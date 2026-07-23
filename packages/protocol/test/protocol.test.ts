import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUDGET_PRESETS,
  BRIDGE_METHODS,
  BRIDGE_METHOD_REGISTRY,
  DEFAULT_DEVICE_SCALE_FACTOR,
  DEFAULT_EVAL_TIMEOUT_MS,
  DEFAULT_NAV_TIMEOUT_MS,
  DEFAULT_NETWORK_INTERCEPT_ACTION,
  MAX_SENSITIVE_VALUE_BYTES,
  ERROR_CODES,
  applyBudget,
  bridgeMethodNeedsTab,
  createFailure,
  createBridgeMethodGroups,
  createRequest,
  createRuntimeContext,
  getMethodCapability,
  getBridgeOperationTimeoutMs,
  isBatchSafeBridgeCall,
  normalizeCheckedAction,
  normalizeAccessRequestParams,
  createSuccess,
  normalizeCdpDispatchKeyEventParams,
  normalizeCdpDomSnapshotParams,
  normalizeCdpNodeIdParams,
  normalizeInputAction,
  normalizeDomQuery,
  normalizeNavigationAction,
  normalizePatchOperation,
  normalizeSelectAction,
  normalizeViewportAction,
  truncateText,
  normalizeEvaluateParams,
  normalizeConsoleParams,
  normalizeHandleDialogParams,
  normalizeWaitForParams,
  normalizeFindByTextParams,
  normalizeFindByRoleParams,
  normalizeGetHtmlParams,
  normalizeHoverParams,
  normalizeDragParams,
  normalizeStorageParams,
  normalizeSensitiveReadParams,
  normalizeWaitForLoadStateParams,
  normalizeTabCreateParams,
  normalizeTabCloseParams,
  normalizeAccessibilityTreeParams,
  normalizeScreenshotParams,
  normalizeArtifactReadParams,
  normalizeArtifactDeleteParams,
  normalizeNetworkParams,
  normalizeNetworkInterceptAddParams,
  normalizePageTextParams,
  normalizeExtractContentParams,
  normalizeLogTailParams,
  normalizeViewportResizeParams,
  normalizeStyleQuery,
  getErrorRecovery,
  PROTOCOL_VERSION,
  validateBridgeRequest,
} from '../src/index.js';
import type { BridgeRequest, TabCloseParams, WaitForParams } from '../src/types.js';

type ErrorWithCode = Error & { code?: string };

/** Ensure budgeting normalizes user-provided limits safely. */
test('applyBudget clamps and normalizes fields', () => {
  const budget = applyBudget({
    maxNodes: 999,
    maxDepth: -1,
    textBudget: 4,
    attributeAllowlist: ['id', 'id', '', 'data-test'],
  });

  assert.equal(budget.maxNodes, 250);
  assert.equal(budget.maxDepth, 1);
  assert.equal(budget.textBudget, 32);
  assert.deepEqual(budget.attributeAllowlist, ['id', 'data-test']);
});

test('normalizeDomQuery preserves canonical budgets across repeated validation', () => {
  const normalized = normalizeDomQuery({
    selector: 'main',
    withinRef: 'el_root',
    maxNodes: 5,
    maxDepth: 2,
    textBudget: 300,
    includeBbox: false,
    attributeAllowlist: ['id', 'data-testid'],
  });

  assert.deepEqual(normalizeDomQuery(normalized), normalized);

  const request = createRequest({
    id: 'req_dom_budget',
    method: 'dom.query',
    params: normalized,
  });
  const revalidated = validateBridgeRequest(request);
  assert.deepEqual(revalidated.params, normalized);
});

test('normalizeDomQuery gives top-level fields precedence over a nested budget', () => {
  const normalized = normalizeDomQuery({
    budget: {
      maxNodes: 5,
      maxDepth: 2,
      textBudget: 300,
      includeBbox: true,
      attributeAllowlist: ['class'],
    },
    maxNodes: 8,
    includeBbox: false,
    attributeAllowlist: ['id'],
  });

  assert.deepEqual(normalized.budget, {
    maxNodes: 8,
    maxDepth: 2,
    textBudget: 300,
    includeBbox: false,
    attributeAllowlist: ['id'],
  });
});

/** Ensure protocol metadata is always attached to outgoing requests. */
test('createRequest adds protocol metadata', () => {
  const request = createRequest({
    id: 'req_1',
    method: 'health.ping',
  });

  assert.equal(request.meta.protocol_version, PROTOCOL_VERSION);
});

test('createRequest includes explicit tab_id when provided', () => {
  const request = createRequest({
    id: 'req_2',
    method: 'dom.query',
    tabId: 5,
  });

  assert.equal(request.tab_id, 5);
});

test('getBridgeOperationTimeoutMs returns normalized defaults and requested waits', () => {
  assert.equal(getBridgeOperationTimeoutMs('navigation.navigate'), 15_000);
  assert.equal(getBridgeOperationTimeoutMs('page.evaluate', { timeoutMs: 20_000 }), 20_000);
  assert.equal(getBridgeOperationTimeoutMs('dom.wait_for', { timeoutMs: 60_000 }), 30_000);
  assert.equal(getBridgeOperationTimeoutMs('page.get_state'), null);
});

test('validateBridgeRequest normalizes routing and metadata fallbacks', () => {
  const request = validateBridgeRequest({
    id: 'req_meta',
    method: 'health.ping',
    meta: {
      protocol_version: 42,
      token_budget: '100',
      source: 'unknown',
      keep: 'value',
    },
  });

  assert.equal(request.tab_id, null);
  assert.equal(request.meta.protocol_version, PROTOCOL_VERSION);
  assert.equal(request.meta.token_budget, null);
  assert.equal(request.meta.source, undefined);
  assert.equal(request.meta.keep, 'value');
});

test('validateBridgeRequest accepts omitted, null, and positive safe integer tab_id routing', () => {
  const baseRequest = { id: 'req_tab', method: 'health.ping' } as const;

  assert.equal(validateBridgeRequest(baseRequest).tab_id, null);
  assert.equal(validateBridgeRequest({ ...baseRequest, tab_id: null }).tab_id, null);
  assert.equal(validateBridgeRequest({ ...baseRequest, tab_id: 1 }).tab_id, 1);
  assert.equal(
    validateBridgeRequest({ ...baseRequest, tab_id: Number.MAX_SAFE_INTEGER }).tab_id,
    Number.MAX_SAFE_INTEGER
  );
});

