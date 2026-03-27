// @ts-check

import {
  CAPABILITIES,
  ERROR_CODES,
  estimateJsonPayloadCost,
  getCostClass,
  isDebuggerBackedMethod,
} from '../../protocol/src/index.js';

/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */
/** @typedef {import('../../protocol/src/types.js').Capability} Capability */
/** @typedef {import('../../protocol/src/types.js').ErrorCode} ErrorCode */

const INTERACTIVE_AX_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'tab', 'switch', 'slider', 'spinbutton',
  'searchbox', 'menuitemcheckbox', 'menuitemradio', 'option'
]);

/**
 * @param {chrome.tabs.Tab} tab
 * @param {string} method
 * @returns {{ method: string, tabId: number | null, windowId: number | null, url: string, title: string, status: string }}
 */
export function summarizeTabResult(tab, method) {
  return {
    method,
    tabId: typeof tab.id === 'number' ? tab.id : null,
    windowId: typeof tab.windowId === 'number' ? tab.windowId : null,
    url: tab.url ?? '',
    title: tab.title ?? '',
    status: tab.status ?? 'unknown'
  };
}

/**
 * @param {unknown} prop
 * @returns {string}
 */
export function axValue(prop) {
  if (!prop || typeof prop !== 'object') return '';
  const val = /** @type {{ value?: unknown }} */ (prop).value;
  return typeof val === 'string' ? val : '';
}

/**
 * @param {unknown} prop
 * @returns {boolean}
 */
export function axBool(prop) {
  if (!prop || typeof prop !== 'object') return false;
  return /** @type {{ value?: unknown }} */ (prop).value === true;
}

/**
 * @param {unknown} prop
 * @returns {string | null}
 */
export function axTristateValue(prop) {
  if (!prop || typeof prop !== 'object') return null;
  const val = /** @type {{ value?: unknown }} */ (prop).value;
  if (val === 'true' || val === true) return 'true';
  if (val === 'false' || val === false) return 'false';
  if (val === 'mixed') return 'mixed';
  return null;
}

/**
 * @param {Record<string, unknown>} node
 * @returns {{ nodeId: string, role: string, name: string, description: string, value: string, focused: boolean, required: boolean, checked: string | null, disabled: boolean, interactive: boolean, childIds: string[] }}
 */
export function simplifyAXNode(node) {
  const role = axValue(node.role);
  return {
    nodeId: String(node.nodeId ?? ''),
    role,
    name: axValue(node.name),
    description: axValue(node.description),
    value: axValue(node.value),
    focused: axBool(node.focused),
    required: axBool(node.required),
    checked: axTristateValue(node.checked),
    disabled: axBool(node.disabled),
    interactive: INTERACTIVE_AX_ROLES.has(role) || axBool(node.focusable),
    childIds: Array.isArray(node.childIds) ? node.childIds.map(String) : []
  };
}

/**
 * @param {string} method
 * @returns {boolean}
 */
export function shouldLogAction(method) {
  return ![
    'health.ping',
    'log.tail',
    'skill.get_runtime_context',
    'setup.get_status',
    'setup.install',
    'tabs.list'
  ].includes(method);
}

/**
 * Treat page exceptions as part of the error stream so filtered reads return
 * runtime failures alongside explicit `console.error` calls.
 *
 * @param {string} requestedLevel
 * @param {string} entryLevel
 * @returns {boolean}
 */
export function matchesConsoleLevel(requestedLevel, entryLevel) {
  if (requestedLevel === entryLevel) {
    return true;
  }
  if (requestedLevel === 'error') {
    return entryLevel === 'exception' || entryLevel === 'rejection';
  }
  return false;
}

/**
 * @param {BridgeResponse} response
 * @returns {string}
 */
export function summarizeActionResult(response) {
  if (!response.ok) {
    return response.error.message;
  }

  const result = response.result && typeof response.result === 'object'
    ? /** @type {Record<string, unknown>} */ (response.result)
    : {};

  if (typeof result.patchId === 'string') {
    return `Patch ${result.patchId} applied.`;
  }

  if (Array.isArray(result.nodes)) {
    return `${result.nodes.length} node(s) returned.`;
  }

  if (typeof result.image === 'string') {
    return 'Partial screenshot captured.';
  }

  return 'Completed successfully.';
}

