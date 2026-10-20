// @ts-check

import {
  BridgeError,
  ARTIFACT_CHUNK_BYTES,
  ARTIFACT_TTL_MS,
  MAX_ARTIFACT_BYTES,
  ERROR_CODES,
  createFailure,
  createRuntimeContext,
  createSuccess,
  normalizeNetworkInterceptAddParams,
  normalizeTabCloseParams,
  RecoveryTelemetryCollector,
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
import { executeInputPerform } from './background-perform.js';
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
import { createWindowActionsController } from './background-window-actions.js';
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
import { createDomBaselineController } from './background-dom-baselines.js';
import { createDomBaselineRequestHandler } from './background-dom-baseline-requests.js';
import { createAgentTabLeaseStore, normalizeAgentSession } from './background-agent-tabs.js';
import { createAgentTabGroupController } from './background-agent-groups.js';
import { createWebMcpController } from './background-webmcp.js';
import { createEmulationController } from './background-emulation.js';
import { SOURCE_DIGEST } from './build-info.js';
import { createRecordingController } from './background-recording.js';
import { pageRecorder } from './page-recorder.js';
import { renderRecording } from './recording-export.js';
import {
  createFileStaging,
  assignStagedFiles,
  assignBrowserFiles,
  fileBase64,
} from './background-files.js';
import { fetchResourceInPage, cancelPageResources } from './background-resource.js';

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
const domBaselines = createDomBaselineController();
const stagedFiles = createFileStaging();
const loadedBuild = Object.freeze({
  sourceDigest: SOURCE_DIGEST,
  workerId: crypto.randomUUID(),
  startedAt: new Date().toISOString(),
});
/** @type {Set<number>} */
const resourceFetches = new Set();
/** @type {Map<string, string>} */
const dataRequestOwners = new Map();
/** @type {Set<string>} */
const disconnectedDataRequests = new Set();
/** @type {Map<number, string>} */
const resourceOwners = new Map();
const agentTabs = createAgentTabLeaseStore({
  storage: chrome.storage?.session ?? null,
});
const agentGroups = createAgentTabGroupController(chrome, {
  async getActivity() {
    const windowId = state.enabledWindow?.windowId ?? null;
    const tabs = await agentTabs.listRecentTabs();
    return {
      windowId,
      tabIds: new Set(tabs.filter((tab) => tab.windowId === windowId).map((tab) => tab.tabId)),
    };
  },
});
/** @type {Map<string, import('./background-page.js').TabRouting>} */
const tabRoutingByRequestId = new Map();
const MAX_TRACKED_TAB_ROUTINGS = 256;

/**
 * Remember which tab a request was routed to so the response can report it.
 *
 * @param {string} requestId
 * @param {import('./background-page.js').TabRouting} routing
 * @returns {void}
 */
function recordTabRouting(requestId, routing) {
  tabRoutingByRequestId.set(requestId, routing);
  if (tabRoutingByRequestId.size > MAX_TRACKED_TAB_ROUTINGS) {
    const oldest = tabRoutingByRequestId.keys().next().value;
    if (oldest !== undefined) tabRoutingByRequestId.delete(oldest);
  }
  void syncWorkingTabIndicators().catch(reportAsyncError);
}

/**
 * Refresh the cached working-tab set and repaint badges whose state changed.
 *
 * @returns {Promise<void>}
 */
async function syncWorkingTabIndicators() {
  void agentGroups.sync().catch(reportAsyncError);
  const next = await agentTabs.getWorkingTabIds();
  const previous = state.workingTabIds ?? new Set();
  const changed = new Set(
    [...previous, ...next].filter((tabId) => previous.has(tabId) !== next.has(tabId))
  );
  state.workingTabIds = next;
  for (const tabId of changed) {
    await updateActionIndicatorForTab(tabId).catch(() => {});
  }
  if (changed.size) {
    await syncGlobalBadgeToActiveTab();
    await emitUiState();
  }
}
const recoveryTelemetry = new RecoveryTelemetryCollector();

const tabDebugger = new TabDebuggerCoordinator({
  attach: (target, protocolVersion) => chrome.debugger.attach(target, protocolVersion),
  detach: (target) => chrome.debugger.detach(target),
  initialize: async (target) => {
    await chrome.debugger.sendCommand(target, 'Page.enable', {});
  },
  protocolVersion: DEBUGGER_PROTOCOL_VERSION,
  recordReattach: (outcome) => recoveryTelemetry.record('debugger_reattach', outcome),
});

const cdpNetworkCapture = createCdpNetworkCapture({
  acquireDebugger: (tabId) => tabDebugger.acquire(tabId),
  releaseDebugger: (tabId) => tabDebugger.release(tabId),
  assertDebuggerAvailable: (tabId) => tabDebugger.assertCanStart(tabId),
  sendCommand: (target, method, params) =>
    /** @type {Promise<unknown>} */ (chrome.debugger.sendCommand(target, method, params)),
});

const emulation = createEmulationController({
  acquire: (tabId) => tabDebugger.acquire(tabId),
  release: (tabId) => tabDebugger.release(tabId),
  send: (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params),
});

const recordings = createRecordingController({
  page: async (tabId, action, sessionId) => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageRecorder,
      args: [action, sessionId],
    });
    if (!result?.result) throw new Error('Page recorder unavailable.');
    return result.result;
  },
  startNetwork: async (tabId) => {
    const existing = await cdpNetworkCapture.read(tabId);
    if (existing.armed)
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        'Stop the existing CDP network capture before recording a network session.'
      );
    return cdpNetworkCapture.start(tabId);
  },
  stopNetwork: (tabId) => cdpNetworkCapture.stop(tabId),
  send: (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params),
  captureFrame: (tabId) =>
    tabDebugger.run(
      tabId,
      async (target) => {
        const metrics =
          /** @type {{ cssVisualViewport?: { pageX?: number, pageY?: number, clientWidth?: number, clientHeight?: number } }} */ (
            await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics')
          );
        const viewport = metrics.cssVisualViewport ?? {};
        const result = /** @type {{ data: string }} */ (
          await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
            format: 'jpeg',
            quality: 45,
            clip: {
              x: Math.max(0, viewport.pageX ?? 0),
              y: Math.max(0, viewport.pageY ?? 0),
              width: Math.max(1, Math.min(1600, viewport.clientWidth ?? 800)),
              height: Math.max(1, Math.min(1200, viewport.clientHeight ?? 600)),
              scale: 0.5,
            },
            captureBeyondViewport: false,
          })
        );
        return result.data;
      },
      { releaseAfterRun: true }
    ),
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (typeof source.tabId === 'number') {
    tabDebugger.handleDetach(source.tabId, reason);
    emulation.detached(source.tabId);
    recordings.handleDetach(source.tabId);
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
    recordings.handleNetwork(source.tabId, method, params);
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
  sendFrameMessage,
  listFrames,
  getFrameForRef,
  injectContentScriptsForWindow,
  ensureContentScript,
  installNavigationSignals,
  uninstallNavigationSignals,
} = createContentScriptBridge(chrome, {
  contentScriptTimeoutMs: CONTENT_SCRIPT_TIMEOUT_MS,
  isRestrictedAutomationUrl,
  recordReinjection: (outcome, group) =>
    recoveryTelemetry.record('content_script_reinjection', outcome, group),
});

