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
/** @typedef {import('./types.js').DomQueryParams} DomQueryParams */
/** @typedef {import('./types.js').InputActionParams} InputActionParams */
/** @typedef {import('./types.js').NormalizedAccessRequest} NormalizedAccessRequest */
/** @typedef {import('./types.js').NormalizedDomQuery} NormalizedDomQuery */
/** @typedef {import('./types.js').NormalizedInputAction} NormalizedInputAction */
/** @typedef {import('./types.js').NormalizedPatchOperation} NormalizedPatchOperation */
/** @typedef {import('./types.js').NormalizedStyleQuery} NormalizedStyleQuery */
/** @typedef {import('./types.js').PatchOperationParams} PatchOperationParams */
/** @typedef {import('./types.js').StyleQueryParams} StyleQueryParams */

export const PROTOCOL_VERSION = '1.0';
const NON_EXPIRING_SESSION_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** @type {ReadonlyArray<BridgeMethod>} */
export const METHODS = Object.freeze([
  'tabs.list',
  'session.request_access',
  'session.get_status',
  'session.revoke',
  'skill.get_runtime_context',
  'dom.query',
  'dom.describe',
  'dom.get_text',
  'dom.get_attributes',
  'layout.get_box_model',
  'layout.hit_test',
  'styles.get_computed',
  'styles.get_matched_rules',
  'input.click',
  'input.focus',
  'input.type',
  'input.press_key',
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
 * @param {InputActionParams} [params={}]
 * @returns {NormalizedInputAction}
 */
export function normalizeInputAction(params = {}) {
  const button = params.button === 'middle' || params.button === 'right'
    ? params.button
    : 'left';
  const target = params.target && typeof params.target === 'object'
    ? /** @type {{ elementRef?: string, selector?: string }} */ (params.target)
    : {};

  return {
    target: {
      elementRef: typeof target.elementRef === 'string' ? target.elementRef : undefined,
      selector: typeof target.selector === 'string' ? target.selector : undefined
    },
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
 *   guidance: string[],
 *   exampleFlow: BridgeMethod[]
 * }}
 */
export function createRuntimeContext() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    guidance: [
      'Prefer dom.query and styles.get_computed before screenshots.',
      'Keep maxNodes, maxDepth, attributeAllowlist, and styleAllowlist tight.',
      'Use input.click and input.type only after the operator has enabled the tab.',
      'Use patch.apply_styles for visual experiments and rollback before exit.',
      'Scope every result to the enabled tab and origin.'
    ],
    exampleFlow: [
      'session.request_access',
      'dom.query',
      'styles.get_computed',
      'patch.apply_styles',
      'layout.get_box_model',
      'patch.rollback'
    ]
  };
}
