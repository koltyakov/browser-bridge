// @ts-check

import { BridgeError, ERROR_CODES } from '../../protocol/src/index.js';
import { restoreEnabledWindowState } from './background-access.js';
import { getErrorMessage } from './background-helpers.js';
import {
  ENABLED_WINDOW_STORAGE_KEY,
  KEEPALIVE_ALARM_NAME,
  clearRequestedAccessWindow,
  reportAsyncError,
} from './background-state.js';

/** @typedef {import('./background-state.js').CurrentTabState} CurrentTabState */
/** @typedef {import('./background-state.js').ExtensionState} ExtensionState */
/** @typedef {import('./background-state.js').TabChangeInfo} TabChangeInfo */

/**
 * @typedef {{
 *   sendAccessUpdate: (enabled: boolean) => void,
 *   injectContentScriptsForWindow: (windowId: number) => Promise<void>,
 *   primeWindowConsoleCapture: (
 *     windowId: number,
 *     chrome: typeof globalThis.chrome,
 *     resetBuffer?: boolean,
 *   ) => Promise<void>,
 *   primeTabConsoleCapture: (tabId: number, chrome: typeof globalThis.chrome) => Promise<void>,
 *   clearWindowBridgeState: (windowId: number) => Promise<void>,
 *   cancelNavigationWaitsForWindow: (windowId: number) => void,
 *   appendActionLogEntry: (entry: {
 *     method: string,
 *     tabId?: number | null,
 *     url?: string,
 *     ok: boolean,
 *     summary: string,
 *   }) => Promise<void>,
 *   refreshActionIndicators: () => Promise<void>,
 *   updateActionIndicatorForTab: (tabId: number) => Promise<void>,
 *   emitUiState: () => Promise<void>,
 *   isRestrictedAutomationUrl: (url: string) => boolean,
 * }} WindowSessionControllerDeps
 */

/**
 * Keep enabled-window lifecycle and current-tab UI state out of the main
 * background worker so the worker can focus on request orchestration.
 *
 * @param {ExtensionState} state
 * @param {typeof globalThis.chrome} chrome
 * @param {WindowSessionControllerDeps} deps
 * @returns {{
 *   restoreEnabledWindow: () => Promise<void>,
 *   primeEnabledWindowInstrumentation: () => Promise<void>,
 *   clearEnabledWindowIfGone: () => Promise<boolean>,
 *   getCurrentTabState: () => Promise<CurrentTabState | null>,
 *   getTabState: (tabId: number | null) => Promise<CurrentTabState | null>,
 *   setCurrentWindowEnabled: (enabled: boolean) => Promise<void>,
 *   setWindowEnabled: (
 *     windowId: number,
 *     title: string,
 *     enabled: boolean,
 *     context?: { tabId: number, url: string },
 *   ) => Promise<void>,
 *   handleTabUpdated: (tabId: number, changeInfo: TabChangeInfo, tab: chrome.tabs.Tab) => Promise<void>,
 *   handleTabRemoved: (
 *     tabId: number,
 *     removeInfo: { windowId: number, isWindowClosing: boolean },
 *   ) => Promise<void>,
 * }}
 */
