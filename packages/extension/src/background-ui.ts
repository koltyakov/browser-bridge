export type CurrentTabState = import('./background-state.js').CurrentTabState;
export type ExtensionState = import('./background-state.js').ExtensionState;
export type ResolvedTabTarget = import('./background-state.js').ResolvedTabTarget;
export type AccessRequestUiDeps = {
  getTabState: (tabId: number) => Promise<CurrentTabState | null>;
  getCurrentTabState: (windowId?: number | null) => Promise<CurrentTabState | null>;
};
export type AgentTabUiState = {
  tabId: number;
  title: string;
  isCurrent: boolean;
  actionCount?: number;
};
export type UiDeps = {
  refreshSetupStatus: (force?: boolean) => void;
  getTabState: (tabId: number) => Promise<CurrentTabState | null>;
  getCurrentTabState: (windowId?: number | null) => Promise<CurrentTabState | null>;
  setWindowEnabled: (
    windowId: number,
    title: string,
    enabled: boolean,
    context?: { tabId: number; url: string }
  ) => Promise<void>;
  setCurrentWindowEnabled: (enabled: boolean) => Promise<void>;
  getAgentTabState?: (windowId: number, currentTabId: number) => Promise<AgentTabUiState[]>;
  moveAgentToTab?: (tabId: number) => Promise<void>;
  requestWindowAction?: (
    action: import('../../../protocol/src/window-access.js').WindowAction,
    entry: import('../../../protocol/src/window-access.js').BrowserWindowAccess
  ) => Promise<void>;
  handleSetupInstallAction: (message: Record<string, unknown>) => Promise<void>;
};
import { BridgeError, ERROR_CODES, sanitizeIncidentalText } from '../../../protocol/src/index.js';
import { POPUP_PATH } from './background-state.js';

export function getUiSurfaceFromPortName(portName: string): 'popup' | 'sidepanel' | null {
  if (portName === 'ui-popup') {
    return 'popup';
  }
  if (portName === 'ui-sidepanel') {
    return 'sidepanel';
  }
  if (portName === 'ui') {
    return 'popup';
  }
  return null;
}

function postToUiPort(
  state: ExtensionState,
  port: chrome.runtime.Port,
  message: Record<string, unknown>
): boolean {
  try {
    port.postMessage(message);
    return true;
  } catch {
    state.uiPorts.delete(port);
    return false;
  }
}

export function broadcastUi(state: ExtensionState, message: Record<string, unknown>): void {
  for (const port of state.uiPorts.keys()) {
    postToUiPort(state, port, message);
  }
}

export async function emitUiState(state: ExtensionState, deps: UiDeps): Promise<void> {
  await Promise.all([...state.uiPorts.keys()].map((port) => emitUiStateForPort(state, port, deps)));
}

const pendingSnapshots: WeakMap<chrome.runtime.Port, object> = new WeakMap();

function getOtherEnabledWindows(
  state: ExtensionState,
  windowId: number | null | undefined
): import('../../../protocol/src/window-access.js').BrowserWindowAccess[] {
  return [
    ...(state.enabledWindow && state.enabledWindow.windowId !== windowId
      ? [
          {
            extensionId: 'local',
            browserName: null,
            profileLabel: null,
            window: state.enabledWindow,
          },
        ]
      : []),
    ...(state.otherEnabledWindows ?? []),
  ];
}

export async function emitUiStateForPort(
  state: ExtensionState,
  port: chrome.runtime.Port,
  deps: UiDeps
): Promise<void> {
  const portState = state.uiPorts.get(port);
  if (!portState) {
    return;
  }
  const snapshot = {};
  pendingSnapshots.set(port, snapshot);

  deps.refreshSetupStatus();

  const currentTab = portState.scopeTabId
    ? await deps.getTabState(portState.scopeTabId)
    : await deps.getCurrentTabState(portState.scopeWindowId);
  // A state request may bind the panel while the initial lookup is still pending.
  if (state.uiPorts.get(port) !== portState || pendingSnapshots.get(port) !== snapshot) {
    return;
  }
  const scopedTabId = currentTab?.tabId ?? portState.scopeTabId ?? null;
  const agentTabs =
    currentTab?.enabled && deps.getAgentTabState
      ? await deps.getAgentTabState(currentTab.windowId, currentTab.tabId)
      : [];
  if (state.uiPorts.get(port) !== portState || pendingSnapshots.get(port) !== snapshot) {
    return;
  }

  postToUiPort(state, port, {
    type: 'state.sync',
    state: {
      nativeConnected: Boolean(state.nativePort),
      nativeUnstable: state.nativeUnstable === true,
      nativeHostVersion: state.nativeHostVersion,
      daemonProxy: state.daemonProxy,
      currentTab,
      otherEnabledWindows: getOtherEnabledWindows(
        state,
        currentTab?.windowId ?? portState.scopeWindowId
      ),
      ...(agentTabs.length ? { agentTabs } : {}),
      setupStatus: state.setupStatus,
      setupStatusPending: state.setupStatusPending,
      setupStatusError: state.setupStatusError,
      setupInstallPendingKey: state.setupInstallPendingKey,
      setupInstallError: state.setupInstallError,
      actionLog: [...state.actionLog].filter((entry) => entry.tabId === scopedTabId).reverse(),
    },
  });
}

