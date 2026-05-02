// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { createChromeEvent, createChromeFake } from '../../../tests/_helpers/chromeFake.js';
import { loadBackground } from '../../../tests/_helpers/loadBackground.js';
import { createMessagePortPair } from '../../../tests/_helpers/messagePort.js';
import { createRequest } from '../../protocol/src/index.js';

/**
 * @typedef {{ handle: ReturnType<typeof setTimeout>, callback: () => void, delay: number }} ScheduledTimer
 */

/**
 * @param {unknown[]} messages
 * @returns {any}
 */
function createNativePort(messages) {
  const onMessage = createChromeEvent();
  return {
    /** @param {unknown} message */
    postMessage(message) {
      messages.push(message);
      const candidate =
        /** @type {{ type?: string, request?: { id?: string, method?: string } }} */ (message);
      const request = candidate.request;
      if (
        candidate.type === 'host.bridge_request' &&
        request?.method === 'setup.get_status' &&
        typeof request.id === 'string'
      ) {
        queueMicrotask(() => {
          onMessage.dispatch({
            type: 'host.setup_status.response',
            requestId: request.id,
            status: {
              mcpClients: [],
              skillTargets: [],
            },
          });
        });
      }
    },
    disconnect() {},
    onMessage,
    onDisconnect: createChromeEvent(),
    name: 'native',
  };
}

/**
 * @param {number} [count]
 * @returns {Promise<void>}
 */
async function flushAsyncWork(count = 8) {
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
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(predicate(), true);
}

/**
 * @returns {{
 *   scheduled: ScheduledTimer[],
 *   cleared: ReturnType<typeof setTimeout>[],
 *   restore: () => void,
 * }}
 */
function installManualTimers() {
  const savedSetTimeout = globalThis.setTimeout;
  const savedClearTimeout = globalThis.clearTimeout;
  /** @type {ScheduledTimer[]} */
  const scheduled = [];
  /** @type {ReturnType<typeof setTimeout>[]} */
  const cleared = [];

  Reflect.set(
    globalThis,
    'setTimeout',
    /** @type {typeof setTimeout} */ (
      /** @type {unknown} */ (
        /** @param {TimerHandler} callback @param {number | undefined} delay @param {unknown[]} args */
        (callback, delay, ...args) => {
          const handle = /** @type {ReturnType<typeof setTimeout>} */ (
            /** @type {unknown} */ ({ id: `timer-${scheduled.length}` })
          );
          scheduled.push({
            handle,
            delay: Number(delay ?? 0),
            callback: () => {
              if (typeof callback === 'function') {
                callback(...args);
              }
            },
          });
          return handle;
        }
      )
    )
  );
  Reflect.set(
    globalThis,
    'clearTimeout',
    /** @type {typeof clearTimeout} */ (
      /** @param {ReturnType<typeof setTimeout>} handle */
      (handle) => {
        cleared.push(handle);
      }
    )
  );

  return {
    scheduled,
    cleared,
    restore() {
      Reflect.set(globalThis, 'setTimeout', savedSetTimeout);
      Reflect.set(globalThis, 'clearTimeout', savedClearTimeout);
    },
  };
}

/**
 * @param {chrome.scripting.ScriptInjection<any[], any> & { args?: unknown[] }} details
 * @returns {'inject' | 'console' | 'network' | 'other'}
 */
function classifyExecuteScript(details) {
  if (Array.isArray(details.files)) {
    return 'inject';
  }
  const source = String(details.func);
  if (source.includes('__bb_console_buffer')) {
    return 'console';
  }
  if (source.includes('__bb_network_buffer')) {
    return 'network';
  }
  return 'other';
}

/**
 * @param {unknown[]} messages
 * @param {string} type
 * @returns {Record<string, any> | undefined}
 */
function findMessage(messages, type) {
  return /** @type {Record<string, any> | undefined} */ (
    messages.find(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === type
    )
  );
}

