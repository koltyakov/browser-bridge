// @ts-check

import {
  clearSetupStatus as clearSetupStatusNative,
  getSetupActionErrorSummary,
  getSetupActionMethodLabel,
  getSetupActionStartSummary,
  getSetupActionSuccessSummary,
  getSetupActionTargetLabel,
  getSetupInstallKey,
  handleHostStatusMessage as handleHostStatusMessageNative,
  handleSetupInstallAction as handleSetupInstallActionNative,
  normalizeSetupInstallAction,
  refreshSetupStatus as refreshSetupStatusNative,
} from './background-native.js';

/** @typedef {import('./background-state.js').ExtensionState} ExtensionState */

/**
 * @typedef {{
 *   appendActionLogEntry: (entry: { method: string, ok: boolean, summary: string, source?: string }) => Promise<void>,
 *   emitUiState: () => Promise<void>,
 * }} SetupControllerDeps
 */

/**
 * @param {ExtensionState} state
 * @param {SetupControllerDeps} deps
 * @returns {{
 *   clearSetupStatus: (errorMessage?: string | null) => void,
 *   handleHostStatusMessage: (message: unknown) => boolean,
 *   handleSetupInstallAction: (message: Record<string, unknown>) => Promise<void>,
 *   refreshSetupStatus: (force?: boolean) => void,
 * }}
 */
export function createSetupController(state, deps) {
  /**
   * @param {boolean} [force=false]
   * @returns {void}
   */
  function refreshSetupStatus(force = false) {
    refreshSetupStatusNative(state, { emitUiState: deps.emitUiState }, force);
  }

  /**
   * @param {string | null} [errorMessage=null]
   * @returns {void}
   */
  function clearSetupStatus(errorMessage = null) {
    clearSetupStatusNative(state, errorMessage);
  }

  /**
   * @param {unknown} message
   * @returns {boolean}
   */
  function handleHostStatusMessage(message) {
    return handleHostStatusMessageNative(message, state, {
      appendActionLogEntry: deps.appendActionLogEntry,
      emitUiState: deps.emitUiState,
      getSetupActionMethodLabel,
      getSetupActionSuccessSummary,
      getSetupActionErrorSummary,
      refreshSetupStatus,
    });
  }

  /**
   * @param {Record<string, unknown>} message
   * @returns {Promise<void>}
   */
  async function handleSetupInstallAction(message) {
    await handleSetupInstallActionNative(message, state, {
      appendActionLogEntry: deps.appendActionLogEntry,
      emitUiState: deps.emitUiState,
    });
  }

  return {
    clearSetupStatus,
    handleHostStatusMessage,
    handleSetupInstallAction,
    refreshSetupStatus,
  };
}

export {
  getSetupActionErrorSummary,
  getSetupActionMethodLabel,
  getSetupActionStartSummary,
  getSetupActionSuccessSummary,
  getSetupActionTargetLabel,
  getSetupInstallKey,
  normalizeSetupInstallAction,
};
