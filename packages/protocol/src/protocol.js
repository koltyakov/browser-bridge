// @ts-check

import { applyBudget } from './budget.js';
import { DEFAULT_CAPABILITIES, isCapability } from './capabilities.js';
import { BridgeError, ERROR_CODES } from './errors.js';

/** @typedef {import('./types.js').AccessibilityTreeParams} AccessibilityTreeParams */
/** @typedef {import('./types.js').AccessRequestParams} AccessRequestParams */
/** @typedef {import('./types.js').BridgeFailureResponse} BridgeFailureResponse */
/** @typedef {import('./types.js').BridgeMeta} BridgeMeta */
/** @typedef {import('./types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('./types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('./types.js').BridgeSuccessResponse} BridgeSuccessResponse */
/** @typedef {import('./types.js').CheckedActionParams} CheckedActionParams */
/** @typedef {import('./types.js').ConsoleParams} ConsoleParams */
/** @typedef {import('./types.js').DomQueryParams} DomQueryParams */
/** @typedef {import('./types.js').DragParams} DragParams */
/** @typedef {import('./types.js').EvaluateParams} EvaluateParams */
/** @typedef {import('./types.js').FindByRoleParams} FindByRoleParams */
/** @typedef {import('./types.js').FindByTextParams} FindByTextParams */
/** @typedef {import('./types.js').GetHtmlParams} GetHtmlParams */
/** @typedef {import('./types.js').HoverParams} HoverParams */
/** @typedef {import('./types.js').InputActionParams} InputActionParams */
/** @typedef {import('./types.js').NavigationActionParams} NavigationActionParams */
/** @typedef {import('./types.js').NetworkParams} NetworkParams */
/** @typedef {import('./types.js').NormalizedAccessibilityTreeParams} NormalizedAccessibilityTreeParams */
/** @typedef {import('./types.js').NormalizedAccessRequest} NormalizedAccessRequest */
/** @typedef {import('./types.js').NormalizedCheckedAction} NormalizedCheckedAction */
/** @typedef {import('./types.js').NormalizedConsoleParams} NormalizedConsoleParams */
/** @typedef {import('./types.js').NormalizedDomQuery} NormalizedDomQuery */
/** @typedef {import('./types.js').NormalizedDragParams} NormalizedDragParams */
/** @typedef {import('./types.js').NormalizedEvaluateParams} NormalizedEvaluateParams */
/** @typedef {import('./types.js').NormalizedFindByRoleParams} NormalizedFindByRoleParams */
/** @typedef {import('./types.js').NormalizedFindByTextParams} NormalizedFindByTextParams */
/** @typedef {import('./types.js').NormalizedGetHtmlParams} NormalizedGetHtmlParams */
/** @typedef {import('./types.js').NormalizedHoverParams} NormalizedHoverParams */
/** @typedef {import('./types.js').NormalizedInputAction} NormalizedInputAction */
/** @typedef {import('./types.js').NormalizedNavigationAction} NormalizedNavigationAction */
/** @typedef {import('./types.js').NormalizedNetworkParams} NormalizedNetworkParams */
/** @typedef {import('./types.js').NormalizedPageTextParams} NormalizedPageTextParams */
/** @typedef {import('./types.js').NormalizedPatchOperation} NormalizedPatchOperation */
/** @typedef {import('./types.js').NormalizedSelectAction} NormalizedSelectAction */
/** @typedef {import('./types.js').NormalizedStorageParams} NormalizedStorageParams */
/** @typedef {import('./types.js').NormalizedStyleQuery} NormalizedStyleQuery */
/** @typedef {import('./types.js').NormalizedTabCloseParams} NormalizedTabCloseParams */
/** @typedef {import('./types.js').NormalizedTabCreateParams} NormalizedTabCreateParams */
/** @typedef {import('./types.js').NormalizedViewportAction} NormalizedViewportAction */
/** @typedef {import('./types.js').NormalizedViewportResizeParams} NormalizedViewportResizeParams */
/** @typedef {import('./types.js').NormalizedWaitForLoadStateParams} NormalizedWaitForLoadStateParams */
/** @typedef {import('./types.js').NormalizedWaitForParams} NormalizedWaitForParams */
/** @typedef {import('./types.js').PageTextParams} PageTextParams */
/** @typedef {import('./types.js').PatchOperationParams} PatchOperationParams */
/** @typedef {import('./types.js').SelectActionParams} SelectActionParams */
/** @typedef {import('./types.js').StorageParams} StorageParams */
/** @typedef {import('./types.js').StyleQueryParams} StyleQueryParams */
/** @typedef {import('./types.js').TabCloseParams} TabCloseParams */
/** @typedef {import('./types.js').TabCreateParams} TabCreateParams */
/** @typedef {import('./types.js').ViewportActionParams} ViewportActionParams */
/** @typedef {import('./types.js').ViewportResizeParams} ViewportResizeParams */
/** @typedef {import('./types.js').WaitForLoadStateParams} WaitForLoadStateParams */
/** @typedef {import('./types.js').WaitForParams} WaitForParams */