/**
 * Estimate approximate token cost from a bridge response.
 *
 * @param {BridgeResponse} response
 * @returns {{ responseBytes: number, approxTokens: number, hasScreenshot: boolean, nodeCount: number | null }}
 */
export function estimateResponseTokens(response) {
  const payload = response.ok
    ? response.result
    : { error: response.error };
  const estimate = estimateJsonPayloadCost(payload);
  const responseBytes = estimate.bytes;
  const result = response.ok && response.result && typeof response.result === 'object'
    ? /** @type {Record<string, unknown>} */ (response.result)
    : null;
  const hasScreenshot = result != null && typeof result.image === 'string';
  const nodeCount = result != null && Array.isArray(result.nodes) ? result.nodes.length : null;

  return {
    responseBytes,
    approxTokens: estimate.approxTokens,
    hasScreenshot,
    nodeCount,
  };
}

/**
 * @param {string} method
 * @param {BridgeResponse} response
 * @returns {{
 *   responseBytes: number,
 *   approxTokens: number,
 *   hasScreenshot: boolean,
 *   nodeCount: number | null,
 *   costClass: 'cheap' | 'moderate' | 'heavy' | 'extreme',
 *   debuggerBacked: boolean
 * }}
 */
export function getResponseDiagnostics(method, response) {
  const estimate = estimateResponseTokens(response);
  return {
    ...estimate,
    costClass: getCostClass(estimate.approxTokens),
    debuggerBacked: isDebuggerBackedMethod(method),
  };
}

/**
 * Deterministically trim oversized success payloads to fit within an
 * approximate token budget. This prefers shrinking large strings and slicing
 * top-level result arrays before falling back to a compact continuation payload.
 *
 * @param {string} method
 * @param {BridgeResponse} response
 * @param {number | null | undefined} tokenBudget
 * @returns {BridgeResponse}
 */
export function enforceTokenBudget(method, response, tokenBudget) {
  if (!response.ok || typeof tokenBudget !== 'number' || !Number.isFinite(tokenBudget) || tokenBudget <= 0) {
    return response;
  }

  const maxBytes = Math.max(128, Math.floor(tokenBudget * 4));
  const responseBytes = estimateJsonPayloadCost(response.result).bytes;
  if (responseBytes <= maxBytes) {
    return {
      ...response,
      meta: {
        ...response.meta,
        budget_applied: false,
        budget_truncated: false,
        continuation_hint: null,
      },
    };
  }

  const cloned = cloneJsonValue(response.result);
  let truncated = false;
  while (estimateJsonPayloadCost(cloned).bytes > maxBytes && shrinkForBudget(cloned)) {
    truncated = true;
  }

  let result = cloned;
  if (estimateJsonPayloadCost(result).bytes > maxBytes) {
    result = {
      truncated: true,
      continuationHint: `Retry ${method} with a larger token budget or tighter params.`,
    };
    truncated = true;
  }

  return {
    ...response,
    result,
    meta: {
      ...response.meta,
      budget_applied: true,
      budget_truncated: truncated,
      continuation_hint: truncated
        ? `Retry ${method} with a larger token budget or tighter params.`
        : null,
    },
  };
}

/**
 * @param {unknown} value
 * @returns {any}
 */
function cloneJsonValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/**
 * @param {any} value
 * @returns {boolean}
 */
