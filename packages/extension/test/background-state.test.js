// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { createChromeEvent, createChromeFake } from '../../../tests/_helpers/chromeFake.js';
import { loadBackground } from '../../../tests/_helpers/loadBackground.js';
import { createMessagePortPair } from '../../../tests/_helpers/messagePort.js';

/**
 * @param {unknown[]} messages
 * @returns {any}
 */
function createNativePort(messages) {
  return {
    /** @param {unknown} message */
    postMessage(message) {
      messages.push(message);
    },
    disconnect() {},
    onMessage: createChromeEvent(),
    onDisconnect: createChromeEvent(),
    name: 'native',
  };
}

/**
 * @param {number} [count]
 * @returns {Promise<void>}
 */
async function flushAsyncWork(count = 6) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

/**
 * @param {() => boolean} predicate
 * @returns {Promise<void>}
 */
async function waitForCondition(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(predicate(), true);
}

/**
 * @typedef {chrome.scripting.ScriptInjection<any[], any> & { args?: unknown[] }} ExecuteScriptCall
 */

/**
 * @param {Map<number, { entries: unknown[], dropped: number }>} consoleBuffers
 * @param {Map<number, { entries: unknown[], dropped: number }>} networkBuffers
 * @param {ExecuteScriptCall[]} executeScriptCalls
 * @returns {(details: ExecuteScriptCall) => Promise<Array<{ result: unknown }>>}
 */
function createBufferedExecuteScript(consoleBuffers, networkBuffers, executeScriptCalls) {
  return async function executeScript(details) {
    executeScriptCalls.push(details);
    const tabId = details.target?.tabId;
    const shouldClear = details.args?.[0] === true;
    const source = String(details.func);

    if (typeof tabId !== 'number') {
      return [];
    }

    if (source.includes('__bb_console_buffer')) {
      const state = consoleBuffers.get(tabId) ?? { entries: [], dropped: 0 };
      const result = {
        entries: [...state.entries],
        dropped: state.dropped,
      };
      if (shouldClear) {
        consoleBuffers.set(tabId, { entries: [], dropped: 0 });
      }
      return [{ result }];
    }

    if (source.includes('__bb_network_buffer')) {
      const state = networkBuffers.get(tabId) ?? { entries: [], dropped: 0 };
      const result = {
        entries: [...state.entries],
        dropped: state.dropped,
      };
      if (shouldClear) {
        networkBuffers.set(tabId, { entries: [], dropped: 0 });
      }
      return [{ result }];
    }

    return [];
  };
}

