import test from 'node:test';
import assert from 'node:assert/strict';

import { createRequest, createSuccess } from '../../protocol/src/index.js';
import { createActionLogController } from '../src/background-action-log.js';
import { createExtensionState } from '../src/background-state.js';

test('bridge action logging treats storage and UI failures as best-effort', async () => {
  const state = createExtensionState();
  let uiEmissions = 0;
  const chromeObj = {
    storage: {
      session: {
        async set() {
          throw new Error('session storage unavailable');
        },
      },
    },
    tabs: {
      async get() {
        return { url: 'https://example.com/' };
      },
    },
  } as unknown as typeof globalThis.chrome;
  const controller = createActionLogController(state, chromeObj, {
    async getCurrentTabState() {
      return null;
    },
    async resolveRequestTarget() {
      return {
        tabId: 7,
        windowId: 2,
        title: 'Example',
        url: 'https://example.com/',
      };
    },
    async emitUiState() {
      uiEmissions += 1;
      throw new Error('UI port closed');
    },
  });
  const request = createRequest({
    id: 'action-log-best-effort',
    method: 'tabs.activate',
    params: { tabId: 7 },
  });
  const response = createSuccess(request.id, { activated: true }, { method: request.method });

  await assert.doesNotReject(controller.logBridgeAction(request, response, null));
  assert.equal(state.actionLog.length, 1);
  assert.equal(uiEmissions, 1);
});

test('bridge action logging preserves actual optional debugger execution metadata', async () => {
  const state = createExtensionState();
  const chromeObj = {
    storage: {
      session: {
        async set() {},
      },
    },
    tabs: {
      async get() {
        return { url: 'https://example.com/' };
      },
    },
  } as unknown as typeof globalThis.chrome;
  const controller = createActionLogController(state, chromeObj, {
    async getCurrentTabState() {
      return null;
    },
    async resolveRequestTarget() {
      return {
        tabId: 7,
        windowId: 2,
        title: 'Example',
        url: 'https://example.com/',
      };
    },
    async emitUiState() {},
  });
  const request = createRequest({
    id: 'action-log-cdp-input',
    method: 'input.click',
    params: { target: { selector: '#save' }, executionMode: 'cdp' },
  });
  const response = createSuccess(
    request.id,
    { clicked: true, elementRef: 'el_save' },
    { method: request.method, debugger_backed: true }
  );

  await controller.logBridgeAction(request, response, { tabId: 7, url: 'https://example.com/' });
  assert.equal(state.actionLog.length, 1);
  assert.equal(state.actionLog[0].debuggerBacked, true);
});

test('standalone handshake pings are logged and immediate sourced checks replace them', async () => {
  const state = createExtensionState();
  const chromeObj = {
    storage: {
      session: {
        async set() {},
      },
    },
  } as unknown as typeof globalThis.chrome;
  const controller = createActionLogController(state, chromeObj, {
    async getCurrentTabState() {
      return {
        tabId: 31,
        windowId: 8,
        title: 'Current tab',
        url: 'https://example.com/current',
        enabled: false,
        accessRequested: false,
        restricted: false,
      };
    },
    async resolveRequestTarget() {
      throw new Error('connection checks do not require access');
    },
    async emitUiState() {},
  });
  const internalRequest = createRequest({ id: 'internal-handshake', method: 'health.ping' });
  const response = createSuccess(
    internalRequest.id,
    {
      extension: 'ok',
      access: { enabled: false, routeReady: false },
    },
    { method: internalRequest.method }
  );

  const context = await controller.getActionContext(internalRequest);
  await controller.logBridgeAction(internalRequest, response, context);
  assert.equal(state.actionLog.length, 1);
  assert.equal(state.actionLog[0].method, 'health.ping');
  assert.equal(state.actionLog[0].source, '');
  assert.equal(state.actionLog[0].tabId, 31);
  assert.equal(state.actionLog[0].url, 'https://example.com/current');
  assert.equal(
    state.actionLog[0].summary,
    'Connection check completed; window access is disabled.'
  );

  const sourcedRequest = createRequest({
    id: 'connection-check',
    method: 'health.ping',
    meta: { source: 'cli' },
  });
  await controller.logBridgeAction(sourcedRequest, response, context);
  assert.equal(state.actionLog.length, 1);
  assert.equal(state.actionLog[0].source, 'cli');
});

test('dialog text and prompt values never enter persisted action logs', async () => {
  const state = createExtensionState();
  const writes: string[] = [];
  const chromeObj = {
    storage: {
      session: {
        async set(value: unknown) {
          writes.push(JSON.stringify(value));
        },
      },
    },
  } as unknown as typeof globalThis.chrome;
  const controller = createActionLogController(state, chromeObj, {
    async getCurrentTabState() {
      return null;
    },
    async resolveRequestTarget() {
      return { tabId: 7, windowId: 2, title: 'Example', url: 'https://example.com/' };
    },
    async emitUiState() {},
  });
  const secret = 'dialog-secret-value';
  const request = createRequest({
    id: 'dialog-log-redaction',
    method: 'page.handle_dialog',
    params: { action: 'accept', promptText: secret, expectedDialogId: 'dialog-1' },
  });
  const response = createSuccess(
    request.id,
    {
      commandDispatched: true,
      action: 'accept',
      type: 'prompt',
      message: secret,
      defaultPrompt: secret,
    },
    { method: request.method, debugger_backed: true }
  );

  await controller.logBridgeAction(request, response, {
    tabId: 7,
    url: 'https://example.com/',
  });
  const firstDiagnostics = {
    responseBytes: state.actionLog[0].responseBytes,
    approxTokens: state.actionLog[0].approxTokens,
    costClass: state.actionLog[0].costClass,
    summaryBytes: state.actionLog[0].summaryBytes,
    summaryTokens: state.actionLog[0].summaryTokens,
  };
  const longSecret = 'x'.repeat(4_096);
  await controller.logBridgeAction(
    request,
    createSuccess(
      request.id,
      {
        commandDispatched: true,
        action: 'accept',
        type: 'prompt',
        message: longSecret,
        defaultPrompt: longSecret,
      },
      {
        method: request.method,
        debugger_backed: true,
        budget_truncated: true,
        continuation_hint: `secret-length-${longSecret.length}`,
      }
    ),
    { tabId: 7, url: 'https://example.com/' }
  );

  assert.equal(state.actionLog.length, 2);
  assert.equal(
    state.actionLog[0].summary,
    'Dialog accept command dispatched; Chrome did not atomically bind it to the observation identifier.'
  );
  assert.deepEqual(
    {
      responseBytes: state.actionLog[1].responseBytes,
      approxTokens: state.actionLog[1].approxTokens,
      costClass: state.actionLog[1].costClass,
      summaryBytes: state.actionLog[1].summaryBytes,
      summaryTokens: state.actionLog[1].summaryTokens,
    },
    firstDiagnostics
  );
  assert.equal(state.actionLog[1].overBudget, false);
  assert.equal(state.actionLog[1].continuationHint, null);
  assert.doesNotMatch(JSON.stringify(state.actionLog), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(state.actionLog), /secret-length|xxxx/);
  assert.doesNotMatch(writes.join('\n'), new RegExp(secret));
});
