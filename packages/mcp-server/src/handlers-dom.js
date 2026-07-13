// @ts-check

import {
  applyHtmlBudgetPreset,
  applyTextBudgetPreset,
  applyTreeBudgetPreset,
  dispatchToolAction,
  inferBudgetFromSelector,
  summarizeToolError,
} from './handlers-utils.js';

/** @typedef {import('../../protocol/src/types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('./handlers-utils.js').ToolAction} ToolAction */
/** @typedef {import('./handlers-utils.js').ToolResult} ToolResult */

/** @type {Record<string, ToolAction>} */
export const DOM_ACTIONS = {
  query: {
    ref: false,
    method: 'dom.query',
    params: (a) => ({
      selector: a.selector || 'body',
      withinRef: a.withinRef,
      maxNodes: a.maxNodes,
      maxDepth: a.maxDepth,
      textBudget: a.textBudget,
      includeBbox: a.includeBbox,
      attributeAllowlist: a.attributeAllowlist,
    }),
  },
  describe: {
    ref: true,
    method: 'dom.describe',
    params: (_, r) => ({ elementRef: r }),
  },
  text: {
    ref: true,
    method: 'dom.get_text',
    params: (a, r) => ({ elementRef: r, textBudget: a.textBudget }),
  },
  attributes: {
    ref: true,
    method: 'dom.get_attributes',
    params: (a, r) => ({ elementRef: r, attributes: a.attributes || [] }),
  },
  wait: {
    ref: false,
    method: 'dom.wait_for',
    params: (a) => ({
      selector: a.selector,
      text: a.text,
      state: a.state,
      timeoutMs: a.timeoutMs,
    }),
  },
  find_text: {
    ref: false,
    method: 'dom.find_by_text',
    params: (a) => ({
      text: a.text,
      exact: a.exact,
      selector: a.selector,
      maxResults: a.maxResults,
    }),
  },
  find_role: {
    ref: false,
    method: 'dom.find_by_role',
    params: (a) => ({
      role: a.role,
      name: a.name,
      selector: a.selector,
      maxResults: a.maxResults,
    }),
  },
  html: {
    ref: true,
    method: 'dom.get_html',
    params: (a, r) => ({
      elementRef: r,
      outer: a.outer,
      maxLength: a.maxLength,
    }),
  },
  accessibility_tree: {
    ref: false,
    method: 'dom.get_accessibility_tree',
    params: (a) => ({ maxNodes: a.maxNodes, maxDepth: a.maxDepth }),
  },
};

/**
 * @param {{ action: string, selector?: string, elementRef?: string, withinRef?: string, maxNodes?: number, maxDepth?: number, textBudget?: number, includeBbox?: boolean, attributeAllowlist?: string[], attributes?: string[], text?: string, exact?: boolean, maxResults?: number, role?: string, name?: string, state?: string, timeoutMs?: number, outer?: boolean, maxLength?: number, tabId?: number, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleDomTool(args) {
  if (args.action === 'wait' && !hasText(args.selector) && !hasText(args.text)) {
    return summarizeToolError('selector or text is required for dom.wait_for.');
  }
  if (args.action === 'find_text' && !hasText(args.text)) {
    return summarizeToolError('text is required for dom.find_by_text.');
  }
  if (args.action === 'find_role' && !hasText(args.role)) {
    return summarizeToolError('role is required for dom.find_by_role.');
  }
  if (args.action === 'query' || args.action === 'accessibility_tree') {
    const inferred =
      args.action === 'accessibility_tree' ? 'normal' : inferBudgetFromSelector(args);
    const withBudget = inferred ? { ...args, budgetPreset: args.budgetPreset ?? inferred } : args;
    return dispatchToolAction(DOM_ACTIONS, applyTreeBudgetPreset(withBudget), 'DOM');
  }
  if (args.action === 'text') {
    return dispatchToolAction(DOM_ACTIONS, applyTextBudgetPreset(args), 'DOM');
  }
  if (args.action === 'html') {
    return dispatchToolAction(DOM_ACTIONS, applyHtmlBudgetPreset(args), 'DOM');
  }
  return dispatchToolAction(DOM_ACTIONS, args, 'DOM');
}

/** @type {Record<string, ToolAction>} */
export const STYLES_LAYOUT_ACTIONS = {
  computed: {
    ref: true,
    method: 'styles.get_computed',
    params: (a, r) => ({ elementRef: r, properties: a.properties }),
  },
  matched_rules: {
    ref: true,
    method: 'styles.get_matched_rules',
    params: (_, r) => ({ elementRef: r }),
  },
  box_model: {
    ref: true,
    method: 'layout.get_box_model',
    params: (_, r) => ({ elementRef: r }),
  },
  hit_test: {
    ref: false,
    method: 'layout.hit_test',
    params: (a) => ({ x: a.x, y: a.y }),
  },
};

