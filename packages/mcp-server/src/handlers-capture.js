// @ts-check

import { BridgeError } from '../../protocol/src/index.js';
import {
  createToolResult,
  getToolTokenBudget,
  REQUEST_SOURCE,
  requestBridgeWithRetry,
  resolveToolRef,
  summarizeToolError,
  summarizeToolResponse,
  withToolClient,
} from './handlers-utils.js';

/** @typedef {import('../../protocol/src/types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */
/** @typedef {import('./handlers-utils.js').ToolAction} ToolAction */
/** @typedef {import('./handlers-utils.js').ToolResult} ToolResult */

/** @type {Record<string, ToolAction>} */
export const CAPTURE_ACTIONS = {
  element: {
    ref: true,
    method: 'screenshot.capture_element',
    params: (_, r) => ({ elementRef: r }),
  },
  region: {
    ref: false,
    method: 'screenshot.capture_region',
    params: (a) => /** @type {Record<string, unknown>} */ (a.rect || {}),
  },
  full_page: {
    ref: false,
    method: 'screenshot.capture_full_page',
    params: () => ({}),
  },
  cdp_document: { ref: false, method: 'cdp.get_document', params: () => ({}) },
  cdp_dom_snapshot: {
    ref: false,
    method: 'cdp.get_dom_snapshot',
    params: () => ({}),
  },
  cdp_box_model: {
    ref: false,
    method: 'cdp.get_box_model',
    params: (a) => ({ nodeId: a.nodeId }),
  },
  cdp_computed_styles: {
    ref: false,
    method: 'cdp.get_computed_styles_for_node',
    params: (a) => ({ nodeId: a.nodeId }),
  },
};

