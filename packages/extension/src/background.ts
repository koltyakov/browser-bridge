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
} from '../../../protocol/src/index.js';
import {
  getErrorMessage,
  normalizeRuntimeErrorMessage,
  shouldLogAction,
} from './background-helpers.js';
import { isRestrictedAutomationUrl } from './background-routing.js';
import { captureWindowGrant, getAccessStatus, sameWindowGrant } from './background-access.js';
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
import { createMutationGate } from './background-mutation-gate.js';
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
  NATIVE_SETUP_RETRY_ALARM,
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
import { captureVisualBaseline, invalidateVisualBaselines } from './background-visual-baselines.js';
import {
  createTabCleanupController,
  createTabMoveCleanupController,
} from './background-tab-cleanup.js';
import { createActionLogController, enrichBridgeResponse } from './background-action-log.js';
import { createAccessRequestController } from './background-access-request.js';
import { createPageRequestController } from './background-page.js';
import { createBackgroundInputController, isNativeInputRelease } from './background-input.js';
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
import { DEVELOPMENT_AUTO_RELOAD, SOURCE_DIGEST } from './build-info.js';
import {
  createDevelopmentReloadController,
  DEVELOPMENT_RELOAD_ALARM,
} from './background-development.js';
import { createRecordingController } from './background-recording.js';
import { createDownloadController } from './background-downloads.js';
import { createJournalTransport } from './recording-journal.js';
import { pageRecorder } from './page-recorder.js';
import { createFileStaging } from './background-files.js';
import { cancelPageResources } from './background-resource.js';
import { createFileRequestHandler } from './background-file-requests.js';
import { createRecordingRequestHandler } from './background-recording-requests.js';
import { requestLifetimes } from './background-request-lifetime.js';
import { createArtifactTransport } from './background-artifact-transport.js';

export type EnabledWindowState = import('./background-state.js').EnabledWindowState;
export type ResolvedTabTarget = import('./background-state.js').ResolvedTabTarget;
export type ActionLogEntry = import('./background-state.js').ActionLogEntry;
export type CurrentTabState = import('./background-state.js').CurrentTabState;
export type UiPortState = import('./background-state.js').UiPortState;
export type ExtensionState = import('./background-state.js').ExtensionState;
export type BridgeRequest = import('../../../protocol/src/types.js').BridgeRequest;
export type BridgeResponse = import('../../../protocol/src/types.js').BridgeResponse;
export type ErrorCode = import('../../../protocol/src/types.js').ErrorCode;
export type SetupStatus = import('../../../protocol/src/types.js').SetupStatus;

const chrome: typeof globalThis.chrome = globalThis.chrome;

const state: ExtensionState = createExtensionState();
setExtensionState(state);
const domBaselines = createDomBaselineController();
const stagedFiles = createFileStaging();
const loadedBuild = Object.freeze({
  sourceDigest: SOURCE_DIGEST,
  workerId: crypto.randomUUID(),
  startedAt: new Date().toISOString(),
});

const resourceFetches: Set<number> = new Set();

const dataRequestOwners: Map<string, string> = new Map();

const disconnectedDataRequests: Set<string> = new Set();

const resourceOwners: Map<number, string> = new Map();
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

const tabRoutingByRequestId: Map<string, import('./background-page.js').TabRouting> = new Map();
const MAX_TRACKED_TAB_ROUTINGS = 256;

/** Remember which tab a request was routed to so the response can report it. */
function recordTabRouting(
  requestId: string,
  routing: import('./background-page.js').TabRouting
): void {
  tabRoutingByRequestId.set(requestId, mutationGate.routing(requestId, routing));
  if (tabRoutingByRequestId.size > MAX_TRACKED_TAB_ROUTINGS) {
    const oldest = tabRoutingByRequestId.keys().next().value;
    if (oldest !== undefined) tabRoutingByRequestId.delete(oldest);
  }
  void syncWorkingTabIndicators().catch(reportAsyncError);
}

