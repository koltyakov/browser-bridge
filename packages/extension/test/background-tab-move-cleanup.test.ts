import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTabCleanupController,
  createTabMoveCleanupController,
} from '../src/background-tab-cleanup.js';
import { createPageRequestController } from '../src/background-page.js';
import { TabDebuggerCoordinator } from '../src/debugger-coordinator.js';
import { createRequest } from '../../protocol/src/index.js';
import type { ExtensionState } from '../src/background-state.js';

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
    disableTabInstrumentation: async () => {},
    resumeTabInstrumentation: async () => {},
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
  assert.deepEqual(calls, ['cancel-move', 'clear-tab']);

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

test('tab bridge cleanup finishes debugger ownership cleanup when a tab re-enters access', async () => {
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
    discardFetchInterception() {
      calls.push('discard-fetch');
    },
    async stopCdpNetworkCapture() {
      calls.push('stop-cdp-network');
    },
    async discardCdpNetworkCapture() {
      calls.push('discard-cdp-network');
    },
    async beginDebuggerCleanup() {
      calls.push('begin-cleanup');
      return () => calls.push('end-cleanup');
    },
    async commitDebuggerCleanup() {
      calls.push('commit-cleanup');
    },
    cancelNavigationWaitsForWindow() {},
    isRecoverableInstrumentationError: () => false,
    isRestrictedAutomationUrl: () => false,
  });

  await cleanup.clearTabBridgeState(11, async () => {
    checks += 1;
    return checks < 2;
  });

  assert.deepEqual(calls, ['clear-console', 'clear-network']);
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
    disableTabInstrumentation: async () => {},
    resumeTabInstrumentation: async () => {},
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