/**
 * @param {{ action: string, elementRef?: string, selector?: string, properties?: string[], x?: number, y?: number, tabId?: number, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleStylesLayoutTool(args) {
  if (
    args.action === 'hit_test' &&
    (typeof args.x !== 'number' ||
      !Number.isFinite(args.x) ||
      typeof args.y !== 'number' ||
      !Number.isFinite(args.y))
  ) {
    return summarizeToolError('x and y are required for layout.hit_test.');
  }
  return dispatchToolAction(STYLES_LAYOUT_ACTIONS, args, 'styles/layout');
}

/** @type {Record<string, ToolAction>} */
export const PATCH_ACTIONS = {
  apply_styles: {
    ref: true,
    method: 'patch.apply_styles',
    params: (a, r) => ({
      target: { elementRef: r },
      declarations: a.declarations,
      important: a.important,
      patchId: a.patchId,
      verify: a.verify,
    }),
  },
  apply_dom: {
    ref: true,
    method: 'patch.apply_dom',
    params: (a, r) => {
      const operation = typeof a.operation === 'string' ? a.operation : '';
      /** @type {Record<string, string>} */
      const opMap = {
        setAttribute: 'set_attribute',
        removeAttribute: 'remove_attribute',
        addClass: 'add_class',
        removeClass: 'remove_class',
        setTextContent: 'set_text',
      };
      const normalizedOperation = opMap[operation] || operation;
      const value =
        normalizedOperation === 'add_class' || normalizedOperation === 'remove_class'
          ? (a.value ?? a.name)
          : a.value;
      return {
        target: { elementRef: r },
        operation: normalizedOperation,
        value,
        name: a.name,
        patchId: a.patchId,
        verify: a.verify,
      };
    },
  },
  list: { ref: false, method: 'patch.list', params: () => ({}) },
  rollback: {
    ref: false,
    method: 'patch.rollback',
    params: (a) => ({ patchId: a.patchId }),
  },
  commit_baseline: {
    ref: false,
    method: 'patch.commit_session_baseline',
    params: () => ({}),
  },
};

/**
 * @param {{ action: string, elementRef?: string, selector?: string, declarations?: Record<string, string>, important?: boolean, operation?: string, value?: unknown, name?: string, patchId?: string, verify?: boolean, tabId?: number, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
 * @returns {Promise<ToolResult>}
 */
export async function handlePatchTool(args) {
  if (args.action === 'apply_styles' && !hasStringRecord(args.declarations)) {
    return summarizeToolError('declarations are required for patch.apply_styles.');
  }
  if (args.action === 'apply_dom' && !hasText(args.operation)) {
    return summarizeToolError('operation is required for patch.apply_dom.');
  }
  if (args.action === 'rollback' && !hasText(args.patchId)) {
    return summarizeToolError('patchId is required for patch.rollback.');
  }
  return dispatchToolAction(PATCH_ACTIONS, args, 'patch');
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
 * @returns {value is Record<string, string>}
 */
function hasStringRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(/** @type {Record<string, unknown>} */ (value));
  return entries.length > 0 && entries.every(([key, val]) => key.trim() && typeof val === 'string');
}
