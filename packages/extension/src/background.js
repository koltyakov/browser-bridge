// @ts-check

import {
  BridgeError,
  ERROR_CODES,
  createFailure,
  createRuntimeContext,
  createSuccess,
  normalizeNetworkInterceptAddParams,
  normalizeTabCloseParams,
} from '../../protocol/src/index.js';
import {
  getErrorMessage,
  normalizeRuntimeErrorMessage,
  shouldLogAction,
} from './background-helpers.js';
import { isRestrictedAutomationUrl } from './background-routing.js';
import { getAccessStatus } from './background-access.js';
import {
  createNativeConnectionController,
  sendAccessUpdate as sendAccessUpdateNative,
  sendActivityUpdate as sendActivityUpdateNative,
} from './background-native.js';
import {
  createSetupController,
  getSetupActionErrorSummary,
  getSetupActionMethodLabel,
  getSetupActionStartSummary,
  getSetupActionSuccessSummary,
  getSetupActionTargetLabel,
  getSetupInstallKey,
  normalizeSetupInstallAction,
} from './background-setup.js';
import {
  broadcastUi as broadcastUiUi,
  emitUiState as emitUiStateUi,
  emitUiStateForPort as emitUiStateForPortUi,
  getRequestedAccessPopupPlacement as getRequestedAccessPopupPlacementUi,
  getUiSurfaceFromPortName as getUiSurfaceFromPortNameUi,
  handleUiMessage as handleUiMessageUi,
  openRequestedAccessUi as openRequestedAccessUiUi,
  openSidePanelForTab as openSidePanelForTabUi,
} from './background-ui.js';
import {
  isTabEnabled as isTabEnabledBadge,
  isAccessRequestedTab as isAccessRequestedTabBadge,
  refreshActionIndicators as refreshActionIndicatorsBadge,
  syncGlobalBadgeToActiveTab as syncGlobalBadgeToActiveTabBadge,
  updateActionIndicatorForTab as updateActionIndicatorForTabBadge,
} from './background-badge.js';
import { createRuntimeMessageListener } from './background-runtime.js';
import { getVersionNegotiationPayload } from './background-versioning.js';
import { handleNavigationRequest as executeNavigationRequest } from './background-navigation.js';
import { handlePageEvaluate as executePageEvaluate } from './background-evaluate.js';
import {
  handleCreateTab as executeCreateTab,
  handleListTabs as executeListTabs,
} from './background-tabs.js';
import { TabDebuggerCoordinator } from './debugger-coordinator.js';
import { NavigationWaitCoordinator } from './navigation-wait.js';
import {
  createExtensionState,
  setExtensionState,
  CONTENT_SCRIPT_TIMEOUT_MS,
  SIDEPANEL_PATH,
  DEBUGGER_PROTOCOL_VERSION,
  ACCESS_DENIED_WINDOW_OFF,
  ACCESS_DENIED_TAB_CLOSE,
  KEEPALIVE_ALARM_NAME,
  isNumber,
  normalizeActionLogSource,
  normalizeActionLogEntry,
  isWindowEnabled,
  isAccessRequestedWindow,
  clearRequestedAccessWindow,
  clearRequestedAccessPopupWindow,
  toFailureResponse,
  isWindowAccessDeniedResponse,
  reportAsyncError,
  getStateForTest,
} from './background-state.js';
import {
  disableNetworkInterceptor,
  ensureNetworkInterceptor,
  readNetworkBuffer,
} from './background-network.js';
import { createFetchInterceptor } from './background-fetch-intercept.js';
import { createCdpNetworkCapture } from './background-cdp-network.js';
import {
  createContentScriptBridge,
  isRestrictedScriptingError,
} from './background-content-script.js';
import { createWindowSessionController } from './background-window-session.js';
import {
  readConsoleBuffer,
  disableConsoleInterceptor,
  isRecoverableInstrumentationError,
  primeTabConsoleCapture,
  primeWindowConsoleCapture,
} from './background-console.js';
import { handleScreenshot } from './background-screenshots.js';
import {
  createTabCleanupController,
  createTabMoveCleanupController,
} from './background-tab-cleanup.js';
import { createActionLogController, enrichBridgeResponse } from './background-action-log.js';
import { createAccessRequestController } from './background-access-request.js';
import { createPageRequestController } from './background-page.js';
import { createBackgroundInputController } from './background-input.js';
import {
  getContentScriptTimeout,
  handleTabBoundRequest as executeTabBoundRequest,
  isTabBoundMethod,
} from './background-tab-bound.js';

