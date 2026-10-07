import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_TAB_STORAGE_KEY,
  DEFAULT_AGENT_SESSION,
  MAX_AGENT_RECENT_TABS,
  createAgentTabLeaseStore,
  normalizeAgentSession,
} from '../src/background-agent-tabs.js';
import { createChromeFake, createStorageArea } from '../../../tests/_helpers/chromeFake.ts';
import type { FakeChromeEvent } from '../../../tests/_helpers/chromeFake.ts';
import { loadBackground } from '../../../tests/_helpers/loadBackground.ts';
import { createRequest, ERROR_CODES, summarizeBridgeResponse } from '../../protocol/src/index.js';
import type { BridgeMethod, BridgeResponse } from '../../protocol/src/types.js';
import type { ExtensionState } from '../src/background-state.js';
import type { AgentTabUiState } from '../src/background-ui.js';
import { createMessagePortPair } from '../../../tests/_helpers/messagePort.ts';

type LoadedBackground = Awaited<ReturnType<typeof loadBackground>>;

test('normalizeAgentSession keeps safe ids and falls back to the shared default', () => {
  assert.equal(normalizeAgentSession('mcp_1234-abcd'), 'mcp_1234-abcd');
  assert.equal(normalizeAgentSession('  cli:agent.1  '), 'cli:agent.1');
  assert.equal(normalizeAgentSession(''), DEFAULT_AGENT_SESSION);
  assert.equal(normalizeAgentSession('has spaces'), DEFAULT_AGENT_SESSION);
  assert.equal(normalizeAgentSession('x'.repeat(129)), DEFAULT_AGENT_SESSION);
  assert.equal(normalizeAgentSession(42), DEFAULT_AGENT_SESSION);
});

test('agent tab leases bind, refresh, and expire after idle time', async () => {
  let now = 1_000;
  const store = createAgentTabLeaseStore({ now: () => now, idleMs: 100 });
  assert.equal(await store.get('a'), null);

  await store.bind('a', 11, 7);
  now += 60;
  await store.touch('a');
  now += 60;
  assert.equal((await store.get('a'))?.tabId, 11);

  now += 101;
  assert.equal(await store.get('a'), null);
});

test('agent tab leases close on removal, close on move out, and reopen on move back', async () => {
  const store = createAgentTabLeaseStore();
  await store.bind('a', 11, 7);
  await store.bind('b', 12, 7);

  assert.deepEqual(await store.handleTabMoved(11, 8), ['a']);
  assert.equal((await store.get('a'))?.closed, true);
  assert.deepEqual(await store.handleTabMoved(11, 7), ['a']);
  assert.equal((await store.get('a'))?.closed, false);

  assert.deepEqual(await store.handleTabRemoved(12), ['b']);
  assert.equal((await store.get('b'))?.closed, true);
  assert.deepEqual([...(await store.getWorkingTabIds())], [11]);

  await store.bind('b', 13, 7);
  assert.equal((await store.get('b'))?.closed, false);
});

test('agent tab leases persist across worker restarts', async () => {
  const storage = createStorageArea();
  const first = createAgentTabLeaseStore({ storage });
  await first.bind('mcp_a', 21, 7);
  assert.ok(storage.snapshot()[AGENT_TAB_STORAGE_KEY]);

  const second = createAgentTabLeaseStore({ storage });
  assert.equal((await second.get('mcp_a'))?.tabId, 21);
});

test('agent tab leases rebind a window and evict the least recently used session', async () => {
  let now = 0;
  const store = createAgentTabLeaseStore({ now: () => (now += 1), maxLeases: 2 });
  assert.equal(await store.rebindWindow(7, 30), 1);
  assert.equal((await store.get(DEFAULT_AGENT_SESSION))?.tabId, 30);

  await store.bind('a', 31, 7);
  await store.bind('b', 32, 7);
  assert.equal(await store.get(DEFAULT_AGENT_SESSION), null);
  assert.equal(await store.rebindWindow(7, 33), 2);
  assert.deepEqual(
    (await store.list()).map((lease) => [lease.session, lease.tabId]),
    [
      ['a', 33],
      ['b', 33],
    ]
  );
});

