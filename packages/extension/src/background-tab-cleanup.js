// @ts-check

import { CONTENT_SCRIPT_TIMEOUT_MS, isNumber } from './background-state.js';

/**
 * @typedef {{
 *   ensureContentScript: (tabId: number) => Promise<void>,
 *   sendTabMessage: (tabId: number, message: Record<string, unknown>, timeoutMs: number) => Promise<any>,
 *   readConsoleBuffer: (tabId: number, clear: boolean, chrome: typeof globalThis.chrome) => Promise<unknown>,
 *   readNetworkBuffer: (tabId: number, clear: boolean, chrome: typeof globalThis.chrome) => Promise<unknown>,
 *   clearFetchInterception: (tabId: number) => Promise<number>,
 *   isRecoverableInstrumentationError: (error: unknown) => boolean,
 *   isRestrictedAutomationUrl: (url: string) => boolean,
 * }} TabCleanupControllerDeps
 */

/**
 * Isolate tab/window cleanup so the background worker stays focused on request
 * orchestration instead of patch/buffer teardown details.
 *
 * @param {typeof globalThis.chrome} chrome
 * @param {TabCleanupControllerDeps} deps
 * @returns {{
 *   clearTabBridgeState: (tabId: number) => Promise<void>,
 *   clearWindowBridgeState: (windowId: number) => Promise<void>,
 *   rollbackAllPatchesForTab: (tabId: number) => Promise<void>,
 * }}
 */
export function createTabCleanupController(chrome, deps) {
  /**
   * Roll back all reversible patches currently tracked in one tab.
   *
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async function rollbackAllPatchesForTab(tabId) {
    try {
      await deps.ensureContentScript(tabId);
      const listed = await deps.sendTabMessage(
        tabId,
        {
          type: 'bridge.execute',
          method: 'patch.list',
          params: {},
        },
        CONTENT_SCRIPT_TIMEOUT_MS
      );
      const patches = Array.isArray(listed) ? listed : listed?.patches;
      if (!Array.isArray(patches)) {
        return;
      }
      for (const patch of [...patches].reverse()) {
        const patchId =
          patch && typeof patch === 'object'
            ? /** @type {Record<string, unknown>} */ (patch).patchId
            : null;
        if (typeof patchId !== 'string' || !patchId) {
          continue;
        }
        await deps.sendTabMessage(
          tabId,
          {
            type: 'bridge.execute',
            method: 'patch.rollback',
            params: { patchId },
          },
          CONTENT_SCRIPT_TIMEOUT_MS
        );
      }
    } catch (error) {
      if (!deps.isRecoverableInstrumentationError(error)) {
        throw error;
      }
    }
  }

  /**
   * Clear bridge buffers and roll back active patches for one tab.
   *
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async function clearTabBridgeState(tabId) {
    await deps.clearFetchInterception(tabId);
    try {
      await rollbackAllPatchesForTab(tabId);
    } catch (error) {
      if (!deps.isRecoverableInstrumentationError(error)) {
        throw error;
      }
    }
    try {
      await deps.readConsoleBuffer(tabId, true, chrome);
    } catch (error) {
      if (!deps.isRecoverableInstrumentationError(error)) {
        throw error;
      }
    }
    try {
      await deps.readNetworkBuffer(tabId, true, chrome);
    } catch (error) {
      if (!deps.isRecoverableInstrumentationError(error)) {
        throw error;
      }
    }
  }

  /**
   * Clear tab-local bridge state for all tabs in one window.
   *
   * @param {number} windowId
   * @returns {Promise<void>}
   */
  async function clearWindowBridgeState(windowId) {
    const tabs = await chrome.tabs.query({ windowId });
    await Promise.allSettled(
      tabs.map((tab) => {
        if (!isNumber(tab.id)) return Promise.resolve();
        return tab.url && !deps.isRestrictedAutomationUrl(tab.url)
          ? clearTabBridgeState(tab.id)
          : deps.clearFetchInterception(tab.id).then(() => {});
      })
    );
  }

  return {
    clearTabBridgeState,
    clearWindowBridgeState,
    rollbackAllPatchesForTab,
  };
}
