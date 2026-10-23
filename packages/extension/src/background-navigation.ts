import {
  BridgeError,
  ERROR_CODES,
  createSuccess,
  normalizeNavigationAction,
} from '../../../protocol/src/index.js';
import { summarizeTabResult } from './background-helpers.js';
import { requestLifetimes } from './background-request-lifetime.js';

export type BridgeRequest = import('../../../protocol/src/types.js').BridgeRequest;
export type BridgeResponse = import('../../../protocol/src/types.js').BridgeResponse;

export type ResolvedTabTarget = {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
};

export type HandleNavigationRequestDependencies = {
  captureAccess?: () => () => void;
  resolveRequestTarget: (
    request: BridgeRequest,
    options?: { requireScriptable?: boolean }
  ) => Promise<ResolvedTabTarget>;
  updateTab: (tabId: number, properties: { url: string }) => Promise<unknown>;
  reloadTab: (tabId: number) => Promise<void>;
  goBack: (tabId: number) => Promise<void>;
  goForward: (tabId: number) => Promise<void>;
  waitForTabComplete: (tabId: number, timeoutMs: number) => Promise<chrome.tabs.Tab>;
  getTab: (tabId: number) => Promise<chrome.tabs.Tab>;
  emitUiState: () => Promise<void>;
};

/** Execute a tab-level navigation action and optionally wait for the next load
cycle to complete. */
export async function handleNavigationRequest(
  request: BridgeRequest,
  dependencies: HandleNavigationRequestDependencies
): Promise<BridgeResponse> {
  const assertGrant = dependencies.captureAccess?.() ?? (() => {});
  const assertActive = requestLifetimes.guard(request.id);
  const assertAccess = () => {
    assertActive();
    assertGrant();
  };
  const target = await dependencies.resolveRequestTarget(request);
  assertAccess();
  const action = normalizeNavigationAction(request.params);

  if (request.method === 'navigation.navigate') {
    if (!action.url) {
      throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'Missing required url for navigation');
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
  assertAccess();
  await dependencies.emitUiState();

  return createSuccess(request.id, summarizeTabResult(tab, request.method), {
    method: request.method,
  });
}