/** Refresh the cached working-tab set and repaint badges whose state changed. */
let workingIndicatorsPending: Promise<void> | null = null;
let workingIndicatorsDirty = false;
function syncWorkingTabIndicators(): Promise<void> {
  workingIndicatorsDirty = true;
  workingIndicatorsPending ??= Promise.resolve().then(async () => {
    try {
      while (workingIndicatorsDirty) {
        workingIndicatorsDirty = false;
        await refreshWorkingTabIndicators();
      }
    } finally {
      workingIndicatorsPending = null;
    }
  });
  return workingIndicatorsPending;
}

async function refreshWorkingTabIndicators(): Promise<void> {
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
    chrome.debugger.sendCommand(target, method, params) as Promise<unknown>,
});

const emulation = createEmulationController({
  acquire: (tabId) => tabDebugger.acquire(tabId),
  release: (tabId) => tabDebugger.release(tabId),
  send: (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params),
});

const journals = createJournalTransport(() => state.nativePort);
const artifactTransport = createArtifactTransport(() => state.nativePort);
const recordings = createRecordingController({
  acquireReplay: (tabId) => tabDebugger.acquire(tabId),
  releaseReplay: (tabId) => tabDebugger.release(tabId),
  page: async (tabId, action, sessionId, durationMs) => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageRecorder,
      args: [action, sessionId, durationMs ?? 300000],
    });
    if (!result?.result) throw new Error('Page recorder unavailable.');
    return result.result;
  },
  childTabs: async (tabId) => {
    const root = await chrome.tabs.get(tabId);
    return (await chrome.tabs.query({ windowId: root.windowId }))
      .filter((tab) => typeof tab.id === 'number' && !isRestrictedAutomationUrl(tab.url ?? ''))
      .map((tab) => ({ id: tab.id as number, openerTabId: tab.openerTabId }));
  },
  assertTab: async (tabId) => {
    const tab = await chrome.tabs.get(tabId);
    if (
      !state.enabledWindow ||
      tab.windowId !== state.enabledWindow.windowId ||
      isRestrictedAutomationUrl(tab.url ?? '')
    )
      throw new BridgeError(ERROR_CODES.ACCESS_DENIED, 'Child tab is outside the enabled window.');
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
        const metrics = (await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics')) as {
          cssVisualViewport?: {
            pageX?: number;
            pageY?: number;
            clientWidth?: number;
            clientHeight?: number;
          };
        };
        const viewport = metrics.cssVisualViewport ?? {};
        const result = (await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
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
        })) as { data: string };
        return result.data;
      },
      { releaseAfterRun: true }
    ),
});
const downloads = createDownloadController({
  downloads: chrome.downloads,
  storage: chrome.storage.session,
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

const fetchEventFilters: Map<number, (method: string, params: unknown) => void> = new Map();
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
    chrome.debugger.sendCommand(
      target,
      method,
      params as { [key: string]: unknown }
    ) as Promise<unknown>,
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
  getCleanupFrames,
  clearCleanupFrames,
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
  listFrames: getCleanupFrames,
  clearFrames: clearCleanupFrames,
  sendFrameMessage,
  disableConsoleInterceptor,
  disableNetworkInterceptor,
  beginDebuggerCleanup: (tabId) => tabDebugger.beginCleanup(tabId),
  commitDebuggerCleanup: (tabId) => tabDebugger.commitCleanup(tabId),
  clearFetchInterception: (tabId) => fetchInterceptor.clearAllRules(tabId),
  discardFetchInterception: (tabId) => fetchInterceptor.handleDetach(tabId),
  stopCdpNetworkCapture: (tabId) => cdpNetworkCapture.stop(tabId),
  discardCdpNetworkCapture: (tabId) => cdpNetworkCapture.handleDetach(tabId),
  cancelNavigationWaitsForWindow: (windowId) => navigationWaits.cancelWindow(windowId),
  resources: [
    {
      name: 'visual baselines',
      clear: (tabId) => invalidateVisualBaselines(state.nativePort, tabId),
    },
    { name: 'DOM baselines', clear: (tabId) => domBaselines.clearTab(tabId) },
    { name: 'WebMCP', clear: (tabId) => webmcp.clearTab(tabId) },
    {
      name: 'emulation',
      clear: (tabId) => emulation.reset(tabId),
      removed: (tabId) => emulation.detached(tabId),
    },
    { name: 'downloads', clear: (tabId) => downloads.clear(tabId) },
    { name: 'staged files', clear: (tabId) => stagedFiles.clearTab(tabId) },
    {
      name: 'resource fetches',
      clear: async (tabId) => {
        if (resourceFetches.has(tabId))
          await chrome.scripting
            .executeScript({ target: { tabId }, func: cancelPageResources })
            .catch(() => {});
      },
    },
    { name: 'recordings', clear: (tabId) => recordings.clear(tabId) },
  ],
  isRecoverableInstrumentationError,
  isRestrictedAutomationUrl,
});

