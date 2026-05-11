// @ts-check

import {
  applyHtmlBudgetPreset,
  applyTextBudgetPreset,
  applyTreeBudgetPreset,
  dispatchToolAction,
  inferBudgetFromSelector,
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
  if (args.action === 'query' || args.action === 'accessibility_tree') {
    const inferred = inferBudgetFromSelector(args);
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
        setProperty: 'set_attribute',
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
  return dispatchToolAction(PATCH_ACTIONS, args, 'patch');
}
