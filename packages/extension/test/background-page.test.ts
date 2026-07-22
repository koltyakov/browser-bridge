import test from 'node:test';
import assert from 'node:assert/strict';

import { createChromeEvent } from '../../../tests/_helpers/chromeFake.ts';
import { createRequest, ERROR_CODES, PROTOCOL_VERSION } from '../../protocol/src/index.js';
import type { BridgeRequest, BridgeResponse } from '../../protocol/src/types.js';
import type { ExtensionState } from '../src/background-state.js';
import { createPageRequestController } from '../src/background-page.js';

type DebuggerCommand = {
  method: string;
  params: Record<string, unknown>;
};

function createController(
  options: {
    getTab?: (tabId: number, updatedListenerCount: number) => Promise<Record<string, unknown>>;
    dialog?: Record<string, unknown> | null;
    dialogStatus?: Record<string, unknown>;
    sendTabMessage?: () => Promise<unknown>;
    ensureContentScript?: () => Promise<void>;
    waitForUrl?: () => Promise<{
      tab: chrome.tabs.Tab;
      elapsedMs: number;
      observedNavigationKind: string;
    }>;
    waitForDialog?: () => Promise<Record<string, unknown> | null>;
    sendCommandError?: (method: string) => Error | null;
    onSendCommand?: (
      method: string,
      setDialog: (value: Record<string, unknown> | null) => void
    ) => void;
  } = {}
) {
  const onUpdated = createChromeEvent();
  const onRemoved = createChromeEvent();
  const commands: DebuggerCommand[] = [];
  const debuggerOptions: Array<{ retryDetached?: boolean } | undefined> = [];
  let dialog = options.dialog ?? null;
  let dialogEventSequence = dialog ? 1 : 0;
  let lastOpenedDialogId = dialog && typeof dialog.dialogId === 'string' ? dialog.dialogId : null;
  function setDialog(value: Record<string, unknown> | null) {
    dialog = value;
    dialogEventSequence += 1;
    if (value && typeof value.dialogId === 'string') lastOpenedDialogId = value.dialogId;
  }
  const state = {
    enabledWindow: {
      windowId: 5,
      title: 'Enabled',
      enabledAt: 1,
    },
  } as ExtensionState;
  const chromeObj = {
    windows: {
      async get() {
        return { id: 5 };
      },
    },
    tabs: {
      onUpdated,
      onRemoved,
      async get(tabId: number) {
        if (options.getTab) {
          return options.getTab(tabId, onUpdated.listeners.length);
        }
        return {
          id: tabId,
          windowId: 5,
          title: 'Loading tab',
          url: 'https://example.com/loading',
          status: 'loading',
        };
      },
      async query() {
        return [
          {
            id: 21,
            windowId: 5,
            title: 'Active tab',
            url: 'https://example.com/active',
            status: 'complete',
          },
        ];
      },
    },
  } as unknown as typeof chrome;
  const controller = createPageRequestController(state, chromeObj, {
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
    async runWithDebugger(tabId, operation, runOptions) {
      debuggerOptions.push(runOptions);
      return operation({ tabId });
    },
    async sendCommand(_target, method, params) {
      commands.push({ method, params });
      options.onSendCommand?.(method, setDialog);
      const commandError = options.sendCommandError?.(method);
      if (commandError) throw commandError;
      return { ok: true };
    },
    ensureContentScript: options.ensureContentScript ?? (async () => {}),
    sendTabMessage: options.sendTabMessage ?? (async () => ({})),
    contentScriptTimeoutMs: 5_000,
    async waitForDialog() {
      const value = options.waitForDialog ? await options.waitForDialog() : dialog;
      if (options.waitForDialog && value !== dialog) setDialog(value);
      return value as {
        dialogId: string;
        type: string;
        message: string;
        defaultPrompt: string;
        messageTruncated: boolean;
        defaultPromptTruncated: boolean;
        openedAt: number;
      } | null;
    },
    getDialogObservation() {
      return {
        dialog: dialog as {
          dialogId: string;
          type: string;
          message: string;
          defaultPrompt: string;
          messageTruncated: boolean;
          defaultPromptTruncated: boolean;
          openedAt: number;
        } | null,
        eventSequence: dialogEventSequence,
        lastOpenedDialogId,
      };
    },
    getDialogStatus() {
      return options.dialogStatus ?? { status: 'unknown', observable: false };
    },
    clearDialog(_tabId, dialogId) {
      if ((dialog as { dialogId?: string } | null)?.dialogId !== dialogId) return false;
      dialog = null;
      return true;
    },
    waitForUrl:
      options.waitForUrl ??
      (async () => {
        throw new Error('waitForUrl was not expected');
      }),
  });

  return {
    controller,
    onUpdated,
    onRemoved,
    commands,
    debuggerOptions,
    getDialog: () => dialog,
  };
}