const navigationWaits = new NavigationWaitCoordinator({
  getTab: (tabId) => chrome.tabs.get(tabId),
  hasWindowAccess: (windowId) => state.enabledWindow?.windowId === windowId,
  installSignals: installNavigationSignals,
  uninstallSignals: uninstallNavigationSignals,
});

const tabCleanupController = createTabCleanupController(chrome, {
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
  clearDomBaselinesForTab: (tabId) => domBaselines.clearTab(tabId),
  clearWebMcpForTab: (tabId) => webmcp.clearTab(tabId),
  clearEmulationForTab: async (tabId) => {
    await emulation.reset(tabId);
  },
  clearFilesForTab: async (tabId) => {
    stagedFiles.clearTab(tabId);
    if (resourceFetches.has(tabId))
      await chrome.scripting
        .executeScript({ target: { tabId }, func: cancelPageResources })
        .catch(() => {});
    await recordings.clear(tabId);
  },
  isRecoverableInstrumentationError,
  isRestrictedAutomationUrl,
});
/**
 * @param {number} tabId
 * @param {(() => Promise<boolean>) | undefined} [shouldContinue]
 */
const clearTabBridgeState = async (tabId, shouldContinue) => {
  await tabCleanupController.clearTabBridgeState(tabId, shouldContinue);
};
/** @param {number} windowId */
const clearWindowBridgeState = async (windowId) => {
  domBaselines.clearWindow(windowId);
  await agentGroups.clearWindow(windowId).catch(reportAsyncError);
  await agentTabs.clear();
  await agentGroups.sync().catch(reportAsyncError);
  void syncWorkingTabIndicators().catch(reportAsyncError);
  await tabCleanupController.clearWindowBridgeState(windowId);
};
const rollbackAllPatchesForTab = tabCleanupController.rollbackAllPatchesForTab;

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
    await recordings.clear(tabId);
    domBaselines.clearTab(tabId);
    emulation.detached(tabId);
    stagedFiles.clearTab(tabId);
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
  disableWindowAccess,
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

const windowActions = createWindowActionsController(state, chrome, { disableWindowAccess });

const {
  resolveRequestTarget,
  waitForTabComplete,
  handlePageGetConsole,
  handlePageGetState,
  handlePageDialog,
  handleAccessibilityTree,
  handleGetNetwork,
  handleExportHar,
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
  readCdpHarEvidence: (tabId) => cdpNetworkCapture.readHar(tabId),
  storeHarArtifact: (requestId, bytes) =>
    storeByteArtifact(requestId, bytes, { kind: 'har', mimeType: 'application/json' }),
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
  agentTabs,
  onRequestRouted: recordTabRouting,
});