test('move re-entry abort preserves an observed dialog for page.handle_dialog', async () => {
  let tabWindowId = 2;
  let outsideChecks = 0;
  let resumeInitialCleanupCheck: (value?: void | PromiseLike<void>) => void = () => {};
  let signalInitialCleanupCheck: (value?: void | PromiseLike<void>) => void = () => {};
  const initialCleanupCheck = new Promise<void>((resolve) => {
    signalInitialCleanupCheck = resolve;
  });
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {},
    burstIdleMs: 10_000,
  });
  await coordinator.run(7, async () => {});
  coordinator.handleEvent(7, 'Page.javascriptDialogOpening', {
    type: 'confirm',
    message: 'still open',
  });
  const dialogId = coordinator.getDialog(7)?.dialogId;

  const chromeObj = {
    windows: {
      async get() {
        return { id: 1 };
      },
    },
    tabs: {
      async get(tabId: number) {
        return {
          id: tabId,
          windowId: tabWindowId,
          title: 'Dialog tab',
          url: 'https://example.com/dialog',
          status: 'complete',
        };
      },
      async query() {
        return [
          {
            id: 7,
            windowId: tabWindowId,
            title: 'Dialog tab',
            url: 'https://example.com/dialog',
            status: 'complete',
          },
        ];
      },
    },
  } as unknown as typeof chrome;
  const cleanup = createTabCleanupController(chromeObj, {
    async ensureContentScript() {},
    async sendTabMessage() {
      return { patches: [] };
    },
    async readConsoleBuffer() {
      return {};
    },
    async readNetworkBuffer() {
      return {};
    },
    beginDebuggerCleanup: (tabId) => coordinator.beginCleanup(tabId),
    commitDebuggerCleanup: (tabId) => coordinator.commitCleanup(tabId),
    async clearFetchInterception() {
      return 0;
    },
    discardFetchInterception() {},
    async stopCdpNetworkCapture() {},
    async discardCdpNetworkCapture() {},
    cancelNavigationWaitsForWindow() {},
    isRecoverableInstrumentationError: () => false,
    isRestrictedAutomationUrl: () => false,
  });
  const move = createTabMoveCleanupController({
    getEnabledWindowId: () => 1,
    async isTabOutsideEnabledWindow() {
      outsideChecks += 1;
      if (outsideChecks === 1) return true;
      if (outsideChecks === 2) {
        signalInitialCleanupCheck();
        await new Promise<void>((resolve) => {
          resumeInitialCleanupCheck = resolve;
        });
      }
      return tabWindowId !== 1;
    },
    cancelNavigationWaitsForMove() {},
    cancelNavigationWaitsForRemoval() {},
    clearDialogState: (tabId) => coordinator.clearDialogState(tabId),
    disableTabInstrumentation: async () => {},
    resumeTabInstrumentation: async () => {},
    clearTabBridgeState: cleanup.clearTabBridgeState,
    async clearRemovedTabState() {},
  });

  move.handleDetached(7, { oldWindowId: 1 });
  const moved = move.handleAttached(7, { newWindowId: 2 });
  await initialCleanupCheck;
  tabWindowId = 1;
  resumeInitialCleanupCheck();
  await moved;

  assert.equal(coordinator.getDialog(7)?.dialogId, dialogId);
  const state = {
    enabledWindow: { windowId: 1, title: 'Enabled', enabledAt: 1 },
  } as ExtensionState;
  const page = createPageRequestController(state, chromeObj, {
    async clearEnabledWindowIfGone() {
      return false;
    },
    async primeTabConsoleCapture() {},
    async readConsoleBuffer() {
      return { entries: [], dropped: 0 };
    },
    async ensureNetworkInterceptor() {},
    async readNetworkBuffer() {
      return { entries: [], dropped: 0 };
    },
    async startCdpNetworkCapture() {
      return {};
    },
    async clearCdpNetworkCapture() {
      return {};
    },
    async readCdpNetworkCapture() {
      return {};
    },
    async stopCdpNetworkCapture() {
      return {};
    },
    runWithDebugger: (tabId, operation, options) => coordinator.run(tabId, operation, options),
    runForDialog: (tabId, operation, options) =>
      coordinator.runForDialog(tabId, operation, options),
    async sendCommand(_target, method) {
      if (method === 'Page.handleJavaScriptDialog') {
        coordinator.handleEvent(7, 'Page.javascriptDialogClosed', {});
      }
      return {};
    },
    async ensureContentScript() {},
    async sendTabMessage() {
      return {};
    },
    contentScriptTimeoutMs: 5_000,
    waitForDialog: (tabId, timeoutMs) => coordinator.waitForDialog(tabId, timeoutMs),
    getDialogObservation: (tabId) => coordinator.getDialogObservation(tabId),
    getDialogStatus: (tabId) => coordinator.getDialogStatus(tabId),
    clearDialog: (tabId, expectedDialogId) => coordinator.clearDialog(tabId, expectedDialogId),
    async waitForUrl() {
      throw new Error('waitForUrl was not expected');
    },
  });

  const inspected = await page.handlePageDialog(
    createRequest({ id: 'move-dialog-inspect', method: 'page.handle_dialog', tabId: 7 })
  );
  assert.equal((inspected.result as Record<string, unknown>).dialogId, dialogId);
  const dismissed = await page.handlePageDialog(
    createRequest({
      id: 'move-dialog-dismiss',
      method: 'page.handle_dialog',
      tabId: 7,
      params: { action: 'dismiss', expectedDialogId: dialogId },
    })
  );
  assert.equal((dismissed.result as Record<string, unknown>).action, 'dismiss');
  assert.equal(coordinator.getDialog(7), null);
  await coordinator.discard(7);
});

test('tab cleanup hard-discards serialized CDP capture ownership after stop failure', async () => {
  const calls: string[] = [];
  const cleanup = createTabCleanupController(
    {
      tabs: {
        async query() {
          return [];
        },
      },
    } as unknown as typeof chrome,
    {
      async ensureContentScript() {},
      async sendTabMessage() {
        return { patches: [] };
      },
      async readConsoleBuffer() {
        return {};
      },
      async readNetworkBuffer() {
        return {};
      },
      async clearFetchInterception() {
        calls.push('clear-fetch');
        return 0;
      },
      discardFetchInterception() {
        calls.push('discard-fetch');
      },
      async stopCdpNetworkCapture() {
        calls.push('stop-network');
        throw new Error('disable failed');
      },
      async beginDebuggerCleanup() {
        calls.push('begin-cleanup');
        return () => calls.push('end-cleanup');
      },
      async commitDebuggerCleanup() {
        calls.push('commit-cleanup');
      },
      async discardCdpNetworkCapture() {
        calls.push('discard-network-state');
      },
      cancelNavigationWaitsForWindow() {},
      isRecoverableInstrumentationError: () => false,
      isRestrictedAutomationUrl: () => false,
    }
  );

  await cleanup.clearTabBridgeState(42);
  assert.deepEqual(calls.slice(0, 4), [
    'begin-cleanup',
    'commit-cleanup',
    'clear-fetch',
    'stop-network',
  ]);
  assert.equal(calls.includes('discard-network-state'), true);
  assert.equal(calls.at(-1), 'end-cleanup');
});
