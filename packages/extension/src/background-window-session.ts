import { BridgeError, ERROR_CODES } from '../../../protocol/src/index.js';
import {
  isGrantedTab,
  normalizeStoredEnabledWindow,
  restoreEnabledWindowState,
} from './background-access.js';
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
  ensureContentScript?: (tabId: number) => Promise<void>;
  clearWindowBridgeState: (
    windowId: number,
    grant?: import('./background-access.js').EnabledWindowState
  ) => Promise<void>;
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
  restoreEnabledWindowAfterUpdate: () => Promise<void>;
  clearEnabledWindowOnBrowserStartup: () => Promise<void>;
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
    context?: { tabId: number; url: string; scope?: 'tab' }
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
  let browserStarting = false;

  function enqueueWindowTransition(operation: () => Promise<void>): Promise<void> {
    const pending = windowTransitionTail.then(operation, operation);
    windowTransitionTail = pending.catch(() => {});
    return pending;
  }

  async function persistEnabledWindow(): Promise<void> {
    const stored = { [ENABLED_WINDOW_STORAGE_KEY]: state.enabledWindow };
    await Promise.all([chrome.storage.local.set(stored), chrome.storage.session.set(stored)]);
  }

  async function clearStoredEnabledWindow(): Promise<void> {
    await Promise.all([
      chrome.storage.local.remove(ENABLED_WINDOW_STORAGE_KEY),
      chrome.storage.session.remove(ENABLED_WINDOW_STORAGE_KEY),
    ]);
  }

  function buildCurrentTabState(tab: chrome.tabs.Tab | null | undefined): CurrentTabState | null {
    if (!tab?.id || typeof tab.windowId !== 'number' || !tab.url) {
      return null;
    }

    return {
      tabId: tab.id,
      windowId: tab.windowId,
      title: tab.title ?? '',
      url: tab.url,
      enabled: isGrantedTab(state, tab.id, tab.windowId),
      ...(state.enabledWindow?.windowId === tab.windowId && state.enabledWindow.tabId !== undefined
        ? { accessScope: 'tab' as const }
        : {}),
      accessRequested: state.requestedAccessWindowId === tab.windowId,
      restricted: deps.isRestrictedAutomationUrl(tab.url),
      ...(state.requestedAccessWindowId === tab.windowId && state.requestedAccessContext
        ? { accessRequestContext: state.requestedAccessContext }
        : {}),
    };
  }

  async function restoreEnabledWindow(): Promise<void> {
    await enqueueWindowTransition(async () => {
      if (browserStarting) return;
      await restoreEnabledWindowState({
        chrome,
        state,
        storageKey: ENABLED_WINDOW_STORAGE_KEY,
        sendAccessUpdate(enabled) {
          if (!browserStarting) deps.sendAccessUpdate(enabled);
        },
      });
      if (browserStarting) {
        state.enabledWindow = null;
        return;
      }
      if (state.enabledWindow) await persistEnabledWindow();
    });
  }

  /** Local grants are read only for an extension update, never ordinary startup. */
  async function restoreEnabledWindowAfterUpdate(): Promise<void> {
    await enqueueWindowTransition(async () => {
      if (browserStarting || state.enabledWindow) return;
      const stored = await chrome.storage.local.get(ENABLED_WINDOW_STORAGE_KEY);
      const access = normalizeStoredEnabledWindow(stored[ENABLED_WINDOW_STORAGE_KEY]);
      if (!access || browserStarting) return;
      try {
        await chrome.windows.get(access.windowId);
      } catch {
        await clearStoredEnabledWindow();
        return;
      }
      if (browserStarting) return;
      await chrome.storage.session.set({ [ENABLED_WINDOW_STORAGE_KEY]: access });
      if (browserStarting) return;
      state.enabledWindow = access;
      deps.sendAccessUpdate(true);
      await primeEnabledWindowInstrumentation();
      await chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.4 });
      await deps.refreshActionIndicators();
      await deps.emitUiState();
    });
  }

  function clearEnabledWindowOnBrowserStartup(): Promise<void> {
    // Set synchronously so an overlapping update cannot restore an old grant.
    browserStarting = true;
    return enqueueWindowTransition(async () => {
      const access = state.enabledWindow;
      state.enabledWindow = null;
      deps.sendAccessUpdate(false);
      await clearStoredEnabledWindow();
      try {
        if (access) {
          deps.cancelNavigationWaitsForWindow(access.windowId);
          await deps.clearWindowBridgeState(access.windowId, access);
        }
      } finally {
        await chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
        await deps.refreshActionIndicators();
        await deps.emitUiState();
      }
    });
  }

  async function primeEnabledWindowInstrumentation(): Promise<void> {
    if (!state.enabledWindow) {
      return;
    }

    if (state.enabledWindow.tabId !== undefined) {
      const tabs = await chrome.tabs.query({ windowId: state.enabledWindow.windowId });
      await Promise.all(
        tabs
          .filter((tab) => tab.id !== undefined && isGrantedTab(state, tab.id, tab.windowId))
          .map(async (tab) => {
            await deps.ensureContentScript?.(tab.id as number);
            await deps.primeTabConsoleCapture(tab.id as number, chrome);
          })
      );
    } else {
      await deps.injectContentScriptsForWindow(state.enabledWindow.windowId);
      await deps.primeWindowConsoleCapture(state.enabledWindow.windowId, chrome, true);
    }
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

    const goneAccess = state.enabledWindow;
    const goneWindowId = goneAccess.windowId;
    state.enabledWindow = null;
    deps.cancelNavigationWaitsForWindow(goneWindowId);
    await clearStoredEnabledWindow();
    deps.sendAccessUpdate(false);
    try {
      await deps.clearWindowBridgeState(goneWindowId, goneAccess);
    } finally {
      await chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
    }
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
    context?: { tabId: number; url: string; scope?: 'tab' }
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
    context: { tabId: number; url: string; scope?: 'tab' } | undefined
  ): Promise<void> {
    const confirmsAccessRequest = enabled && state.requestedAccessWindowId === windowId;
    if (enabled || state.requestedAccessWindowId === windowId) clearRequestedAccessWindow();
    const access = {
      windowId,
      title,
      enabledAt: Math.max(Date.now(), (state.enabledWindow?.enabledAt ?? 0) + 1),
      ...(context?.scope === 'tab' ? { tabId: context.tabId } : {}),
    };
    const previousAccess = state.enabledWindow;
    const previousWindowId = previousAccess?.windowId ?? null;
    const isSwitch =
      enabled &&
      previousWindowId !== null &&
      (previousWindowId !== windowId || state.enabledWindow?.tabId !== access.tabId);
    const isActiveDisable = !enabled && previousWindowId === windowId;
    const cleanupErrors: unknown[] = [];

    if (isSwitch || isActiveDisable) {
      state.enabledWindow = null;
      deps.cancelNavigationWaitsForWindow(previousWindowId as number);
      await clearStoredEnabledWindow();
      deps.sendAccessUpdate(false);
      try {
        await deps.clearWindowBridgeState(previousWindowId as number, previousAccess ?? undefined);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (enabled && cleanupErrors.length === 0) {
      await Promise.allSettled(
        access.tabId !== undefined
          ? [
              deps.ensureContentScript?.(access.tabId),
              deps.primeTabConsoleCapture(access.tabId, chrome),
            ]
          : [
              deps.injectContentScriptsForWindow(access.windowId),
              deps.primeWindowConsoleCapture(access.windowId, chrome, true),
            ]
      );
      state.enabledWindow = access;
      await persistEnabledWindow();
      if (confirmsAccessRequest) {
        try {
          await deps.appendActionLogEntry({
            method: 'access.confirmed',
            tabId: context?.tabId ?? null,
            url: context?.url ?? '',
            ok: true,
            summary:
              access.tabId !== undefined
                ? 'Tab access request confirmed.'
                : 'Window access request confirmed.',
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

    if (enabled && cleanupErrors.length === 0) {
      deps.sendAccessUpdate(true);
      await chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.4 });
      return;
    }

    if (!isActiveDisable && cleanupErrors.length === 0) return;
    try {
      await chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
    } catch (error) {
      reportAsyncError(error);
    }
    if (cleanupErrors.length) {
      throw new AggregateError(
        cleanupErrors,
        enabled
          ? 'Access remains off because cleanup of the previous session could not finish.'
          : 'Access is disabled, but some cleanup could not finish.'
      );
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
      const title = changeInfo.title;
      await enqueueWindowTransition(async () => {
        if (state.enabledWindow?.windowId !== tab.windowId) return;
        state.enabledWindow = { ...state.enabledWindow, title };
        await persistEnabledWindow();
        deps.sendAccessUpdate(true);
      });
    }

    if (
      typeof changeInfo.url === 'string' ||
      typeof changeInfo.title === 'string' ||
      changeInfo.status === 'complete'
    ) {
      if (changeInfo.status === 'complete' && isGrantedTab(state, tabId, tab.windowId)) {
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
      (removeInfo.isWindowClosing || state.enabledWindow.tabId === tabId) &&
      removeInfo.windowId === state.enabledWindow.windowId
    ) {
      await enqueueWindowTransition(async () => {
        if (state.enabledWindow?.windowId !== removeInfo.windowId) return;
        if (!removeInfo.isWindowClosing && state.enabledWindow.tabId !== tabId) return;
        const access = state.enabledWindow;
        state.enabledWindow = null;
        await clearStoredEnabledWindow();
        deps.sendAccessUpdate(false);
        if (!removeInfo.isWindowClosing) {
          deps.cancelNavigationWaitsForWindow(removeInfo.windowId);
          await deps.clearWindowBridgeState(removeInfo.windowId, access);
          await chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
        }
      });
    }
    if (removeInfo.isWindowClosing && removeInfo.windowId === state.requestedAccessWindowId) {
      clearRequestedAccessWindow(removeInfo.windowId);
    }
    await deps.updateActionIndicatorForTab(tabId);
    await deps.emitUiState();
  }

  return {
    restoreEnabledWindow,
    restoreEnabledWindowAfterUpdate,
    clearEnabledWindowOnBrowserStartup,
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
