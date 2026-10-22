export type SetupStatus = import('../../../protocol/src/types.js').SetupStatus;

export type SidePanelCurrentTab = {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  enabled: boolean;
  accessRequested: boolean;
  restricted: boolean;
  accessRequestContext?: import('./background-state.js').AccessRequestContext;
};

export type ActionLogEntry = {
  id: string;
  at: number;
  method: string;
  source: string;
  mcpEra?: import('../../../protocol/src/types.js').McpProtocolEra | null;
  tabId: number | null;
  url: string;
  ok: boolean;
  summary: string;
  responseBytes: number;
  approxTokens: number;
  imageApproxTokens: number;
  costClass: 'cheap' | 'moderate' | 'heavy' | 'extreme';
  imageBytes: number;
  summaryBytes: number;
  summaryTokens: number;
  summaryCostClass: 'cheap' | 'moderate' | 'heavy' | 'extreme';
  debuggerBacked: boolean;
  overBudget: boolean;
  hasScreenshot: boolean;
  nodeCount: number | null;
  continuationHint: string | null;
  severity?: 'info' | 'warning';
  sensitiveAccess?: {
    source: 'local_storage' | 'session_storage';
    category: 'storage_value';
    keyLength: number;
  } | null;
};

export type DaemonProxyStatus = {
  enabled: boolean;
  endpoint: string | null;
};

export type UiSnapshot = {
  nativeConnected: boolean;
  nativeUnstable?: boolean;
  nativeHostVersion: string | null;
  daemonProxy: DaemonProxyStatus | null;
  currentTab: SidePanelCurrentTab | null;
  agentTabs?: import('./background-ui.js').AgentTabUiState[];
  otherEnabledWindows?: import('../../../protocol/src/window-access.js').BrowserWindowAccess[];
  setupStatus: SetupStatus | null;
  setupStatusPending: boolean;
  setupStatusError: string | null;
  setupInstallPendingKey: string | null;
  setupInstallError: string | null;
  actionLog: ActionLogEntry[];
};

export type SidePanelMessage =
  | {
      type: 'native.status';
      connected: boolean;
      unstable?: boolean;
      error?: string;
    }
  | {
      type: 'state.sync';
      state: UiSnapshot;
    }
  | {
      type: 'toggle.error';
      error: string;
    }
  | {
      type: 'windows.action.result';
      action: import('../../../protocol/src/window-access.js').WindowAction;
      ok: boolean;
      error?: string;
    };

export type SidePanelMessageHandlerOptions = {
  renderNativeStatus: (connected: boolean, error?: string, unstable?: boolean) => void;
  renderState: (state: UiSnapshot) => void;
  renderToggleError: (errorMessage: string) => void;
  renderWindowActionResult?: (
    message: import('../../../protocol/src/window-access.js').WindowActionUiResult
  ) => void;
};

export type SidePanelStateRequestMessage = {
  type: 'state.request';
  scopeTabId?: number;
  scopeWindowId?: number;
};

export type SidePanelRuntimePort = {
  onMessage: {
    addListener: (listener: (message: SidePanelMessage) => void) => void;
  };
  onDisconnect: {
    addListener: (listener: () => void) => void;
  };
  postMessage: (message: SidePanelStateRequestMessage) => void;
};

export type SidePanelStateRenderOptions = {
  hideSetupContextMenu: () => void;
  renderNativeStatus: (connected: boolean, error?: string, unstable?: boolean) => void;
  renderCurrentTab: (currentTab: SidePanelCurrentTab | null) => void;
  renderAgentStatus: (state: UiSnapshot) => void;
  renderPromptExamples: (setupStatus: SetupStatus | null) => void;
  renderSetupStatus: (
    setupStatus: SetupStatus | null,
    pending: boolean,
    error: string | null,
    installPendingKey: string | null,
    installError: string | null
  ) => void;
  renderActionLogEntry: (
    entry: ActionLogEntry,
    setupStatus: SetupStatus | null,
    entries: ActionLogEntry[],
    index: number
  ) => HTMLElement;
  replaceActionLogChildren: (children: HTMLElement[]) => void;
  setCurrentActionLog: (entries: ActionLogEntry[]) => void;
  updateActivityVisualizations: () => void;
  showEmptyActionLog: () => void;
  collapseExamples: () => void;
  syncConnectedSectionsVisibility: () => void;
  syncSetupStatusPolling: () => void;
};

export function createSidepanelMessageHandler(
  options: SidePanelMessageHandlerOptions
): (message: SidePanelMessage) => void {
  return (message) => {
    if (message.type === 'native.status') {
      options.renderNativeStatus(message.connected, message.error, message.unstable === true);
      return;
    }

    if (message.type === 'state.sync') {
      options.renderState(message.state);
      return;
    }

    if (message.type === 'toggle.error') {
      options.renderToggleError(message.error);
    }
    if (message.type === 'windows.action.result') {
      options.renderWindowActionResult?.(message);
    }
  };
}

export function readRequestedTabId(search: string): number | null {
  const value = new URLSearchParams(search).get('tabId');
  const tabId = Number(value);
  return Number.isFinite(tabId) && tabId > 0 ? tabId : null;
}

export function connectSidepanelPort({
  connect,
  onMessage,
  scheduleReconnect,
  onReconnect,
  reconnectDelayMs = 500,
  scopeTabId,
  scopeWindowId,
}: {
  connect: (connectInfo: chrome.runtime.ConnectInfo) => SidePanelRuntimePort;
  onMessage: (message: SidePanelMessage) => void;
  scheduleReconnect: (callback: () => void, delayMs: number) => void;
  onReconnect?: () => void;
  reconnectDelayMs?: number;
  scopeTabId?: number | null;
  scopeWindowId?: number | null;
}): SidePanelRuntimePort {
  const port = connect({ name: 'ui-sidepanel' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    scheduleReconnect(() => {
      onReconnect?.();
    }, reconnectDelayMs);
  });
  port.postMessage({
    type: 'state.request',
    ...(scopeTabId != null ? { scopeTabId } : {}),
    ...(scopeWindowId != null ? { scopeWindowId } : {}),
  });
  return port;
}

/** Connection checks remain visible in history but do not count as agent work. */
export function hasSidepanelAgentWork(state: Pick<UiSnapshot, 'agentTabs' | 'actionLog'>): boolean {
  return (
    Boolean(state.agentTabs?.length) ||
    state.actionLog.some((entry) => entry.method !== 'health.ping')
  );
}

export function renderSidepanelState(
  state: UiSnapshot,
  options: SidePanelStateRenderOptions
): void {
  options.hideSetupContextMenu();
  options.renderNativeStatus(state.nativeConnected, undefined, state.nativeUnstable === true);
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
  }
  if (hasSidepanelAgentWork(state)) {
    options.collapseExamples();
  }

  options.syncConnectedSectionsVisibility();
  options.syncSetupStatusPolling();
}
