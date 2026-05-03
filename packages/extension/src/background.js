// @ts-check

import {
  bridgeMethodNeedsTab,
  ERROR_CODES,
  createFailure,
  createRequest,
  createRuntimeContext,
  createSuccess,
  estimateJsonPayloadCost,
  normalizeAccessibilityTreeParams,
  normalizeCheckedAction,
  normalizeConsoleParams,
  normalizeDomQuery,
  normalizeDragParams,
  normalizeFindByRoleParams,
  normalizeFindByTextParams,
  normalizeGetHtmlParams,
  normalizeHoverParams,
  normalizeInputAction,
  normalizeNetworkParams,
  normalizePageTextParams,
  normalizePatchOperation,
  normalizeSelectAction,
  normalizeStorageParams,
  normalizeStyleQuery,
  normalizeTabCloseParams,
  normalizeViewportAction,
  normalizeViewportResizeParams,
  normalizeWaitForLoadStateParams,
  normalizeWaitForParams,
  serializeJsonPayload,
} from '../../protocol/src/index.js';
import { summarizeBridgeResponse } from '../../protocol/src/index.js';
import {
  enforceTokenBudget,
  createCdpKeyPressEventPair,
  getResponseDiagnostics,
  getErrorMessage,
  matchesConsoleLevel,
  normalizeRuntimeErrorMessage,
  shouldLogAction,
  simplifyAXNode,
  summarizeActionResult,
  summarizeTabResult,
} from './background-helpers.js';
import {
  isRestrictedAutomationUrl,
  normalizeRequestedAccessTab,
  resolveWindowScopedTab,
  selectRequestTabCandidate,
} from './background-routing.js';
import { getAccessStatus, restoreEnabledWindowState } from './background-access.js';
import { createNativePortMessageListener } from './background-bridge.js';
import { scheduleReconnectAttempt } from './background-reconnect.js';
import { detectBrowserName } from './background-browser.js';
import { createRuntimeMessageListener } from './background-runtime.js';
import { getVersionNegotiationPayload } from './background-versioning.js';
import { handleNavigationRequest as executeNavigationRequest } from './background-navigation.js';
import { handlePageEvaluate as executePageEvaluate } from './background-evaluate.js';
import {
  handleCreateTab as executeCreateTab,
  handleListTabs as executeListTabs,
} from './background-tabs.js';
import { TabDebuggerCoordinator } from './debugger-coordinator.js';

/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */
/** @typedef {import('../../protocol/src/types.js').ErrorCode} ErrorCode */
/** @typedef {import('../../protocol/src/types.js').SetupStatus} SetupStatus */

/** @type {typeof globalThis.chrome} */
const chrome = globalThis.chrome;

/**
 * @typedef {{
 *   windowId: number,
 *   title: string,
 *   enabledAt: number
 * }} EnabledWindowState
 */

/**
 * @typedef {{
 *   tabId: number,
 *   windowId: number,
 *   title: string,
 *   url: string
 * }} ResolvedTabTarget
 */

/**
 * @typedef {{
 *   id: string,
 *   at: number,
 *   method: string,
 *   source: string,
 *   tabId: number | null,
 *   url: string,
 *   ok: boolean,
 *   summary: string,
 *   responseBytes: number,
 *   approxTokens: number,
 *   imageApproxTokens: number,
 *   costClass: 'cheap' | 'moderate' | 'heavy' | 'extreme',
 *   imageBytes: number,
 *   summaryBytes: number,
 *   summaryTokens: number,
 *   summaryCostClass: 'cheap' | 'moderate' | 'heavy' | 'extreme',
 *   debuggerBacked: boolean,
 *   overBudget: boolean,
 *   hasScreenshot: boolean,
 *   nodeCount: number | null,
 *   continuationHint: string | null
 * }} ActionLogEntry
 */

/**
 * @typedef {{
 *   tabId: number,
 *   windowId: number,
 *   title: string,
 *   url: string,
 *   enabled: boolean,
 *   accessRequested: boolean,
 *   restricted: boolean
 * }} CurrentTabState
 */

/**
 * @typedef {{
 *   status?: string,
 *   title?: string,
 *   url?: string
 * }} TabChangeInfo
 */

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @typedef {{
 *   scopeTabId: number | null,
 *   surface: 'popup' | 'sidepanel'
 * }} UiPortState
 */

/**
 * @typedef {{
 *   action?: 'install' | 'uninstall',
 *   kind: 'mcp' | 'skill',
 *   target: string
 * }} SetupInstallAction
 */

/**
 * @typedef {{
 *   nativePort: chrome.runtime.Port | null,
 *   enabledWindow: EnabledWindowState | null,
 *   requestedAccessWindowId: number | null,
 *   requestedAccessPopupWindowId: number | null,
 *   nativeReconnectAttempts: number,
 *   actionLog: ActionLogEntry[],
 *   uiPorts: Map<chrome.runtime.Port, UiPortState>,
 *   setupStatus: SetupStatus | null,
 *   setupStatusPending: boolean,
 *   setupStatusPendingRequestId: string | null,
 *   setupStatusUpdatedAt: number,
 *   setupStatusError: string | null,
 *   setupStatusTimeoutId: ReturnType<typeof setTimeout> | null,
 *   setupInstallPendingRequestId: string | null,
 *   setupInstallPendingAction: SetupInstallAction | null,
 *   setupInstallPendingKey: string | null,
 *   setupInstallError: string | null
 * }} ExtensionState
 */

/**
 * @returns {Promise<string>}
 */
async function getProfileLabel() {
  const STORAGE_KEY = 'bb_profile_label';
  try {
    const result = await chrome.storage.session.get(STORAGE_KEY);
    if (result[STORAGE_KEY]) {
      return /** @type {string} */ (result[STORAGE_KEY]);
    }
    const label = `profile_${Math.random().toString(36).slice(2, 8)}`;
    await chrome.storage.session.set({ [STORAGE_KEY]: label });
    return label;
  } catch {
    return `profile_${Date.now().toString(36)}`;
  }
}

/**
 * Send browser/profile identity to the daemon via the native host.
 *
 * @param {chrome.runtime.Port} port
 * @returns {void}
 */