/**
 * @param {unknown[]} messages
 * @returns {Array<{ type: 'state.sync', state: Record<string, any> }>}
 */
function getStateSyncMessages(messages) {
  return /** @type {Array<{ type: 'state.sync', state: Record<string, any> }>} */ (
    messages.filter(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'state.sync'
    )
  );
}

test('background native enable flow primes console capture and swallows recoverable tab errors', async () => {
  /** @type {unknown[]} */
  const nativeMessages = [];
  /** @type {Array<{ tabId: number | undefined, args: unknown[] | null }>} */
  const executeScriptCalls = [];
  const nativePort = createNativePort(nativeMessages);
  const portPair = createMessagePortPair({ leftName: 'ui-popup', rightName: 'agent' });
  const tabsById = new Map([
    [
      31,
      {
        id: 31,
        windowId: 8,
        title: 'Current Window',
        url: 'https://example.com/current',
        status: 'complete',
      },
    ],
    [
      32,
      {
        id: 32,
        windowId: 8,
        title: 'Restricted Tab',
        url: 'chrome://settings',
        status: 'complete',
      },
    ],
  ]);
  const loaded = await loadBackground({
    chrome: createChromeFake({
      runtime: {
        connectNative() {
          return nativePort;
        },
      },
      tabs: {
        /** @param {chrome.tabs.QueryInfo} [queryInfo] */
        async query(queryInfo = {}) {
          if (queryInfo.active && queryInfo.lastFocusedWindow) {
            return [tabsById.get(31)];
          }
          if (queryInfo.windowId === 8) {
            return [tabsById.get(31), tabsById.get(32), { id: null, windowId: 8 }];
          }
          return [];
        },
        /** @param {number} tabId */
        async get(tabId) {
          const tab = tabsById.get(tabId);
          if (!tab) {
            throw new Error(`No tab with id: ${tabId}.`);
          }
          return tab;
        },
        /** @param {number} _tabId @param {Record<string, unknown>} message */
        async sendMessage(_tabId, message) {
          if (message.type === 'bridge.ping') {
            return { ok: true };
          }
          return null;
        },
      },
      scripting: {
        /** @param {chrome.scripting.ScriptInjection<any[], any> & { args?: unknown[] }} details */
        async executeScript(details) {
          executeScriptCalls.push({
            tabId: details.target?.tabId,
            args: Array.isArray(details.args) ? details.args : null,
          });
          if (details.target?.tabId === 32) {
            throw new Error('Cannot access contents of url "chrome://settings".');
          }
          if (Array.isArray(details.args)) {
            return [
              { result: { entries: [{ level: 'log', args: ['stale'], ts: 1 }], dropped: 1 } },
            ];
          }
          return [];
        },
      },
    }),
    query: `test-background-native-console-prime-${Date.now()}-${Math.random()}`,
  });

  loaded.chrome.runtime.onConnect.dispatch(portPair.left.port);
  await flushAsyncWork();
  portPair.left.postedMessages.length = 0;

  portPair.left.dispatchMessage({ type: 'scope.set_enabled', enabled: true });
  await flushAsyncWork();
  await waitForCondition(() => executeScriptCalls.length === 3);

  const state = loaded.module.getStateForTest();
  assert.equal(state.enabledWindow?.windowId, 8);
  assert.equal(
    portPair.left.postedMessages.some(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'toggle.error'
    ),
    false
  );
  assert.deepEqual(executeScriptCalls, [
    { tabId: 31, args: null },
    { tabId: 32, args: null },
    { tabId: 31, args: [true] },
  ]);
  assert.deepEqual(findMessage(nativeMessages, 'host.access_update'), {
    type: 'host.access_update',
    accessEnabled: true,
  });
});

