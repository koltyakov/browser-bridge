export type Budget = import('./types.js').Budget;
export type BudgetOptions = import('./types.js').BudgetOptions;

import { DEFAULT_MAX_DEPTH, DEFAULT_MAX_NODES, DEFAULT_TEXT_BUDGET } from './defaults.js';

export function applyBudget(options: BudgetOptions = {}): Budget {
  return {
    maxNodes: clamp(options.maxNodes ?? DEFAULT_MAX_NODES, 1, 250),
    maxDepth: clamp(options.maxDepth ?? DEFAULT_MAX_DEPTH, 1, 20),
    textBudget: clamp(options.textBudget ?? DEFAULT_TEXT_BUDGET, 32, 10000),
    includeBbox: options.includeBbox !== false,
    attributeAllowlist: normalizeList(options.attributeAllowlist),
  };
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((item) => typeof item === 'string' && item.trim()))];
}

function clamp(
  value: number | string | null | undefined,
  minimum: number,
  maximum: number
): number {
  return Math.min(Math.max(Number(value) || minimum, minimum), maximum);
}
