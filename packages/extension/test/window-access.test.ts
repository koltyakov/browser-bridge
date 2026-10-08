import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionState } from '../src/background-state.js';
import {
  clearSetupStatus,
  handleHostStatusMessage,
  sendAccessUpdate,
} from '../src/background-native.js';
import { emitUiStateForPort, handleUiMessage } from '../src/background-ui.js';
import { createWindowActionsController } from '../src/background-window-actions.js';
import { createChromeFake } from '../../../tests/_helpers/chromeFake.ts';
import { clockController } from '../../../tests/_helpers/faultInjection.ts';
import type { BrowserWindowAccess } from '../../protocol/src/window-access.js';

const remote: BrowserWindowAccess = {
  extensionId: 'edge-work',
  browserName: 'Edge',
  profileLabel: 'Work',
  window: { windowId: 7, title: 'Work page', enabledAt: 123 },
};

test('host window access snapshots validate metadata, replace stale entries, and clear on disconnect', async () => {
  const state = createExtensionState();
  let emissions = 0;
  const deps = {
    async appendActionLogEntry() {},
    async emitUiState() {
      emissions += 1;
    },
    getSetupActionMethodLabel: () => '',
    getSetupActionSuccessSummary: () => '',
    getSetupActionErrorSummary: () => '',
    refreshSetupStatus() {},
  };
  assert.equal(
    handleHostStatusMessage(
      {
        type: 'host.window_access',
        otherEnabledWindows: [
          remote,
          { ...remote, window: null },
          null,
          {},
          { ...remote, window: { windowId: -1 } },
          { ...remote, browserName: 42 },
          { ...remote, window: 'invalid' },
        ],
      },
      state,
      deps
    ),
    true
  );
  assert.deepEqual(state.otherEnabledWindows, [remote, { ...remote, window: null }]);
  assert.equal(emissions, 1);
  handleHostStatusMessage({ type: 'host.window_access' }, state, deps);
  assert.deepEqual(state.otherEnabledWindows, []);
  state.otherEnabledWindows = [remote];
  clearSetupStatus(state);
  assert.deepEqual(state.otherEnabledWindows, []);
});

test('UI includes the local enabled window only when it belongs to a different window', async () => {
  const state = createExtensionState();
  state.enabledWindow = { windowId: 7, title: 'Local page', enabledAt: 1 };
  state.otherEnabledWindows = [remote];
  const messages: Array<{ state: { otherEnabledWindows: BrowserWindowAccess[] } }> = [];
  const port = {
    postMessage(message: (typeof messages)[number]) {
      messages.push(message);
    },
  } as unknown as chrome.runtime.Port;
  state.uiPorts.set(port, { surface: 'sidepanel', scopeTabId: null, scopeWindowId: 8 });
  let windowId = 8;
  const deps = {
    refreshSetupStatus() {},
    async getTabState() {
      return null;
    },
    async getCurrentTabState() {
      return {
        tabId: 1,
        windowId,
        title: '',
        url: '',
        enabled: windowId === 7,
        accessRequested: false,
        restricted: false,
      };
    },
    async setWindowEnabled() {},
    async setCurrentWindowEnabled() {},
    async handleSetupInstallAction() {},
  };
  await emitUiStateForPort(state, port, deps);
  assert.deepEqual(messages[0].state.otherEnabledWindows, [
    { extensionId: 'local', browserName: null, profileLabel: null, window: state.enabledWindow },
    remote,
  ]);
  windowId = 7;
  await emitUiStateForPort(state, port, deps);
  assert.deepEqual(
    messages[1].state.otherEnabledWindows,
    [remote],
    'same window IDs in other browsers must not be filtered out'
  );
});

test('access updates send metadata on enable and remove it on disable', () => {
  const messages: unknown[] = [];
  const port = {
    postMessage(message: unknown) {
      messages.push(message);
    },
  } as chrome.runtime.Port;
  sendAccessUpdate(true, port, remote.window);
  sendAccessUpdate(false, port, remote.window);
  assert.deepEqual(messages, [
    { type: 'host.access_update', accessEnabled: true, enabledWindow: remote.window },
    { type: 'host.access_update', accessEnabled: false, enabledWindow: null },
  ]);
});

