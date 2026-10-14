// @ts-check

import {
  createFailure,
  createSuccess,
  ERROR_CODES,
  normalizeTabCreateParams,
  normalizeTabListParams,
  paginateTabList,
} from '../../protocol/src/index.js';
import { safeOrigin, summarizeTabResult } from './background-helpers.js';

/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */

/**
 * @typedef {{
 *   enabledWindow: { windowId: number } | null,
 *   workingTabId?: number | null,
 * }} BackgroundTabState
 */

/**
 * @typedef {{
 *   queryTabs: (query: { windowId: number }) => Promise<chrome.tabs.Tab[]>,
 *   createTab: (properties: {
 *     url: string,
 *     active: boolean,
 *     windowId: number,
 *   }) => Promise<chrome.tabs.Tab>,
 * }} TabHandlerDependencies
 */

/**
 * @param {BridgeRequest} request
 * @param {BackgroundTabState} state
 * @param {Pick<TabHandlerDependencies, 'queryTabs'>} dependencies
 * @param {string} accessDeniedWindowOffMessage
 * @returns {Promise<BridgeResponse>}
 */
export async function handleListTabs(request, state, dependencies, accessDeniedWindowOffMessage) {
  if (!state.enabledWindow) {
    return createFailure(
      request.id,
      ERROR_CODES.ACCESS_DENIED,
      accessDeniedWindowOffMessage,
      null,
      {
        method: request.method,
      }
    );
  }

  const params = request.params ?? {};
  normalizeTabListParams(params);
  const tabs = await dependencies.queryTabs({
    windowId: state.enabledWindow.windowId,
  });
  const summarized = tabs
    .map((tab) => {
      if (typeof tab.id !== 'number' || !Number.isFinite(tab.id) || typeof tab.url !== 'string') {
        return null;
      }
      return {
        tabId: tab.id,
        windowId: tab.windowId,
        active: Boolean(tab.active),
        title: tab.title ?? '',
        origin: safeOrigin(tab.url),
        url: tab.url,
        ...(tab.id === state.workingTabId ? { working: true } : {}),
      };
    })
    .filter((tab) => tab !== null);
  const page = paginateTabList(summarized, params);
  return createSuccess(
    request.id,
    params.limit !== undefined || params.offset !== undefined ? page : { tabs: summarized },
    { method: request.method }
  );
}

/**
 * @param {BridgeRequest} request
 * @param {BackgroundTabState} state
 * @param {Pick<TabHandlerDependencies, 'createTab'>} dependencies
 * @param {string} accessDeniedWindowOffMessage
 * @returns {Promise<BridgeResponse>}
 */
export async function handleCreateTab(request, state, dependencies, accessDeniedWindowOffMessage) {
  if (!state.enabledWindow) {
    return createFailure(
      request.id,
      ERROR_CODES.ACCESS_DENIED,
      accessDeniedWindowOffMessage,
      null,
      {
        method: request.method,
      }
    );
  }
  const params = normalizeTabCreateParams(request.params);
  const tab = await dependencies.createTab({
    url: params.url,
    active: params.active,
    windowId: state.enabledWindow.windowId,
  });
  return createSuccess(request.id, summarizeTabResult(tab, request.method), {
    method: request.method,
  });
}