test('validateBridgeRequest rejects invalid explicitly supplied tab_id routing', () => {
  const invalidTabIds = [
    undefined,
    '12',
    true,
    false,
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ];

  for (const tabId of invalidTabIds) {
    assert.throws(
      () =>
        validateBridgeRequest({
          id: 'req_invalid_tab',
          method: 'health.ping',
          tab_id: tabId,
        } as unknown as BridgeRequest),
      (error) => {
        assert.equal(error instanceof Error, true);
        const bridgeError = error as ErrorWithCode;
        assert.equal(bridgeError.code, ERROR_CODES.INVALID_REQUEST);
        assert.equal(
          bridgeError.message,
          'Request tab_id must be null or a positive safe integer.'
        );
        return true;
      },
      `tab_id=${String(tabId)}`
    );
  }
});

/** Ensure success and failure responses keep the shared envelope shape. */
test('createSuccess and createFailure shape bridge responses', () => {
  const success = createSuccess('req_2', { ok: true }, { revision: 'rev_1' });
  const failure = createFailure('req_3', ERROR_CODES.ACCESS_DENIED, 'Denied');

  assert.equal(success.ok, true);
  assert.equal(success.meta.revision, 'rev_1');
  assert.equal(failure.error.code, ERROR_CODES.ACCESS_DENIED);
});

test('access denied recovery guidance tells the agent to wait for the user', () => {
  const recovery = getErrorRecovery(ERROR_CODES.ACCESS_DENIED);

  assert.ok(recovery);
  assert.equal(recovery.retry, false);
  assert.match(recovery.hint, /Do not request access again/i);
});

/** Ensure truncation metadata stays consistent. */
test('truncateText reports truncation metadata', () => {
  const result = truncateText('abcdef', 4);
  assert.equal(result.truncated, true);
  assert.equal(result.omitted, 2);
});

/** Ensure runtime guidance remains compact and opinionated. */
test('runtime context stays compact and opinionated', () => {
  const context = createRuntimeContext();
  assert.equal(context.v, PROTOCOL_VERSION);
  assert.ok(context.tips.length >= 3);
  assert.equal(context.flow.includes('page.get_state'), true);
});

test('bridge method registry is the source of truth for method ordering and tab-routing requirements', () => {
  assert.deepEqual(BRIDGE_METHODS, Object.keys(BRIDGE_METHOD_REGISTRY));
  assert.equal(bridgeMethodNeedsTab('health.ping'), false);
  assert.equal(bridgeMethodNeedsTab('setup.get_status'), false);
  assert.equal(bridgeMethodNeedsTab('setup.install'), false);
  assert.equal(bridgeMethodNeedsTab('dom.query'), true);
});

test('bridge method groups are derived from the registry', () => {
  const groups = createBridgeMethodGroups();
  assert.ok(groups.tabs.includes('tabs.create'));
  assert.ok(groups.inspect.includes('dom.find_by_role'));
  assert.ok(groups.wait.includes('page.wait_for_load_state'));
});

test('method capability lookup stays aligned with bridge semantics', () => {
  assert.equal(getMethodCapability('page.evaluate'), 'page.evaluate');
  assert.equal(getMethodCapability('page.get_network'), 'network.read');
  assert.equal(getMethodCapability('tabs.create'), 'tabs.manage');
  assert.equal(getMethodCapability('tabs.list'), null);
  assert.equal(getMethodCapability('health.ping'), null);
});

/** Ensure DOM patch metadata is preserved by normalization. */
test('normalizePatchOperation preserves DOM patch metadata', () => {
  const patch = normalizePatchOperation({
    operation: 'set_attribute',
    name: 'aria-hidden',
    value: 'true',
  });

  assert.equal(patch.name, 'aria-hidden');
  assert.equal(patch.value, 'true');
});

test('normalizePatchOperation defaults malformed patch metadata', () => {
  const patch = normalizePatchOperation({
    patchId: 123,
    target: 'button',
    operation: 42,
    name: false,
    declarations: 'color:red',
  } as unknown as Parameters<typeof normalizePatchOperation>[0]);

  assert.equal(patch.patchId, null);
  assert.deepEqual(patch.target, {});
  assert.equal(patch.operation, null);
  assert.equal(patch.name, null);
  assert.deepEqual(patch.declarations, {});
  assert.equal(patch.value, null);
});

test('normalizePatchOperation exposes toggle_class and rejects undocumented operations', () => {
  assert.equal(normalizePatchOperation({ operation: 'toggle_class' }).operation, 'toggle_class');
  assert.throws(
    () => normalizePatchOperation({ operation: 'replace_children' }),
    (error: ErrorWithCode) => error.code === ERROR_CODES.INVALID_REQUEST
  );
});

/** Ensure input actions normalize button and modifier defaults safely. */
test('normalizeInputAction preserves interactive intent', () => {
  const input = normalizeInputAction({
    target: { selector: 'button.primary' },
    button: 'right',
    clickCount: 9,
    value: 'filled value',
    mode: 'keystrokes',
    key: 'Enter',
    modifiers: ['Shift', ''],
  });

  assert.equal(input.target.selector, 'button.primary');
  assert.equal(input.button, 'right');
  assert.equal(input.clickCount, 2);
  assert.equal(input.value, 'filled value');
  assert.equal(input.mode, 'keystrokes');
  assert.equal(input.key, 'Enter');
  assert.deepEqual(input.modifiers, ['Shift']);
});

test('validateBridgeRequest normalizes input.fill parameters', () => {
  const request = validateBridgeRequest({
    id: 'req_fill',
    method: 'input.fill',
    params: {
      target: { selector: '#name' },
      value: 'Ada',
      mode: 'setter',
    },
  });

  assert.deepEqual(request.params, {
    target: { elementRef: undefined, selector: '#name' },
    button: 'left',
    clickCount: 1,
    text: '',
    value: 'Ada',
    mode: 'setter',
    clear: false,
    submit: false,
    key: '',
    modifiers: [],
    executionMode: 'dom',
    recoverStale: false,
  });
});

test('input execution and stale recovery options are strict and opt-in', () => {
  const input = normalizeInputAction({ executionMode: 'cdp', recoverStale: true });
  assert.equal(input.executionMode, 'cdp');
  assert.equal(input.recoverStale, true);
  assert.throws(
    () => normalizeInputAction({ executionMode: 'native' } as never),
    /executionMode must be either dom or cdp/
  );
});

test('normalizeInputAction defaults invalid input details', () => {
  const input = normalizeInputAction({
    target: null,
    button: 'invalid',
    clickCount: 0,
    text: 42,
    value: 42,
    mode: 'invalid',
    modifiers: 'Shift',
  } as unknown as Parameters<typeof normalizeInputAction>[0]);

  assert.deepEqual(input.target, { elementRef: undefined, selector: undefined });
  assert.equal(input.button, 'left');
  assert.equal(input.clickCount, 1);
  assert.equal(input.text, '');
  assert.equal(input.value, '');
  assert.equal(input.mode, 'auto');
  assert.deepEqual(input.modifiers, []);
});