/** @typedef {import('./background-state.js').EnabledWindowState} EnabledWindowState */
/** @typedef {import('./background-state.js').ResolvedTabTarget} ResolvedTabTarget */
/** @typedef {import('./background-state.js').ActionLogEntry} ActionLogEntry */
/** @typedef {import('./background-state.js').CurrentTabState} CurrentTabState */
/** @typedef {import('./background-state.js').UiPortState} UiPortState */
/** @typedef {import('./background-state.js').ExtensionState} ExtensionState */
/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */
/** @typedef {import('../../protocol/src/types.js').ErrorCode} ErrorCode */
/** @typedef {import('../../protocol/src/types.js').SetupStatus} SetupStatus */

/** @type {typeof globalThis.chrome} */
const chrome = globalThis.chrome;

/** @type {ExtensionState} */
const state = createExtensionState();
setExtensionState(state);

const tabDebugger = new TabDebuggerCoordinator({
  attach: (target, protocolVersion) => chrome.debugger.attach(target, protocolVersion),
  detach: (target) => chrome.debugger.detach(target),
  initialize: async (target) => {
    await chrome.debugger.sendCommand(target, 'Page.enable', {});
  },
  protocolVersion: DEBUGGER_PROTOCOL_VERSION,
});

const cdpNetworkCapture = createCdpNetworkCapture({
  acquireDebugger: (tabId) => tabDebugger.acquire(tabId),
  releaseDebugger: (tabId) => tabDebugger.release(tabId),
  assertDebuggerAvailable: (tabId) => tabDebugger.assertCanStart(tabId),
  sendCommand: (target, method, params) =>
    /** @type {Promise<unknown>} */ (chrome.debugger.sendCommand(target, method, params)),
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (typeof source.tabId === 'number') {
    tabDebugger.handleDetach(source.tabId, reason);
    void cdpNetworkCapture.handleDetach(source.tabId);
    // Drop interception rules for the dead session so list reflects reality
    // (covers infobar cancel, tab close, and external debugger takeover).
    fetchInterceptor.handleDetach(source.tabId);
  }
});

// CDP Fetch-domain request interception (declarative rule engine)
/** @type {Map<number, (method: string, params: unknown) => void>} */
const fetchEventFilters = new Map();
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId === 'number') {
    tabDebugger.handleEvent(source.tabId, method, params);
    cdpNetworkCapture.handleEvent(source.tabId, method, params);
    fetchEventFilters.get(source.tabId)?.(method, params);
  }
});
const fetchInterceptor = createFetchInterceptor({
  acquireDebugger: (tabId, init) => tabDebugger.acquire(tabId, init),
  releaseDebugger: (tabId) => tabDebugger.release(tabId),
  assertDebuggerAvailable: (tabId) => tabDebugger.assertCanStart(tabId),
  sendCommand: (target, method, params) =>
    /** @type {Promise<unknown>} */ (
      chrome.debugger.sendCommand(
        target,
        method,
        /** @type {{ [key: string]: unknown }} */ (params)
      )
    ),
  addEventFilter: (tabId, handler) => fetchEventFilters.set(tabId, handler),
  removeEventFilter: (tabId) => fetchEventFilters.delete(tabId),
});

