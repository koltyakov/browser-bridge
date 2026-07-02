// @ts-check

import { BridgeError, ERROR_CODES, createRequest } from '../../protocol/src/index.js';
import { createNativePortMessageListener } from './background-bridge.js';
import { detectBrowserName } from './background-browser.js';
import { getErrorMessage } from './background-helpers.js';
import { scheduleReconnectAttempt } from './background-reconnect.js';
import {
  NATIVE_APP_NAME,
  NATIVE_RECONNECT_BASE_MS,
  NATIVE_RECONNECT_MAX_MS,
  reportAsyncError,
  SETUP_STATUS_STALE_MS,
  SETUP_STATUS_TIMEOUT_MS,
} from './background-state.js';

/** @typedef {import('./background-state.js').SetupInstallAction} SetupInstallAction */
/** @typedef {import('./background-state.js').ExtensionState} ExtensionState */
/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */
/** @typedef {import('../../protocol/src/types.js').SetupStatus} SetupStatus */

/**
 * @typedef {{
 *   appendActionLogEntry: (entry: { method: string, ok: boolean, summary: string, source?: string }) => Promise<void>,
 *   emitUiState: () => Promise<void>,
 * }} NativeDeps
 */

/**
 * @typedef {{
 *   appendActionLogEntry: (entry: { method: string, ok: boolean, summary: string, source?: string }) => Promise<void>,
 *   broadcastUi: (message: Record<string, unknown>) => void,
 *   clearSetupStatus: (errorMessage?: string | null) => void,
 *   emitUiState: () => Promise<void>,
 *   handleBridgeRequest: (request: BridgeRequest) => Promise<void>,
 *   handleHostStatusMessage: (message: unknown) => boolean,
 *   refreshActionIndicators: () => Promise<void>,
 *   refreshSetupStatus: (force?: boolean) => void,
 *   reply: (response: BridgeResponse) => void,
 * }} NativeConnectionDeps
 */

/**
 * @typedef {{
 *   appendActionLogEntry: (entry: { method: string, ok: boolean, summary: string, source?: string }) => Promise<void>,
 *   emitUiState: () => Promise<void>,
 *   getSetupActionMethodLabel: (action: SetupInstallAction) => string,
 *   getSetupActionSuccessSummary: (action: SetupInstallAction) => string,
 *   getSetupActionErrorSummary: (action: SetupInstallAction, message: string) => string,
 *   refreshSetupStatus: (force?: boolean) => void,
 * }} HostStatusDeps
 */

/**
 * @param {unknown} value
 * @returns {value is SetupStatus}
 */
export function isSetupStatus(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = /** @type {Record<string, unknown>} */ (value);
  return Array.isArray(candidate.mcpClients) && Array.isArray(candidate.skillTargets);
}

/**
 * @param {ExtensionState} state
 * @param {string | null} [errorMessage=null]
 * @returns {void}
 */
export function clearSetupStatus(state, errorMessage = null) {
  clearSetupStatusTimer(state);
  state.nativeHostVersion = null;
  state.nativeHostVersionRequestId = null;
  state.daemonProxy = null;
  state.setupStatus = null;
  state.setupStatusPending = false;
  state.setupStatusPendingRequestId = null;
  state.setupStatusUpdatedAt = 0;
  state.setupStatusError = errorMessage;
  state.setupInstallPendingRequestId = null;
  state.setupInstallPendingAction = null;
  state.setupInstallPendingKey = null;
  state.setupInstallError = null;
}

/**
 * @param {ExtensionState} state
 * @returns {void}
 */
export function clearSetupStatusTimer(state) {
  if (!state.setupStatusTimeoutId) {
    return;
  }
  clearTimeout(state.setupStatusTimeoutId);
  state.setupStatusTimeoutId = null;
}

/**
 * @param {{ storage: { session: { get: (key: string) => Promise<Record<string, unknown>>, set: (items: Record<string, unknown>) => Promise<void> } } }} chromeObj
 * @returns {Promise<string>}
 */