test('normalizeCdpDispatchKeyEventParams preserves valid CDP key event input', () => {
  const input = normalizeCdpDispatchKeyEventParams({
    key: 'Escape',
    code: ' Escape ',
    modifiers: ['Shift'],
  });

  assert.equal(input.key, 'Escape');
  assert.equal(input.code, 'Escape');
  assert.deepEqual(input.modifiers, ['Shift']);
});

test('normalizeCdpNodeIdParams requires a finite node id', () => {
  assert.deepEqual(normalizeCdpNodeIdParams({ nodeId: 42 }), { nodeId: 42 });

  assert.throws(
    () => normalizeCdpNodeIdParams({ nodeId: Number.NaN }),
    /nodeId must be a finite number\./
  );
});

test('normalizeCdpDomSnapshotParams bounds computed style names', () => {
  assert.deepEqual(
    normalizeCdpDomSnapshotParams({ computedStyles: ['display', '', 'x'.repeat(129), 'color'] }),
    { computedStyles: ['display', 'color'] }
  );
  assert.throws(
    () => normalizeCdpDomSnapshotParams({ computedStyles: Array(101).fill('display') }),
    (error: ErrorWithCode) => error.code === ERROR_CODES.INVALID_REQUEST
  );
});

/** Ensure checked actions default to an affirmative toggle with a normalized target. */
test('normalizeCheckedAction defaults to checked=true', () => {
  const action = normalizeCheckedAction({
    target: { selector: 'input[type=checkbox]' },
  });

  assert.equal(action.target.selector, 'input[type=checkbox]');
  assert.equal(action.checked, true);
});

/** Ensure select actions keep only useful selectors. */
test('normalizeSelectAction preserves selection intent', () => {
  const action = normalizeSelectAction({
    target: { elementRef: 'el_1' },
    values: ['us', ''],
    labels: ['United States'],
    indexes: [0, -1, 2.5, 3],
  });

  assert.equal(action.target.elementRef, 'el_1');
  assert.deepEqual(action.values, ['us']);
  assert.deepEqual(action.labels, ['United States']);
  assert.deepEqual(action.indexes, [0, 3]);
});

test('normalizeSelectAction defaults non-array selectors', () => {
  const action = normalizeSelectAction({
    values: 'us',
    labels: 'United States',
    indexes: '0',
  } as unknown as Parameters<typeof normalizeSelectAction>[0]);

  assert.deepEqual(action.values, []);
  assert.deepEqual(action.labels, []);
  assert.deepEqual(action.indexes, []);
});

/** Ensure viewport actions clamp to the supported behavior set. */
test('normalizeViewportAction preserves scroll behavior', () => {
  const action = normalizeViewportAction({
    top: 120,
    left: -45,
    behavior: 'smooth',
    relative: true,
  });

  assert.equal(action.top, 120);
  assert.equal(action.left, -45);
  assert.equal(action.behavior, 'smooth');
  assert.equal(action.relative, true);
});

/** Ensure navigation actions stay bounded and wait by default. */
test('normalizeNavigationAction keeps navigation actions bounded', () => {
  const action = normalizeNavigationAction({
    url: ' https://example.com/path ',
    timeoutMs: 999999,
  });

  assert.equal(action.url, 'https://example.com/path');
  assert.equal(action.waitForLoad, true);
  assert.equal(action.timeoutMs, 120000);
});

// ── New normalization function tests ────────────────────────────────

/** Ensure evaluate params clamp timeout and default awaitPromise. */
test('normalizeEvaluateParams clamps timeout and defaults', () => {
  const params = normalizeEvaluateParams({
    expression: 'document.title',
    timeoutMs: 999999,
  });

  assert.equal(params.expression, 'document.title');
  assert.equal(params.awaitPromise, false);
  assert.equal(params.timeoutMs, 30000);
  assert.equal(params.returnByValue, true);
});

test('normalizeEvaluateParams handles empty input', () => {
  const params = normalizeEvaluateParams({});
  assert.equal(params.expression, '');
  assert.equal(params.timeoutMs, 5000);
});

test('normalizeEvaluateParams rejects unsupported remote-object results', () => {
  assert.throws(
    () => normalizeEvaluateParams({ expression: 'window', returnByValue: false }),
    (error: ErrorWithCode) =>
      error.code === ERROR_CODES.INVALID_REQUEST && /returnByValue=false/.test(error.message)
  );
});

/** Ensure console params validate level and clamp limit. */
test('normalizeConsoleParams validates level and clamps limit', () => {
  const params = normalizeConsoleParams({
    level: 'error',
    clear: true,
    limit: 500,
  });

  assert.equal(params.level, 'error');
  assert.equal(params.clear, true);
  assert.equal(params.limit, 200);
});

test('normalizeConsoleParams rejects invalid level', () => {
  const params = normalizeConsoleParams({ level: 'bogus' });
  assert.equal(params.level, 'all');
});

/** Ensure wait-for params validate state and clamp timeout. */
test('normalizeWaitForParams validates state and clamps timeout', () => {
  const params = normalizeWaitForParams({
    selector: '.modal',
    text: 'Welcome',
    state: 'visible',
    timeoutMs: 50000,
  });

  assert.equal(params.selector, '.modal');
  assert.equal(params.text, 'Welcome');
  assert.equal(params.state, 'visible');
  assert.equal(params.timeoutMs, 30000);
});

test('normalizeWaitForParams defaults state to attached', () => {
  const params = normalizeWaitForParams({
    selector: 'div',
    state: 'bogus',
  } as unknown as WaitForParams);
  assert.equal(params.state, 'attached');
});

test('normalizeWaitForParams supports text-only waits and rejects empty conditions', () => {
  assert.deepEqual(normalizeWaitForParams({ text: 'Saved' }), {
    selector: '*',
    text: 'Saved',
    state: 'attached',
    timeoutMs: 5000,
  });
  assert.throws(
    () => normalizeWaitForParams({}),
    (error: ErrorWithCode) =>
      error.code === ERROR_CODES.INVALID_REQUEST && /selector or text/.test(error.message)
  );
});

/** Ensure find-by-text params default scope and clamp maxResults. */
test('normalizeFindByTextParams defaults scope and clamps maxResults', () => {
  const params = normalizeFindByTextParams({
    text: 'Submit',
    maxResults: 100,
  });

  assert.equal(params.text, 'Submit');
  assert.equal(params.exact, false);
  assert.equal(params.selector, '*');
  assert.equal(params.maxResults, 50);
});