test('recent agent targets survive alternating explicit tabs and worker restarts without changing default routing', async () => {
  const storage = createStorageArea();
  let now = 100;
  const store = createAgentTabLeaseStore({ storage, now: () => now, idleMs: 50 });
  await store.bind('a', 11, 7);
  now = 110;
  await store.bind('a', 12, 7);
  now = 120;
  await store.bind('a', 11, 7);
  assert.equal((await store.get('a'))?.tabId, 11);
  assert.deepEqual((await store.listRecentTabs()).map((tab) => tab.tabId).sort(), [11, 12]);
  const restarted = createAgentTabLeaseStore({ storage, now: () => now, idleMs: 50 });
  assert.deepEqual(await restarted.listRecentTabs(), await store.listRecentTabs());
  now = 165;
  assert.deepEqual(
    (await restarted.listRecentTabs()).map((tab) => tab.tabId),
    [11]
  );
  await restarted.rebindWindow(7, 13);
  assert.deepEqual(
    (await restarted.listRecentTabs()).map((tab) => tab.tabId),
    [13]
  );
});

test('recent targets deduplicate sessions and remove closed or moved tabs independently', async () => {
  const store = createAgentTabLeaseStore({ now: () => 100 });
  await store.bind('a', 11, 7);
  await store.bind('a', 12, 7);
  await store.bind('b', 11, 7);
  assert.equal((await store.listRecentTabs()).length, 2);
  await store.handleTabRemoved(11);
  assert.deepEqual(
    (await store.listRecentTabs()).map((tab) => tab.tabId),
    [12]
  );
  await store.handleTabMoved(12, 8);
  assert.deepEqual(await store.listRecentTabs(), []);
  await store.handleTabMoved(12, 7);
  assert.deepEqual(
    (await store.listRecentTabs()).map((tab) => tab.tabId),
    [12]
  );
  await store.markClosed('a');
  assert.deepEqual(await store.listRecentTabs(), []);
});

test('older stored leases become recent targets and malformed target data is ignored', async () => {
  const storage = createStorageArea({
    [AGENT_TAB_STORAGE_KEY]: {
      legacy: { tabId: 11, windowId: 7, boundAt: 100, lastUsedAt: 100, closed: false },
      malformed: {
        tabId: 12,
        windowId: 7,
        boundAt: 100,
        lastUsedAt: 100,
        recentTabs: [
          null,
          'invalid',
          { tabId: NaN, windowId: 7, lastUsedAt: 100 },
          { tabId: 13, windowId: 8, lastUsedAt: 100 },
          { tabId: 14, windowId: 7, lastUsedAt: 100 },
        ],
      },
    },
  });
  const store = createAgentTabLeaseStore({ storage, now: () => 100 });
  assert.deepEqual(
    (await store.listRecentTabs()).map((tab) => tab.tabId),
    [11, 14]
  );
});

test('recent targets stay bounded, follow window rebinding, and clear with access', async () => {
  const store = createAgentTabLeaseStore({ now: () => 100 });
  for (let tabId = 1; tabId <= MAX_AGENT_RECENT_TABS + 3; tabId += 1) {
    await store.bind('a', tabId, 7);
  }
  const tabs = await store.listRecentTabs();
  assert.equal(tabs.length, MAX_AGENT_RECENT_TABS);
  assert.equal(tabs[0].tabId, 4);
  await store.bind('a', 50, 8);
  assert.deepEqual(await store.listRecentTabs(), [{ tabId: 50, windowId: 8, lastUsedAt: 100 }]);
  await store.clear();
  assert.deepEqual(await store.listRecentTabs(), []);
});

/**
 * Two tabs in enabled window 7: the agent's page (81) and the user's mail (82).
 */
