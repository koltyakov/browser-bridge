import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFailure,
  createRequest,
  createSuccess,
  ERROR_CODES,
} from '../../protocol/src/index.js';
import { createActionLogController, enrichBridgeResponse } from '../src/background-action-log.js';
import { createExtensionState, MAX_ACTION_LOG_ENTRIES } from '../src/background-state.js';
import { createStorageArea } from '../../../tests/_helpers/chromeFake.ts';

const openTabsApi = {
  async get(tabId: number) {
    return { id: tabId, url: 'https://example.test/' };
  },
  async query() {
    return [{ id: 7 }, { id: 31 }];
  },
};

function createHistoryHarness(stored: Record<string, unknown> = {}) {
  const storage = createStorageArea(stored);
  const openTabIds = new Set([7, 8]);
  const chromeObj = {
    storage: { session: storage },
    tabs: {
      async get(tabId: number) {
        if (!openTabIds.has(tabId)) throw new Error('Tab was closed');
        return { id: tabId, url: `https://example.test/tab-${tabId}` };
      },
      async query() {
        return [...openTabIds].map((id) => ({ id }));
      },
    },
  } as unknown as typeof globalThis.chrome;
  function startWorker() {
    const state = createExtensionState();
    const controller = createActionLogController(state, chromeObj, {
      async getCurrentTabState() {
        return null;
      },
      async resolveRequestTarget() {
        return { tabId: 7, windowId: 2, title: 'Example', url: 'https://example.test/tab-7' };
      },
      async emitUiState() {},
    });
    return { state, controller };
  }
  return { storage, openTabIds, startWorker, ...startWorker() };
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('WebMCP activity never persists website metadata, arguments, output or callback errors', async () => {
  const { controller, storage } = createHistoryHarness();
  const toolRef = 'wm_12345678-1234-1234-1234-123456789012';
  for (const method of ['webmcp.list_tools', 'webmcp.get_tool', 'webmcp.execute_tool'] as const) {
    const request = createRequest({
      id: method,
      method,
      tabId: 7,
      params: { toolRef, arguments: { secret: 'argument-secret' } },
    });
    await controller.logBridgeAction(
      request,
      createSuccess(method, {
        value: 'output-secret',
        tool: { name: 'tool-secret', description: 'description-secret' },
      }),
      { tabId: 7, url: 'https://example.test/' }
    );
    await controller.logBridgeAction(
      request,
      createFailure(method, 'WEBMCP_EXECUTION_UNCERTAIN', 'error-secret', {
        value: 'detail-secret',
      }),
      { tabId: 7, url: 'https://example.test/' }
    );
  }
  const stored = JSON.stringify(storage.snapshot());
  for (const secret of [
    'argument-secret',
    'output-secret',
    'tool-secret',
    'description-secret',
    'error-secret',
    'detail-secret',
  ])
    assert.equal(stored.includes(secret), false);
  assert.match(stored, /WebMCP/);
});

test('sibling-tab and host activity cannot evict a quiet tab history', async () => {
  const { controller, state, storage } = createHistoryHarness();
  await controller.appendActionLogEntry({
    method: 'input.click',
    tabId: 7,
    ok: true,
    summary: 'Quiet tab',
  });
  const quietId = state.actionLog[0].id;
  for (let index = 0; index < MAX_ACTION_LOG_ENTRIES + 10; index += 1) {
    await controller.appendActionLogEntry({
      method: 'dom.query',
      tabId: 8,
      ok: true,
      summary: `Sibling ${index}`,
    });
    await controller.appendActionLogEntry({
      method: 'native.connected',
      ok: true,
      summary: `Host ${index}`,
    });
  }
  assert.deepEqual(
    state.actionLog.filter((entry) => entry.tabId === 7).map((entry) => entry.id),
    [quietId]
  );
  assert.equal(state.actionLog.filter((entry) => entry.tabId === 8).length, MAX_ACTION_LOG_ENTRIES);
  assert.equal(
    state.actionLog.filter((entry) => entry.tabId === null).length,
    MAX_ACTION_LOG_ENTRIES
  );
  assert.equal(state.actionLog.find((entry) => entry.tabId === 8)?.summary, 'Sibling 10');
  assert.deepEqual(storage.snapshot().actionLog, state.actionLog);
});

test('connection checks coalesce within their own tab despite sibling activity', async () => {
  const { controller, state } = createHistoryHarness();
  await controller.appendActionLogEntry({
    method: 'health.ping',
    tabId: 7,
    ok: true,
    summary: 'Handshake',
  });
  await controller.appendActionLogEntry({
    method: 'input.click',
    tabId: 8,
    ok: true,
    summary: 'Sibling',
  });
  await controller.appendActionLogEntry({
    method: 'health.ping',
    tabId: 7,
    source: 'mcp',
    ok: true,
    summary: 'Sourced check',
  });
  assert.deepEqual(
    state.actionLog.map((entry) => [entry.tabId, entry.summary]),
    [
      [8, 'Sibling'],
      [7, 'Sourced check'],
    ]
  );
});

test('worker restart restores each open tab independently and prunes closed-tab history', async () => {
  const actionLog = Array.from({ length: MAX_ACTION_LOG_ENTRIES + 10 }, (_, index) => [
    { id: `tab7-${index}`, method: 'dom.query', tabId: 7, at: index },
    { id: `tab8-${index}`, method: 'dom.query', tabId: 8, at: index },
    { id: `closed-${index}`, method: 'dom.query', tabId: 9, at: index },
  ]).flat();
  const { controller, state, storage, startWorker } = createHistoryHarness({ actionLog });
  await controller.restoreActionLog();
  assert.equal(state.actionLog.length, MAX_ACTION_LOG_ENTRIES * 2);
  assert.equal(state.actionLog.filter((entry) => entry.tabId === 7).length, MAX_ACTION_LOG_ENTRIES);
  assert.equal(state.actionLog.filter((entry) => entry.tabId === 8).length, MAX_ACTION_LOG_ENTRIES);
  assert.equal(
    state.actionLog.some((entry) => entry.tabId === 9),
    false
  );
  assert.deepEqual(storage.snapshot().actionLog, state.actionLog);
  const restarted = startWorker();
  await restarted.controller.restoreActionLog();
  assert.deepEqual(restarted.state.actionLog, state.actionLog);
  await restarted.controller.restoreActionLog();
  assert.deepEqual(restarted.state.actionLog, state.actionLog);
});

test('events arriving during startup wait for persisted history instead of overwriting it', async () => {
  const { controller, state, storage } = createHistoryHarness({
    actionLog: [{ id: 'previous', tabId: 7, method: 'input.click', summary: 'Previous worker' }],
  });
  const read = storage.get;
  const gate = deferred();
  storage.get = async (keys) => {
    await gate.promise;
    return read(keys);
  };
  const restoration = controller.restoreActionLog();
  const arriving = controller.appendActionLogEntry({
    method: 'dom.query',
    tabId: 8,
    ok: true,
    summary: 'New worker',
  });
  gate.resolve();
  await Promise.all([restoration, arriving]);
  assert.deepEqual(
    state.actionLog.map((entry) => entry.summary),
    ['Previous worker', 'New worker']
  );
  assert.deepEqual(storage.snapshot().actionLog, state.actionLog);
});

test('failed startup reads cannot overwrite stored history and are retried safely', async () => {
  const previous = { id: 'previous', tabId: 7, method: 'input.click', summary: 'Previous worker' };
  const { controller, state, storage } = createHistoryHarness({ actionLog: [previous] });
  const read = storage.get;
  let reads = 0;
  storage.get = async (keys) => {
    reads += 1;
    if (reads === 1) throw new Error('Transient read failure');
    return read(keys);
  };
  await controller.appendActionLogEntry({
    method: 'dom.query',
    tabId: 8,
    ok: true,
    summary: 'Memory only',
  });
  assert.deepEqual(storage.snapshot().actionLog, [previous]);
  await controller.appendActionLogEntry({
    method: 'input.click',
    tabId: 7,
    ok: true,
    summary: 'After retry',
  });
  assert.deepEqual(
    state.actionLog.map((entry) => entry.summary),
    ['Previous worker', 'Memory only', 'After retry']
  );
  assert.deepEqual(storage.snapshot().actionLog, state.actionLog);
});

test('late failures for a closed explicit tab do not become unscoped history', async () => {
  const { controller, state, openTabIds } = createHistoryHarness();
  openTabIds.delete(7);
  const request = createRequest({
    id: 'closed-explicit-history',
    method: 'dom.query',
    tabId: 7,
    params: { selector: 'main' },
  });
  await controller.logBridgeAction(
    request,
    createFailure(request.id, ERROR_CODES.TAB_MISMATCH, 'Tab closed'),
    null
  );
  assert.equal(state.actionLog.length, 0);
});

test('concurrent persistence is serialized and failed writes do not block later events', async () => {
  const { controller, state, storage } = createHistoryHarness();
  await controller.restoreActionLog();
  const write = storage.set;
  const started = deferred();
  const gate = deferred();
  let writes = 0;
  storage.set = async (items) => {
    writes += 1;
    if (writes === 1) {
      started.resolve();
      await gate.promise;
      throw new Error('Transient storage failure');
    }
    await write(items);
  };
  const first = controller.appendActionLogEntry({
    method: 'dom.query',
    tabId: 7,
    ok: true,
    summary: 'First',
  });
  const rejected = assert.rejects(first, /Transient storage failure/);
  await started.promise;
  const second = controller.appendActionLogEntry({
    method: 'dom.query',
    tabId: 8,
    ok: true,
    summary: 'Second',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 1);
  gate.resolve();
  await Promise.all([rejected, second]);
  assert.deepEqual(
    state.actionLog.map((entry) => entry.summary),
    ['First', 'Second']
  );
  assert.deepEqual(storage.snapshot().actionLog, state.actionLog);
});

test('tab closure clears memory and persistence without losing siblings or reviving late responses', async () => {
  const { controller, state, storage, openTabIds, startWorker } = createHistoryHarness();
  await controller.appendActionLogEntry({
    method: 'dom.query',
    tabId: 8,
    ok: true,
    summary: 'Sibling',
  });
  const write = storage.set;
  const started = deferred();
  const gate = deferred();
  let first = true;
  storage.set = async (items) => {
    if (first) {
      first = false;
      started.resolve();
      await gate.promise;
    }
    await write(items);
  };
  const pending = controller.appendActionLogEntry({
    method: 'input.click',
    tabId: 7,
    ok: true,
    summary: 'Pending',
  });
  await started.promise;
  openTabIds.delete(7);
  const closure = controller.clearActionLogForTab(7);
  const late = controller.appendActionLogEntry({
    method: 'input.click',
    tabId: 7,
    ok: true,
    summary: 'Late',
  });
  gate.resolve();
  await Promise.all([pending, closure, late]);
  assert.deepEqual(
    state.actionLog.map((entry) => [entry.tabId, entry.summary]),
    [[8, 'Sibling']]
  );
  assert.deepEqual(storage.snapshot().actionLog, state.actionLog);
  const restarted = startWorker();
  await restarted.controller.restoreActionLog();
  assert.deepEqual(restarted.state.actionLog, state.actionLog);
});

test('action history belongs to the actual routed tab and new tab rather than the preflight tab', async () => {
  const { controller, state } = createHistoryHarness();
  const request = createRequest({
    id: 'routed-history',
    method: 'dom.query',
    params: { selector: 'main' },
  });
  await controller.logBridgeAction(
    request,
    createSuccess(request.id, { nodes: [] }, { tab_id: 8 }),
    {
      tabId: 7,
      url: 'https://example.test/tab-7',
    }
  );
  const created = createRequest({
    id: 'created-history',
    method: 'tabs.create',
    params: { url: 'https://example.test/new' },
  });
  await controller.logBridgeAction(
    created,
    createSuccess(created.id, { tabId: 8, url: 'https://example.test/new' }),
    {
      tabId: 7,
      url: 'https://example.test/tab-7',
    }
  );
  assert.deepEqual(
    state.actionLog.map((entry) => entry.tabId),
    [8, 8]
  );
  assert.equal(state.actionLog[1].url, 'https://example.test/new');
  assert.equal(state.actionLog[0].url, '');
});

test('bridge action logging treats storage and UI failures as best-effort', async () => {
  const state = createExtensionState();
  let uiEmissions = 0;
  const chromeObj = {
    storage: {
      session: {
        async get() {
          return {};
        },
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
        async get() {
          return {};
        },
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
    tabs: openTabsApi,
    storage: {
      session: {
        async get() {
          return {};
        },
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

  const modernRequest = createRequest({
    id: 'modern-connection-check',
    method: 'health.ping',
    meta: { source: 'mcp', mcp_era: 'modern' },
  });
  await controller.logBridgeAction(modernRequest, response, context);
  assert.equal(state.actionLog.length, 1);
  assert.equal(state.actionLog[0].source, 'mcp');
  assert.equal(state.actionLog[0].mcpEra, 'modern');
});

test('dialog text and prompt values never enter persisted action logs', async () => {
  const state = createExtensionState();
  const writes: string[] = [];
  const chromeObj = {
    tabs: openTabsApi,
    storage: {
      session: {
        async get() {
          return {};
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

test('sensitive read success, failure, and oversize activity never retains values or derived sizes', async () => {
  const state = createExtensionState();
  const writes: string[] = [];
  const chromeObj = {
    tabs: openTabsApi,
    storage: {
      session: {
        async get() {
          return {};
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
      return { tabId: 7, windowId: 2, title: 'Example', url: 'https://example.test/' };
    },
    async emitUiState() {},
  });
  const successSecret = '\u001b[31mBBX_SENSITIVE_SUCCESS_SENTINEL\n\u2603 {"token":"value"}';
  const failureSecret = 'BBX_SENSITIVE_FAILURE_SENTINEL';
  const oversizeSecret = 'BBX_SENSITIVE_OVERSIZE_SENTINEL';
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
      { source: 'local_storage', value: successSecret, exact: true },
      { method: request.method }
    )
  );
  assert.equal(response.ok, true);
  if (response.ok) {
    assert.equal((response.result as { value: string }).value, successSecret);
    assert.equal(response.meta.transport_bytes, undefined);
  }

  await controller.logBridgeAction(request, response, {
    tabId: 7,
    url: 'https://example.test/?token=secret',
  });
  await controller.logBridgeAction(
    request,
    createFailure(
      request.id,
      ERROR_CODES.SENSITIVE_TARGET_NOT_FOUND,
      `Missing exact key: ${failureSecret}`,
      { observed: failureSecret },
      { method: request.method }
    ),
    { tabId: 7, url: 'https://example.test/' }
  );
  const oversizedValue = `${oversizeSecret}${'\u0000'.repeat(262_144 - oversizeSecret.length)}`;
  const oversizeResponse = enrichBridgeResponse(
    request,
    createSuccess(
      request.id,
      { source: 'local_storage', value: oversizedValue, exact: true },
      { method: request.method }
    )
  );
  assert.equal(oversizeResponse.ok, false);
  if (oversizeResponse.ok) assert.fail('Expected encoded sensitive value rejection');
  assert.equal(oversizeResponse.error.code, ERROR_CODES.RESULT_TOO_LARGE);
  assert.equal(oversizeResponse.error.recovery?.retry, false);
  assert.equal((oversizeResponse.error.details as { bytes: number }).bytes, 262_144);
  assert.ok(
    (oversizeResponse.error.details as { responseBytes: number }).responseBytes > 1_000_000
  );
  assert.doesNotMatch(JSON.stringify(oversizeResponse.error), new RegExp(oversizeSecret));
  await controller.logBridgeAction(request, oversizeResponse, {
    tabId: 7,
    url: 'https://example.test/',
  });

  assert.equal(state.actionLog.length, 3);
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
      {
        ok: false,
        severity: 'warning',
        summary: 'Sensitive local storage read failed: RESULT_TOO_LARGE.',
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
  for (const secret of [successSecret, failureSecret, oversizeSecret]) {
    assert.equal(JSON.stringify(state.actionLog).includes(secret), false);
    assert.equal(writes.join('\n').includes(secret), false);
  }
  assert.doesNotMatch(JSON.stringify(state.actionLog), /private-token|"token"/);
  assert.doesNotMatch(writes.join('\n'), /private-token|"token"/);
});

test('page evaluation activity warns without persisting returned values or sizes', async () => {
  const state = createExtensionState();
  const writes: string[] = [];
  const chromeObj = {
    tabs: openTabsApi,
    storage: {
      session: {
        get: async () => ({}),
        set: async (value: unknown) => writes.push(JSON.stringify(value)),
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
    tabs: openTabsApi,
    storage: { session: { get: async () => ({}), set: () => persistence } },
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

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.actionLog.length, 1);
  releasePersistence();
  await logging;
});