export const PROTOCOL_VERSION = '1.0';
const NON_EXPIRING_SESSION_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/**
 * Clamp a numeric value between min and max, falling back to a default.
 *
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampInt(value, min, max, fallback) {
  return Math.min(Math.max(Number(value) || fallback, min), max);
}

/** @type {ReadonlyArray<BridgeMethod>} */
export const METHODS = Object.freeze([
  'tabs.list',
  'tabs.create',
  'tabs.close',
  'session.request_access',
  'session.get_status',
  'session.revoke',
  'skill.get_runtime_context',
  'page.get_state',
  'page.evaluate',
  'page.get_console',
  'page.wait_for_load_state',
  'page.get_storage',
  'page.get_text',
  'page.get_network',
  'navigation.navigate',
  'navigation.reload',
  'navigation.go_back',
  'navigation.go_forward',
  'dom.query',
  'dom.describe',
  'dom.get_text',
  'dom.get_attributes',
  'dom.wait_for',
  'dom.find_by_text',
  'dom.find_by_role',
  'dom.get_html',
  'dom.get_accessibility_tree',
  'layout.get_box_model',
  'layout.hit_test',
  'styles.get_computed',
  'styles.get_matched_rules',
  'viewport.scroll',
  'viewport.resize',
  'input.click',
  'input.focus',
  'input.type',
  'input.press_key',
  'input.set_checked',
  'input.select_option',
  'input.hover',
  'input.drag',
  'screenshot.capture_region',
  'screenshot.capture_element',
  'patch.apply_styles',
  'patch.apply_dom',
  'patch.list',
  'patch.rollback',
  'patch.commit_session_baseline',
  'cdp.get_document',
  'cdp.get_dom_snapshot',
  'cdp.get_box_model',
  'cdp.get_computed_styles_for_node',
  'performance.get_metrics',
  'log.tail',
  'health.ping'
]);

/**
 * @param {{
 *   id: string,
 *   method: BridgeMethod,
 *   sessionId?: string | null,
 *   params?: Record<string, unknown>,
 *   meta?: BridgeMeta
 * }} input
 * @returns {BridgeRequest}
 */
export function createRequest({ id, method, sessionId = null, params = {}, meta = {} }) {
  return validateBridgeRequest({
    id,
    method,
    session_id: sessionId,
    params,
    meta: {
      protocol_version: PROTOCOL_VERSION,
      ...meta
    }
  });
}

/**
 * @param {string} id
 * @param {unknown} result
 * @param {Record<string, unknown>} [meta={}]
 * @returns {BridgeSuccessResponse}
 */
export function createSuccess(id, result, meta = {}) {
  return {
    id,
    ok: true,
    result,
    error: null,
    meta: {
      protocol_version: PROTOCOL_VERSION,
      ...meta
    }
  };
}

/**
 * @param {string} id
 * @param {import('./types.js').ErrorCode} code
 * @param {string} message
 * @param {unknown} [details=null]
 * @param {Record<string, unknown>} [meta={}]
 * @returns {BridgeFailureResponse}
 */
export function createFailure(id, code, message, details = null, meta = {}) {
  return {
    id,
    ok: false,
    result: null,
    error: {
      code,
      message,
      details
    },
    meta: {
      protocol_version: PROTOCOL_VERSION,
      ...meta
    }
  };
}

