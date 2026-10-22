import test from 'node:test';
import assert from 'node:assert/strict';

import { createChromeFake } from '../../../tests/_helpers/chromeFake.ts';
import { createExtensionState, setExtensionState } from '../src/background-state.js';
import {
  createWindowSessionController,
  type WindowSessionControllerDeps,
} from '../src/background-window-session.js';

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function createDeferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(predicate(), true);
}

function createUpdateHarness() {
  const windows = new Set([7, 8]);
  const chromeObj = createChromeFake({
    windows: {
      async get(windowId: number) {
        if (!windows.has(windowId)) throw new Error('No window');
        return { id: windowId };
      },
    },
  }) as unknown as typeof chrome;
  const updates: boolean[] = [];
  const injected: number[] = [];
  const deps: WindowSessionControllerDeps = {
    sendAccessUpdate(enabled) {
      updates.push(enabled);
    },
    async injectContentScriptsForWindow(windowId) {
      injected.push(windowId);
    },
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
  };
  function startWorker() {
    const state = createExtensionState();
    setExtensionState(state);
    return { state, controller: createWindowSessionController(state, chromeObj, deps) };
  }
  return { chromeObj, windows, updates, injected, startWorker, ...startWorker() };
}

test('extension updates restore only the previously enabled window and preserve its grant', async () => {
  const { chromeObj, controller, state, startWorker, injected } = createUpdateHarness();
  await controller.setWindowEnabled(7, 'Workspace', true);
  const grant = state.enabledWindow;
  await chromeObj.storage.session.clear();
  const updated = startWorker();
  await updated.controller.restoreEnabledWindow();
  assert.equal(
    updated.state.enabledWindow,
    null,
    'ordinary worker startup cannot read local grants'
  );
  await updated.controller.restoreEnabledWindowAfterUpdate();
  assert.deepEqual(updated.state.enabledWindow, grant);
  assert.deepEqual((await chromeObj.storage.session.get('enabledWindow')).enabledWindow, grant);
  assert.deepEqual(injected, [7, 7]);
  await updated.controller.setWindowEnabled(7, 'Workspace', false);
  await chromeObj.storage.session.clear();
  const disabled = startWorker();
  await disabled.controller.restoreEnabledWindowAfterUpdate();
  assert.equal(disabled.state.enabledWindow, null, 'disable removes the update backup');
});

test('updates do not restore a closed window and browser startup clears the local grant', async () => {
  const { chromeObj, controller, startWorker, windows } = createUpdateHarness();
  await controller.setWindowEnabled(7, 'Workspace', true);
  await chromeObj.storage.session.clear();
  windows.delete(7);
  const updated = startWorker();
  await updated.controller.restoreEnabledWindowAfterUpdate();
  assert.equal(updated.state.enabledWindow, null);
  assert.equal((await chromeObj.storage.local.get('enabledWindow')).enabledWindow, undefined);
  await updated.controller.setWindowEnabled(8, 'Other', true);
  await chromeObj.storage.session.clear();
  const restarted = startWorker();
  await restarted.controller.restoreEnabledWindow();
  assert.equal(restarted.state.enabledWindow, null);
  await restarted.controller.clearEnabledWindowOnBrowserStartup();
  await restarted.controller.restoreEnabledWindowAfterUpdate();
  assert.equal(restarted.state.enabledWindow, null);
  assert.equal((await chromeObj.storage.local.get('enabledWindow')).enabledWindow, undefined);
  assert.equal((await chromeObj.storage.session.get('enabledWindow')).enabledWindow, undefined);
});

test('browser startup cancels an in-flight update restore before access is advertised', async () => {
  const { chromeObj, controller, startWorker, updates } = createUpdateHarness();
  await controller.setWindowEnabled(7, 'Workspace', true);
  await chromeObj.storage.session.clear();
  updates.length = 0;
  const gate = createDeferred();
  let readStarted = false;
  chromeObj.windows.get = (async () => {
    readStarted = true;
    await gate.promise;
    return { id: 7, focused: true, alwaysOnTop: false, incognito: false };
  }) as typeof chromeObj.windows.get;
  const updated = startWorker();
  const restore = updated.controller.restoreEnabledWindowAfterUpdate();
  await waitFor(() => readStarted);
  const startup = updated.controller.clearEnabledWindowOnBrowserStartup();
  gate.resolve();
  await Promise.all([restore, startup]);
  assert.equal(updated.state.enabledWindow, null);
  assert.equal(updates.includes(true), false);
  assert.equal((await chromeObj.storage.local.get('enabledWindow')).enabledWindow, undefined);
});

test('window closure removes both session and update access copies', async () => {
  const { chromeObj, controller, state } = createUpdateHarness();
  await controller.setWindowEnabled(7, 'Workspace', true);
  await controller.handleTabRemoved(31, { windowId: 7, isWindowClosing: true });
  assert.equal(state.enabledWindow, null);
  assert.equal((await chromeObj.storage.local.get('enabledWindow')).enabledWindow, undefined);
  assert.equal((await chromeObj.storage.session.get('enabledWindow')).enabledWindow, undefined);
});