const {
  sendTabMessage,
  injectContentScriptsForWindow,
  ensureContentScript,
  installNavigationSignals,
  uninstallNavigationSignals,
} = createContentScriptBridge(chrome, {
  contentScriptTimeoutMs: CONTENT_SCRIPT_TIMEOUT_MS,
  isRestrictedAutomationUrl,
});

const navigationWaits = new NavigationWaitCoordinator({
  getTab: (tabId) => chrome.tabs.get(tabId),
  hasWindowAccess: (windowId) => state.enabledWindow?.windowId === windowId,
  installSignals: installNavigationSignals,
  uninstallSignals: uninstallNavigationSignals,
});

const { clearTabBridgeState, clearWindowBridgeState, rollbackAllPatchesForTab } =
  createTabCleanupController(chrome, {
    ensureContentScript,
    sendTabMessage,
    disableConsoleInterceptor,
    disableNetworkInterceptor,
    beginDebuggerCleanup: (tabId) => tabDebugger.beginCleanup(tabId),
    commitDebuggerCleanup: (tabId) => tabDebugger.commitCleanup(tabId),
    clearFetchInterception: (tabId) => fetchInterceptor.clearAllRules(tabId),
    discardFetchInterception: (tabId) => fetchInterceptor.handleDetach(tabId),
    stopCdpNetworkCapture: (tabId) => cdpNetworkCapture.stop(tabId),
    discardCdpNetworkCapture: (tabId) => cdpNetworkCapture.handleDetach(tabId),
    cancelNavigationWaitsForWindow: (windowId) => navigationWaits.cancelWindow(windowId),
    isRecoverableInstrumentationError,
    isRestrictedAutomationUrl,
  });

const tabMoveCleanup = createTabMoveCleanupController({
  getEnabledWindowId: () => state.enabledWindow?.windowId ?? null,
  isTabOutsideEnabledWindow: async (tabId) => {
    const enabledWindowId = state.enabledWindow?.windowId ?? null;
    if (enabledWindowId === null) return true;
    try {
      return (await chrome.tabs.get(tabId)).windowId !== enabledWindowId;
    } catch {
      return true;
    }
  },
  cancelNavigationWaitsForMove: (tabId) =>
    navigationWaits.cancelTab(
      tabId,
      new BridgeError(
        ERROR_CODES.ACCESS_DENIED,
        'Tab moved outside the enabled window while waiting for URL'
      )
    ),
  cancelNavigationWaitsForRemoval: (tabId) => navigationWaits.handleTabRemoved(tabId),
  clearDialogState: (tabId) => tabDebugger.clearDialogState(tabId),
  disableTabInstrumentation: async (tabId) => {
    await Promise.allSettled([
      disableConsoleInterceptor(tabId, chrome),
      disableNetworkInterceptor(tabId, chrome),
    ]);
  },
  resumeTabInstrumentation: async (tabId) => {
    await primeTabConsoleCapture(tabId, chrome, true);
  },
  clearTabBridgeState,
  clearRemovedTabState: async (tabId) => {
    const endCleanup = await tabDebugger.beginCleanup(tabId);
    try {
      await tabDebugger.commitCleanup(tabId);
      try {
        await fetchInterceptor.clearAllRules(tabId);
        await cdpNetworkCapture.stop(tabId).catch(() => {});
      } finally {
        await cdpNetworkCapture.handleDetach(tabId);
      }
    } finally {
      endCleanup();
    }
  },
});

const {
  restoreEnabledWindow,
  primeEnabledWindowInstrumentation,
  clearEnabledWindowIfGone,
  getCurrentTabState,
  getTabState,
  setCurrentWindowEnabled,
  setWindowEnabled,
  handleTabUpdated,
  handleTabRemoved,
} = createWindowSessionController(state, chrome, {
  sendAccessUpdate,
  injectContentScriptsForWindow,
  primeWindowConsoleCapture,
  primeTabConsoleCapture,
  clearWindowBridgeState,
  cancelNavigationWaitsForWindow: (windowId) => navigationWaits.cancelWindow(windowId),
  appendActionLogEntry: (entry) => appendActionLogEntry(entry),
  refreshActionIndicators,
  updateActionIndicatorForTab,
  emitUiState,
  isRestrictedAutomationUrl,
});