test('background native tab updates log non-recoverable console priming failures', async () => {
  /** @type {Error[]} */
  const loggedErrors = [];
  const savedConsoleError = console.error;
  const loaded = await loadBackground({
    chrome: createChromeFake({
      tabs: {
        /** @param {number} tabId */
        async get(tabId) {
          return {
            id: tabId,
            windowId: 8,
            title: 'Current Window',
            url: 'https://example.com/current',
            status: 'complete',
          };
        },
      },
      scripting: {
        async executeScript() {
          throw new Error('console priming failed');
        },
      },
    }),
    query: `test-background-native-console-prime-error-${Date.now()}-${Math.random()}`,
  });

  console.error = /** @param {unknown} error */ (error) => {
    loggedErrors.push(error instanceof Error ? error : new Error(String(error)));
  };

  try {
    loaded.module.getStateForTest().enabledWindow = {
      windowId: 8,
      title: 'Current Window',
      enabledAt: Date.now(),
    };

    loaded.chrome.tabs.onUpdated.dispatch(
      31,
      { status: 'complete' },
      {
        id: 31,
        windowId: 8,
        title: 'Current Window',
        url: 'https://example.com/current',
        status: 'complete',
      }
    );
    await flushAsyncWork();
  } finally {
    console.error = savedConsoleError;
  }

  assert.equal(loggedErrors.length, 1);
  assert.equal(loggedErrors[0]?.message, 'console priming failed');
});

test('background native scheduleNativeReconnect backs off and clears the prior reconnect timer', async () => {
  /** @type {unknown[]} */
  const nativeMessages = [];
  const nativePort = createNativePort(nativeMessages);
  const loaded = await loadBackground({
    chrome: createChromeFake({
      runtime: {
        connectNative() {
          return nativePort;
        },
      },
    }),
    query: `test-background-native-backoff-${Date.now()}-${Math.random()}`,
  });

  const timers = installManualTimers();
  try {
    const state = loaded.module.getStateForTest();
    const staleStatusTimer = /** @type {ReturnType<typeof setTimeout>} */ (
      /** @type {unknown} */ ({ id: 'status-timeout' })
    );
    state.setupStatus = {
      mcpClients: [{ configured: true }],
      skillTargets: [{ target: 'cursor' }],
    };
    state.setupStatusPending = true;
    state.setupStatusPendingRequestId = 'pending-status';
    state.setupStatusUpdatedAt = 123;
    state.setupStatusError = 'stale';
    state.setupStatusTimeoutId = staleStatusTimer;

    loaded.module.scheduleNativeReconnect('bridge down', {
      method: 'native.disconnect',
      summaryPrefix: 'Native host disconnected',
      updateDisconnectedUi: false,
    });
    loaded.module.scheduleNativeReconnect('still down', {
      method: 'native.disconnect',
      summaryPrefix: 'Native host disconnected',
      updateDisconnectedUi: false,
    });
    await flushAsyncWork();

    assert.equal(state.nativeReconnectAttempts, 2);
    assert.equal(state.setupStatus, null);
    assert.equal(state.setupStatusPending, false);
    assert.equal(state.setupStatusPendingRequestId, null);
    assert.equal(state.setupStatusUpdatedAt, 0);
    assert.equal(state.setupStatusError, 'still down');
    assert.equal(state.setupStatusTimeoutId, null);
    assert.deepEqual(
      timers.scheduled.map((entry) => entry.delay),
      [2000, 4000]
    );
    assert.deepEqual(timers.cleared, [staleStatusTimer, timers.scheduled[0].handle]);
    assert.equal(
      state.actionLog.at(-1)?.summary,
      'Native host disconnected (attempt 2): still down. Reconnecting in 4000ms.'
    );
  } finally {
    timers.restore();
  }
});