const domBaselineRequests = createDomBaselineRequestHandler(domBaselines, {
  resolveRequestTarget,
  ensureContentScript,
  sendTabMessage,
  contentScriptTimeoutMs: CONTENT_SCRIPT_TIMEOUT_MS,
});

/** @type {WeakMap<chrome.runtime.Port, string>} */
const webMcpConnections = new WeakMap();
const webmcp = createWebMcpController(chrome, {
  resolveRequestTarget,
  getSessionKey() {
    const window = state.enabledWindow;
    const port = state.nativePort;
    if (!window || !port) return null;
    let connection = webMcpConnections.get(port);
    if (!connection) {
      connection = crypto.randomUUID();
      webMcpConnections.set(port, connection);
    }
    return `${window.windowId}:${window.enabledAt}:${connection}`;
  },
});

const {
  appendActionLogEntry,
  getActionContext,
  logBridgeAction,
  restoreActionLog,
  clearActionLogForTab,
} = createActionLogController(state, chrome, {
  emitUiState,
  getCurrentTabState,
  resolveRequestTarget,
});

const { handleNativeInput } = createBackgroundInputController({
  contentScriptTimeoutMs: CONTENT_SCRIPT_TIMEOUT_MS,
  runWithDebugger: (tabId, operation) => tabDebugger.runGuarded(tabId, operation),
  sendCommand: (target, method, params) => {
    tabDebugger.assertTaskActive(target);
    return /** @type {Promise<unknown>} */ (chrome.debugger.sendCommand(target, method, params));
  },
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
  handleHostStatusMessage: (message) => {
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'host.owner_disconnected'
    ) {
      const ownerId =
        'ownerId' in message && typeof message.ownerId === 'string' ? message.ownerId : '';
      if (!/^[a-f0-9-]{36}$/u.test(ownerId)) return true;
      for (const [id, owner] of dataRequestOwners)
        if (owner === ownerId) disconnectedDataRequests.add(id);
      stagedFiles.clearTransportOwner(ownerId);
      void recordings.clearTransportOwner(ownerId);
      for (const [tabId, owner] of resourceOwners)
        if (owner === ownerId)
          void chrome.scripting
            .executeScript({ target: { tabId }, func: cancelPageResources })
            .catch(() => {});
      return true;
    }
    return windowActions.handleMessage(message) || handleHostStatusMessage(message);
  },
  refreshActionIndicators,
  refreshSetupStatus,
  reply,
  handleDestinationDisconnect: () => {
    for (const tabId of recordings.tabIds()) void recordings.clear(tabId).catch(reportAsyncError);
    domBaselines.clearAll();
    stagedFiles.clearAll();
    for (const tabId of resourceFetches)
      void chrome.scripting
        .executeScript({ target: { tabId }, func: cancelPageResources })
        .catch(() => {});
    windowActions.disconnect();
  },
  recordReconnect: (outcome) => recoveryTelemetry.record('native_host_reconnect', outcome),
});

/**
 * @param {string} requestId
 * @param {string} data
 * @param {{ mimeType: string, byteLength: number }} metadata
 * @returns {Promise<import('../../protocol/src/types.js').ArtifactDescriptor<'screenshot'>>}
 */
async function storeScreenshotArtifact(requestId, data, metadata) {
  return storeByteArtifact(requestId, base64ToBytes(data), {
    kind: 'screenshot',
    mimeType: metadata.mimeType,
  });
}

/**
 * @template {import('../../protocol/src/types.js').ArtifactKind} K
 * @param {string} requestId
 * @param {Uint8Array} bytes
 * @param {{ kind: K, mimeType: string }} metadata
 * @returns {Promise<import('../../protocol/src/types.js').ArtifactDescriptor<K>>}
 */