/** Ensure find-by-role params normalize role and name. */
test('normalizeFindByRoleParams normalizes role and name', () => {
  const params = normalizeFindByRoleParams({
    role: 'button',
    name: 'Save',
  });

  assert.equal(params.role, 'button');
  assert.equal(params.name, 'Save');
  assert.equal(params.selector, '*');
  assert.equal(params.maxResults, 10);
});

/** Ensure getHtml params clamp maxLength. */
test('normalizeGetHtmlParams clamps maxLength', () => {
  const params = normalizeGetHtmlParams({
    elementRef: 'el_abc',
    outer: true,
    maxLength: 100000,
  });

  assert.equal(params.elementRef, 'el_abc');
  assert.equal(params.outer, true);
  assert.equal(params.maxLength, 50000);
});

test('normalizeGetHtmlParams defaults sensibly', () => {
  const params = normalizeGetHtmlParams({});
  assert.equal(params.outer, false);
  assert.equal(params.maxLength, 2000);
});

/** Ensure hover params normalize target and clamp duration. */
test('normalizeHoverParams clamps duration', () => {
  const params = normalizeHoverParams({
    target: { elementRef: 'el_abc' },
    duration: 99999,
    modifiers: ['Shift', '', 'Alt'],
  });

  assert.equal(params.target.elementRef, 'el_abc');
  assert.equal(params.duration, 5000);
  assert.deepEqual(params.modifiers, ['Shift', 'Alt']);
});

test('normalizeHoverParams defaults duration to 0', () => {
  const params = normalizeHoverParams({ target: { selector: '.btn' } });
  assert.equal(params.duration, 0);
  assert.equal(params.target.selector, '.btn');
  assert.deepEqual(params.modifiers, []);
});

/** Ensure drag params normalize source, destination, and offsets. */
test('normalizeDragParams normalizes source and destination targets', () => {
  const params = normalizeDragParams({
    source: { elementRef: 'el_src' },
    destination: { elementRef: 'el_dst' },
    offsetX: 10,
    offsetY: 20,
  });

  assert.equal(params.source.elementRef, 'el_src');
  assert.equal(params.destination.elementRef, 'el_dst');
  assert.equal(params.offsetX, 10);
  assert.equal(params.offsetY, 20);
});

test('normalizeDragParams defaults offsets to zero', () => {
  const params = normalizeDragParams({});
  assert.equal(params.offsetX, 0);
  assert.equal(params.offsetY, 0);
});

/** Ensure storage params validate type and filter keys. */
test('normalizeStorageParams validates type and filters keys', () => {
  const params = normalizeStorageParams({
    type: 'session',
    keys: ['token', 42, 'user'],
  } as unknown as Parameters<typeof normalizeStorageParams>[0]);

  assert.equal(params.type, 'session');
  assert.deepEqual(params.keys, ['token', 'user']);
});

test('normalizeStorageParams defaults to local with null keys', () => {
  const params = normalizeStorageParams({});
  assert.equal(params.type, 'local');
  assert.equal(params.keys, null);
});

test('normalizeStorageParams rejects explicit key lists above the documented bound', () => {
  assert.throws(
    () =>
      normalizeStorageParams({ keys: Array.from({ length: 101 }, (_, index) => `key-${index}`) }),
    (error: ErrorWithCode) => error.code === ERROR_CODES.INVALID_REQUEST
  );
});

test('normalizeSensitiveReadParams preserves exact keys and rejects unsupported sources', () => {
  assert.deepEqual(normalizeSensitiveReadParams({ source: 'local_storage', key: '' }), {
    source: 'local_storage',
    key: '',
    maxBytes: MAX_SENSITIVE_VALUE_BYTES,
  });
  assert.deepEqual(
    normalizeSensitiveReadParams({ source: 'session_storage', key: ' multiline\nkey ' }),
    {
      source: 'session_storage',
      key: ' multiline\nkey ',
      maxBytes: MAX_SENSITIVE_VALUE_BYTES,
    }
  );
  assert.throws(
    () => normalizeSensitiveReadParams({ source: 'network', key: 'x' }),
    (error: ErrorWithCode) => error.code === ERROR_CODES.INVALID_REQUEST
  );
  assert.throws(
    () => normalizeSensitiveReadParams({ source: 'local_storage', key: 1 }),
    (error: ErrorWithCode) => error.code === ERROR_CODES.INVALID_REQUEST
  );
});

test('sensitive read errors are explicitly non-retryable', () => {
  assert.equal(getErrorRecovery(ERROR_CODES.RESULT_TOO_LARGE)?.retry, false);
  assert.equal(getErrorRecovery(ERROR_CODES.SENSITIVE_TARGET_NOT_FOUND)?.retry, false);
});

test('sensitive-read failures override retryable transport errors', () => {
  const response = createFailure('sensitive-timeout', ERROR_CODES.TIMEOUT, 'Timed out.', null, {
    method: 'sensitive.read',
  });
  assert.equal(response.error.recovery?.retry, false);
  assert.equal(response.error.recovery?.retryAfterMs, undefined);
  assert.match(response.error.recovery?.hint ?? '', /never retried automatically/);
});

test('batch safety follows canonical read-only method and parameter policy', () => {
  assert.equal(isBatchSafeBridgeCall('page.get_state'), true);
  assert.equal(isBatchSafeBridgeCall('input.click'), false);
  assert.equal(isBatchSafeBridgeCall('sensitive.read'), false);
  assert.equal(isBatchSafeBridgeCall('page.get_console', { clear: false }), true);
  assert.equal(isBatchSafeBridgeCall('page.get_console', { clear: true }), false);
  assert.equal(isBatchSafeBridgeCall('page.get_console', { clear: 1 }), false);
  assert.equal(isBatchSafeBridgeCall('page.get_console', { clear: 'false' }), false);
  assert.equal(isBatchSafeBridgeCall('page.get_network', { source: 'cdp', capture: 'read' }), true);
  assert.equal(
    isBatchSafeBridgeCall('page.get_network', { source: 'cdp', capture: 'clear' }),
    false
  );
});

/** Ensure wait-for-load-state params clamp timeout. */
test('normalizeWaitForLoadStateParams clamps timeout', () => {
  const params = normalizeWaitForLoadStateParams({
    timeoutMs: 999999,
  });

  assert.equal(params.waitForLoad, true);
  assert.equal(params.timeoutMs, 120000);
});

test('normalizeWaitForLoadStateParams defaults sensibly', () => {
  const params = normalizeWaitForLoadStateParams({});
  assert.equal(params.timeoutMs, 15000);
  assert.equal(params.waitForLoad, true);
});