test('background native scheduleNativeReconnect broadcasts disconnect state and logs reconnect recovery', async () => {
  /** @type {unknown[]} */
  const firstPortMessages = [];
  /** @type {unknown[]} */
  const secondPortMessages = [];
  const firstNativePort = createNativePort(firstPortMessages);
  const secondNativePort = createNativePort(secondPortMessages);
  const connectedPorts = [firstNativePort, secondNativePort];
  let connectCalls = 0;
  const portPair = createMessagePortPair({ leftName: 'ui-popup', rightName: 'agent' });
  const loaded = await loadBackground({
    chrome: createChromeFake({
      runtime: {
        connectNative() {
          const port = connectedPorts[connectCalls];
          connectCalls += 1;
          if (!port) {
            throw new Error('Unexpected connectNative call');
          }
          return port;
        },
      },
    }),
    query: `test-background-native-reconnect-${Date.now()}-${Math.random()}`,
  });

  loaded.chrome.runtime.onConnect.dispatch(portPair.left.port);
  await flushAsyncWork();
  portPair.left.postedMessages.length = 0;

  const timers = installManualTimers();
  try {
    const state = loaded.module.getStateForTest();
    state.setupStatus = {
      mcpClients: [{ configured: true }],
      skillTargets: [],
    };

    loaded.module.scheduleNativeReconnect('native host exited', {
      method: 'native.disconnect',
      summaryPrefix: 'Native host disconnected',
      updateDisconnectedUi: true,
    });
    await flushAsyncWork();

    assert.equal(state.nativePort, null);
    assert.equal(state.nativeReconnectAttempts, 1);
    assert.deepEqual(findMessage(portPair.left.postedMessages, 'native.status'), {
      type: 'native.status',
      connected: false,
      error: 'native host exited',
    });
    assert.deepEqual(portPair.left.postedMessages.at(-1), {
      type: 'state.sync',
      state: {
        nativeConnected: false,
        currentTab: null,
        setupStatus: null,
        setupStatusPending: false,
        setupStatusError: null,
        setupInstallPendingKey: null,
        setupInstallError: null,
        actionLog: [state.actionLog[0]],
      },
    });
    assert.equal(timers.scheduled[0]?.delay, 2000);

    timers.scheduled[0].callback();
    assert.equal(connectCalls, 2);
    assert.equal(timers.scheduled[1]?.delay, 500);

    timers.scheduled[1].callback();
    await flushAsyncWork();

    assert.equal(state.nativePort, secondNativePort);
    assert.equal(state.nativeReconnectAttempts, 0);
    assert.deepEqual(findMessage(portPair.left.postedMessages, 'native.status'), {
      type: 'native.status',
      connected: false,
      error: 'native host exited',
    });
    assert.equal(
      portPair.left.postedMessages.some(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'native.status' &&
          'connected' in message &&
          message.connected === true
      ),
      true
    );
    assert.equal(findMessage(secondPortMessages, 'host.activity')?.type, 'host.activity');
    assert.equal(findMessage(secondPortMessages, 'host.identity')?.type, 'host.identity');
    assert.equal(
      findMessage(secondPortMessages, 'host.bridge_request')?.request?.method,
      'setup.get_status'
    );
    assert.equal(
      state.actionLog.at(-2)?.summary,
      'Native host disconnected (attempt 1): native host exited. Reconnecting in 2000ms.'
    );
    assert.equal(state.actionLog.at(-1)?.summary, 'Native host reconnected after 1 attempt.');
  } finally {
    timers.restore();
  }
});

