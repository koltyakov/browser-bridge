import { BridgeError, ERROR_CODES } from '../../../protocol/src/index.js';
import { restoreEnabledWindowState } from './background-access.js';
import { getErrorMessage } from './background-helpers.js';
import {
  ENABLED_WINDOW_STORAGE_KEY,
  KEEPALIVE_ALARM_NAME,
  clearRequestedAccessWindow,
  reportAsyncError,
} from './background-state.js';

export type CurrentTabState = import('./background-state.js').CurrentTabState;
export type ExtensionState = import('./background-state.js').ExtensionState;
export type TabChangeInfo = import('./background-state.js').TabChangeInfo;

export type WindowSessionControllerDeps = {
  sendAccessUpdate: (enabled: boolean) => void;
  injectContentScriptsForWindow: (windowId: number) => Promise<void>;
  primeWindowConsoleCapture: (
    windowId: number,
    chrome: typeof globalThis.chrome,
    resetBuffer?: boolean
  ) => Promise<void>;
  primeTabConsoleCapture: (tabId: number, chrome: typeof globalThis.chrome) => Promise<void>;
  clearWindowBridgeState: (windowId: number) => Promise<void>;
  cancelNavigationWaitsForWindow: (windowId: number) => void;
  appendActionLogEntry: (entry: {
    method: string;
    tabId?: number | null;
    url?: string;
    ok: boolean;
    summary: string;
  }) => Promise<void>;
  refreshActionIndicators: () => Promise<void>;
  updateActionIndicatorForTab: (tabId: number) => Promise<void>;
  emitUiState: () => Promise<void>;
  isRestrictedAutomationUrl: (url: string) => boolean;
};

/** Keep enabled-window lifecycle and current-tab UI state out of the main
background worker so the worker can focus on request orchestration. */
export function createWindowSessionController(
  state: ExtensionState,
  chrome: typeof globalThis.chrome,
  deps: WindowSessionControllerDeps
): {
  restoreEnabledWindow: () => Promise<void>;
  primeEnabledWindowInstrumentation: () => Promise<void>;
  clearEnabledWindowIfGone: () => Promise<boolean>;
  getCurrentTabState: (windowId?: number | null) => Promise<CurrentTabState | null>;
  getTabState: (tabId: number | null) => Promise<CurrentTabState | null>;
  setCurrentWindowEnabled: (enabled: boolean) => Promise<void>;
  disableWindowAccess: (windowId: number, enabledAt: number) => Promise<void>;
  setWindowEnabled: (
    windowId: number,
    title: string,
    enabled: boolean,
    context?: { tabId: number; url: string }
  ) => Promise<void>;
  handleTabUpdated: (
    tabId: number,
    changeInfo: TabChangeInfo,
    tab: chrome.tabs.Tab
  ) => Promise<void>;
  handleTabRemoved: (
    tabId: number,
    removeInfo: { windowId: number; isWindowClosing: boolean }
  ) => Promise<void>;
} {
  let windowTransitionTail: Promise<void> = Promise.resolve();

  function buildCurrentTabState(tab: chrome.tabs.Tab | null | undefined): CurrentTabState | null {
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
      ...(state.requestedAccessWindowId === tab.windowId && state.requestedAccessContext
        ? { accessRequestContext: state.requestedAccessContext }
        : {}),
    };
  }

  async function restoreEnabledWindow(): Promise<void> {
    await restoreEnabledWindowState({
      chrome,
      state,
      storageKey: ENABLED_WINDOW_STORAGE_KEY,
      sendAccessUpdate: deps.sendAccessUpdate,
    });
  }

  async function primeEnabledWindowInstrumentation(): Promise<void> {
    if (!state.enabledWindow) {
      return;
    }

    await deps.injectContentScriptsForWindow(state.enabledWindow.windowId);
    await deps.primeWindowConsoleCapture(state.enabledWindow.windowId, chrome, true);
  }

  async function clearEnabledWindowIfGone(): Promise<boolean> {
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

  async function getCurrentTabState(windowId?: number | null): Promise<CurrentTabState | null> {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      ...(windowId != null ? { windowId } : { lastFocusedWindow: true }),
    });
    return buildCurrentTabState(activeTab);
  }

  async function getTabState(tabId: number | null): Promise<CurrentTabState | null> {
    if (!tabId) {
      return null;
    }

    try {
      return buildCurrentTabState(await chrome.tabs.get(tabId));
    } catch {
      return null;
    }
  }

  async function setCurrentWindowEnabled(enabled: boolean): Promise<void> {
    const currentTab = await getCurrentTabState();
    if (!currentTab?.url) {
      throw new BridgeError(ERROR_CODES.TAB_MISMATCH, 'No active tab available');
    }

    await setWindowEnabled(currentTab.windowId, currentTab.title, enabled, {
      tabId: currentTab.tabId,
      url: currentTab.url,
    });
  }

  async function setWindowEnabled(
    windowId: number,
    title: string,
    enabled: boolean,
    context?: { tabId: number; url: string }
  ): Promise<void> {
    const operation = windowTransitionTail.then(
      () => applyWindowEnabledState(windowId, title, enabled, context),
      () => applyWindowEnabledState(windowId, title, enabled, context)
    );
    windowTransitionTail = operation.catch(() => {});
    return operation;
  }

  /** Revoke only the grant the user saw, not a window enabled after the click. */
  async function disableWindowAccess(windowId: number, enabledAt: number): Promise<void> {
    const operation = windowTransitionTail.then(async () => {
      if (!state.enabledWindow) return;
      if (
        state.enabledWindow.windowId !== windowId ||
        state.enabledWindow.enabledAt !== enabledAt
      ) {
        throw new Error('Window access changed. Refresh the list and try again.');
      }
      await applyWindowEnabledState(windowId, state.enabledWindow.title, false, undefined);
    });
    windowTransitionTail = operation.catch(() => {});
    return operation;
  }

  async function applyWindowEnabledState(
    windowId: number,
    title: string,
    enabled: boolean,
    context: { tabId: number; url: string } | undefined
  ): Promise<void> {
    const confirmsAccessRequest = enabled && state.requestedAccessWindowId === windowId;
    if (enabled || state.requestedAccessWindowId === windowId) clearRequestedAccessWindow();
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
      deps.cancelNavigationWaitsForWindow(previousWindowId as number);
      await chrome.storage.session.remove(ENABLED_WINDOW_STORAGE_KEY);
      deps.sendAccessUpdate(false);
      await deps.clearWindowBridgeState(previousWindowId as number);
    }

    if (enabled) {
      await Promise.allSettled([
        deps.injectContentScriptsForWindow(access.windowId),
        deps.primeWindowConsoleCapture(access.windowId, chrome, true),
      ]);
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
      return;
    }

    if (!isActiveDisable) return;
    try {
      await chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
    } catch (error) {
      reportAsyncError(error);
    }
  }

  async function handleTabUpdated(
    tabId: number,
    changeInfo: TabChangeInfo,
    tab: chrome.tabs.Tab
  ): Promise<void> {
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
      deps.sendAccessUpdate(true);
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

  async function handleTabRemoved(
    tabId: number,
    removeInfo: { windowId: number; isWindowClosing: boolean }
  ): Promise<void> {
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
    disableWindowAccess,
    handleTabUpdated,
    handleTabRemoved,
  };
}