const {
  resolveRequestTarget,
  waitForTabComplete,
  handlePageGetConsole,
  handlePageGetState,
  handlePageDialog,
  handleAccessibilityTree,
  handleGetNetwork,
  handleViewportResize,
  handlePerformanceMetrics,
  handleWaitForLoadState,
  handleCdpRequest,
} = createPageRequestController(state, chrome, {
  clearEnabledWindowIfGone,
  primeTabConsoleCapture: (tabId) => primeTabConsoleCapture(tabId, chrome),
  readConsoleBuffer: (tabId, clear) => readConsoleBuffer(tabId, clear, chrome),
  ensureNetworkInterceptor: (tabId) => ensureNetworkInterceptor(tabId, chrome),
  readNetworkBuffer: (tabId, clear) => readNetworkBuffer(tabId, clear, chrome),
  startCdpNetworkCapture: (tabId) => cdpNetworkCapture.start(tabId),
  clearCdpNetworkCapture: (tabId) => cdpNetworkCapture.clear(tabId),
  readCdpNetworkCapture: (tabId, clear) => cdpNetworkCapture.read(tabId, clear),
  stopCdpNetworkCapture: (tabId) => cdpNetworkCapture.stop(tabId),
  runWithDebugger: (tabId, operation, options) => tabDebugger.run(tabId, operation, options),
  runForDialog: (tabId, operation, options) => tabDebugger.runForDialog(tabId, operation, options),
  sendCommand: (target, method, params) =>
    /** @type {Promise<unknown>} */ (
      chrome.debugger.sendCommand(
        target,
        method,
        /** @type {{ [key: string]: unknown }} */ (params)
      )
    ),
  ensureContentScript,
  sendTabMessage: (tabId, message, timeoutMs) => sendTabMessage(tabId, message, timeoutMs),
  contentScriptTimeoutMs: CONTENT_SCRIPT_TIMEOUT_MS,
  waitForDialog: (tabId, timeoutMs) => tabDebugger.waitForDialog(tabId, timeoutMs),
  getDialogObservation: (tabId) => tabDebugger.getDialogObservation(tabId),
  getDialogStatus: (tabId) => tabDebugger.getDialogStatus(tabId),
  clearDialog: (tabId, dialogId) => tabDebugger.clearDialog(tabId, dialogId),
  waitForUrl: (tabId, windowId, params) => navigationWaits.wait(tabId, windowId, params),
});

const { appendActionLogEntry, getActionContext, logBridgeAction, restoreActionLog } =
  createActionLogController(state, chrome, {
    emitUiState,
    getCurrentTabState,
    resolveRequestTarget,
  });

const { handleNativeInput } = createBackgroundInputController({
  contentScriptTimeoutMs: CONTENT_SCRIPT_TIMEOUT_MS,
  runWithDebugger: (tabId, operation, options) => tabDebugger.run(tabId, operation, options),
  sendCommand: (target, method, params) =>
    /** @type {Promise<unknown>} */ (chrome.debugger.sendCommand(target, method, params)),
  sendTabMessage: (tabId, message, timeoutMs = CONTENT_SCRIPT_TIMEOUT_MS) =>
    sendTabMessage(tabId, message, timeoutMs),
});

const { clearSetupStatus, handleHostStatusMessage, handleSetupInstallAction, refreshSetupStatus } =
  createSetupController(state, {
    appendActionLogEntry,
    emitUiState,
  });

