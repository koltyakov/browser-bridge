import { BridgeError, ERROR_CODES, createRequest } from '../../../protocol/src/index.js';
import { createNativePortMessageListener } from './background-bridge.js';
import { detectBrowserName } from './background-browser.js';
import { getErrorMessage } from './background-helpers.js';
import {
  isNativeConnectionUnstable,
  recordNativeDisconnect,
  scheduleReconnectAttempt,
} from './background-reconnect.js';
import {
  NATIVE_APP_NAME,
  NATIVE_FLAP_THRESHOLD,
  NATIVE_FLAP_WINDOW_MS,
  NATIVE_RECONNECT_BASE_MS,
  NATIVE_RECONNECT_MAX_MS,
  reportAsyncError,
  SETUP_STATUS_STALE_MS,
  SETUP_STATUS_TIMEOUT_MS,
} from './background-state.js';

export type SetupInstallAction = import('./background-state.js').SetupInstallAction;
export type ExtensionState = import('./background-state.js').ExtensionState;
export type BridgeRequest = import('../../../protocol/src/types.js').BridgeRequest;
export type BridgeResponse = import('../../../protocol/src/types.js').BridgeResponse;
export type SetupStatus = import('../../../protocol/src/types.js').SetupStatus;
export type ProfileStorage = {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
};

const pendingProfileLabels: WeakMap<object, Promise<string>> = new WeakMap();

export type NativeDeps = {
  appendActionLogEntry: (entry: {
    method: string;
    ok: boolean;
    summary: string;
    source?: string;
  }) => Promise<void>;
  emitUiState: () => Promise<void>;
};

export type NativeConnectionDeps = {
  appendActionLogEntry: (entry: {
    method: string;
    ok: boolean;
    summary: string;
    source?: string;
  }) => Promise<void>;
  broadcastUi: (message: Record<string, unknown>) => void;
  clearSetupStatus: (errorMessage?: string | null) => void;
  emitUiState: () => Promise<void>;
  handleBridgeRequest: (request: BridgeRequest) => Promise<void>;
  handleHostStatusMessage: (message: unknown) => boolean;
  refreshActionIndicators: () => Promise<void>;
  refreshSetupStatus: (force?: boolean) => void;
  reply: (response: BridgeResponse) => void;
  handleDestinationDisconnect?: () => void;
  recordReconnect?: (outcome: 'success' | 'failure') => void;
  checkDevelopmentUpdate?: () => Promise<void>;
};

export type HostStatusDeps = {
  appendActionLogEntry: (entry: {
    method: string;
    ok: boolean;
    summary: string;
    source?: string;
  }) => Promise<void>;
  emitUiState: () => Promise<void>;
  getSetupActionMethodLabel: (action: SetupInstallAction) => string;
  getSetupActionSuccessSummary: (action: SetupInstallAction) => string;
  getSetupActionErrorSummary: (action: SetupInstallAction, message: string) => string;
  refreshSetupStatus: (force?: boolean) => void;
};

export function isSetupStatus(value: unknown): value is SetupStatus {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.mcpClients) && Array.isArray(candidate.skillTargets);
}