// ── New method normalizer tests ─────────────────────────────────────

/** Ensure tab create params default to about:blank and active. */
test('normalizeTabCreateParams defaults to about:blank and active', () => {
  const params = normalizeTabCreateParams({});
  assert.equal(params.url, 'about:blank');
  assert.equal(params.active, true);
});

test('normalizeTabCreateParams preserves URL', () => {
  const params = normalizeTabCreateParams({
    url: 'https://example.com',
    active: false,
  });
  assert.equal(params.url, 'https://example.com');
  assert.equal(params.active, false);
});

test('normalizeTabCreateParams rejects javascript URLs', () => {
  assert.throws(
    () => normalizeTabCreateParams({ url: 'javascript:alert(1)' }),
    (error) => {
      assert.equal(error instanceof Error, true);
      const bridgeError = error as ErrorWithCode;
      assert.equal(bridgeError.code, ERROR_CODES.INVALID_REQUEST);
      assert.match(bridgeError.message, /unsupported protocol "javascript:"/);
      return true;
    }
  );
});

test('normalizeTabCreateParams rejects invalid URLs that do not parse', () => {
  assert.throws(
    () => normalizeTabCreateParams({ url: 'not a url' }),
    (error) => {
      assert.equal(error instanceof Error, true);
      const bridgeError = error as ErrorWithCode;
      assert.equal(bridgeError.code, ERROR_CODES.INVALID_REQUEST);
      assert.match(bridgeError.message, /Invalid tab create URL: not a url/);
      return true;
    }
  );
});

/** Ensure tab close params require a valid tabId. */
test('normalizeTabCloseParams requires valid tabId', () => {
  assert.throws(() => normalizeTabCloseParams({}), /tabId is required/);
  for (const tabId of [-1, 0, 'abc', Number.NaN, null] as Array<number | string | null>) {
    assert.throws(
      () => normalizeTabCloseParams({ tabId } as unknown as TabCloseParams),
      /tabId is required/
    );
  }
});

test('normalizeTabCloseParams accepts valid tabId', () => {
  const params = normalizeTabCloseParams({ tabId: 42 });
  assert.equal(params.tabId, 42);
});

test('normalizeAccessRequestParams validates the bounded intent enum', () => {
  assert.deepEqual(normalizeAccessRequestParams({}), { intent: 'general' });
  assert.deepEqual(normalizeAccessRequestParams({ intent: 'capture' }), { intent: 'capture' });
  assert.throws(
    () => normalizeAccessRequestParams({ intent: 'capture this exact secret' as never }),
    /intent must be one of/
  );
});

/** Ensure accessibility tree params clamp depth and node count. */
test('normalizeAccessibilityTreeParams clamps depth and nodes', () => {
  const params = normalizeAccessibilityTreeParams({
    maxDepth: 100,
    maxNodes: 99999,
  });
  assert.equal(params.maxDepth, 20);
  assert.equal(params.maxNodes, 5000);
  assert.equal(params.selector, null);
  assert.equal(params.compact, false);
  assert.equal(params.interactiveOnly, false);
});

test('normalizeAccessibilityTreeParams defaults sensibly', () => {
  const params = normalizeAccessibilityTreeParams({});
  assert.equal(params.maxDepth, 6);
  assert.equal(params.maxNodes, 500);
  assert.equal(params.selector, null);
  assert.equal(params.compact, false);
  assert.equal(params.interactiveOnly, false);
});

test('normalizeScreenshotParams validates formats and bounds lossy quality', () => {
  assert.deepEqual(normalizeScreenshotParams(), {
    format: 'png',
    quality: null,
    delivery: 'inline',
    scale: 1,
  });
  assert.deepEqual(normalizeScreenshotParams({ format: 'jpeg', quality: 120 }), {
    format: 'jpeg',
    quality: 100,
    delivery: 'inline',
    scale: 1,
  });
  assert.deepEqual(normalizeScreenshotParams({ format: 'webp', quality: 0 }), {
    format: 'webp',
    quality: 0,
    delivery: 'inline',
    scale: 1,
  });
  assert.deepEqual(normalizeScreenshotParams({ format: 'png', quality: 20 }), {
    format: 'png',
    quality: null,
    delivery: 'inline',
    scale: 1,
  });
  assert.deepEqual(
    normalizeScreenshotParams({ delivery: 'artifact', scale: '2' as unknown as number }),
    {
      format: 'png',
      quality: null,
      delivery: 'artifact',
      scale: 2,
    }
  );
  assert.throws(
    () => normalizeScreenshotParams({ delivery: 'remote' as 'artifact' }),
    /auto, inline, or artifact/
  );
  assert.throws(() => normalizeScreenshotParams({ format: 'gif' as 'png' }), /png, jpeg, or webp/);
});

test('artifact params enforce opaque handles and bounded reads', () => {
  const artifactId = `art_${'a'.repeat(43)}`;
  assert.deepEqual(normalizeArtifactReadParams({ artifactId, offset: 10, maxBytes: 999_999 }), {
    artifactId,
    offset: 10,
    maxBytes: 196_608,
  });
  assert.deepEqual(normalizeArtifactDeleteParams({ artifactId }), { artifactId });
  assert.throws(
    () => normalizeArtifactReadParams({ artifactId: '../../private', offset: 0 }),
    /artifactId is invalid/
  );
});

/** Ensure network params validate and clamp. */
test('normalizeNetworkParams clamps limit and handles urlPattern', () => {
  const params = normalizeNetworkParams({
    limit: 9999,
    urlPattern: '/api/',
    clear: true,
  });
  assert.equal(params.limit, 500);
  assert.equal(params.urlPattern, '/api/');
  assert.equal(params.clear, true);
  assert.equal(params.source, 'fetch-xhr');
  assert.equal(params.capture, 'read');
});

test('normalizeNetworkParams defaults sensibly', () => {
  const params = normalizeNetworkParams({});
  assert.equal(params.limit, 50);
  assert.equal(params.urlPattern, null);
  assert.equal(params.clear, false);
  assert.equal(params.source, 'fetch-xhr');
  assert.equal(params.capture, 'read');
});