test('page request controller waits for matching load completion and ignores unrelated events', async () => {
  const { controller, onUpdated, onRemoved } = createController();
  const pending = controller.waitForTabComplete(21, 1_000);
  await Promise.resolve();

  onUpdated.dispatch(22, { status: 'complete' }, { id: 22 });
  onUpdated.dispatch(21, { status: 'loading' }, { id: 21 });
  onRemoved.dispatch(22);
  onUpdated.dispatch(21, { status: 'complete' }, { id: 21, status: 'complete' });

  assert.deepEqual(await pending, { id: 21, status: 'complete' });
});

test('page request controller rechecks load status after listeners are registered', async () => {
  const { controller } = createController({
    async getTab(tabId, updatedListenerCount) {
      return {
        id: tabId,
        windowId: 5,
        status: updatedListenerCount > 0 ? 'complete' : 'loading',
      };
    },
  });

  const tab = await controller.waitForTabComplete(21, 1_000);

  assert.equal(tab.status, 'complete');
});

test('page request controller rejects when a loading tab is removed', async () => {
  const { controller, onRemoved } = createController();
  const pending = controller.waitForTabComplete(21, 1_000);
  await Promise.resolve();

  onRemoved.dispatch(21);

  await assert.rejects(pending, {
    code: ERROR_CODES.TAB_MISMATCH,
    message: 'Tab was closed while waiting for load',
  });
});

test('page request controller reports load timeouts with the TIMEOUT code', async () => {
  const { controller } = createController();

  await assert.rejects(controller.waitForTabComplete(21, 1), {
    code: ERROR_CODES.TIMEOUT,
    message: 'Timed out waiting for tab 21 to finish loading after 1ms.',
  });
});

test('page request controller handles CDP computed-style validation and dispatches valid requests', async () => {
  const { controller, commands } = createController();
  const invalid = await controller.handleCdpRequest({
    id: 'req-invalid-computed-style',
    method: 'cdp.get_computed_styles_for_node',
    tab_id: null,
    params: {},
    meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
  } as BridgeRequest);

  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, ERROR_CODES.INVALID_REQUEST);
  assert.equal(invalid.error.message, 'nodeId must be a finite number.');

  const valid = (await controller.handleCdpRequest(
    createRequest({
      id: 'req-valid-computed-style',
      method: 'cdp.get_computed_styles_for_node',
      params: { nodeId: 42 },
    })
  )) as BridgeResponse;

  assert.equal(valid.ok, true);
  assert.deepEqual(commands, [
    {
      method: 'CSS.getComputedStyleForNode',
      params: { nodeId: 42 },
    },
  ]);
});

test('page request controller can return current tab state without waiting for load', async () => {
  const { controller } = createController();

  const response = await controller.handleWaitForLoadState(
    createRequest({
      id: 'req-no-wait-load-state',
      method: 'page.wait_for_load_state',
      params: {
        waitForLoad: false,
      },
    })
  );

  assert.equal(response.ok, true);
  assert.deepEqual(response.result, {
    method: 'page.wait_for_load_state',
    tabId: 21,
    windowId: 5,
    url: 'https://example.com/loading',
    title: 'Loading tab',
    status: 'loading',
  });
});

