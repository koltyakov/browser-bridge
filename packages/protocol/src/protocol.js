// @ts-check

import { applyBudget } from './budget.js';
import { DEFAULT_CAPABILITIES, isCapability } from './capabilities.js';
import { BridgeError, ERROR_CODES } from './errors.js';

/** @typedef {import('./types.js').AccessRequestParams} AccessRequestParams */
/** @typedef {import('./types.js').BridgeFailureResponse} BridgeFailureResponse */
/** @typedef {import('./types.js').BridgeMeta} BridgeMeta */
/** @typedef {import('./types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('./types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('./types.js').BridgeSuccessResponse} BridgeSuccessResponse */
/** @typedef {import('./types.js').CheckedActionParams} CheckedActionParams */
/** @typedef {import('./types.js').DomQueryParams} DomQueryParams */
/** @typedef {import('./types.js').InputActionParams} InputActionParams */
/** @typedef {import('./types.js').NavigationActionParams} NavigationActionParams */
/** @typedef {import('./types.js').NormalizedAccessRequest} NormalizedAccessRequest */
/** @typedef {import('./types.js').NormalizedCheckedAction} NormalizedCheckedAction */
/** @typedef {import('./types.js').NormalizedDomQuery} NormalizedDomQuery */
/** @typedef {import('./types.js').NormalizedInputAction} NormalizedInputAction */
/** @typedef {import('./types.js').NormalizedNavigationAction} NormalizedNavigationAction */
/** @typedef {import('./types.js').NormalizedPatchOperation} NormalizedPatchOperation */
/** @typedef {import('./types.js').NormalizedSelectAction} NormalizedSelectAction */
/** @typedef {import('./types.js').NormalizedStyleQuery} NormalizedStyleQuery */
/** @typedef {import('./types.js').NormalizedViewportAction} NormalizedViewportAction */
/** @typedef {import('./types.js').PatchOperationParams} PatchOperationParams */
/** @typedef {import('./types.js').SelectActionParams} SelectActionParams */
/** @typedef {import('./types.js').StyleQueryParams} StyleQueryParams */
/** @typedef {import('./types.js').ViewportActionParams} ViewportActionParams */

export const PROTOCOL_VERSION = '1.0';
const NON_EXPIRING_SESSION_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** @type {ReadonlyArray<BridgeMethod>} */
export const METHODS = Object.freeze([
  'tabs.list',
  'session.request_access',
  'session.get_status',
  'session.revoke',
  'skill.get_runtime_context',
  'page.get_state',
  'navigation.navigate',
  'navigation.reload',
  'navigation.go_back',
  'navigation.go_forward',
  'dom.query',
  'dom.describe',
  'dom.get_text',
  'dom.get_attributes',
  'layout.get_box_model',
  'layout.hit_test',
  'styles.get_computed',
  'styles.get_matched_rules',
  'viewport.scroll',
  'input.click',
  'input.focus',
  'input.type',
  'input.press_key',
  'input.set_checked',
  'input.select_option',
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
    ttlMs: Math.max(NON_EXPIRING_SESSION_TTL_MS, Number(params.ttlMs) || NON_EXPIRING_SESSION_TTL_MS),
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
  return {
    elementRef: String(params.elementRef || ''),
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
    clickCount: Math.min(Math.max(Number(params.clickCount) || 1, 1), 2),
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
  return {
    url: typeof params.url === 'string' ? params.url.trim() : '',
    waitForLoad: params.waitForLoad !== false,
    timeoutMs: Math.min(Math.max(Number(params.timeoutMs) || 15_000, 500), 120_000)
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
 * @returns {{
 *   protocolVersion: string,
 *   budgetPresets: Record<string, { maxNodes: number, maxDepth: number, textBudget: number }>,
 *   methodGroups: Record<string, string[]>,
 *   guidance: string[],
 *   exampleFlow: BridgeMethod[]
 * }}
 */
export function createRuntimeContext() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    budgetPresets: {
      quick: { maxNodes: 5, maxDepth: 2, textBudget: 300 },
      normal: { maxNodes: 25, maxDepth: 4, textBudget: 600 },
      deep: { maxNodes: 100, maxDepth: 8, textBudget: 2000 }
    },
    methodGroups: {
      inspect: ['dom.query', 'dom.describe', 'dom.get_text', 'dom.get_attributes',
        'styles.get_computed', 'styles.get_matched_rules', 'layout.get_box_model', 'layout.hit_test'],
      navigate: ['navigation.navigate', 'navigation.reload', 'navigation.go_back',
        'navigation.go_forward', 'viewport.scroll'],
      interact: ['input.click', 'input.type', 'input.focus', 'input.press_key',
        'input.set_checked', 'input.select_option'],
      patch: ['patch.apply_styles', 'patch.apply_dom', 'patch.list', 'patch.rollback',
        'patch.commit_session_baseline'],
      capture: ['screenshot.capture_element', 'screenshot.capture_region'],
      cdp: ['cdp.get_document', 'cdp.get_dom_snapshot', 'cdp.get_box_model',
        'cdp.get_computed_styles_for_node']
    },
    guidance: [
      'Start with dom.query at quick budget; widen only if truncated.',
      'Reuse elementRef from prior results instead of re-querying.',
      'Set attributeAllowlist and styleAllowlist to limit payload size.',
      'Try patch.apply_styles before patch.apply_dom for visual experiments.',
      'Verify patches with layout.get_box_model, not screenshots.',
      'Use batch command for independent multi-step reads.',
      'Rollback all patches before finishing.'
    ],
    exampleFlow: [
      'session.request_access',
      'page.get_state',
      'dom.query',
      'styles.get_computed',
      'patch.apply_styles',
      'layout.get_box_model',
      'patch.rollback'
    ]
  };
}