function sendIdentity(port) {
  const browserName = detectBrowserName();
  void getProfileLabel().then((profileLabel) => {
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
 * @param {chrome.runtime.Port | null} [port=state.nativePort]
 * @returns {void}
 */
function sendActivityUpdate(port = state.nativePort) {
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
 * @returns {void}
 */
function sendAccessUpdate(enabled) {
  if (!state.nativePort) return;
  try {
    state.nativePort.postMessage({
      type: 'host.access_update',
      accessEnabled: enabled,
    });
  } catch {
    /* port may have disconnected */
  }
}

const NATIVE_APP_NAME = 'com.browserbridge.browser_bridge';
const CONTENT_SCRIPT_TIMEOUT_MS = 5_000;
const MAX_ACTION_LOG_ENTRIES = 50;
const ENABLED_WINDOW_STORAGE_KEY = 'enabledWindow';
const ACTION_LOG_STORAGE_KEY = 'actionLog';
const SIDEPANEL_PATH = 'packages/extension/ui/sidepanel.html';
const POPUP_PATH = 'packages/extension/ui/popup.html';
const ENABLED_BADGE_TEXT = 'AI';
const ACCESS_REQUEST_BADGE_TEXT = '!';
const RESTRICTED_BADGE_TEXT = '!';
const DEBUGGER_PROTOCOL_VERSION = '1.3';
const SETUP_STATUS_STALE_MS = 30_000;
const SETUP_STATUS_TIMEOUT_MS = 5_000;
const ACCESS_DENIED_WINDOW_OFF = 'Browser Bridge is off for this window.';
const ACCESS_DENIED_TAB_CLOSE = 'tabs.close only works inside the enabled window.';
const KEEPALIVE_ALARM_NAME = 'bb-keepalive';
const NATIVE_RECONNECT_BASE_MS = 2_000;
const NATIVE_RECONNECT_MAX_MS = 30_000;

/** @type {ReturnType<typeof setTimeout> | null} */
let _nativeReconnectTimer = null;
let nativeReconnectDelay = NATIVE_RECONNECT_BASE_MS;

/** @type {ExtensionState} */
const state = {
  nativePort: null,
  enabledWindow: null,
  requestedAccessWindowId: null,
  requestedAccessPopupWindowId: null,
  nativeReconnectAttempts: 0,
  actionLog: [],
  uiPorts: new Map(),
  setupStatus: null,
  setupStatusPending: false,
  setupStatusPendingRequestId: null,
  setupStatusUpdatedAt: 0,
  setupStatusError: null,
  setupStatusTimeoutId: null,
  setupInstallPendingRequestId: null,
  setupInstallPendingAction: null,
  setupInstallPendingKey: null,
  setupInstallError: null,
};

const tabDebugger = new TabDebuggerCoordinator({
  attach: (target, protocolVersion) => chrome.debugger.attach(target, protocolVersion),
  detach: (target) => chrome.debugger.detach(target),
  protocolVersion: DEBUGGER_PROTOCOL_VERSION,
});

void initializeState().catch(reportAsyncError);
connectNative();

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  sendActivityUpdate();
  void updateActionIndicatorForTab(tabId).catch(reportAsyncError);
  void syncGlobalBadgeToActiveTab().catch(reportAsyncError);
  void emitUiState().catch(reportAsyncError);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (typeof windowId === 'number' && windowId >= 0) {
    sendActivityUpdate();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void handleTabUpdated(tabId, changeInfo, tab).catch(reportAsyncError);
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  void handleTabRemoved(tabId, removeInfo).catch(reportAsyncError);
});

chrome.windows.onRemoved.addListener((windowId) => {
  clearRequestedAccessPopupWindow(windowId);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM_NAME) {
    // No-op: the alarm firing is enough to wake the service worker.
    // Verify we still need to stay alive.
    if (!state.enabledWindow) {
      void chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
    }
  }
});

chrome.runtime.onConnect.addListener((port) => {
  const surface = getUiSurfaceFromPortName(port.name);
  if (surface) {
    state.uiPorts.set(port, { scopeTabId: null, surface });
    port.onMessage.addListener((message) => {
      void handleUiMessage(port, message).catch(reportAsyncError);
    });
    port.onDisconnect.addListener(() => {
      state.uiPorts.delete(port);
    });
    void emitUiStateForPort(port);
  }
});

chrome.runtime.onMessage.addListener(createRuntimeMessageListener({ openSidePanelForTab }));

/**
 * Restore persisted window access state when the service worker starts so the
 * current browser-run grant survives worker restarts.
 *
 * @returns {Promise<void>}
 */
async function initializeState() {
  await restoreEnabledWindow();
  await restoreActionLog();
  await primeEnabledWindowInstrumentation();
  await refreshActionIndicators();
}

/**
 * @returns {void}
 */
function clearNativeReconnectTimer() {
  if (!_nativeReconnectTimer) {
    return;
  }
  clearTimeout(_nativeReconnectTimer);
  _nativeReconnectTimer = null;
}

/**
 * Schedule the next native-host reconnect attempt using the shared backoff
 * path used after runtime disconnects.
 *
 * @param {string} errorMessage
 * @param {{
 *   method?: string,
 *   summaryPrefix?: string,
 *   updateDisconnectedUi?: boolean
 * }} [options]
 * @returns {void}
 */
function scheduleNativeReconnect(errorMessage, options = {}) {
  const method = typeof options.method === 'string' ? options.method : 'native.disconnect';
  const summaryPrefix =
    typeof options.summaryPrefix === 'string' ? options.summaryPrefix : 'Native host disconnected';
  const updateDisconnectedUi = options.updateDisconnectedUi === true;

  state.nativeReconnectAttempts += 1;
  const reconnectAttempt = state.nativeReconnectAttempts;
  clearSetupStatus(errorMessage);

  if (updateDisconnectedUi) {
    state.nativePort = null;
    broadcastUi({
      type: 'native.status',
      connected: false,
      error: errorMessage,
    });
  }
  void emitUiState().catch(reportAsyncError);

  void appendActionLogEntry({
    method,
    source: 'extension',
    ok: false,
    summary: `${summaryPrefix} (attempt ${reconnectAttempt}): ${errorMessage}. Reconnecting in ${nativeReconnectDelay}ms.`,
  });

  const scheduledReconnect = scheduleReconnectAttempt({
    currentTimer: _nativeReconnectTimer,
    currentDelay: nativeReconnectDelay,
    maxDelay: NATIVE_RECONNECT_MAX_MS,
    onReconnect: () => {
      _nativeReconnectTimer = null;
      connectNative();
    },
    clearTimeoutFn: clearTimeout,
    setTimeoutFn: setTimeout,
  });
  _nativeReconnectTimer = scheduledReconnect.timer;
  nativeReconnectDelay = scheduledReconnect.nextDelay;
}

/**
 * Connect the extension service worker to the local Native Messaging host and
 * fan connection state out to the popup and side panel UIs.
 *
 * @returns {void}
 */
function connectNative() {
  clearNativeReconnectTimer();
  try {
    const candidatePort = chrome.runtime.connectNative(NATIVE_APP_NAME);
    const wasReconnect = nativeReconnectDelay > NATIVE_RECONNECT_BASE_MS;
    const reconnectAttempts = state.nativeReconnectAttempts;
    const stabilityTimer = setTimeout(() => {
      state.nativePort = candidatePort;
      nativeReconnectDelay = NATIVE_RECONNECT_BASE_MS;
      state.nativeReconnectAttempts = 0;
      broadcastUi({ type: 'native.status', connected: true });
      refreshSetupStatus(true);
      void refreshActionIndicators();
      void emitUiState();
      sendIdentity(candidatePort);
      sendActivityUpdate(candidatePort);
      if (state.enabledWindow) {
        sendAccessUpdate(true);
      }
      if (wasReconnect && reconnectAttempts > 0) {
        void appendActionLogEntry({
          method: 'native.reconnect',
          source: 'extension',
          ok: true,
          summary: `Native host reconnected after ${reconnectAttempts} attempt${reconnectAttempts === 1 ? '' : 's'}.`,
        });
      }
    }, 500);
    candidatePort.onMessage.addListener(
      createNativePortMessageListener({
        handleHostStatusMessage,
        handleBridgeRequest,
        reply,
        reportAsyncError,
      })
    );
    candidatePort.onDisconnect.addListener(() => {
      clearTimeout(stabilityTimer);
      const disconnectError = chrome.runtime.lastError?.message ?? 'Native host disconnected.';
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

/**
 * Route a validated bridge request to the extension capability that should
 * satisfy it.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<void>}
 */
async function handleBridgeRequest(request) {
  const actionContext = shouldLogAction(request.method) ? await getActionContext(request) : null;
  /** @type {BridgeResponse} */
  let response;

  try {
    response = await dispatchBridgeRequest(request);
  } catch (error) {
    response = toFailureResponse(request, error);
  }

  if (
    !response.ok &&
    response.error.code === ERROR_CODES.ACCESS_DENIED &&
    response.error.message === ACCESS_DENIED_WINDOW_OFF
  ) {
    await requestEnableFromAgentSide(request);
  }

  response = enrichBridgeResponse(request, response);

  await logBridgeAction(request, response, actionContext);
  reply(response);
}

/**
 * Resolve one bridge request into a structured response.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function dispatchBridgeRequest(request) {
  switch (request.method) {
    case 'health.ping':
      return createSuccess(
        request.id,
        {
          extension: 'ok',
          access: await getAccessStatus({
            chrome,
            state,
            clearEnabledWindowIfGone,
            isRestrictedAutomationUrl,
          }),
          ...getVersionNegotiationPayload(request.meta?.protocol_version),
        },
        { method: request.method }
      );
    case 'access.request':
      return handleAccessRequest(request);
    case 'skill.get_runtime_context':
      return createSuccess(request.id, createRuntimeContext(), {
        method: request.method,
      });
    case 'tabs.list':
      return handleListTabs(request);
    case 'tabs.create':
      return handleCreateTab(request);
    case 'tabs.close':
      return handleCloseTab(request);
    case 'page.evaluate':
      return handlePageEvaluate(request);
    case 'page.get_console':
      return handlePageGetConsole(request);
    case 'page.wait_for_load_state':
      return handleWaitForLoadState(request);
    case 'dom.get_accessibility_tree':
      return handleAccessibilityTree(request);
    case 'page.get_network':
      return handleGetNetwork(request);
    case 'viewport.resize':
      return handleViewportResize(request);
    case 'performance.get_metrics':
      return handlePerformanceMetrics(request);
    case 'navigation.navigate':
    case 'navigation.reload':
    case 'navigation.go_back':
    case 'navigation.go_forward':
      return handleNavigationRequest(request);
    case 'page.get_state':
    case 'page.get_storage':
    case 'page.get_text':
    case 'dom.query':
    case 'dom.describe':
    case 'dom.get_text':
    case 'dom.get_attributes':
    case 'dom.wait_for':
    case 'dom.find_by_text':
    case 'dom.find_by_role':
    case 'dom.get_html':
    case 'layout.get_box_model':
    case 'layout.hit_test':
    case 'styles.get_computed':
    case 'styles.get_matched_rules':
    case 'viewport.scroll':
    case 'input.click':
    case 'input.focus':
    case 'input.type':
    case 'input.press_key':
    case 'input.set_checked':
    case 'input.select_option':
    case 'input.hover':
    case 'input.drag':
    case 'input.scroll_into_view':
    case 'patch.apply_styles':
    case 'patch.apply_dom':
    case 'patch.list':
    case 'patch.rollback':
    case 'patch.commit_session_baseline':
    case 'screenshot.capture_region':
    case 'screenshot.capture_element':
    case 'screenshot.capture_full_page':
      return handleTabBoundRequest(request);
    case 'cdp.get_document':
    case 'cdp.get_dom_snapshot':
    case 'cdp.get_box_model':
    case 'cdp.get_computed_styles_for_node':
    case 'cdp.dispatch_key_event':
      return handleCdpRequest(request);
    default:
      return createFailure(
        request.id,
        ERROR_CODES.INVALID_REQUEST,
        `Unhandled method ${request.method}`
      );
  }
}

/**
 * Restore the enabled window for the current browser run.
 *
 * @returns {Promise<void>}
 */
async function restoreEnabledWindow() {
  await restoreEnabledWindowState({
    chrome,
    state,
    storageKey: ENABLED_WINDOW_STORAGE_KEY,
    sendAccessUpdate,
  });
}

/**
 * Best-effort reinjection of passive instrumentation for tabs in the enabled
 * window so reads like `page.get_console` can see activity that happened
 * before the first explicit read.
 *
 * @returns {Promise<void>}
 */
async function primeEnabledWindowInstrumentation() {
  if (!state.enabledWindow) {
    return;
  }
  await injectContentScriptsForWindow(state.enabledWindow.windowId);
  await primeWindowConsoleCapture(state.enabledWindow.windowId);
}

/**
 * Restore the recent action log that powers the side panel activity view.
 *
 * @returns {Promise<void>}
 */
async function restoreActionLog() {
  const stored = await chrome.storage.session.get(ACTION_LOG_STORAGE_KEY);
  const entries = stored[ACTION_LOG_STORAGE_KEY];
  if (Array.isArray(entries)) {
    state.actionLog = entries
      .map((entry) => normalizeActionLogEntry(entry))
      .filter((entry) => entry !== null);
  }
}

/**
 * Clear the enabled window state if the window no longer exists.
 * Retries once after a short delay to ride over transient API errors.
 *
 * @returns {Promise<boolean>} true if the window was verified gone and cleared
 */
async function clearEnabledWindowIfGone() {
  if (!state.enabledWindow) {
    return false;
  }
  let gone = false;
  try {
    await chrome.windows.get(state.enabledWindow.windowId);
  } catch (e) {
    const msg = getErrorMessage(e).toLowerCase();
    if (msg.includes('no window') || msg.includes('not found') || msg.includes('window closed')) {
      gone = true;
    } else {
      await new Promise((r) => {
        setTimeout(r, 300);
      });
      try {
        await chrome.windows.get(state.enabledWindow.windowId);
      } catch (_e2) {
        gone = true;
      }
    }
  }
  if (gone) {
    state.enabledWindow = null;
    await chrome.storage.session.remove(ENABLED_WINDOW_STORAGE_KEY);
    sendAccessUpdate(false);
    return true;
  }
  return false;
}

/**
 * Summarize the currently open tabs in the enabled window so the client can
 * inspect or explicitly target them.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handleListTabs(request) {
  return executeListTabs(
    request,
    state,
    {
      queryTabs: (query) => chrome.tabs.query(query),
    },
    ACCESS_DENIED_WINDOW_OFF
  );
}

/**
 * Normalizers for tab-bound request params.  Each entry maps a bridge method
 * to a function that coerces and defaults the raw request params.
 *
 * @type {Record<string, ((params: Record<string, unknown>) => Record<string, unknown>) | undefined>}
 */
const TAB_BOUND_NORMALIZERS = {
  'dom.query': normalizeDomQuery,
  'dom.wait_for': normalizeWaitForParams,
  'dom.find_by_text': normalizeFindByTextParams,
  'dom.find_by_role': normalizeFindByRoleParams,
  'dom.get_html': normalizeGetHtmlParams,
  'styles.get_computed': normalizeStyleQuery,
  'styles.get_matched_rules': normalizeStyleQuery,
  'viewport.scroll': normalizeViewportAction,
  'input.click': normalizeInputAction,
  'input.focus': normalizeInputAction,
  'input.type': normalizeInputAction,
  'input.press_key': normalizeInputAction,
  'input.set_checked': normalizeCheckedAction,
  'input.select_option': normalizeSelectAction,
  'input.hover': normalizeHoverParams,
  'input.drag': normalizeDragParams,
  'patch.apply_styles': normalizePatchOperation,
  'patch.apply_dom': normalizePatchOperation,
  'patch.list': normalizePatchOperation,
  'patch.rollback': normalizePatchOperation,
  'patch.commit_session_baseline': normalizePatchOperation,
  'page.get_storage': normalizeStorageParams,
  'page.get_text': normalizePageTextParams,
};

/**
 * Dispatch a tab-bound request to the content script after enforcing the
 * session scope and capability requirements.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handleTabBoundRequest(request) {
  const target = await resolveRequestTarget(request);
  await ensureContentScript(target.tabId);
  const normalizer = TAB_BOUND_NORMALIZERS[request.method];
  const payload = normalizer ? normalizer(request.params) : request.params;

  if (request.method.startsWith('screenshot.')) {
    const result = await handleScreenshot(target, request.method, request.params);
    return createSuccess(request.id, result, { method: request.method });
  }

  const timeoutMs = getContentScriptTimeout(request.method, payload);
  const response = await sendTabMessage(
    target.tabId,
    {
      type: 'bridge.execute',
      method: request.method,
      params: payload,
    },
    timeoutMs
  );
  if (response?.error) {
    return toFailureResponse(request, response.error);
  }
  return createSuccess(request.id, response, { method: request.method });
}

/**
 * Execute a tab-level navigation action and optionally wait for the next load
 * cycle to complete.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handleNavigationRequest(request) {
  return executeNavigationRequest(request, {
    resolveRequestTarget,
    updateTab: (tabId, properties) => chrome.tabs.update(tabId, properties),
    reloadTab: (tabId) => chrome.tabs.reload(tabId),
    goBack: (tabId) => chrome.tabs.goBack(tabId),
    goForward: (tabId) => chrome.tabs.goForward(tabId),
    waitForTabComplete,
    getTab: (tabId) => chrome.tabs.get(tabId),
    emitUiState,
  });
}

/**
 * Compute a per-method content script timeout that accommodates long-running
 * operations such as dom.wait_for or hover-with-duration.
 *
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @returns {number}
 */
function getContentScriptTimeout(method, params) {
  if (method === 'dom.wait_for') {
    return Math.min(Math.max(Number(params?.timeoutMs) || 5_000, 100), 30_000) + 2_000;
  }
  if (method === 'input.hover' && Number(params?.duration) > 0) {
    return CONTENT_SCRIPT_TIMEOUT_MS + Math.min(Number(params.duration), 5_000) + 1_000;
  }
  return CONTENT_SCRIPT_TIMEOUT_MS;
}

/**
 * Evaluate a JavaScript expression in the page's main context using the
 * Chrome DevTools Protocol, avoiding content-script CSP restrictions.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handlePageEvaluate(request) {
  return executePageEvaluate(request, {
    resolveRequestTarget,
    runWithDebugger: (tabId, operation) => tabDebugger.run(tabId, operation),
    sendCommand: (target, method, params) => chrome.debugger.sendCommand(target, method, params),
  });
}

/**
 * Install a console interceptor on the page and retrieve buffered messages.
 * Uses chrome.scripting.executeScript in the MAIN world.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handlePageGetConsole(request) {
  const target = await resolveRequestTarget(request);
  const params = normalizeConsoleParams(request.params);

  await primeTabConsoleCapture(target.tabId);
  const { entries, dropped } = await readConsoleBuffer(target.tabId, params.clear);
  const filtered =
    params.level === 'all'
      ? entries
      : entries.filter((/** @type {{ level: string }} */ e) =>
          matchesConsoleLevel(params.level, e.level)
        );
  const limited = filtered.slice(-params.limit);

  return createSuccess(
    request.id,
    { entries: limited, count: limited.length, total: entries.length, dropped },
    { method: request.method }
  );
}

/**
 * Create a new tab with an optional URL.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handleCreateTab(request) {
  return executeCreateTab(
    request,
    state,
    {
      createTab: (properties) => chrome.tabs.create(properties),
    },
    ACCESS_DENIED_WINDOW_OFF
  );
}

/**
 * Close a tab by tabId.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handleCloseTab(request) {
  const params = normalizeTabCloseParams(request.params);
  if (!state.enabledWindow) {
    return createFailure(request.id, ERROR_CODES.ACCESS_DENIED, ACCESS_DENIED_WINDOW_OFF, null, {
      method: request.method,
    });
  }
  let tab;
  try {
    tab = await chrome.tabs.get(params.tabId);
  } catch {
    return createFailure(
      request.id,
      ERROR_CODES.TAB_MISMATCH,
      `Tab ${params.tabId} not found.`,
      null,
      { method: request.method }
    );
  }
  if (tab.windowId !== state.enabledWindow.windowId) {
    return createFailure(request.id, ERROR_CODES.ACCESS_DENIED, ACCESS_DENIED_TAB_CLOSE, null, {
      method: request.method,
    });
  }
  await chrome.tabs.remove(params.tabId);
  return createSuccess(
    request.id,
    { closed: true, tabId: params.tabId },
    { method: request.method }
  );
}

/**
 * Return the full accessibility tree for the target tab via CDP
 * Accessibility.getFullAXTree. Returns a pruned, token-efficient tree with
 * roles, names, descriptions, and interactive states.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handleAccessibilityTree(request) {
  const target = await resolveRequestTarget(request);
  const params = normalizeAccessibilityTreeParams(request.params);
  return tabDebugger.run(target.tabId, async (debugTarget) => {
    await chrome.debugger.sendCommand(debugTarget, 'Accessibility.enable', {});
    const result = await chrome.debugger.sendCommand(debugTarget, 'Accessibility.getFullAXTree', {
      depth: params.maxDepth,
    });
    const cdpResult = /** @type {{ nodes?: Array<Record<string, unknown>> }} */ (result);
    const rawNodes = cdpResult.nodes || [];
    const pruned = rawNodes.slice(0, params.maxNodes).map(simplifyAXNode);
    await chrome.debugger.sendCommand(debugTarget, 'Accessibility.disable', {});
    return createSuccess(
      request.id,
      {
        nodes: pruned,
        count: pruned.length,
        total: rawNodes.length,
        truncated: rawNodes.length > params.maxNodes,
      },
      { method: request.method }
    );
  });
}