test('background native enable flow broadcasts synced UI state and posts an access update', async () => {
  /** @type {unknown[]} */
  const nativeMessages = [];
  const nativePort = createNativePort(nativeMessages);
  const popupPort = createMessagePortPair({ leftName: 'ui-popup', rightName: 'agent' });
  const sidePanelPort = createMessagePortPair({ leftName: 'ui-sidepanel', rightName: 'agent' });
  const chrome = createChromeFake({
    runtime: {
      connectNative() {
        return nativePort;
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
      async sendMessage() {
        return { ok: true };
      },
    },
    alarms: {
      async create() {},
      async clear() {
        return true;
      },
    },
    scripting: {
      async executeScript() {
        return [{ result: { entries: [], dropped: 0 } }];
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-native-access-update-${Date.now()}-${Math.random()}`,
  });

  loaded.chrome.runtime.onConnect.dispatch(popupPort.left.port);
  loaded.chrome.runtime.onConnect.dispatch(sidePanelPort.left.port);
  await flushAsyncWork();
  popupPort.left.postedMessages.length = 0;
  sidePanelPort.left.postedMessages.length = 0;

  popupPort.left.dispatchMessage({ type: 'scope.set_enabled', enabled: true });
  await flushAsyncWork();
  await waitForCondition(() => getStateSyncMessages(popupPort.left.postedMessages).length > 0);

  const state = loaded.module.getStateForTest();
  assert.equal(state.enabledWindow?.windowId, 8);

  const popupSync = getStateSyncMessages(popupPort.left.postedMessages).at(-1);
  const sidePanelSync = getStateSyncMessages(sidePanelPort.left.postedMessages).at(-1);
  assert.deepEqual(popupSync, {
    type: 'state.sync',
    state: {
      nativeConnected: true,
      currentTab: {
        tabId: 31,
        windowId: 8,
        title: 'Current Window',
        url: 'https://example.com/current',
        enabled: true,
        accessRequested: false,
        restricted: false,
      },
      setupStatus: {
        mcpClients: [],
        skillTargets: [],
      },
      setupStatusPending: false,
      setupStatusError: null,
      setupInstallPendingKey: null,
      setupInstallError: null,
      actionLog: [],
    },
  });
  assert.deepEqual(sidePanelSync, popupSync);
  await waitForCondition(() => Boolean(findMessage(nativeMessages, 'host.access_update')));
  assert.deepEqual(findMessage(nativeMessages, 'host.access_update'), {
    type: 'host.access_update',
    accessEnabled: true,
  });
});

test('background native page.get_network falls back to an empty buffer when the page read returns no result', async () => {
  /** @type {Array<{ target: chrome.scripting.InjectionTarget | undefined, world: string | undefined, args: unknown[] | null }>} */
  const executeScriptCalls = [];
  const activeTab = /** @type {chrome.tabs.Tab} */ ({
    id: 75,
    windowId: 7,
    active: true,
    title: 'Network buffer page',
    url: 'https://example.com/network-buffer',
    status: 'complete',
  });
  const loaded = await loadBackground({
    chrome: createChromeFake({
      tabs: {
        /** @param {chrome.tabs.QueryInfo} [queryInfo] */
        async query(queryInfo = /** @type {chrome.tabs.QueryInfo} */ ({})) {
          if (queryInfo.active && queryInfo.windowId === activeTab.windowId) {
            return [activeTab];
          }
          if (queryInfo.active && queryInfo.lastFocusedWindow) {
            return [];
          }
          return [];
        },
        /** @param {number} tabId */
        async get(tabId) {
          assert.equal(tabId, activeTab.id);
          return activeTab;
        },
      },
      windows: {
        /** @param {number} windowId */
        async get(windowId) {
          return { id: windowId };
        },
      },
      scripting: {
        /** @param {chrome.scripting.ScriptInjection<any[], any> & { args?: unknown[] }} details */
        async executeScript(details) {
          executeScriptCalls.push({
            target: details.target,
            world: details.world,
            args: Array.isArray(details.args) ? details.args : null,
          });
          return [];
        },
      },
    }),
    query: `test-background-native-network-empty-${Date.now()}-${Math.random()}`,
  });

  loaded.module.getStateForTest().enabledWindow = {
    windowId: activeTab.windowId,
    title: 'Enabled Window',
    enabledAt: Date.now(),
  };

  const response = await loaded.dispatch(
    createRequest({
      id: 'native-page-network-empty',
      method: 'page.get_network',
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.equal(response.meta?.method, 'page.get_network');
  assert.deepEqual(response.result, {
    entries: [],
    count: 0,
    total: 0,
    dropped: 0,
  });
  assert.deepEqual(executeScriptCalls, [
    {
      target: { tabId: 75 },
      world: 'MAIN',
      args: null,
    },
    {
      target: { tabId: 75 },
      world: 'MAIN',
      args: [false],
    },
  ]);
});

test('background native clearTabBridgeState surfaces unexpected network buffer read failures', async () => {
  /** @type {Array<{ tabId: number | undefined, clear: unknown, source: string }>} */
  const executeScriptCalls = [];
  const loaded = await loadBackground({
    chrome: createChromeFake({
      tabs: {
        /** @param {number} _tabId @param {Record<string, unknown>} message */
        async sendMessage(_tabId, message) {
          if (message.type === 'bridge.ping') {
            return { ok: true };
          }

          if (message.type === 'bridge.execute' && message.method === 'patch.list') {
            return { patches: [] };
          }

          return null;
        },
      },
      scripting: {
        /** @param {chrome.scripting.ScriptInjection<any[], any> & { args?: unknown[] }} details */
        async executeScript(details) {
          const source = String(details.func);
          executeScriptCalls.push({
            tabId: details.target?.tabId,
            clear: details.args?.[0],
            source,
          });
          if (source.includes('__bb_console_buffer')) {
            return [{ result: { entries: [], dropped: 0 } }];
          }
          if (source.includes('__bb_network_buffer')) {
            throw new Error('network buffer exploded');
          }
          return [];
        },
      },
    }),
    query: `test-background-native-network-error-${Date.now()}-${Math.random()}`,
  });

  await assert.rejects(loaded.module.clearTabBridgeState(91), /network buffer exploded/);
  assert.deepEqual(
    executeScriptCalls.map((call) => ({
      tabId: call.tabId,
      clear: call.clear,
      source: call.source.includes('__bb_console_buffer')
        ? 'console'
        : call.source.includes('__bb_network_buffer')
          ? 'network'
          : 'other',
    })),
    [
      {
        tabId: 91,
        clear: true,
        source: 'console',
      },
      {
        tabId: 91,
        clear: true,
        source: 'network',
      },
    ]
  );
});

test('background native enable flow injects content scripts after ping timeouts and skips restricted tabs', async () => {
  /** @type {unknown[]} */
  const nativeMessages = [];
  /** @type {Array<{ tabId: number, type: string, method: string | undefined }>} */
  const sendMessageCalls = [];
  /** @type {Array<{ tabId: number | undefined, kind: 'inject' | 'console' | 'network' | 'other', files?: string[] }>} */
  const executeScriptCalls = [];
  const nativePort = createNativePort(nativeMessages);
  const portPair = createMessagePortPair({ leftName: 'ui-popup', rightName: 'agent' });
  const tabsById = new Map([
    [
      41,
      {
        id: 41,
        windowId: 8,
        title: 'Scriptable Tab',
        url: 'https://example.com/scriptable',
        status: 'complete',
      },
    ],
    [
      42,
      {
        id: 42,
        windowId: 8,
        title: 'Restricted Tab',
        url: 'chrome://settings',
        status: 'complete',
      },
    ],
  ]);
  const loaded = await loadBackground({
    chrome: createChromeFake({
      runtime: {
        connectNative() {
          return nativePort;
        },
      },
      tabs: {
        /** @param {chrome.tabs.QueryInfo} [queryInfo] */
        async query(queryInfo = {}) {
          if (queryInfo.active && queryInfo.lastFocusedWindow) {
            return [tabsById.get(41)];
          }
          if (queryInfo.windowId === 8) {
            return [tabsById.get(41), tabsById.get(42)];
          }
          return [];
        },
        /** @param {number} tabId */
        async get(tabId) {
          const tab = tabsById.get(tabId);
          if (!tab) {
            throw new Error(`No tab with id: ${tabId}.`);
          }
          return tab;
        },
        /** @param {number} tabId @param {Record<string, unknown>} message */
        async sendMessage(tabId, message) {
          sendMessageCalls.push({
            tabId,
            type: String(message.type),
            method: typeof message.method === 'string' ? message.method : undefined,
          });
          if (message.type === 'bridge.ping' && tabId === 41) {
            return new Promise(() => {});
          }
          return { ok: true };
        },
      },
      scripting: {
        /** @param {chrome.scripting.ScriptInjection<any[], any> & { args?: unknown[] }} details */
        async executeScript(details) {
          executeScriptCalls.push({
            tabId: details.target?.tabId,
            kind: classifyExecuteScript(details),
            files: Array.isArray(details.files) ? details.files.map(String) : undefined,
          });
          if (details.target?.tabId === 42) {
            throw new Error('Cannot access contents of url "chrome://settings".');
          }
          if (Array.isArray(details.args)) {
            return [{ result: { entries: [], dropped: 0 } }];
          }
          return [];
        },
      },
    }),
    query: `test-background-native-content-script-timeout-${Date.now()}-${Math.random()}`,
  });

  loaded.chrome.runtime.onConnect.dispatch(portPair.left.port);
  await flushAsyncWork();
  portPair.left.postedMessages.length = 0;

  const timers = installManualTimers();
  try {
    portPair.left.dispatchMessage({ type: 'scope.set_enabled', enabled: true });
    await flushAsyncWork();
    await waitForCondition(() => timers.scheduled.length === 1);

    assert.equal(timers.scheduled.length, 1);
    assert.equal(timers.scheduled[0]?.delay, 5000);

    timers.scheduled[0].callback();
    await flushAsyncWork();

    assert.deepEqual(sendMessageCalls, [
      {
        tabId: 41,
        type: 'bridge.ping',
        method: undefined,
      },
    ]);
    assert.deepEqual(
      executeScriptCalls.filter((call) => call.kind === 'inject'),
      [
        {
          tabId: 41,
          kind: 'inject',
          files: [
            'packages/extension/src/content-script-helpers.js',
            'packages/extension/src/content-script.js',
          ],
        },
      ]
    );
    assert.equal(
      portPair.left.postedMessages.some(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'toggle.error'
      ),
      false
    );
  } finally {
    timers.restore();
  }
});

test('background native clearTabBridgeState swallows restricted content script cleanup failures', async () => {
  /** @type {Array<{ tabId: number, type: string, method: string | undefined }>} */
  const sendMessageCalls = [];
  /** @type {Array<{ tabId: number | undefined, kind: 'inject' | 'console' | 'network' | 'other' }>} */
  const executeScriptCalls = [];
  const loaded = await loadBackground({
    chrome: createChromeFake({
      tabs: {
        /** @param {number} tabId @param {Record<string, unknown>} message */
        async sendMessage(tabId, message) {
          sendMessageCalls.push({
            tabId,
            type: String(message.type),
            method: typeof message.method === 'string' ? message.method : undefined,
          });
          throw new Error('Receiving end does not exist.');
        },
      },
      scripting: {
        /** @param {chrome.scripting.ScriptInjection<any[], any> & { args?: unknown[] }} details */
        async executeScript(details) {
          executeScriptCalls.push({
            tabId: details.target?.tabId,
            kind: classifyExecuteScript(details),
          });
          throw new Error('Cannot access contents of url "chrome://settings".');
        },
      },
    }),
    query: `test-background-native-content-script-restricted-${Date.now()}-${Math.random()}`,
  });

  await assert.doesNotReject(loaded.module.clearTabBridgeState(92));
  assert.deepEqual(sendMessageCalls, [
    {
      tabId: 92,
      type: 'bridge.ping',
      method: undefined,
    },
  ]);
  assert.deepEqual(executeScriptCalls, [
    {
      tabId: 92,
      kind: 'inject',
    },
    {
      tabId: 92,
      kind: 'console',
    },
    {
      tabId: 92,
      kind: 'network',
    },
  ]);
});
