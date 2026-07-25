// @ts-check

/**
 * Shared budget-preset merge helpers. Presets fill gaps in method params;
 * explicit per-call params always win. Used by both the MCP server and the
 * agent CLI so `budgetPreset`/`--preset` behave identically.
 */

import {
  DEFAULT_CONSOLE_LIMIT,
  DEFAULT_HAR_LIMIT,
  DEFAULT_LOG_TAIL_LIMIT,
  DEFAULT_MAX_HTML_LENGTH,
  DEFAULT_NETWORK_LIMIT,
  DEFAULT_PAGE_TEXT_BUDGET,
  getBudgetPreset,
  isBudgetPresetName,
} from './defaults.js';

/**
 * @param {unknown} value
 * @returns {import('./defaults.js').BudgetPresetName | null}
 */
export function getBudgetPresetName(value) {
  return isBudgetPresetName(value) ? value : null;
}

/**
 * @template {{ budgetPreset?: unknown, maxNodes?: unknown, maxDepth?: unknown, textBudget?: unknown }} T
 * @param {T} args
 * @returns {T}
 */
export function applyTreeBudgetPreset(args) {
  const presetName = getBudgetPresetName(args.budgetPreset);
  if (!presetName) {
    return args;
  }
  const preset = getBudgetPreset(presetName);
  return /** @type {T} */ ({
    ...args,
    maxNodes: args.maxNodes ?? preset.maxNodes,
    maxDepth: args.maxDepth ?? preset.maxDepth,
    textBudget: args.textBudget ?? preset.textBudget,
  });
}

/**
 * @template {{ budgetPreset?: unknown, textBudget?: unknown }} T
 * @param {T} args
 * @returns {T}
 */
export function applyTextBudgetPreset(args) {
  const presetName = getBudgetPresetName(args.budgetPreset);
  if (!presetName) {
    return args;
  }
  const preset = getBudgetPreset(presetName);
  return /** @type {T} */ ({
    ...args,
    textBudget: args.textBudget ?? preset.textBudget,
  });
}

/**
 * @template {{ budgetPreset?: unknown, textBudget?: unknown }} T
 * @param {T} args
 * @returns {T}
 */
export function applyPageTextBudgetPreset(args) {
  const presetName = getBudgetPresetName(args.budgetPreset);
  if (!presetName) {
    return args;
  }
  const textBudgetByPreset = {
    quick: 2000,
    normal: DEFAULT_PAGE_TEXT_BUDGET,
    deep: DEFAULT_PAGE_TEXT_BUDGET * 2,
  };
  return /** @type {T} */ ({
    ...args,
    textBudget: args.textBudget ?? textBudgetByPreset[presetName],
  });
}

/**
 * @template {{ budgetPreset?: unknown, limit?: unknown }} T
 * @param {T} args
 * @param {{ quick: number, normal: number, deep: number }} defaults
 * @returns {T}
 */
export function applyLimitBudgetPreset(args, defaults) {
  const presetName = getBudgetPresetName(args.budgetPreset);
  if (!presetName) {
    return args;
  }
  return /** @type {T} */ ({
    ...args,
    limit: args.limit ?? defaults[presetName],
  });
}

/**
 * @template {{ budgetPreset?: unknown, maxLength?: unknown }} T
 * @param {T} args
 * @returns {T}
 */
export function applyHtmlBudgetPreset(args) {
  const presetName = getBudgetPresetName(args.budgetPreset);
  if (!presetName) {
    return args;
  }
  const maxLengthByPreset = {
    quick: 600,
    normal: DEFAULT_MAX_HTML_LENGTH,
    deep: 6000,
  };
  return /** @type {T} */ ({
    ...args,
    maxLength: args.maxLength ?? maxLengthByPreset[presetName],
  });
}

/**
 * Apply a preset to method parameters before dispatch. Explicit method params
 * always win over preset defaults.
 *
 * @param {import('./types.js').BridgeMethod} method
 * @param {Record<string, unknown>} params
 * @param {unknown} budgetPreset
 * @returns {Record<string, unknown>}
 */
export function applyMethodBudgetPreset(method, params, budgetPreset) {
  const args = { ...params, budgetPreset };
  /** @type {Record<string, unknown>} */
  let normalized = args;
  if (
    method === 'dom.query' ||
    method === 'dom.get_accessibility_tree' ||
    method === 'dom.baseline.create'
  ) {
    normalized = applyTreeBudgetPreset(args);
  } else if (method === 'dom.baseline.compare') {
    const preset = getBudgetPresetName(budgetPreset);
    const defaults = { quick: 10, normal: 50, deep: 100 };
    normalized = {
      ...args,
      maxChanges: params.maxChanges ?? (preset ? defaults[preset] : undefined),
    };
  } else if (method === 'dom.get_text') {
    normalized = applyTextBudgetPreset(args);
  } else if (method === 'dom.get_html') {
    normalized = applyHtmlBudgetPreset(args);
  } else if (method === 'page.get_text' || method === 'page.extract_content') {
    normalized = applyPageTextBudgetPreset(args);
  } else if (method === 'page.get_console') {
    normalized = applyLimitBudgetPreset(args, {
      quick: 10,
      normal: DEFAULT_CONSOLE_LIMIT,
      deep: 100,
    });
  } else if (method === 'page.get_network') {
    normalized = applyLimitBudgetPreset(args, {
      quick: 10,
      normal: DEFAULT_NETWORK_LIMIT,
      deep: 100,
    });
  } else if (method === 'network.export_har') {
    normalized = applyLimitBudgetPreset(args, {
      quick: 20,
      normal: DEFAULT_HAR_LIMIT,
      deep: 100,
    });
  } else if (method === 'log.tail') {
    normalized = applyLimitBudgetPreset(args, {
      quick: 10,
      normal: DEFAULT_LOG_TAIL_LIMIT,
      deep: 100,
    });
  }
  const { budgetPreset: _budgetPreset, ...methodParams } = normalized;
  return methodParams;
}
