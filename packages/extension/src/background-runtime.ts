export type RuntimeResponse = { ok: boolean; error?: string; details?: Record<string, unknown> };

export type RuntimeMessageListenerOptions = {
  openSidePanelForTab: (tabId: number, windowId: number) => Promise<void>;
  onNavigationSignal?: (
    tabId: number,
    kind: 'pushState' | 'replaceState' | 'popstate' | 'hashchange',
    channel: string
  ) => void;
  onWebMcpApproval?: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    reply: (response: RuntimeResponse) => void
  ) => boolean;
};

function settleSidePanelOpen(
  sendResponse: (response: { ok: boolean; error?: string }) => void,
  operation: Promise<void>
): void {
  void operation
    .then(() => {
      sendResponse({ ok: true });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

/** Create the runtime message listener used by the background service worker so
its side-panel routing behavior can be tested without importing the whole
background module and mocking every Chrome API. */
export function createRuntimeMessageListener(
  options: RuntimeMessageListenerOptions
): (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: RuntimeResponse) => void
) => boolean {
  return (message, sender, sendResponse) => {
    const candidate =
      message && typeof message === 'object' ? (message as Record<string, unknown>) : null;
    if (candidate?.type === 'webmcp.approval.get' || candidate?.type === 'webmcp.approval.decide') {
      return options.onWebMcpApproval?.(message, sender, sendResponse) ?? false;
    }
    if (
      candidate?.type === 'bridge.navigation-signal' &&
      typeof sender.tab?.id === 'number' &&
      typeof candidate.channel === 'string' &&
      candidate.channel.length > 0 &&
      candidate.channel.length <= 128 &&
      (candidate.kind === 'pushState' ||
        candidate.kind === 'replaceState' ||
        candidate.kind === 'popstate' ||
        candidate.kind === 'hashchange')
    ) {
      options.onNavigationSignal?.(sender.tab.id, candidate.kind, candidate.channel);
      return false;
    }
    if (candidate?.type !== 'bridge.open-sidepanel') {
      return false;
    }

    if (typeof candidate.tabId === 'number' && typeof candidate.windowId === 'number') {
      settleSidePanelOpen(
        sendResponse,
        options.openSidePanelForTab(candidate.tabId, candidate.windowId)
      );
      return true;
    }

    if (typeof sender.tab?.id === 'number' && typeof sender.tab.windowId === 'number') {
      settleSidePanelOpen(
        sendResponse,
        options.openSidePanelForTab(sender.tab.id, sender.tab.windowId)
      );
      return true;
    }

    return false;
  };
}
