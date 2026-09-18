import test from 'node:test';
import assert from 'node:assert/strict';

import { createExtensionState } from '../src/background-state.js';
import { createWindowSessionController } from '../src/background-window-session.js';
import { createChromeFake } from '../../../tests/_helpers/chromeFake.ts';
import {
  broadcastUi,
  emitUiStateForPort,
  getRequestedAccessPopupPlacement,
  getUiSurfaceFromPortName,
  handleUiMessage,
  openRequestedAccessUi,
} from '../src/background-ui.js';

type PostedMessage = Record<string, unknown>;

function createPort(messages: PostedMessage[] = []): chrome.runtime.Port {
  return {
    name: 'ui-popup',
    postMessage(message: PostedMessage) {
      messages.push(message);
    },
    disconnect() {},
    onMessage: {
      addListener() {},
      removeListener() {},
      hasListener() {
        return false;
      },
    },
    onDisconnect: {
      addListener() {},
      removeListener() {},
      hasListener() {
        return false;
      },
    },
  } as unknown as chrome.runtime.Port;
}

test('background UI helpers classify surfaces and prune disconnected ports', () => {
  assert.equal(getUiSurfaceFromPortName('ui-popup'), 'popup');
  assert.equal(getUiSurfaceFromPortName('ui-sidepanel'), 'sidepanel');
  assert.equal(getUiSurfaceFromPortName('ui'), 'popup');
  assert.equal(getUiSurfaceFromPortName('other'), null);

  const state = createExtensionState();
  const goodMessages: PostedMessage[] = [];
  const goodPort = createPort(goodMessages);
  const badPort = {
    ...createPort(),
    postMessage() {
      throw new Error('disconnected');
    },
  } as unknown as chrome.runtime.Port;
  state.uiPorts.set(goodPort, { surface: 'popup', scopeTabId: null });
  state.uiPorts.set(badPort, { surface: 'popup', scopeTabId: null });

  broadcastUi(state, { type: 'hello' });

  assert.deepEqual(goodMessages, [{ type: 'hello' }]);
  assert.equal(state.uiPorts.has(badPort), false);
});

test('background UI state emission handles missing and scoped ports', async () => {
  const state = createExtensionState();
  const messages: PostedMessage[] = [];
  const port = createPort(messages);
  let refreshCount = 0;

  await emitUiStateForPort(state, port, {
    refreshSetupStatus() {
      refreshCount += 1;
    },
    async getTabState() {
      return null;
    },
    async getCurrentTabState() {
      return null;
    },
    async setWindowEnabled() {},
    async setCurrentWindowEnabled() {},
    async handleSetupInstallAction() {},
  });

  state.actionLog.push({
    id: 'visible',
    at: 1,
    method: 'dom.query',
    source: 'mcp',
    tabId: 7,
    url: 'https://example.com',
    ok: true,
    summary: 'visible',
    responseBytes: 1,
    approxTokens: 1,
    imageApproxTokens: 0,
    costClass: 'cheap',
    imageBytes: 0,
    summaryBytes: 1,
    summaryTokens: 1,
    summaryCostClass: 'cheap',
    debuggerBacked: false,
    overBudget: false,
    hasScreenshot: false,
    nodeCount: null,
    continuationHint: null,
  });
  state.actionLog.push({ ...state.actionLog[0], id: 'hidden', tabId: 8 });
  state.uiPorts.set(port, { surface: 'sidepanel', scopeTabId: 7 });

  await emitUiStateForPort(state, port, {
    refreshSetupStatus() {
      refreshCount += 1;
    },
    async getTabState(tabId: number) {
      return {
        tabId,
        windowId: 3,
        title: 'Scoped tab',
        url: 'https://example.com',
        enabled: true,
        accessRequested: false,
        restricted: false,
      };
    },
    async getCurrentTabState() {
      throw new Error('should use scoped tab');
    },
    async setWindowEnabled() {},
    async setCurrentWindowEnabled() {},
    async handleSetupInstallAction() {},
  });

  assert.equal(refreshCount, 1);
  assert.equal(messages.length, 1);
  const sync = messages[0] as { state: { actionLog: Array<{ id: string }> } };
  assert.deepEqual(
    sync.state.actionLog.map((entry) => entry.id),
    ['visible']
  );
});