test('accessibility and CDP network options normalize strictly', () => {
  assert.deepEqual(normalizeAccessibilityTreeParams({ compact: true, interactiveOnly: true }), {
    selector: null,
    maxDepth: 6,
    maxNodes: 500,
    compact: true,
    interactiveOnly: true,
  });
  assert.equal(normalizeAccessibilityTreeParams({ selector: ' main ' }).selector, 'main');
  assert.deepEqual(normalizeNetworkParams({ source: 'cdp', capture: 'start' }), {
    clear: false,
    limit: 50,
    urlPattern: null,
    source: 'cdp',
    capture: 'start',
  });
  assert.throws(
    () => normalizeNetworkParams({ source: 'fetch-xhr', capture: 'stop' }),
    /only valid with source/
  );
  assert.throws(() => normalizeNetworkParams({ source: 'invalid' } as never), /source must be/);
});

test('normalizeNetworkInterceptAddParams safely defaults omitted action to continue', () => {
  const params = normalizeNetworkInterceptAddParams({ urlPattern: '*api*' });

  assert.deepEqual(params, {
    urlPattern: '*api*',
    action: 'continue',
  });
  assert.equal(
    createRequest({
      id: 'req-intercept-default',
      method: 'network.intercept.add',
      params: { urlPattern: '*api*' },
    }).params.action,
    'continue'
  );
});

test('normalizeNetworkInterceptAddParams rejects invalid actions', () => {
  assert.throws(
    () =>
      normalizeNetworkInterceptAddParams({
        urlPattern: '*',
        action: 'redirect',
      } as unknown as Parameters<typeof normalizeNetworkInterceptAddParams>[0]),
    (error: ErrorWithCode) =>
      error.code === ERROR_CODES.INVALID_REQUEST && /action must be one of/.test(error.message)
  );
});

/** Ensure page text params clamp budget. */
test('normalizePageTextParams clamps budget', () => {
  const params = normalizePageTextParams({ textBudget: 999999 });
  assert.equal(params.textBudget, 100000);
});

test('normalizePageTextParams defaults to 8000', () => {
  const params = normalizePageTextParams({});
  assert.equal(params.textBudget, 8000);
});

test('normalizeExtractContentParams applies bounded semantic extraction defaults', () => {
  assert.deepEqual(normalizeExtractContentParams({}), {
    format: 'text',
    selector: null,
    includeMetadata: true,
    consistency: 'best_effort',
    textBudget: 8000,
    settleTimeoutMs: 2000,
  });
  assert.deepEqual(
    normalizeExtractContentParams({
      format: 'markdown',
      selector: ' main ',
      includeMetadata: false,
      consistency: 'settled',
      textBudget: 999_999,
      settleTimeoutMs: 99_999,
    }),
    {
      format: 'markdown',
      selector: 'main',
      includeMetadata: false,
      consistency: 'settled',
      textBudget: 100_000,
      settleTimeoutMs: 10_000,
    }
  );
  assert.throws(() => normalizeExtractContentParams({ format: 'html' as never }), /format/);
  assert.throws(
    () => normalizeExtractContentParams({ consistency: 'frozen' as never }),
    /consistency/
  );
});

test('normalizeLogTailParams clamps limit', () => {
  const params = normalizeLogTailParams({ limit: 9999 });
  assert.equal(params.limit, 200);
});

test('integer normalizers truncate fractional values', () => {
  assert.equal(normalizeLogTailParams({ limit: 5.9 }).limit, 5);
  assert.equal(normalizeViewportResizeParams({ width: 1000.8, height: 700.2 }).width, 1000);
  assert.equal(normalizeViewportResizeParams({ width: 1000.8, height: 700.2 }).height, 700);
});

test('validateBridgeRequest normalizes log.tail params', () => {
  const request = validateBridgeRequest({
    id: 'req_logs',
    method: 'log.tail',
    params: { limit: 5 },
  });
  assert.equal(request.params.limit, 5);
});

/** Ensure viewport resize params clamp dimensions. */
test('normalizeViewportResizeParams clamps dimensions', () => {
  const params = normalizeViewportResizeParams({
    width: 99999,
    height: 99999,
    deviceScaleFactor: 10,
    reset: true,
  });
  assert.equal(params.width, 7680);
  assert.equal(params.height, 4320);
  assert.equal(params.deviceScaleFactor, 4);
  assert.equal(params.reset, true);
});

test('normalizeViewportResizeParams preserves finite fractional device scale factors', () => {
  assert.equal(
    normalizeViewportResizeParams({ deviceScaleFactor: 2.625 }).deviceScaleFactor,
    2.625
  );
  assert.equal(normalizeViewportResizeParams({ deviceScaleFactor: -0.5 }).deviceScaleFactor, 0);
  assert.equal(normalizeViewportResizeParams({ deviceScaleFactor: 4.5 }).deviceScaleFactor, 4);
  assert.equal(
    normalizeViewportResizeParams({ deviceScaleFactor: Number.NaN }).deviceScaleFactor,
    DEFAULT_DEVICE_SCALE_FACTOR
  );
});

test('normalizeViewportResizeParams defaults to 1280x720', () => {
  const params = normalizeViewportResizeParams({});
  assert.equal(params.width, 1280);
  assert.equal(params.height, 720);
  assert.equal(params.deviceScaleFactor, 0);
  assert.equal(params.reset, false);
});

/** Ensure runtime context includes new method groups. */
test('runtime context includes new method groups', () => {
  const context = createRuntimeContext();
  assert.ok(context.methods.tabs.includes('tabs.create'));
  assert.ok(context.methods.tabs.includes('tabs.close'));
  assert.ok(context.methods.inspect.includes('dom.get_accessibility_tree'));
  assert.ok(context.methods.page.includes('page.get_text'));
  assert.ok(context.methods.page.includes('page.get_network'));
  assert.ok(context.methods.navigate.includes('viewport.resize'));
  assert.ok(context.methods.performance.includes('performance.get_metrics'));
});

/** Ensure runtime context includes error code descriptions. */
test('runtime context includes error descriptions', () => {
  const context = createRuntimeContext();
  assert.ok(context.errors);
  assert.ok(context.errors.ACCESS_DENIED);
  assert.ok(context.errors.ELEMENT_STALE);
  assert.ok(context.errors.TIMEOUT);
  assert.ok(context.errors.INVALID_REQUEST);
});

test('runtime context excludes legacy capability descriptions and session methods', () => {
  const context = createRuntimeContext();
  assert.equal('capabilities' in context, false);
  assert.equal('session' in context.methods, false);
});

/** Ensure runtime context includes parameter limits. */
test('runtime context includes parameter limits', () => {
  const context = createRuntimeContext();
  assert.ok(context.limits);
  assert.ok(context.limits.maxNodes);
  assert.equal(context.limits.maxNodes.default, 25);
  assert.equal(context.limits.evalTimeout.max, 30000);
  assert.equal(context.limits.pageTextBudget.default, 8000);
});

