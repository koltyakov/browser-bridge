// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUDGET_PRESETS,
  BRIDGE_METHODS,
  BRIDGE_METHOD_REGISTRY,
  ERROR_CODES,
  applyBudget,
  bridgeMethodNeedsTab,
  createFailure,
  createBridgeMethodGroups,
  createRequest,
  createRuntimeContext,
  normalizeCheckedAction,
  createSuccess,
  normalizeInputAction,
  normalizeNavigationAction,
  normalizePatchOperation,
  normalizeSelectAction,
  normalizeViewportAction,
  truncateText,
  normalizeEvaluateParams,
  normalizeConsoleParams,
  normalizeWaitForParams,
  normalizeFindByTextParams,
  normalizeFindByRoleParams,
  normalizeGetHtmlParams,
  normalizeHoverParams,
  normalizeDragParams,
  normalizeStorageParams,
  normalizeWaitForLoadStateParams,
  normalizeTabCreateParams,
  normalizeTabCloseParams,
  normalizeAccessibilityTreeParams,
  normalizeNetworkParams,
  normalizePageTextParams,
  normalizeViewportResizeParams,
  normalizeStyleQuery
} from '../src/index.js';

/** Ensure budgeting normalizes user-provided limits safely. */
test('applyBudget clamps and normalizes fields', () => {
  const budget = applyBudget({
    maxNodes: 999,
    maxDepth: -1,
    textBudget: 4,
    attributeAllowlist: ['id', 'id', '', 'data-test']
  });

  assert.equal(budget.maxNodes, 250);
  assert.equal(budget.maxDepth, 1);
  assert.equal(budget.textBudget, 32);
  assert.deepEqual(budget.attributeAllowlist, ['id', 'data-test']);
});

/** Ensure protocol metadata is always attached to outgoing requests. */
test('createRequest adds protocol metadata', () => {
  const request = createRequest({
    id: 'req_1',
    method: 'health.ping'
  });

  assert.equal(request.meta.protocol_version, '1.0');
});

test('createRequest includes explicit tab_id when provided', () => {
  const request = createRequest({
    id: 'req_2',
    method: 'dom.query',
    tabId: 5,
  });

  assert.equal(request.tab_id, 5);
});