function shrinkForBudget(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }

  if (Array.isArray(value)) {
    if (value.length > 1) {
      const nextLength = Math.max(1, Math.floor(value.length * 0.75));
      value.splice(nextLength);
      return true;
    }
    return value.length === 1 ? shrinkForBudget(value[0]) : false;
  }

  for (const key of ['image', 'html', 'text', 'value']) {
    if (typeof value[key] === 'string' && value[key].length > 64) {
      value[key] = key === 'image'
        ? '[omitted image over token budget]'
        : `${value[key].slice(0, Math.max(32, Math.floor(value[key].length * 0.75) - 1))}\u2026`;
      if (typeof value.truncated !== 'boolean') {
        value.truncated = true;
      }
      return true;
    }
  }

  for (const key of ['nodes', 'entries', 'tabs', 'patches']) {
    if (Array.isArray(value[key]) && value[key].length > 1) {
      const originalLength = value[key].length;
      const nextLength = Math.max(1, Math.floor(originalLength * 0.75));
      value[key].splice(nextLength);
      if (typeof value.count !== 'number') {
        value.count = originalLength;
      }
      if (typeof value.total !== 'number') {
        value.total = originalLength;
      }
      value.truncated = true;
      return true;
    }
  }

  for (const entry of Object.values(value)) {
    if (shrinkForBudget(entry)) {
      if (typeof value.truncated !== 'boolean') {
        value.truncated = true;
      }
      return true;
    }
  }

  const keys = Object.keys(value);
  if (keys.length > 2) {
    delete value[keys[keys.length - 1]];
    value.truncated = true;
    return true;
  }

  return false;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function getErrorMessage(error) {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unexpected extension error.';
}

/**
 * @param {string} message
 * @returns {string}
 */
export function normalizeRuntimeErrorMessage(message) {
  return /^No tab with id[: ]/i.test(message)
    ? ERROR_CODES.TAB_MISMATCH
    : message;
}

/**
 * @param {{ x?: number, y?: number, width?: number, height?: number, scale?: number }} [rect={}]
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function normalizeCropRect(rect = {}) {
  const scale = Number(rect.scale) || 1;
  return {
    x: Math.max(0, Math.round((rect.x || 0) * scale)),
    y: Math.max(0, Math.round((rect.y || 0) * scale)),
    width: Math.max(1, Math.round((rect.width || 1) * scale)),
    height: Math.max(1, Math.round((rect.height || 1) * scale))
  };
}

/**
 * @param {string} url
 * @returns {string}
 */
export function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * @param {string} method
 * @returns {Capability | null}
 */
export function inferCapability(method) {
  if (method === 'page.evaluate') {
    return CAPABILITIES.PAGE_EVALUATE;
  }
  if (method === 'page.get_network') {
    return CAPABILITIES.NETWORK_READ;
  }
  if (method.startsWith('page.')) {
    return CAPABILITIES.PAGE_READ;
  }
  if (method.startsWith('dom.')) {
    return CAPABILITIES.DOM_READ;
  }
  if (method.startsWith('styles.')) {
    return CAPABILITIES.STYLES_READ;
  }
  if (method.startsWith('layout.')) {
    return CAPABILITIES.LAYOUT_READ;
  }
  if (method.startsWith('viewport.')) {
    return CAPABILITIES.VIEWPORT_CONTROL;
  }
  if (method.startsWith('navigation.')) {
    return CAPABILITIES.NAVIGATION_CONTROL;
  }
  if (method.startsWith('input.')) {
    return CAPABILITIES.AUTOMATION_INPUT;
  }
  if (method === 'patch.apply_styles') {
    return CAPABILITIES.PATCH_STYLES;
  }
  if (method.startsWith('patch.')) {
    return CAPABILITIES.PATCH_DOM;
  }
  if (method.startsWith('screenshot.')) {
    return CAPABILITIES.SCREENSHOT_PARTIAL;
  }
  if (method === 'cdp.get_box_model') {
    return CAPABILITIES.CDP_BOX_MODEL;
  }
  if (method === 'cdp.get_computed_styles_for_node') {
    return CAPABILITIES.CDP_STYLES;
  }
  if (method.startsWith('cdp.')) {
    return CAPABILITIES.CDP_DOM_SNAPSHOT;
  }
  if (method.startsWith('performance.')) {
    return CAPABILITIES.PERFORMANCE_READ;
  }
  if (method.startsWith('tabs.') && method !== 'tabs.list') {
    return CAPABILITIES.TABS_MANAGE;
  }
  return null;
}