export async function getProfileLabel(chromeObj) {
  const STORAGE_KEY = 'bb_profile_label';
  try {
    const result = await chromeObj.storage.session.get(STORAGE_KEY);
    if (result[STORAGE_KEY]) {
      return /** @type {string} */ (result[STORAGE_KEY]);
    }
    const label = `profile_${Math.random().toString(36).slice(2, 8)}`;
    await chromeObj.storage.session.set({ [STORAGE_KEY]: label });
    return label;
  } catch (e) {
    reportAsyncError(e);
    return `profile_${Date.now().toString(36)}`;
  }
}

/**
 * Send browser/profile identity to the daemon via the native host.
 *
 * @param {chrome.runtime.Port} port
 * @param {{ storage: { session: { get: (key: string) => Promise<Record<string, unknown>>, set: (items: Record<string, unknown>) => Promise<void> } } }} chromeObj
 * @returns {void}
 */
export function sendIdentity(port, chromeObj) {
  const browserName = detectBrowserName();
  void getProfileLabel(chromeObj).then((profileLabel) => {
    try {
      port.postMessage({ type: 'host.identity', browserName, profileLabel });
    } catch {
      /* port may have disconnected */
    }
  });
}

/**
 * Notify the daemon that this browser/profile was recently active so untargeted
 * access prompts can be routed to one browser instead of broadcasting.
 *
 * @param {chrome.runtime.Port | null} [port]
 * @returns {void}
 */
export function sendActivityUpdate(port) {
  if (!port) return;
  try {
    port.postMessage({ type: 'host.activity', at: Date.now() });
  } catch {
    /* port may have disconnected */
  }
}

/**
 * Notify the daemon whether this extension currently has access enabled.
 *
 * @param {boolean} enabled
 * @param {chrome.runtime.Port | null} nativePort
 * @returns {void}
 */
export function sendAccessUpdate(enabled, nativePort) {
  if (!nativePort) return;
  try {
    nativePort.postMessage({
      type: 'host.access_update',
      accessEnabled: enabled,
    });
  } catch {
    /* port may have disconnected */
  }
}

/**
 * @param {chrome.runtime.Port} port
 * @param {ExtensionState} state
 * @returns {void}
 */
function requestNativeHostVersion(port, state) {
  const requestId = crypto.randomUUID();
  state.nativeHostVersionRequestId = requestId;
  try {
    port.postMessage({
      type: 'host.bridge_request',
      request: createRequest({
        id: requestId,
        method: 'health.ping',
      }),
    });
  } catch {
    state.nativeHostVersionRequestId = null;
  }
}

/**
 * @param {unknown} result
 * @returns {string | null}
 */
function getNativeHostVersion(result) {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const candidate = /** @type {Record<string, unknown>} */ (result);
  return typeof candidate.daemonVersion === 'string' ? candidate.daemonVersion : null;
}

/**
 * Parse the daemon's structured remote-proxy status from a health.ping result.
 *
 * @param {unknown} result
 * @returns {import('./background-state.js').DaemonProxyStatus | null}
 */
function getDaemonProxyStatus(result) {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const proxy = /** @type {Record<string, unknown>} */ (result).proxy;
  if (!proxy || typeof proxy !== 'object') {
    return null;
  }
  const candidate = /** @type {Record<string, unknown>} */ (proxy);
  if (typeof candidate.enabled !== 'boolean') {
    return null;
  }
  return {
    enabled: candidate.enabled,
    endpoint: typeof candidate.endpoint === 'string' ? candidate.endpoint : null,
  };
}