/** Ensure success and failure responses keep the shared envelope shape. */
test('createSuccess and createFailure shape bridge responses', () => {
  const success = createSuccess('req_2', { ok: true }, { revision: 'rev_1' });
  const failure = createFailure('req_3', ERROR_CODES.ACCESS_DENIED, 'Denied');

  assert.equal(success.ok, true);
  assert.equal(success.meta.revision, 'rev_1');
  assert.equal(failure.error.code, ERROR_CODES.ACCESS_DENIED);
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
  assert.equal(context.v, '1.0');
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

/** Ensure DOM patch metadata is preserved by normalization. */
test('normalizePatchOperation preserves DOM patch metadata', () => {
  const patch = normalizePatchOperation({
    operation: 'set_attribute',
    name: 'aria-hidden',
    value: 'true'
  });

  assert.equal(patch.name, 'aria-hidden');
  assert.equal(patch.value, 'true');
});

/** Ensure input actions normalize button and modifier defaults safely. */
test('normalizeInputAction preserves interactive intent', () => {
  const input = normalizeInputAction({
    target: { selector: 'button.primary' },
    button: 'right',
    clickCount: 9,
    key: 'Enter',
    modifiers: ['Shift', '']
  });

  assert.equal(input.target.selector, 'button.primary');
  assert.equal(input.button, 'right');
  assert.equal(input.clickCount, 2);
  assert.equal(input.key, 'Enter');
  assert.deepEqual(input.modifiers, ['Shift']);
});

/** Ensure checked actions default to an affirmative toggle with a normalized target. */
test('normalizeCheckedAction defaults to checked=true', () => {
  const action = normalizeCheckedAction({
    target: { selector: 'input[type=checkbox]' }
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
    indexes: [0, -1, 2.5, 3]
  });

  assert.equal(action.target.elementRef, 'el_1');
  assert.deepEqual(action.values, ['us']);
  assert.deepEqual(action.labels, ['United States']);
  assert.deepEqual(action.indexes, [0, 3]);
});

/** Ensure viewport actions clamp to the supported behavior set. */
test('normalizeViewportAction preserves scroll behavior', () => {
  const action = normalizeViewportAction({
    top: 120,
    left: -45,
    behavior: 'smooth',
    relative: true
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
    timeoutMs: 999999
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
    timeoutMs: 999999
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

/** Ensure console params validate level and clamp limit. */
test('normalizeConsoleParams validates level and clamps limit', () => {
  const params = normalizeConsoleParams({
    level: 'error',
    clear: true,
    limit: 500
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
    timeoutMs: 50000
  });

  assert.equal(params.selector, '.modal');
  assert.equal(params.text, 'Welcome');
  assert.equal(params.state, 'visible');
  assert.equal(params.timeoutMs, 30000);
});

test('normalizeWaitForParams defaults state to attached', () => {
  const params = normalizeWaitForParams({ selector: 'div', state: /** @type {*} */ ('bogus') });
  assert.equal(params.state, 'attached');
});

/** Ensure find-by-text params default scope and clamp maxResults. */
test('normalizeFindByTextParams defaults scope and clamps maxResults', () => {
  const params = normalizeFindByTextParams({
    text: 'Submit',
    maxResults: 100
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
    name: 'Save'
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
    maxLength: 100000
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
    duration: 99999
  });

  assert.equal(params.target.elementRef, 'el_abc');
  assert.equal(params.duration, 5000);
});

test('normalizeHoverParams defaults duration to 0', () => {
  const params = normalizeHoverParams({ target: { selector: '.btn' } });
  assert.equal(params.duration, 0);
  assert.equal(params.target.selector, '.btn');
});

/** Ensure drag params normalize source, destination, and offsets. */
test('normalizeDragParams normalizes source and destination targets', () => {
  const params = normalizeDragParams({
    source: { elementRef: 'el_src' },
    destination: { elementRef: 'el_dst' },
    offsetX: 10,
    offsetY: 20
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
    keys: /** @type {*} */ (['token', 42, 'user'])
  });

  assert.equal(params.type, 'session');
  assert.deepEqual(params.keys, ['token', 'user']);
});

test('normalizeStorageParams defaults to local with null keys', () => {
  const params = normalizeStorageParams({});
  assert.equal(params.type, 'local');
  assert.equal(params.keys, null);
});

/** Ensure wait-for-load-state params clamp timeout. */
test('normalizeWaitForLoadStateParams clamps timeout', () => {
  const params = normalizeWaitForLoadStateParams({
    timeoutMs: 999999
  });

  assert.equal(params.waitForLoad, true);
  assert.equal(params.timeoutMs, 120000);
});

test('normalizeWaitForLoadStateParams defaults sensibly', () => {
  const params = normalizeWaitForLoadStateParams({});
  assert.equal(params.timeoutMs, 15000);
  assert.equal(params.waitForLoad, true);
});

/** Ensure TIMEOUT error code exists. */
test('ERROR_CODES includes TIMEOUT', () => {
  assert.equal(ERROR_CODES.TIMEOUT, 'TIMEOUT');
});

// ── New method normalizer tests ─────────────────────────────────────

/** Ensure tab create params default to about:blank and active. */
test('normalizeTabCreateParams defaults to about:blank and active', () => {
  const params = normalizeTabCreateParams({});
  assert.equal(params.url, 'about:blank');
  assert.equal(params.active, true);
});

test('normalizeTabCreateParams preserves URL', () => {
  const params = normalizeTabCreateParams({ url: 'https://example.com', active: false });
  assert.equal(params.url, 'https://example.com');
  assert.equal(params.active, false);
});

/** Ensure tab close params require a valid tabId. */
test('normalizeTabCloseParams requires valid tabId', () => {
  assert.throws(() => normalizeTabCloseParams({}), /tabId is required/);
  assert.throws(() => normalizeTabCloseParams({ tabId: -1 }), /tabId is required/);
});

test('normalizeTabCloseParams accepts valid tabId', () => {
  const params = normalizeTabCloseParams({ tabId: 42 });
  assert.equal(params.tabId, 42);
});

/** Ensure accessibility tree params clamp depth and node count. */
test('normalizeAccessibilityTreeParams clamps depth and nodes', () => {
  const params = normalizeAccessibilityTreeParams({ maxDepth: 100, maxNodes: 99999 });
  assert.equal(params.maxDepth, 20);
  assert.equal(params.maxNodes, 5000);
});

test('normalizeAccessibilityTreeParams defaults sensibly', () => {
  const params = normalizeAccessibilityTreeParams({});
  assert.equal(params.maxDepth, 6);
  assert.equal(params.maxNodes, 500);
});

/** Ensure network params validate and clamp. */
test('normalizeNetworkParams clamps limit and handles urlPattern', () => {
  const params = normalizeNetworkParams({ limit: 9999, urlPattern: '/api/', clear: true });
  assert.equal(params.limit, 500);
  assert.equal(params.urlPattern, '/api/');
  assert.equal(params.clear, true);
});

test('normalizeNetworkParams defaults sensibly', () => {
  const params = normalizeNetworkParams({});
  assert.equal(params.limit, 50);
  assert.equal(params.urlPattern, null);
  assert.equal(params.clear, false);
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

/** Ensure viewport resize params clamp dimensions. */
test('normalizeViewportResizeParams clamps dimensions', () => {
  const params = normalizeViewportResizeParams({ width: 99999, height: 99999, deviceScaleFactor: 10, reset: true });
  assert.equal(params.width, 7680);
  assert.equal(params.height, 4320);
  assert.equal(params.deviceScaleFactor, 4);
  assert.equal(params.reset, true);
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
  assert.throws(() => normalizeStyleQuery({}), /elementRef is required/);
  assert.throws(() => normalizeStyleQuery({ elementRef: '' }), /elementRef is required/);
});

/** Ensure evaluate params reject oversized expressions. */
test('normalizeEvaluateParams rejects oversized expression', () => {
  assert.throws(
    () => normalizeEvaluateParams({ expression: 'x'.repeat(100_001) }),
    /Expression too large/
  );
});