/**
 * Install a network interceptor and retrieve buffered request/response entries
 * via chrome.scripting.executeScript in the MAIN world, capturing fetch/XHR.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handleGetNetwork(request) {
  const target = await resolveRequestTarget(request);
  const params = normalizeNetworkParams(request.params);
  await ensureNetworkInterceptor(target.tabId);
  const { entries, dropped } = await readNetworkBuffer(target.tabId, params.clear);
  const urlPattern = typeof params.urlPattern === 'string' ? params.urlPattern : null;
  const filtered = urlPattern
    ? entries.filter((/** @type {{ url: string }} */ e) => e.url.includes(urlPattern))
    : entries;
  const limited = filtered.slice(-params.limit);
  return createSuccess(
    request.id,
    { entries: limited, count: limited.length, total: entries.length, dropped },
    { method: request.method }
  );
}

/**
 * Inject the network interceptor into the page's main world. Patches
 * fetch and XMLHttpRequest to capture request/response metadata.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function ensureNetworkInterceptor(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      // @ts-ignore
      if (globalThis.__bb_network_installed) return;
      // @ts-ignore
      globalThis.__bb_network_installed = true;
      /** @type {Array<{method: string, url: string, status: number, duration: number, type: string, ts: number, size: number}>} */
      const buffer = [];
      // @ts-ignore
      globalThis.__bb_network_buffer = buffer;
      // @ts-ignore
      globalThis.__bb_network_dropped = 0;
      const MAX = 200;

      const origFetch = globalThis.fetch;
      // @ts-ignore - intentional main-world global override
      globalThis.fetch = async function (...args) {
        // @ts-ignore
        const req = new Request(...args);
        const entry = {
          method: req.method,
          url: req.url,
          status: 0,
          duration: 0,
          type: 'fetch',
          ts: Date.now(),
          size: 0,
        };
        const startTime = performance.now();
        try {
          const resp = await origFetch.apply(globalThis, args);
          entry.status = resp.status;
          entry.duration = Math.round(performance.now() - startTime);
          const cl = resp.headers.get('content-length');
          if (cl) entry.size = Number(cl);
          return resp;
        } catch (err) {
          entry.status = 0;
          entry.duration = Math.round(performance.now() - startTime);
          throw err;
        } finally {
          buffer.push(entry);
          if (buffer.length > MAX) {
            const dropped =
              /** @type {Record<string, unknown>} */ (globalThis).__bb_network_dropped;
            /** @type {Record<string, unknown>} */ (globalThis).__bb_network_dropped =
              (typeof dropped === 'number' ? dropped : 0) + (buffer.length - MAX);
            buffer.splice(0, buffer.length - MAX);
          }
        }
      };

      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      /**
       * @this {XMLHttpRequest & { __bb_method?: string, __bb_url?: string }}
       * @param {string} method
       * @param {string | URL} url
       * @param {...unknown} rest
       * @returns {unknown}
       */
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        // @ts-ignore - stashing method/url for XHR interception
        this.__bb_method = method;
        // @ts-ignore
        this.__bb_url = String(url);
        return /** @type {any} */ (origOpen).call(this, method, url, ...rest);
      };
      /**
       * @this {XMLHttpRequest & { __bb_method?: string, __bb_url?: string }}
       * @param {...unknown} args
       * @returns {unknown}
       */
      XMLHttpRequest.prototype.send = function (...args) {
        // @ts-ignore
        const entry = {
          method: this.__bb_method || 'GET',
          url: this.__bb_url || '',
          status: 0,
          duration: 0,
          type: 'xhr',
          ts: Date.now(),
          size: 0,
        };
        const startTime = performance.now();
        this.addEventListener('loadend', () => {
          entry.status = this.status;
          entry.duration = Math.round(performance.now() - startTime);
          const cl = this.getResponseHeader('content-length');
          if (cl) entry.size = Number(cl);
          buffer.push(entry);
          if (buffer.length > MAX) {
            const dropped =
              /** @type {Record<string, unknown>} */ (globalThis).__bb_network_dropped;
            /** @type {Record<string, unknown>} */ (globalThis).__bb_network_dropped =
              (typeof dropped === 'number' ? dropped : 0) + (buffer.length - MAX);
            buffer.splice(0, buffer.length - MAX);
          }
        });
        return /** @type {any} */ (origSend).apply(this, args);
      };
    },
  });
}

/**
 * Read and optionally clear the network buffer from the page's main world.
 *
 * @param {number} tabId
 * @param {boolean} clear
 * @returns {Promise<{ entries: Array<{method: string, url: string, status: number, duration: number, type: string, ts: number, size: number}>, dropped: number }>}
 */
async function readNetworkBuffer(tabId, clear) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (shouldClear) => {
      // @ts-ignore
      const buf = globalThis.__bb_network_buffer || [];
      // @ts-ignore
      const dropped = globalThis.__bb_network_dropped || 0;
      const copy = [...buf];
      if (shouldClear) {
        // @ts-ignore
        globalThis.__bb_network_buffer = [];
        // @ts-ignore
        globalThis.__bb_network_dropped = 0;
      }
      return { entries: copy, dropped };
    },
    args: [clear],
  });
  return /** @type {any} */ (results?.[0]?.result) || { entries: [], dropped: 0 };
}

/**
 * Resize the browser viewport via CDP Emulation.setDeviceMetricsOverride
 * or reset to natural size when width/height are 0.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handleViewportResize(request) {
  const target = await resolveRequestTarget(request);
  const params = normalizeViewportResizeParams(request.params);
  return tabDebugger.run(target.tabId, async (debugTarget) => {
    if (params.reset || (params.width === 0 && params.height === 0)) {
      await chrome.debugger.sendCommand(debugTarget, 'Emulation.clearDeviceMetricsOverride', {});
    } else {
      await chrome.debugger.sendCommand(debugTarget, 'Emulation.setDeviceMetricsOverride', {
        width: params.width,
        height: params.height,
        deviceScaleFactor: params.deviceScaleFactor,
        mobile: params.width < 768,
      });
    }
    return createSuccess(
      request.id,
      {
        resized: true,
        width: params.width,
        height: params.height,
        deviceScaleFactor: params.deviceScaleFactor,
        reset: params.reset,
      },
      { method: request.method }
    );
  });
}

/**
 * Return browser performance metrics via CDP Performance.getMetrics.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handlePerformanceMetrics(request) {
  const target = await resolveRequestTarget(request);
  return tabDebugger.run(target.tabId, async (debugTarget) => {
    await chrome.debugger.sendCommand(debugTarget, 'Performance.enable', {
      timeDomain: 'timeTicks',
    });
    const result = await chrome.debugger.sendCommand(debugTarget, 'Performance.getMetrics', {});
    await chrome.debugger.sendCommand(debugTarget, 'Performance.disable', {});
    const cdpResult = /** @type {{ metrics?: Array<{ name: string, value: number }> }} */ (result);
    const metrics = (cdpResult.metrics || []).reduce((acc, m) => {
      acc[m.name] = m.value;
      return acc;
    }, /** @type {Record<string, number>} */ ({}));
    return createSuccess(request.id, { metrics }, { method: request.method });
  });
}

