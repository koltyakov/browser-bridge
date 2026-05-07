// @ts-check

import { BridgeError, ERROR_CODES } from '../../protocol/src/index.js';

/**
 * @typedef {{
 *   tabId: number,
 *   windowId: number,
 *   title: string,
 *   url: string
 * }} ResolvedTabTarget
 */

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isRestrictedAutomationUrl(url) {
  return /^(about:|chrome:|chrome-extension:|chrome-search:|devtools:|edge:|brave:|moz-extension:|view-source:)/i.test(
    url
  );
}

/**
 * @param {number | null | undefined} requestTabId
 * @param {chrome.tabs.Tab | null | undefined} explicitTab
 * @param {chrome.tabs.Tab | null | undefined} activeTab
 * @returns {chrome.tabs.Tab | null}
 */
export function selectRequestTabCandidate(requestTabId, explicitTab, activeTab) {
  if (typeof requestTabId === 'number' && Number.isFinite(requestTabId)) {
    return explicitTab ?? null;
  }
  return activeTab ?? null;
}

/**
 * @param {chrome.tabs.Tab | null | undefined} tab
 * @param {number} enabledWindowId
 * @param {{ requireScriptable?: boolean }} [options]
 * @returns {ResolvedTabTarget}
 */
export function resolveWindowScopedTab(tab, enabledWindowId, options = {}) {
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
  if (typeof tab.url !== 'string' || !tab.url) {
    throw new BridgeError(ERROR_CODES.TAB_MISMATCH, 'Tab has no URL available');
  }
  if (requireScriptable && isRestrictedAutomationUrl(tab.url)) {
    throw new BridgeError(ERROR_CODES.ACCESS_DENIED, 'Tab URL is restricted for automation');
  }

  return {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    url: tab.url,
  };
}

/**
 * @param {chrome.tabs.Tab | null | undefined} tab
 * @returns {ResolvedTabTarget | null}
 */
export function normalizeRequestedAccessTab(tab) {
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
