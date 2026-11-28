import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createIdleTabSweeper,
  idleCloseLogEntry,
  IDLE_ACTIVITY_PERSIST_MS,
  type OwnedTabRecord,
} from '../src/background-idle-tabs.js';
import { createActionLogController } from '../src/background-action-log.js';
import { createExtensionState } from '../src/background-state.js';
import { createChromeFake } from '../../../tests/_helpers/chromeFake.ts';
import { normalizeTabCreateParams } from '../../../protocol/src/index.js';

function harness(
  owned: Record<string, OwnedTabRecord>,
  overrides: { busy?: number[]; active?: number[]; pinned?: number[] } = {}
) {
  let clock = 1_000_000;
  const closed: number[] = [];
  const onClosed: Array<[number, number]> = [];
  const persisted: Array<[number, number]> = [];
  const sweeper = createIdleTabSweeper({
    getOwnedTabs: () => owned,
    getEnabledWindowId: () => 7,
    isBusy: (tabId) => (overrides.busy ?? []).includes(tabId),
    getTab: async (tabId) =>
      ({
        id: tabId,
        windowId: 7,
        active: (overrides.active ?? []).includes(tabId),
        pinned: (overrides.pinned ?? []).includes(tabId),
      }) as chrome.tabs.Tab,
    closeTab: async (tabId) => {
      closed.push(tabId);
      // tabs.onRemoved drops the ownership record in the extension.
      delete owned[String(tabId)];
    },
    onClosed: (tabId, idleMs) => onClosed.push([tabId, idleMs]),
    persistActivity: (tabId, at) => {
      persisted.push([tabId, at]);
      const record = owned[String(tabId)];
      if (record) record.lastActiveAt = at;
    },
    now: () => clock,
    defaultTtlMs: 15 * 60_000,
  });
  return {
    sweeper,
    closed,
    onClosed,
    persisted,
    now: () => clock,
    advance: (ms: number) => (clock += ms),
  };
}

test('agent-opened tabs close after their own idle TTL', async () => {
  const { sweeper, closed, advance } = harness({
    '1': { windowId: 7, enabledAt: 1, idleTtlMs: 60_000 },
    '2': { windowId: 7, enabledAt: 1 },
    '3': { windowId: 7, enabledAt: 1, idleTtlMs: 0 },
  });
  for (const id of [1, 2, 3]) sweeper.touch(id);
  advance(61_000);
  assert.deepEqual(await sweeper.sweep(), [1], 'a short-TTL tab closes once its TTL passes');
  advance(15 * 60_000);
  assert.deepEqual(await sweeper.sweep(), [2], 'the default TTL is fifteen minutes');
  advance(24 * 60 * 60_000);
  assert.deepEqual(await sweeper.sweep(), [], 'TTL 0 keeps the tab until access ends');
  assert.deepEqual(closed, [1, 2]);
});

test('activity, running work, and an active tab postpone closing', async () => {
  const { sweeper, closed, advance } = harness(
    {
      '4': { windowId: 7, enabledAt: 1, idleTtlMs: 60_000 },
      '5': { windowId: 7, enabledAt: 1, idleTtlMs: 60_000 },
      '6': { windowId: 7, enabledAt: 1, idleTtlMs: 60_000 },
    },
    { busy: [5], active: [6] }
  );
  for (const id of [4, 5, 6]) sweeper.touch(id);
  advance(50_000);
  sweeper.touch(4);
  advance(20_000);
  assert.deepEqual(
    await sweeper.sweep(),
    [],
    'recent activity, a busy tab, and the active tab stay'
  );
  advance(60_000);
  assert.deepEqual(await sweeper.sweep(), [4]);
  assert.deepEqual(closed, [4]);
});

test('idle close rechecks activity and ownership after looking up the tab', async () => {
  for (const change of ['touch', 'busy', 'forget', 'replace']) {
    const owned: Record<string, OwnedTabRecord> = { '4': { windowId: 7, enabledAt: 1 } };
    const busy: number[] = [];
    const { sweeper, advance, closed } = harness(owned, { busy });
    sweeper.touch(4);
    advance(16 * 60_000);
    const sweep = sweeper.sweep();
    // The sweep has checked the idle timeout and is awaiting getTab.
    switch (change) {
      case 'touch':
        sweeper.touch(4);
        break;
      case 'busy':
        busy.push(4);
        break;
      case 'forget':
        delete owned['4'];
        break;
      case 'replace':
        owned['4'] = { windowId: 7, enabledAt: 2, idleTtlMs: 0 };
        break;
    }
    await sweep;
    assert.deepEqual(closed, [], change);
  }
});