async function loadTwoTabBackground(label: string) {
  const tabs = new Map<number, chrome.tabs.Tab>([
    [81, { id: 81, windowId: 7, active: true, title: 'App', url: 'https://app.test/' }],
    [82, { id: 82, windowId: 7, active: false, title: 'Mail', url: 'https://mail.test/' }],
  ] as Array<[number, chrome.tabs.Tab]>);
  const reloads: number[] = [];
  const chrome = createChromeFake({
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
        const all = [...tabs.values()].map((tab) => ({ ...tab }));
        if (queryInfo.active) {
          return all.filter((tab) => tab.active && tab.windowId === queryInfo.windowId);
        }
        return all.filter(
          (tab) => queryInfo.windowId === undefined || tab.windowId === queryInfo.windowId
        );
      },
      async get(tabId: number) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        return { ...tab };
      },
      async reload(tabId: number) {
        reloads.push(tabId);
      },
    },
    windows: {
      async get(windowId: number) {
        return { id: windowId };
      },
    },
  });
  const loaded = await loadBackground({ chrome, query: `${label}-${Date.now()}` });
  const state = loaded.module.getStateForTest() as {
    enabledWindow: { windowId: number; title: string; enabledAt: number } | null;
  };
  state.enabledWindow = { windowId: 7, title: 'Enabled', enabledAt: Date.now() };

  /** @param {number} tabId */
  const activate = (tabId: number) => {
    for (const tab of tabs.values()) tab.active = tab.id === tabId;
  };
  const remove = (tabId: number) => {
    tabs.delete(tabId);
    (
      loaded.chrome as unknown as {
        tabs: { onRemoved: { dispatch: (...args: unknown[]) => void } };
      }
    ).tabs.onRemoved.dispatch(tabId, { windowId: 7, isWindowClosing: false });
  };
  return { loaded, reloads, activate, remove };
}

let requestCounter = 0;

/**
 * @param {LoadedBackground} loaded
 */
function call(
  loaded: LoadedBackground,
  method: BridgeMethod,
  options: { session?: string; tabId?: number; params?: Record<string, unknown> } = {}
): Promise<BridgeResponse> {
  requestCounter += 1;
  return loaded.dispatch(
    createRequest({
      id: `agent-tabs-${requestCounter}`,
      method,
      tabId: options.tabId ?? null,
      params: options.params ?? (method === 'navigation.reload' ? { waitForLoad: false } : {}),
      meta: options.session ? { agent_session: options.session } : {},
    })
  );
}

test('agent keeps working in its tab after the user activates another tab', async () => {
  const { loaded, reloads, activate } = await loadTwoTabBackground('agent-tabs-sticky');

  const first = await call(loaded, 'navigation.reload');
  assert.equal(first.ok, true);
  assert.equal(first.meta.tab_routing, 'active');
  assert.equal(first.meta.tab_id, 81);

  activate(82);
  const second = await call(loaded, 'navigation.reload');
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(reloads, [81, 81]);
  assert.equal(second.meta.tab_routing, 'working');
  assert.equal(second.meta.active_tab_id, 82);
  assert.match(
    summarizeBridgeResponse(second, 'navigation.reload').summary,
    /working tab 81; the user's active tab is 82/
  );
});

test('a closed working tab fails loudly instead of hijacking the active tab', async () => {
  const { loaded, reloads, activate, remove } = await loadTwoTabBackground('agent-tabs-closed');

  assert.equal((await call(loaded, 'navigation.reload')).ok, true);
  activate(82);
  remove(81);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const blocked = await call(loaded, 'navigation.reload');
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.error.code, ERROR_CODES.TAB_MISMATCH);
    assert.deepEqual(blocked.error.details, {
      reason: 'working_tab_closed',
      workingTabId: 81,
      activeTabId: 82,
    });
  }
  assert.deepEqual(reloads, [81]);

  const explicit = await call(loaded, 'navigation.reload', { tabId: 82 });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.meta.tab_routing, 'explicit');
  const followUp = await call(loaded, 'navigation.reload');
  assert.equal(followUp.ok, true);
  assert.deepEqual(reloads, [81, 82, 82]);
});