/**
 * @param {ExtensionState} state
 * @param {{ runtime: { connectNative: (application: string) => chrome.runtime.Port, lastError?: { message?: string } }, storage: { session: { get: (key: string) => Promise<Record<string, unknown>>, set: (items: Record<string, unknown>) => Promise<void> } } }} chromeObj
 * @param {NativeConnectionDeps} deps
 * @returns {{
 *   clearNativeReconnectTimer: () => void,
 *   connectNative: () => void,
 *   scheduleNativeReconnect: (errorMessage: string, options?: { method?: string, summaryPrefix?: string, updateDisconnectedUi?: boolean }) => void,
 * }}
 */
export function createNativeConnectionController(state, chromeObj, deps) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let nativeReconnectTimer = null;
  let nativeReconnectDelay = NATIVE_RECONNECT_BASE_MS;

  /**
   * @returns {void}
   */
  function clearNativeReconnectTimer() {
    if (!nativeReconnectTimer) {
      return;
    }
    clearTimeout(nativeReconnectTimer);
    nativeReconnectTimer = null;
  }

  /**
   * @param {string} errorMessage
   * @param {{
   *   method?: string,
   *   summaryPrefix?: string,
   *   updateDisconnectedUi?: boolean,
   * }} [options]
   * @returns {void}
   */
  function scheduleNativeReconnect(errorMessage, options = {}) {
    const method = typeof options.method === 'string' ? options.method : 'native.disconnect';
    const summaryPrefix =
      typeof options.summaryPrefix === 'string'
        ? options.summaryPrefix
        : 'Native host disconnected';
    const updateDisconnectedUi = options.updateDisconnectedUi === true;

    state.nativeReconnectAttempts += 1;
    const reconnectAttempt = state.nativeReconnectAttempts;
    deps.clearSetupStatus(errorMessage);
    state.nativeHostVersion = null;
    state.nativeHostVersionRequestId = null;

    if (updateDisconnectedUi) {
      state.nativePort = null;
      deps.broadcastUi({
        type: 'native.status',
        connected: false,
        error: errorMessage,
      });
    }
    void deps.emitUiState().catch(reportAsyncError);

    void deps.appendActionLogEntry({
      method,
      source: 'extension',
      ok: false,
      summary: `${summaryPrefix} (attempt ${reconnectAttempt}): ${errorMessage}. Reconnecting in ${nativeReconnectDelay}ms.`,
    });

    const scheduledReconnect = scheduleReconnectAttempt({
      currentTimer: nativeReconnectTimer,
      currentDelay: nativeReconnectDelay,
      maxDelay: NATIVE_RECONNECT_MAX_MS,
      onReconnect: () => {
        nativeReconnectTimer = null;
        connectNative();
      },
      clearTimeoutFn: clearTimeout,
      setTimeoutFn: setTimeout,
    });
    nativeReconnectTimer = scheduledReconnect.timer;
    nativeReconnectDelay = scheduledReconnect.nextDelay;
  }

  /**
   * @returns {void}
   */
  function connectNative() {
    clearNativeReconnectTimer();
    try {
      const candidatePort = chromeObj.runtime.connectNative(NATIVE_APP_NAME);
      const wasReconnect = nativeReconnectDelay > NATIVE_RECONNECT_BASE_MS;
      const reconnectAttempts = state.nativeReconnectAttempts;
      const stabilityTimer = setTimeout(() => {
        state.nativePort = candidatePort;
        nativeReconnectDelay = NATIVE_RECONNECT_BASE_MS;
        state.nativeReconnectAttempts = 0;
        deps.broadcastUi({ type: 'native.status', connected: true });
        deps.refreshSetupStatus(true);
        requestNativeHostVersion(candidatePort, state);
        void deps.refreshActionIndicators();
        void deps.emitUiState();
        sendIdentity(candidatePort, chromeObj);
        sendActivityUpdate(candidatePort);
        if (state.enabledWindow) {
          sendAccessUpdate(true, candidatePort);
        }
        if (wasReconnect && reconnectAttempts > 0) {
          void deps.appendActionLogEntry({
            method: 'native.reconnect',
            source: 'extension',
            ok: true,
            summary: `Native host reconnected after ${reconnectAttempts} attempt${reconnectAttempts === 1 ? '' : 's'}.`,
          });
        }
      }, 500);
      candidatePort.onMessage.addListener(
        createNativePortMessageListener({
          handleHostStatusMessage: deps.handleHostStatusMessage,
          handleBridgeRequest: deps.handleBridgeRequest,
          reply: deps.reply,
          reportAsyncError,
        })
      );
      candidatePort.onDisconnect.addListener(() => {
        clearTimeout(stabilityTimer);
        const disconnectError = chromeObj.runtime.lastError?.message ?? 'Native host disconnected.';
        scheduleNativeReconnect(disconnectError, {
          method: 'native.disconnect',
          summaryPrefix: 'Native host disconnected',
          updateDisconnectedUi: state.nativePort === candidatePort,
        });
      });
    } catch (error) {
      scheduleNativeReconnect(getErrorMessage(error), {
        method: 'native.connect',
        summaryPrefix: 'Native host connection failed',
        updateDisconnectedUi: !state.nativePort,
      });
    }
  }

  return {
    clearNativeReconnectTimer,
    connectNative,
    scheduleNativeReconnect,
  };
}