test('window controls focus and restore the exact local grant without switching tabs', async () => {
  const state = createExtensionState();
  state.enabledWindow = remote.window;
  const updates: Array<{ id: number; properties: chrome.windows.UpdateInfo }> = [];
  const disabled: number[] = [];
  let minimized = true;
  let changeGrant = false;
  const chromeObj = createChromeFake({
    windows: {
      async get() {
        if (changeGrant) state.enabledWindow = { ...remote.window!, enabledAt: 124 };
        return { state: minimized ? 'minimized' : 'maximized' };
      },
      async update(id: number, properties: chrome.windows.UpdateInfo) {
        updates.push({ id, properties });
      },
    },
  }) as unknown as typeof chrome;
  const controls = createWindowActionsController(state, chromeObj, {
    async disableWindowAccess(id) {
      disabled.push(id);
      state.enabledWindow = null;
    },
  });
  const local = { ...remote, extensionId: 'local' };
  await controls.request('focus', local);
  minimized = false;
  await controls.request('focus', local);
  assert.deepEqual(updates, [
    { id: 7, properties: { focused: true, state: 'normal' } },
    { id: 7, properties: { focused: true } },
  ]);
  assert.equal(state.enabledWindow, remote.window, 'focusing does not change access');
  changeGrant = true;
  await assert.rejects(controls.request('focus', local), /access changed/);
  assert.equal(updates.length, 2);
  await assert.rejects(controls.request('disable', local), /access changed/);
  state.enabledWindow = remote.window;
  await controls.request('disable', local);
  assert.deepEqual(disabled, [7]);
  assert.equal(state.enabledWindow, null);
});

test('window action commands acknowledge success and failures through the native port', async () => {
  const state = createExtensionState();
  state.enabledWindow = remote.window;
  const messages: Array<Record<string, unknown>> = [];
  state.pendingNativePort = {
    postMessage(message: Record<string, unknown>) {
      messages.push(message);
    },
  } as chrome.runtime.Port;
  const controls = createWindowActionsController(
    state,
    createChromeFake() as unknown as typeof chrome,
    {
      async disableWindowAccess() {
        state.enabledWindow = null;
      },
    }
  );
  const command = {
    type: 'host.window_action.command',
    requestId: 'daemon-request',
    action: 'disable',
    windowId: 7,
    enabledAt: 123,
  };
  assert.equal(controls.handleMessage(null), false);
  assert.equal(controls.handleMessage({ type: 'unrelated' }), false);
  assert.equal(controls.handleMessage({ type: command.type }), true);
  assert.equal(controls.handleMessage(command), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages[0], {
    type: 'host.window_action.result',
    requestId: 'daemon-request',
    ok: true,
  });
  controls.handleMessage(command);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages[1].ok, false);
  assert.match(String(messages[1].error), /access changed/);
});

test('remote window actions await actual results and expire or reject on disconnect', async (t) => {
  const clock = clockController();
  t.mock.method(globalThis, 'setTimeout', clock.setTimeout);
  t.mock.method(globalThis, 'clearTimeout', clock.clearTimeout);
  const state = createExtensionState();
  const messages: Array<Record<string, unknown>> = [];
  state.nativePort = {
    postMessage(message: Record<string, unknown>) {
      messages.push(message);
    },
  } as chrome.runtime.Port;
  const controls = createWindowActionsController(
    state,
    createChromeFake() as unknown as typeof chrome,
    { async disableWindowAccess() {} }
  );
  const entry = { ...remote, canControl: true };
  const focused = controls.request('focus', entry);
  assert.equal(messages[0].type, 'host.window_action.request');
  assert.equal(messages[0].extensionId, 'edge-work');
  assert.equal(messages[0].windowId, 7);
  controls.handleMessage({ type: 'host.window_action.response', requestId: 'forged', ok: true });
  controls.handleMessage({
    type: 'host.window_action.response',
    requestId: messages[0].requestId,
    ok: true,
  });
  await focused;
  const failed = controls.request('disable', entry);
  const failedAssertion = assert.rejects(failed, /Window closed/);
  controls.handleMessage({
    type: 'host.window_action.response',
    requestId: messages[1].requestId,
    ok: false,
    error: 'Window closed',
  });
  await failedAssertion;
  const timedOut = controls.request('focus', entry);
  const timeoutAssertion = assert.rejects(timedOut, /timed out/);
  await clock.runNext();
  await timeoutAssertion;
  const disconnected = controls.request('disable', entry);
  const disconnectAssertion = assert.rejects(disconnected, /disconnected/);
  controls.disconnect();
  await disconnectAssertion;
  await assert.rejects(controls.request('focus', remote), /Update/);
  await assert.rejects(controls.request('disable', { ...entry, window: null }), /Update/);
  state.nativePort = null;
  await assert.rejects(controls.request('focus', entry), /disconnected/);
  assert.equal(await clock.runNext(), false);
});