const { handleAccessRequest, requestEnableFromAgentSide } = createAccessRequestController(state, {
  getTab: (tabId) => chrome.tabs.get(tabId),
  queryTabs: (queryInfo) => chrome.tabs.query(queryInfo),
  getLastFocusedWindow: () => chrome.windows.getLastFocused(),
  getAccessStatus: () =>
    getAccessStatus({
      chrome,
      state,
      clearEnabledWindowIfGone,
      isRestrictedAutomationUrl,
    }),
  appendActionLogEntry,
  refreshActionIndicators,
  emitUiState,
  openRequestedAccessUi,
});

const { connectNative, scheduleNativeReconnect } = createNativeConnectionController(state, chrome, {
  appendActionLogEntry,
  broadcastUi,
  clearSetupStatus,
  emitUiState,
  handleBridgeRequest,
  handleHostStatusMessage,
  refreshActionIndicators,
  refreshSetupStatus,
  reply,
});

/** @type {Parameters<typeof executeTabBoundRequest>[1]} */
const tabBoundRequestDependencies = {
  contentScriptTimeoutMs: CONTENT_SCRIPT_TIMEOUT_MS,
  ensureContentScript,
  handleScreenshot: (target, method, params) =>
    handleScreenshot(target, method, params, {
      chrome,
      contentScriptTimeoutMs: CONTENT_SCRIPT_TIMEOUT_MS,
      ensureContentScript,
      sendTabMessage,
      tabDebugger,
    }),
  handleNativeInput,
  resolveRequestTarget,
  sendTabMessage: (tabId, message, timeoutMs = CONTENT_SCRIPT_TIMEOUT_MS) =>
    sendTabMessage(tabId, message, timeoutMs),
  toFailureResponse,
};

void initializeState().catch(reportAsyncError);
connectNative();

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(reportAsyncError);
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
  navigationWaits.handleTabUpdated(tabId, changeInfo, tab);
  void handleTabUpdated(tabId, changeInfo, tab).catch(reportAsyncError);
});

chrome.tabs.onDetached?.addListener((tabId, detachInfo) => {
  tabMoveCleanup.handleDetached(tabId, detachInfo);
});

chrome.tabs.onAttached?.addListener((tabId, attachInfo) => {
  navigationWaits.handleTabMoved(tabId, attachInfo.newWindowId);
  void tabMoveCleanup.handleAttached(tabId, attachInfo).catch(reportAsyncError);
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  void tabMoveCleanup.handleRemoved(tabId).catch(reportAsyncError);
  void handleTabRemoved(tabId, removeInfo).catch(reportAsyncError);
});

