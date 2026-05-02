// @ts-check

/** @typedef {import('../../protocol/src/types.js').SetupStatus} SetupStatus */

/**
 * @typedef {{
 *   tabId: number,
 *   windowId: number,
 *   title: string,
 *   url: string,
 *   enabled: boolean,
 *   accessRequested: boolean,
 *   restricted: boolean
 * }} SidePanelCurrentTab
 */

/**
 * @typedef {{
 *   id: string,
 *   at: number,
 *   method: string,
 *   source: string,
 *   tabId: number | null,
 *   url: string,
 *   ok: boolean,
 *   summary: string,
 *   responseBytes: number,
 *   approxTokens: number,
 *   imageApproxTokens: number,
 *   costClass: 'cheap' | 'moderate' | 'heavy' | 'extreme',
 *   imageBytes: number,
 *   summaryBytes: number,
 *   summaryTokens: number,
 *   summaryCostClass: 'cheap' | 'moderate' | 'heavy' | 'extreme',
 *   debuggerBacked: boolean,
 *   overBudget: boolean,
 *   hasScreenshot: boolean,
 *   nodeCount: number | null,
 *   continuationHint: string | null
 * }} ActionLogEntry
 */

/**
 * @typedef {{
 *   nativeConnected: boolean,
 *   currentTab: SidePanelCurrentTab | null,
 *   setupStatus: SetupStatus | null,
 *   setupStatusPending: boolean,
 *   setupStatusError: string | null,
 *   setupInstallPendingKey: string | null,
 *   setupInstallError: string | null,
 *   actionLog: ActionLogEntry[]
 * }} UiSnapshot
 */

/**
 * @typedef {{
 *   type: 'native.status',
 *   connected: boolean,
 *   error?: string
 * } | {
 *   type: 'state.sync',
 *   state: UiSnapshot
 * } | {
 *   type: 'toggle.error',
 *   error: string
 * }} SidePanelMessage
 */

/**
 * @typedef {{
 *   renderNativeStatus: (connected: boolean, error?: string) => void,
 *   renderState: (state: UiSnapshot) => void,
 *   renderToggleError: (errorMessage: string) => void
 * }} SidePanelMessageHandlerOptions
 */

/**
 * @typedef {{
 *   type: 'state.request'
 * }} SidePanelStateRequestMessage
 */

/**
 * @typedef {{
 *   onMessage: {
 *     addListener: (listener: (message: SidePanelMessage) => void) => void
 *   },
 *   onDisconnect: {
 *     addListener: (listener: () => void) => void
 *   },
 *   postMessage: (message: SidePanelStateRequestMessage) => void
 * }} SidePanelRuntimePort
 */

/**
 * @typedef {{
 *   hideSetupContextMenu: () => void,
 *   renderNativeStatus: (connected: boolean) => void,
 *   renderCurrentTab: (currentTab: SidePanelCurrentTab | null) => void,
 *   renderAgentStatus: (state: UiSnapshot) => void,
 *   renderPromptExamples: (setupStatus: SetupStatus | null) => void,
 *   renderSetupStatus: (
 *     setupStatus: SetupStatus | null,
 *     pending: boolean,
 *     error: string | null,
 *     installPendingKey: string | null,
 *     installError: string | null
 *   ) => void,
 *   renderActionLogEntry: (
 *     entry: ActionLogEntry,
 *     setupStatus: SetupStatus | null,
 *     entries: ActionLogEntry[],
 *     index: number
 *   ) => HTMLElement,
 *   replaceActionLogChildren: (children: HTMLElement[]) => void,
 *   setCurrentActionLog: (entries: ActionLogEntry[]) => void,
 *   updateActivityVisualizations: () => void,
 *   showEmptyActionLog: () => void,
 *   collapseExamples: () => void,
 *   syncConnectedSectionsVisibility: () => void,
 *   syncSetupStatusPolling: () => void
 * }} SidePanelStateRenderOptions
 */

/**
 * @param {SidePanelMessageHandlerOptions} options
 * @returns {(message: SidePanelMessage) => void}
 */
export function createSidepanelMessageHandler(options) {
  return (message) => {
    if (message.type === 'native.status') {
      options.renderNativeStatus(message.connected, message.error);
      return;
    }

    if (message.type === 'state.sync') {
      options.renderState(message.state);
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
export function readRequestedTabId(search) {
  const value = new URLSearchParams(search).get('tabId');
  const tabId = Number(value);
  return Number.isFinite(tabId) && tabId > 0 ? tabId : null;
}

/**
 * @param {{
 *   connect: (connectInfo: chrome.runtime.ConnectInfo) => SidePanelRuntimePort,
 *   onMessage: (message: SidePanelMessage) => void,
 *   scheduleReconnect: (callback: () => void, delayMs: number) => void,
 *   onReconnect?: () => void,
 *   reconnectDelayMs?: number
 * }} options
 * @returns {SidePanelRuntimePort}
 */
export function connectSidepanelPort({
  connect,
  onMessage,
  scheduleReconnect,
  onReconnect,
  reconnectDelayMs = 500,
}) {
  const port = connect({ name: 'ui-sidepanel' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    scheduleReconnect(() => {
      onReconnect?.();
    }, reconnectDelayMs);
  });
  port.postMessage({ type: 'state.request' });
  return port;
}

/**
 * @param {UiSnapshot} state
 * @param {SidePanelStateRenderOptions} options
 * @returns {void}
 */
export function renderSidepanelState(state, options) {
  options.hideSetupContextMenu();
  options.renderNativeStatus(state.nativeConnected);
  options.renderCurrentTab(state.currentTab);
  options.renderAgentStatus(state);
  options.renderPromptExamples(state.setupStatus);
  options.renderSetupStatus(
    state.setupStatus,
    state.setupStatusPending,
    state.setupStatusError,
    state.setupInstallPendingKey,
    state.setupInstallError
  );

  options.replaceActionLogChildren(
    state.actionLog.map((entry, index, entries) =>
      options.renderActionLogEntry(entry, state.setupStatus, entries, index)
    )
  );
  options.setCurrentActionLog(state.actionLog);
  options.updateActivityVisualizations();

  if (!state.actionLog.length) {
    options.showEmptyActionLog();
  } else {
    options.collapseExamples();
  }

  options.syncConnectedSectionsVisibility();
  options.syncSetupStatusPolling();
}