const clearTabBridgeState = async (
  tabId: number,
  shouldContinue?: (() => Promise<boolean>) | undefined
) => {
  await tabCleanupController.clearTabBridgeState(tabId, shouldContinue);
};

const clearWindowBridgeState = async (windowId: number) => {
  requestLifetimes.disconnect();
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
  clearRemovedTabState: tabCleanupController.clearRemovedTabState,
});

const {
  restoreEnabledWindow,
  restoreEnabledWindowAfterUpdate,
  clearEnabledWindowOnBrowserStartup,
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
  resolveRequestTarget: resolvePageRequestTarget,
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
    chrome.debugger.sendCommand(
      target,
      method,
      params as { [key: string]: unknown }
    ) as Promise<unknown>,
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

async function resolveRequestTarget(
  request: BridgeRequest,
  options?: Parameters<typeof resolvePageRequestTarget>[1]
): Promise<ResolvedTabTarget> {
  const assertActive = requestLifetimes.guard(request.id, request.meta?.deadline_ms);
  assertActive();
  const target = await resolvePageRequestTarget(request, options);
  assertActive();
  return target;
}

const mutationGate = createMutationGate({
  // Peek: the dispatched handler resolves the pinned tab again and binds it.
  resolveTarget: async (request) => {
    let via: import('./background-page.js').TabRoutingVia | undefined;
    const target = await resolveRequestTarget(request, {
      peek: true,
      onRouted: (routing) => {
        via = routing.via;
      },
    });
    return { ...target, via };
  },
  captureAccess: () => captureWindowGrant(state),
  snapshot: async (tabId, scope) => {
    tabDebugger.assertNoDialog(tabId);
    if (scope === 'tab') {
      const tab = await chrome.tabs.get(tabId);
      return { documentId: '', url: tab.url ?? '' };
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => location.href,
    });
    const result = results[0];
    if (!result?.documentId || typeof result.result !== 'string')
      throw new BridgeError(ERROR_CODES.TAB_MISMATCH, 'Mutation target has no committed document.');
    return { documentId: result.documentId, url: result.result };
  },
  send: (message) => {
    if (!state.nativePort)
      throw new BridgeError(
        ERROR_CODES.EXTENSION_DISCONNECTED,
        'Native connection disappeared while scheduling.'
      );
    state.nativePort.postMessage(message);
  },
});

const domBaselineRequests = createDomBaselineRequestHandler(domBaselines, {
  resolveRequestTarget,
  ensureContentScript,
  sendTabMessage,
  contentScriptTimeoutMs: CONTENT_SCRIPT_TIMEOUT_MS,
});

const dataRequestDependencies = {
  state,
  disconnectedDataRequests,
  resolveRequestTarget,
  storeByteArtifact,
};
const handleRecordingRequest = createRecordingRequestHandler({
  ...dataRequestDependencies,
  recordings,
  journals,
});
const handleFileRequest = createFileRequestHandler({
  ...dataRequestDependencies,
  chrome,
  stagedFiles,
  downloads,
  tabDebugger,
  ensureContentScript,
  getFrameForRef,
  sendTabMessage,
  resourceFetches,
  resourceOwners,
});