test('page dialog inspect returns bounded tracked details without handling it', async () => {
  const { controller, commands, debuggerOptions } = createController({
    dialog: {
      dialogId: 'dialog-1',
      type: 'prompt',
      message: 'Question?',
      defaultPrompt: 'default',
      messageTruncated: false,
      defaultPromptTruncated: false,
      openedAt: 123,
    },
  });
  const response = await controller.handlePageDialog(
    createRequest({ id: 'dialog-inspect', method: 'page.handle_dialog', params: {} })
  );

  assert.equal(response.ok, true);
  assert.deepEqual(response.result, {
    open: true,
    dialogId: 'dialog-1',
    type: 'prompt',
    message: 'Question?',
    defaultPrompt: 'default',
    messageTruncated: false,
    defaultPromptTruncated: false,
    openedAt: 123,
  });
  assert.deepEqual(commands, []);
  assert.deepEqual(debuggerOptions, [{ retryDetached: true }]);
});

test('page dialog accept sends prompt text once with mutation replay disabled', async () => {
  const { controller, commands, debuggerOptions } = createController({
    dialog: {
      dialogId: 'dialog-2',
      type: 'prompt',
      message: 'Secret question',
      defaultPrompt: '',
      messageTruncated: false,
      defaultPromptTruncated: false,
      openedAt: 123,
    },
  });
  const response = await controller.handlePageDialog(
    createRequest({
      id: 'dialog-accept',
      method: 'page.handle_dialog',
      params: { action: 'accept', promptText: 'answer', expectedDialogId: 'dialog-2' },
    })
  );

  assert.equal(response.ok, true);
  assert.deepEqual(response.result, {
    commandDispatched: true,
    action: 'accept',
    type: 'prompt',
    dialogId: 'dialog-2',
    expectedDialogIdChecked: true,
    atomicDialogBinding: false,
    replacementObserved: false,
  });
  assert.deepEqual(commands, [
    { method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'answer' } },
  ]);
  assert.deepEqual(debuggerOptions, [{ retryDetached: false }]);
});

test('page dialog dismiss does not send prompt text and no-dialog calls fail clearly', async () => {
  const dismiss = createController({
    dialog: {
      dialogId: 'dialog-3',
      type: 'confirm',
      message: 'Continue?',
      defaultPrompt: '',
      messageTruncated: false,
      defaultPromptTruncated: false,
      openedAt: 123,
    },
  });
  const dismissed = await dismiss.controller.handlePageDialog(
    createRequest({
      id: 'dialog-dismiss',
      method: 'page.handle_dialog',
      params: { action: 'dismiss' },
    })
  );
  assert.equal(dismissed.ok, true);
  assert.equal((dismissed.result as Record<string, unknown>).expectedDialogIdChecked, false);
  assert.deepEqual(dismiss.commands[0], {
    method: 'Page.handleJavaScriptDialog',
    params: { accept: false },
  });

  const missing = createController();
  await assert.rejects(
    missing.controller.handlePageDialog(
      createRequest({ id: 'dialog-missing', method: 'page.handle_dialog' })
    ),
    { code: ERROR_CODES.DIALOG_NOT_OPEN }
  );

  const stale = createController({
    dialog: {
      dialogId: 'dialog-4',
      type: 'alert',
      message: 'Already closed',
      defaultPrompt: '',
      messageTruncated: false,
      defaultPromptTruncated: false,
      openedAt: 123,
    },
    sendCommandError(method) {
      return method === 'Page.handleJavaScriptDialog' ? new Error('No dialog is showing') : null;
    },
  });
  await assert.rejects(
    stale.controller.handlePageDialog(
      createRequest({
        id: 'dialog-stale',
        method: 'page.handle_dialog',
        params: { action: 'dismiss', expectedDialogId: 'dialog-4' },
      })
    ),
    { code: ERROR_CODES.DIALOG_NOT_OPEN }
  );
});