/** @param {Record<string, unknown>} args */
function isCdpNodeCapture(args) {
  return args.action === 'cdp_box_model' || args.action === 'cdp_computed_styles';
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** @param {unknown} rect */
function isValidCaptureRegion(rect) {
  if (!rect || typeof rect !== 'object' || Array.isArray(rect)) {
    return false;
  }
  const candidate = /** @type {Record<string, unknown>} */ (rect);
  return (
    isFiniteNumber(candidate.x) &&
    isFiniteNumber(candidate.y) &&
    isFiniteNumber(candidate.width) &&
    candidate.width > 0 &&
    isFiniteNumber(candidate.height) &&
    candidate.height > 0
  );
}

/**
 * @param {{ action: string, elementRef?: string, selector?: string, rect?: Record<string, unknown>, nodeId?: number, tabId?: number, destinationId?: string, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleCaptureTool(args) {
  if (args.action === 'region' && !isValidCaptureRegion(args.rect)) {
    return summarizeToolError(
      'rect with finite x, y, width, and height is required for region capture.'
    );
  }
  if (
    isCdpNodeCapture(args) &&
    (typeof args.nodeId !== 'number' || !Number.isFinite(args.nodeId))
  ) {
    return summarizeToolError('nodeId must be a finite number.');
  }

  const entry = CAPTURE_ACTIONS[args.action];
  if (!entry) {
    return summarizeToolError(`Unsupported capture action "${args.action}".`);
  }

  return withToolClient(
    async (client) => {
      const requestedTabId = typeof args.tabId === 'number' ? args.tabId : null;
      const ref = entry.ref ? await resolveToolRef(client, args, requestedTabId) : undefined;
      const response = await requestBridgeWithRetry(client, entry.method, entry.params(args, ref), {
        tabId: requestedTabId,
        source: REQUEST_SOURCE,
        tokenBudget: entry.method.startsWith('screenshot.') ? null : getToolTokenBudget(args),
      });
      if (!response.ok) {
        return summarizeToolResponse(response, entry.method);
      }
      return entry.method.startsWith('screenshot.')
        ? createScreenshotResult(response, entry.method)
        : createCdpCaptureResult(response, entry.method);
    },
    { destinationId: args.destinationId ?? null }
  );
}

/**
 * @param {BridgeResponse & { ok: true }} response
 * @param {BridgeMethod} method
 * @returns {ToolResult}
 */
export function createScreenshotResult(response, method) {
  const result = toRecord(response.result);
  if (typeof result.image !== 'string') {
    return summarizeToolError(new Error(`${method} returned no image data.`));
  }

  const image = normalizeBase64Image(result.image);
  if (!image) {
    return summarizeToolError(new Error(`${method} returned invalid base64 image data.`));
  }

  const rect = boundedRect(result.rect);
  return createToolResult(
    `Captured ${image.mimeType} screenshot (${image.byteLength} bytes).`,
    {
      ok: true,
      method,
      mimeType: image.mimeType,
      byteLength: image.byteLength,
      ...(rect ? { rect } : {}),
    },
    false,
    [{ type: 'image', data: image.data, mimeType: image.mimeType }]
  );
}

/**
 * @param {BridgeResponse & { ok: true }} response
 * @param {BridgeMethod} method
 * @returns {ToolResult}
 */
function createCdpCaptureResult(response, method) {
  const bounded = boundStructuredValue(response.result);
  return createToolResult(`Captured bounded structured data from ${method}.`, {
    ok: true,
    method,
    data: bounded.value,
    truncated: bounded.truncated,
  });
}

/**
 * @param {string} value
 * @returns {{ data: string, mimeType: string, byteLength: number } | null}
 */
function normalizeBase64Image(value) {
  const dataUrl = /^data:([^;,]+);base64,(.*)$/su.exec(value);
  const mimeType = dataUrl?.[1] ?? 'image/png';
  if (!mimeType.startsWith('image/')) return null;
  const data = (dataUrl?.[2] ?? value).replace(/\s+/gu, '');
  if (!data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) {
    return null;
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) return null;
  return { data, mimeType, byteLength: bytes.length };
}

/**
 * @param {unknown} value
 * @returns {Record<string, number> | null}
 */
function boundedRect(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = /** @type {Record<string, unknown>} */ (value);
  /** @type {Record<string, number>} */
  const rect = {};
  for (const key of ['x', 'y', 'width', 'height', 'scale']) {
    if (isFiniteNumber(source[key])) rect[key] = source[key];
  }
  return Object.keys(rect).length > 0 ? rect : null;
}

/**
 * Bound debugger payloads by depth, entries, and string length while retaining
 * their actual values rather than reducing them to field names.
 *
 * @param {unknown} input
 * @returns {{ value: unknown, truncated: boolean }}
 */
function boundStructuredValue(input) {
  const state = { entries: 0, characters: 0, truncated: false };
  const maxEntries = 500;
  const maxCharacters = 50_000;
  /** @type {(value: unknown, depth: number) => unknown} */
  const visit = (value, depth) => {
    if (state.entries >= maxEntries || state.characters >= maxCharacters || depth > 8) {
      state.truncated = true;
      return '[truncated]';
    }
    state.entries += 1;
    if (typeof value === 'string') {
      const remaining = maxCharacters - state.characters;
      const limit = Math.min(value.length, remaining, 4000);
      state.characters += limit;
      if (limit === value.length) return value;
      state.truncated = true;
      return `${value.slice(0, limit)}[truncated]`;
    }
    if (Array.isArray(value)) {
      const remaining = maxEntries - state.entries;
      const limit = Math.min(value.length, remaining, 100);
      if (limit < value.length) state.truncated = true;
      return value.slice(0, limit).map((entry) => visit(entry, depth + 1));
    }
    if (value && typeof value === 'object') {
      /** @type {Record<string, unknown>} */
      const output = {};
      const entries = Object.entries(/** @type {Record<string, unknown>} */ (value));
      const limit = Math.min(entries.length, 100);
      if (limit < entries.length) state.truncated = true;
      for (const [key, entry] of entries.slice(0, limit)) {
        if (state.entries >= maxEntries || state.characters >= maxCharacters) {
          state.truncated = true;
          break;
        }
        state.characters += key.length;
        output[key] = visit(entry, depth + 1);
      }
      return output;
    }
    return value;
  };
  return { value: visit(input, 0), truncated: state.truncated };
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function toRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @type {Record<string, BridgeMethod>} */
export const INPUT_ACTION_METHODS = {
  click: 'input.click',
  focus: 'input.focus',
  type: 'input.type',
  fill: 'input.fill',
  press_key: 'input.press_key',
  cdp_press_key: 'cdp.dispatch_key_event',
  set_checked: 'input.set_checked',
  select_option: 'input.select_option',
  hover: 'input.hover',
  drag: 'input.drag',
  scroll_into_view: 'input.scroll_into_view',
};

/**
 * Keep selector-based actions atomic instead of resolving a ref in a separate
 * bridge request that can race with a page rerender.
 *
 * @param {unknown} elementRef
 * @param {unknown} selector
 * @returns {import('../../protocol/src/types.js').InputTarget | null}
 */
function createInputTarget(elementRef, selector) {
  if (typeof elementRef === 'string' && elementRef) return { elementRef };
  if (typeof selector === 'string' && selector) return { selector };
  return null;
}

/**
 * @param {{ action: string, elementRef?: string, selector?: string, button?: string, clickCount?: number, text?: string, value?: string, mode?: 'auto' | 'setter' | 'keystrokes', clear?: boolean, submit?: boolean, key?: string, code?: string, modifiers?: string[], checked?: boolean, values?: string[], labels?: string[], indexes?: number[], duration?: number, sourceElementRef?: string, sourceSelector?: string, destinationElementRef?: string, destinationSelector?: string, offsetX?: number, offsetY?: number, tabId?: number, destinationId?: string, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleInputTool(args) {
  if (args.action === 'type' && !hasText(args.text)) {
    return summarizeToolError('text is required for input.type.');
  }
  if (args.action === 'fill' && typeof args.value !== 'string') {
    return summarizeToolError('value is required for input.fill.');
  }
  if ((args.action === 'press_key' || args.action === 'cdp_press_key') && !hasText(args.key)) {
    return summarizeToolError('key is required for key input actions.');
  }
  if (
    args.action === 'select_option' &&
    !hasNonEmptyArray(args.values) &&
    !hasNonEmptyArray(args.labels) &&
    !hasNonEmptyArray(args.indexes)
  ) {
    return summarizeToolError('values, labels, or indexes are required for input.select_option.');
  }

  return withToolClient(
    async (client) => {
      const requestedTabId = typeof args.tabId === 'number' ? args.tabId : null;
      const elementTarget = () => {
        const target = createInputTarget(args.elementRef, args.selector);
        if (!target) {
          throw new BridgeError('INVALID_REQUEST', 'Provide either elementRef or selector.');
        }
        return target;
      };

      switch (args.action) {
        case 'click': {
          const response = await requestBridgeWithRetry(
            client,
            'input.click',
            {
              target: elementTarget(),
              button: args.button,
              clickCount: args.clickCount,
              modifiers: args.modifiers,
            },
            {
              tabId: requestedTabId,
              source: REQUEST_SOURCE,
              tokenBudget: getToolTokenBudget(args),
            }
          );
          return summarizeToolResponse(response, 'input.click');
        }
        case 'focus': {
          const response = await requestBridgeWithRetry(
            client,
            'input.focus',
            {
              target: elementTarget(),
            },
            {
              tabId: requestedTabId,
              source: REQUEST_SOURCE,
              tokenBudget: getToolTokenBudget(args),
            }
          );
          return summarizeToolResponse(response, 'input.focus');
        }
        case 'type': {
          const response = await requestBridgeWithRetry(
            client,
            'input.type',
            {
              target: elementTarget(),
              text: args.text,
              clear: args.clear,
              submit: args.submit,
              modifiers: args.modifiers,
            },
            {
              tabId: requestedTabId,
              source: REQUEST_SOURCE,
              tokenBudget: getToolTokenBudget(args),
            }
          );
          return summarizeToolResponse(response, 'input.type');
        }
        case 'fill': {
          const response = await requestBridgeWithRetry(
            client,
            'input.fill',
            {
              target: elementTarget(),
              value: args.value,
              mode: args.mode,
            },
            {
              tabId: requestedTabId,
              source: REQUEST_SOURCE,
              tokenBudget: getToolTokenBudget(args),
            }
          );
          return summarizeToolResponse(response, 'input.fill');
        }
        case 'press_key': {
          const target = args.elementRef || args.selector ? elementTarget() : undefined;
          const response = await requestBridgeWithRetry(
            client,
            'input.press_key',
            {
              target,
              key: args.key,
              modifiers: args.modifiers,
            },
            {
              tabId: requestedTabId,
              source: REQUEST_SOURCE,
              tokenBudget: getToolTokenBudget(args),
            }
          );
          return summarizeToolResponse(response, 'input.press_key');
        }
        case 'cdp_press_key': {
          const response = await requestBridgeWithRetry(
            client,
            'cdp.dispatch_key_event',
            {
              key: args.key,
              code: args.code,
              modifiers: args.modifiers,
            },
            {
              tabId: requestedTabId,
              source: REQUEST_SOURCE,
              tokenBudget: getToolTokenBudget(args),
            }
          );
          return summarizeToolResponse(response, 'cdp.dispatch_key_event');
        }
        case 'set_checked': {
          const response = await requestBridgeWithRetry(
            client,
            'input.set_checked',
            {
              target: elementTarget(),
              checked: args.checked,
            },
            {
              tabId: requestedTabId,
              source: REQUEST_SOURCE,
              tokenBudget: getToolTokenBudget(args),
            }
          );
          return summarizeToolResponse(response, 'input.set_checked');
        }
        case 'select_option': {
          const response = await requestBridgeWithRetry(
            client,
            'input.select_option',
            {
              target: elementTarget(),
              values: args.values,
              labels: args.labels,
              indexes: args.indexes,
            },
            {
              tabId: requestedTabId,
              source: REQUEST_SOURCE,
              tokenBudget: getToolTokenBudget(args),
            }
          );
          return summarizeToolResponse(response, 'input.select_option');
        }
        case 'hover': {
          const response = await requestBridgeWithRetry(
            client,
            'input.hover',
            {
              target: elementTarget(),
              duration: args.duration,
              modifiers: args.modifiers,
            },
            {
              tabId: requestedTabId,
              source: REQUEST_SOURCE,
              tokenBudget: getToolTokenBudget(args),
            }
          );
          return summarizeToolResponse(response, 'input.hover');
        }
        case 'drag': {
          const source = createInputTarget(args.sourceElementRef, args.sourceSelector);
          const destination = createInputTarget(
            args.destinationElementRef,
            args.destinationSelector
          );
          if (!source || !destination) {
            return summarizeToolError(
              'sourceElementRef/sourceSelector and destinationElementRef/destinationSelector are required for drag.'
            );
          }
          const response = await requestBridgeWithRetry(
            client,
            'input.drag',
            {
              source,
              destination,
              offsetX: args.offsetX,
              offsetY: args.offsetY,
            },
            {
              tabId: requestedTabId,
              source: REQUEST_SOURCE,
              tokenBudget: getToolTokenBudget(args),
            }
          );
          return summarizeToolResponse(response, 'input.drag');
        }
        case 'scroll_into_view': {
          const response = await requestBridgeWithRetry(
            client,
            'input.scroll_into_view',
            {
              target: elementTarget(),
            },
            {
              tabId: requestedTabId,
              source: REQUEST_SOURCE,
              tokenBudget: getToolTokenBudget(args),
            }
          );
          return summarizeToolResponse(response, 'input.scroll_into_view');
        }
        default:
          return summarizeToolError(`Unsupported input action "${args.action}".`);
      }
    },
    { destinationId: args.destinationId ?? null }
  );
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}
