export type ResolvedTabTarget = {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
};
import { BridgeError, ERROR_CODES } from '../../../protocol/src/index.js';

export function isRestrictedAutomationUrl(url: string): boolean {
  return /^(about:|chrome:|chrome-extension:|chrome-search:|devtools:|edge:|brave:|moz-extension:|view-source:)/i.test(
    url
  );
}

export function selectRequestTabCandidate(
  requestTabId: number | null | undefined,
  explicitTab: chrome.tabs.Tab | null | undefined,
  activeTab: chrome.tabs.Tab | null | undefined
): chrome.tabs.Tab | null {
  if (typeof requestTabId === 'number' && Number.isFinite(requestTabId)) {
    return explicitTab ?? null;
  }
  return activeTab ?? null;
}

export function resolveWindowScopedTab(
  tab: chrome.tabs.Tab | null | undefined,
  enabledWindowId: number,
  options: { requireScriptable?: boolean; allowPendingUrl?: boolean } = {}
): ResolvedTabTarget {
  const requireScriptable = options.requireScriptable !== false;
  if (typeof tab?.id !== 'number' || !Number.isFinite(tab.id) || typeof tab.windowId !== 'number') {
    throw new BridgeError(
      ERROR_CODES.TAB_MISMATCH,
      'Tab object is invalid or missing required properties'
    );
  }
  if (tab.windowId !== enabledWindowId) {
    throw new BridgeError(ERROR_CODES.ACCESS_DENIED, 'Tab does not belong to the enabled window');
  }
  // Load waits may target a newly created tab before its first URL commits.
  // Keep normal DOM routing tied to the committed document.
  const url = tab.url || (options.allowPendingUrl ? tab.pendingUrl : undefined);
  if (typeof url !== 'string' || !url) {
    throw new BridgeError(ERROR_CODES.TAB_MISMATCH, 'Tab has no URL available');
  }
  if (requireScriptable && isRestrictedAutomationUrl(url)) {
    throw new BridgeError(ERROR_CODES.ACCESS_DENIED, 'Tab URL is restricted for automation');
  }

  return {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    url,
  };
}

export function normalizeRequestedAccessTab(
  tab: chrome.tabs.Tab | null | undefined
): ResolvedTabTarget | null {
  if (
    typeof tab?.id !== 'number' ||
    !Number.isFinite(tab.id) ||
    typeof tab.windowId !== 'number' ||
    typeof tab.url !== 'string' ||
    !tab.url
  ) {
    return null;
  }
  if (isRestrictedAutomationUrl(tab.url)) {
    return null;
  }
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    url: tab.url,
  };
}
