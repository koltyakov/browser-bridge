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

export type ExtensionState = import('./background-state.js').ExtensionState;

export type SetupControllerDeps = {
  appendActionLogEntry: (entry: {
    method: string;
    ok: boolean;
    summary: string;
    source?: string;
  }) => Promise<void>;
  emitUiState: () => Promise<void>;
};

export function createSetupController(
  state: ExtensionState,
  deps: SetupControllerDeps
): {
  clearSetupStatus: (errorMessage?: string | null) => void;
  handleHostStatusMessage: (message: unknown) => boolean;
  handleSetupInstallAction: (message: Record<string, unknown>) => Promise<void>;
  refreshSetupStatus: (force?: boolean) => void;
} {
  function refreshSetupStatus(force: boolean = false): void {
    refreshSetupStatusNative(state, { emitUiState: deps.emitUiState }, force);
  }

  function clearSetupStatus(errorMessage: string | null = null): void {
    clearSetupStatusNative(state, errorMessage);
  }

  function handleHostStatusMessage(message: unknown): boolean {
    return handleHostStatusMessageNative(message, state, {
      appendActionLogEntry: deps.appendActionLogEntry,
      emitUiState: deps.emitUiState,
      getSetupActionMethodLabel,
      getSetupActionSuccessSummary,
      getSetupActionErrorSummary,
      refreshSetupStatus,
    });
  }

  async function handleSetupInstallAction(message: Record<string, unknown>): Promise<void> {
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
