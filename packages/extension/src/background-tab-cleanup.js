// @ts-check

import { CONTENT_SCRIPT_TIMEOUT_MS, isNumber } from './background-state.js';

/**
 * @typedef {{
 *   ensureContentScript: (tabId: number) => Promise<void>,
 *   sendTabMessage: (tabId: number, message: Record<string, unknown>, timeoutMs: number) => Promise<any>,
 *   readConsoleBuffer: (tabId: number, clear: boolean, chrome: typeof globalThis.chrome) => Promise<unknown>,
 *   readNetworkBuffer: (tabId: number, clear: boolean, chrome: typeof globalThis.chrome) => Promise<unknown>,
 *   clearFetchInterception: (tabId: number) => Promise<number>,
 *   clearDebuggerState: (tabId: number) => Promise<void>,
 *   cancelNavigationWaitsForWindow: (windowId: number) => void,
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
 *   clearTabBridgeState: (tabId: number, shouldContinue?: () => Promise<boolean>) => Promise<void>,
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
  async function rollbackAllPatchesForTab(tabId, shouldContinue = async () => true) {
    try {
      if (!(await shouldContinue())) return;
      await deps.ensureContentScript(tabId);
      if (!(await shouldContinue())) return;
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
        if (!(await shouldContinue())) return;
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
  async function clearTabBridgeState(tabId, shouldContinue = async () => true) {
    if (!(await shouldContinue())) return;
    await deps.clearFetchInterception(tabId);
    if (!(await shouldContinue())) return;
    await deps.clearDebuggerState(tabId);
    if (!(await shouldContinue())) return;
    try {
      await rollbackAllPatchesForTab(tabId, shouldContinue);
    } catch (error) {
      if (!deps.isRecoverableInstrumentationError(error)) {
        throw error;
      }
    }
    if (!(await shouldContinue())) return;
    try {
      await deps.readConsoleBuffer(tabId, true, chrome);
    } catch (error) {
      if (!deps.isRecoverableInstrumentationError(error)) {
        throw error;
      }
    }
    if (!(await shouldContinue())) return;
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
    deps.cancelNavigationWaitsForWindow(windowId);
    const tabs = await chrome.tabs.query({ windowId });
    await Promise.allSettled(
      tabs.map((tab) => {
        if (!isNumber(tab.id)) return Promise.resolve();
        const tabId = tab.id;
        return tab.url && !deps.isRestrictedAutomationUrl(tab.url)
          ? clearTabBridgeState(tabId)
          : deps
              .clearFetchInterception(tabId)
              .then(() => deps.clearDebuggerState(tabId))
              .then(() => {});
      })
    );
  }

  return {
    clearTabBridgeState,
    clearWindowBridgeState,
    rollbackAllPatchesForTab,
  };
}

/**
 * Coordinate Chrome's detach/attach move events so tabs that land in the
 * enabled window keep valid state, while tabs that leave it are fully cleaned.
 *
 * @param {{
 *   getEnabledWindowId: () => number | null,
 *   isTabOutsideEnabledWindow: (tabId: number) => Promise<boolean>,
 *   cancelNavigationWaitsForMove: (tabId: number) => void,
 *   cancelNavigationWaitsForRemoval: (tabId: number) => void,
 *   clearDialogState: (tabId: number) => void,
 *   clearTabBridgeState: (tabId: number, shouldContinue?: () => Promise<boolean>) => Promise<void>,
 *   clearRemovedTabState: (tabId: number) => Promise<void>
 * }} deps
 * @returns {{
 *   handleDetached: (tabId: number, detachInfo: { oldWindowId: number }) => void,
 *   handleAttached: (tabId: number, attachInfo: { newWindowId: number }) => Promise<void>,
 *   handleRemoved: (tabId: number) => Promise<void>
 * }}
 */
export function createTabMoveCleanupController(deps) {
  /** @type {Set<number>} */
  const detachedFromEnabledWindow = new Set();

  /** @param {number} tabId @param {{ oldWindowId: number }} detachInfo */
  function handleDetached(tabId, detachInfo) {
    detachedFromEnabledWindow.delete(tabId);
    if (detachInfo.oldWindowId !== deps.getEnabledWindowId()) return;
    detachedFromEnabledWindow.add(tabId);
    deps.cancelNavigationWaitsForMove(tabId);
  }

  /** @param {number} tabId @param {{ newWindowId: number }} attachInfo */
  async function handleAttached(tabId, attachInfo) {
    const leftEnabledWindow = detachedFromEnabledWindow.delete(tabId);
    if (!leftEnabledWindow || attachInfo.newWindowId === deps.getEnabledWindowId()) return;
    if (!(await deps.isTabOutsideEnabledWindow(tabId))) return;
    if (attachInfo.newWindowId === deps.getEnabledWindowId()) return;

    deps.clearDialogState(tabId);
    await deps.clearTabBridgeState(tabId, () => deps.isTabOutsideEnabledWindow(tabId));
  }

  /** @param {number} tabId */
  async function handleRemoved(tabId) {
    detachedFromEnabledWindow.delete(tabId);
    deps.cancelNavigationWaitsForRemoval(tabId);
    deps.clearDialogState(tabId);
    await deps.clearRemovedTabState(tabId);
  }

  return { handleDetached, handleAttached, handleRemoved };
}
