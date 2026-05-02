// @ts-check

import {
  createFailure,
  ERROR_CODES,
  estimateJsonPayloadCost,
  getMethodCapability,
  getCostClass,
  getUtf8ByteLength,
  isDebuggerBackedMethod,
  serializeJsonPayload,
} from '../../protocol/src/index.js';

/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */
/** @typedef {import('../../protocol/src/types.js').Capability} Capability */
/** @typedef {import('../../protocol/src/types.js').ErrorCode} ErrorCode */

const INTERACTIVE_AX_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menuitem',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'searchbox',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
]);

const CDP_MODIFIER_BITS = Object.freeze({
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
});

const SPECIAL_KEY_DEFINITIONS = Object.freeze({
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
});

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
    status: tab.status ?? 'unknown',
  };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeCdpModifiers(value) {
  if (value == null) return 0;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 15) {
    return value;
  }
  if (!Array.isArray(value)) {
    throw new Error('modifiers must be an array of Alt, Control, Meta, Shift or a bitmask 0-15.');
  }
  return value.reduce((mask, item) => {
    if (typeof item !== 'string' || !Object.hasOwn(CDP_MODIFIER_BITS, item)) {
      throw new Error('modifiers must contain only Alt, Control, Meta, or Shift.');
    }
    return mask | CDP_MODIFIER_BITS[/** @type {keyof typeof CDP_MODIFIER_BITS} */ (item)];
  }, 0);
}

/**
 * @param {string} key
 * @returns {{ key: string, code: string, windowsVirtualKeyCode: number, text?: string }}
 */
function inferCdpKeyDefinition(key) {
  if (Object.hasOwn(SPECIAL_KEY_DEFINITIONS, key)) {
    return SPECIAL_KEY_DEFINITIONS[/** @type {keyof typeof SPECIAL_KEY_DEFINITIONS} */ (key)];
  }
  if (/^[a-zA-Z]$/.test(key)) {
    const upper = key.toUpperCase();
    return {
      key,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      text: key,
    };
  }
  if (/^[0-9]$/.test(key)) {
    return {
      key,
      code: `Digit${key}`,
      windowsVirtualKeyCode: key.charCodeAt(0),
      text: key,
    };
  }
  if (key.length === 1) {
    return {
      key,
      code: '',
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
      text: key,
    };
  }
  throw new Error(
    'Unsupported key. Use Escape, Enter, Tab, Backspace, arrow keys, or a single character.'
  );
}

/**
 * Build the fixed keyDown/keyUp press pair accepted by CDP
 * Input.dispatchKeyEvent.
 *
 * @param {Record<string, unknown>} params
 * @returns {Array<Record<string, unknown>>}
 */
