// @ts-check

/**
 * @typedef {{
 *   tabId: number,
 *   windowId: number,
 *   title: string,
 *   url: string,
 *   enabled: boolean,
 *   accessRequested: boolean,
 *   restricted: boolean
 * }} PopupCurrentTab
 */

/**
 * @typedef {{
 *   type: 'state.sync',
 *   state: {
 *     nativeConnected: boolean,
 *     currentTab: PopupCurrentTab | null
 *   }
 * } | {
 *   type: 'toggle.error',
 *   error: string
 * }} PopupMessage
 */

/**
 * @typedef {{
 *   renderNativeStatus: (connected: boolean) => void,
 *   renderPopupState: (currentTab: PopupCurrentTab | null) => void,
 *   shouldResetPendingToggleOnSync: (currentTab: PopupCurrentTab | null, pendingEnabledState: boolean | null) => boolean,
 *   getPendingEnabledState: () => boolean | null,
 *   resetPendingToggle: () => void,
 *   renderToggleError: (errorMessage: string) => void,
 *   windowedPopup: boolean,
 *   closeWindow: () => void
 * }} PopupMessageHandlerOptions
 */

/**
 * @typedef {{
 *   type: 'state.request',
 *   scopeTabId?: number
 * }} PopupStateRequestMessage
 */

/**
 * @typedef {{
 *   onMessage: {
 *     addListener: (listener: (message: PopupMessage) => void) => void
 *   },
 *   postMessage: (message: PopupStateRequestMessage) => void
 * }} PopupRuntimePort
 */

/**
 * @param {PopupMessageHandlerOptions} options
 * @returns {(message: PopupMessage) => void}
 */
export function createPopupMessageHandler(options) {
  return (message) => {
    if (message.type === 'state.sync') {
      options.renderNativeStatus(message.state.nativeConnected);
      options.renderPopupState(message.state.currentTab);
      if (
        options.shouldResetPendingToggleOnSync(
          message.state.currentTab,
          options.getPendingEnabledState()
        )
      ) {
        options.resetPendingToggle();
        if (options.windowedPopup) {
          options.closeWindow();
        }
      }
      return;
    }

    if (message.type === 'toggle.error') {
      options.renderToggleError(message.error);
    }
  };
}

/**
 * @param {string} search
 * @returns {number | null}
 */
export function readScopedTabId(search) {
  const value = new URLSearchParams(search).get('tabId');
  const tabId = Number(value);
  return Number.isFinite(tabId) && tabId > 0 ? tabId : null;
}

/**
 * @param {string} search
 * @returns {boolean}
 */
export function isWindowedPopup(search) {
  return new URLSearchParams(search).get('windowed') === '1';
}

/**
 * @param {{
 *   search: string,
 *   queryTabs: (queryInfo: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>
 * }} options
 * @returns {Promise<number | null>}
 */
export async function resolveInitialScopeTabId({ search, queryTabs }) {
  const explicitScopeTabId = readScopedTabId(search);
  if (explicitScopeTabId != null) {
    return explicitScopeTabId;
  }

  try {
    const [activeTab] = await queryTabs({
      active: true,
      currentWindow: true,
    });
    return typeof activeTab?.id === 'number' ? activeTab.id : null;
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   search: string,
 *   queryTabs: (queryInfo: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>,
 *   connect: (connectInfo: chrome.runtime.ConnectInfo) => PopupRuntimePort,
 *   onMessage: (message: PopupMessage) => void
 * }} options
 * @returns {Promise<{ popupScopeTabId: number | null, port: PopupRuntimePort }>}
 */
export async function connectPopupPort({ search, queryTabs, connect, onMessage }) {
  const popupScopeTabId = await resolveInitialScopeTabId({ search, queryTabs });
  const port = connect({ name: 'ui-popup' });
  port.onMessage.addListener(onMessage);
  port.postMessage({
    type: 'state.request',
    ...(popupScopeTabId != null ? { scopeTabId: popupScopeTabId } : {}),
  });
  return { popupScopeTabId, port };
}
