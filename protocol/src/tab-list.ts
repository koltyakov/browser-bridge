import { BridgeError, ERROR_CODES } from './errors.js';

export type TabPagination = import('./types.js').TabPagination;

/** Preserve unpaged raw listings, while allowing bounded pages when requested. */
export function normalizeTabListParams(params: Record<string, unknown>): {
  offset: number;
  limit: number | null;
} {
  const offset = params.offset === undefined ? 0 : params.offset;
  const limit =
    params.limit === undefined ? (params.offset === undefined ? null : 30) : params.limit;
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

export function describeTabPage(
  totalCount: number,
  returnedCount: number,
  offset: number
): TabPagination {
  return {
    totalCount,
    returnedCount,
    offset,
    omittedCount: Math.max(0, totalCount - returnedCount),
    truncated: returnedCount < totalCount,
    nextOffset: offset + returnedCount < totalCount ? offset + returnedCount : null,
  };
}

export function paginateTabList<T>(
  tabs: T[],
  params: Record<string, unknown> = {}
): { tabs: T[]; pagination: TabPagination } {
  const { offset, limit } = normalizeTabListParams(params);
  const sorted = [...tabs].sort((left, right) => {
    const priority = (tab: unknown): number => {
      const record = tab && typeof tab === 'object' ? (tab as Record<string, unknown>) : {};
      return Number(record.working === true || record.active === true);
    };
    return priority(right) - priority(left);
  });
  const page = sorted.slice(offset, limit === null ? undefined : offset + limit);
  return { tabs: page, pagination: describeTabPage(tabs.length, page.length, offset) };
}

export function describeTabList(page: TabPagination): string {
  return page.truncated
    ? `Bridge listed ${page.totalCount} tab(s); showing ${page.returnedCount} at offset ${page.offset}, ${page.omittedCount} omitted. Use tabs.list with limit and offset to retrieve another page.`
    : `Bridge listed ${page.totalCount} tab(s).`;
}