test('background state scope.set_enabled enables and disables the requested current window', async () => {
  /** @type {unknown[]} */
  const nativeMessages = [];
  /** @type {Array<Record<string, unknown>>} */
  const alarmCreates = [];
  /** @type {string[]} */
  const alarmClears = [];
  const portPair = createMessagePortPair({ leftName: 'ui-sidepanel', rightName: 'agent' });
  const chrome = createChromeFake({
    runtime: {
      connectNative() {
        return createNativePort(nativeMessages);
      },
    },
    tabs: {
      /** @param {chrome.tabs.QueryInfo} [queryInfo] */
      async query(queryInfo = {}) {
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [
            {
              id: 31,
              windowId: 8,
              title: 'Current Window',
              url: 'https://example.com/current',
              status: 'complete',
            },
          ];
        }
        if (queryInfo.windowId === 8) {
          return [
            {
              id: 31,
              windowId: 8,
              title: 'Current Window',
              url: 'https://example.com/current',
              status: 'complete',
            },
          ];
        }
        return [];
      },
      /** @param {number} tabId */
      async get(tabId) {
        assert.equal(tabId, 31);
        return {
          id: 31,
          windowId: 8,
          title: 'Current Window',
          url: 'https://example.com/current',
          status: 'complete',
        };
      },
    },
    alarms: {
      /** @param {string} name @param {chrome.alarms.AlarmCreateInfo} info */
      async create(name, info) {
        alarmCreates.push({ name, ...info });
      },
      /** @param {string} name */
      async clear(name) {
        alarmClears.push(name);
        return true;
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-state-set-current-window-enabled-${Date.now()}`,
  });

  loaded.chrome.runtime.onConnect.dispatch(portPair.left.port);
  await flushAsyncWork();

  const state = loaded.module.getStateForTest();
  state.requestedAccessWindowId = 8;

  portPair.left.dispatchMessage({ type: 'scope.set_enabled', enabled: true });
  await flushAsyncWork();
  await waitForCondition(() => alarmCreates.length === 1);

  assert.equal(state.requestedAccessWindowId, null);
  assert.equal(state.enabledWindow?.windowId, 8);
  assert.equal(state.enabledWindow?.title, 'Current Window');
  assert.deepEqual(loaded.chrome.storage.session.snapshot().enabledWindow, state.enabledWindow);
  assert.deepEqual(alarmCreates, [{ name: 'bb-keepalive', periodInMinutes: 0.4 }]);
  assert.equal(
    nativeMessages.some(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'host.access_update' &&
        'accessEnabled' in message &&
        message.accessEnabled === true
    ),
    true
  );

  const enabledAt = state.enabledWindow?.enabledAt;
  portPair.left.dispatchMessage({ type: 'scope.set_enabled', enabled: true });
  await flushAsyncWork();
  await waitForCondition(() => alarmCreates.length === 2);

  assert.equal(state.enabledWindow?.windowId, 8);
  assert.equal(typeof state.enabledWindow?.enabledAt, 'number');
  assert.equal((state.enabledWindow?.enabledAt ?? 0) >= (enabledAt ?? 0), true);
  assert.equal(alarmCreates.length, 2);

  portPair.left.dispatchMessage({ type: 'scope.set_enabled', enabled: false });
  await flushAsyncWork();
  await waitForCondition(() => alarmClears.length === 1);

  assert.equal(state.enabledWindow, null);
  assert.equal(loaded.chrome.storage.session.snapshot().enabledWindow, undefined);
  assert.deepEqual(alarmClears, ['bb-keepalive']);
  assert.equal(
    nativeMessages.some(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'host.access_update' &&
        'accessEnabled' in message &&
        message.accessEnabled === false
    ),
    true
  );
});

test('background state scope.set_enabled surfaces tab mismatch and ignores disabling a different window', async () => {
  /** @type {unknown[]} */
  const nativeMessages = [];
  /** @type {string[]} */
  const alarmClears = [];
  const portPair = createMessagePortPair({ leftName: 'ui-popup', rightName: 'agent' });
  const chrome = createChromeFake({
    runtime: {
      connectNative() {
        return createNativePort(nativeMessages);
      },
    },
    tabs: {
      /** @param {chrome.tabs.QueryInfo} [queryInfo] */
      async query(queryInfo = {}) {
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [{ id: 45, windowId: 3 }];
        }
        if (queryInfo.windowId === 9) {
          return [
            {
              id: 91,
              windowId: 9,
              title: 'Enabled Window',
              url: 'https://example.com/enabled',
              status: 'complete',
            },
          ];
        }
        return [];
      },
      /** @param {number} tabId */
      async get(tabId) {
        if (tabId === 45) {
          return {
            id: 45,
            windowId: 3,
            title: 'Different Window',
            url: 'https://example.com/different',
          };
        }
        if (tabId === 91) {
          return {
            id: 91,
            windowId: 9,
            title: 'Enabled Window',
            url: 'https://example.com/enabled',
          };
        }
        throw new Error(`No tab with id: ${tabId}.`);
      },
    },
    alarms: {
      /** @param {string} name */
      async clear(name) {
        alarmClears.push(name);
        return true;
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-state-set-current-window-error-${Date.now()}`,
  });

  const state = loaded.module.getStateForTest();
  state.enabledWindow = {
    windowId: 9,
    title: 'Enabled Window',
    enabledAt: 12,
  };

  loaded.chrome.runtime.onConnect.dispatch(portPair.left.port);
  await flushAsyncWork();

  portPair.left.dispatchMessage({ type: 'scope.set_enabled', enabled: true });
  await flushAsyncWork();

  assert.deepEqual(portPair.left.postedMessages.at(-1), {
    type: 'toggle.error',
    error: 'TAB_MISMATCH',
  });
  assert.deepEqual(state.enabledWindow, {
    windowId: 9,
    title: 'Enabled Window',
    enabledAt: 12,
  });

  portPair.left.dispatchMessage({ type: 'scope.set_enabled', tabId: 45, enabled: false });
  await flushAsyncWork();
  await waitForCondition(() => alarmClears.length === 1);

  assert.deepEqual(state.enabledWindow, {
    windowId: 9,
    title: 'Enabled Window',
    enabledAt: 12,
  });
  assert.deepEqual(alarmClears, ['bb-keepalive']);
  assert.equal(
    nativeMessages.some(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'host.access_update' &&
        'accessEnabled' in message &&
        message.accessEnabled === false
    ),
    true
  );
});

test('background state getCurrentTabState returns null when the active tab is incomplete', async () => {
  const chrome = createChromeFake({
    tabs: {
      /** @param {chrome.tabs.QueryInfo} [queryInfo] */
      async query(queryInfo = {}) {
        if (Object.keys(queryInfo).length === 0) {
          return [];
        }
        assert.deepEqual(queryInfo, {
          active: true,
          lastFocusedWindow: true,
        });
        return [
          {
            id: 14,
            windowId: 3,
          },
        ];
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-state-current-tab-null-${Date.now()}`,
  });

  assert.equal(await loaded.module.getCurrentTabState(), null);
});

test('background state getCurrentTabState reflects enabled, requested, and restricted flags', async () => {
  const chrome = createChromeFake({
    tabs: {
      /** @param {chrome.tabs.QueryInfo} [queryInfo] */
      async query(queryInfo = {}) {
        if (Object.keys(queryInfo).length === 0) {
          return [];
        }
        assert.deepEqual(queryInfo, {
          active: true,
          lastFocusedWindow: true,
        });
        return [
          {
            id: 27,
            windowId: 8,
            title: 'Extensions',
            url: 'chrome://extensions',
          },
        ];
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-state-current-tab-flags-${Date.now()}`,
  });

  const state = loaded.module.getStateForTest();
  state.requestedAccessWindowId = 8;

  assert.deepEqual(await loaded.module.getCurrentTabState(), {
    tabId: 27,
    windowId: 8,
    title: 'Extensions',
    url: 'chrome://extensions',
    enabled: false,
    accessRequested: true,
    restricted: true,
  });
});

test('background state getTabState returns null for missing tab ids and failed lookups', async () => {
  /** @type {number[]} */
  const requestedTabIds = [];
  const chrome = createChromeFake({
    tabs: {
      /** @param {number} tabId */
      async get(tabId) {
        requestedTabIds.push(tabId);
        throw new Error(`No tab with id: ${tabId}.`);
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-state-get-tab-null-${Date.now()}`,
  });

  assert.equal(await loaded.module.getTabState(null), null);
  assert.equal(await loaded.module.getTabState(99), null);
  assert.deepEqual(requestedTabIds, [99]);
});

test('background state getTabState returns the UI shape for a specific tab', async () => {
  const chrome = createChromeFake({
    tabs: {
      /** @param {number} tabId */
      async get(tabId) {
        assert.equal(tabId, 64);
        return {
          id: 64,
          windowId: 12,
          title: 'Docs',
          url: 'https://example.com/docs',
        };
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-state-get-tab-shape-${Date.now()}`,
  });

  const state = loaded.module.getStateForTest();
  state.enabledWindow = {
    windowId: 12,
    title: 'Workspace',
    enabledAt: 1,
  };

  assert.deepEqual(await loaded.module.getTabState(64), {
    tabId: 64,
    windowId: 12,
    title: 'Docs',
    url: 'https://example.com/docs',
    enabled: true,
    accessRequested: false,
    restricted: false,
  });
});

test('background state clearEnabledWindowIfGone returns false when no window is enabled', async () => {
  const loaded = await loadBackground({
    query: `test-background-state-clear-enabled-window-empty-${Date.now()}`,
  });

  assert.equal(await loaded.module.clearEnabledWindowIfGone(), false);
});

test('background state clearEnabledWindowIfGone keeps the enabled window when it still exists', async () => {
  /** @type {number[]} */
  const requestedWindowIds = [];
  const chrome = createChromeFake({
    windows: {
      /** @param {number} windowId */
      async get(windowId) {
        requestedWindowIds.push(windowId);
        return { id: windowId };
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-state-clear-enabled-window-present-${Date.now()}`,
  });

  const state = loaded.module.getStateForTest();
  state.enabledWindow = {
    windowId: 19,
    title: 'Workspace',
    enabledAt: 5,
  };
  await loaded.chrome.storage.session.set({ enabledWindow: state.enabledWindow });

  assert.equal(await loaded.module.clearEnabledWindowIfGone(), false);
  assert.deepEqual(requestedWindowIds, [19]);
  assert.deepEqual(state.enabledWindow, {
    windowId: 19,
    title: 'Workspace',
    enabledAt: 5,
  });
  assert.deepEqual(loaded.chrome.storage.session.snapshot().enabledWindow, {
    windowId: 19,
    title: 'Workspace',
    enabledAt: 5,
  });
});

test('background state clearEnabledWindowIfGone clears missing windows and sends an access update', async () => {
  /** @type {unknown[]} */
  const nativeMessages = [];
  const chrome = createChromeFake({
    runtime: {
      connectNative() {
        return createNativePort(nativeMessages);
      },
    },
    windows: {
      /** @param {number} windowId */
      async get(windowId) {
        assert.equal(windowId, 21);
        throw new Error('No window with id: 21.');
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-state-clear-enabled-window-missing-${Date.now()}`,
  });

  const state = loaded.module.getStateForTest();
  state.enabledWindow = {
    windowId: 21,
    title: 'Workspace',
    enabledAt: 6,
  };
  await loaded.chrome.storage.session.set({ enabledWindow: state.enabledWindow });

  assert.equal(await loaded.module.clearEnabledWindowIfGone(), true);
  assert.equal(state.enabledWindow, null);
  assert.equal(loaded.chrome.storage.session.snapshot().enabledWindow, undefined);
  assert.deepEqual(nativeMessages.at(-1), {
    type: 'host.access_update',
    accessEnabled: false,
  });
});

test('background state clearEnabledWindowIfGone retries transient window lookup failures once', async () => {
  let windowGetCalls = 0;
  const chrome = createChromeFake({
    windows: {
      /** @param {number} windowId */
      async get(windowId) {
        windowGetCalls += 1;
        assert.equal(windowId, 23);
        if (windowGetCalls === 1) {
          throw new Error('Transient lookup failure');
        }
        return { id: windowId };
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-state-clear-enabled-window-retry-${Date.now()}`,
  });

  const state = loaded.module.getStateForTest();
  state.enabledWindow = {
    windowId: 23,
    title: 'Workspace',
    enabledAt: 7,
  };
  await loaded.chrome.storage.session.set({ enabledWindow: state.enabledWindow });

  assert.equal(await loaded.module.clearEnabledWindowIfGone(), false);
  assert.equal(windowGetCalls, 2);
  assert.deepEqual(state.enabledWindow, {
    windowId: 23,
    title: 'Workspace',
    enabledAt: 7,
  });
  assert.deepEqual(loaded.chrome.storage.session.snapshot().enabledWindow, {
    windowId: 23,
    title: 'Workspace',
    enabledAt: 7,
  });
});

test('background state rollbackAllPatchesForTab only rolls back tracked patch ids', async () => {
  /** @type {Array<{ tabId: number, message: Record<string, unknown> }>} */
  const sentMessages = [];
  /** @type {string[]} */
  const rollbackPatchIds = [];
  const chrome = createChromeFake({
    tabs: {
      /** @param {number} tabId @param {Record<string, unknown>} message */
      async sendMessage(tabId, message) {
        sentMessages.push({ tabId, message });

        if (message.type === 'bridge.ping') {
          return { ok: true };
        }

        if (message.type === 'bridge.execute' && message.method === 'patch.list') {
          return {
            patches: [
              { patchId: 'patch-1' },
              { patchId: '' },
              null,
              { patchId: 'patch-2' },
              { patchId: 42 },
            ],
          };
        }

        if (message.type === 'bridge.execute' && message.method === 'patch.rollback') {
          const params = /** @type {{ patchId?: string }} */ (message.params ?? {});
          rollbackPatchIds.push(String(params.patchId));
          return { ok: true };
        }

        return null;
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-state-rollback-all-patches-${Date.now()}`,
  });

  await loaded.module.rollbackAllPatchesForTab(61);

  assert.deepEqual(rollbackPatchIds, ['patch-1', 'patch-2']);
  assert.deepEqual(
    sentMessages.map(({ tabId, message }) => ({
      tabId,
      type: message.type,
      method: message.method,
    })),
    [
      { tabId: 61, type: 'bridge.ping', method: undefined },
      { tabId: 61, type: 'bridge.execute', method: 'patch.list' },
      { tabId: 61, type: 'bridge.execute', method: 'patch.rollback' },
      { tabId: 61, type: 'bridge.execute', method: 'patch.rollback' },
    ]
  );
});

test('background state clearTabBridgeState clears tracked patches and bridge buffers', async () => {
  const patchIdsByTab = new Map([[62, ['patch-a', 'patch-b']]]);
  const consoleBuffers = new Map([
    [
      62,
      {
        entries: [{ level: 'log', args: ['hello'], ts: 1 }],
        dropped: 2,
      },
    ],
  ]);
  const networkBuffers = new Map([
    [
      62,
      {
        entries: [
          {
            method: 'GET',
            url: 'https://example.com/data',
            status: 200,
            duration: 8,
            type: 'fetch',
            ts: 2,
            size: 12,
          },
        ],
        dropped: 1,
      },
    ],
  ]);
  /** @type {ExecuteScriptCall[]} */
  const executeScriptCalls = [];
  const chrome = createChromeFake({
    tabs: {
      /** @param {number} tabId @param {Record<string, unknown>} message */
      async sendMessage(tabId, message) {
        if (message.type === 'bridge.ping') {
          return { ok: true };
        }

        if (message.type === 'bridge.execute' && message.method === 'patch.list') {
          return {
            patches: (patchIdsByTab.get(tabId) ?? []).map((patchId) => ({ patchId })),
          };
        }

        if (message.type === 'bridge.execute' && message.method === 'patch.rollback') {
          const params = /** @type {{ patchId?: string }} */ (message.params ?? {});
          const patchId = params.patchId;
          if (typeof patchId === 'string') {
            patchIdsByTab.set(
              tabId,
              (patchIdsByTab.get(tabId) ?? []).filter((candidate) => candidate !== patchId)
            );
          }
          return { ok: true };
        }

        return null;
      },
    },
    scripting: {
      executeScript: createBufferedExecuteScript(
        consoleBuffers,
        networkBuffers,
        executeScriptCalls
      ),
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-state-clear-tab-bridge-${Date.now()}`,
  });

  await loaded.module.clearTabBridgeState(62);

  assert.deepEqual(patchIdsByTab.get(62), []);
  assert.deepEqual(consoleBuffers.get(62), { entries: [], dropped: 0 });
  assert.deepEqual(networkBuffers.get(62), { entries: [], dropped: 0 });
  assert.deepEqual(
    executeScriptCalls.map((details) => ({
      tabId: details.target?.tabId,
      world: details.world,
      clear: details.args?.[0],
    })),
    [
      { tabId: 62, world: 'MAIN', clear: true },
      { tabId: 62, world: 'MAIN', clear: true },
    ]
  );
});

test('background state clearTabBridgeState swallows recoverable instrumentation errors', async () => {
  /** @type {ExecuteScriptCall[]} */
  const executeScriptCalls = [];
  const chrome = createChromeFake({
    tabs: {
      /** @param {number} _tabId @param {Record<string, unknown>} message */
      async sendMessage(_tabId, message) {
        if (message.type === 'bridge.ping') {
          return { ok: true };
        }

        if (message.type === 'bridge.execute' && message.method === 'patch.list') {
          throw new Error('No tab with id: 63.');
        }

        return null;
      },
    },
    scripting: {
      /** @param {ExecuteScriptCall} details */
      async executeScript(details) {
        executeScriptCalls.push(details);
        const source = String(details.func);
        if (source.includes('__bb_console_buffer')) {
          throw new Error('Cannot access contents of url "chrome://extensions".');
        }
        throw new Error('Cannot script this page');
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-state-clear-tab-recoverable-${Date.now()}`,
  });

  await assert.doesNotReject(loaded.module.clearTabBridgeState(63));
  assert.deepEqual(
    executeScriptCalls.map((details) => ({
      tabId: details.target?.tabId,
      clear: details.args?.[0],
    })),
    [
      { tabId: 63, clear: true },
      { tabId: 63, clear: true },
    ]
  );
});

test('background state clearWindowBridgeState only clears scriptable tabs and ignores per-tab failures', async () => {
  const patchIdsByTab = new Map([
    [71, ['patch-1']],
    [73, ['patch-3']],
  ]);
  const consoleBuffers = new Map([
    [71, { entries: [{ level: 'log', args: ['tab-71'], ts: 1 }], dropped: 0 }],
    [73, { entries: [{ level: 'warn', args: ['tab-73'], ts: 2 }], dropped: 1 }],
  ]);
  const networkBuffers = new Map([
    [
      71,
      {
        entries: [
          {
            method: 'GET',
            url: 'https://example.com/one',
            status: 200,
            duration: 4,
            type: 'fetch',
            ts: 3,
            size: 10,
          },
        ],
        dropped: 0,
      },
    ],
    [
      73,
      {
        entries: [
          {
            method: 'POST',
            url: 'https://example.com/two',
            status: 500,
            duration: 9,
            type: 'xhr',
            ts: 4,
            size: 20,
          },
        ],
        dropped: 2,
      },
    ],
  ]);
  /** @type {ExecuteScriptCall[]} */
  const executeScriptCalls = [];
  const chrome = createChromeFake({
    tabs: {
      /** @param {chrome.tabs.QueryInfo} [queryInfo] */
      async query(queryInfo = {}) {
        if (Object.keys(queryInfo).length === 0) {
          return [];
        }
        assert.deepEqual(queryInfo, { windowId: 9 });
        return [
          { id: 71, url: 'https://example.com/one' },
          { id: 72, url: 'chrome://settings' },
          { id: null, url: 'https://example.com/no-id' },
          { id: 73, url: 'https://example.com/two' },
        ];
      },
      /** @param {number} tabId @param {Record<string, unknown>} message */
      async sendMessage(tabId, message) {
        if (message.type === 'bridge.ping') {
          return { ok: true };
        }

        if (tabId === 73 && message.type === 'bridge.execute' && message.method === 'patch.list') {
          throw new Error('Patch enumeration failed');
        }

        if (message.type === 'bridge.execute' && message.method === 'patch.list') {
          return {
            patches: (patchIdsByTab.get(tabId) ?? []).map((patchId) => ({ patchId })),
          };
        }

        if (message.type === 'bridge.execute' && message.method === 'patch.rollback') {
          const params = /** @type {{ patchId?: string }} */ (message.params ?? {});
          const patchId = params.patchId;
          if (typeof patchId === 'string') {
            patchIdsByTab.set(
              tabId,
              (patchIdsByTab.get(tabId) ?? []).filter((candidate) => candidate !== patchId)
            );
          }
          return { ok: true };
        }

        return null;
      },
    },
    scripting: {
      executeScript: createBufferedExecuteScript(
        consoleBuffers,
        networkBuffers,
        executeScriptCalls
      ),
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-state-clear-window-bridge-${Date.now()}`,
  });

  await loaded.module.clearWindowBridgeState(9);

  assert.deepEqual(patchIdsByTab.get(71), []);
  assert.deepEqual(consoleBuffers.get(71), { entries: [], dropped: 0 });
  assert.deepEqual(networkBuffers.get(71), { entries: [], dropped: 0 });
  assert.deepEqual(patchIdsByTab.get(73), ['patch-3']);
  assert.deepEqual(consoleBuffers.get(73), {
    entries: [{ level: 'warn', args: ['tab-73'], ts: 2 }],
    dropped: 1,
  });
  assert.deepEqual(networkBuffers.get(73), {
    entries: [
      {
        method: 'POST',
        url: 'https://example.com/two',
        status: 500,
        duration: 9,
        type: 'xhr',
        ts: 4,
        size: 20,
      },
    ],
    dropped: 2,
  });
  assert.deepEqual(
    executeScriptCalls.map((details) => details.target?.tabId),
    [71, 71]
  );
});

test('background state persists enabled-window title updates and refreshes action state', async () => {
  /** @type {Array<chrome.scripting.ScriptInjection<any[], any>>} */
  const executeScriptCalls = [];
  /** @type {Array<Record<string, unknown>>} */
  const badgeTextCalls = [];
  /** @type {Array<Record<string, unknown>>} */
  const titleCalls = [];
  const chrome = createChromeFake({
    tabs: {
      /** @param {number} tabId */
      async get(tabId) {
        assert.equal(tabId, 41);
        return {
          id: 41,
          windowId: 7,
          title: 'Updated title',
          url: 'https://example.com/page',
          status: 'complete',
        };
      },
    },
    action: {
      /** @param {Record<string, unknown>} details */
      async setBadgeText(details) {
        badgeTextCalls.push(details);
      },
      /** @param {Record<string, unknown>} details */
      async setTitle(details) {
        titleCalls.push(details);
      },
    },
    scripting: {
      /** @param {chrome.scripting.ScriptInjection<any[], any>} details */
      async executeScript(details) {
        executeScriptCalls.push(details);
        return [];
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-state-updated-${Date.now()}`,
  });

  const state = loaded.module.getStateForTest();
  state.enabledWindow = {
    windowId: 7,
    title: 'Original title',
    enabledAt: 1,
  };

  loaded.chrome.tabs.onUpdated.dispatch(
    41,
    {
      title: 'Updated title',
      status: 'complete',
    },
    {
      id: 41,
      windowId: 7,
      title: 'Updated title',
      url: 'https://example.com/page',
      status: 'complete',
    }
  );
  await flushAsyncWork();
  await waitForCondition(() => executeScriptCalls.length === 1);
  await waitForCondition(
    () =>
      titleCalls.some(
        (call) => call.tabId === 41 && call.title === 'Browser Bridge is enabled for this window.'
      ) && badgeTextCalls.some((call) => call.tabId === 41 && call.text === 'AI')
  );

  assert.deepEqual(state.enabledWindow, {
    windowId: 7,
    title: 'Updated title',
    enabledAt: 1,
  });
  assert.deepEqual(loaded.chrome.storage.session.snapshot().enabledWindow, {
    windowId: 7,
    title: 'Updated title',
    enabledAt: 1,
  });
  assert.equal(executeScriptCalls.length, 1);
  assert.deepEqual(executeScriptCalls[0].target, { tabId: 41 });
  assert.equal(executeScriptCalls[0].world, 'MAIN');
  assert.equal(
    titleCalls.some(
      (call) => call.tabId === 41 && call.title === 'Browser Bridge is enabled for this window.'
    ),
    true
  );
  assert.equal(
    badgeTextCalls.some((call) => call.tabId === 41 && call.text === 'AI'),
    true
  );
});

test('background state ignores tab updates that do not affect UI state', async () => {
  /** @type {Array<chrome.scripting.ScriptInjection<any[], any>>} */
  const executeScriptCalls = [];
  /** @type {Array<Record<string, unknown>>} */
  const badgeTextCalls = [];
  /** @type {Array<Record<string, unknown>>} */
  const titleCalls = [];
  const chrome = createChromeFake({
    tabs: {
      /** @param {number} tabId */
      async get(tabId) {
        assert.equal(tabId, 42);
        return {
          id: 42,
          windowId: 7,
          title: 'Original title',
          url: 'https://example.com/idle',
          status: 'complete',
        };
      },
    },
    action: {
      /** @param {Record<string, unknown>} details */
      async setBadgeText(details) {
        badgeTextCalls.push(details);
      },
      /** @param {Record<string, unknown>} details */
      async setTitle(details) {
        titleCalls.push(details);
      },
    },
    scripting: {
      /** @param {chrome.scripting.ScriptInjection<any[], any>} details */
      async executeScript(details) {
        executeScriptCalls.push(details);
        return [];
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-state-ignored-update-${Date.now()}`,
  });

  const state = loaded.module.getStateForTest();
  state.enabledWindow = {
    windowId: 7,
    title: 'Original title',
    enabledAt: 2,
  };

  loaded.chrome.tabs.onUpdated.dispatch(
    42,
    {
      favIconUrl: 'https://example.com/favicon.ico',
    },
    {
      id: 42,
      windowId: 7,
      title: 'Original title',
      url: 'https://example.com/idle',
      status: 'complete',
    }
  );
  await flushAsyncWork();

  assert.deepEqual(state.enabledWindow, {
    windowId: 7,
    title: 'Original title',
    enabledAt: 2,
  });
  assert.equal(loaded.chrome.storage.session.snapshot().enabledWindow, undefined);
  assert.deepEqual(executeScriptCalls, []);
  assert.deepEqual(titleCalls, []);
  assert.deepEqual(badgeTextCalls, []);
});

test('background state clears enabled access and updates the action when the enabled window closes', async () => {
  /** @type {unknown[]} */
  const nativeMessages = [];
  /** @type {Array<Record<string, unknown>>} */
  const badgeTextCalls = [];
  /** @type {Array<Record<string, unknown>>} */
  const titleCalls = [];
  const chrome = createChromeFake({
    runtime: {
      connectNative() {
        return createNativePort(nativeMessages);
      },
    },
    tabs: {
      async get() {
        throw new Error('No tab with id: 52.');
      },
    },
    action: {
      /** @param {Record<string, unknown>} details */
      async setBadgeText(details) {
        badgeTextCalls.push(details);
      },
      /** @param {Record<string, unknown>} details */
      async setTitle(details) {
        titleCalls.push(details);
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-state-removed-${Date.now()}`,
  });

  const state = loaded.module.getStateForTest();
  state.enabledWindow = {
    windowId: 7,
    title: 'Workspace',
    enabledAt: 9,
  };
  state.requestedAccessWindowId = 7;
  await loaded.chrome.storage.session.set({ enabledWindow: state.enabledWindow });

  loaded.chrome.tabs.onRemoved.dispatch(52, {
    windowId: 7,
    isWindowClosing: true,
  });
  await flushAsyncWork();

  assert.equal(state.enabledWindow, null);
  assert.equal(state.requestedAccessWindowId, null);
  assert.equal(loaded.chrome.storage.session.snapshot().enabledWindow, undefined);
  assert.deepEqual(titleCalls.at(-1), {
    tabId: 52,
    title: 'Browser Bridge',
  });
  assert.deepEqual(badgeTextCalls.at(-1), { tabId: 52, text: '' });
  assert.deepEqual(nativeMessages.at(-1), {
    type: 'host.access_update',
    accessEnabled: false,
  });
});

test('background state only clears the requested access popup for the matching window', async () => {
  const loaded = await loadBackground({
    query: `test-background-state-popup-window-${Date.now()}`,
  });

  const state = loaded.module.getStateForTest();
  state.requestedAccessPopupWindowId = 91;

  loaded.chrome.windows.onRemoved.dispatch(44);
  assert.equal(state.requestedAccessPopupWindowId, 91);

  loaded.chrome.windows.onRemoved.dispatch(91);
  assert.equal(state.requestedAccessPopupWindowId, null);
});

test('background state window and requested-access predicates reflect live state', async () => {
  const loaded = await loadBackground({
    query: `test-background-state-predicates-${Date.now()}`,
  });

  const state = loaded.module.getStateForTest();
  state.enabledWindow = {
    windowId: 12,
    title: 'Workspace',
    enabledAt: 3,
  };
  state.requestedAccessWindowId = 34;
  state.requestedAccessPopupWindowId = 55;

  assert.equal(loaded.module.isWindowEnabled(12), true);
  assert.equal(loaded.module.isWindowEnabled(99), false);
  assert.equal(loaded.module.isAccessRequestedWindow(34), true);
  assert.equal(loaded.module.isAccessRequestedWindow(35), false);

  loaded.module.clearRequestedAccessWindow(99);
  assert.equal(state.requestedAccessWindowId, 34);

  loaded.module.clearRequestedAccessWindow(34);
  assert.equal(state.requestedAccessWindowId, null);

  state.requestedAccessWindowId = 88;
  loaded.module.clearRequestedAccessWindow();
  assert.equal(state.requestedAccessWindowId, null);

  loaded.module.clearRequestedAccessPopupWindow(44);
  assert.equal(state.requestedAccessPopupWindowId, 55);

  loaded.module.clearRequestedAccessPopupWindow(55);
  assert.equal(state.requestedAccessPopupWindowId, null);

  state.requestedAccessPopupWindowId = 77;
  loaded.module.clearRequestedAccessPopupWindow();
  assert.equal(state.requestedAccessPopupWindowId, null);
});

test('background state tab-level predicates handle enabled, requested, and missing tabs', async () => {
  const chrome = createChromeFake({
    tabs: {
      /** @param {number} tabId */
      async get(tabId) {
        if (tabId === 12) {
          return { id: 12, windowId: 7 };
        }
        if (tabId === 20) {
          return { id: 20, windowId: 9 };
        }
        throw new Error(`No tab with id: ${tabId}.`);
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-state-tab-predicates-${Date.now()}`,
  });

  const state = loaded.module.getStateForTest();
  state.enabledWindow = {
    windowId: 7,
    title: 'Enabled',
    enabledAt: 1,
  };
  state.requestedAccessWindowId = 9;

  assert.equal(await loaded.module.isTabEnabled(12), true);
  assert.equal(await loaded.module.isTabEnabled(20), false);
  assert.equal(await loaded.module.isTabEnabled(404), false);

  assert.equal(await loaded.module.isAccessRequestedTab(20), true);
  assert.equal(await loaded.module.isAccessRequestedTab(12), false);
  assert.equal(await loaded.module.isAccessRequestedTab(404), false);
});

test('background state updateActionIndicatorForTab marks enabled tabs', async () => {
  /** @type {Array<Record<string, unknown>>} */
  const badgeBackgroundCalls = [];
  /** @type {Array<Record<string, unknown>>} */
  const badgeTextColorCalls = [];
  /** @type {Array<Record<string, unknown>>} */
  const badgeTextCalls = [];
  /** @type {Array<Record<string, unknown>>} */
  const titleCalls = [];
  const chrome = createChromeFake({
    tabs: {
      /** @param {number} tabId */
      async get(tabId) {
        assert.equal(tabId, 17);
        return {
          id: 17,
          windowId: 4,
          url: 'https://example.com/app',
        };
      },
    },
    action: {
      /** @param {Record<string, unknown>} details */
      async setBadgeBackgroundColor(details) {
        badgeBackgroundCalls.push(details);
      },
      /** @param {Record<string, unknown>} details */
      async setBadgeTextColor(details) {
        badgeTextColorCalls.push(details);
      },
      /** @param {Record<string, unknown>} details */
      async setBadgeText(details) {
        badgeTextCalls.push(details);
      },
      /** @param {Record<string, unknown>} details */
      async setTitle(details) {
        titleCalls.push(details);
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-state-action-enabled-${Date.now()}`,
  });

  loaded.module.getStateForTest().enabledWindow = {
    windowId: 4,
    title: 'App',
    enabledAt: 1,
  };

  await loaded.module.updateActionIndicatorForTab(17);

  assert.deepEqual(badgeBackgroundCalls, [{ tabId: 17, color: '#787878' }]);
  assert.deepEqual(badgeTextColorCalls, [{ tabId: 17, color: '#ffffff' }]);
  assert.deepEqual(titleCalls, [
    {
      tabId: 17,
      title: 'Browser Bridge is enabled for this window.',
    },
  ]);
  assert.deepEqual(badgeTextCalls, [{ tabId: 17, text: 'AI' }]);
});

test('background state updateActionIndicatorForTab marks requested restricted tabs and swallows tab mismatch', async () => {
  /** @type {Array<Record<string, unknown>>} */
  const badgeBackgroundCalls = [];
  /** @type {Array<Record<string, unknown>>} */
  const badgeTextColorCalls = [];
  /** @type {Array<Record<string, unknown>>} */
  const badgeTextCalls = [];
  /** @type {Array<Record<string, unknown>>} */
  const titleCalls = [];
  const chrome = createChromeFake({
    tabs: {
      /** @param {number} tabId */
      async get(tabId) {
        if (tabId === 21) {
          return {
            id: 21,
            windowId: 6,
            url: 'chrome://settings',
          };
        }
        if (tabId === 22) {
          return {
            id: 22,
            windowId: 11,
            url: 'https://example.com/request',
          };
        }
        throw new Error(`No tab with id: ${tabId}.`);
      },
    },
    action: {
      /** @param {Record<string, unknown>} details */
      async setBadgeBackgroundColor(details) {
        badgeBackgroundCalls.push(details);
      },
      /** @param {Record<string, unknown>} details */
      async setBadgeTextColor(details) {
        badgeTextColorCalls.push(details);
      },
      /** @param {Record<string, unknown>} details */
      async setBadgeText(details) {
        if (details.tabId === 23) {
          throw new Error('No tab with id: 23');
        }
        badgeTextCalls.push(details);
      },
      /** @param {Record<string, unknown>} details */
      async setTitle(details) {
        titleCalls.push(details);
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-state-action-requested-restricted-${Date.now()}`,
  });

  const state = loaded.module.getStateForTest();
  state.enabledWindow = {
    windowId: 6,
    title: 'Settings',
    enabledAt: 1,
  };

  await loaded.module.updateActionIndicatorForTab(21);
  assert.deepEqual(badgeBackgroundCalls.at(-1), { tabId: 21, color: '#e07020' });
  assert.deepEqual(badgeTextColorCalls.at(-1), { tabId: 21, color: '#ffffff' });
  assert.deepEqual(titleCalls.at(-1), {
    tabId: 21,
    title: 'Browser Bridge is enabled, but this page cannot be interacted with.',
  });
  assert.deepEqual(badgeTextCalls.at(-1), { tabId: 21, text: '!' });

  state.enabledWindow = null;
  state.requestedAccessWindowId = 11;

  await loaded.module.updateActionIndicatorForTab(22);
  assert.deepEqual(badgeBackgroundCalls.at(-1), { tabId: 22, color: '#f2cf2f' });
  assert.deepEqual(badgeTextColorCalls.at(-1), { tabId: 22, color: '#000000' });
  assert.deepEqual(titleCalls.at(-1), {
    tabId: 22,
    title:
      'Agent requested Browser Bridge access for this window. Click to open Browser Bridge, then click Enable.',
  });
  assert.deepEqual(badgeTextCalls.at(-1), { tabId: 22, text: '!' });

  await assert.doesNotReject(loaded.module.updateActionIndicatorForTab(23));
  assert.equal(
    badgeBackgroundCalls.some((details) => details.tabId === 23),
    true
  );
  assert.equal(
    titleCalls.some((details) => details.tabId === 23 && details.title === 'Browser Bridge'),
    true
  );
  assert.equal(
    badgeTextCalls.some((details) => details.tabId === 23),
    false
  );
});