export function createCdpKeyPressEventPair(params) {
  const rawKey = params.key;
  if (typeof rawKey !== 'string' || rawKey.trim() === '') {
    throw new Error('key must be a non-empty string.');
  }
  const keyDefinition = inferCdpKeyDefinition(rawKey);
  const code =
    typeof params.code === 'string' && params.code.trim() ? params.code : keyDefinition.code;
  const modifiers = normalizeCdpModifiers(params.modifiers);
  const base = {
    key: keyDefinition.key,
    code,
    windowsVirtualKeyCode: keyDefinition.windowsVirtualKeyCode,
    nativeVirtualKeyCode: keyDefinition.windowsVirtualKeyCode,
    modifiers,
  };
  const keyDown = {
    type: 'keyDown',
    ...base,
    ...(keyDefinition.text ? { text: keyDefinition.text, unmodifiedText: keyDefinition.text } : {}),
  };
  return [keyDown, { type: 'keyUp', ...base }];
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
    childIds: Array.isArray(node.childIds) ? node.childIds.map(String) : [],
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

  const result =
    response.result && typeof response.result === 'object'
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
 * @param {string} [serializedPayload]
 * @returns {{
 *   responseBytes: number,
 *   approxTokens: number,
 *   textBytes: number,
 *   textApproxTokens: number,
 *   imageApproxTokens: number,
 *   imageBytes: number,
 *   hasScreenshot: boolean,
 *   nodeCount: number | null
 * }}
 */
export function estimateResponseTokens(response, serializedPayload) {
  const payload = response.ok ? response.result : { error: response.error };
  const payloadJson =
    typeof serializedPayload === 'string' ? serializedPayload : serializeJsonPayload(payload);
  const estimate = estimateJsonPayloadCost(payload, payloadJson);
  const responseBytes = estimate.bytes;
  const result =
    response.ok && response.result && typeof response.result === 'object'
      ? /** @type {Record<string, unknown>} */ (response.result)
      : null;
  const hasScreenshot = result != null && typeof result.image === 'string';
  const nodeCount = result != null && Array.isArray(result.nodes) ? result.nodes.length : null;
  const textPayload = hasScreenshot && result != null ? omitScreenshotImage(result) : payload;
  const textEstimate = estimateJsonPayloadCost(
    textPayload,
    textPayload === payload ? payloadJson : serializeJsonPayload(textPayload)
  );
  const imageTransportBytes = Math.max(0, responseBytes - textEstimate.bytes);
  const imageBytes = hasScreenshot && result != null ? estimateInlineImageBytes(result.image) : 0;

  return {
    responseBytes,
    approxTokens: estimate.approxTokens,
    textBytes: textEstimate.bytes,
    textApproxTokens: textEstimate.approxTokens,
    imageApproxTokens: imageTransportBytes === 0 ? 0 : Math.ceil(imageTransportBytes / 4),
    imageBytes,
    hasScreenshot,
    nodeCount,
  };
}

/**
 * @param {string} method
 * @param {BridgeResponse} response
 * @param {string} [serializedPayload]
 * @returns {{
 *   responseBytes: number,
 *   approxTokens: number,
 *   textBytes: number,
 *   textApproxTokens: number,
 *   imageApproxTokens: number,
 *   imageBytes: number,
 *   hasScreenshot: boolean,
 *   nodeCount: number | null,
 *   costClass: 'cheap' | 'moderate' | 'heavy' | 'extreme',
 *   textCostClass: 'cheap' | 'moderate' | 'heavy' | 'extreme',
 *   debuggerBacked: boolean
 * }}
 */
export function getResponseDiagnostics(method, response, serializedPayload) {
  const estimate = estimateResponseTokens(response, serializedPayload);
  return {
    ...estimate,
    costClass: getCostClass(estimate.approxTokens),
    textCostClass: getCostClass(estimate.textApproxTokens),
    debuggerBacked: isDebuggerBackedMethod(method),
  };
}

/**
 * Keep screenshot metadata while excluding the large inline image payload from
 * token-oriented UI estimates.
 *
 * @param {Record<string, unknown>} result
 * @returns {Record<string, unknown>}
 */
function omitScreenshotImage(result) {
  const textPayload = { ...result };
  delete textPayload.image;
  return textPayload;
}

/**
 * Estimate decoded image bytes for data URLs so the UI can show image size
 * without pretending the base64 blob is text-token traffic.
 *
 * @param {unknown} image
 * @returns {number}
 */
function estimateInlineImageBytes(image) {
  if (typeof image !== 'string' || image.length === 0) {
    return 0;
  }

  const match = /^data:[^;]+;base64,([A-Za-z0-9+/=\s]+)$/u.exec(image);
  if (!match) {
    return getUtf8ByteLength(image);
  }

  const base64 = match[1].replace(/\s+/gu, '');
  if (base64.length === 0) {
    return 0;
  }

  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
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
  if (
    !response.ok ||
    typeof tokenBudget !== 'number' ||
    !Number.isFinite(tokenBudget) ||
    tokenBudget <= 0
  ) {
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
  let iterations = 0;
  const MAX_BUDGET_ITERATIONS = 100;
  while (
    estimateJsonPayloadCost(cloned).bytes > maxBytes &&
    shrinkForBudget(cloned) &&
    iterations < MAX_BUDGET_ITERATIONS
  ) {
    truncated = true;
    iterations += 1;
  }

  let result = cloned;
  const continuationHint = `Retry ${method} with a larger token budget or tighter params.`;
  if (estimateJsonPayloadCost(result).bytes > maxBytes) {
    const compactFallback = {
      truncated: true,
      continuationHint,
    };
    if (estimateJsonPayloadCost(compactFallback).bytes > maxBytes) {
      return createFailure(
        response.id,
        ERROR_CODES.RESULT_TRUNCATED,
        'Result was truncated to fit the response budget.',
        {
          method,
          tokenBudget,
        },
        {
          ...response.meta,
          budget_applied: true,
          budget_truncated: true,
          continuation_hint: continuationHint,
        }
      );
    }
    result = compactFallback;
    truncated = true;
  }

  return {
    ...response,
    result,
    meta: {
      ...response.meta,
      budget_applied: true,
      budget_truncated: truncated,
      continuation_hint: truncated ? continuationHint : null,
    },
  };
}

/**
 * @param {unknown} value
 * @returns {any}
 */
export function cloneJsonValue(value) {
  return value == null ? value : structuredClone(value);
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
      value[key] =
        key === 'image'
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
  const normalizedMessage = message.replace(/^Error:\s*/i, '');
  return /^No tab with id[: ]/i.test(normalizedMessage)
    ? ERROR_CODES.TAB_MISMATCH
    : normalizedMessage;
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
    height: Math.max(1, Math.round((rect.height || 1) * scale)),
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
  return getMethodCapability(
    /** @type {import('../../protocol/src/types.js').BridgeMethod} */ (method)
  );
}
