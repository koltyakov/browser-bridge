import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTabCleanupController,
  createTabMoveCleanupController,
} from '../src/background-tab-cleanup.js';

test('tab move cleanup clears state only after a tab leaves the enabled window', async () => {
  let enabledWindowId: number | null = 1;
  let tabWindowId = 1;
  const calls: string[] = [];
  const controller = createTabMoveCleanupController({
    getEnabledWindowId: () => enabledWindowId,
    isTabOutsideEnabledWindow: async () => tabWindowId !== enabledWindowId,
    cancelNavigationWaitsForMove: () => calls.push('cancel-move'),
    cancelNavigationWaitsForRemoval: () => calls.push('cancel-remove'),
    clearDialogState: () => calls.push('clear-dialog'),
    clearTabBridgeState: async (_tabId, shouldContinue) => {
      assert.equal(await shouldContinue?.(), true);
      calls.push('clear-tab');
    },
    clearRemovedTabState: async () => {
      calls.push('clear-removed');
    },
  });

  controller.handleDetached(7, { oldWindowId: 1 });
  assert.deepEqual(calls, ['cancel-move']);
  tabWindowId = 2;
  await controller.handleAttached(7, { newWindowId: 2 });
  assert.deepEqual(calls, ['cancel-move', 'clear-dialog', 'clear-tab']);

  calls.length = 0;
  tabWindowId = 1;
  controller.handleDetached(8, { oldWindowId: 1 });
  await controller.handleAttached(8, { newWindowId: 1 });
  assert.deepEqual(calls, ['cancel-move']);

  calls.length = 0;
  controller.handleDetached(9, { oldWindowId: 3 });
  tabWindowId = 4;
  await controller.handleAttached(9, { newWindowId: 4 });
  assert.deepEqual(calls, []);

  enabledWindowId = 4;
  await controller.handleRemoved(10);
  assert.deepEqual(calls, ['cancel-remove', 'clear-dialog', 'clear-removed']);
});

test('tab bridge cleanup stops between destructive stages when a tab re-enters access', async () => {
  const calls: string[] = [];
  let checks = 0;
  const chromeObj = {
    tabs: {
      async query() {
        return [];
      },
    },
  } as unknown as typeof chrome;
  const cleanup = createTabCleanupController(chromeObj, {
    async ensureContentScript() {
      calls.push('ensure-content');
    },
    async sendTabMessage() {
      return { patches: [] };
    },
    async readConsoleBuffer() {
      calls.push('clear-console');
      return {};
    },
    async readNetworkBuffer() {
      calls.push('clear-network');
      return {};
    },
    async clearFetchInterception() {
      calls.push('clear-fetch');
      return 1;
    },
    async clearDebuggerState() {
      calls.push('clear-debugger');
    },
    cancelNavigationWaitsForWindow() {},
    isRecoverableInstrumentationError: () => false,
    isRestrictedAutomationUrl: () => false,
  });

  await cleanup.clearTabBridgeState(11, async () => {
    checks += 1;
    return checks < 2;
  });

  assert.deepEqual(calls, ['clear-fetch']);
  assert.equal(checks, 2);
});

test('tab move cleanup revalidates destination before beginning destructive cleanup', async () => {
  let enabledWindowId: number | null = 1;
  let tabWindowId = 1;
  const calls: string[] = [];
  const controller = createTabMoveCleanupController({
    getEnabledWindowId: () => enabledWindowId,
    isTabOutsideEnabledWindow: async () => tabWindowId !== enabledWindowId,
    cancelNavigationWaitsForMove: () => calls.push('cancel'),
    cancelNavigationWaitsForRemoval() {},
    clearDialogState: () => calls.push('clear-dialog'),
    clearTabBridgeState: async () => {
      calls.push('clear-tab');
    },
    async clearRemovedTabState() {},
  });

  controller.handleDetached(12, { oldWindowId: 1 });
  tabWindowId = 2;
  const attached = controller.handleAttached(12, { newWindowId: 2 });
  enabledWindowId = 2;
  await attached;

  assert.deepEqual(calls, ['cancel']);
});