test('agent sessions keep separate working tabs and tabs.list marks the caller tab', async () => {
  const { loaded, reloads, activate } = await loadTwoTabBackground('agent-tabs-sessions');

  assert.equal((await call(loaded, 'navigation.reload', { session: 'agent-a' })).ok, true);
  activate(82);
  assert.equal((await call(loaded, 'navigation.reload', { session: 'agent-b' })).ok, true);
  assert.equal((await call(loaded, 'navigation.reload', { session: 'agent-a' })).ok, true);
  assert.deepEqual(reloads, [81, 82, 81]);

  const listed = await call(loaded, 'tabs.list', { session: 'agent-b' });
  assert.equal(listed.ok, true);
  if (listed.ok) {
    const result = listed.result as { workingTabId: number; tabs: Array<Record<string, unknown>> };
    assert.equal(result.workingTabId, 82);
    assert.deepEqual(
      result.tabs.map((tab) => [tab.tabId, tab.working === true]),
      [
        [81, false],
        [82, true],
      ]
    );
  }
});

test('tabs.activate moves the calling agent to the activated tab', async () => {
  const { loaded, reloads } = await loadTwoTabBackground('agent-tabs-activate');

  assert.equal((await call(loaded, 'navigation.reload')).ok, true);
  const activated = await call(loaded, 'tabs.activate', { params: { tabId: 82 } });
  assert.equal(activated.ok, true);
  assert.equal((await call(loaded, 'navigation.reload')).ok, true);
  assert.deepEqual(reloads, [81, 82]);
});

test('panel shows both targets for one alternating agent and stays scoped to its own tab', async () => {
  const { loaded, remove } = await loadTwoTabBackground('agent-tabs-panel');
  const state = loaded.module.getStateForTest() as ExtensionState;
  const pair = createMessagePortPair();
  const port = pair.left.port as unknown as chrome.runtime.Port;
  (loaded.chrome.runtime.onConnect as unknown as FakeChromeEvent).dispatch(port);
  state.uiPorts.set(port, { surface: 'sidepanel', scopeTabId: 81 });
  const emit = async () => {
    pair.left.dispatchMessage({ type: 'state.request', scopeTabId: 81 });
    await new Promise((resolve) => setImmediate(resolve));
  };
  const latest = () => {
    const messages = pair.left.postedMessages as Array<{
      type: string;
      state: { agentTabs?: AgentTabUiState[] };
    }>;
    return messages.filter((message) => message.type === 'state.sync').at(-1)?.state.agentTabs;
  };
  await call(loaded, 'navigation.reload', { session: 'a', tabId: 81 });
  await call(loaded, 'navigation.reload', { session: 'a', tabId: 82 });
  await emit();
  const expected = latest();
  assert.deepEqual(
    expected?.map((tab) => [tab.tabId, tab.isCurrent]),
    [
      [81, true],
      [82, false],
    ]
  );
  assert.deepEqual(
    expected?.map((tab) => tab.actionCount),
    [1, 1]
  );
  await call(loaded, 'navigation.reload', { session: 'a', tabId: 81 });
  await call(loaded, 'navigation.reload', { session: 'b', tabId: 82 });
  await emit();
  assert.deepEqual(
    latest()?.map((tab) => [tab.tabId, tab.title, tab.isCurrent]),
    expected?.map((tab) => [tab.tabId, tab.title, tab.isCurrent])
  );
  assert.deepEqual(
    latest()?.map((tab) => tab.actionCount),
    [2, 2]
  );
  const ping = state.actionLog.find((entry) => entry.tabId === 82);
  assert.ok(ping);
  state.actionLog.push({ ...ping, id: 'sibling-ping', method: 'health.ping' });
  await emit();
  assert.deepEqual(
    latest()?.map((tab) => tab.actionCount),
    [2, 2],
    'pings do not inflate action counts'
  );
  remove(82);
  await new Promise((resolve) => setImmediate(resolve));
  await emit();
  assert.deepEqual(
    latest()?.map((tab) => [tab.tabId, tab.isCurrent]),
    [[81, true]]
  );
});
