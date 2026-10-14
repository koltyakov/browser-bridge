// @ts-check

import { BridgeError, ERROR_CODES } from './errors.js';

/** @typedef {import('./types.js').TabPagination} TabPagination */

/**
 * Preserve unpaged raw listings, while allowing bounded pages when requested.
 * @param {Record<string, unknown>} params
 * @returns {{ offset: number, limit: number | null }}
 */
export function normalizeTabListParams(params) {
  const offset = params.offset === undefined ? 0 : params.offset;
  const limit =
    params.limit === undefined ? (params.offset === undefined ? null : 10) : params.limit;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'tabs.list offset must be a non-negative integer.'
    );
  }
  if (
    (params.limit !== undefined || limit !== null) &&
    (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)
  ) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'tabs.list limit must be an integer from 1 to 100.'
    );
  }
  return { offset, limit };
}

/**
 * @param {number} totalCount
 * @param {number} returnedCount
 * @param {number} offset
 * @returns {TabPagination}
 */
export function describeTabPage(totalCount, returnedCount, offset) {
  return {
    totalCount,
    returnedCount,
    offset,
    omittedCount: Math.max(0, totalCount - returnedCount),
    truncated: returnedCount < totalCount,
    nextOffset: offset + returnedCount < totalCount ? offset + returnedCount : null,
  };
}

/**
 * @template T
 * @param {T[]} tabs
 * @param {Record<string, unknown>} [params]
 * @returns {{ tabs: T[], pagination: TabPagination }}
 */
export function paginateTabList(tabs, params = {}) {
  const { offset, limit } = normalizeTabListParams(params);
  const sorted = [...tabs].sort((left, right) => {
    /** @param {unknown} tab @returns {number} */
    const priority = (tab) => {
      const record =
        tab && typeof tab === 'object' ? /** @type {Record<string, unknown>} */ (tab) : {};
      return Number(record.working === true || record.active === true);
    };
    return priority(right) - priority(left);
  });
  const page = sorted.slice(offset, limit === null ? undefined : offset + limit);
  return { tabs: page, pagination: describeTabPage(tabs.length, page.length, offset) };
}

/** @param {TabPagination} page @returns {string} */
export function describeTabList(page) {
  return page.truncated
    ? `Bridge listed ${page.totalCount} tab(s); showing ${page.returnedCount} at offset ${page.offset}, ${page.omittedCount} omitted. Use tabs.list with limit and offset to retrieve another page.`
    : `Bridge listed ${page.totalCount} tab(s).`;
}