chrome.windows.onRemoved.addListener((windowId) => {
  clearRequestedAccessPopupWindow(windowId);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM_NAME) {
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

chrome.runtime.onMessage.addListener(
  createRuntimeMessageListener({
    openSidePanelForTab,
    onNavigationSignal: (tabId, kind, channel) =>
      navigationWaits.handleSpaSignal(tabId, kind, channel),
  })
);

/**
 * Notify the daemon that this browser/profile was recently active so untargeted
 * access prompts can be routed to one browser instead of broadcasting.
 *
 * @param {chrome.runtime.Port | null} [port=state.nativePort]
 * @returns {void}
 */
function sendActivityUpdate(port = state.nativePort) {
  sendActivityUpdateNative(port);
}

/**
 * Notify the daemon whether this extension currently has access enabled.
 *
 * @param {boolean} enabled
 * @returns {void}
 */
function sendAccessUpdate(enabled) {
  sendAccessUpdateNative(enabled, state.nativePort);
}

/**
 * Restore persisted window access state when the service worker starts so the
 * current browser-run grant survives worker restarts.
 *
 * @returns {Promise<void>}
 */
async function initializeState() {
  await restoreEnabledWindow();
  if (state.enabledWindow && state.nativePort) {
    sendAccessUpdate(true);
  }
  await restoreActionLog();
  await primeEnabledWindowInstrumentation();
  await refreshActionIndicators();
}

/**
 * Route a validated bridge request to the extension capability that should
 * satisfy it.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<void>}
 */
async function handleBridgeRequest(request) {
  let actionContext = null;
  if (shouldLogAction(request.method)) {
    try {
      actionContext = await getActionContext(request);
    } catch (error) {
      reportAsyncError(error);
    }
  }
  /** @type {BridgeResponse} */
  let response;

  try {
    response = await dispatchBridgeRequest(request);
  } catch (error) {
    response = toFailureResponse(request, error);
  }

  if (isWindowAccessDeniedResponse(response)) {
    try {
      response = (await requestEnableFromAgentSide(request)) ?? response;
    } catch (error) {
      reportAsyncError(error);
    }
  }
  response = enrichBridgeResponse(request, response);
  if (request.method === 'sensitive.read') {
    void logBridgeAction(request, response, actionContext).catch(reportAsyncError);
    reply(response);
    return;
  }
  reply(response);
  try {
    await logBridgeAction(request, response, actionContext);
  } catch (error) {
    reportAsyncError(error);
  }
}

/**
 * Resolve one bridge request into a structured response.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function dispatchBridgeRequest(request) {
  switch (request.method) {
    case 'health.ping': {
      const debuggerDiagnostics = tabDebugger.getDiagnostics();
      const cdpCaptureDiagnostics = cdpNetworkCapture.getDiagnostics();
      const interceptionDiagnostics = fetchInterceptor.getDiagnostics();
      return createSuccess(
        request.id,
        {
          extension: 'ok',
          extensionVersion: chrome.runtime.getManifest().version,
          access: await getAccessStatus({
            chrome,
            state,
            clearEnabledWindowIfGone,
            isRestrictedAutomationUrl,
          }),
          debugger: debuggerDiagnostics,
          capture: {
            state:
              cdpCaptureDiagnostics.status === 'stop_failed'
                ? 'stop_failed'
                : cdpCaptureDiagnostics.status === 'armed'
                  ? 'armed'
                  : interceptionDiagnostics.status === 'active'
                    ? 'active'
                    : 'stopped',
            activeTabCount: cdpCaptureDiagnostics.activeTabCount,
            ownershipCount: cdpCaptureDiagnostics.ownershipCount,
            inflightCount: cdpCaptureDiagnostics.inflightCount,
            interceptionActiveTabCount: interceptionDiagnostics.activeTabCount,
            interceptionRuleCount: interceptionDiagnostics.ruleCount,
          },
          ...getVersionNegotiationPayload(request.meta?.protocol_version),
        },
        { method: request.method }
      );
    }
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
    case 'tabs.activate':
      return handleActivateTab(request);
    case 'page.evaluate':
      return handlePageEvaluate(request);
    case 'page.get_console':
      return handlePageGetConsole(request);
    case 'page.get_state':
      return handlePageGetState(request);
    case 'page.handle_dialog':
      return handlePageDialog(request);
    case 'page.wait_for_load_state':
      return handleWaitForLoadState(request);
    case 'dom.get_accessibility_tree':
      return handleAccessibilityTree(request);
    case 'page.get_network':
      return handleGetNetwork(request);
    case 'network.intercept.add':
    case 'network.intercept.remove':
    case 'network.intercept.list':
    case 'network.intercept.clear':
      return handleFetchInterceptRequest(request);
    case 'viewport.resize':
      return handleViewportResize(request);
    case 'performance.get_metrics':
      return handlePerformanceMetrics(request);
    case 'navigation.navigate':
    case 'navigation.reload':
    case 'navigation.go_back':
    case 'navigation.go_forward':
      return handleNavigationRequest(request);
    case 'cdp.get_document':
    case 'cdp.get_dom_snapshot':
    case 'cdp.get_box_model':
    case 'cdp.get_computed_styles_for_node':
    case 'cdp.dispatch_key_event':
      return handleCdpRequest(request);
    default:
      if (isTabBoundMethod(request.method)) {
        return executeTabBoundRequest(request, tabBoundRequestDependencies);
      }
      return createFailure(
        request.id,
        ERROR_CODES.INVALID_REQUEST,
        `Unhandled method ${request.method}`
      );
  }
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
    sendCommand: (target, method, params) =>
      /** @type {Promise<unknown>} */ (chrome.debugger.sendCommand(target, method, params)),
  });
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
 * Dispatch network.intercept.* methods to the fetch interceptor.
 * Resolves the target tab from the request, then delegates to the rule engine.
 */