/**
 * @param {unknown} request
 * @returns {BridgeRequest}
 */
export function validateBridgeRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'Request must be an object.');
  }

  const candidate = /** @type {Record<string, unknown>} */ (request);

  if (typeof candidate.id !== 'string' || !candidate.id.trim()) {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'Request id must be a non-empty string.');
  }

  if (typeof candidate.method !== 'string' || !METHODS.includes(/** @type {BridgeMethod} */ (candidate.method))) {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, `Unsupported method: ${String(candidate.method)}`);
  }

  const meta = candidate.meta && typeof candidate.meta === 'object'
    ? /** @type {Record<string, unknown>} */ (candidate.meta)
    : {};

  return {
    id: candidate.id,
    method: /** @type {BridgeMethod} */ (candidate.method),
    session_id: typeof candidate.session_id === 'string' ? candidate.session_id : null,
    params: candidate.params && typeof candidate.params === 'object'
      ? /** @type {Record<string, unknown>} */ (candidate.params)
      : {},
    meta: {
      protocol_version: typeof meta.protocol_version === 'string'
        ? meta.protocol_version
        : PROTOCOL_VERSION,
      token_budget: typeof meta.token_budget === 'number' ? meta.token_budget : null
    }
  };
}

/**
 * @param {AccessRequestParams} [params={}]
 * @returns {NormalizedAccessRequest}
 */
export function normalizeAccessRequest(params = {}) {
  const capabilities = Array.isArray(params.capabilities) && params.capabilities.length
    ? params.capabilities.filter(isCapability)
    : [...DEFAULT_CAPABILITIES];
  const parsedTabId = Number(params.tabId);

  return {
    tabId: Number.isFinite(parsedTabId) && parsedTabId > 0 ? parsedTabId : null,
    origin: String(params.origin || ''),
    capabilities,
    ttlMs: Number(params.ttlMs) || NON_EXPIRING_SESSION_TTL_MS,
    label: params.label ? String(params.label) : ''
  };
}

/**
 * @param {DomQueryParams} [params={}]
 * @returns {NormalizedDomQuery}
 */
export function normalizeDomQuery(params = {}) {
  return {
    selector: typeof params.selector === 'string' && params.selector.trim() ? params.selector : 'body',
    withinRef: typeof params.withinRef === 'string' ? params.withinRef : null,
    budget: applyBudget(params),
    includeRoles: params.includeRoles !== false
  };
}

/**
 * @param {StyleQueryParams} [params={}]
 * @returns {NormalizedStyleQuery}
 */
export function normalizeStyleQuery(params = {}) {
  const elementRef = String(params.elementRef || '');
  if (!elementRef) {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'elementRef is required for style queries.');
  }
  return {
    elementRef,
    properties: Array.isArray(params.properties) ? params.properties.filter(Boolean) : []
  };
}

/**
 * @param {{ elementRef?: string, selector?: string } | null | undefined} target
 * @returns {import('./types.js').InputTarget}
 */
function normalizeTarget(target) {
  return {
    elementRef: typeof target?.elementRef === 'string' ? target.elementRef : undefined,
    selector: typeof target?.selector === 'string' ? target.selector : undefined
  };
}

/**
 * @param {InputActionParams} [params={}]
 * @returns {NormalizedInputAction}
 */
export function normalizeInputAction(params = {}) {
  const button = params.button === 'middle' || params.button === 'right'
    ? params.button
    : 'left';

  return {
    target: normalizeTarget(
      params.target && typeof params.target === 'object'
        ? /** @type {{ elementRef?: string, selector?: string }} */ (params.target)
        : undefined
    ),
    button,
    clickCount: clampInt(params.clickCount, 1, 2, 1),
    text: typeof params.text === 'string' ? params.text : '',
    clear: Boolean(params.clear),
    submit: Boolean(params.submit),
    key: typeof params.key === 'string' ? params.key : '',
    modifiers: Array.isArray(params.modifiers)
      ? params.modifiers.filter((modifier) => typeof modifier === 'string' && modifier.trim())
      : []
  };
}