export function createWindowSessionController(state, chrome, deps) {
  /** @type {Promise<void>} */
  let windowTransitionTail = Promise.resolve();

  /**
   * @param {chrome.tabs.Tab | null | undefined} tab
   * @returns {CurrentTabState | null}
   */
  function buildCurrentTabState(tab) {
    if (!tab?.id || typeof tab.windowId !== 'number' || !tab.url) {
      return null;
    }

    return {
      tabId: tab.id,
      windowId: tab.windowId,
      title: tab.title ?? '',
      url: tab.url,
      enabled: state.enabledWindow?.windowId === tab.windowId,
      accessRequested: state.requestedAccessWindowId === tab.windowId,
      restricted: deps.isRestrictedAutomationUrl(tab.url),
    };
  }

  /**
   * @returns {Promise<void>}
   */
  async function restoreEnabledWindow() {
    await restoreEnabledWindowState({
      chrome,
      state,
      storageKey: ENABLED_WINDOW_STORAGE_KEY,
      sendAccessUpdate: deps.sendAccessUpdate,
    });
  }

  /**
   * @returns {Promise<void>}
   */
  async function primeEnabledWindowInstrumentation() {
    if (!state.enabledWindow) {
      return;
    }

    await deps.injectContentScriptsForWindow(state.enabledWindow.windowId);
    await deps.primeWindowConsoleCapture(state.enabledWindow.windowId, chrome);
  }

  /**
   * @returns {Promise<boolean>}
   */
  async function clearEnabledWindowIfGone() {
    if (!state.enabledWindow) {
      return false;
    }

    let gone = false;
    try {
      await chrome.windows.get(state.enabledWindow.windowId);
    } catch (error) {
      const message = getErrorMessage(error).toLowerCase();
      if (
        message.includes('no window') ||
        message.includes('not found') ||
        message.includes('window closed')
      ) {
        gone = true;
      } else {
        await new Promise((resolve) => {
          setTimeout(resolve, 300);
        });
        try {
          await chrome.windows.get(state.enabledWindow.windowId);
        } catch {
          gone = true;
        }
      }
    }

    if (!gone) {
      return false;
    }

    const goneWindowId = state.enabledWindow.windowId;
    state.enabledWindow = null;
    deps.cancelNavigationWaitsForWindow(goneWindowId);
    await chrome.storage.session.remove(ENABLED_WINDOW_STORAGE_KEY);
    deps.sendAccessUpdate(false);
    await deps.clearWindowBridgeState(goneWindowId);
    return true;
  }

  /**
   * @returns {Promise<CurrentTabState | null>}
   */
  async function getCurrentTabState() {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    return buildCurrentTabState(activeTab);
  }

  /**
   * @param {number | null} tabId
   * @returns {Promise<CurrentTabState | null>}
   */
  async function getTabState(tabId) {
    if (!tabId) {
      return null;
    }

    try {
      return buildCurrentTabState(await chrome.tabs.get(tabId));
    } catch {
      return null;
    }
  }

  /**
   * @param {boolean} enabled
   * @returns {Promise<void>}
   */
  async function setCurrentWindowEnabled(enabled) {
    const currentTab = await getCurrentTabState();
    if (!currentTab?.url) {
      throw new BridgeError(ERROR_CODES.TAB_MISMATCH, 'No active tab available');
    }

    await setWindowEnabled(currentTab.windowId, currentTab.title, enabled, {
      tabId: currentTab.tabId,
      url: currentTab.url,
    });
  }

  /**
   * @param {number} windowId
   * @param {string} title
   * @param {boolean} enabled
   * @param {{ tabId: number, url: string }} [context]
   * @returns {Promise<void>}
   */
  async function setWindowEnabled(windowId, title, enabled, context) {
    const operation = windowTransitionTail.then(
      () => applyWindowEnabledState(windowId, title, enabled, context),
      () => applyWindowEnabledState(windowId, title, enabled, context)
    );
    windowTransitionTail = operation.catch(() => {});
    return operation;
  }

  /**
   * @param {number} windowId
   * @param {string} title
   * @param {boolean} enabled
   * @param {{ tabId: number, url: string } | undefined} context
   * @returns {Promise<void>}
   */
  async function applyWindowEnabledState(windowId, title, enabled, context) {
    const confirmsAccessRequest = enabled && state.requestedAccessWindowId === windowId;
    clearRequestedAccessWindow();
    const access = {
      windowId,
      title,
      enabledAt: Date.now(),
    };
    const previousWindowId = state.enabledWindow?.windowId ?? null;
    const isSwitch = enabled && previousWindowId !== null && previousWindowId !== windowId;
    const isActiveDisable = !enabled && previousWindowId === windowId;

    if (isSwitch || isActiveDisable) {
      state.enabledWindow = null;
      deps.cancelNavigationWaitsForWindow(/** @type {number} */ (previousWindowId));
      await chrome.storage.session.remove(ENABLED_WINDOW_STORAGE_KEY);
      deps.sendAccessUpdate(false);
      await deps.clearWindowBridgeState(/** @type {number} */ (previousWindowId));
    }

    if (enabled) {
      state.enabledWindow = access;
      await chrome.storage.session.set({
        [ENABLED_WINDOW_STORAGE_KEY]: access,
      });
      if (confirmsAccessRequest) {
        try {
          await deps.appendActionLogEntry({
            method: 'access.confirmed',
            tabId: context?.tabId ?? null,
            url: context?.url ?? '',
            ok: true,
            summary: 'Window access request confirmed.',
          });
        } catch (error) {
          // Activity persistence must never prevent access from being enabled.
          reportAsyncError(error);
        }
      }
    }

    try {
      await deps.refreshActionIndicators();
    } catch (error) {
      /* Badge updates can fail for closed or restricted tabs. */
      reportAsyncError(error);
    }
    await deps.emitUiState();

    if (enabled) {
      deps.sendAccessUpdate(true);
      await chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.4 });
      await Promise.allSettled([
        deps.injectContentScriptsForWindow(access.windowId),
        deps.primeWindowConsoleCapture(access.windowId, chrome, true),
      ]);
      return;
    }

    if (!isActiveDisable) {
      deps.sendAccessUpdate(false);
    }
    try {
      await chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
      if (!isActiveDisable) {
        await deps.clearWindowBridgeState(windowId);
      }
    } catch (error) {
      reportAsyncError(error);
    }
  }

  /**
   * @param {number} tabId
   * @param {TabChangeInfo} changeInfo
   * @param {chrome.tabs.Tab} tab
   * @returns {Promise<void>}
   */
  async function handleTabUpdated(tabId, changeInfo, tab) {
    if (
      typeof changeInfo.title === 'string' &&
      state.enabledWindow &&
      tab.windowId === state.enabledWindow.windowId
    ) {
      state.enabledWindow = {
        ...state.enabledWindow,
        title: changeInfo.title,
      };
      await chrome.storage.session.set({
        [ENABLED_WINDOW_STORAGE_KEY]: state.enabledWindow,
      });
    }

    if (
      typeof changeInfo.url === 'string' ||
      typeof changeInfo.title === 'string' ||
      changeInfo.status === 'complete'
    ) {
      if (
        changeInfo.status === 'complete' &&
        state.enabledWindow &&
        tab.windowId === state.enabledWindow.windowId
      ) {
        await deps.primeTabConsoleCapture(tabId, chrome);
      }
      await deps.updateActionIndicatorForTab(tabId);
      await deps.emitUiState();
    }
  }

  /**
   * @param {number} tabId
   * @param {{ windowId: number, isWindowClosing: boolean }} removeInfo
   * @returns {Promise<void>}
   */
  async function handleTabRemoved(tabId, removeInfo) {
    if (
      state.enabledWindow &&
      removeInfo.isWindowClosing &&
      removeInfo.windowId === state.enabledWindow.windowId
    ) {
      state.enabledWindow = null;
      await chrome.storage.session.remove(ENABLED_WINDOW_STORAGE_KEY);
      deps.sendAccessUpdate(false);
    }
    if (removeInfo.isWindowClosing && removeInfo.windowId === state.requestedAccessWindowId) {
      clearRequestedAccessWindow(removeInfo.windowId);
    }
    await deps.updateActionIndicatorForTab(tabId);
    await deps.emitUiState();
  }

  return {
    restoreEnabledWindow,
    primeEnabledWindowInstrumentation,
    clearEnabledWindowIfGone,
    getCurrentTabState,
    getTabState,
    setCurrentWindowEnabled,
    setWindowEnabled,
    handleTabUpdated,
    handleTabRemoved,
  };
}
