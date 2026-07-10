import test from 'node:test';
import assert from 'node:assert/strict';

import { createChromeFake } from '../../../tests/_helpers/chromeFake.ts';
import { createExtensionState, setExtensionState } from '../src/background-state.js';
import { createWindowSessionController } from '../src/background-window-session.js';

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

test('enabled-window switches revoke access, tear down the prior window, and serialize', async () => {
  const state = createExtensionState();
  setExtensionState(state);
  state.enabledWindow = { windowId: 1, title: 'One', enabledAt: 1 };
  const firstClear = createDeferred();
  const secondClear = createDeferred();
  const clearedWindows: number[] = [];
  const injectedWindows: number[] = [];
  const accessUpdates: boolean[] = [];
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
  assert.deepEqual(injectedWindows, []);
  assert.deepEqual(accessUpdates, [false]);

  firstClear.resolve();
  await waitFor(() => clearedWindows.length === 2);
  assert.equal(state.enabledWindow, null);
  assert.deepEqual(clearedWindows, [1, 2]);
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
  assert.deepEqual(accessUpdates, [false, true, false, true, false]);
});