/**
 * @param {CheckedActionParams} [params={}]
 * @returns {NormalizedCheckedAction}
 */
export function normalizeCheckedAction(params = {}) {
  return {
    target: normalizeTarget(
      params.target && typeof params.target === 'object'
        ? /** @type {{ elementRef?: string, selector?: string }} */ (params.target)
        : undefined
    ),
    checked: params.checked !== false
  };
}

/**
 * @param {SelectActionParams} [params={}]
 * @returns {NormalizedSelectAction}
 */
export function normalizeSelectAction(params = {}) {
  return {
    target: normalizeTarget(
      params.target && typeof params.target === 'object'
        ? /** @type {{ elementRef?: string, selector?: string }} */ (params.target)
        : undefined
    ),
    values: Array.isArray(params.values)
      ? params.values.filter((value) => typeof value === 'string' && value.trim())
      : [],
    labels: Array.isArray(params.labels)
      ? params.labels.filter((label) => typeof label === 'string' && label.trim())
      : [],
    indexes: Array.isArray(params.indexes)
      ? params.indexes
        .map((index) => Number(index))
        .filter((index) => Number.isInteger(index) && index >= 0)
      : []
  };
}

/**
 * @param {ViewportActionParams} [params={}]
 * @returns {NormalizedViewportAction}
 */
export function normalizeViewportAction(params = {}) {
  return {
    target: normalizeTarget(
      params.target && typeof params.target === 'object'
        ? /** @type {{ elementRef?: string, selector?: string }} */ (params.target)
        : undefined
    ),
    top: Number.isFinite(Number(params.top)) ? Number(params.top) : 0,
    left: Number.isFinite(Number(params.left)) ? Number(params.left) : 0,
    behavior: params.behavior === 'smooth' ? 'smooth' : 'auto',
    relative: Boolean(params.relative)
  };
}

/**
 * @param {NavigationActionParams} [params={}]
 * @returns {NormalizedNavigationAction}
 */
export function normalizeNavigationAction(params = {}) {
  const url = typeof params.url === 'string' ? params.url.trim() : '';
  if (url) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:', 'about:'].includes(parsed.protocol)) {
        throw new BridgeError(
          ERROR_CODES.INVALID_REQUEST,
          `Navigation blocked: unsupported protocol "${parsed.protocol}". Only http:, https:, and about: are allowed.`
        );
      }
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(ERROR_CODES.INVALID_REQUEST, `Invalid navigation URL: ${url}`);
    }
  }
  return {
    url,
    waitForLoad: params.waitForLoad !== false,
    timeoutMs: clampInt(params.timeoutMs, 500, 120_000, 15_000)
  };
}

/**
 * @param {PatchOperationParams} [params={}]
 * @returns {NormalizedPatchOperation}
 */
export function normalizePatchOperation(params = {}) {
  return {
    patchId: typeof params.patchId === 'string' ? params.patchId : null,
    target: params.target && typeof params.target === 'object'
      ? /** @type {Record<string, unknown>} */ (params.target)
      : {},
    operation: typeof params.operation === 'string' ? params.operation : null,
    name: typeof params.name === 'string' ? params.name : null,
    declarations: params.declarations && typeof params.declarations === 'object'
      ? /** @type {Record<string, string>} */ (params.declarations)
      : {},
    value: params.value ?? null,
    important: Boolean(params.important)
  };
}

/**
 * @param {EvaluateParams} [params={}]
 * @returns {NormalizedEvaluateParams}
 */
export function normalizeEvaluateParams(params = {}) {
  const expression = typeof params.expression === 'string' ? params.expression : '';
  if (expression.length > 100_000) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      `Expression too large (${expression.length} chars). Maximum is 100,000.`
    );
  }
  return {
    expression,
    awaitPromise: Boolean(params.awaitPromise),
    timeoutMs: clampInt(params.timeoutMs, 100, 30_000, 5_000),
    returnByValue: params.returnByValue !== false
  };
}

/**
 * @param {ConsoleParams} [params={}]
 * @returns {NormalizedConsoleParams}
 */