test('runtime context budgets stay aligned with shared presets', () => {
  const context = createRuntimeContext();
  assert.deepEqual(context.budgets.quick, {
    n: BUDGET_PRESETS.quick.maxNodes,
    d: BUDGET_PRESETS.quick.maxDepth,
    t: BUDGET_PRESETS.quick.textBudget,
  });
  assert.deepEqual(context.budgets.normal, {
    n: BUDGET_PRESETS.normal.maxNodes,
    d: BUDGET_PRESETS.normal.maxDepth,
    t: BUDGET_PRESETS.normal.textBudget,
  });
});

test('dom.query registry excludes removed no-op params', () => {
  assert.deepEqual(BRIDGE_METHOD_REGISTRY['dom.query'].params, [
    'selector',
    'withinRef',
    'maxNodes',
    'maxDepth',
    'textBudget',
    'includeBbox',
    'attributeAllowlist',
  ]);
});

test('registry parameters and shared defaults align for reviewed protocol fields', () => {
  assert.equal(DEFAULT_NETWORK_INTERCEPT_ACTION, 'continue');
  assert.equal(normalizeNetworkInterceptAddParams({ urlPattern: '*' }).action, 'continue');
  assert.ok(BRIDGE_METHOD_REGISTRY['network.intercept.add'].params.includes('action'));

  assert.equal(normalizeEvaluateParams({}).timeoutMs, DEFAULT_EVAL_TIMEOUT_MS);
  assert.ok(BRIDGE_METHOD_REGISTRY['page.evaluate'].params.includes('returnByValue'));

  assert.equal(normalizeWaitForLoadStateParams({}).timeoutMs, DEFAULT_NAV_TIMEOUT_MS);
  assert.ok(BRIDGE_METHOD_REGISTRY['page.wait_for_load_state'].params.includes('timeoutMs'));

  assert.equal(normalizeViewportResizeParams({}).deviceScaleFactor, DEFAULT_DEVICE_SCALE_FACTOR);
  assert.ok(BRIDGE_METHOD_REGISTRY['viewport.resize'].params.includes('deviceScaleFactor'));
});

test('dialog params keep the pre-dispatch observation check optional and bounded', () => {
  assert.deepEqual(normalizeHandleDialogParams({}), {
    action: 'inspect',
    promptText: null,
    expectedDialogId: null,
  });
  assert.deepEqual(
    normalizeHandleDialogParams({
      action: 'accept',
      promptText: '',
      expectedDialogId: 'dialog-1',
    }),
    {
      action: 'accept',
      promptText: '',
      expectedDialogId: 'dialog-1',
    }
  );
  assert.deepEqual(normalizeHandleDialogParams({ action: 'accept' }), {
    action: 'accept',
    promptText: null,
    expectedDialogId: null,
  });
  assert.throws(() => normalizeHandleDialogParams({ action: 'dismiss', expectedDialogId: '' }));
  assert.throws(() =>
    normalizeHandleDialogParams({ action: 'dismiss', expectedDialogId: 'x'.repeat(129) })
  );
  assert.throws(() =>
    normalizeHandleDialogParams({ action: 'inspect', expectedDialogId: 'dialog-1' })
  );
  assert.throws(() => normalizeHandleDialogParams({ action: 'dismiss', promptText: 'secret' }));
  assert.throws(() =>
    normalizeHandleDialogParams({
      action: 'accept',
      promptText: 'x'.repeat(10_001),
      expectedDialogId: 'dialog-1',
    })
  );
  assert.equal(getErrorRecovery(ERROR_CODES.DIALOG_NOT_OPEN)?.retry, false);
  assert.equal(getErrorRecovery(ERROR_CODES.DIALOG_ACTION_CONFLICT)?.retry, false);
  assert.equal(BRIDGE_METHOD_REGISTRY['page.handle_dialog'].debuggerBacked, true);
  assert.ok(BRIDGE_METHOD_REGISTRY['page.handle_dialog'].params.includes('expectedDialogId'));
});

test('load-state URL conditions normalize exact, contains, and safe bounded regex modes', () => {
  assert.deepEqual(normalizeWaitForLoadStateParams({ url: 'https://example.com' }), {
    waitForLoad: true,
    timeoutMs: DEFAULT_NAV_TIMEOUT_MS,
    url: 'https://example.com',
    urlMatch: 'exact',
  });
  assert.equal(
    normalizeWaitForLoadStateParams({ url: '/items/', urlMatch: 'contains' }).urlMatch,
    'contains'
  );
  assert.equal(
    normalizeWaitForLoadStateParams({ url: '^https://[^/][^/]/items/[0-9]$', urlMatch: 'regex' })
      .urlMatch,
    'regex'
  );
  assert.throws(() => normalizeWaitForLoadStateParams({ urlMatch: 'exact' }));
  assert.throws(() => normalizeWaitForLoadStateParams({ url: '(a+)+$', urlMatch: 'regex' }));
  for (const hostile of ['a+a+$', 'a*a*$', 'a{1,100}$', 'a?|aa', '(a|aa)+$', '.*.*x']) {
    assert.throws(() => normalizeWaitForLoadStateParams({ url: hostile, urlMatch: 'regex' }));
  }
  assert.equal(
    normalizeWaitForLoadStateParams({
      url: String.raw`^https://example\.com/price\+$`,
      urlMatch: 'regex',
    }).urlMatch,
    'regex'
  );
  assert.throws(() => normalizeWaitForLoadStateParams({ url: '[', urlMatch: 'regex' }));
});

/** Ensure runtime context flow includes page.get_console. */
test('runtime context flow includes console check', () => {
  const context = createRuntimeContext();
  assert.ok(context.flow.includes('page.get_console'));
});

/** Ensure navigation URL validation rejects unsafe protocols. */
test('normalizeNavigationAction rejects unsafe protocols', () => {
  assert.throws(
    () => normalizeNavigationAction({ url: 'javascript:alert(1)' }),
    /unsupported protocol/
  );
  assert.throws(
    () => normalizeNavigationAction({ url: 'file:///etc/passwd' }),
    /unsupported protocol/
  );
  assert.throws(
    () => normalizeNavigationAction({ url: 'data:text/html,<h1>XSS</h1>' }),
    /unsupported protocol/
  );
  assert.throws(
    () => normalizeNavigationAction({ url: 'chrome://settings' }),
    /unsupported protocol/
  );
});

/** Ensure navigation URL validation allows safe protocols. */
test('normalizeNavigationAction allows http/https/about', () => {
  const http = normalizeNavigationAction({ url: 'http://example.com' });
  assert.equal(http.url, 'http://example.com');

  const https = normalizeNavigationAction({ url: 'https://example.com' });
  assert.equal(https.url, 'https://example.com');

  const about = normalizeNavigationAction({ url: 'about:blank' });
  assert.equal(about.url, 'about:blank');
});