/** @param {BridgeRequest} request */
async function handleFetchInterceptRequest(request) {
  const target = await resolveRequestTarget(request);
  const params = request.params ?? {};
  const method = request.method;

  if (method === 'network.intercept.add') {
    const ruleParams = normalizeNetworkInterceptAddParams(params);
    if (state.enabledWindow?.windowId !== target.windowId) {
      return createFailure(
        request.id,
        ERROR_CODES.ACCESS_DENIED,
        'Enabled window changed before the interception rule could be added.',
        null,
        { method }
      );
    }
    const rule = await fetchInterceptor.addRule(target.tabId, ruleParams);
    return createSuccess(request.id, rule, { method });
  }

  if (method === 'network.intercept.remove') {
    const removed = await fetchInterceptor.removeRule(target.tabId, String(params.ruleId ?? ''));
    return createSuccess(request.id, { removed }, { method });
  }

  if (method === 'network.intercept.list') {
    return createSuccess(
      request.id,
      { rules: fetchInterceptor.listRules(target.tabId) },
      { method }
    );
  }

  if (method === 'network.intercept.clear') {
    const count = await fetchInterceptor.clearAllRules(target.tabId);
    return createSuccess(request.id, { cleared: count }, { method });
  }

  return createFailure(
    request.id,
    ERROR_CODES.INVALID_REQUEST,
    `Unknown intercept method: ${method}`,
    null,
    { method }
  );
}

/**
 * Bring a tab to the foreground (make it the active tab in its window).
 * Useful for agents that need to focus a specific tab before performing
 * debugger-backed operations or ensuring the tab is visible.
 */
/** @param {BridgeRequest} request */
async function handleActivateTab(request) {
  const tabId = request.params?.tabId;
  if (typeof tabId !== 'number' || !Number.isFinite(tabId)) {
    return createFailure(request.id, ERROR_CODES.INVALID_REQUEST, 'tabId is required.', null, {
      method: request.method,
    });
  }
  if (!state.enabledWindow) {
    return createFailure(request.id, ERROR_CODES.ACCESS_DENIED, ACCESS_DENIED_WINDOW_OFF, null, {
      method: request.method,
    });
  }
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return createFailure(request.id, ERROR_CODES.TAB_MISMATCH, `Tab ${tabId} not found.`, null, {
      method: request.method,
    });
  }
  if (tab.windowId !== state.enabledWindow.windowId) {
    return createFailure(
      request.id,
      ERROR_CODES.ACCESS_DENIED,
      'Tab does not belong to the enabled window.',
      null,
      { method: request.method }
    );
  }
  await chrome.tabs.update(tabId, { active: true });
  await emitUiState();
  return createSuccess(
    request.id,
    { activated: true, tabId, title: tab.title ?? '', url: tab.url ?? '' },
    { method: request.method }
  );
}

const badgeDependencies = {
  getErrorMessage,
  isRestrictedAutomationUrl,
  normalizeRuntimeErrorMessage,
};

/**
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
async function isTabEnabled(tabId) {
  return isTabEnabledBadge(tabId, state, chrome);
}

/**
 * Refresh the extension action badge and title across the currently open tabs.
 *
 * @returns {Promise<void>}
 */
