export type PopupCurrentTab = {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  enabled: boolean;
  accessRequested: boolean;
  restricted: boolean;
  accessRequestContext?: import('./background-state.js').AccessRequestContext;
};

export type PopupMessage =
  | {
      type: 'state.sync';
      state: {
        nativeConnected: boolean;
        nativeUnstable?: boolean;
        currentTab: PopupCurrentTab | null;
      };
    }
  | {
      type: 'toggle.error';
      error: string;
    };

export type PopupMessageHandlerOptions = {
  renderNativeStatus: (connected: boolean, unstable?: boolean) => void;
  renderPopupState: (currentTab: PopupCurrentTab | null) => void;
  shouldResetPendingToggleOnSync: (
    currentTab: PopupCurrentTab | null,
    pendingEnabledState: boolean | null
  ) => boolean;
  getPendingEnabledState: () => boolean | null;
  resetPendingToggle: () => void;
  renderToggleError: (errorMessage: string) => void;
  windowedPopup: boolean;
  closeWindow: () => void;
};

export type PopupStateRequestMessage = {
  type: 'state.request';
  scopeTabId?: number;
};

export type PopupRuntimePort = {
  onMessage: {
    addListener: (listener: (message: PopupMessage) => void) => void;
  };
  postMessage: (message: PopupStateRequestMessage) => void;
};

export function createPopupMessageHandler(
  options: PopupMessageHandlerOptions
): (message: PopupMessage) => void {
  return (message) => {
    if (message.type === 'state.sync') {
      options.renderNativeStatus(
        message.state.nativeConnected,
        message.state.nativeUnstable === true
      );
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

export function readScopedTabId(search: string): number | null {
  const value = new URLSearchParams(search).get('tabId');
  const tabId = Number(value);
  return Number.isFinite(tabId) && tabId > 0 ? tabId : null;
}

export function isWindowedPopup(search: string): boolean {
  return new URLSearchParams(search).get('windowed') === '1';
}

export async function resolveInitialScopeTabId({
  search,
  queryTabs,
}: {
  search: string;
  queryTabs: (queryInfo: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>;
}): Promise<number | null> {
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

export async function connectPopupPort({
  search,
  queryTabs,
  connect,
  onMessage,
}: {
  search: string;
  queryTabs: (queryInfo: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>;
  connect: (connectInfo: chrome.runtime.ConnectInfo) => PopupRuntimePort;
  onMessage: (message: PopupMessage) => void;
}): Promise<{ popupScopeTabId: number | null; port: PopupRuntimePort }> {
  const popupScopeTabId = await resolveInitialScopeTabId({ search, queryTabs });
  const port = connect({ name: 'ui-popup' });
  port.onMessage.addListener(onMessage);
  port.postMessage({
    type: 'state.request',
    ...(popupScopeTabId != null ? { scopeTabId: popupScopeTabId } : {}),
  });
  return { popupScopeTabId, port };
}