/**
 * @param {unknown} message
 * @param {ExtensionState} state
 * @param {HostStatusDeps} deps
 * @returns {boolean}
 */
export function handleHostStatusMessage(message, state, deps) {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = /** @type {Record<string, unknown>} */ (message);
  if (candidate.type === 'host.bridge_response') {
    const response =
      candidate.response && typeof candidate.response === 'object'
        ? /** @type {BridgeResponse} */ (candidate.response)
        : null;
    if (response?.id === state.nativeHostVersionRequestId) {
      state.nativeHostVersionRequestId = null;
      const nextVersion = response.ok ? getNativeHostVersion(response.result) : null;
      const nextProxy = response.ok ? getDaemonProxyStatus(response.result) : null;
      const proxyChanged =
        state.daemonProxy?.enabled !== nextProxy?.enabled ||
        state.daemonProxy?.endpoint !== nextProxy?.endpoint;
      if (state.nativeHostVersion !== nextVersion || proxyChanged) {
        state.nativeHostVersion = nextVersion;
        state.daemonProxy = nextProxy;
        void deps.emitUiState().catch(reportAsyncError);
      }
      return true;
    }
    if (response?.id === state.setupInstallPendingRequestId) {
      const action = state.setupInstallPendingAction;
      state.setupInstallPendingRequestId = null;
      state.setupInstallPendingAction = null;
      if (response.ok) {
        state.setupInstallError = null;
        if (action) {
          void deps
            .appendActionLogEntry({
              method: deps.getSetupActionMethodLabel(action),
              ok: true,
              summary: deps.getSetupActionSuccessSummary(action),
            })
            .catch(reportAsyncError);
        }
        deps.refreshSetupStatus(true);
      } else {
        state.setupInstallError = response.error.message;
        if (action) {
          void deps
            .appendActionLogEntry({
              method: deps.getSetupActionMethodLabel(action),
              ok: false,
              summary: deps.getSetupActionErrorSummary(action, response.error.message),
            })
            .catch(reportAsyncError);
        }
        state.setupInstallPendingKey = null;
      }
      void deps.emitUiState().catch(reportAsyncError);
      return true;
    }
    if (response?.id === state.setupStatusPendingRequestId) {
      clearSetupStatusTimer(state);
      state.setupStatusPending = false;
      state.setupStatusPendingRequestId = null;
      state.setupInstallPendingKey = null;
      if (response.ok) {
        state.setupStatus = isSetupStatus(response.result) ? response.result : null;
        state.setupStatusUpdatedAt = Date.now();
        state.setupStatusError = null;
      } else {
        state.setupStatusError = response.error.message;
      }
      void deps.emitUiState().catch(reportAsyncError);
    }
    return true;
  }

  if (candidate.type === 'host.bridge_error') {
    if (candidate.requestId === state.setupInstallPendingRequestId) {
      const action = state.setupInstallPendingAction;
      state.setupInstallPendingRequestId = null;
      state.setupInstallPendingAction = null;
      state.setupInstallPendingKey = null;
      state.setupInstallError =
        typeof candidate.error === 'object' &&
        candidate.error &&
        typeof (/** @type {Record<string, unknown>} */ (candidate.error).message) === 'string'
          ? /** @type {Record<string, string>} */ (candidate.error).message
          : 'Could not install host setup.';
      if (action) {
        void deps
          .appendActionLogEntry({
            method: deps.getSetupActionMethodLabel(action),
            ok: false,
            summary: deps.getSetupActionErrorSummary(action, state.setupInstallError),
          })
          .catch(reportAsyncError);
      }
      void deps.emitUiState().catch(reportAsyncError);
      return true;
    }
    if (candidate.requestId === state.setupStatusPendingRequestId) {
      clearSetupStatusTimer(state);
      state.setupStatusPending = false;
      state.setupStatusPendingRequestId = null;
      state.setupInstallPendingAction = null;
      state.setupInstallPendingKey = null;
      state.setupStatusError =
        typeof candidate.error === 'object' &&
        candidate.error &&
        typeof (/** @type {Record<string, unknown>} */ (candidate.error).message) === 'string'
          ? /** @type {Record<string, string>} */ (candidate.error).message
          : 'Could not inspect host setup.';
      void deps.emitUiState().catch(reportAsyncError);
    }
    return true;
  }

  if (candidate.type === 'host.setup_status.response') {
    if (candidate.requestId === state.setupStatusPendingRequestId) {
      clearSetupStatusTimer(state);
      state.setupStatus = isSetupStatus(candidate.status) ? candidate.status : null;
      state.setupStatusPending = false;
      state.setupStatusPendingRequestId = null;
      state.setupInstallPendingAction = null;
      state.setupInstallPendingKey = null;
      state.setupStatusUpdatedAt = Date.now();
      state.setupStatusError = null;
      void deps.emitUiState().catch(reportAsyncError);
    }
    return true;
  }

  if (candidate.type === 'host.setup_status.error') {
    if (candidate.requestId === state.setupStatusPendingRequestId) {
      clearSetupStatusTimer(state);
      state.setupStatusPending = false;
      state.setupStatusPendingRequestId = null;
      state.setupInstallPendingAction = null;
      state.setupInstallPendingKey = null;
      state.setupStatusError =
        typeof candidate.error === 'object' &&
        candidate.error &&
        typeof (/** @type {Record<string, unknown>} */ (candidate.error).message) === 'string'
          ? /** @type {Record<string, string>} */ (candidate.error).message
          : 'Could not inspect host setup.';
      void deps.emitUiState().catch(reportAsyncError);
    }
    return true;
  }

  return false;
}