async function refreshActionIndicators() {
  await refreshActionIndicatorsBadge(state, chrome, badgeDependencies);
}

/**
 * Set the global badge (no tabId) to match the active tab in the last-focused
 * window. This forces browsers that batch per-tab badge updates (e.g. Edge) to
 * immediately repaint the toolbar icon.
 *
 * @returns {Promise<void>}
 */
async function syncGlobalBadgeToActiveTab() {
  await syncGlobalBadgeToActiveTabBadge(state, chrome, badgeDependencies);
}

/**
 * Update the action badge and title for one tab so enabled windows are visibly
 * marked from the Chrome toolbar.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function updateActionIndicatorForTab(tabId) {
  await updateActionIndicatorForTabBadge(tabId, state, chrome, badgeDependencies);
}

/**
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
async function isAccessRequestedTab(tabId) {
  return isAccessRequestedTabBadge(tabId, state, chrome);
}

/**
 * @param {ResolvedTabTarget} target
 * @returns {Promise<void>}
 */
async function openRequestedAccessUi(target) {
  await openRequestedAccessUiUi(target, state, chrome, {
    getCurrentTabState,
    getTabState,
  });
}

/**
 * @param {number} targetWindowId
 * @param {number} popupWidth
 * @returns {Promise<Pick<chrome.windows.UpdateInfo, 'left' | 'top'> | null>}
 */
async function getRequestedAccessPopupPlacement(targetWindowId, popupWidth) {
  return getRequestedAccessPopupPlacementUi(targetWindowId, popupWidth, chrome);
}

/**
 * @param {string} portName
 * @returns {'popup' | 'sidepanel' | null}
 */
function getUiSurfaceFromPortName(portName) {
  return getUiSurfaceFromPortNameUi(portName);
}

/**
 * Forward a response to the connected native host if it is present. Falls back
 * to the still-stabilizing port so requests that arrive right after a
 * (re)connect are answered instead of silently dropped.
 *
 * @param {BridgeResponse} response
 * @returns {void}
 */
function reply(response) {
  const port = state.nativePort ?? state.pendingNativePort;
  if (!port) {
    return;
  }
  try {
    port.postMessage(response);
  } catch (error) {
    reportAsyncError(error);
  }
}

/**
 * Broadcast a UI event to all connected extension surfaces.
 *
 * @param {Record<string, unknown>} message
 * @returns {void}
 */
function broadcastUi(message) {
  broadcastUiUi(state, message);
}

/**
 * Publish the current connection/session snapshot to the popup and side panel.
 *
 * @returns {Promise<void>}
 */
async function emitUiState() {
  await emitUiStateUi(state, {
    refreshSetupStatus,
    getTabState,
    getCurrentTabState,
    setWindowEnabled,
    setCurrentWindowEnabled,
    handleSetupInstallAction,
  });
}

/**
 * Publish the current connection and tab snapshot to one UI surface.
 *
 * @param {chrome.runtime.Port} port
 * @returns {Promise<void>}
 */
async function emitUiStateForPort(port) {
  await emitUiStateForPortUi(state, port, {
    refreshSetupStatus,
    getTabState,
    getCurrentTabState,
    setWindowEnabled,
    setCurrentWindowEnabled,
    handleSetupInstallAction,
  });
}

/**
 * Handle commands coming from the popup or side panel.
 *
 * @param {chrome.runtime.Port} port
 * @param {Record<string, any>} message
 * @returns {Promise<void>}
 */
async function handleUiMessage(port, message) {
  await handleUiMessageUi(state, port, message, {
    refreshSetupStatus,
    getTabState,
    getCurrentTabState,
    setWindowEnabled,
    setCurrentWindowEnabled,
    handleSetupInstallAction,
  });
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
  await openSidePanelForTabUi(tabId, windowId, chrome, SIDEPANEL_PATH);
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
