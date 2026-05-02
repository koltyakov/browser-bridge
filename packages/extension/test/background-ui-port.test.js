// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { createChromeEvent, createChromeFake } from '../../../tests/_helpers/chromeFake.js';
import { loadBackground } from '../../../tests/_helpers/loadBackground.js';
import { createMessagePortPair } from '../../../tests/_helpers/messagePort.js';
import { createRequest, createSuccess } from '../../protocol/src/index.js';

/**
 * @param {unknown[]} messages
 * @param {{
 *   mcpClients?: unknown[],
 *   skillTargets?: unknown[]
 * }} [setupStatus]
 * @returns {{
 *   postMessage: (message: unknown) => void,
 *   disconnect: () => void,
 *   onMessage: ReturnType<typeof createChromeEvent>,
 *   onDisconnect: ReturnType<typeof createChromeEvent>,
 *   name: string
 * }}
 */
function createNativePort(messages, setupStatus = {}) {
  const onMessage = createChromeEvent();
  return {
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
              mcpClients: setupStatus.mcpClients ?? [],
              skillTargets: setupStatus.skillTargets ?? [],
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

/**
 * @typedef {{
 *   type: 'host.bridge_request',
 *   request: {
 *     id: string,
 *     method: 'setup.install',
 *     params: {
 *       action: string,
 *       kind: string,
 *       target: string,
 *     }
 *   }
 * }} SetupInstallRequestMessage
 */

/**
 * @param {unknown} message
 * @returns {message is SetupInstallRequestMessage}
 */
function isSetupInstallRequestMessage(message) {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'host.bridge_request' &&
    'request' in message &&
    typeof message.request === 'object' &&
    message.request !== null &&
    'id' in message.request &&
    typeof message.request.id === 'string' &&
    'method' in message.request &&
    message.request.method === 'setup.install' &&
    'params' in message.request &&
    typeof message.request.params === 'object' &&
    message.request.params !== null
  );
}

/**
 * @param {string} id
 * @param {number | null} tabId
 * @param {string} summary
 * @param {string} url
 * @returns {any}
 */
function createActionLogEntry(id, tabId, summary, url) {
  return {
    id,
    at: 1,
    method: 'navigation.navigate',
    source: 'cli',
    tabId,
    url,
    ok: true,
    summary,
    responseBytes: 0,
    approxTokens: 0,
    imageApproxTokens: 0,
    costClass: 'cheap',
    imageBytes: 0,
    summaryBytes: 0,
    summaryTokens: 0,
    summaryCostClass: 'cheap',
    debuggerBacked: false,
    overBudget: false,
    hasScreenshot: false,
    nodeCount: null,
    continuationHint: null,
  };
}

test('background UI port syncs current state and updates scoped tab state on request', async () => {
  /** @type {unknown[]} */
  const nativeMessages = [];
  const nativePort = createNativePort(nativeMessages);
  const portPair = createMessagePortPair({ leftName: 'ui-popup', rightName: 'agent' });
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
              title: 'Focused tab',
              url: 'https://example.com/current',
              status: 'complete',
            },
          ];
        }
        return [];
      },
      /** @param {number} tabId */
      async get(tabId) {
        if (tabId === 31) {
          return {
            id: 31,
            windowId: 8,
            title: 'Focused tab',
            url: 'https://example.com/current',
            status: 'complete',
          };
        }
        assert.equal(tabId, 41);
        return {
          id: 41,
          windowId: 8,
          title: 'Scoped tab',
          url: 'https://example.com/scoped',
          status: 'complete',
        };
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-ui-port-state-${Date.now()}-${Math.random()}`,
  });

  const state = loaded.module.getStateForTest();
  state.actionLog.push(
    /** @type {any} */ (
      createActionLogEntry('entry-31', 31, 'Current tab action', 'https://example.com/current')
    ),
    /** @type {any} */ (
      createActionLogEntry('entry-41', 41, 'Scoped tab action', 'https://example.com/scoped')
    )
  );

  loaded.chrome.runtime.onConnect.dispatch(portPair.left.port);
  await flushAsyncWork();

  const initialSync = getStateSyncMessages(portPair.left.postedMessages).at(-1);
  assert.deepEqual(initialSync, {
    type: 'state.sync',
    state: {
      nativeConnected: true,
      currentTab: {
        tabId: 31,
        windowId: 8,
        title: 'Focused tab',
        url: 'https://example.com/current',
        enabled: false,
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
      actionLog: [state.actionLog[0]],
    },
  });

  portPair.left.dispatchMessage({ type: 'state.request', scopeTabId: 41 });
  await flushAsyncWork();

  const scopedSync = getStateSyncMessages(portPair.left.postedMessages).at(-1);
  assert.equal(state.uiPorts.get(portPair.left.port)?.scopeTabId, 41);
  assert.deepEqual(scopedSync, {
    type: 'state.sync',
    state: {
      nativeConnected: true,
      currentTab: {
        tabId: 41,
        windowId: 8,
        title: 'Scoped tab',
        url: 'https://example.com/scoped',
        enabled: false,
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
      actionLog: [state.actionLog[1]],
    },
  });
});

test('background UI port prunes disconnected UI ports when sync posting throws', async () => {
  const loaded = await loadBackground({
    query: `test-background-ui-port-prune-${Date.now()}-${Math.random()}`,
  });
  const failingPort = {
    name: 'ui-sidepanel',
    onMessage: createChromeEvent(),
    onDisconnect: createChromeEvent(),
    postMessage() {
      throw new Error('Port is closed');
    },
    disconnect() {},
  };

  loaded.chrome.runtime.onConnect.dispatch(/** @type {any} */ (failingPort));
  await flushAsyncWork();

  assert.equal(loaded.module.getStateForTest().uiPorts.size, 0);
});

test('background UI port refresh clears setup status when the native host is unavailable', async () => {
  /** @type {unknown[]} */
  const nativeMessages = [];
  const nativePort = createNativePort(nativeMessages);
  const portPair = createMessagePortPair({ leftName: 'ui-sidepanel', rightName: 'agent' });
  const loaded = await loadBackground({
    chrome: createChromeFake({
      runtime: {
        connectNative() {
          return nativePort;
        },
      },
    }),
    query: `test-background-ui-port-refresh-${Date.now()}-${Math.random()}`,
  });

  loaded.chrome.runtime.onConnect.dispatch(portPair.left.port);
  await flushAsyncWork();

  const state = loaded.module.getStateForTest();
  state.nativePort = null;
  state.setupStatus = {
    mcpClients: [{ configured: true }],
    skillTargets: [],
  };
  state.setupStatusPending = true;
  state.setupStatusPendingRequestId = 'status-request';
  state.setupStatusUpdatedAt = 123;
  state.setupStatusError = 'stale';
  state.setupInstallPendingRequestId = 'install-request';
  state.setupInstallPendingAction = {
    action: 'install',
    kind: 'skill',
    target: 'cursor',
  };
  state.setupInstallPendingKey = 'skill:cursor';
  state.setupInstallError = 'bad state';
  portPair.left.postedMessages.length = 0;

  portPair.left.dispatchMessage({ type: 'setup.status.refresh' });
  await flushAsyncWork();

  assert.equal(state.setupStatus, null);
  assert.equal(state.setupStatusPending, false);
  assert.equal(state.setupStatusPendingRequestId, null);
  assert.equal(state.setupStatusUpdatedAt, 0);
  assert.equal(state.setupStatusError, null);
  assert.equal(state.setupInstallPendingRequestId, null);
  assert.equal(state.setupInstallPendingAction, null);
  assert.equal(state.setupInstallPendingKey, null);
  assert.equal(state.setupInstallError, null);
  assert.deepEqual(getStateSyncMessages(portPair.left.postedMessages).at(-1), {
    type: 'state.sync',
    state: {
      nativeConnected: false,
      currentTab: null,
      setupStatus: null,
      setupStatusPending: false,
      setupStatusError: null,
      setupInstallPendingKey: null,
      setupInstallError: null,
      actionLog: [],
    },
  });
});

test('background UI port broadcasts setup install start and success state', async () => {
  /** @type {unknown[]} */
  const nativeMessages = [];
  const nativePort = createNativePort(nativeMessages);
  const portPair = createMessagePortPair({ leftName: 'ui-popup', rightName: 'agent' });
  const loaded = await loadBackground({
    chrome: createChromeFake({
      runtime: {
        connectNative() {
          return nativePort;
        },
      },
    }),
    query: `test-background-ui-port-setup-success-${Date.now()}-${Math.random()}`,
  });

  loaded.chrome.runtime.onConnect.dispatch(portPair.left.port);
  await flushAsyncWork();
  nativeMessages.length = 0;
  portPair.left.postedMessages.length = 0;

  portPair.left.dispatchMessage({
    type: 'setup.install',
    action: 'install',
    kind: 'skill',
    target: 'cursor',
  });
  await flushAsyncWork();

  const installRequestMessage = nativeMessages.find(isSetupInstallRequestMessage);
  if (!installRequestMessage) {
    assert.fail('Expected setup.install request to be posted to the native host.');
  }
  assert.deepEqual(installRequestMessage.request.params, {
    action: 'install',
    kind: 'skill',
    target: 'cursor',
  });

  const pendingSync = getStateSyncMessages(portPair.left.postedMessages).at(-1);
  assert.equal(pendingSync?.state.setupInstallPendingKey, 'skill:cursor');
  assert.equal(pendingSync?.state.setupInstallError, null);
  assert.equal(pendingSync?.state.actionLog.length, 1);
  assert.equal(pendingSync?.state.actionLog[0].summary, 'Installing SKILL for cursor…');

  nativePort.onMessage.dispatch({
    type: 'host.bridge_response',
    response: createSuccess(installRequestMessage.request.id, { installed: true }),
  });
  await flushAsyncWork();

  const state = loaded.module.getStateForTest();
  assert.equal(state.setupInstallPendingRequestId, null);
  assert.equal(state.setupInstallPendingAction, null);
  assert.equal(state.setupInstallPendingKey, null);
  assert.equal(state.setupInstallError, null);
  const successSync = getStateSyncMessages(portPair.left.postedMessages).at(-1);
  assert.equal(successSync?.state.actionLog.length, 2);
  assert.equal(successSync?.state.actionLog[0].summary, 'Installed SKILL for cursor.');
  assert.equal(successSync?.state.actionLog[1].summary, 'Installing SKILL for cursor…');
});

test('background UI port broadcasts setup install transport errors', async () => {
  /** @type {unknown[]} */
  const nativeMessages = [];
  const nativePort = createNativePort(nativeMessages);
  const portPair = createMessagePortPair({ leftName: 'ui-popup', rightName: 'agent' });
  const loaded = await loadBackground({
    chrome: createChromeFake({
      runtime: {
        connectNative() {
          return nativePort;
        },
      },
    }),
    query: `test-background-ui-port-setup-error-${Date.now()}-${Math.random()}`,
  });

  loaded.chrome.runtime.onConnect.dispatch(portPair.left.port);
  await flushAsyncWork();
  nativeMessages.length = 0;
  portPair.left.postedMessages.length = 0;

  portPair.left.dispatchMessage({
    type: 'setup.install',
    action: 'uninstall',
    kind: 'mcp',
    target: 'cursor',
  });
  await flushAsyncWork();

  const installRequestMessage = nativeMessages.find(isSetupInstallRequestMessage);
  if (!installRequestMessage) {
    assert.fail('Expected setup.install request to be posted to the native host.');
  }

  nativePort.onMessage.dispatch({
    type: 'host.bridge_error',
    requestId: installRequestMessage.request.id,
    error: { message: 'No daemon' },
  });
  await flushAsyncWork();

  const state = loaded.module.getStateForTest();
  assert.equal(state.setupInstallPendingRequestId, null);
  assert.equal(state.setupInstallPendingAction, null);
  assert.equal(state.setupInstallPendingKey, null);
  assert.equal(state.setupInstallError, 'No daemon');
  const errorSync = getStateSyncMessages(portPair.left.postedMessages).at(-1);
  assert.equal(errorSync?.state.setupInstallError, 'No daemon');
  assert.equal(errorSync?.state.actionLog.length, 2);
  assert.equal(
    errorSync?.state.actionLog[0].summary,
    'Removal failed for MCP on cursor: No daemon'
  );
  assert.equal(errorSync?.state.actionLog[1].summary, 'Removing MCP for cursor…');
});

test('background UI port broadcasts logged bridge actions to connected surfaces', async () => {
  /** @type {unknown[]} */
  const nativeMessages = [];
  const nativePort = createNativePort(nativeMessages);
  const portPair = createMessagePortPair({ leftName: 'ui-popup', rightName: 'agent' });
  /** @type {Array<{ tabId: number, properties: { url: string } }>} */
  const updateCalls = [];
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
              windowId: 7,
              title: 'Current page',
              url: 'https://example.com/current',
              active: true,
              status: 'complete',
            },
          ];
        }
        if (queryInfo.active && queryInfo.windowId === 7) {
          return [
            {
              id: 31,
              windowId: 7,
              title: 'Current page',
              url: 'https://example.com/current',
              active: true,
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
          windowId: 7,
          title: 'Current page',
          url: 'https://example.com/current',
          active: true,
          status: 'complete',
        };
      },
      /** @param {number} tabId @param {{ url: string }} properties */
      async update(tabId, properties) {
        updateCalls.push({ tabId, properties });
        return {
          id: tabId,
          windowId: 7,
          title: 'Current page',
          url: properties.url,
          active: true,
          status: 'complete',
        };
      },
      async reload() {},
      async goBack() {},
      async goForward() {},
    },
    windows: {
      /** @param {number} windowId */
      async get(windowId) {
        return { id: windowId };
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-ui-port-action-log-${Date.now()}-${Math.random()}`,
  });

  loaded.module.getStateForTest().enabledWindow = {
    windowId: 7,
    title: 'Enabled Window',
    enabledAt: Date.now(),
  };

  loaded.chrome.runtime.onConnect.dispatch(portPair.left.port);
  await flushAsyncWork();
  portPair.left.postedMessages.length = 0;

  const response = await loaded.dispatch(
    createRequest({
      id: 'ui-port-navigation-log',
      method: 'navigation.navigate',
      params: {
        url: 'https://example.com/next',
        waitForLoad: false,
      },
      meta: {
        source: 'cli',
      },
    })
  );
  await flushAsyncWork();

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.deepEqual(updateCalls, [{ tabId: 31, properties: { url: 'https://example.com/next' } }]);
  const actionLogEntry = loaded.module.getStateForTest().actionLog.at(-1);
  assert.equal(actionLogEntry?.method, 'navigation.navigate');
  assert.equal(actionLogEntry?.source, 'cli');
  assert.equal(actionLogEntry?.tabId, 31);
  assert.equal(actionLogEntry?.url, 'https://example.com/current');

  const broadcastSync = getStateSyncMessages(portPair.left.postedMessages).find(
    (message) => message.state.actionLog[0]?.method === 'navigation.navigate'
  );
  if (!broadcastSync) {
    assert.fail('Expected a state.sync broadcast with the logged navigation action.');
  }
  assert.equal(broadcastSync.state.actionLog[0].source, 'cli');
  assert.equal(broadcastSync.state.actionLog[0].tabId, 31);
});