export function normalizeConsoleParams(params = {}) {
  const validLevels = ['all', 'log', 'warn', 'error', 'info', 'debug', 'exception', 'rejection'];
  return {
    level: validLevels.includes(String(params.level ?? '')) ? String(params.level) : 'all',
    clear: Boolean(params.clear),
    limit: clampInt(params.limit, 1, 200, 50)
  };
}

/**
 * @param {WaitForParams} [params={}]
 * @returns {NormalizedWaitForParams}
 */
export function normalizeWaitForParams(params = {}) {
  const validStates = ['attached', 'detached', 'visible', 'hidden'];
  return {
    selector: typeof params.selector === 'string' && params.selector.trim() ? params.selector : '',
    text: params.text != null ? String(params.text) : null,
    state: validStates.includes(String(params.state ?? ''))
      ? /** @type {'attached' | 'detached' | 'visible' | 'hidden'} */ (String(params.state))
      : 'attached',
    timeoutMs: clampInt(params.timeoutMs, 100, 30_000, 5_000)
  };
}

/**
 * @param {FindByTextParams} [params={}]
 * @returns {NormalizedFindByTextParams}
 */
export function normalizeFindByTextParams(params = {}) {
  return {
    text: typeof params.text === 'string' ? params.text : '',
    exact: Boolean(params.exact),
    selector: typeof params.selector === 'string' && params.selector.trim() ? params.selector : '*',
    maxResults: clampInt(params.maxResults, 1, 50, 10)
  };
}

/**
 * @param {FindByRoleParams} [params={}]
 * @returns {NormalizedFindByRoleParams}
 */
export function normalizeFindByRoleParams(params = {}) {
  return {
    role: typeof params.role === 'string' ? params.role : '',
    name: typeof params.name === 'string' ? params.name : '',
    selector: typeof params.selector === 'string' && params.selector.trim() ? params.selector : '*',
    maxResults: clampInt(params.maxResults, 1, 50, 10)
  };
}

/**
 * @param {GetHtmlParams} [params={}]
 * @returns {NormalizedGetHtmlParams}
 */
export function normalizeGetHtmlParams(params = {}) {
  return {
    elementRef: String(params.elementRef || ''),
    outer: Boolean(params.outer),
    maxLength: clampInt(params.maxLength, 32, 50_000, 2000)
  };
}

/**
 * @param {HoverParams} [params={}]
 * @returns {NormalizedHoverParams}
 */
export function normalizeHoverParams(params = {}) {
  return {
    target: normalizeTarget(
      params.target && typeof params.target === 'object'
        ? /** @type {{ elementRef?: string, selector?: string }} */ (params.target)
        : undefined
    ),
    duration: clampInt(params.duration, 0, 5_000, 0)
  };
}

/**
 * @param {DragParams} [params={}]
 * @returns {NormalizedDragParams}
 */
export function normalizeDragParams(params = {}) {
  return {
    source: normalizeTarget(
      params.source && typeof params.source === 'object'
        ? /** @type {{ elementRef?: string, selector?: string }} */ (params.source)
        : undefined
    ),
    destination: normalizeTarget(
      params.destination && typeof params.destination === 'object'
        ? /** @type {{ elementRef?: string, selector?: string }} */ (params.destination)
        : undefined
    ),
    offsetX: Number.isFinite(Number(params.offsetX)) ? Number(params.offsetX) : 0,
    offsetY: Number.isFinite(Number(params.offsetY)) ? Number(params.offsetY) : 0
  };
}

/**
 * @param {StorageParams} [params={}]
 * @returns {NormalizedStorageParams}
 */
export function normalizeStorageParams(params = {}) {
  return {
    type: params.type === 'session' ? 'session' : 'local',
    keys: Array.isArray(params.keys) ? params.keys.filter((k) => typeof k === 'string') : null
  };
}

/**
 * @param {WaitForLoadStateParams} [params={}]
 * @returns {NormalizedWaitForLoadStateParams}
 */
export function normalizeWaitForLoadStateParams(params = {}) {
  return {
    waitForLoad: params.waitForLoad !== false,
    timeoutMs: clampInt(params.timeoutMs, 500, 120_000, 15_000)
  };
}

