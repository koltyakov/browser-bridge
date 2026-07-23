import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFailure,
  createRequest,
  createSuccess,
  ERROR_CODES,
} from '../../protocol/src/index.js';
import { createActionLogController, enrichBridgeResponse } from '../src/background-action-log.js';
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

test('action logs sanitize incidental URL and error details before persistence', async () => {
  const state = createExtensionState();
  const writes: string[] = [];
  const chromeObj = {
    storage: {
      session: {
        async get() {
          return {
            actionLog: [
              {
                id: 'legacy',
                method: 'page.get_state',
                url: 'https://user:pass@example.test/page?token=secret#fragment',
                summary: 'failed at /Users/alice/project/config.json',
              },
            ],
          };
        },
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
      throw new Error('not needed');
    },
    async emitUiState() {},
  });

  await controller.restoreActionLog();
  await controller.appendActionLogEntry({
    method: 'page.get_state',
    ok: false,
    url: 'https://user:pass@example.test/page?token=secret#fragment',
    summary: 'Authorization: Bearer secret',
  });

  assert.equal(state.actionLog[0].url, 'https://example.test/page?token=%5Bredacted%5D');
  assert.equal(state.actionLog[0].summary, 'failed at [redacted-path]/config.json');
  assert.equal(state.actionLog[1].summary, 'Authorization: [redacted]');
  assert.doesNotMatch(JSON.stringify(state.actionLog), /user:pass|Bearer secret|\/Users\/alice/);
  assert.doesNotMatch(writes.join('\n'), /user:pass|Bearer secret|\/Users\/alice/);
});

test('sensitive reads remain exact while warning activity never retains values or derived sizes', async () => {
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
      return { tabId: 7, windowId: 2, title: 'Example', url: 'https://example.test/' };
    },
    async emitUiState() {},
  });
  const secret = '\u001b[31mline 1\n\u2603 {"token":"value"}';
  const request = createRequest({
    id: 'sensitive-log',
    method: 'sensitive.read',
    params: { source: 'local_storage', key: 'private-token' },
    meta: { token_budget: 1 },
  });
  const response = enrichBridgeResponse(
    request,
    createSuccess(
      request.id,
      { source: 'local_storage', value: secret, exact: true },
      { method: request.method }
    )
  );
  assert.equal(response.ok, true);
  if (response.ok) {
    assert.equal((response.result as { value: string }).value, secret);
    assert.equal(response.meta.transport_bytes, undefined);
  }

  await controller.logBridgeAction(request, response, {
    tabId: 7,
    url: 'https://example.test/?token=secret',
  });
  await controller.logBridgeAction(
    request,
    createFailure(request.id, ERROR_CODES.SENSITIVE_TARGET_NOT_FOUND, 'Missing exact key.', null, {
      method: request.method,
    }),
    { tabId: 7, url: 'https://example.test/' }
  );

  assert.equal(state.actionLog.length, 2);
  assert.deepEqual(
    state.actionLog.map((entry) => ({
      ok: entry.ok,
      severity: entry.severity,
      summary: entry.summary,
      responseBytes: entry.responseBytes,
      approxTokens: entry.approxTokens,
      sensitiveAccess: entry.sensitiveAccess,
    })),
    [
      {
        ok: true,
        severity: 'warning',
        summary: 'Sensitive local storage read succeeded.',
        responseBytes: 0,
        approxTokens: 0,
        sensitiveAccess: {
          source: 'local_storage',
          category: 'storage_value',
          keyLength: 13,
        },
      },
      {
        ok: false,
        severity: 'warning',
        summary: 'Sensitive local storage read failed: SENSITIVE_TARGET_NOT_FOUND.',
        responseBytes: 0,
        approxTokens: 0,
        sensitiveAccess: {
          source: 'local_storage',
          category: 'storage_value',
          keyLength: 13,
        },
      },
    ]
  );
  assert.doesNotMatch(JSON.stringify(state.actionLog), /private-token|line 1|"token"/);
  assert.doesNotMatch(writes.join('\n'), /private-token|line 1|"token"/);
});

test('page evaluation activity warns without persisting returned values or sizes', async () => {
  const state = createExtensionState();
  const writes: string[] = [];
  const chromeObj = {
    storage: { session: { set: async (value: unknown) => writes.push(JSON.stringify(value)) } },
  } as unknown as typeof globalThis.chrome;
  const controller = createActionLogController(state, chromeObj, {
    async getCurrentTabState() {
      return null;
    },
    async resolveRequestTarget() {
      return { tabId: 7, windowId: 2, title: 'Example', url: 'https://example.test/' };
    },
    async emitUiState() {},
  });
  const request = createRequest({
    id: 'evaluate-sensitive-capability',
    method: 'page.evaluate',
    params: { expression: 'localStorage.getItem("token")' },
  });
  await controller.logBridgeAction(
    request,
    createSuccess(
      request.id,
      { value: 'secret-value', type: 'string' },
      { method: request.method }
    ),
    { tabId: 7, url: 'https://example.test/' }
  );

  assert.equal(state.actionLog[0].severity, 'warning');
  assert.equal(state.actionLog[0].responseBytes, 0);
  assert.match(state.actionLog[0].summary, /sensitive-data access capability succeeded/);
  assert.doesNotMatch(JSON.stringify(state.actionLog), /secret-value|localStorage|getItem/);
  assert.doesNotMatch(writes.join('\n'), /secret-value|localStorage|getItem/);
});

test('sensitive activity is recorded in memory before persistence completes', async () => {
  const state = createExtensionState();
  let releasePersistence = () => {};
  const persistence = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  const chromeObj = {
    storage: { session: { set: () => persistence } },
  } as unknown as typeof globalThis.chrome;
  const controller = createActionLogController(state, chromeObj, {
    async getCurrentTabState() {
      return null;
    },
    async resolveRequestTarget() {
      return { tabId: 7, windowId: 2, title: 'Example', url: 'https://example.test/' };
    },
    async emitUiState() {},
  });
  const request = createRequest({
    id: 'sensitive-persistence',
    method: 'sensitive.read',
    params: { source: 'local_storage', key: 'token' },
  });
  const logging = controller.logBridgeAction(
    request,
    createSuccess(
      request.id,
      { source: 'local_storage', value: 'secret', exact: true },
      {
        method: request.method,
      }
    ),
    { tabId: 7, url: 'https://example.test/' }
  );

  await Promise.resolve();
  assert.equal(state.actionLog.length, 1);
  releasePersistence();
  await logging;
});

test('sensitive reads reject values whose encoded response exceeds transport limits', () => {
  const request = createRequest({
    id: 'sensitive-encoded-size',
    method: 'sensitive.read',
    params: { source: 'local_storage', key: 'token' },
  });
  const response = enrichBridgeResponse(
    request,
    createSuccess(
      request.id,
      { source: 'local_storage', value: '\u0000'.repeat(262_144), exact: true },
      { method: request.method }
    )
  );

  assert.equal(response.ok, false);
  if (response.ok) assert.fail('Expected encoded sensitive value rejection');
  assert.equal(response.error.code, ERROR_CODES.RESULT_TOO_LARGE);
  assert.equal(response.error.recovery?.retry, false);
  assert.equal((response.error.details as { bytes: number }).bytes, 262_144);
  assert.ok((response.error.details as { responseBytes: number }).responseBytes > 1_000_000);
});