/**
 * Wait for the tab to reach the 'complete' load state.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handleWaitForLoadState(request) {
  const target = await resolveRequestTarget(request);
  const params = normalizeWaitForLoadStateParams(request.params);
  const tab = params.waitForLoad
    ? await waitForTabComplete(target.tabId, params.timeoutMs)
    : await chrome.tabs.get(target.tabId);
  return createSuccess(request.id, summarizeTabResult(tab, request.method), {
    method: request.method,
  });
}

/**
 * Inject the console interceptor into the page's main world if not already
 * present. The interceptor patches console methods and captures unhandled
 * errors into a bounded in-page buffer.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function ensureConsoleInterceptor(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      // @ts-ignore - intentional main-world global
      if (globalThis.__bb_console_installed) return;
      // @ts-ignore
      globalThis.__bb_console_installed = true;
      /** @type {Array<{level: string, args: string[], ts: number}>} */
      const buffer = [];
      // @ts-ignore
      globalThis.__bb_console_buffer = buffer;
      // @ts-ignore
      globalThis.__bb_console_dropped = 0;
      const MAX = 200;
      const orig = /** @type {Record<string, Function>} */ ({});
      const consoleMethods =
        /** @type {Record<string, (...args: unknown[]) => void>} */ (
          /** @type {unknown} */ (console)
        );
      for (const level of ['log', 'warn', 'error', 'info', 'debug']) {
        orig[level] = consoleMethods[level];
        consoleMethods[level] = (...args) => {
          buffer.push({
            level,
            args: args.map((a) => {
              try {
                return typeof a === 'object'
                  ? JSON.stringify(a).slice(0, 500)
                  : String(a).slice(0, 500);
              } catch {
                return String(a).slice(0, 500);
              }
            }),
            ts: Date.now(),
          });
          if (buffer.length > MAX) {
            const dropped =
              /** @type {Record<string, unknown>} */ (globalThis).__bb_console_dropped;
            /** @type {Record<string, unknown>} */ (globalThis).__bb_console_dropped =
              (typeof dropped === 'number' ? dropped : 0) + (buffer.length - MAX);
            buffer.splice(0, buffer.length - MAX);
          }
          orig[level].apply(console, args);
        };
      }
      globalThis.addEventListener('error', (e) => {
        buffer.push({
          level: 'exception',
          args: [
            e.message || 'Unknown error',
            e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '',
          ],
          ts: Date.now(),
        });
        if (buffer.length > MAX) {
          const dropped = /** @type {Record<string, unknown>} */ (globalThis).__bb_console_dropped;
          /** @type {Record<string, unknown>} */ (globalThis).__bb_console_dropped =
            (typeof dropped === 'number' ? dropped : 0) + (buffer.length - MAX);
          buffer.splice(0, buffer.length - MAX);
        }
      });
      globalThis.addEventListener('unhandledrejection', (e) => {
        buffer.push({
          level: 'rejection',
          args: [String(e.reason).slice(0, 500)],
          ts: Date.now(),
        });
        if (buffer.length > MAX) {
          const dropped = /** @type {Record<string, unknown>} */ (globalThis).__bb_console_dropped;
          /** @type {Record<string, unknown>} */ (globalThis).__bb_console_dropped =
            (typeof dropped === 'number' ? dropped : 0) + (buffer.length - MAX);
          buffer.splice(0, buffer.length - MAX);
        }
      });
    },
  });
}

/**
 * Best-effort console capture installation for enabled tabs. Some URLs cannot
 * be scripted; those failures should not block enablement or navigation.
 *
 * @param {number} tabId
 * @param {boolean} [resetBuffer=false]
 * @returns {Promise<void>}
 */
async function primeTabConsoleCapture(tabId, resetBuffer = false) {
  try {
    await ensureConsoleInterceptor(tabId);
    if (resetBuffer) {
      await readConsoleBuffer(tabId, true);
    }
  } catch (error) {
    if (isRecoverableInstrumentationError(error)) {
      return;
    }
    throw error;
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isRecoverableInstrumentationError(error) {
  const message = normalizeRuntimeErrorMessage(getErrorMessage(error));
  return (
    message === ERROR_CODES.TAB_MISMATCH ||
    /Cannot access contents of/i.test(message) ||
    /The extensions gallery cannot be scripted/i.test(message) ||
    /Cannot access a chrome:\/\//i.test(message) ||
    /Cannot script/i.test(message) ||
    /CONTENT_SCRIPT_UNAVAILABLE/i.test(message) ||
    /No tab with id/i.test(message) ||
    /Cannot attach to this target/i.test(message) ||
    /Another debugger is already attached/i.test(message)
  );
}

/**
 * Read and optionally clear the console buffer from the page's main world.
 *
 * @param {number} tabId
 * @param {boolean} clear
 * @returns {Promise<{ entries: Array<{level: string, args: string[], ts: number}>, dropped: number }>}
 */
async function readConsoleBuffer(tabId, clear) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (shouldClear) => {
      // @ts-ignore
      const buf = globalThis.__bb_console_buffer || [];
      // @ts-ignore
      const dropped = globalThis.__bb_console_dropped || 0;
      const copy = [...buf];
      if (shouldClear) {
        // @ts-ignore
        globalThis.__bb_console_buffer = [];
        // @ts-ignore
        globalThis.__bb_console_dropped = 0;
      }
      return { entries: copy, dropped };
    },
    args: [clear],
  });
  return /** @type {any} */ (results?.[0]?.result) || { entries: [], dropped: 0 };
}

/**
 * Prime console capture for every tab in one window.
 *
 * @param {number} windowId
 * @param {boolean} [resetBuffer=false]
 * @returns {Promise<void>}
 */
async function primeWindowConsoleCapture(windowId, resetBuffer = false) {
  const tabs = await chrome.tabs.query({ windowId });
  const tabIds = tabs
    .map((tab) => (isNumber(tab.id) ? tab.id : null))
    .filter((tabId) => tabId !== null);
  await Promise.allSettled(tabIds.map((tabId) => primeTabConsoleCapture(tabId, resetBuffer)));
}

/**
 * Clear bridge buffers and roll back active patches for one tab.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function clearTabBridgeState(tabId) {
  try {
    await rollbackAllPatchesForTab(tabId);
  } catch (error) {
    if (!isRecoverableInstrumentationError(error)) {
      throw error;
    }
  }
  try {
    await readConsoleBuffer(tabId, true);
  } catch (error) {
    if (!isRecoverableInstrumentationError(error)) {
      throw error;
    }
  }
  try {
    await readNetworkBuffer(tabId, true);
  } catch (error) {
    if (!isRecoverableInstrumentationError(error)) {
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
  const tabIds = tabs
    .filter((tab) => tab.url && !isRestrictedAutomationUrl(tab.url))
    .map((tab) => (isNumber(tab.id) ? tab.id : null))
    .filter((tabId) => tabId !== null);
  await Promise.allSettled(tabIds.map((tabId) => clearTabBridgeState(tabId)));
}

/**
 * Roll back all reversible patches currently tracked in one tab.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function rollbackAllPatchesForTab(tabId) {
  try {
    await ensureContentScript(tabId);
    const listed = await sendTabMessage(
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
    for (const patch of patches) {
      const patchId =
        patch && typeof patch === 'object'
          ? /** @type {Record<string, unknown>} */ (patch).patchId
          : null;
      if (typeof patchId !== 'string' || !patchId) {
        continue;
      }
      await sendTabMessage(
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
    if (!isRecoverableInstrumentationError(error)) {
      throw error;
    }
  }
}

/**
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
async function isTabEnabled(tabId) {
  if (!state.enabledWindow) {
    return false;
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.windowId === state.enabledWindow.windowId;
  } catch {
    return false;
  }
}

/**
 * Capture a targeted screenshot for the current target tab by asking the content
 * script for an element rect and then cropping the visible tab image.
 *
 * @param {ResolvedTabTarget} target
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @returns {Promise<{ rect: unknown, image: string }>}
 */
async function handleScreenshot(target, method, params) {
  /** @type {{ x: number, y: number, width: number, height: number, scale: number }} */
  let clip;

  if (method === 'screenshot.capture_element') {
    await ensureContentScript(target.tabId);
    try {
      clip = await sendTabMessage(
        target.tabId,
        {
          type: 'bridge.execute',
          method,
          params,
        },
        CONTENT_SCRIPT_TIMEOUT_MS
      );
    } catch (err) {
      // Retry once after a brief pause - the page may have been mid-render
      if (err instanceof Error && /stale/i.test(err.message)) {
        await new Promise((r) => setTimeout(r, 250));
        clip = await sendTabMessage(
          target.tabId,
          {
            type: 'bridge.execute',
            method,
            params,
          },
          CONTENT_SCRIPT_TIMEOUT_MS
        );
      } else {
        throw err;
      }
    }
    // Defensively coerce content-script values - NaN / undefined / negative
    // would slip past the < 1 guard and reach CDP as invalid values.
    clip = {
      x: Math.max(0, Number(clip.x) || 0),
      y: Math.max(0, Number(clip.y) || 0),
      width: Math.max(0, Number(clip.width) || 0),
      height: Math.max(0, Number(clip.height) || 0),
      scale: Number(clip.scale) || 1,
    };
  } else if (method === 'screenshot.capture_full_page') {
    await ensureContentScript(target.tabId);
    const dims =
      /** @type {{ scrollWidth: number, scrollHeight: number, devicePixelRatio: number }} */ (
        await sendTabMessage(
          target.tabId,
          { type: 'bridge.execute', method, params },
          CONTENT_SCRIPT_TIMEOUT_MS
        )
      );
    clip = {
      x: 0,
      y: 0,
      width: Math.min(Math.max(1, Number(dims.scrollWidth) || 1), 16384),
      height: Math.min(Math.max(1, Number(dims.scrollHeight) || 1), 16384),
      scale: Number(dims.devicePixelRatio) || 1,
    };
  } else {
    // capture_region: params already carry viewport coordinates
    const scale = Number(params.scale) || 1;
    clip = {
      x: Number(params.x) || 0,
      y: Number(params.y) || 0,
      width: Math.max(1, Number(params.width) || 1),
      height: Math.max(1, Number(params.height) || 1),
      scale,
    };
  }

  if (clip.width < 1 || clip.height < 1) {
    throw new Error(
      `Capture target has no visible area (${clip.width}\u00d7${clip.height}px). ` +
        'It may be hidden, collapsed, or not yet rendered.'
    );
  }

  // Use CDP Page.captureScreenshot - works regardless of tab focus,
  // captures renderer output directly with built-in clip support.
  return tabDebugger.run(target.tabId, async (debugTarget) => {
    const dpr = clip.scale || 1;
    const cdpResult = /** @type {{ data?: string }} */ (
      await chrome.debugger.sendCommand(debugTarget, 'Page.captureScreenshot', {
        format: 'png',
        clip: {
          x: Math.max(0, clip.x),
          y: Math.max(0, clip.y),
          width: clip.width,
          height: clip.height,
          scale: dpr,
        },
        captureBeyondViewport: method === 'screenshot.capture_full_page',
      })
    );
    if (!cdpResult?.data) {
      throw new Error('CDP Page.captureScreenshot returned empty data.');
    }
    return {
      rect: clip,
      image: `data:image/png;base64,${cdpResult.data}`,
    };
  });
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
    return await Promise.race([chrome.tabs.sendMessage(tabId, message), timeout]);
  } finally {
    clearTimeout(timeoutId);
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
  const tabs = await chrome.tabs.query({ windowId });
  await Promise.allSettled(
    tabs
      .map((tab) =>
        isNumber(tab.id) && tab.url && !isRestrictedAutomationUrl(tab.url) ? tab.id : null
      )
      .filter((tabId) => tabId !== null)
      .map((tabId) => ensureContentScript(tabId))
  );
}