/**
 * @param {TabCreateParams} [params={}]
 * @returns {NormalizedTabCreateParams}
 */
export function normalizeTabCreateParams(params = {}) {
  return {
    url: typeof params.url === 'string' && params.url.trim() ? params.url.trim() : 'about:blank',
    active: params.active !== false
  };
}

/**
 * @param {TabCloseParams} [params={}]
 * @returns {NormalizedTabCloseParams}
 */
export function normalizeTabCloseParams(params = {}) {
  const tabId = Number(params.tabId);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'tabId is required for tabs.close.');
  }
  return { tabId };
}

/**
 * @param {AccessibilityTreeParams} [params={}]
 * @returns {NormalizedAccessibilityTreeParams}
 */
export function normalizeAccessibilityTreeParams(params = {}) {
  return {
    maxDepth: clampInt(params.maxDepth, 1, 20, 6),
    maxNodes: clampInt(params.maxNodes, 10, 5000, 500)
  };
}

/**
 * @param {NetworkParams} [params={}]
 * @returns {NormalizedNetworkParams}
 */
export function normalizeNetworkParams(params = {}) {
  return {
    clear: Boolean(params.clear),
    limit: clampInt(params.limit, 1, 500, 50),
    urlPattern: typeof params.urlPattern === 'string' && params.urlPattern.trim()
      ? params.urlPattern.trim()
      : null
  };
}

/**
 * @param {PageTextParams} [params={}]
 * @returns {NormalizedPageTextParams}
 */
export function normalizePageTextParams(params = {}) {
  return {
    textBudget: clampInt(params.textBudget, 100, 100_000, 8000)
  };
}

/**
 * @param {ViewportResizeParams} [params={}]
 * @returns {NormalizedViewportResizeParams}
 */
export function normalizeViewportResizeParams(params = {}) {
  return {
    width: clampInt(params.width, 320, 7680, 1280),
    height: clampInt(params.height, 200, 4320, 720),
    deviceScaleFactor: clampInt(params.deviceScaleFactor, 0, 4, 0)
  };
}

/**
 * @returns {{
 *   v: string,
 *   budgets: Record<string, { n: number, d: number, t: number }>,
 *   methods: Record<string, string[]>,
 *   errors: Record<string, string>,
 *   capabilities: Record<string, string>,
 *   tips: string[],
 *   flow: BridgeMethod[],
 *   limits: Record<string, { min: number, max: number, default: number }>
 * }}
 */