/** Handle commands coming from the popup or side panel. */
export async function handleUiMessage(
  state: ExtensionState,
  port: chrome.runtime.Port,
  message: Record<string, unknown>,
  deps: UiDeps
): Promise<void> {
  if (message?.type === 'windows.focus' || message?.type === 'windows.disable_others') {
    const action = message.type === 'windows.focus' ? 'focus' : 'disable';
    try {
      const scope = state.uiPorts.get(port);
      if (!scope || !deps.requestWindowAction)
        throw new Error('Window controls are unavailable. Reload the extension.');
      const requestWindowAction = deps.requestWindowAction;
      const tab = scope.scopeTabId
        ? await deps.getTabState(scope.scopeTabId)
        : await deps.getCurrentTabState(scope.scopeWindowId);
      const windowId = tab?.windowId ?? scope.scopeWindowId;
      if (windowId == null)
        throw new Error('Could not identify the current window. Reopen the side panel.');
      const windows = getOtherEnabledWindows(state, windowId);
      if (action === 'focus') {
        const entry = windows.find(
          (entry) =>
            entry.extensionId === message.extensionId &&
            entry.window !== null &&
            entry.window.windowId === message.windowId &&
            entry.window.enabledAt === message.enabledAt
        );
        if (!entry) throw new Error('Window access changed. Refresh the list and try again.');
        await requestWindowAction('focus', entry);
      } else {
        // Snapshot only the other grants visible at the click, never the current grant.
        const results = await Promise.allSettled(
          windows.map((entry) => requestWindowAction('disable', entry))
        );
        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length) {
          const reason = failures[0].reason as unknown;
          const detail = reason instanceof Error ? reason.message : 'Window action failed.';
          throw new Error(
            `${failures.length} ${failures.length === 1 ? 'window could' : 'windows could'} not be disabled. ${detail}`
          );
        }
      }
      postToUiPort(state, port, { type: 'windows.action.result', action, ok: true });
    } catch (error) {
      postToUiPort(state, port, {
        type: 'windows.action.result',
        action,
        ok: false,
        error: error instanceof Error ? error.message : 'Window action failed.',
      });
    }
    return;
  }
  if (message?.type === 'state.request') {
    const scopeTabId = Number(message.scopeTabId);
    const scopeWindowId = Number(message.scopeWindowId);
    const currentPortState = state.uiPorts.get(port);
    if (!currentPortState) {
      return;
    }
    state.uiPorts.set(port, {
      surface: currentPortState.surface,
      scopeTabId: Number.isFinite(scopeTabId) && scopeTabId > 0 ? scopeTabId : null,
      ...(Number.isInteger(scopeWindowId) && scopeWindowId > 0 ? { scopeWindowId } : {}),
    });
    deps.refreshSetupStatus();
    await emitUiStateForPort(state, port, deps);
    return;
  }

  if (message?.type === 'setup.status.refresh') {
    deps.refreshSetupStatus(true);
    await emitUiStateForPort(state, port, deps);
    return;
  }

  if (message?.type === 'scope.set_enabled') {
    const requestedTabId = Number(message.tabId);
    try {
      // -- DEBUG: simulate slow/error toggles. Set to "delay", "error", or "" --
      const _TOGGLE_SIM = '' as 'delay' | 'error' | '';
      if (_TOGGLE_SIM === 'delay') {
        await new Promise((resolve) => setTimeout(resolve, 6000));
      } else if (_TOGGLE_SIM === 'error') {
        if (Math.random() > 0.3) {
          throw new Error('Something went wrong.');
        }
      }
      // -- END DEBUG --
      if (Number.isFinite(requestedTabId) && requestedTabId > 0) {
        const tabState = await deps.getTabState(requestedTabId);
        if (!tabState) {
          throw new BridgeError(ERROR_CODES.TAB_MISMATCH, 'Requested tab state not found');
        }
        await deps.setWindowEnabled(tabState.windowId, tabState.title, Boolean(message.enabled), {
          tabId: tabState.tabId,
          url: tabState.url,
        });
      } else {
        await deps.setCurrentWindowEnabled(Boolean(message.enabled));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      try {
        port.postMessage({ type: 'toggle.error', error: errorMessage });
      } catch {
        /* port may have disconnected */
      }
      throw error;
    }
    return;
  }

  if (message?.type === 'agent.move_here') {
    const tabId = Number(message.tabId);
    if (Number.isInteger(tabId) && tabId > 0 && deps.moveAgentToTab) {
      await deps.moveAgentToTab(tabId);
    }
    return;
  }

  if (message?.type === 'setup.install') {
    await deps.handleSetupInstallAction(message);
  }
}