test('Disable all uses panel scope, never the focused browser window, and reports partial failure', async () => {
  const state = createExtensionState();
  state.enabledWindow = { windowId: 7, title: 'Current', enabledAt: 1 };
  const legacy = { ...remote, extensionId: 'legacy', window: null };
  state.otherEnabledWindows = [{ ...remote, canControl: true }, legacy];
  const messages: Array<Record<string, unknown>> = [];
  const port = {
    postMessage(message: Record<string, unknown>) {
      messages.push(message);
    },
  } as chrome.runtime.Port;
  state.uiPorts.set(port, { surface: 'sidepanel', scopeTabId: null, scopeWindowId: 7 });
  const calls: Array<{ action: string; entry: BrowserWindowAccess }> = [];
  let scopeWindowId: number | null = 7;
  const deps = {
    refreshSetupStatus() {},
    async getTabState() {
      return null;
    },
    async getCurrentTabState(windowId?: number | null) {
      scopeWindowId = windowId ?? null;
      return null;
    },
    async setWindowEnabled() {},
    async setCurrentWindowEnabled() {},
    async handleSetupInstallAction() {},
    async requestWindowAction(action: 'focus' | 'disable', entry: BrowserWindowAccess) {
      calls.push({ action, entry });
      if (entry.extensionId === 'legacy') throw new Error('Update the other extension.');
    },
  };
  await handleUiMessage(state, port, { type: 'windows.disable_others' }, deps);
  assert.equal(scopeWindowId, 7);
  assert.deepEqual(
    calls.map((call) => call.entry.extensionId),
    ['edge-work', 'legacy']
  );
  assert.equal(state.enabledWindow.windowId, 7, 'the current grant is not revoked');
  assert.equal(messages[0].ok, false);
  assert.match(String(messages[0].error), /1 window could not be disabled/);
  calls.length = 0;
  state.otherEnabledWindows = [remote];
  state.uiPorts.set(port, { surface: 'sidepanel', scopeTabId: null, scopeWindowId: 8 });
  await handleUiMessage(state, port, { type: 'windows.disable_others' }, deps);
  assert.deepEqual(
    calls.map((call) => call.entry.extensionId),
    ['local', 'edge-work']
  );
  assert.equal(messages[1].ok, true);
  await handleUiMessage(
    state,
    port,
    { type: 'windows.focus', extensionId: 'edge-work', windowId: 7, enabledAt: 123 },
    deps
  );
  assert.equal(calls.at(-1)?.action, 'focus');
  const callCount = calls.length;
  await handleUiMessage(
    state,
    port,
    { type: 'windows.focus', extensionId: 'local', windowId: 7, enabledAt: 99 },
    deps
  );
  assert.equal(messages.at(-1)?.ok, false);
  assert.equal(calls.length, callCount, 'stale focus clicks are rejected');
  state.uiPorts.set(port, { surface: 'sidepanel', scopeTabId: null });
  await handleUiMessage(state, port, { type: 'windows.disable_others' }, deps);
  assert.equal(calls.length, callCount, 'unresolved current windows cannot disable access');
});