const webMcpConnections: WeakMap<chrome.runtime.Port, string> = new WeakMap();
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
  clearActionLog,
  clearActionLogForTab,
} = createActionLogController(state, chrome, {
  emitUiState,
  getCurrentTabState,
  resolveRequestTarget,
});

const { handleNativeInput } = createBackgroundInputController({
  captureAccess: () => captureWindowGrant(state),
  getTab: (tabId) => chrome.tabs.get(tabId),
  contentScriptTimeoutMs: CONTENT_SCRIPT_TIMEOUT_MS,
  runWithDebugger: (tabId, operation) => tabDebugger.runGuarded(tabId, operation),
  sendCommand: (target, method, params) => {
    if (!isNativeInputRelease(method, params)) tabDebugger.assertTaskActive(target);
    return chrome.debugger.sendCommand(target, method, params) as Promise<unknown>;
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

const developmentReload = createDevelopmentReloadController(chrome, {
  enabled: DEVELOPMENT_AUTO_RELOAD,
  sourceDigest: SOURCE_DIGEST,
});

const {
  connectNative,
  scheduleNativeReconnect,
  retryNativeConnection,
  syncNativeReconnectSchedule,
} = createNativeConnectionController(state, chrome, {
  scheduleIdleReconnect: (delayMs) => {
    void chrome.alarms
      .create(NATIVE_SETUP_RETRY_ALARM, { delayInMinutes: delayMs / 60_000 })
      .catch(reportAsyncError);
  },
  clearIdleReconnect: () => {
    void chrome.alarms.clear(NATIVE_SETUP_RETRY_ALARM).catch(reportAsyncError);
  },
  checkDevelopmentUpdate: developmentReload.checkForUpdate,
  appendActionLogEntry,
  broadcastUi,
  clearSetupStatus,
  emitUiState,
  handleBridgeRequest,
  handleHostStatusMessage: (message) => {
    if (mutationGate.handle(message)) return true;
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'host.request_cancelled'
    ) {
      if ('requestId' in message && typeof message.requestId === 'string')
        requestLifetimes.cancel(message.requestId);
      return true;
    }
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'host.owner_disconnected'
    ) {
      const ownerId =
        'ownerId' in message && typeof message.ownerId === 'string' ? message.ownerId : '';
      if (!/^[a-f0-9-]{36}$/u.test(ownerId)) return true;
      requestLifetimes.cancelOwner(ownerId);
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
    return (
      artifactTransport.handle(message) ||
      journals.handle(message) ||
      windowActions.handleMessage(message) ||
      handleHostStatusMessage(message)
    );
  },
  refreshActionIndicators,
  refreshSetupStatus,
  reply,
  handleDestinationDisconnect: () => {
    requestLifetimes.disconnect();
    artifactTransport.disconnect();
    journals.disconnect();
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

async function storeScreenshotArtifact(
  requestId: string,
  data: string,
  metadata: { mimeType: string; byteLength: number }
): Promise<import('../../../protocol/src/types.js').ArtifactDescriptor<'screenshot'>> {
  return storeByteArtifact(requestId, base64ToBytes(data), {
    kind: 'screenshot',
    mimeType: metadata.mimeType,
  });
}

async function storeByteArtifact<K extends import('../../../protocol/src/types.js').ArtifactKind>(
  requestId: string,
  bytes: Uint8Array,
  metadata: { kind: K; mimeType: string }
): Promise<import('../../../protocol/src/types.js').ArtifactDescriptor<K>> {
  const port = state.nativePort;
  const assertActive = requestLifetimes.guard(requestId);
  const send = async (message: Record<string, unknown>) => {
    assertActive();
    if (state.nativePort !== port)
      throw new BridgeError(ERROR_CODES.EXTENSION_DISCONNECTED, 'Artifact destination changed.');
    if (requestLifetimes.acknowledgesArtifacts(requestId)) await artifactTransport.send(message);
    else {
      // Older daemons do not acknowledge chunks. Yield between bounded frames
      // rather than enqueueing an entire artifact in one worker turn.
      port?.postMessage(message);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assertActive();
  };
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
  await send({
    type: 'host.artifact.begin',
    artifact: { ...descriptor, requestId },
  });
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const chunk = bytes.subarray(
      chunkIndex * ARTIFACT_CHUNK_BYTES,
      Math.min(bytes.byteLength, (chunkIndex + 1) * ARTIFACT_CHUNK_BYTES)
    );
    await send({
      type: 'host.artifact.chunk',
      artifact: { requestId },
      artifactId,
      chunkIndex,
      data: bytesToBase64(chunk),
    });
  }
  await send({
    type: 'host.artifact.commit',
    artifact: { requestId },
    artifactId,
  });
  return descriptor;
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64(value: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < value.length; offset += 32768)
    binary += String.fromCharCode(...value.subarray(offset, offset + 32768));
  return btoa(binary);
}

/** Auto execution mode: use debugger (trusted) input only when it is already
attached to the tab, or when the target likely ignores synthetic events
(file pickers, media, new-window links, rich editors). Otherwise stay on DOM
events so no debugger banner appears. */
async function chooseInputExecutionMode(
  tabId: number,
  method: string,
  params: Record<string, unknown>
): Promise<{ mode: 'dom' | 'cdp'; reason: string }> {
  if (tabDebugger.attachedTabs.has(tabId)) return { mode: 'cdp', reason: 'debugger-attached' };
  try {
    const hint = (await sendTabMessage(
      tabId,
      {
        type: 'bridge.execute',
        method: 'input.trust_hint',
        params: { method, target: params.target ?? params.source ?? null },
      },
      CONTENT_SCRIPT_TIMEOUT_MS
    )) as { needsTrusted?: boolean; reason?: string } | null;
    if (hint?.needsTrusted && typeof hint.reason === 'string') {
      return { mode: 'cdp', reason: hint.reason };
    }
  } catch {
    // Fall back to DOM input when the hint is unavailable.
  }
  return { mode: 'dom', reason: 'synthetic-dom-default' };
}

const tabBoundRequestDependencies: Parameters<typeof executeTabBoundRequest>[1] = {
  captureAccess: () => captureWindowGrant(state),
  contentScriptTimeoutMs: CONTENT_SCRIPT_TIMEOUT_MS,
  assertNoDialog: (tabId) => tabDebugger.assertNoDialog(tabId),
  runWithDialogGuard: (tabId, operation) => tabDebugger.runGuarded(tabId, operation),
  chooseInputExecutionMode,
  ensureContentScript,
  handleScreenshot: (target, method, params, requestId) =>
    (method.startsWith('screenshot.baseline.') ? captureVisualBaseline : handleScreenshot)(
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
if (DEVELOPMENT_AUTO_RELOAD) {
  void chrome.alarms
    .create(DEVELOPMENT_RELOAD_ALARM, { periodInMinutes: 1 })
    .catch(reportAsyncError);
}

chrome.runtime.onInstalled.addListener((details) => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(reportAsyncError);
  if (details.reason === 'update') {
    void accessStateInitialization.then(restoreEnabledWindowAfterUpdate).catch(reportAsyncError);
  }
});

chrome.runtime.onStartup.addListener(() => {
  void clearEnabledWindowOnBrowserStartup().catch(reportAsyncError);
  void clearActionLog().then(emitUiState).catch(reportAsyncError);
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
    mutationGate.invalidate(tabId);
    domBaselines.invalidateNavigation(tabId);
    invalidateVisualBaselines(state.nativePort, tabId);
    void webmcp.clearTab(tabId).catch(reportAsyncError);
  }
  navigationWaits.handleTabUpdated(tabId, changeInfo, tab);
  void handleTabUpdated(tabId, changeInfo, tab).catch(reportAsyncError);
});

chrome.tabs.onDetached?.addListener((tabId, detachInfo) => {
  invalidateVisualBaselines(state.nativePort, tabId);
  mutationGate.invalidate(tabId);
  void webmcp.clearTab(tabId).catch(reportAsyncError);
  tabMoveCleanup.handleDetached(tabId, detachInfo);
});

chrome.tabs.onMoved?.addListener(() => {
  void agentGroups.sync().catch(reportAsyncError);
  void emitUiState().catch(reportAsyncError);
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
  mutationGate.invalidate(tabId);
  void webmcp.clearTab(tabId).catch(reportAsyncError);
  domBaselines.clearTab(tabId);
  invalidateVisualBaselines(state.nativePort, tabId);
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
  if (alarm.name === NATIVE_SETUP_RETRY_ALARM) {
    connectNative();
    return;
  }
  if (alarm.name === DEVELOPMENT_RELOAD_ALARM) {
    void developmentReload.checkForUpdate();
  }
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
    connectNative();
    port.onMessage.addListener((message) => {
      void handleUiMessage(port, message).catch(reportAsyncError);
    });
    port.onDisconnect.addListener(() => {
      state.uiPorts.delete(port);
      syncNativeReconnectSchedule();
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
      invalidateVisualBaselines(state.nativePort, tabId);
      void webmcp.clearTab(tabId).catch(reportAsyncError);
      navigationWaits.handleSpaSignal(tabId, kind, channel);
    },
  })
);

/** Notify the daemon that this browser/profile was recently active so untargeted
access prompts can be routed to one browser instead of broadcasting. */
function sendActivityUpdate(port: chrome.runtime.Port | null = state.nativePort): void {
  sendActivityUpdateNative(port);
}

/** Notify the daemon whether this extension currently has access enabled. */
function sendAccessUpdate(enabled: boolean): void {
  sendAccessUpdateNative(enabled, state.nativePort, state.enabledWindow);
}

/** Restore persisted window access state when the service worker starts so the
current browser-run grant survives worker restarts. */
async function initializeState(): Promise<void> {
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

/** Route a validated bridge request to the extension capability that should
satisfy it. */
async function handleBridgeRequest(request: BridgeRequest): Promise<void> {
  let finish: () => void;
  try {
    finish = requestLifetimes.begin(request);
  } catch (error) {
    reply(toFailureResponse(request, error));
    return;
  }
  try {
    if (
      typeof request.meta?.transport_owner === 'string' &&
      /^(?:files\.|session\.|download\.|input\.(?:set_files|paste_image)$)/u.test(request.method)
    )
      dataRequestOwners.set(request.id, request.meta.transport_owner);
    // Capture the log context beside the command instead of before it: the
    // lookup is read-only and starts first, so it still sees the prior page.
    const actionContext = shouldLogAction(request.method)
      ? getActionContext(request).catch((error: unknown) => {
          reportAsyncError(error);
          return null;
        })
      : Promise.resolve(null);

    let response: BridgeResponse;

    try {
      request = await mutationGate.prepare(request);
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
      const loggedResponse = response;
      void actionContext
        .then((context) => logBridgeAction(request, loggedResponse, context))
        .catch(reportAsyncError);
      reply(response);
      return;
    }
    reply(response);
    dataRequestOwners.delete(request.id);
    disconnectedDataRequests.delete(request.id);
    try {
      await logBridgeAction(request, response, await actionContext);
    } catch (error) {
      reportAsyncError(error);
    }
  } finally {
    finish();
    mutationGate.release(request.id);
    dataRequestOwners.delete(request.id);
    disconnectedDataRequests.delete(request.id);
  }
}

/** Add the calling session's working tab to an access status. */
async function withWorkingTab<T extends { enabled: boolean; windowId?: number | null }>(
  request: BridgeRequest,
  access: T
): Promise<T & { workingTabId?: number }> {
  if (!access.enabled) return access;
  const lease = await agentTabs.get(normalizeAgentSession(request.meta?.agent_session));
  return lease && !lease.closed && lease.windowId === access.windowId
    ? { ...access, workingTabId: lease.tabId }
    : access;
}

/** Report where a tab-bound request ran. `active_tab_id` is included only when
the agent's working tab differs from the user's active tab, which is the
case agents need to notice. */
function attachTabRouting(request: BridgeRequest, response: BridgeResponse): BridgeResponse {
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

/** Resolve one bridge request into a structured response. */
async function dispatchBridgeRequest(request: BridgeRequest): Promise<BridgeResponse> {
  requestLifetimes.guard(request.id, request.meta?.deadline_ms)();
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
    case 'input.paste_image':
    case 'download.resource':
    case 'download.start':
    case 'download.status':
    case 'download.pause':
    case 'download.resume':
    case 'download.cancel':
    case 'download.release':
      return handleFileRequest(request);
    case 'emulation.apply':
    case 'emulation.status':
    case 'emulation.reset': {
      const target = await resolveRequestTarget(request);
      const access = state.enabledWindow;
      const port = state.nativePort;
      const assertAccess = async () => {
        if (!sameWindowGrant(access, state.enabledWindow) || state.nativePort !== port)
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
        captureAccess: () => captureWindowGrant(state),
        resolveRequestTarget,
        armNetwork: (tabId) => ensureNetworkInterceptor(tabId, chrome),
        readNetwork: (tabId, after) => readNetworkBuffer(tabId, false, chrome, true, after),
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

/** Summarize the currently open tabs in the enabled window so the client can
inspect or explicitly target them. */
async function handleListTabs(request: BridgeRequest): Promise<BridgeResponse> {
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
  const result = response.result as { tabs: Array<Record<string, unknown>> };
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

/** Make one tab the calling agent session's working tab. */
async function bindWorkingTab(
  request: BridgeRequest,
  tabId: number,
  windowId: number
): Promise<void> {
  await agentTabs.bind(normalizeAgentSession(request.meta?.agent_session), tabId, windowId);
  await syncWorkingTabIndicators();
}

/** Execute a tab-level navigation action and optionally wait for the next load
cycle to complete. */
async function handleNavigationRequest(request: BridgeRequest): Promise<BridgeResponse> {
  return executeNavigationRequest(request, {
    captureAccess: () => captureWindowGrant(state),
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

/** Evaluate a JavaScript expression in the page's main context using the
Chrome DevTools Protocol, avoiding content-script CSP restrictions. */
async function handlePageEvaluate(request: BridgeRequest): Promise<BridgeResponse> {
  return executePageEvaluate(request, {
    resolveRequestTarget,
    runWithDebugger: (tabId, operation) => tabDebugger.runGuarded(tabId, operation),
    sendCommand: (target, method, params) =>
      chrome.debugger.sendCommand(target, method, params) as Promise<unknown>,
  });
}

/** Create a new tab with an optional URL. */
async function handleCreateTab(request: BridgeRequest): Promise<BridgeResponse> {
  const response = await executeCreateTab(
    request,
    state,
    {
      createTab: (properties) => chrome.tabs.create(properties),
    },
    ACCESS_DENIED_WINDOW_OFF
  );
  if (!response.ok) return response;
  const created = response.result as { tabId?: unknown };
  if (typeof created.tabId === 'number' && state.enabledWindow) {
    await bindWorkingTab(request, created.tabId, state.enabledWindow.windowId);
    return { ...response, result: { ...created, working: true } };
  }
  return response;
}

/** Close a tab by tabId. */
async function handleCloseTab(request: BridgeRequest): Promise<BridgeResponse> {
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

async function handleFetchInterceptRequest(request: BridgeRequest) {
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
 * Agents may switch to tabs they opened while the active tab is in use for
 * their task; otherwise they need a user request or permission to take focus.
 * Tab-targeted operations do not normally require activation.
 */

async function handleActivateTab(request: BridgeRequest) {
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

async function isTabEnabled(tabId: number): Promise<boolean> {
  return isTabEnabledBadge(tabId, state, chrome);
}

/** Refresh the extension action badge and title across the currently open tabs. */
async function refreshActionIndicators(): Promise<void> {
  await refreshActionIndicatorsBadge(state, chrome, badgeDependencies);
}

/** Set the global badge (no tabId) to match the active tab in the last-focused
window. This forces browsers that batch per-tab badge updates (e.g. Edge) to
immediately repaint the toolbar icon. */
async function syncGlobalBadgeToActiveTab(): Promise<void> {
  await syncGlobalBadgeToActiveTabBadge(state, chrome, badgeDependencies);
}

/** Update the action badge and title for one tab so enabled windows are visibly
marked from the Chrome toolbar. */
async function updateActionIndicatorForTab(tabId: number): Promise<void> {
  await updateActionIndicatorForTabBadge(tabId, state, chrome, badgeDependencies);
}

async function isAccessRequestedTab(tabId: number): Promise<boolean> {
  return isAccessRequestedTabBadge(tabId, state, chrome);
}

async function openRequestedAccessUi(target: ResolvedTabTarget): Promise<void> {
  await openRequestedAccessUiUi(target, state, chrome, {
    getCurrentTabState,
    getTabState,
  });
}

async function getRequestedAccessPopupPlacement(
  targetWindowId: number,
  popupWidth: number
): Promise<Pick<chrome.windows.UpdateInfo, 'left' | 'top'> | null> {
  return getRequestedAccessPopupPlacementUi(targetWindowId, popupWidth, chrome);
}

function getUiSurfaceFromPortName(portName: string): 'popup' | 'sidepanel' | null {
  return getUiSurfaceFromPortNameUi(portName);
}

/** Forward a response to the connected native host if it is present. Falls back
to the still-stabilizing port so requests that arrive right after a
(re)connect are answered instead of silently dropped. */
function reply(response: BridgeResponse): void {
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

/** Broadcast a UI event to all connected extension surfaces. */
function broadcastUi(message: Record<string, unknown>): void {
  broadcastUiUi(state, message);
}

/** Publish the current connection/session snapshot to the popup and side panel. */
async function emitUiState(): Promise<void> {
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

/** Publish the current connection and tab snapshot to one UI surface. */
async function emitUiStateForPort(port: chrome.runtime.Port): Promise<void> {
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

/** Handle commands coming from the popup or side panel. */
async function handleUiMessage(
  port: chrome.runtime.Port,
  message: Record<string, unknown>
): Promise<void> {
  await handleUiMessageUi(state, port, message, {
    retryNativeConnection,
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

/** Describe recently targeted tabs in their left-to-right browser window order. */
async function getAgentTabState(
  windowId: number,
  currentTabId: number
): Promise<import('./background-ui.js').AgentTabUiState[]> {
  const leases = await agentTabs.listRecentTabs();
  const tabIds = [
    ...new Set(leases.filter((entry) => entry.windowId === windowId).map((entry) => entry.tabId)),
  ];
  const lastActivityByTab = new Map(leases.map((entry) => [entry.tabId, entry.lastUsedAt]));

  const actionCounts: Map<number, number> = new Map();
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
        return { ...tab, id: tabId };
      } catch {
        return null;
      }
    })
  );
  return tabs
    .filter((tab) => tab !== null)
    .sort(
      (left, right) =>
        (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER) ||
        left.id - right.id
    )
    .map((tab) => ({
      tabId: tab.id,
      title: tab.title ?? '',
      ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
      isCurrent: tab.id === currentTabId,
      actionCount: actionCounts.get(tab.id) ?? 0,
      lastActivityAt: lastActivityByTab.get(tab.id) ?? 0,
    }));
}

/** Redirect every agent session in the tab's window to that tab. This is the
user's explicit way to point an agent somewhere else, since merely switching
tabs no longer moves it. */
async function moveAgentToTab(tabId: number): Promise<void> {
  if (!state.enabledWindow) return;
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId !== state.enabledWindow.windowId) return;
  await agentTabs.rebindWindow(tab.windowId, tabId);
  await syncWorkingTabIndicators();
  await emitUiState();
}

/** Configure and open the side panel for a single tab so the panel is attached
to the current tab instead of acting like a window-global surface. */
async function openSidePanelForTab(tabId: number, windowId: number): Promise<void> {
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