export function createRuntimeContext() {
  return {
    v: PROTOCOL_VERSION,
    budgets: {
      quick: { n: 5, d: 2, t: 300 },
      normal: { n: 25, d: 4, t: 600 },
      deep: { n: 100, d: 8, t: 2000 }
    },
    methods: {
      session: ['session.request_access', 'session.get_status', 'session.revoke',
        'skill.get_runtime_context'],
      inspect: ['dom.query', 'dom.describe', 'dom.get_text', 'dom.get_attributes',
        'dom.find_by_text', 'dom.find_by_role', 'dom.get_html', 'dom.get_accessibility_tree',
        'styles.get_computed', 'styles.get_matched_rules', 'layout.get_box_model', 'layout.hit_test'],
      page: ['page.get_state', 'page.evaluate', 'page.get_console', 'page.get_storage',
        'page.wait_for_load_state', 'page.get_text', 'page.get_network'],
      navigate: ['navigation.navigate', 'navigation.reload', 'navigation.go_back',
        'navigation.go_forward', 'viewport.scroll', 'viewport.resize'],
      interact: ['input.click', 'input.type', 'input.focus', 'input.press_key',
        'input.set_checked', 'input.select_option', 'input.hover', 'input.drag'],
      wait: ['dom.wait_for', 'page.wait_for_load_state'],
      patch: ['patch.apply_styles', 'patch.apply_dom', 'patch.list', 'patch.rollback',
        'patch.commit_session_baseline'],
      capture: ['screenshot.capture_element', 'screenshot.capture_region'],
      cdp: ['cdp.get_document', 'cdp.get_dom_snapshot', 'cdp.get_box_model',
        'cdp.get_computed_styles_for_node'],
      tabs: ['tabs.list', 'tabs.create', 'tabs.close'],
      performance: ['performance.get_metrics']
    },
    errors: {
      ACCESS_DENIED: 'Tab not enabled - user must allow in extension UI',
      SESSION_EXPIRED: 'Session invalid - call session.request_access again',
      APPROVAL_PENDING: 'Access prompt opened - retry after ~3s',
      TAB_MISMATCH: 'Tab closed or not found',
      ORIGIN_MISMATCH: 'Tab navigated to different origin',
      CAPABILITY_MISSING: 'Session lacks needed capability',
      ELEMENT_STALE: 'Element removed from DOM - re-query',
      INVALID_REQUEST: 'Malformed method or params',
      TIMEOUT: 'Operation exceeded time limit',
      RATE_LIMITED: 'Too many requests - back off',
      INTERNAL_ERROR: 'Unexpected extension error',
      EXTENSION_DISCONNECTED: 'Extension not connected to daemon - check Chrome'
    },
    capabilities: {
      'page.read': 'page.get_state, page.get_console, page.get_storage, page.get_text, page.get_network',
      'page.evaluate': 'page.evaluate (JS in page context via CDP)',
      'dom.read': 'dom.query, dom.describe, dom.get_text, dom.find_by_text, dom.find_by_role, dom.get_html, dom.get_accessibility_tree',
      'styles.read': 'styles.get_computed, styles.get_matched_rules',
      'layout.read': 'layout.get_box_model, layout.hit_test',
      'automation.input': 'input.click, input.type, input.focus, input.press_key, input.hover, input.drag',
      'patch.styles': 'patch.apply_styles',
      'patch.dom': 'patch.apply_dom, patch.list, patch.rollback',
      'screenshot.partial': 'screenshot.capture_element, screenshot.capture_region',
      'navigation.control': 'navigation.navigate, navigation.reload, navigation.go_back/forward',
      'viewport.control': 'viewport.scroll, viewport.resize',
      'tabs.manage': 'tabs.create, tabs.close',
      'network.read': 'page.get_network',
      'performance.read': 'performance.get_metrics'
    },
    tips: [
      'dom.query quick budget first; widen only if truncated',
      'Reuse elementRef; don\'t re-query',
      'Set attributeAllowlist + styleAllowlist',
      'patch.apply_styles before patch.apply_dom',
      'Verify with get_box_model not screenshots',
      'batch independent reads',
      'Rollback all patches before finishing',
      'page.evaluate to read framework state (React, Vue, Next.js data)',
      'dom.find_by_text / dom.find_by_role for semantic element finding',
      'dom.get_accessibility_tree for reliable interactive element discovery',
      'dom.wait_for after HMR / navigation to detect page updates',
      'page.get_console to catch runtime errors after interactions',
      'page.get_network to inspect XHR/fetch API calls',
      'page.get_text for full-page content extraction',
      'input.hover before screenshot to inspect hover states',
      'performance.get_metrics for Core Web Vitals and load timing',
      'viewport.resize to test responsive layouts',
      'screenshot.capture_element only when structured data is ambiguous',
      'page.get_storage reads localStorage/sessionStorage without evaluate'
    ],
    flow: [
      'session.request_access',
      'page.get_state',
      'dom.query',
      'styles.get_computed',
      'patch.apply_styles',
      'layout.get_box_model',
      'page.get_console',
      'patch.rollback'
    ],
    limits: {
      maxNodes: { min: 1, max: 250, default: 25 },
      maxDepth: { min: 1, max: 20, default: 4 },
      textBudget: { min: 32, max: 10000, default: 600 },
      evalTimeout: { min: 100, max: 30000, default: 5000 },
      navTimeout: { min: 500, max: 120000, default: 15000 },
      waitTimeout: { min: 100, max: 30000, default: 5000 },
      maxHtmlLength: { min: 32, max: 50000, default: 2000 },
      a11yMaxNodes: { min: 10, max: 5000, default: 500 },
      networkLimit: { min: 1, max: 500, default: 50 },
      consoleLimit: { min: 1, max: 200, default: 50 },
      pageTextBudget: { min: 100, max: 100000, default: 8000 }
    }
  };
}