/**
 * @param {ExtensionState} state
 * @param {{
 *   emitUiState: () => Promise<void>,
 * }} deps
 * @param {boolean} [force=false]
 * @returns {void}
 */
export function refreshSetupStatus(state, deps, force = false) {
  if (!state.nativePort) {
    clearSetupStatus(state);
    return;
  }

  const isFresh =
    state.setupStatusUpdatedAt > 0 &&
    Date.now() - state.setupStatusUpdatedAt < SETUP_STATUS_STALE_MS;
  if (state.setupStatusPending || (!force && isFresh && !state.setupStatusError)) {
    return;
  }

  const requestId = crypto.randomUUID();
  state.setupStatusPending = true;
  state.setupStatusPendingRequestId = requestId;
  state.setupStatusError = null;
  clearSetupStatusTimer(state);
  state.nativePort.postMessage({
    type: 'host.bridge_request',
    request: createRequest({
      id: requestId,
      method: 'setup.get_status',
    }),
  });
  state.setupStatusTimeoutId = setTimeout(() => {
    if (state.setupStatusPendingRequestId !== requestId) {
      return;
    }
    state.setupStatusPending = false;
    state.setupStatusPendingRequestId = null;
    state.setupInstallPendingAction = null;
    state.setupInstallPendingKey = null;
    state.setupStatusError = 'Host setup request timed out.';
    state.setupStatusTimeoutId = null;
    void deps.emitUiState().catch(reportAsyncError);
  }, SETUP_STATUS_TIMEOUT_MS);
}