/** Ensure style query requires elementRef. */
test('normalizeStyleQuery requires elementRef', () => {
  assert.throws(() => normalizeStyleQuery({}), /elementRef or target is required/);
  assert.throws(() => normalizeStyleQuery({ elementRef: '' }), /elementRef or target is required/);
});

test('normalizeStyleQuery keeps target alias for element-level reads', () => {
  const query = normalizeStyleQuery({
    target: { selector: '.hero-title' },
    properties: ['display', 'color'],
  });

  assert.equal(query.elementRef, '');
  assert.equal(query.target.selector, '.hero-title');
  assert.deepEqual(query.properties, ['display', 'color']);
});

test('normalizeGetHtmlParams keeps target alias for element-level reads', () => {
  const params = normalizeGetHtmlParams({
    target: { elementRef: 'el_html' },
    maxLength: 4000,
  });

  assert.equal(params.elementRef, 'el_html');
  assert.equal(params.target.elementRef, 'el_html');
  assert.equal(params.maxLength, 4000);
});

/** Ensure evaluate params enforce expression length limits exactly. */
test('normalizeEvaluateParams enforces expression length boundary', () => {
  const withinLimit = normalizeEvaluateParams({ expression: 'x'.repeat(100_000) });
  assert.equal(withinLimit.expression.length, 100_000);

  assert.throws(
    () => normalizeEvaluateParams({ expression: 'x'.repeat(100_001) }),
    /Expression too large/
  );
});

test('validateBridgeRequest rejects malformed request input', () => {
  const cases = [
    {
      name: 'missing id',
      request: { method: 'health.ping' },
      message: /Request id must be a non-empty string\./,
    },
    {
      name: 'blank id',
      request: { id: '   ', method: 'health.ping' },
      message: /Request id must be a non-empty string\./,
    },
    {
      name: 'non-string method',
      request: { id: 'req_1', method: 42 },
      message: /Unsupported method: 42/,
    },
    {
      name: 'non-object meta',
      request: { id: 'req_3', method: 'health.ping', meta: 'cli' },
      message: /Request meta must be an object\./,
    },
    {
      name: 'array meta',
      request: { id: 'req_3b', method: 'health.ping', meta: [] },
      message: /Request meta must be an object\./,
    },
    {
      name: 'primitive params',
      request: { id: 'req_3c', method: 'health.ping', params: 'bad' },
      message: /Request params must be an object\./,
    },
    {
      name: 'array params',
      request: { id: 'req_4', method: 'dom.query', params: [] },
      message: /Request params must be an object\./,
    },
  ];

  for (const testCase of cases) {
    assert.throws(
      () => validateBridgeRequest(testCase.request as unknown as BridgeRequest),
      (error) => {
        assert.equal(error instanceof Error, true);
        const bridgeError = error as ErrorWithCode;
        assert.equal(bridgeError.code, ERROR_CODES.INVALID_REQUEST);
        assert.match(bridgeError.message, testCase.message);
        return true;
      },
      testCase.name
    );
  }
});

test('validateBridgeRequest rejects legacy session_id routing', () => {
  assert.throws(
    () =>
      validateBridgeRequest({
        id: 'req_legacy_session',
        method: 'dom.query',
        session_id: 'session_1',
      } as unknown as BridgeRequest),
    (error) => {
      assert.equal(error instanceof Error, true);
      const bridgeError = error as ErrorWithCode;
      assert.equal(bridgeError.code, ERROR_CODES.INVALID_REQUEST);
      assert.match(bridgeError.message, /session_id is no longer supported/);
      return true;
    }
  );
});

test('validateBridgeRequest rejects unknown method and names it in the error', () => {
  assert.throws(
    () => validateBridgeRequest({ id: 'req_2', method: 'unknown.method' }),
    (error) => {
      assert.equal(error instanceof Error, true);
      const bridgeError = error as ErrorWithCode;
      assert.equal(bridgeError.code, ERROR_CODES.INVALID_REQUEST);
      assert.equal(bridgeError.message, 'Unsupported method: unknown.method');
      return true;
    }
  );
});

test('validateBridgeRequest bubbles method param normalization errors unchanged', () => {
  assert.throws(
    () =>
      validateBridgeRequest({
        id: 'req_4',
        method: 'tabs.close',
        params: { tabId: 0 },
      }),
    (error) => {
      assert.equal(error instanceof Error, true);
      const bridgeError = error as ErrorWithCode;
      assert.equal(bridgeError.code, ERROR_CODES.INVALID_REQUEST);
      assert.equal(bridgeError.message, 'tabId is required for tabs.close.');
      return true;
    }
  );
});

test('validateBridgeRequest rejects invalid cdp.dispatch_key_event params', () => {
  const testCases = [
    {
      request: {
        id: 'req_cdp_1',
        method: 'cdp.dispatch_key_event',
        params: { key: '' },
      },
      message: 'key must be a non-empty string.',
    },
    {
      request: {
        id: 'req_cdp_2',
        method: 'cdp.dispatch_key_event',
        params: { key: 'Escape', modifiers: ['Shift', 'Ctrl'] },
      },
      message: 'modifiers must contain only Alt, Control, Meta, or Shift.',
    },
    {
      request: {
        id: 'req_cdp_3',
        method: 'cdp.dispatch_key_event',
        params: { key: 'Escape', modifiers: 99 },
      },
      message: 'modifiers must be an array of Alt, Control, Meta, Shift or a bitmask 0-15.',
    },
  ];

  for (const testCase of testCases) {
    assert.throws(
      () => validateBridgeRequest(testCase.request as unknown as BridgeRequest),
      (error) => {
        assert.equal(error instanceof Error, true);
        const bridgeError = error as ErrorWithCode;
        assert.equal(bridgeError.code, ERROR_CODES.INVALID_REQUEST);
        assert.equal(bridgeError.message, testCase.message);
        return true;
      }
    );
  }
});

test('validateBridgeRequest rejects invalid CDP node id params', () => {
  for (const method of ['cdp.get_box_model', 'cdp.get_computed_styles_for_node'] as const) {
    assert.throws(
      () =>
        validateBridgeRequest({
          id: `req_${method}`,
          method,
          params: {},
        }),
      (error) => {
        assert.equal(error instanceof Error, true);
        const bridgeError = error as ErrorWithCode;
        assert.equal(bridgeError.code, ERROR_CODES.INVALID_REQUEST);
        assert.equal(bridgeError.message, 'nodeId must be a finite number.');
        return true;
      }
    );
  }
});