async function storeByteArtifact(requestId, bytes, metadata) {
  if (!state.nativePort) {
    throw new BridgeError(ERROR_CODES.EXTENSION_DISCONNECTED, 'Native host is disconnected.');
  }
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new BridgeError(
      ERROR_CODES.RESULT_TOO_LARGE,
      `Artifact exceeds the artifact limit (${bytes.byteLength} bytes).`,
      { byteLength: bytes.byteLength, maxArtifactBytes: MAX_ARTIFACT_BYTES }
    );
  }
  const random = crypto.getRandomValues(new Uint8Array(32));
  const artifactId = `art_${bytesToBase64(random).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  const sha256 = [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ARTIFACT_TTL_MS).toISOString();
  const chunkCount = Math.ceil(bytes.byteLength / ARTIFACT_CHUNK_BYTES);
  const descriptor = {
    artifactId,
    kind: metadata.kind,
    mimeType: metadata.mimeType,
    byteLength: bytes.byteLength,
    sha256,
    chunkSize: ARTIFACT_CHUNK_BYTES,
    chunkCount,
    createdAt,
    expiresAt,
  };
  state.nativePort.postMessage({
    type: 'host.artifact.begin',
    artifact: { ...descriptor, requestId },
  });
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const chunk = bytes.subarray(
      chunkIndex * ARTIFACT_CHUNK_BYTES,
      Math.min(bytes.byteLength, (chunkIndex + 1) * ARTIFACT_CHUNK_BYTES)
    );
    state.nativePort.postMessage({
      type: 'host.artifact.chunk',
      artifact: { requestId },
      artifactId,
      chunkIndex,
      data: bytesToBase64(chunk),
    });
  }
  state.nativePort.postMessage({
    type: 'host.artifact.commit',
    artifact: { requestId },
    artifactId,
  });
  return descriptor;
}

/** @param {string} value */
function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** @param {Uint8Array} value */
function bytesToBase64(value) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Auto execution mode: use debugger (trusted) input only when it is already
 * attached to the tab, or when the target likely ignores synthetic events
 * (file pickers, media, new-window links, rich editors). Otherwise stay on DOM
 * events so no debugger banner appears.
 *
 * @param {number} tabId
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @returns {Promise<{ mode: 'dom' | 'cdp', reason: string }>}
 */
async function chooseInputExecutionMode(tabId, method, params) {
  if (tabDebugger.attachedTabs.has(tabId)) return { mode: 'cdp', reason: 'debugger-attached' };
  try {
    const hint = /** @type {{ needsTrusted?: boolean, reason?: string } | null} */ (
      await sendTabMessage(
        tabId,
        {
          type: 'bridge.execute',
          method: 'input.trust_hint',
          params: { method, target: params.target ?? params.source ?? null },
        },
        CONTENT_SCRIPT_TIMEOUT_MS
      )
    );
    if (hint?.needsTrusted && typeof hint.reason === 'string') {
      return { mode: 'cdp', reason: hint.reason };
    }
  } catch {
    // Fall back to DOM input when the hint is unavailable.
  }
  return { mode: 'dom', reason: 'synthetic-dom-default' };
}

/** @type {Parameters<typeof executeTabBoundRequest>[1]} */
const tabBoundRequestDependencies = {
  contentScriptTimeoutMs: CONTENT_SCRIPT_TIMEOUT_MS,
  assertNoDialog: (tabId) => tabDebugger.assertNoDialog(tabId),
  runWithDialogGuard: (tabId, operation) => tabDebugger.runGuarded(tabId, operation),
  chooseInputExecutionMode,
  ensureContentScript,
  handleScreenshot: (target, method, params, requestId) =>
    handleScreenshot(
      target,
      method,
      params,
      {
        chrome,
        contentScriptTimeoutMs: CONTENT_SCRIPT_TIMEOUT_MS,
        ensureContentScript,
        sendTabMessage,
        tabDebugger,
        storeArtifact: storeScreenshotArtifact,
      },
      requestId
    ),
  handleNativeInput,
  resolveRequestTarget,
  sendTabMessage: (tabId, message, timeoutMs = CONTENT_SCRIPT_TIMEOUT_MS) =>
    sendTabMessage(tabId, message, timeoutMs),
  toFailureResponse,
  recordStaleRecovery: (outcome, group) =>
    recoveryTelemetry.record('stale_ref_recovery', outcome, group),
  frames: { listFrames, getFrameForRef, sendFrameMessage },
};

const accessStateInitialization = restoreEnabledWindow().catch(reportAsyncError);
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
  if (typeof changeInfo.groupId === 'number' || typeof changeInfo.pinned === 'boolean') {
    void agentGroups.sync().catch(reportAsyncError);
  }
  if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') {
    domBaselines.invalidateNavigation(tabId);
    void webmcp.clearTab(tabId).catch(reportAsyncError);
  }
  navigationWaits.handleTabUpdated(tabId, changeInfo, tab);
  void handleTabUpdated(tabId, changeInfo, tab).catch(reportAsyncError);
});

chrome.tabs.onDetached?.addListener((tabId, detachInfo) => {
  void webmcp.clearTab(tabId).catch(reportAsyncError);
  tabMoveCleanup.handleDetached(tabId, detachInfo);
});

chrome.tabs.onMoved?.addListener(() => {
  void agentGroups.sync().catch(reportAsyncError);
});

chrome.tabs.onAttached?.addListener((tabId, attachInfo) => {
  navigationWaits.handleTabMoved(tabId, attachInfo.newWindowId);
  void agentTabs
    .handleTabMoved(tabId, attachInfo.newWindowId)
    .then(() => syncWorkingTabIndicators())
    .catch(reportAsyncError);
  void tabMoveCleanup.handleAttached(tabId, attachInfo).catch(reportAsyncError);
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  void webmcp.clearTab(tabId).catch(reportAsyncError);
  domBaselines.clearTab(tabId);
  void clearActionLogForTab(tabId)
    .finally(() => emitUiState())
    .catch(reportAsyncError);
  void agentTabs
    .handleTabRemoved(tabId)
    .then(() => syncWorkingTabIndicators())
    .catch(reportAsyncError);
  void tabMoveCleanup.handleRemoved(tabId).catch(reportAsyncError);
  void handleTabRemoved(tabId, removeInfo).catch(reportAsyncError);
});

chrome.windows.onRemoved.addListener((windowId) => {
  webmcp.handleWindowRemoved(windowId);
  clearRequestedAccessPopupWindow(windowId);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM_NAME) {
    domBaselines.pruneExpired();
    void syncWorkingTabIndicators().catch(reportAsyncError);
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
    onWebMcpApproval: webmcp.handleMessage,
    onNavigationSignal: (tabId, kind, channel) => {
      domBaselines.invalidateNavigation(tabId);
      void webmcp.clearTab(tabId).catch(reportAsyncError);
      navigationWaits.handleSpaSignal(tabId, kind, channel);
    },
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
  sendAccessUpdateNative(enabled, state.nativePort, state.enabledWindow);
}

/**
 * Restore persisted window access state when the service worker starts so the
 * current browser-run grant survives worker restarts.
 *
 * @returns {Promise<void>}
 */
async function initializeState() {
  await accessStateInitialization;
  if (state.enabledWindow && state.nativePort) {
    sendAccessUpdate(true);
  }
  await restoreActionLog();
  await emitUiState();
  await primeEnabledWindowInstrumentation();
  await refreshActionIndicators();
  await syncWorkingTabIndicators();
}

/**
 * Route a validated bridge request to the extension capability that should
 * satisfy it.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<void>}
 */
async function handleBridgeRequest(request) {
  if (
    typeof request.meta?.transport_owner === 'string' &&
    /^(?:files\.|session\.|download\.|input\.set_files$)/u.test(request.method)
  )
    dataRequestOwners.set(request.id, request.meta.transport_owner);
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
  response = attachTabRouting(request, response);
  response = enrichBridgeResponse(request, response);
  if (request.method === 'sensitive.read') {
    void logBridgeAction(request, response, actionContext).catch(reportAsyncError);
    reply(response);
    return;
  }
  reply(response);
  dataRequestOwners.delete(request.id);
  disconnectedDataRequests.delete(request.id);
  try {
    await logBridgeAction(request, response, actionContext);
  } catch (error) {
    reportAsyncError(error);
  }
}

/**
 * Add the calling session's working tab to an access status.
 *
 * @template {Record<string, unknown>} T
 * @param {BridgeRequest} request
 * @param {T} access
 * @returns {Promise<T & { workingTabId?: number }>}
 */
async function withWorkingTab(request, access) {
  if (!access.enabled) return access;
  const lease = await agentTabs.get(normalizeAgentSession(request.meta?.agent_session));
  return lease && !lease.closed && lease.windowId === access.windowId
    ? { ...access, workingTabId: lease.tabId }
    : access;
}

/**
 * Report where a tab-bound request ran. `active_tab_id` is included only when
 * the agent's working tab differs from the user's active tab, which is the
 * case agents need to notice.
 *
 * @param {BridgeRequest} request
 * @param {BridgeResponse} response
 * @returns {BridgeResponse}
 */
function attachTabRouting(request, response) {
  const routing = tabRoutingByRequestId.get(request.id);
  if (!routing) return response;
  tabRoutingByRequestId.delete(request.id);
  return {
    ...response,
    meta: {
      ...response.meta,
      tab_id: routing.tabId,
      tab_routing: routing.via,
      ...(routing.activeTabId !== null && routing.activeTabId !== routing.tabId
        ? { active_tab_id: routing.activeTabId }
        : {}),
    },
  };
}

/**
 * Resolve one bridge request into a structured response.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function dispatchBridgeRequest(request) {
  if (request.method === 'viewport.resize') {
    const target = await resolveRequestTarget(request);
    if (emulation.status(target.tabId).pendingReset.includes('device'))
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        'Device emulation owns viewport metrics. Update emulation.apply.device or reset emulation before resizing.'
      );
  }
  if (request.method === 'page.get_network' && request.params.capture !== 'read') {
    const target = await resolveRequestTarget(request);
    if (recordings.has(target.tabId))
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        'A recording owns network capture on this tab. Stop it through session.stop first.'
      );
  }
  switch (request.method) {
    case 'session.start':
    case 'session.status':
    case 'session.read':
    case 'session.stop':
    case 'session.export':
    case 'session.release':
      return handleRecordingRequest(request);
    case 'files.stage':
    case 'files.release':
    case 'input.set_files':
    case 'download.resource':
      return handleFileRequest(request);
    case 'emulation.apply':
    case 'emulation.status':
    case 'emulation.reset': {
      const target = await resolveRequestTarget(request);
      const access = state.enabledWindow;
      const port = state.nativePort;
      const assertAccess = async () => {
        if (state.enabledWindow !== access || state.nativePort !== port)
          throw new BridgeError(
            ERROR_CODES.ACCESS_DENIED,
            'Emulation access or transport changed.'
          );
        await resolveRequestTarget({ ...request, tab_id: target.tabId });
      };
      const result =
        request.method === 'emulation.apply'
          ? await emulation.apply(target.tabId, request.params, assertAccess)
          : request.method === 'emulation.reset'
            ? await emulation.reset(target.tabId)
            : emulation.status(target.tabId);
      return createSuccess(request.id, result, { method: request.method });
    }
    case 'webmcp.list_tools':
    case 'webmcp.get_tool':
    case 'webmcp.execute_tool':
      return webmcp.handle(request);
    case 'health.ping': {
      const debuggerDiagnostics = tabDebugger.getDiagnostics();
      const cdpCaptureDiagnostics = cdpNetworkCapture.getDiagnostics();
      const interceptionDiagnostics = fetchInterceptor.getDiagnostics();
      return createSuccess(
        request.id,
        {
          extension: 'ok',
          extensionVersion: chrome.runtime.getManifest().version,
          loadedBuild,
          access: await withWorkingTab(
            request,
            await getAccessStatus({
              chrome,
              state,
              clearEnabledWindowIfGone,
              isRestrictedAutomationUrl,
            })
          ),
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
          domBaselines: domBaselines.metrics(),
          recovery: recoveryTelemetry.snapshot('routedExtension'),
          ...getVersionNegotiationPayload(request.meta?.protocol_version),
        },
        { method: request.method }
      );
    }
    case 'access.request':
      return handleAccessRequest(request);
    case 'dom.baseline.create':
    case 'dom.baseline.compare':
    case 'dom.baseline.describe':
    case 'dom.baseline.release':
      return domBaselineRequests.handle(request);
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
      // The DOM outline runs in the content script and needs no debugger.
      return request.params?.source === 'dom'
        ? executeTabBoundRequest(request, tabBoundRequestDependencies)
        : handleAccessibilityTree(request);
    case 'page.get_network':
      return handleGetNetwork(request);
    case 'network.export_har':
      return handleExportHar(request);
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
    case 'input.perform':
      return executeInputPerform(request, {
        resolveRequestTarget,
        dispatch: async (step) => {
          try {
            // Input steps own their guard. Guard waits and reads too, so an
            // alert scheduled after an edit cannot strand the remaining flow.
            return await (step.method.startsWith('input.') || typeof step.tab_id !== 'number'
              ? dispatchBridgeRequest(step)
              : tabDebugger.runGuarded(step.tab_id, () => dispatchBridgeRequest(step)));
          } catch (error) {
            return toFailureResponse(step, error);
          }
        },
      });
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

/** @param {BridgeRequest} request @returns {Promise<BridgeResponse>} */
async function handleRecordingRequest(request) {
  if (disconnectedDataRequests.has(request.id))
    throw new BridgeError(ERROR_CODES.ACCESS_DENIED, 'Recording connection closed.');
  const target = await resolveRequestTarget(request);
  const access = state.enabledWindow;
  const port = state.nativePort;
  const transportOwner = request.meta?.transport_owner;
  if (!transportOwner)
    throw new BridgeError(
      ERROR_CODES.ACCESS_DENIED,
      'Recordings require a current daemon connection identity.'
    );
  const owner = `${transportOwner}:${normalizeAgentSession(request.meta?.agent_session)}`;
  const assertAccess = async () => {
    if (disconnectedDataRequests.has(request.id))
      throw new BridgeError(ERROR_CODES.ACCESS_DENIED, 'Recording connection closed.');
    if (access !== state.enabledWindow || port !== state.nativePort)
      throw new BridgeError(ERROR_CODES.ACCESS_DENIED, 'Recording access or transport changed.');
    await resolveRequestTarget({ ...request, tab_id: target.tabId });
  };
  const p = request.params;
  const id = String(p.sessionId);
  let result;
  switch (request.method) {
    case 'session.start':
      result = await recordings.start(
        target.tabId,
        owner,
        {
          activity: p.activity === true,
          network: p.network === true,
          bodies: p.bodies === true,
          messages: p.messages === true,
          visual: p.visual === true,
          durationMs: Number(p.durationMs),
        },
        assertAccess
      );
      break;
    case 'session.status':
      result = await recordings.status(target.tabId, owner, id);
      break;
    case 'session.read':
      result = await recordings.read(
        target.tabId,
        owner,
        id,
        Number(p.cursor),
        Number(p.limit),
        Number(p.waitMs)
      );
      break;
    case 'session.stop':
      result = await recordings.stop(target.tabId, owner, id);
      break;
    case 'session.release':
      result = await recordings.release(target.tabId, owner, id);
      break;
    default: {
      const recording = await recordings.exportSession(target.tabId, owner, id);
      await assertAccess();
      const html = p.format === 'html';
      const bytes = new TextEncoder().encode(
        html ? renderRecording(recording) : JSON.stringify(recording)
      );
      const artifact = await storeByteArtifact(request.id, bytes, {
        kind: 'resource',
        mimeType: html ? 'text/html' : 'application/json',
      });
      result = {
        sessionId: id,
        delivery: 'artifact',
        artifact,
        gaps: recording.gaps,
        dropped: recording.dropped,
      };
    }
  }
  return createSuccess(request.id, result, { method: request.method });
}

/** @param {BridgeRequest} request @returns {Promise<BridgeResponse>} */
async function handleFileRequest(request) {
  const tab = await resolveRequestTarget(request);
  const access = state.enabledWindow;
  const assertScope = () => {
    if (state.enabledWindow !== access || disconnectedDataRequests.has(request.id))
      throw new BridgeError(
        ERROR_CODES.ACCESS_DENIED,
        'Window access changed during file operation.'
      );
  };
  assertScope();
  const transportOwner = request.meta?.transport_owner;
  if (typeof transportOwner !== 'string' || !transportOwner)
    throw new BridgeError(
      ERROR_CODES.ACCESS_DENIED,
      'File operations require a current daemon connection identity. Restart the daemon.'
    );
  const owner = `${state.enabledWindow?.enabledAt}:${transportOwner}:${normalizeAgentSession(request.meta?.agent_session)}`;
  const p = request.params;
  let result;
  switch (request.method) {
    case 'files.stage':
      result = stagedFiles.stage(p, owner, tab.tabId);
      break;
    case 'files.release':
      result = stagedFiles.release(String(p.transferId), owner, tab.tabId);
      break;
    case 'download.resource': {
      if (resourceFetches.size >= 4 || resourceFetches.has(tab.tabId))
        throw new BridgeError(
          ERROR_CODES.INVALID_REQUEST,
          'A resource fetch is already active for this tab or the global limit is reached.'
        );
      resourceFetches.add(tab.tabId);
      resourceOwners.set(tab.tabId, transportOwner);
      try {
        const [fetched] = await chrome.scripting.executeScript({
          target: { tabId: tab.tabId },
          func: fetchResourceInPage,
          args: [String(p.url), Number(p.maxBytes), Number(p.timeoutMs), request.id],
        });
        if (!fetched?.result || 'error' in fetched.result)
          throw new BridgeError(
            ERROR_CODES.INVALID_REQUEST,
            fetched?.result && 'error' in fetched.result
              ? fetched.result.error
              : 'Resource fetch produced no result.'
          );
        await resolveRequestTarget({ ...request, tab_id: tab.tabId });
        assertScope();
        const artifact = await storeByteArtifact(request.id, base64ToBytes(fetched.result.data), {
          kind: 'resource',
          mimeType: fetched.result.mimeType,
        });
        result = { delivery: 'artifact', artifact, status: fetched.result.status };
      } finally {
        resourceFetches.delete(tab.tabId);
        resourceOwners.delete(tab.tabId);
      }
      break;
    }
    default: {
      const target = /** @type {Record<string, unknown>} */ (p.target);
      if (Array.isArray(p.paths)) {
        result = await tabDebugger.runGuarded(tab.tabId, (debugTarget) =>
          assignBrowserFiles(
            (method, params) => {
              assertScope();
              tabDebugger.assertTaskActive(debugTarget);
              return chrome.debugger.sendCommand(debugTarget, method, params);
            },
            String(target.selector),
            /** @type {string[]} */ (p.paths)
          )
        );
      } else {
        const ids = /** @type {string[]} */ (p.files);
        const files = stagedFiles.resolve(ids, owner, tab.tabId);
        await ensureContentScript(tab.tabId);
        const frameId =
          typeof target.elementRef === 'string'
            ? await getFrameForRef(tab.tabId, target.elementRef)
            : 0;
        await resolveRequestTarget({ ...request, tab_id: tab.tabId });
        assertScope();
        const [assigned] = await chrome.scripting.executeScript({
          target: { tabId: tab.tabId, frameIds: [frameId] },
          func: assignStagedFiles,
          args: [
            target,
            files.map((file) => ({
              name: file.name,
              mimeType: file.mimeType,
              data: fileBase64(file.bytes),
            })),
          ],
        });
        if (!assigned?.result || 'error' in assigned.result)
          throw new BridgeError(
            ERROR_CODES.INPUT_INVALID_TARGET,
            assigned?.result && 'error' in assigned.result
              ? assigned.result.error
              : 'File assignment produced no result. Inspect the input before retrying.'
          );
        result = assigned.result;
      }
    }
  }
  return createSuccess(request.id, result, { method: request.method });
}

/**
 * Summarize the currently open tabs in the enabled window so the client can
 * inspect or explicitly target them.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handleListTabs(request) {
  const lease = await agentTabs.get(normalizeAgentSession(request.meta?.agent_session));
  const workingTabId = lease && !lease.closed ? lease.tabId : null;
  const response = await executeListTabs(
    request,
    { ...state, workingTabId },
    {
      queryTabs: (query) => chrome.tabs.query(query),
    },
    ACCESS_DENIED_WINDOW_OFF
  );
  if (!response.ok) return response;
  const result = /** @type {{ tabs: Array<Record<string, unknown>> }} */ (response.result);
  return {
    ...response,
    result: {
      ...result,
      ...(workingTabId !== null ? { workingTabId } : {}),
      tabs: result.tabs.map((tab) =>
        tab.tabId === workingTabId ? { ...tab, working: true } : tab
      ),
    },
  };
}

/**
 * Make one tab the calling agent session's working tab.
 *
 * @param {BridgeRequest} request
 * @param {number} tabId
 * @param {number} windowId
 * @returns {Promise<void>}
 */
async function bindWorkingTab(request, tabId, windowId) {
  await agentTabs.bind(normalizeAgentSession(request.meta?.agent_session), tabId, windowId);
  await syncWorkingTabIndicators();
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
    runWithDebugger: (tabId, operation) => tabDebugger.runGuarded(tabId, operation),
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
  const response = await executeCreateTab(
    request,
    state,
    {
      createTab: (properties) => chrome.tabs.create(properties),
    },
    ACCESS_DENIED_WINDOW_OFF
  );
  if (!response.ok) return response;
  const created = /** @type {{ tabId?: unknown }} */ (response.result);
  if (typeof created.tabId === 'number' && state.enabledWindow) {
    await bindWorkingTab(request, created.tabId, state.enabledWindow.windowId);
    return { ...response, result: { ...created, working: true } };
  }
  return response;
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
  await bindWorkingTab(request, tabId, tab.windowId);
  await emitUiState();
  return createSuccess(
    request.id,
    { activated: true, working: true, tabId, title: tab.title ?? '', url: tab.url ?? '' },
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
  await accessStateInitialization;
  await emitUiStateUi(state, {
    refreshSetupStatus,
    getTabState,
    getCurrentTabState,
    setWindowEnabled,
    setCurrentWindowEnabled,
    handleSetupInstallAction,
    getAgentTabState,
    moveAgentToTab,
  });
}

/**
 * Publish the current connection and tab snapshot to one UI surface.
 *
 * @param {chrome.runtime.Port} port
 * @returns {Promise<void>}
 */
async function emitUiStateForPort(port) {
  await accessStateInitialization;
  await emitUiStateForPortUi(state, port, {
    refreshSetupStatus,
    getTabState,
    getCurrentTabState,
    setWindowEnabled,
    setCurrentWindowEnabled,
    handleSetupInstallAction,
    getAgentTabState,
    moveAgentToTab,
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
    getAgentTabState,
    moveAgentToTab,
    requestWindowAction: windowActions.request,
  });
}

/**
 * Describe recently targeted tabs without choosing the latest request as a winner.
 *
 * @param {number} windowId
 * @param {number} currentTabId
 * @returns {Promise<import('./background-ui.js').AgentTabUiState[]>}
 */
async function getAgentTabState(windowId, currentTabId) {
  const leases = await agentTabs.listRecentTabs();
  const tabIds = [
    ...new Set(leases.filter((entry) => entry.windowId === windowId).map((entry) => entry.tabId)),
  ];
  /** @type {Map<number, number>} */
  const actionCounts = new Map();
  for (const entry of state.actionLog) {
    if (entry.tabId !== null && entry.method !== 'health.ping') {
      actionCounts.set(entry.tabId, (actionCounts.get(entry.tabId) ?? 0) + 1);
    }
  }
  const tabs = await Promise.all(
    tabIds.map(async (tabId) => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId !== windowId) return null;
        return {
          tabId,
          title: tab.title ?? '',
          isCurrent: tabId === currentTabId,
          actionCount: actionCounts.get(tabId) ?? 0,
        };
      } catch {
        return null;
      }
    })
  );
  return tabs
    .filter((tab) => tab !== null)
    .sort(
      (left, right) => Number(right.isCurrent) - Number(left.isCurrent) || left.tabId - right.tabId
    );
}

/**
 * Redirect every agent session in the tab's window to that tab. This is the
 * user's explicit way to point an agent somewhere else, since merely switching
 * tabs no longer moves it.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function moveAgentToTab(tabId) {
  if (!state.enabledWindow) return;
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId !== state.enabledWindow.windowId) return;
  await agentTabs.rebindWindow(tab.windowId, tabId);
  await syncWorkingTabIndicators();
  await emitUiState();
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
  disableWindowAccess,
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
