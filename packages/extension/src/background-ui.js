// @ts-check

import { BridgeError, ERROR_CODES } from '../../protocol/src/index.js';
import { POPUP_PATH } from './background-state.js';

/** @typedef {import('./background-state.js').CurrentTabState} CurrentTabState */
/** @typedef {import('./background-state.js').ExtensionState} ExtensionState */
/** @typedef {import('./background-state.js').ResolvedTabTarget} ResolvedTabTarget */

/**
 * @typedef {{
 *   getTabState: (tabId: number) => Promise<CurrentTabState | null>,
 *   getCurrentTabState: () => Promise<CurrentTabState | null>,
 * }} AccessRequestUiDeps
 */

/**
 * @typedef {{
 *   refreshSetupStatus: (force?: boolean) => void,
 *   getTabState: (tabId: number) => Promise<CurrentTabState | null>,
 *   getCurrentTabState: () => Promise<CurrentTabState | null>,
 *   setWindowEnabled: (windowId: number, title: string, enabled: boolean) => Promise<void>,
 *   setCurrentWindowEnabled: (enabled: boolean) => Promise<void>,
 *   handleSetupInstallAction: (message: Record<string, unknown>) => Promise<void>,
 * }} UiDeps
 */

/**
 * @param {string} portName
 * @returns {'popup' | 'sidepanel' | null}
 */
export function getUiSurfaceFromPortName(portName) {
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

/**
 * @param {ExtensionState} state
 * @param {chrome.runtime.Port} port
 * @param {Record<string, unknown>} message
 * @returns {boolean}
 */
function postToUiPort(state, port, message) {
  try {
    port.postMessage(message);
    return true;
  } catch {
    state.uiPorts.delete(port);
    return false;
  }
}

/**
 * @param {ExtensionState} state
 * @param {Record<string, unknown>} message
 * @returns {void}
 */
export function broadcastUi(state, message) {
  for (const port of state.uiPorts.keys()) {
    postToUiPort(state, port, message);
  }
}

/**
 * @param {ExtensionState} state
 * @param {UiDeps} deps
 * @returns {Promise<void>}
 */
export async function emitUiState(state, deps) {
  await Promise.all([...state.uiPorts.keys()].map((port) => emitUiStateForPort(state, port, deps)));
}

/**
 * @param {ExtensionState} state
 * @param {chrome.runtime.Port} port
 * @param {UiDeps} deps
 * @returns {Promise<void>}
 */
export async function emitUiStateForPort(state, port, deps) {
  const portState = state.uiPorts.get(port);
  if (!portState) {
    return;
  }

  deps.refreshSetupStatus();

  const currentTab = portState.scopeTabId
    ? await deps.getTabState(portState.scopeTabId)
    : await deps.getCurrentTabState();
  const scopedTabId = currentTab?.tabId ?? portState.scopeTabId ?? null;

  postToUiPort(state, port, {
    type: 'state.sync',
    state: {
      nativeConnected: Boolean(state.nativePort),
      nativeUnstable: state.nativeUnstable === true,
      nativeHostVersion: state.nativeHostVersion,
      daemonProxy: state.daemonProxy,
      currentTab,
      setupStatus: state.setupStatus,
      setupStatusPending: state.setupStatusPending,
      setupStatusError: state.setupStatusError,
      setupInstallPendingKey: state.setupInstallPendingKey,
      setupInstallError: state.setupInstallError,
      actionLog: [...state.actionLog]
        .filter((entry) => scopedTabId == null || entry.tabId === scopedTabId)
        .reverse(),
    },
  });
}

/**
 * Handle commands coming from the popup or side panel.
 *
 * @param {ExtensionState} state
 * @param {chrome.runtime.Port} port
 * @param {Record<string, any>} message
 * @param {UiDeps} deps
 * @returns {Promise<void>}
 */
export async function handleUiMessage(state, port, message, deps) {
  if (message?.type === 'state.request') {
    const scopeTabId = Number(message.scopeTabId);
    const currentPortState = state.uiPorts.get(port);
    if (!currentPortState) {
      return;
    }
    state.uiPorts.set(port, {
      surface: currentPortState.surface,
      scopeTabId: Number.isFinite(scopeTabId) && scopeTabId > 0 ? scopeTabId : null,
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
      const _TOGGLE_SIM = /** @type {'delay' | 'error' | ''} */ ('');
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
        await deps.setWindowEnabled(tabState.windowId, tabState.title, Boolean(message.enabled));
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

  if (message?.type === 'setup.install') {
    await deps.handleSetupInstallAction(message);
  }
}

/**
 * Configure and open the side panel for a single tab so the panel is attached
 * to the current tab instead of acting like a window-global surface.
 *
 * @param {number} tabId
 * @param {number} windowId
 * @param {typeof globalThis.chrome} chromeObj
 * @param {string} sidePanelPath
 * @returns {Promise<void>}
 */
export async function openSidePanelForTab(tabId, windowId, chromeObj, sidePanelPath) {
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

/**
 * Open Browser Bridge UI for an agent-side access request. If the side panel
 * is already open for that window, leave it in place so its existing attention
 * state continues to guide the user. Otherwise open one controlled popup
 * window so multiple browser windows cannot splash duplicate prompts.
 *
 * @param {ResolvedTabTarget} target
 * @param {ExtensionState} state
 * @param {typeof globalThis.chrome} chromeObj
 * @param {AccessRequestUiDeps} deps
 * @returns {Promise<void>}
 */
export async function openRequestedAccessUi(target, state, chromeObj, deps) {
  if (await isSidePanelOpenForWindow(target.windowId, state, deps)) {
    return;
  }

  try {
    await openRequestedAccessPopupWindow(target, state, chromeObj);
  } catch (error) {
    console.warn('Could not open Browser Bridge popup window for access request.', error);
  }
}

/**
 * Open the popup UI in its own small extension window, scoped to the requested
 * tab. Reuse the same popup window while access remains pending so only one
 * visible prompt exists across browser windows.
 *
 * @param {ResolvedTabTarget} target
 * @param {ExtensionState} state
 * @param {typeof globalThis.chrome} chromeObj
 * @returns {Promise<void>}
 */
async function openRequestedAccessPopupWindow(target, state, chromeObj) {
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

  let createData = /** @type {chrome.windows.CreateData} */ ({
    url: popupUrl,
    type: 'popup',
    focused: true,
    width: popupWidth,
    height: popupHeight,
  });

  if (popupPlacement) {
    createData = {
      ...createData,
      ...popupPlacement,
    };
  }

  const popupWindow = await chromeObj.windows.create(createData);
  state.requestedAccessPopupWindowId = typeof popupWindow?.id === 'number' ? popupWindow.id : null;
}

/**
 * @param {number} targetWindowId
 * @param {number} popupWidth
 * @param {typeof globalThis.chrome} chromeObj
 * @returns {Promise<Pick<chrome.windows.UpdateInfo, 'left' | 'top'> | null>}
 */
export async function getRequestedAccessPopupPlacement(targetWindowId, popupWidth, chromeObj) {
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

/**
 * @param {number} windowId
 * @param {ExtensionState} state
 * @param {AccessRequestUiDeps} deps
 * @returns {Promise<boolean>}
 */
async function isSidePanelOpenForWindow(windowId, state, deps) {
  for (const portState of state.uiPorts.values()) {
    if (portState.surface !== 'sidepanel') {
      continue;
    }
    const currentTab = portState.scopeTabId
      ? await deps.getTabState(portState.scopeTabId)
      : await deps.getCurrentTabState();
    if (currentTab?.windowId === windowId) {
      return true;
    }
  }
  return false;
}