test('window-scoped panel follows a second tab despite another window having focus', async () => {
  const state = createExtensionState();
  state.enabledWindow = { windowId: 3, title: 'Enabled window', enabledAt: 1 };
  let activeTabId = 7;
  const chromeObj = createChromeFake({
    tabs: {
      async query(query: chrome.tabs.QueryInfo) {
        return [
          {
            id: query.windowId === 3 ? activeTabId : 99,
            windowId: query.windowId ?? 9,
            url: 'https://example.com/',
          },
        ];
      },
    },
  }) as unknown as typeof chrome;
  const controller = createWindowSessionController(state, chromeObj, {
    sendAccessUpdate() {},
    async injectContentScriptsForWindow() {},
    async primeWindowConsoleCapture() {},
    async primeTabConsoleCapture() {},
    async clearWindowBridgeState() {},
    cancelNavigationWaitsForWindow() {},
    async appendActionLogEntry() {},
    async refreshActionIndicators() {},
    async updateActionIndicatorForTab() {},
    async emitUiState() {},
    isRestrictedAutomationUrl() {
      return false;
    },
  });
  const messages: PostedMessage[] = [];
  const port = createPort(messages);
  state.uiPorts.set(port, { surface: 'sidepanel', scopeTabId: null });
  const deps = {
    ...controller,
    refreshSetupStatus() {},
    async handleSetupInstallAction() {},
  };
  await handleUiMessage(state, port, { type: 'state.request', scopeWindowId: 3 }, deps);
  activeTabId = 8;
  state.actionLog.push({
    id: 'second-tab-action',
    at: 1,
    method: 'dom.query',
    source: 'cli',
    tabId: 8,
    url: 'https://example.com/',
    ok: true,
    summary: 'Queried second tab',
    responseBytes: 4,
    approxTokens: 1,
    imageApproxTokens: 0,
    costClass: 'cheap',
    imageBytes: 0,
    summaryBytes: 4,
    summaryTokens: 1,
    summaryCostClass: 'cheap',
    debuggerBacked: false,
    overBudget: false,
    hasScreenshot: false,
    nodeCount: null,
    continuationHint: null,
  });
  state.actionLog.push({ ...state.actionLog[0], id: 'other-tab-action', tabId: 99 });
  await emitUiStateForPort(state, port, deps);
  const snapshots = messages as Array<{
    state: {
      currentTab: { tabId: number; enabled: boolean };
      actionLog: Array<{ id: string }>;
    };
  }>;
  assert.equal(snapshots[0].state.currentTab.tabId, 7);
  assert.equal(snapshots[1].state.currentTab.tabId, 8);
  assert.equal(snapshots[1].state.currentTab.enabled, true);
  assert.deepEqual(
    snapshots[1].state.actionLog.map((entry) => entry.id),
    ['second-tab-action']
  );
});

test('a pending unscoped snapshot cannot overwrite a newly scoped panel', async () => {
  const state = createExtensionState();
  const messages: PostedMessage[] = [];
  const port = createPort(messages);
  state.uiPorts.set(port, { surface: 'sidepanel', scopeTabId: null });
  let finishLookup: () => void = () => {};
  const pendingLookup = new Promise<void>((resolve) => {
    finishLookup = resolve;
  });
  const deps = {
    refreshSetupStatus() {},
    async getTabState() {
      return null;
    },
    async getCurrentTabState(windowId?: number | null) {
      if (windowId == null) await pendingLookup;
      return null;
    },
    async setWindowEnabled() {},
    async setCurrentWindowEnabled() {},
    async handleSetupInstallAction() {},
  };
  const initialEmission = emitUiStateForPort(state, port, deps);
  await handleUiMessage(state, port, { type: 'state.request', scopeWindowId: 3 }, deps);
  assert.equal(messages.length, 1);
  finishLookup();
  await initialEmission;
  assert.equal(messages.length, 1);
});

test('background UI message handling covers missing ports, refresh, install, and toggle errors', async () => {
  const state = createExtensionState();
  const messages: PostedMessage[] = [];
  const port = createPort(messages);
  const calls: string[] = [];
  const deps = {
    refreshSetupStatus(force?: boolean) {
      calls.push(force ? 'refresh-force' : 'refresh');
    },
    async getTabState() {
      return null;
    },
    async getCurrentTabState() {
      return null;
    },
    async setWindowEnabled() {
      calls.push('set-window');
    },
    async setCurrentWindowEnabled() {
      calls.push('set-current');
    },
    async handleSetupInstallAction() {
      calls.push('install');
    },
  };

  await handleUiMessage(state, port, { type: 'state.request', scopeTabId: 9 }, deps);
  state.uiPorts.set(port, { surface: 'popup', scopeTabId: null });
  await handleUiMessage(state, port, { type: 'setup.status.refresh' }, deps);
  await handleUiMessage(state, port, { type: 'setup.install' }, deps);
  await assert.rejects(
    handleUiMessage(state, port, { type: 'scope.set_enabled', tabId: 9, enabled: true }, deps),
    /Requested tab state not found/
  );

  assert.deepEqual(calls, ['refresh-force', 'refresh', 'install']);
  assert.equal(
    messages.some((message) => message.type === 'toggle.error'),
    true
  );
});

test('background UI access prompt falls back when placement or popup open fails', async () => {
  const state = createExtensionState();
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    const placement = await getRequestedAccessPopupPlacement(1, 420, {
      windows: {
        async get() {
          throw new Error('window gone');
        },
      },
    } as unknown as typeof chrome);
    assert.equal(placement, null);

    await openRequestedAccessUi(
      { tabId: 5, windowId: 2, title: 'Target', url: 'https://example.com' },
      state,
      {
        runtime: {
          getURL(path: string) {
            return `chrome-extension://test/${path}`;
          },
        },
        windows: {
          async get() {
            return { id: 2 };
          },
          async create() {
            throw new Error('popup blocked');
          },
        },
      } as unknown as typeof chrome,
      {
        async getTabState() {
          return null;
        },
        async getCurrentTabState() {
          return null;
        },
      }
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
});
