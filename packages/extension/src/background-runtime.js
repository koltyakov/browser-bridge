// @ts-check

/**
 * @typedef {{
 *   openSidePanelForTab: (tabId: number, windowId: number) => Promise<void>
 * }} RuntimeMessageListenerOptions
 */

/**
 * @param {(response: { ok: boolean, error?: string }) => void} sendResponse
 * @param {Promise<void>} operation
 * @returns {void}
 */
function settleSidePanelOpen(sendResponse, operation) {
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

/**
 * Create the runtime message listener used by the background service worker so
 * its side-panel routing behavior can be tested without importing the whole
 * background module and mocking every Chrome API.
 *
 * @param {RuntimeMessageListenerOptions} options
 * @returns {(message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: { ok: boolean, error?: string }) => void) => boolean}
 */
export function createRuntimeMessageListener(options) {
  return (message, sender, sendResponse) => {
    const candidate =
      message && typeof message === 'object'
        ? /** @type {Record<string, unknown>} */ (message)
        : null;
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
