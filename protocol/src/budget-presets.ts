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

export function getBudgetPresetName(
  value: unknown
): import('./defaults.js').BudgetPresetName | null {
  return isBudgetPresetName(value) ? value : null;
}

export function applyTreeBudgetPreset<
  T extends {
    budgetPreset?: unknown;
    maxNodes?: unknown;
    maxDepth?: unknown;
    textBudget?: unknown;
  },
>(args: T): T {
  const presetName = getBudgetPresetName(args.budgetPreset);
  if (!presetName) {
    return args;
  }
  const preset = getBudgetPreset(presetName);
  return {
    ...args,
    maxNodes: args.maxNodes ?? preset.maxNodes,
    maxDepth: args.maxDepth ?? preset.maxDepth,
    textBudget: args.textBudget ?? preset.textBudget,
  } as T;
}

export function applyTextBudgetPreset<T extends { budgetPreset?: unknown; textBudget?: unknown }>(
  args: T
): T {
  const presetName = getBudgetPresetName(args.budgetPreset);
  if (!presetName) {
    return args;
  }
  const preset = getBudgetPreset(presetName);
  return {
    ...args,
    textBudget: args.textBudget ?? preset.textBudget,
  } as T;
}

export function applyPageTextBudgetPreset<
  T extends { budgetPreset?: unknown; textBudget?: unknown },
>(args: T): T {
  const presetName = getBudgetPresetName(args.budgetPreset);
  if (!presetName) {
    return args;
  }
  const textBudgetByPreset = {
    quick: 2000,
    normal: DEFAULT_PAGE_TEXT_BUDGET,
    deep: DEFAULT_PAGE_TEXT_BUDGET * 2,
  };
  return {
    ...args,
    textBudget: args.textBudget ?? textBudgetByPreset[presetName],
  } as T;
}

export function applyLimitBudgetPreset<T extends { budgetPreset?: unknown; limit?: unknown }>(
  args: T,
  defaults: { quick: number; normal: number; deep: number }
): T {
  const presetName = getBudgetPresetName(args.budgetPreset);
  if (!presetName) {
    return args;
  }
  return {
    ...args,
    limit: args.limit ?? defaults[presetName],
  } as T;
}

export function applyHtmlBudgetPreset<T extends { budgetPreset?: unknown; maxLength?: unknown }>(
  args: T
): T {
  const presetName = getBudgetPresetName(args.budgetPreset);
  if (!presetName) {
    return args;
  }
  const maxLengthByPreset = {
    quick: 600,
    normal: DEFAULT_MAX_HTML_LENGTH,
    deep: 6000,
  };
  return {
    ...args,
    maxLength: args.maxLength ?? maxLengthByPreset[presetName],
  } as T;
}

/** Apply a preset to method parameters before dispatch. Explicit method params
always win over preset defaults. */
export function applyMethodBudgetPreset(
  method: import('./types.js').BridgeMethod,
  params: Record<string, unknown>,
  budgetPreset: unknown
): Record<string, unknown> {
  const args = { ...params, budgetPreset };

  let normalized: Record<string, unknown> = args;
  if (method === 'webmcp.list_tools') {
    normalized = applyLimitBudgetPreset(args, { quick: 5, normal: 20, deep: 100 });
  } else if (
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
