// @ts-check

import {
  dispatchToolAction,
  getToolTokenBudget,
  REQUEST_SOURCE,
  requestBridgeWithRetry,
  resolveToolRef,
  resolveRef,
  summarizeToolError,
  summarizeToolResponse,
  withToolClient,
} from './handlers-utils.js';

/** @typedef {import('../../protocol/src/types.js').BridgeMethod} BridgeMethod */
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
 * @param {{ action: string, elementRef?: string, selector?: string, rect?: Record<string, unknown>, nodeId?: number, tabId?: number, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
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

  return dispatchToolAction(CAPTURE_ACTIONS, args, 'capture');
}

/** @type {Record<string, BridgeMethod>} */
export const INPUT_ACTION_METHODS = {
  click: 'input.click',
  focus: 'input.focus',
  type: 'input.type',
  press_key: 'input.press_key',
  cdp_press_key: 'cdp.dispatch_key_event',
  set_checked: 'input.set_checked',
  select_option: 'input.select_option',
  hover: 'input.hover',
  drag: 'input.drag',
  scroll_into_view: 'input.scroll_into_view',
};

/**
 * @param {{ action: string, elementRef?: string, selector?: string, button?: string, clickCount?: number, text?: string, clear?: boolean, submit?: boolean, key?: string, code?: string, modifiers?: string[], checked?: boolean, values?: string[], labels?: string[], indexes?: number[], duration?: number, sourceElementRef?: string, sourceSelector?: string, destinationElementRef?: string, destinationSelector?: string, offsetX?: number, offsetY?: number, tabId?: number, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleInputTool(args) {
  if (args.action === 'type' && !hasText(args.text)) {
    return summarizeToolError('text is required for input.type.');
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

  return withToolClient(async (client) => {
    const requestedTabId = typeof args.tabId === 'number' ? args.tabId : null;
    const elementTarget = async () => ({
      elementRef: await resolveToolRef(client, args, requestedTabId),
    });

    switch (args.action) {
      case 'click': {
        const response = await requestBridgeWithRetry(
          client,
          'input.click',
          {
            target: await elementTarget(),
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
            target: await elementTarget(),
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
            target: await elementTarget(),
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
      case 'press_key': {
        const target = args.elementRef || args.selector ? await elementTarget() : undefined;
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
            target: await elementTarget(),
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
            target: await elementTarget(),
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
            target: await elementTarget(),
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
        const source = {
          elementRef:
            args.sourceElementRef ||
            (args.sourceSelector
              ? await resolveRef(client, args.sourceSelector, requestedTabId, REQUEST_SOURCE)
              : ''),
        };
        const destination = {
          elementRef:
            args.destinationElementRef ||
            (args.destinationSelector
              ? await resolveRef(client, args.destinationSelector, requestedTabId, REQUEST_SOURCE)
              : ''),
        };
        if (!source.elementRef || !destination.elementRef) {
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
            target: await elementTarget(),
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
  });
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
