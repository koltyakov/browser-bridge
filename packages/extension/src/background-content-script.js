// @ts-check

/**
 * @typedef {{
 *   contentScriptTimeoutMs: number,
 *   isRestrictedAutomationUrl: (url: string) => boolean,
 * }} ContentScriptBridgeDeps
 */

/** @type {string[]} */
const CONTENT_SCRIPT_FILES = [
  'packages/extension/src/content-script-helpers.js',
  'packages/extension/src/content-element-registry.js',
  'packages/extension/src/content-dom-query.js',
  'packages/extension/src/content-input.js',
  'packages/extension/src/content-patch.js',
  'packages/extension/src/content-script.js',
];

/**
 * Detect Chrome scripting errors that indicate a restricted or unscriptable page.
 *
 * @param {string} message
 * @returns {boolean}
 */
export function isRestrictedScriptingError(message) {
  return (
    /Cannot access contents of/i.test(message) ||
    /The extensions gallery cannot be scripted/i.test(message) ||
    /Cannot access a chrome:\/\//i.test(message) ||
    /Cannot script/i.test(message)
  );
}

/**
 * Chrome returns this when a tab is scriptable, but the current document does
 * not have our content-script listener anymore, commonly during reloads or SPA
 * document swaps between the preflight ping and the actual command.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isMissingContentScriptReceiverError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /Could not establish connection/i.test(message) && /Receiving end does not exist/i.test(message)
  );
}

/**
 * @param {typeof globalThis.chrome} chromeObj
 * @param {ContentScriptBridgeDeps} deps
 * @returns {{
 *   sendTabMessage: (tabId: number, message: Record<string, unknown>, timeoutMs: number) => Promise<any>,
 *   injectContentScriptsForWindow: (windowId: number) => Promise<void>,
 *   ensureContentScript: (tabId: number) => Promise<void>,
 * }}
 */
export function createContentScriptBridge(chromeObj, deps) {
  /**
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async function injectContentScript(tabId) {
    try {
      await chromeObj.scripting.executeScript({
        target: { tabId },
        files: CONTENT_SCRIPT_FILES,
      });
    } catch (injectError) {
      const msg = injectError instanceof Error ? injectError.message : String(injectError);
      if (isRestrictedScriptingError(msg)) {
        throw new Error(
          'CONTENT_SCRIPT_UNAVAILABLE: Content script not available on this page (restricted or extension page).',
          { cause: injectError }
        );
      }
      throw injectError;
    }
  }

  /**
   * Send a message to the content script and fail fast if it does not respond.
   *
   * @param {number} tabId
   * @param {Record<string, unknown>} message
   * @param {number} timeoutMs
   * @returns {Promise<any>}
   */
  async function sendTabMessage(tabId, message, timeoutMs) {
    try {
      return await sendTabMessageWithTimeout(tabId, message, timeoutMs);
    } catch (error) {
      if (!isMissingContentScriptReceiverError(error)) {
        throw error;
      }
      await injectContentScript(tabId);
      return await sendTabMessageWithTimeout(tabId, message, timeoutMs);
    }
  }

  /**
   * @param {number} tabId
   * @param {Record<string, unknown>} message
   * @param {number} timeoutMs
   * @returns {Promise<unknown>}
   */
  async function sendTabMessageWithTimeout(tabId, message, timeoutMs) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () =>
          reject(new Error(`Timed out waiting for content script response after ${timeoutMs}ms.`)),
        timeoutMs
      );
    });
    try {
      return await Promise.race([chromeObj.tabs.sendMessage(tabId, message), timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Ensure the content script is present on the target tab before issuing
   * content-script-backed requests. This makes page operations resilient after
   * extension reloads or on tabs that predate the current extension version.
   *
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async function ensureContentScript(tabId) {
    try {
      await sendTabMessage(tabId, { type: 'bridge.ping' }, deps.contentScriptTimeoutMs);
      return;
    } catch {
      await injectContentScript(tabId);
    }
  }

  /**
   * Proactively inject content scripts into all scriptable tabs in a window
   * when Bridge access is enabled. Errors on restricted pages are silently
   * ignored since ensureContentScript will handle them on demand.
   *
   * @param {number} windowId
   * @returns {Promise<void>}
   */
  async function injectContentScriptsForWindow(windowId) {
    const tabs = await chromeObj.tabs.query({ windowId });
    await Promise.allSettled(
      tabs
        .map((tab) =>
          typeof tab.id === 'number' &&
          Number.isFinite(tab.id) &&
          tab.url &&
          !deps.isRestrictedAutomationUrl(tab.url)
            ? tab.id
            : null
        )
        .filter((tabId) => tabId !== null)
        .map((tabId) => ensureContentScript(tabId))
    );
  }

  return {
    sendTabMessage,
    injectContentScriptsForWindow,
    ensureContentScript,
  };
}