test('enabled-window switches revoke access, tear down the prior window, and serialize', async () => {
  const state = createExtensionState();
  setExtensionState(state);
  state.enabledWindow = { windowId: 1, title: 'One', enabledAt: 1 };
  const firstClear = createDeferred();
  const secondClear = createDeferred();
  const clearedWindows: number[] = [];
  const injectedWindows: number[] = [];
  const accessUpdates: boolean[] = [];
  const cancelledWindows: number[] = [];
  const chromeObj = createChromeFake() as unknown as typeof globalThis.chrome;
  const controller = createWindowSessionController(state, chromeObj, {
    sendAccessUpdate(enabled) {
      accessUpdates.push(enabled);
    },
    async injectContentScriptsForWindow(windowId) {
      injectedWindows.push(windowId);
    },
    async primeWindowConsoleCapture() {},
    async primeTabConsoleCapture() {},
    async clearWindowBridgeState(windowId) {
      clearedWindows.push(windowId);
      if (windowId === 1) await firstClear.promise;
      if (windowId === 2) await secondClear.promise;
    },
    cancelNavigationWaitsForWindow(windowId) {
      cancelledWindows.push(windowId);
    },
    async appendActionLogEntry() {},
    async refreshActionIndicators() {},
    async updateActionIndicatorForTab() {},
    async emitUiState() {},
    isRestrictedAutomationUrl() {
      return false;
    },
  });

  const switchToTwo = controller.setWindowEnabled(2, 'Two', true);
  const switchToThree = controller.setWindowEnabled(3, 'Three', true);
  await waitFor(() => clearedWindows.length === 1);

  assert.equal(state.enabledWindow, null);
  assert.deepEqual(clearedWindows, [1]);
  assert.deepEqual(cancelledWindows, [1]);
  assert.deepEqual(injectedWindows, []);
  assert.deepEqual(accessUpdates, [false]);

  firstClear.resolve();
  await waitFor(() => clearedWindows.length === 2);
  assert.equal(state.enabledWindow, null);
  assert.deepEqual(clearedWindows, [1, 2]);
  assert.deepEqual(cancelledWindows, [1, 2]);
  assert.deepEqual(injectedWindows, [2]);

  secondClear.resolve();
  await Promise.all([switchToTwo, switchToThree]);
  const finalEnabledWindow = state.enabledWindow as { windowId: number } | null;
  assert.equal(finalEnabledWindow?.windowId, 3);
  assert.deepEqual(injectedWindows, [2, 3]);
  assert.deepEqual(accessUpdates, [false, true, false, true]);

  await controller.setWindowEnabled(3, 'Three', false);
  assert.equal(state.enabledWindow, null);
  assert.deepEqual(clearedWindows, [1, 2, 3]);
  assert.deepEqual(cancelledWindows, [1, 2, 3]);
  assert.deepEqual(accessUpdates, [false, true, false, true, false]);
});

test('enabling a requested window records a scoped access confirmation activity', async () => {
  const state = createExtensionState();
  setExtensionState(state);
  state.requestedAccessWindowId = 7;
  const activities: Array<{
    method: string;
    tabId?: number | null;
    url?: string;
    ok: boolean;
    summary: string;
  }> = [];
  const chromeObj = createChromeFake() as unknown as typeof globalThis.chrome;
  const controller = createWindowSessionController(state, chromeObj, {
    sendAccessUpdate() {},
    async injectContentScriptsForWindow() {},
    async primeWindowConsoleCapture() {},
    async primeTabConsoleCapture() {},
    async clearWindowBridgeState() {},
    cancelNavigationWaitsForWindow() {},
    async appendActionLogEntry(entry) {
      activities.push(entry);
    },
    async refreshActionIndicators() {},
    async updateActionIndicatorForTab() {},
    async emitUiState() {},
    isRestrictedAutomationUrl() {
      return false;
    },
  });

  await controller.setWindowEnabled(7, 'Requested window', true, {
    tabId: 31,
    url: 'https://example.com/requested',
  });

  assert.deepEqual(activities, [
    {
      method: 'access.confirmed',
      tabId: 31,
      url: 'https://example.com/requested',
      ok: true,
      summary: 'Window access request confirmed.',
    },
  ]);

  await controller.setWindowEnabled(7, 'Requested window', false);
  await controller.setWindowEnabled(7, 'Requested window', true, {
    tabId: 31,
    url: 'https://example.com/requested',
  });
  assert.equal(activities.length, 1);
});

test('UI revocation is serialized, rejects a newer grant, and preserves another window access prompt', async () => {
  const state = createExtensionState();
  setExtensionState(state);
  state.enabledWindow = { windowId: 7, title: 'Original', enabledAt: 123 };
  const chromeObj = createChromeFake() as unknown as typeof chrome;
  const cleared: number[] = [];
  const updates: boolean[] = [];
  const controller = createWindowSessionController(state, chromeObj, {
    sendAccessUpdate(enabled) {
      updates.push(enabled);
    },
    async injectContentScriptsForWindow() {},
    async primeWindowConsoleCapture() {},
    async primeTabConsoleCapture() {},
    async clearWindowBridgeState(windowId) {
      cleared.push(windowId);
    },
    cancelNavigationWaitsForWindow() {},
    async appendActionLogEntry() {},
    async refreshActionIndicators() {},
    async updateActionIndicatorForTab() {},
    async emitUiState() {},
    isRestrictedAutomationUrl() {
      return false;
    },
  });
  const reenabled = controller.setWindowEnabled(7, 'New grant', true);
  const staleDisable = controller.disableWindowAccess(7, 123);
  const staleAssertion = assert.rejects(staleDisable, /access changed/);
  await reenabled;
  await staleAssertion;
  assert.equal(state.enabledWindow?.windowId, 7);
  assert.equal(cleared.length, 0);
  state.requestedAccessWindowId = 8;
  const access = state.enabledWindow!;
  await controller.disableWindowAccess(access.windowId, access.enabledAt);
  assert.equal(state.enabledWindow, null);
  assert.equal(state.requestedAccessWindowId, 8, 'another panel access prompt is unaffected');
  assert.deepEqual(cleared, [7]);
  assert.deepEqual(updates, [true, false]);
  await controller.disableWindowAccess(access.windowId, access.enabledAt);
  assert.deepEqual(cleared, [7], 'already revoked grants are idempotent');
});
