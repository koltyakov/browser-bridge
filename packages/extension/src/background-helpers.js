// @ts-check

import { CAPABILITIES, ERROR_CODES } from '../../protocol/src/index.js';

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
    'tabs.list',
    'session.get_status'
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

  if (result.revoked === true) {
    return 'Session revoked.';
  }

  if (typeof result.sessionId === 'string') {
    return 'Session ready.';
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
  const resultJson = response.ok ? JSON.stringify(response.result) : '';
  const responseBytes = resultJson.length;
  const result = response.ok && response.result && typeof response.result === 'object'
    ? /** @type {Record<string, unknown>} */ (response.result)
    : null;
  const hasScreenshot = result != null && typeof result.image === 'string';
  const nodeCount = result != null && Array.isArray(result.nodes) ? result.nodes.length : null;

  let approxTokens;
  if (hasScreenshot && typeof result.image === 'string') {
    const imageLength = result.image.length;
    const otherBytes = responseBytes - imageLength;
    approxTokens = Math.ceil(otherBytes / 4 + imageLength / 6);
  } else {
    approxTokens = Math.ceil(responseBytes / 4);
  }

  return { responseBytes, approxTokens, hasScreenshot, nodeCount };
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