test('page dialog waits for attachment-time opening events and rejects stale identities', async () => {
  let resolveOpening: (value: Record<string, unknown>) => void = () => {};
  const opening = new Promise<Record<string, unknown>>((resolve) => {
    resolveOpening = resolve;
  });
  const delayed = createController({ waitForDialog: async () => opening });
  const inspected = delayed.controller.handlePageDialog(
    createRequest({ id: 'dialog-delayed', method: 'page.handle_dialog' })
  );
  resolveOpening({
    dialogId: 'attachment-dialog',
    type: 'alert',
    message: 'ready',
    defaultPrompt: '',
    messageTruncated: false,
    defaultPromptTruncated: false,
    openedAt: 456,
  });
  assert.equal(((await inspected).result as Record<string, unknown>).dialogId, 'attachment-dialog');

  const stale = createController({
    dialog: {
      dialogId: 'current-dialog',
      type: 'confirm',
      message: 'new',
      defaultPrompt: '',
      messageTruncated: false,
      defaultPromptTruncated: false,
      openedAt: 789,
    },
  });
  await assert.rejects(
    stale.controller.handlePageDialog(
      createRequest({
        id: 'dialog-stale-identity',
        method: 'page.handle_dialog',
        params: { action: 'accept', expectedDialogId: 'old-dialog' },
      })
    ),
    { code: ERROR_CODES.DIALOG_ACTION_CONFLICT }
  );
  assert.deepEqual(stale.commands, []);
});

test('page dialog reports a conflict instead of claiming a replaced generation was handled', async () => {
  const replacement = {
    dialogId: 'dialog-new',
    type: 'alert',
    message: 'replacement-secret-value',
    defaultPrompt: '',
    messageTruncated: false,
    defaultPromptTruncated: false,
    openedAt: 999,
  };
  const harness = createController({
    dialog: {
      dialogId: 'dialog-old',
      type: 'alert',
      message: 'old-secret-value',
      defaultPrompt: '',
      messageTruncated: false,
      defaultPromptTruncated: false,
      openedAt: 998,
    },
    onSendCommand(method, setDialog) {
      if (method === 'Page.handleJavaScriptDialog') setDialog(replacement);
    },
  });

  await assert.rejects(
    harness.controller.handlePageDialog(
      createRequest({
        id: 'dialog-generation-race',
        method: 'page.handle_dialog',
        params: { action: 'dismiss', expectedDialogId: 'dialog-old' },
      })
    ),
    (error: unknown) => {
      const conflict = error as { code?: string; details?: Record<string, unknown> };
      assert.equal(conflict.code, ERROR_CODES.DIALOG_ACTION_CONFLICT);
      assert.deepEqual(conflict.details, {
        phase: 'during_dispatch',
        commandDispatched: true,
        actionOutcome: 'uncertain',
      });
      assert.doesNotMatch(JSON.stringify(conflict), /replacement-secret-value|old-secret-value/);
      return true;
    }
  );
  assert.deepEqual(harness.getDialog(), replacement);

  const staleFailure = createController({
    dialog: {
      dialogId: 'dialog-stale',
      type: 'alert',
      message: 'stale',
      defaultPrompt: '',
      messageTruncated: false,
      defaultPromptTruncated: false,
      openedAt: 1_000,
    },
    onSendCommand(method, setDialog) {
      if (method === 'Page.handleJavaScriptDialog') setDialog(replacement);
    },
    sendCommandError(method) {
      return method === 'Page.handleJavaScriptDialog' ? new Error('No dialog is showing') : null;
    },
  });
  await assert.rejects(
    staleFailure.controller.handlePageDialog(
      createRequest({
        id: 'dialog-generation-error-race',
        method: 'page.handle_dialog',
        params: { action: 'dismiss', expectedDialogId: 'dialog-stale' },
      })
    ),
    { code: ERROR_CODES.DIALOG_ACTION_CONFLICT }
  );
  assert.deepEqual(staleFailure.getDialog(), replacement);

  const openedAndClosed = createController({
    dialog: {
      dialogId: 'dialog-initial',
      type: 'alert',
      message: 'initial',
      defaultPrompt: '',
      messageTruncated: false,
      defaultPromptTruncated: false,
      openedAt: 1_001,
    },
    onSendCommand(method, setDialog) {
      if (method !== 'Page.handleJavaScriptDialog') return;
      setDialog(replacement);
      setDialog(null);
    },
  });
  await assert.rejects(
    openedAndClosed.controller.handlePageDialog(
      createRequest({
        id: 'dialog-replacement-opened-and-closed',
        method: 'page.handle_dialog',
        params: { action: 'accept' },
      })
    ),
    { code: ERROR_CODES.DIALOG_ACTION_CONFLICT }
  );
});