test('tabs the agent did not open are never closed, and a record without activity starts the clock', async () => {
  const { sweeper, advance } = harness({ '8': { windowId: 7, enabledAt: 1, idleTtlMs: 60_000 } });
  sweeper.touch(99);
  advance(10 * 60 * 60_000);
  assert.deepEqual(await sweeper.sweep(), [], 'no activity record yet: only start the clock');
  advance(61_000);
  assert.deepEqual(await sweeper.sweep(), [8]);
});

test('a worker restart resumes the persisted idle clock without closing early', async () => {
  const ttl = 5 * 60_000;
  const owned: Record<string, OwnedTabRecord> = {
    '9': { windowId: 7, enabledAt: 1, idleTtlMs: ttl },
  };
  const before = harness(owned);
  before.sweeper.touch(9);
  assert.deepEqual(before.persisted, [[9, before.now()]], 'first touch persists');
  before.advance(IDLE_ACTIVITY_PERSIST_MS - 1);
  before.sweeper.touch(9);
  assert.equal(before.persisted.length, 1, 'touches within the step are not persisted');
  before.advance(1);
  before.sweeper.touch(9);
  assert.equal(before.persisted.length, 2, 'a touch a full step later persists again');
  const lastTouch = before.now();

  // A fresh sweeper is a restarted worker: only the persisted record remains.
  const after = harness(owned);
  after.advance(lastTouch - after.now() + ttl);
  assert.deepEqual(
    await after.sweeper.sweep(),
    [],
    'never earlier than the TTL after the last touch'
  );
  after.advance(IDLE_ACTIVITY_PERSIST_MS);
  assert.deepEqual(
    await after.sweeper.sweep(),
    [9],
    'the restart does not grant a fresh full timeout'
  );
  assert.deepEqual(after.onClosed, [[9, ttl]]);
});

test('pinned tabs stay open', async () => {
  const { sweeper, advance } = harness(
    { '10': { windowId: 7, enabledAt: 1, idleTtlMs: 60_000 } },
    { pinned: [10] }
  );
  sweeper.touch(10);
  advance(24 * 60 * 60_000);
  assert.deepEqual(await sweeper.sweep(), []);
});

test('an idle close is recorded in the activity log after the tab is gone', async () => {
  const chromeObj = createChromeFake({
    tabs: {
      async get(id: number) {
        throw new Error(`No tab with id: ${id}.`);
      },
    },
  }) as unknown as typeof chrome;
  const state = createExtensionState();
  const log = createActionLogController(state, chromeObj, {
    resolveRequestTarget: async () => {
      throw new Error('unused');
    },
    getCurrentTabState: async () => null,
    emitUiState: async () => {},
  });
  await log.appendActionLogEntry(idleCloseLogEntry(12, 15 * 60_000));
  assert.equal(state.actionLog.length, 1);
  assert.equal(state.actionLog[0].method, 'tabs.idle_close');
  assert.equal(state.actionLog[0].tabId, null);
  assert.match(state.actionLog[0].summary, /tab 12 after 15 min/);
});

test('tabs.create accepts an idle TTL within bounds', () => {
  assert.equal(normalizeTabCreateParams({}).idleTtlMs, 15 * 60_000);
  assert.equal(normalizeTabCreateParams({ idleTtlMs: 0 }).idleTtlMs, 0);
  assert.equal(normalizeTabCreateParams({ idleTtlMs: 60_000 }).idleTtlMs, 5 * 60_000);
  assert.equal(normalizeTabCreateParams({ idleTtlMs: 10 ** 9 }).idleTtlMs, 24 * 60 * 60_000);
  assert.throws(() => normalizeTabCreateParams({ idleTtlMs: -1 }), /idleTtlMs/);
});