/**
 * @param {Record<string, unknown>} message
 * @param {ExtensionState} state
 * @param {NativeDeps} deps
 * @returns {Promise<void>}
 */
export async function handleSetupInstallAction(message, state, deps) {
  if (!state.nativePort) {
    state.setupInstallError = 'Native host is not connected.';
    await deps.appendActionLogEntry({
      method: 'Host setup',
      ok: false,
      summary: 'Install failed: Native host is not connected.',
    });
    await deps.emitUiState();
    return;
  }
  if (state.setupInstallPendingRequestId) {
    return;
  }
  const action = normalizeSetupInstallAction(message);
  const requestId = crypto.randomUUID();
  state.setupInstallPendingRequestId = requestId;
  state.setupInstallPendingAction = action;
  state.setupInstallPendingKey = getSetupInstallKey(action);
  state.setupInstallError = null;
  await deps.appendActionLogEntry({
    method: getSetupActionMethodLabel(action),
    ok: true,
    summary: getSetupActionStartSummary(action),
  });
  state.nativePort.postMessage({
    type: 'host.bridge_request',
    request: createRequest({
      id: requestId,
      method: 'setup.install',
      params: action,
    }),
  });
  await deps.emitUiState();
}

/**
 * @param {Record<string, unknown>} message
 * @returns {SetupInstallAction}
 */
export function normalizeSetupInstallAction(message) {
  const action = message.action === 'uninstall' ? 'uninstall' : 'install';
  const kind = message.kind === 'skill' ? 'skill' : message.kind === 'mcp' ? 'mcp' : null;
  const target = typeof message.target === 'string' ? message.target.trim().toLowerCase() : '';
  if (!kind || !target) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'Missing kind or target in setup install action'
    );
  }
  return { action, kind, target };
}

/**
 * @param {SetupInstallAction} action
 * @returns {string}
 */
export function getSetupInstallKey(action) {
  return `${action.kind}:${action.target}`;
}

/**
 * @param {SetupInstallAction} action
 * @returns {string}
 */
export function getSetupActionMethodLabel(action) {
  return action.kind === 'mcp' ? 'Host setup: MCP' : 'Host setup: Skills';
}

/**
 * @param {SetupInstallAction} action
 * @returns {string}
 */
export function getSetupActionTargetLabel(action) {
  return action.target;
}

/**
 * @param {SetupInstallAction} action
 * @returns {string}
 */
export function getSetupActionStartSummary(action) {
  const verb = action.action === 'uninstall' ? 'Removing' : 'Installing';
  return `${verb} ${action.kind.toUpperCase()} for ${getSetupActionTargetLabel(action)}…`;
}

/**
 * @param {SetupInstallAction} action
 * @returns {string}
 */
export function getSetupActionSuccessSummary(action) {
  const verb = action.action === 'uninstall' ? 'Removed' : 'Installed';
  return `${verb} ${action.kind.toUpperCase()} for ${getSetupActionTargetLabel(action)}.`;
}

/**
 * @param {SetupInstallAction} action
 * @param {string} message
 * @returns {string}
 */
export function getSetupActionErrorSummary(action, message) {
  const verb = action.action === 'uninstall' ? 'Removal' : 'Install';
  return `${verb} failed for ${action.kind.toUpperCase()} on ${getSetupActionTargetLabel(action)}: ${message}`;
}
