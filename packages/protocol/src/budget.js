// @ts-check

/** @typedef {import('./types.js').Budget} Budget */
/** @typedef {import('./types.js').BudgetOptions} BudgetOptions */
/** @typedef {import('./types.js').TruncateResult} TruncateResult */

const DEFAULT_TEXT_BUDGET = 600;
const DEFAULT_MAX_NODES = 25;
const DEFAULT_MAX_DEPTH = 4;

/**
 * @param {BudgetOptions} [options={}]
 * @returns {Budget}
 */
export function applyBudget(options = {}) {
  return {
    maxNodes: clamp(options.maxNodes ?? DEFAULT_MAX_NODES, 1, 250),
    maxDepth: clamp(options.maxDepth ?? DEFAULT_MAX_DEPTH, 1, 20),
    textBudget: clamp(options.textBudget ?? DEFAULT_TEXT_BUDGET, 32, 10000),
    includeHtml: Boolean(options.includeHtml),
    includeScreenshot: Boolean(options.includeScreenshot),
    attributeAllowlist: normalizeList(options.attributeAllowlist),
    styleAllowlist: normalizeList(options.styleAllowlist)
  };
}

/**
 * @param {string} value
 * @param {number} budget
 * @returns {TruncateResult}
 */
export function truncateText(value, budget) {
  if (!value) {
    return { value: '', truncated: false, omitted: 0 };
  }

  if (value.length <= budget) {
    return { value, truncated: false, omitted: 0 };
  }

  return {
    value: `${value.slice(0, Math.max(0, budget - 1))}\u2026`,
    truncated: true,
    omitted: value.length - budget
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} source
 * @param {string[]} [fields=[]]
 * @returns {Record<string, unknown>}
 */
export function summarizeFields(source, fields = []) {
  if (!source || typeof source !== 'object') {
    return {};
  }

  return fields.reduce((accumulator, field) => {
    if (field in source && source[field] != null) {
      accumulator[field] = source[field];
    }
    return accumulator;
  }, {});
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((item) => typeof item === 'string' && item.trim()))];
}

/**
 * @param {number | string | null | undefined} value
 * @param {number} minimum
 * @param {number} maximum
 * @returns {number}
 */
function clamp(value, minimum, maximum) {
  return Math.min(Math.max(Number(value) || minimum, minimum), maximum);
}
