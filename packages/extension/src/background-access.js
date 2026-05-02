// @ts-check

/**
 * @typedef {{
 *   windowId: number,
 *   title: string,
 *   enabledAt: number
 * }} EnabledWindowState
 */

/**
 * @typedef {{ enabledWindow: EnabledWindowState | null }} EnabledWindowContainer
 */

/**
 * @typedef {{
 *   enabled: boolean,
 *   windowId: number | null,
 *   routeTabId: number | null,
 *   routeReady: boolean,
 *   routeUrl: string,
 *   reason: 'enabled' | 'access_disabled' | 'enabled_window_missing' | 'no_routable_active_tab' | 'restricted_page'
 * }} AccessStatus
 */

/**
 * @param {unknown} value
 * @param {() => number} [now]
 * @returns {EnabledWindowState | null}
 */
export function normalizeStoredEnabledWindow(value, now = Date.now) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = /** @type {Record<string, unknown>} */ (value);
  const windowId = Number(candidate.windowId);
  if (!Number.isFinite(windowId) || windowId <= 0) {
    return null;
  }

  return {
    windowId,
    title: typeof candidate.title === 'string' ? candidate.title : '',
    enabledAt: Number(candidate.enabledAt) || now(),
  };
}

/**
 * Restore a previously-enabled window from session storage.
 *
 * @param {{
 *   chrome: { storage: { session: { get: (key: string) => Promise<Record<string, unknown>> } } },
 *   state: EnabledWindowContainer,
 *   storageKey: string,
 *   sendAccessUpdate: (enabled: boolean) => void,
 *   now?: () => number,
 * }} options
 * @returns {Promise<void>}
 */
export async function restoreEnabledWindowState({
  chrome,
  state,
  storageKey,
  sendAccessUpdate,
  now = Date.now,
}) {
  const stored = await chrome.storage.session.get(storageKey);
  const enabledWindow = normalizeStoredEnabledWindow(stored[storageKey], now);
  state.enabledWindow = enabledWindow;
  if (enabledWindow) {
    sendAccessUpdate(true);
  }
}

/**
 * Build a compact access-status payload for health and doctor flows.
 *
 * @param {{
 *   chrome: {
 *     windows: { get: (windowId: number) => Promise<unknown> },
 *     tabs: {
 *       query: (query: { active: boolean, windowId: number }) => Promise<Array<{ id?: number, url?: unknown }>>
 *     },
 *   },
 *   state: EnabledWindowContainer,
 *   clearEnabledWindowIfGone: () => Promise<boolean>,
 *   isRestrictedAutomationUrl: (url: string) => boolean,
 * }} options
 * @returns {Promise<AccessStatus>}
 */
export async function getAccessStatus({
  chrome,
  state,
  clearEnabledWindowIfGone,
  isRestrictedAutomationUrl,
}) {
  if (!state.enabledWindow) {
    return {
      enabled: false,
      windowId: null,
      routeTabId: null,
      routeReady: false,
      routeUrl: '',
      reason: 'access_disabled',
    };
  }

  try {
    await chrome.windows.get(state.enabledWindow.windowId);
  } catch {
    const cleared = await clearEnabledWindowIfGone();
    if (cleared) {
      return {
        enabled: false,
        windowId: null,
        routeTabId: null,
        routeReady: false,
        routeUrl: '',
        reason: 'enabled_window_missing',
      };
    }
  }

  const tabs = await chrome.tabs.query({
    active: true,
    windowId: state.enabledWindow.windowId,
  });
  const tab = tabs[0];
  if (!tab?.id || typeof tab.url !== 'string') {
    return {
      enabled: true,
      windowId: state.enabledWindow.windowId,
      routeTabId: null,
      routeReady: false,
      routeUrl: '',
      reason: 'no_routable_active_tab',
    };
  }

  if (isRestrictedAutomationUrl(tab.url)) {
    return {
      enabled: true,
      windowId: state.enabledWindow.windowId,
      routeTabId: tab.id,
      routeReady: false,
      routeUrl: tab.url,
      reason: 'restricted_page',
    };
  }

  return {
    enabled: true,
    windowId: state.enabledWindow.windowId,
    routeTabId: tab.id,
    routeReady: true,
    routeUrl: tab.url,
    reason: 'enabled',
  };
}
