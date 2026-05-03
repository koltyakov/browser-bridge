// @ts-check

import { ERROR_CODES, createSuccess, normalizeNavigationAction } from '../../protocol/src/index.js';
import { summarizeTabResult } from './background-helpers.js';

/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */

/**
 * @typedef {{
 *   tabId: number,
 *   windowId: number,
 *   title: string,
 *   url: string
 * }} ResolvedTabTarget
 */

/**
 * @typedef {{
 *   resolveRequestTarget: (request: BridgeRequest, options?: { requireScriptable?: boolean }) => Promise<ResolvedTabTarget>,
 *   updateTab: (tabId: number, properties: { url: string }) => Promise<unknown>,
 *   reloadTab: (tabId: number) => Promise<void>,
 *   goBack: (tabId: number) => Promise<void>,
 *   goForward: (tabId: number) => Promise<void>,
 *   waitForTabComplete: (tabId: number, timeoutMs: number) => Promise<chrome.tabs.Tab>,
 *   getTab: (tabId: number) => Promise<chrome.tabs.Tab>,
 *   emitUiState: () => Promise<void>,
 * }} HandleNavigationRequestDependencies
 */

/**
 * Execute a tab-level navigation action and optionally wait for the next load
 * cycle to complete.
 *
 * @param {BridgeRequest} request
 * @param {HandleNavigationRequestDependencies} dependencies
 * @returns {Promise<BridgeResponse>}
 */
export async function handleNavigationRequest(request, dependencies) {
  const target = await dependencies.resolveRequestTarget(request);
  const action = normalizeNavigationAction(request.params);

  if (request.method === 'navigation.navigate') {
    if (!action.url) {
      throw new Error(ERROR_CODES.INVALID_REQUEST);
    }
    await dependencies.updateTab(target.tabId, { url: action.url });
  } else if (request.method === 'navigation.reload') {
    await dependencies.reloadTab(target.tabId);
  } else if (request.method === 'navigation.go_back') {
    await dependencies.goBack(target.tabId);
  } else {
    await dependencies.goForward(target.tabId);
  }

  const tab = action.waitForLoad
    ? await dependencies.waitForTabComplete(target.tabId, action.timeoutMs)
    : await dependencies.getTab(target.tabId);
  await dependencies.emitUiState();

  return createSuccess(request.id, summarizeTabResult(tab, request.method), {
    method: request.method,
  });
}