test('page state adds non-sensitive dialog status to content and background fallback results', async () => {
  const dialogStatus = { status: 'open', observable: true, type: 'alert', openedAt: 12 };
  const content = createController({
    dialogStatus,
    sendTabMessage: async () => ({
      url: 'https://example.com/active',
      origin: 'https://example.com',
      title: 'Page',
      readyState: 'complete',
    }),
  });
  const contentResponse = await content.controller.handlePageGetState(
    createRequest({ id: 'state-content', method: 'page.get_state' })
  );
  assert.equal(contentResponse.ok, true);
  assert.deepEqual((contentResponse.result as Record<string, unknown>).dialog, dialogStatus);

  const fallback = createController({
    dialogStatus,
    ensureContentScript: async () => {
      throw new Error('CONTENT_SCRIPT_UNAVAILABLE: Cannot access contents of the page');
    },
  });
  const fallbackResponse = await fallback.controller.handlePageGetState(
    createRequest({ id: 'state-fallback', method: 'page.get_state' })
  );
  assert.equal(fallbackResponse.ok, true);
  assert.deepEqual(fallbackResponse.result, {
    url: 'https://example.com/loading',
    origin: 'https://example.com',
    title: 'Loading tab',
    readyState: 'loading',
    contentAvailable: false,
    dialog: dialogStatus,
  });
  assert.equal(fallbackResponse.meta.background_fallback, true);
  assert.doesNotMatch(JSON.stringify(fallbackResponse.result), /Question|Secret/);

  const blockedByDialog = createController({
    dialogStatus,
    sendTabMessage: async () => {
      throw new Error('Timed out waiting for content script response after 5000ms.');
    },
  });
  const blockedResponse = await blockedByDialog.controller.handlePageGetState(
    createRequest({ id: 'state-dialog-blocked', method: 'page.get_state' })
  );
  assert.equal(blockedResponse.ok, true);
  assert.equal(blockedResponse.meta.background_fallback, true);
  assert.deepEqual((blockedResponse.result as Record<string, unknown>).dialog, dialogStatus);
});

test('page URL wait returns final URL, elapsed time, match mode, and observed kind', async () => {
  const { controller } = createController({
    waitForUrl: async () => ({
      tab: {
        id: 21,
        windowId: 5,
        title: 'Final',
        url: 'https://example.com/final',
        status: 'complete',
      } as chrome.tabs.Tab,
      elapsedMs: 42,
      observedNavigationKind: 'replaceState',
    }),
  });
  const response = await controller.handleWaitForLoadState(
    createRequest({
      id: 'wait-url',
      method: 'page.wait_for_load_state',
      params: { url: '/final', urlMatch: 'contains' },
    })
  );

  assert.equal(response.ok, true);
  assert.deepEqual(response.result, {
    method: 'page.wait_for_load_state',
    tabId: 21,
    windowId: 5,
    title: 'Final',
    url: 'https://example.com/final',
    status: 'complete',
    finalUrl: 'https://example.com/final',
    urlMatch: 'contains',
    elapsedMs: 42,
    observedNavigationKind: 'replaceState',
  });
});