/**
 * Detect Chrome scripting errors that indicate a restricted or unscriptable page.
 *
 * @param {string} message
 * @returns {boolean}
 */
function isRestrictedScriptingError(message) {
  return (
    /Cannot access contents of/i.test(message) ||
    /The extensions gallery cannot be scripted/i.test(message) ||
    /Cannot access a chrome:\/\//i.test(message) ||
    /Cannot script/i.test(message)
  );
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
    await sendTabMessage(tabId, { type: 'bridge.ping' }, CONTENT_SCRIPT_TIMEOUT_MS);
    return;
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [
          'packages/extension/src/content-script-helpers.js',
          'packages/extension/src/content-script.js',
        ],
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
}

/**
 * Execute a restricted Chrome DevTools Protocol request against the enabled
 * tab.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handleCdpRequest(request) {
  const target = await resolveRequestTarget(request);
  return tabDebugger.run(target.tabId, async (debugTarget) => {
    if (request.method === 'cdp.dispatch_key_event') {
      const events = createCdpKeyPressEventPair(request.params ?? {});
      for (const event of events) {
        await chrome.debugger.sendCommand(debugTarget, 'Input.dispatchKeyEvent', event);
      }
      return createSuccess(
        request.id,
        {
          method: 'Input.dispatchKeyEvent',
          pressed: true,
          key: events[0]?.key ?? '',
          code: events[0]?.code ?? '',
          dispatched: events.map((event) => event.type),
        },
        { method: request.method }
      );
    }

    let command;
    let params = {};
    if (request.method === 'cdp.get_document') {
      command = 'DOM.getDocument';
      params = { depth: 2, pierce: false };
    } else if (request.method === 'cdp.get_dom_snapshot') {
      command = 'DOMSnapshot.captureSnapshot';
      params = { computedStyles: request.params?.computedStyles ?? [] };
    } else if (request.method === 'cdp.get_box_model') {
      const nodeId = request.params?.nodeId;
      if (typeof nodeId !== 'number' || !Number.isFinite(nodeId)) {
        return createFailure(
          request.id,
          ERROR_CODES.INVALID_REQUEST,
          'nodeId must be a finite number.',
          null,
          { method: request.method }
        );
      }
      command = 'DOM.getBoxModel';
      params = { nodeId };
    } else {
      const nodeId = request.params?.nodeId;
      if (typeof nodeId !== 'number' || !Number.isFinite(nodeId)) {
        return createFailure(
          request.id,
          ERROR_CODES.INVALID_REQUEST,
          'nodeId must be a finite number.',
          null,
          { method: request.method }
        );
      }
      command = 'CSS.getComputedStyleForNode';
      params = { nodeId };
    }
    const result = await chrome.debugger.sendCommand(
      debugTarget,
      command,
      /** @type {Record<string, unknown>} */ (params)
    );
    return createSuccess(request.id, result, { method: request.method });
  });
}

/**
 * Wait for a tab to reach the `complete` status after a navigation-like action.
 *
 * @param {number} tabId
 * @param {number} timeoutMs
 * @returns {Promise<chrome.tabs.Tab>}
 */