export function clearSetupStatus(state: ExtensionState, errorMessage: string | null = null): void {
  clearSetupStatusTimer(state);
  state.nativeHostVersion = null;
  state.nativeHostVersionRequestId = null;
  state.daemonProxy = null;
  state.otherEnabledWindows = [];
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

export function clearSetupStatusTimer(state: ExtensionState): void {
  if (!state.setupStatusTimeoutId) {
    return;
  }
  clearTimeout(state.setupStatusTimeoutId);
  state.setupStatusTimeoutId = null;
}

export function getProfileLabel(chromeObj: {
  storage: { local: ProfileStorage; session: ProfileStorage };
}): Promise<string> {
  const pending = pendingProfileLabels.get(chromeObj);
  if (pending) return pending;
  const result = loadProfileLabel(chromeObj).finally(() => pendingProfileLabels.delete(chromeObj));
  pendingProfileLabels.set(chromeObj, result);
  return result;
}

async function loadProfileLabel(chromeObj: {
  storage: { local: ProfileStorage; session: ProfileStorage };
}): Promise<string> {
  const STORAGE_KEY = 'bb_profile_label';

  const validLabel = (value: unknown): value is string =>
    typeof value === 'string' && /^profile_[a-zA-Z0-9_-]{6,64}$/.test(value);
  try {
    const result = await chromeObj.storage.local.get(STORAGE_KEY);
    if (validLabel(result[STORAGE_KEY])) {
      return result[STORAGE_KEY];
    }
    const session = (await chromeObj.storage.session.get(STORAGE_KEY).catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const label = validLabel(session[STORAGE_KEY])
      ? session[STORAGE_KEY]
      : `profile_${crypto.randomUUID()}`;
    await chromeObj.storage.local.set({ [STORAGE_KEY]: label });
    await chromeObj.storage.session.set({ [STORAGE_KEY]: label }).catch(reportAsyncError);
    return label;
  } catch (e) {
    reportAsyncError(e);
    const session = (await chromeObj.storage.session.get(STORAGE_KEY).catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (validLabel(session[STORAGE_KEY])) return session[STORAGE_KEY];
    const label = `profile_${crypto.randomUUID()}`;
    await chromeObj.storage.session.set({ [STORAGE_KEY]: label }).catch(reportAsyncError);
    return label;
  }
}

/** Send browser/profile identity to the daemon via the native host. */
export function sendIdentity(
  port: chrome.runtime.Port,
  chromeObj: {
    runtime?: { id?: string };
    storage: { local: ProfileStorage; session: ProfileStorage };
  }
): void {
  const browserName = detectBrowserName();
  void getProfileLabel(chromeObj).then((profileLabel) => {
    try {
      port.postMessage({
        type: 'host.identity',
        browserName,
        profileLabel,
        windowAccessUpdates: true,
        windowActions: true,
        browserExtensionId:
          typeof chromeObj.runtime?.id === 'string' ? chromeObj.runtime.id : undefined,
      });
    } catch {
      /* port may have disconnected */
    }
  });
}

/** Notify the daemon that this browser/profile was recently active so untargeted
access prompts can be routed to one browser instead of broadcasting. */
export function sendActivityUpdate(port?: chrome.runtime.Port | null): void {
  if (!port) return;
  try {
    port.postMessage({ type: 'host.activity', at: Date.now() });
  } catch {
    /* port may have disconnected */
  }
}

/** Notify the daemon whether this extension currently has access enabled. */
export function sendAccessUpdate(
  enabled: boolean,
  nativePort: chrome.runtime.Port | null,
  enabledWindow?: import('../../../protocol/src/window-access.js').EnabledWindowInfo | null
): void {
  if (!nativePort) return;
  try {
    nativePort.postMessage({
      type: 'host.access_update',
      accessEnabled: enabled,
      ...(enabledWindow !== undefined ? { enabledWindow: enabled ? enabledWindow : null } : {}),
    });
  } catch {
    /* port may have disconnected */
  }
}

function requestNativeHostVersion(port: chrome.runtime.Port, state: ExtensionState): void {
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

function getNativeHostVersion(result: unknown): string | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const candidate = result as Record<string, unknown>;
  return typeof candidate.daemonVersion === 'string' ? candidate.daemonVersion : null;
}

/** Parse the daemon's structured remote-proxy status from a health.ping result. */
function getDaemonProxyStatus(
  result: unknown
): import('./background-state.js').DaemonProxyStatus | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const proxy = (result as Record<string, unknown>).proxy;
  if (!proxy || typeof proxy !== 'object') {
    return null;
  }
  const candidate = proxy as Record<string, unknown>;
  if (typeof candidate.enabled !== 'boolean') {
    return null;
  }
  return {
    enabled: candidate.enabled,
    endpoint: typeof candidate.endpoint === 'string' ? candidate.endpoint : null,
  };
}

/** Extract a native-host bootstrap failure sent before the daemon socket is
available. New hosts send `host.bridge_response`; older hosts sent the raw
`agent.response`, so accept both while users upgrade CLI/npm separately from
the extension. */
function getNativeBootstrapErrorMessage(message: unknown): string | null {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const candidate = message as Record<string, unknown>;
  const responseContainer =
    candidate.type === 'host.bridge_response' || candidate.type === 'agent.response'
      ? candidate.response
      : null;
  if (!responseContainer || typeof responseContainer !== 'object') {
    return null;
  }

  const response = responseContainer as Record<string, unknown>;
  if (response.id !== 'native_bootstrap' || response.ok !== false) {
    return null;
  }
  const error = response.error;
  if (!error || typeof error !== 'object') {
    return 'Native host could not start the bridge daemon.';
  }
  const messageValue = (error as Record<string, unknown>).message;
  return typeof messageValue === 'string' && messageValue.trim()
    ? messageValue
    : 'Native host could not start the bridge daemon.';
}

export function createNativeConnectionController(
  state: ExtensionState,
  chromeObj: {
    runtime: {
      id?: string;
      connectNative: (application: string) => chrome.runtime.Port;
      lastError?: { message?: string };
    };
    storage: { local: ProfileStorage; session: ProfileStorage };
  },
  deps: NativeConnectionDeps
): {
  clearNativeReconnectTimer: () => void;
  connectNative: () => void;
  scheduleNativeReconnect: (
    errorMessage: string,
    options?: { method?: string; summaryPrefix?: string; updateDisconnectedUi?: boolean }
  ) => void;
} {
  let nativeReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  let nativeUnstableTimer: ReturnType<typeof setTimeout> | null = null;
  let nativeReconnectDelay = NATIVE_RECONNECT_BASE_MS;

  function clearNativeReconnectTimer(): void {
    if (!nativeReconnectTimer) {
      return;
    }
    clearTimeout(nativeReconnectTimer);
    nativeReconnectTimer = null;
  }

  function clearNativeUnstableTimer(): void {
    if (!nativeUnstableTimer) {
      return;
    }
    clearTimeout(nativeUnstableTimer);
    nativeUnstableTimer = null;
  }

  /** Schedule a future recheck for the exact point where the oldest disconnect
falls out of the flap window. Without this, a recovered connection would
keep the warning visible until another disconnect happened. */
  function scheduleNativeUnstableRecheck(now: number = Date.now()): void {
    clearNativeUnstableTimer();
    const recentDisconnects = state.nativeDisconnectTimes.filter(
      (at) => at <= now && now - at <= NATIVE_FLAP_WINDOW_MS
    );
    const oldest = recentDisconnects[0];
    if (oldest === undefined) {
      return;
    }
    const delay = Math.max(1, oldest + NATIVE_FLAP_WINDOW_MS - now + 1);
    nativeUnstableTimer = setTimeout(() => {
      nativeUnstableTimer = null;
      syncNativeUnstableState();
    }, delay);
  }

  /** Recompute whether the native connection is still flapping and notify the UI
when it has recovered without requiring another connect/disconnect event. */
  function syncNativeUnstableState(): void {
    const now = Date.now();
    state.nativeDisconnectTimes = state.nativeDisconnectTimes.filter(
      (at) => at <= now && now - at <= NATIVE_FLAP_WINDOW_MS
    );
    const stillUnstable = isNativeConnectionUnstable(
      state.nativeDisconnectTimes,
      now,
      NATIVE_FLAP_WINDOW_MS,
      NATIVE_FLAP_THRESHOLD
    );
    if (stillUnstable) {
      state.nativeUnstable = true;
      scheduleNativeUnstableRecheck(now);
      return;
    }

    clearNativeUnstableTimer();
    if (!state.nativeUnstable) {
      return;
    }
    state.nativeUnstable = false;
    nativeReconnectDelay = NATIVE_RECONNECT_BASE_MS;
    state.nativeReconnectAttempts = 0;
    deps.broadcastUi({
      type: 'native.status',
      connected: Boolean(state.nativePort),
      unstable: false,
    });
    void deps.emitUiState().catch(reportAsyncError);
  }

  function scheduleNativeReconnect(
    errorMessage: string,
    options: {
      method?: string;
      summaryPrefix?: string;
      updateDisconnectedUi?: boolean;
    } = {}
  ): void {
    const method = typeof options.method === 'string' ? options.method : 'native.disconnect';
    const summaryPrefix =
      typeof options.summaryPrefix === 'string'
        ? options.summaryPrefix
        : 'Native host disconnected';
    const updateDisconnectedUi = options.updateDisconnectedUi === true;

    state.nativeReconnectAttempts += 1;
    const reconnectAttempt = state.nativeReconnectAttempts;
    const now = Date.now();
    state.nativeDisconnectTimes = recordNativeDisconnect(
      state.nativeDisconnectTimes,
      now,
      NATIVE_FLAP_WINDOW_MS
    );
    state.nativeUnstable = isNativeConnectionUnstable(
      state.nativeDisconnectTimes,
      now,
      NATIVE_FLAP_WINDOW_MS,
      NATIVE_FLAP_THRESHOLD
    );
    if (state.nativeUnstable) {
      scheduleNativeUnstableRecheck(now);
    } else {
      clearNativeUnstableTimer();
    }
    deps.clearSetupStatus(errorMessage);
    state.nativeHostVersion = null;
    state.nativeHostVersionRequestId = null;

    if (updateDisconnectedUi) {
      state.nativePort = null;
      deps.broadcastUi({
        type: 'native.status',
        connected: false,
        unstable: state.nativeUnstable,
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

  function connectNative(): void {
    clearNativeReconnectTimer();
    void deps.checkDevelopmentUpdate?.().catch(reportAsyncError);
    const wasReconnect = nativeReconnectDelay > NATIVE_RECONNECT_BASE_MS;
    let reconnectOutcomePending = wasReconnect;

    const settleReconnect = (outcome: 'success' | 'failure') => {
      if (!reconnectOutcomePending) return;
      reconnectOutcomePending = false;
      deps.recordReconnect?.(outcome);
    };
    try {
      const candidatePort = chromeObj.runtime.connectNative(NATIVE_APP_NAME);
      // Track the connecting port immediately so replies to bridge requests
      // that arrive before the stability window closes are not dropped.
      state.pendingNativePort = candidatePort;
      const reconnectAttempts = state.nativeReconnectAttempts;
      const stabilityTimer = setTimeout(() => {
        state.nativePort = candidatePort;
        if (state.pendingNativePort === candidatePort) {
          state.pendingNativePort = null;
        }
        // A connection that survives the stability window can still be part of
        // a crash loop (daemon dying seconds after startup). Keep the grown
        // backoff while the recent disconnect history says we are flapping so
        // the UI stops flickering and reconnect churn slows down.
        state.nativeUnstable = isNativeConnectionUnstable(
          state.nativeDisconnectTimes,
          Date.now(),
          NATIVE_FLAP_WINDOW_MS,
          NATIVE_FLAP_THRESHOLD
        );
        if (!state.nativeUnstable) {
          clearNativeUnstableTimer();
          nativeReconnectDelay = NATIVE_RECONNECT_BASE_MS;
          state.nativeReconnectAttempts = 0;
        } else {
          scheduleNativeUnstableRecheck();
        }
        deps.broadcastUi({
          type: 'native.status',
          connected: true,
          unstable: state.nativeUnstable,
        });
        deps.refreshSetupStatus(true);
        requestNativeHostVersion(candidatePort, state);
        void deps.refreshActionIndicators();
        void deps.emitUiState();
        sendIdentity(candidatePort, chromeObj);
        sendActivityUpdate(candidatePort);
        if (state.enabledWindow) {
          sendAccessUpdate(true, candidatePort, state.enabledWindow);
        }
        if (wasReconnect && reconnectAttempts > 0) {
          settleReconnect('success');
          void deps.appendActionLogEntry({
            method: 'native.reconnect',
            source: 'extension',
            ok: true,
            summary: `Native host reconnected after ${reconnectAttempts} attempt${reconnectAttempts === 1 ? '' : 's'}.`,
          });
        }
      }, 500);
      let bootstrapFailed = false;
      candidatePort.onMessage.addListener(
        createNativePortMessageListener({
          handleHostStatusMessage: (message) => {
            const bootstrapError = getNativeBootstrapErrorMessage(message);
            if (bootstrapError) {
              bootstrapFailed = true;
              settleReconnect('failure');
              clearTimeout(stabilityTimer);
              if (state.pendingNativePort === candidatePort) {
                state.pendingNativePort = null;
              }
              scheduleNativeReconnect(bootstrapError, {
                method: 'native.bootstrap',
                summaryPrefix: 'Native host startup failed',
                updateDisconnectedUi: state.nativePort === candidatePort || !state.nativePort,
              });
              return true;
            }
            return deps.handleHostStatusMessage(message);
          },
          handleBridgeRequest: deps.handleBridgeRequest,
          reply: deps.reply,
          reportAsyncError,
        })
      );
      candidatePort.onDisconnect.addListener(() => {
        clearTimeout(stabilityTimer);
        if (state.pendingNativePort === candidatePort) {
          state.pendingNativePort = null;
        }
        if (bootstrapFailed) {
          return;
        }
        settleReconnect('failure');
        if (state.nativePort === candidatePort) deps.handleDestinationDisconnect?.();
        const disconnectError = chromeObj.runtime.lastError?.message ?? 'Native host disconnected.';
        scheduleNativeReconnect(disconnectError, {
          method: 'native.disconnect',
          summaryPrefix: 'Native host disconnected',
          updateDisconnectedUi: state.nativePort === candidatePort,
        });
      });
    } catch (error) {
      settleReconnect('failure');
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

export function handleHostStatusMessage(
  message: unknown,
  state: ExtensionState,
  deps: HostStatusDeps
): boolean {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  if (candidate.type === 'host.window_access') {
    state.otherEnabledWindows = Array.isArray(candidate.otherEnabledWindows)
      ? candidate.otherEnabledWindows.filter(isBrowserWindowAccess)
      : [];
    void deps.emitUiState().catch(reportAsyncError);
    return true;
  }
  if (candidate.type === 'host.bridge_response') {
    const response =
      candidate.response && typeof candidate.response === 'object'
        ? (candidate.response as BridgeResponse)
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
        typeof (candidate.error as Record<string, unknown>).message === 'string'
          ? (candidate.error as Record<string, string>).message
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
        typeof (candidate.error as Record<string, unknown>).message === 'string'
          ? (candidate.error as Record<string, string>).message
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
        typeof (candidate.error as Record<string, unknown>).message === 'string'
          ? (candidate.error as Record<string, string>).message
          : 'Could not inspect host setup.';
      void deps.emitUiState().catch(reportAsyncError);
    }
    return true;
  }

  return false;
}

function isBrowserWindowAccess(
  value: unknown
): value is import('../../../protocol/src/window-access.js').BrowserWindowAccess {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.extensionId !== 'string' ||
    !(entry.browserName === null || typeof entry.browserName === 'string') ||
    !(entry.profileLabel === null || typeof entry.profileLabel === 'string') ||
    !(entry.canControl === undefined || typeof entry.canControl === 'boolean')
  )
    return false;
  if (entry.window === null) return true;
  if (!entry.window || typeof entry.window !== 'object') return false;
  const window = entry.window as Record<string, unknown>;
  return (
    typeof window.windowId === 'number' &&
    Number.isInteger(window.windowId) &&
    window.windowId > 0 &&
    typeof window.title === 'string' &&
    typeof window.enabledAt === 'number' &&
    Number.isFinite(window.enabledAt)
  );
}

export function refreshSetupStatus(
  state: ExtensionState,
  deps: {
    emitUiState: () => Promise<void>;
  },
  force: boolean = false
): void {
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

export async function handleSetupInstallAction(
  message: Record<string, unknown>,
  state: ExtensionState,
  deps: NativeDeps
): Promise<void> {
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

export function normalizeSetupInstallAction(message: Record<string, unknown>): SetupInstallAction {
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

export function getSetupInstallKey(action: SetupInstallAction): string {
  return `${action.kind}:${action.target}`;
}

export function getSetupActionMethodLabel(action: SetupInstallAction): string {
  return action.kind === 'mcp' ? 'Host setup: MCP' : 'Host setup: Skills';
}

export function getSetupActionTargetLabel(action: SetupInstallAction): string {
  return action.target;
}

export function getSetupActionStartSummary(action: SetupInstallAction): string {
  const verb = action.action === 'uninstall' ? 'Removing' : 'Installing';
  return `${verb} ${action.kind.toUpperCase()} for ${getSetupActionTargetLabel(action)}…`;
}

export function getSetupActionSuccessSummary(action: SetupInstallAction): string {
  const verb = action.action === 'uninstall' ? 'Removed' : 'Installed';
  return `${verb} ${action.kind.toUpperCase()} for ${getSetupActionTargetLabel(action)}.`;
}

export function getSetupActionErrorSummary(action: SetupInstallAction, message: string): string {
  const verb = action.action === 'uninstall' ? 'Removal' : 'Install';
  return `${verb} failed for ${action.kind.toUpperCase()} on ${getSetupActionTargetLabel(action)}: ${message}`;
}