/** Configure and open the side panel for a single tab so the panel is attached
to the current tab instead of acting like a window-global surface. */
export async function openSidePanelForTab(
  tabId: number,
  windowId: number,
  chromeObj: typeof globalThis.chrome,
  sidePanelPath: string
): Promise<void> {
  await chromeObj.sidePanel.setOptions({
    tabId,
    path: `${sidePanelPath}?tabId=${encodeURIComponent(String(tabId))}`,
    enabled: true,
  });
  await chromeObj.sidePanel.open({
    tabId,
    windowId,
  });
}

/** Open Browser Bridge UI for an agent-side access request. If the side panel
is already open for that window, leave it in place so its existing attention
state continues to guide the user. Otherwise open one controlled popup
window so multiple browser windows cannot splash duplicate prompts. */
export async function openRequestedAccessUi(
  target: ResolvedTabTarget,
  state: ExtensionState,
  chromeObj: typeof globalThis.chrome,
  deps: AccessRequestUiDeps
): Promise<void> {
  if (await isSidePanelOpenForWindow(target.windowId, state, deps)) {
    return;
  }

  try {
    await openRequestedAccessPopupWindow(target, state, chromeObj);
  } catch (error) {
    console.warn(
      'Could not open Browser Bridge popup window for access request.',
      sanitizeIncidentalText(error instanceof Error ? error.message : String(error))
    );
  }
}

/** Open the popup UI in its own small extension window, scoped to the requested
tab. Reuse the same popup window while access remains pending so only one
visible prompt exists across browser windows. */
async function openRequestedAccessPopupWindow(
  target: ResolvedTabTarget,
  state: ExtensionState,
  chromeObj: typeof globalThis.chrome
): Promise<void> {
  const popupUrl = chromeObj.runtime.getURL(
    `${POPUP_PATH}?tabId=${encodeURIComponent(String(target.tabId))}&windowed=1`
  );
  const popupWidth = 420;
  const popupHeight = 320;
  const popupPlacement = await getRequestedAccessPopupPlacement(
    target.windowId,
    popupWidth,
    chromeObj
  );

  if (state.requestedAccessPopupWindowId != null) {
    try {
      const existingWindow = await chromeObj.windows.get(state.requestedAccessPopupWindowId, {
        populate: true,
      });
      const existingWindowId = typeof existingWindow.id === 'number' ? existingWindow.id : null;
      const popupTabId = existingWindow.tabs?.find((tab) => typeof tab.id === 'number')?.id ?? null;
      if (existingWindowId == null || popupTabId == null) {
        throw new Error('Requested access popup window is missing its tab.');
      }
      await chromeObj.tabs.update(popupTabId, { url: popupUrl });
      await chromeObj.windows.update(existingWindowId, {
        focused: true,
        ...(popupPlacement ?? {}),
      });
      return;
    } catch {
      state.requestedAccessPopupWindowId = null;
    }
  }

  let createData = {
    url: popupUrl,
    type: 'popup',
    focused: true,
    width: popupWidth,
    height: popupHeight,
  } as chrome.windows.CreateData;

  if (popupPlacement) {
    createData = {
      ...createData,
      ...popupPlacement,
    };
  }

  const popupWindow = await chromeObj.windows.create(createData);
  state.requestedAccessPopupWindowId = typeof popupWindow?.id === 'number' ? popupWindow.id : null;
}

export async function getRequestedAccessPopupPlacement(
  targetWindowId: number,
  popupWidth: number,
  chromeObj: typeof globalThis.chrome
): Promise<Pick<chrome.windows.UpdateInfo, 'left' | 'top'> | null> {
  try {
    const browserWindow = await chromeObj.windows.get(targetWindowId);
    if (
      typeof browserWindow.left === 'number' &&
      typeof browserWindow.top === 'number' &&
      typeof browserWindow.width === 'number'
    ) {
      return {
        left: browserWindow.left + Math.max(24, browserWindow.width - popupWidth - 40),
        top: browserWindow.top + 72,
      };
    }
  } catch {
    // Ignore window positioning failures and fall back to Chrome defaults.
  }

  return null;
}

async function isSidePanelOpenForWindow(
  windowId: number,
  state: ExtensionState,
  deps: AccessRequestUiDeps
): Promise<boolean> {
  for (const portState of state.uiPorts.values()) {
    if (portState.surface !== 'sidepanel') {
      continue;
    }
    const currentTab = portState.scopeTabId
      ? await deps.getTabState(portState.scopeTabId)
      : await deps.getCurrentTabState(portState.scopeWindowId);
    if (currentTab?.windowId === windowId) {
      return true;
    }
  }
  return false;
}
