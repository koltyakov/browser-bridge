import assert from 'node:assert/strict';
import test from 'node:test';
import { createIdleTabSweeper, type OwnedTabRecord } from '../src/background-idle-tabs.js';
import { normalizeTabCreateParams } from '../../../protocol/src/index.js';

function harness(
  owned: Record<string, OwnedTabRecord>,
  overrides: { busy?: number[]; active?: number[] } = {}
) {
  let clock = 1_000_000;
  const closed: number[] = [];
  const sweeper = createIdleTabSweeper({
    getOwnedTabs: () => owned,
    getEnabledWindowId: () => 7,
    closingAllowed: () => true,
    isBusy: (tabId) => (overrides.busy ?? []).includes(tabId),
    getTab: async (tabId) =>
      ({
        id: tabId,
        windowId: 7,
        active: (overrides.active ?? []).includes(tabId),
      }) as chrome.tabs.Tab,
    closeTab: async (tabId) => {
      closed.push(tabId);
      // tabs.onRemoved drops the ownership record in the extension.
      delete owned[String(tabId)];
    },
    now: () => clock,
    defaultTtlMs: 15 * 60_000,
  });
  return { sweeper, closed, advance: (ms: number) => (clock += ms) };
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

test('tabs the agent did not open are never closed, and a restart restarts the clock', async () => {
  const { sweeper, advance } = harness({ '8': { windowId: 7, enabledAt: 1, idleTtlMs: 60_000 } });
  sweeper.touch(99);
  advance(10 * 60 * 60_000);
  assert.deepEqual(await sweeper.sweep(), [], 'first sweep after a restart only starts the clock');
  advance(61_000);
  assert.deepEqual(await sweeper.sweep(), [8]);
});

test('tabs.create accepts an idle TTL within bounds', () => {
  assert.equal(normalizeTabCreateParams({}).idleTtlMs, 15 * 60_000);
  assert.equal(normalizeTabCreateParams({ idleTtlMs: 0 }).idleTtlMs, 0);
  assert.equal(normalizeTabCreateParams({ idleTtlMs: 60_000 }).idleTtlMs, 5 * 60_000);
  assert.equal(normalizeTabCreateParams({ idleTtlMs: 10 ** 9 }).idleTtlMs, 24 * 60 * 60_000);
  assert.throws(() => normalizeTabCreateParams({ idleTtlMs: -1 }), /idleTtlMs/);
});