async function waitForTabComplete(tabId, timeoutMs) {
  const initialTab = await chrome.tabs.get(tabId);
  if (initialTab.status === 'complete') {
    return initialTab;
  }

  return new Promise((resolve, reject) => {
    let finished = false;
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Timed out waiting for tab ${tabId} to finish loading after ${timeoutMs}ms.`)
      );
    }, timeoutMs);

    /**
     * @returns {void}
     */
    function cleanup() {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }

    /**
     * @param {number} updatedTabId
     * @param {TabChangeInfo} changeInfo
     * @param {chrome.tabs.Tab} tab
     * @returns {void}
     */
    function onUpdated(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') {
        return;
      }
      cleanup();
      resolve(tab);
    }

    /**
     * @param {number} removedTabId
     * @returns {void}
     */
    function onRemoved(removedTabId) {
      if (removedTabId !== tabId) {
        return;
      }
      cleanup();
      reject(new Error(ERROR_CODES.TAB_MISMATCH));
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

/**
 * Resolve the tab a request should operate on. Requests may explicitly target
 * one tab via `tab_id`; otherwise they follow the active tab in the enabled
 * window.
 *
 * @param {BridgeRequest} request
 * @param {{ requireScriptable?: boolean }} [options]
 * @returns {Promise<ResolvedTabTarget>}
 */
async function resolveRequestTarget(request, options = {}) {
  const requireScriptable = options.requireScriptable !== false;
  if (!state.enabledWindow) {
    throw new Error(ERROR_CODES.ACCESS_DENIED);
  }

  try {
    await chrome.windows.get(state.enabledWindow.windowId);
  } catch {
    const cleared = await clearEnabledWindowIfGone();
    if (cleared) {
      throw new Error(ERROR_CODES.ACCESS_DENIED);
    }
  }

  /** @type {chrome.tabs.Tab | null} */
  let explicitTab = null;
  if (typeof request.tab_id === 'number' && Number.isFinite(request.tab_id)) {
    explicitTab = await chrome.tabs.get(request.tab_id);
  }
  const [activeTab] = await chrome.tabs.query({
    active: true,
    windowId: state.enabledWindow.windowId,
  });
  const tab = selectRequestTabCandidate(request.tab_id, explicitTab, activeTab ?? null);

  return resolveWindowScopedTab(tab, state.enabledWindow.windowId, {
    requireScriptable,
  });
}

/**
 * Resolve the current active tab in the last-focused window so the popup and
 * side panel can reflect and toggle its bridge enablement state.
 *
 * @returns {Promise<CurrentTabState | null>}
 */
async function getCurrentTabState() {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!activeTab?.id || typeof activeTab.windowId !== 'number' || !activeTab.url) {
    return null;
  }

  return {
    tabId: activeTab.id,
    windowId: activeTab.windowId,
    title: activeTab.title ?? '',
    url: activeTab.url,
    enabled: isWindowEnabled(activeTab.windowId),
    accessRequested: isAccessRequestedWindow(activeTab.windowId),
    restricted: isRestrictedAutomationUrl(activeTab.url),
  };
}

/**
 * Resolve one specific tab into the UI shape used by the popup and side panel.
 *
 * @param {number | null} tabId
 * @returns {Promise<CurrentTabState | null>}
 */
async function getTabState(tabId) {
  if (!tabId) {
    return null;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    if (typeof tab.id !== 'number' || typeof tab.windowId !== 'number' || !tab.url) {
      return null;
    }

    return {
      tabId: tab.id,
      windowId: tab.windowId,
      title: tab.title ?? '',
      url: tab.url,
      enabled: isWindowEnabled(tab.windowId),
      accessRequested: isAccessRequestedWindow(tab.windowId),
      restricted: isRestrictedAutomationUrl(tab.url),
    };
  } catch {
    return null;
  }
}

/**
 * Enable or disable bridge communication for the current window.
 *
 * @param {boolean} enabled
 * @returns {Promise<void>}
 */
async function setCurrentWindowEnabled(enabled) {
  const currentTab = await getCurrentTabState();
  if (!currentTab?.url) {
    throw new Error(ERROR_CODES.TAB_MISMATCH);
  }

  await setWindowEnabled(currentTab.windowId, currentTab.title, enabled);
}

/**
 * Enable or disable bridge communication for one specific window.
 *
 * @param {number} windowId
 * @param {string} title
 * @param {boolean} enabled
 * @returns {Promise<void>}
 */
async function setWindowEnabled(windowId, title, enabled) {
  clearRequestedAccessWindow();
  const access = {
    windowId,
    title,
    enabledAt: Date.now(),
  };

  if (enabled) {
    state.enabledWindow = access;
    await chrome.storage.session.set({
      [ENABLED_WINDOW_STORAGE_KEY]: access,
    });
  } else {
    if (state.enabledWindow && state.enabledWindow.windowId === windowId) {
      state.enabledWindow = null;
      await chrome.storage.session.remove(ENABLED_WINDOW_STORAGE_KEY);
    }
  }

  try {
    await refreshActionIndicators();
  } catch {
    /* Badge updates can fail for closed or restricted tabs. */
  }
  await emitUiState();

  if (enabled) {
    sendAccessUpdate(true);
    await chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.4 });
    await Promise.allSettled([
      injectContentScriptsForWindow(access.windowId),
      primeWindowConsoleCapture(access.windowId, true),
    ]);
  } else {
    sendAccessUpdate(false);
    try {
      await chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
      await clearWindowBridgeState(windowId);
    } catch (error) {
      reportAsyncError(error);
    }
  }
}

/**
 * React to tab navigation/title changes so popup and side panel state stays in
 * sync with the tab the user is currently looking at.
 *
 * @param {number} tabId
 * @param {TabChangeInfo} changeInfo
 * @param {chrome.tabs.Tab} tab
 * @returns {Promise<void>}
 */
async function handleTabUpdated(tabId, changeInfo, tab) {
  if (
    typeof changeInfo.title === 'string' &&
    state.enabledWindow &&
    tab.windowId === state.enabledWindow.windowId
  ) {
    state.enabledWindow = {
      ...state.enabledWindow,
      title: changeInfo.title,
    };
    await chrome.storage.session.set({
      [ENABLED_WINDOW_STORAGE_KEY]: state.enabledWindow,
    });
  }

  if (
    typeof changeInfo.url === 'string' ||
    typeof changeInfo.title === 'string' ||
    changeInfo.status === 'complete'
  ) {
    if (
      changeInfo.status === 'complete' &&
      state.enabledWindow &&
      tab.windowId === state.enabledWindow.windowId
    ) {
      await primeTabConsoleCapture(tabId);
    }
    await updateActionIndicatorForTab(tabId);
    await emitUiState();
  }
}

/**
 * Remove any persisted enablement when the enabled window closes.
 *
 * @param {number} tabId
 * @param {{ windowId: number, isWindowClosing: boolean }} removeInfo
 * @returns {Promise<void>}
 */
async function handleTabRemoved(tabId, removeInfo) {
  if (
    state.enabledWindow &&
    removeInfo.isWindowClosing &&
    removeInfo.windowId === state.enabledWindow.windowId
  ) {
    state.enabledWindow = null;
    await chrome.storage.session.remove(ENABLED_WINDOW_STORAGE_KEY);
    sendAccessUpdate(false);
  }
  if (removeInfo.isWindowClosing && removeInfo.windowId === state.requestedAccessWindowId) {
    clearRequestedAccessWindow(removeInfo.windowId);
  }
  await updateActionIndicatorForTab(tabId);
  await emitUiState();
}

/**
 * Refresh the extension action badge and title across the currently open tabs.
 *
 * @returns {Promise<void>}
 */
async function refreshActionIndicators() {
  const query = state.enabledWindow ? { windowId: state.enabledWindow.windowId } : {};
  const tabs = await chrome.tabs.query(query);
  const tabIds = tabs
    .map((tab) => (isNumber(tab.id) ? tab.id : null))
    .filter((tabId) => tabId !== null);
  await Promise.allSettled(tabIds.map((tabId) => updateActionIndicatorForTab(tabId)));

  // Some Chromium-based browsers (e.g. Edge) do not visually refresh the toolbar
  // badge after per-tab updates until the tab navigates. Setting the global badge
  // (without tabId) to match the active tab forces an immediate repaint.
  await syncGlobalBadgeToActiveTab();
}

/**
 * Set the global badge (no tabId) to match the active tab in the last-focused
 * window. This forces browsers that batch per-tab badge updates (e.g. Edge) to
 * immediately repaint the toolbar icon.
 *
 * @returns {Promise<void>}
 */
async function syncGlobalBadgeToActiveTab() {
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!activeTab?.id) return;
    const enabled = await isTabEnabled(activeTab.id);
    const accessRequested = !enabled && (await isAccessRequestedTab(activeTab.id));
    const restricted = enabled && isRestrictedAutomationUrl(activeTab.url ?? '');
    const text = enabled
      ? restricted
        ? RESTRICTED_BADGE_TEXT
        : ENABLED_BADGE_TEXT
      : accessRequested
        ? ACCESS_REQUEST_BADGE_TEXT
        : '';
    const bgColor = enabled
      ? restricted
        ? '#e07020'
        : '#787878'
      : accessRequested
        ? '#f2cf2f'
        : '#464646';
    const textColor = enabled ? '#ffffff' : accessRequested ? '#000000' : '#ffffff';
    await chrome.action.setBadgeText({ text });
    try {
      await chrome.action.setBadgeBackgroundColor({ color: bgColor });
    } catch {
      /* unsupported */
    }
    try {
      await chrome.action.setBadgeTextColor({ color: textColor });
    } catch {
      /* unsupported */
    }
  } catch {
    /* non-critical */
  }
}

/**
 * Update the action badge and title for one tab so enabled windows are visibly
 * marked from the Chrome toolbar.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function updateActionIndicatorForTab(tabId) {
  const enabled = await isTabEnabled(tabId);
  const accessRequested = !enabled && (await isAccessRequestedTab(tabId));
  let restricted = false;
  if (enabled) {
    try {
      const tab = await chrome.tabs.get(tabId);
      restricted = isRestrictedAutomationUrl(tab.url ?? '');
    } catch {
      /* ignore */
    }
  }
  const badgeText = enabled
    ? restricted
      ? RESTRICTED_BADGE_TEXT
      : ENABLED_BADGE_TEXT
    : accessRequested
      ? ACCESS_REQUEST_BADGE_TEXT
      : '';
  const bgColor = enabled
    ? restricted
      ? '#e07020'
      : '#787878'
    : accessRequested
      ? '#f2cf2f'
      : '#464646';
  const textColor = enabled ? '#ffffff' : accessRequested ? '#000000' : '#ffffff';
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: bgColor });
  } catch {
    /* color APIs may be unsupported */
  }
  try {
    await chrome.action.setBadgeTextColor({ tabId, color: textColor });
  } catch {
    /* setBadgeTextColor not supported everywhere */
  }
  try {
    if (enabled && restricted) {
      await chrome.action.setTitle({
        tabId,
        title: 'Browser Bridge is enabled, but this page cannot be interacted with.',
      });
    } else if (enabled) {
      await chrome.action.setTitle({
        tabId,
        title: 'Browser Bridge is enabled for this window.',
      });
    } else if (accessRequested) {
      await chrome.action.setTitle({
        tabId,
        title:
          'Agent requested Browser Bridge access for this window. Click to open Browser Bridge, then click Enable.',
      });
    } else {
      await chrome.action.setTitle({ tabId, title: 'Browser Bridge' });
    }
  } catch {
    /* title can fail for closed tabs */
  }
  try {
    await chrome.action.setBadgeText({ tabId, text: badgeText });
  } catch (error) {
    if (normalizeRuntimeErrorMessage(getErrorMessage(error)) === ERROR_CODES.TAB_MISMATCH) {
      return;
    }
    throw error;
  }
}

/**
 * Check whether the user explicitly enabled bridge communication for a given
 * window.
 *
 * @param {number} windowId
 * @returns {boolean}
 */
function isWindowEnabled(windowId) {
  return state.enabledWindow?.windowId === windowId;
}

/**
 * @param {number} windowId
 * @returns {boolean}
 */
function isAccessRequestedWindow(windowId) {
  return state.requestedAccessWindowId === windowId;
}

/**
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
async function isAccessRequestedTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return typeof tab.windowId === 'number' && isAccessRequestedWindow(tab.windowId);
  } catch {
    return false;
  }
}

/**
 * @param {number | null} [windowId=null]
 * @returns {void}
 */
function clearRequestedAccessWindow(windowId = null) {
  if (windowId == null || state.requestedAccessWindowId === windowId) {
    state.requestedAccessWindowId = null;
  }
}

/**
 * @param {number | null} [windowId=null]
 * @returns {void}
 */
function clearRequestedAccessPopupWindow(windowId = null) {
  if (windowId == null || state.requestedAccessPopupWindowId === windowId) {
    state.requestedAccessPopupWindowId = null;
  }
}

/**
 * Surface an enable cue in the extension UI when an agent-side request fails
 * because Browser Bridge is off for the target window.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<void>}
 */
async function requestEnableFromAgentSide(request) {
  const target = await resolveRequestedAccessTarget(request);
  if (!target) {
    return;
  }

  if (state.requestedAccessWindowId != null) {
    return;
  }

  state.requestedAccessWindowId = target.windowId;
  await refreshActionIndicators();
  await emitUiState();
  await openRequestedAccessUi(target);
}

/**
 * @param {ResolvedTabTarget} target
 * @returns {{ allowed: true } | { allowed: false, message: string }}
 */
function checkAccessRequestAvailability(target) {
  if (state.requestedAccessWindowId == null) {
    return { allowed: true };
  }

  if (state.requestedAccessWindowId === target.windowId) {
    return {
      allowed: false,
      message:
        'Browser Bridge access is already pending for this window. Ask the user to click Enable before requesting access again.',
    };
  }

  return {
    allowed: false,
    message:
      'Browser Bridge access is already pending for another window. Ask the user to click Enable for that window before requesting access again.',
  };
}

/**
 * Handle an explicit access.request call. Resolves the active tab in the
 * last-focused window, surfaces the Enable cue in the extension UI, and
 * returns the requested window/tab metadata.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handleAccessRequest(request) {
  const target = await resolveRequestedAccessTarget(request);

  if (state.enabledWindow) {
    const access = await getAccessStatus({
      chrome,
      state,
      clearEnabledWindowIfGone,
      isRestrictedAutomationUrl,
    });
    return createSuccess(
      request.id,
      {
        enabled: true,
        access,
      },
      { method: request.method }
    );
  }

  if (!target) {
    return createFailure(
      request.id,
      ERROR_CODES.ACCESS_DENIED,
      'No scriptable tab found in the focused window.',
      null,
      { method: request.method }
    );
  }

  const availability = checkAccessRequestAvailability(target);
  if (!availability.allowed) {
    return createFailure(
      request.id,
      ERROR_CODES.ACCESS_DENIED,
      availability.message,
      {
        requestedWindowId: state.requestedAccessWindowId,
        requestedTargetWindowId: target.windowId,
        requestedTargetTabId: target.tabId,
      },
      { method: request.method }
    );
  }

  state.requestedAccessWindowId = target.windowId;
  await refreshActionIndicators();
  await emitUiState();
  await openRequestedAccessUi(target);

  return createSuccess(
    request.id,
    {
      enabled: false,
      requested: true,
      windowId: target.windowId,
      tabId: target.tabId,
      title: target.title,
      url: target.url,
    },
    { method: request.method }
  );
}

/**
 * @param {BridgeRequest} request
 * @returns {Promise<ResolvedTabTarget | null>}
 */
async function resolveRequestedAccessTarget(request) {
  if (typeof request.tab_id === 'number' && request.tab_id > 0) {
    try {
      const tab = await chrome.tabs.get(request.tab_id);
      return normalizeRequestedAccessTab(tab);
    } catch {
      return null;
    }
  }

  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return normalizeRequestedAccessTab(tabs[0] ?? null);
}

/**
 * Open Browser Bridge UI for an agent-side access request. If the side panel
 * is already open for that window, leave it in place so its existing attention
 * state continues to guide the user. Otherwise open one controlled popup
 * window so multiple browser windows cannot splash duplicate prompts.
 *
 * @param {ResolvedTabTarget} target
 * @returns {Promise<void>}
 */
async function openRequestedAccessUi(target) {
  if (await isSidePanelOpenForWindow(target.windowId)) {
    return;
  }

  try {
    await openRequestedAccessPopupWindow(target);
  } catch (error) {
    console.warn('Could not open Browser Bridge popup window for access request.', error);
  }
}

/**
 * Open the popup UI in its own small extension window, scoped to the requested
 * tab. Reuse the same popup window while access remains pending so only one
 * visible prompt exists across browser windows.
 *
 * @param {ResolvedTabTarget} target
 * @returns {Promise<void>}
 */
async function openRequestedAccessPopupWindow(target) {
  const popupUrl = chrome.runtime.getURL(
    `${POPUP_PATH}?tabId=${encodeURIComponent(String(target.tabId))}&windowed=1`
  );
  const popupWidth = 420;
  const popupHeight = 320;
  const popupPlacement = await getRequestedAccessPopupPlacement(target.windowId, popupWidth);

  if (state.requestedAccessPopupWindowId != null) {
    try {
      const existingWindow = await chrome.windows.get(state.requestedAccessPopupWindowId, {
        populate: true,
      });
      const existingWindowId = typeof existingWindow.id === 'number' ? existingWindow.id : null;
      const popupTabId = existingWindow.tabs?.find((tab) => typeof tab.id === 'number')?.id ?? null;
      if (existingWindowId == null || popupTabId == null) {
        throw new Error('Requested access popup window is missing its tab.');
      }
      await chrome.tabs.update(popupTabId, { url: popupUrl });
      await chrome.windows.update(existingWindowId, {
        focused: true,
        ...(popupPlacement ?? {}),
      });
      return;
    } catch {
      clearRequestedAccessPopupWindow();
    }
  }

  let createData = /** @type {chrome.windows.CreateData} */ ({
    url: popupUrl,
    type: 'popup',
    focused: true,
    width: popupWidth,
    height: popupHeight,
  });

  if (popupPlacement) {
    createData = {
      ...createData,
      ...popupPlacement,
    };
  }

  const popupWindow = await chrome.windows.create(createData);
  state.requestedAccessPopupWindowId = typeof popupWindow?.id === 'number' ? popupWindow.id : null;
}

/**
 * @param {number} targetWindowId
 * @param {number} popupWidth
 * @returns {Promise<Pick<chrome.windows.UpdateInfo, 'left' | 'top'> | null>}
 */
async function getRequestedAccessPopupPlacement(targetWindowId, popupWidth) {
  try {
    const browserWindow = await chrome.windows.get(targetWindowId);
    if (
      typeof browserWindow.left === 'number' &&
      typeof browserWindow.top === 'number' &&
      typeof browserWindow.width === 'number'
    ) {
      return {
        left: browserWindow.left + Math.max(24, browserWindow.width - popupWidth - 40),
        top: browserWindow.top + 72,
      };
    }
  } catch {
    // Ignore window positioning failures and fall back to Chrome defaults.
  }

  return null;
}

/**
 * @param {number} windowId
 * @returns {Promise<boolean>}
 */
async function isSidePanelOpenForWindow(windowId) {
  for (const portState of state.uiPorts.values()) {
    if (portState.surface !== 'sidepanel') {
      continue;
    }
    const currentTab = portState.scopeTabId
      ? await getTabState(portState.scopeTabId)
      : await getCurrentTabState();
    if (currentTab?.windowId === windowId) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} portName
 * @returns {'popup' | 'sidepanel' | null}
 */
function getUiSurfaceFromPortName(portName) {
  if (portName === 'ui-popup') {
    return 'popup';
  }
  if (portName === 'ui-sidepanel') {
    return 'sidepanel';
  }
  if (portName === 'ui') {
    return 'popup';
  }
  return null;
}

/**
 * Resolve the scope context for a bridge request so the action log can show
 * where an operation happened even if that operation later revokes the session.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<{ tabId: number | null, url: string } | null>}
 */
async function getActionContext(request) {
  try {
    if (request.method === 'tabs.close') {
      const params = normalizeTabCloseParams(request.params);
      const tab = await chrome.tabs.get(params.tabId);
      return {
        tabId: params.tabId,
        url: tab.url ?? '',
      };
    }
    if (!bridgeMethodNeedsTab(request.method)) {
      return null;
    }
    const tab = await resolveRequestTarget(request, {
      requireScriptable: request.method !== 'tabs.create',
    });
    return {
      tabId: tab.tabId,
      url: tab.url,
    };
  } catch {
    return null;
  }
}

/**
 * Append one operator-facing action log entry and persist the bounded history.
 *
 * @param {BridgeRequest} request
 * @param {BridgeResponse} response
 * @param {{ tabId: number | null, url: string } | null} actionContext
 * @returns {Promise<void>}
 */
async function logBridgeAction(request, response, actionContext) {
  if (!shouldLogAction(request.method)) {
    return;
  }

  const diagnostics = getResponseDiagnostics(request.method, response);
  const summaryPayload = summarizeBridgeResponse(response, request.method);
  const summaryCost = estimateJsonPayloadCost(summaryPayload);

  await appendActionLogEntry({
    method: request.method,
    source: normalizeActionLogSource(request.meta?.source),
    tabId: actionContext?.tabId ?? null,
    url: actionContext?.url ?? '',
    ok: response.ok,
    summary: summarizeActionResult(response),
    responseBytes: diagnostics.responseBytes,
    approxTokens: diagnostics.textApproxTokens,
    imageApproxTokens: diagnostics.imageApproxTokens,
    costClass: diagnostics.costClass,
    imageBytes: diagnostics.imageBytes,
    summaryBytes: summaryCost.bytes,
    summaryTokens: summaryCost.approxTokens,
    summaryCostClass: summaryCost.costClass,
    debuggerBacked: diagnostics.debuggerBacked,
    overBudget: response.meta?.budget_truncated === true,
    hasScreenshot: diagnostics.hasScreenshot,
    nodeCount: diagnostics.nodeCount,
    continuationHint:
      typeof response.meta?.continuation_hint === 'string' ? response.meta.continuation_hint : null,
  });
  await emitUiState();
}

/**
 * Append one action log entry and persist the bounded history.
 *
 * @param {{
 *   method: string,
 *   source?: string,
 *   tabId?: number | null,
 *   url?: string,
 *   ok: boolean,
 *   summary: string,
 *   responseBytes?: number,
 *   approxTokens?: number,
 *   imageApproxTokens?: number,
 *   costClass?: 'cheap' | 'moderate' | 'heavy' | 'extreme',
 *   imageBytes?: number,
 *   summaryBytes?: number,
 *   summaryTokens?: number,
 *   summaryCostClass?: 'cheap' | 'moderate' | 'heavy' | 'extreme',
 *   debuggerBacked?: boolean,
 *   overBudget?: boolean,
 *   hasScreenshot?: boolean,
 *   nodeCount?: number | null,
 *   continuationHint?: string | null
 * }} entry
 * @returns {Promise<void>}
 */
async function appendActionLogEntry(entry) {
  state.actionLog.push({
    id: crypto.randomUUID(),
    at: Date.now(),
    method: entry.method,
    source: normalizeActionLogSource(entry.source),
    tabId: entry.tabId ?? null,
    url: entry.url ?? '',
    ok: entry.ok,
    summary: entry.summary,
    responseBytes: entry.responseBytes ?? 0,
    approxTokens: entry.approxTokens ?? 0,
    imageApproxTokens: entry.imageApproxTokens ?? 0,
    costClass: entry.costClass ?? 'cheap',
    imageBytes: entry.imageBytes ?? 0,
    summaryBytes: entry.summaryBytes ?? 0,
    summaryTokens: entry.summaryTokens ?? 0,
    summaryCostClass: entry.summaryCostClass ?? 'cheap',
    debuggerBacked: entry.debuggerBacked === true,
    overBudget: entry.overBudget === true,
    hasScreenshot: entry.hasScreenshot ?? false,
    nodeCount: entry.nodeCount ?? null,
    continuationHint: entry.continuationHint ?? null,
  });
  while (state.actionLog.length > MAX_ACTION_LOG_ENTRIES) {
    state.actionLog.shift();
  }

  await chrome.storage.session.set({
    [ACTION_LOG_STORAGE_KEY]: state.actionLog,
  });
}

/**
 * @param {unknown} source
 * @returns {string}
 */
function normalizeActionLogSource(source) {
  return source === 'cli' || source === 'mcp' ? source : '';
}

/**
 * @param {unknown} entry
 * @returns {ActionLogEntry | null}
 */
function normalizeActionLogEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const candidate = /** @type {Record<string, unknown>} */ (entry);
  if (typeof candidate.id !== 'string' || typeof candidate.method !== 'string') {
    return null;
  }

  return {
    id: candidate.id,
    at: Number(candidate.at) || 0,
    method: candidate.method,
    source: normalizeActionLogSource(candidate.source),
    tabId: typeof candidate.tabId === 'number' ? candidate.tabId : null,
    url: typeof candidate.url === 'string' ? candidate.url : '',
    ok: candidate.ok === true,
    summary: typeof candidate.summary === 'string' ? candidate.summary : '',
    responseBytes: Number(candidate.responseBytes) || 0,
    approxTokens: Number(candidate.approxTokens) || 0,
    imageApproxTokens: Number(candidate.imageApproxTokens) || 0,
    costClass:
      candidate.costClass === 'moderate' ||
      candidate.costClass === 'heavy' ||
      candidate.costClass === 'extreme'
        ? candidate.costClass
        : 'cheap',
    imageBytes: Number(candidate.imageBytes) || 0,
    summaryBytes: Number(candidate.summaryBytes) || 0,
    summaryTokens: Number(candidate.summaryTokens) || 0,
    summaryCostClass:
      candidate.summaryCostClass === 'moderate' ||
      candidate.summaryCostClass === 'heavy' ||
      candidate.summaryCostClass === 'extreme'
        ? candidate.summaryCostClass
        : 'cheap',
    debuggerBacked: candidate.debuggerBacked === true,
    overBudget: candidate.overBudget === true,
    hasScreenshot: candidate.hasScreenshot === true,
    nodeCount: typeof candidate.nodeCount === 'number' ? candidate.nodeCount : null,
    continuationHint:
      typeof candidate.continuationHint === 'string' ? candidate.continuationHint : null,
  };
}

/**
 * Map thrown runtime errors to structured bridge failures.
 *
 * @param {BridgeRequest} request
 * @param {unknown} error
 * @returns {BridgeResponse}
 */
function toFailureResponse(request, error) {
  const message = normalizeRuntimeErrorMessage(getErrorMessage(error));
  const knownErrorCodes = /** @type {string[]} */ (Object.values(ERROR_CODES));
  /** @type {ErrorCode} */
  const code = knownErrorCodes.includes(message)
    ? /** @type {ErrorCode} */ (message)
    : message === 'Element reference is stale.'
      ? ERROR_CODES.ELEMENT_STALE
      : ERROR_CODES.INTERNAL_ERROR;

  return createFailure(request.id, code, message, null, {
    method: request.method,
  });
}

/**
 * Apply token-budget truncation and attach cost/debugger metadata for the
 * response that will be sent back to the agent.
 *
 * @param {BridgeRequest} request
 * @param {BridgeResponse} response
 * @returns {BridgeResponse}
 */
function enrichBridgeResponse(request, response) {
  const budgetedResponse = enforceTokenBudget(request.method, response, request.meta?.token_budget);
  const responsePayload = budgetedResponse.ok
    ? budgetedResponse.result
    : { error: budgetedResponse.error };
  const diagnostics = getResponseDiagnostics(
    request.method,
    budgetedResponse,
    serializeJsonPayload(responsePayload)
  );
  return {
    ...budgetedResponse,
    meta: {
      ...budgetedResponse.meta,
      transport_bytes: diagnostics.responseBytes,
      transport_approx_tokens: diagnostics.approxTokens,
      transport_cost_class: diagnostics.costClass,
      text_bytes: diagnostics.textBytes,
      text_approx_tokens: diagnostics.textApproxTokens,
      text_cost_class: diagnostics.textCostClass,
      image_approx_tokens: diagnostics.imageApproxTokens,
      image_bytes: diagnostics.imageBytes,
      response_bytes: diagnostics.responseBytes,
      approx_tokens: diagnostics.approxTokens,
      cost_class: diagnostics.costClass,
      debugger_backed: diagnostics.debuggerBacked,
    },
  };
}

/**
 * Forward a response to the connected native host if it is present.
 *
 * @param {BridgeResponse} response
 * @returns {void}
 */
function reply(response) {
  state.nativePort?.postMessage(response);
}

/**
 * Broadcast a UI event to all connected extension surfaces.
 *
 * @param {Record<string, unknown>} message
 * @returns {void}
 */
function broadcastUi(message) {
  for (const port of state.uiPorts.keys()) {
    postToUiPort(port, message);
  }
}

/**
 * Post a message to a UI surface, pruning the port if Chrome has already
 * disconnected it.
 *
 * @param {chrome.runtime.Port} port
 * @param {Record<string, unknown>} message
 * @returns {boolean}
 */
function postToUiPort(port, message) {
  try {
    port.postMessage(message);
    return true;
  } catch {
    state.uiPorts.delete(port);
    return false;
  }
}

/**
 * Publish the current connection/session snapshot to the popup and side panel.
 *
 * @returns {Promise<void>}
 */
async function emitUiState() {
  await Promise.all([...state.uiPorts.keys()].map((port) => emitUiStateForPort(port)));
}

/**
 * Publish the current connection and tab snapshot to one UI surface.
 *
 * @param {chrome.runtime.Port} port
 * @returns {Promise<void>}
 */
async function emitUiStateForPort(port) {
  const portState = state.uiPorts.get(port);
  if (!portState) {
    return;
  }

  refreshSetupStatus();

  const currentTab = portState.scopeTabId
    ? await getTabState(portState.scopeTabId)
    : await getCurrentTabState();
  const scopedTabId = currentTab?.tabId ?? portState.scopeTabId ?? null;

  postToUiPort(port, {
    type: 'state.sync',
    state: {
      nativeConnected: Boolean(state.nativePort),
      currentTab,
      setupStatus: state.setupStatus,
      setupStatusPending: state.setupStatusPending,
      setupStatusError: state.setupStatusError,
      setupInstallPendingKey: state.setupInstallPendingKey,
      setupInstallError: state.setupInstallError,
      actionLog: [...state.actionLog]
        .filter((entry) => scopedTabId == null || entry.tabId === scopedTabId)
        .reverse(),
    },
  });
}

/**
 * @param {unknown} message
 * @returns {boolean}
 */
function handleHostStatusMessage(message) {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = /** @type {Record<string, unknown>} */ (message);
  if (candidate.type === 'host.bridge_response') {
    const response =
      candidate.response && typeof candidate.response === 'object'
        ? /** @type {BridgeResponse} */ (candidate.response)
        : null;
    if (response?.id === state.setupInstallPendingRequestId) {
      const action = state.setupInstallPendingAction;
      state.setupInstallPendingRequestId = null;
      state.setupInstallPendingAction = null;
      if (response.ok) {
        state.setupInstallError = null;
        if (action) {
          void appendActionLogEntry({
            method: getSetupActionMethodLabel(action),
            ok: true,
            summary: getSetupActionSuccessSummary(action),
          }).catch(reportAsyncError);
        }
        refreshSetupStatus(true);
      } else {
        state.setupInstallError = response.error.message;
        if (action) {
          void appendActionLogEntry({
            method: getSetupActionMethodLabel(action),
            ok: false,
            summary: getSetupActionErrorSummary(action, response.error.message),
          }).catch(reportAsyncError);
        }
        state.setupInstallPendingKey = null;
      }
      void emitUiState().catch(reportAsyncError);
      return true;
    }
    if (response?.id === state.setupStatusPendingRequestId) {
      clearSetupStatusTimer();
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
      void emitUiState().catch(reportAsyncError);
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
        void appendActionLogEntry({
          method: getSetupActionMethodLabel(action),
          ok: false,
          summary: getSetupActionErrorSummary(action, state.setupInstallError),
        }).catch(reportAsyncError);
      }
      void emitUiState().catch(reportAsyncError);
      return true;
    }
    if (candidate.requestId === state.setupStatusPendingRequestId) {
      clearSetupStatusTimer();
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
      void emitUiState().catch(reportAsyncError);
    }
    return true;
  }

  if (candidate.type === 'host.setup_status.response') {
    if (candidate.requestId === state.setupStatusPendingRequestId) {
      clearSetupStatusTimer();
      state.setupStatus = isSetupStatus(candidate.status) ? candidate.status : null;
      state.setupStatusPending = false;
      state.setupStatusPendingRequestId = null;
      state.setupInstallPendingAction = null;
      state.setupInstallPendingKey = null;
      state.setupStatusUpdatedAt = Date.now();
      state.setupStatusError = null;
      void emitUiState().catch(reportAsyncError);
    }
    return true;
  }

  if (candidate.type === 'host.setup_status.error') {
    if (candidate.requestId === state.setupStatusPendingRequestId) {
      clearSetupStatusTimer();
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
      void emitUiState().catch(reportAsyncError);
    }
    return true;
  }

  return false;
}

/**
 * @param {boolean} [force=false]
 * @returns {void}
 */
function refreshSetupStatus(force = false) {
  if (!state.nativePort) {
    clearSetupStatus();
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
  clearSetupStatusTimer();
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
    void emitUiState().catch(reportAsyncError);
  }, SETUP_STATUS_TIMEOUT_MS);
}

/**
 * @param {string | null} [errorMessage=null]
 * @returns {void}
 */
function clearSetupStatus(errorMessage = null) {
  clearSetupStatusTimer();
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
 * @returns {void}
 */
function clearSetupStatusTimer() {
  if (!state.setupStatusTimeoutId) {
    return;
  }
  clearTimeout(state.setupStatusTimeoutId);
  state.setupStatusTimeoutId = null;
}

/**
 * @param {unknown} value
 * @returns {value is SetupStatus}
 */
function isSetupStatus(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = /** @type {Record<string, unknown>} */ (value);
  return Array.isArray(candidate.mcpClients) && Array.isArray(candidate.skillTargets);
}

/**
 * Handle commands coming from the popup or side panel.
 *
 * @param {chrome.runtime.Port} port
 * @param {Record<string, any>} message
 * @returns {Promise<void>}
 */
async function handleUiMessage(port, message) {
  if (message?.type === 'state.request') {
    const scopeTabId = Number(message.scopeTabId);
    const currentPortState = state.uiPorts.get(port);
    if (!currentPortState) {
      return;
    }
    state.uiPorts.set(port, {
      surface: currentPortState.surface,
      scopeTabId: Number.isFinite(scopeTabId) && scopeTabId > 0 ? scopeTabId : null,
    });
    refreshSetupStatus();
    await emitUiStateForPort(port);
    return;
  }

  if (message?.type === 'setup.status.refresh') {
    refreshSetupStatus(true);
    await emitUiStateForPort(port);
    return;
  }

  if (message?.type === 'scope.set_enabled') {
    const requestedTabId = Number(message.tabId);
    try {
      // ── DEBUG: simulate slow/error toggles. Set to "delay", "error", or "" ──
      const _TOGGLE_SIM = /** @type {'delay' | 'error' | ''} */ ('');
      if (_TOGGLE_SIM === 'delay') {
        await new Promise((r) => setTimeout(r, 6000));
      } else if (_TOGGLE_SIM === 'error') {
        if (Math.random() > 0.3) {
          throw new Error('Something went wrong.');
        }
      }
      // ── END DEBUG ──
      if (Number.isFinite(requestedTabId) && requestedTabId > 0) {
        const tabState = await getTabState(requestedTabId);
        if (!tabState) {
          throw new Error(ERROR_CODES.TAB_MISMATCH);
        }
        await setWindowEnabled(tabState.windowId, tabState.title, Boolean(message.enabled));
      } else {
        await setCurrentWindowEnabled(Boolean(message.enabled));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      try {
        port.postMessage({ type: 'toggle.error', error: errorMessage });
      } catch {
        /* port may have disconnected */
      }
      throw error;
    }
    return;
  }

  if (message?.type === 'setup.install') {
    await handleSetupInstallAction(message);
  }
}

/**
 * @param {Record<string, unknown>} message
 * @returns {Promise<void>}
 */
async function handleSetupInstallAction(message) {
  if (!state.nativePort) {
    state.setupInstallError = 'Native host is not connected.';
    await appendActionLogEntry({
      method: 'Host setup',
      ok: false,
      summary: 'Install failed: Native host is not connected.',
    });
    await emitUiState();
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
  await appendActionLogEntry({
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
  await emitUiState();
}

/**
 * @param {Record<string, unknown>} message
 * @returns {SetupInstallAction}
 */
function normalizeSetupInstallAction(message) {
  const action = message.action === 'uninstall' ? 'uninstall' : 'install';
  const kind = message.kind === 'skill' ? 'skill' : message.kind === 'mcp' ? 'mcp' : null;
  const target = typeof message.target === 'string' ? message.target.trim().toLowerCase() : '';
  if (!kind || !target) {
    throw new Error(ERROR_CODES.INVALID_REQUEST);
  }
  return { action, kind, target };
}

/**
 * @param {SetupInstallAction} action
 * @returns {string}
 */
function getSetupInstallKey(action) {
  return `${action.kind}:${action.target}`;
}

/**
 * @param {SetupInstallAction} action
 * @returns {string}
 */
function getSetupActionMethodLabel(action) {
  return action.kind === 'mcp' ? 'Host setup: MCP' : 'Host setup: Skills';
}

/**
 * @param {SetupInstallAction} action
 * @returns {string}
 */
function getSetupActionTargetLabel(action) {
  return action.target;
}

/**
 * @param {SetupInstallAction} action
 * @returns {string}
 */
function getSetupActionStartSummary(action) {
  const verb = action.action === 'uninstall' ? 'Removing' : 'Installing';
  return `${verb} ${action.kind.toUpperCase()} for ${getSetupActionTargetLabel(action)}…`;
}

/**
 * @param {SetupInstallAction} action
 * @returns {string}
 */
function getSetupActionSuccessSummary(action) {
  const verb = action.action === 'uninstall' ? 'Removed' : 'Installed';
  return `${verb} ${action.kind.toUpperCase()} for ${getSetupActionTargetLabel(action)}.`;
}

/**
 * @param {SetupInstallAction} action
 * @param {string} message
 * @returns {string}
 */
function getSetupActionErrorSummary(action, message) {
  const verb = action.action === 'uninstall' ? 'Removal' : 'Install';
  return `${verb} failed for ${action.kind.toUpperCase()} on ${getSetupActionTargetLabel(action)}: ${message}`;
}

/**
 * Configure and open the side panel for a single tab so the panel is attached
 * to the current tab instead of acting like a window-global surface.
 *
 * @param {number} tabId
 * @param {number} windowId
 * @returns {Promise<void>}
 */
async function openSidePanelForTab(tabId, windowId) {
  await chrome.sidePanel.setOptions({
    tabId,
    path: `${SIDEPANEL_PATH}?tabId=${encodeURIComponent(String(tabId))}`,
    enabled: true,
  });
  await chrome.sidePanel.open({
    tabId,
    windowId,
  });
}

/**
 * Keep fire-and-forget async listener failures out of the browser's uncaught
 * promise surface so extension errors stay actionable and structured.
 *
 * @param {unknown} error
 * @returns {void}
 */
function reportAsyncError(error) {
  if (normalizeRuntimeErrorMessage(getErrorMessage(error)) === ERROR_CODES.TAB_MISMATCH) {
    return;
  }
  console.error(error);
}

/**
 * Expose the live module state to tests that need to seed or inspect routing,
 * access-request, or instrumentation state directly.
 *
 * @returns {ExtensionState}
 */
function getStateForTest() {
  return state;
}

export {
  clearEnabledWindowIfGone,
  clearTabBridgeState,
  clearWindowBridgeState,
  enrichBridgeResponse,
  getContentScriptTimeout,
  getCurrentTabState,
  getRequestedAccessPopupPlacement,
  getTabState,
  getUiSurfaceFromPortName,
  getStateForTest,
  isAccessRequestedTab,
  isAccessRequestedWindow,
  isTabEnabled,
  isWindowEnabled,
  normalizeActionLogEntry,
  normalizeActionLogSource,
  normalizeSetupInstallAction,
  isNumber,
  isRecoverableInstrumentationError,
  isRestrictedScriptingError,
  clearRequestedAccessPopupWindow,
  clearRequestedAccessWindow,
  getSetupInstallKey,
  getSetupActionMethodLabel,
  getSetupActionTargetLabel,
  getSetupActionStartSummary,
  getSetupActionSuccessSummary,
  getSetupActionErrorSummary,
  reportAsyncError,
  rollbackAllPatchesForTab,
  scheduleNativeReconnect,
  toFailureResponse,
  updateActionIndicatorForTab,
};
