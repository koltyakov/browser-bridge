// @ts-check

import {
  CAPABILITIES,
  ERROR_CODES,
  createFailure,
  createRuntimeContext,
  createSuccess,
  normalizeAccessRequest,
  normalizeAccessibilityTreeParams,
  normalizeCheckedAction,
  normalizeConsoleParams,
  normalizeDomQuery,
  normalizeDragParams,
  normalizeEvaluateParams,
  normalizeFindByRoleParams,
  normalizeFindByTextParams,
  normalizeGetHtmlParams,
  normalizeHoverParams,
  normalizeInputAction,
  normalizeNavigationAction,
  normalizeNetworkParams,
  normalizePageTextParams,
  normalizePatchOperation,
  normalizeSelectAction,
  normalizeStorageParams,
  normalizeStyleQuery,
  normalizeTabCloseParams,
  normalizeTabCreateParams,
  normalizeViewportAction,
  normalizeViewportResizeParams,
  normalizeWaitForLoadStateParams,
  normalizeWaitForParams
} from '../../protocol/src/index.js';
import {
  estimateResponseTokens,
  getErrorMessage,
  inferCapability,
  normalizeCropRect,
  normalizeRuntimeErrorMessage,
  safeOrigin,
  shouldLogAction,
  simplifyAXNode,
  summarizeActionResult,
  summarizeTabResult
} from './background-helpers.js';
import { TabDebuggerCoordinator } from './debugger-coordinator.js';

/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */
/** @typedef {import('../../protocol/src/types.js').Capability} Capability */
/** @typedef {import('../../protocol/src/types.js').ErrorCode} ErrorCode */
/** @typedef {import('../../protocol/src/types.js').SessionState} SessionState */
/** @typedef {import('../../protocol/src/types.js').NormalizedAccessRequest} NormalizedAccessRequest */

/**
 * @typedef {{
 *   tabId: number,
 *   title: string,
 *   enabledAt: number
 * }} EnabledScope
 */

/**
 * @typedef {{
 *   id: string,
 *   at: number,
 *   method: string,
 *   tabId: number | null,
 *   url: string,
 *   ok: boolean,
 *   summary: string,
 *   responseBytes: number,
 *   approxTokens: number,
 *   hasScreenshot: boolean,
 *   nodeCount: number | null
 * }} ActionLogEntry
 */

/**
 * @typedef {{
 *   tabId: number,
 *   windowId: number,
 *   title: string,
 *   url: string,
 *   enabled: boolean
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
 * @typedef {{
 *   scopeTabId: number | null
 * }} UiPortState
 */

/**
 * @typedef {{
 *   nativePort: chrome.runtime.Port | null,
 *   sessions: Map<string, SessionState>,
 *   enabledScopes: Map<string, EnabledScope>,
 *   actionLog: ActionLogEntry[],
 *   uiPorts: Map<chrome.runtime.Port, UiPortState>
 * }} ExtensionState
 */

const NATIVE_APP_NAME = 'com.browserbridge.browser_bridge';
const CONTENT_SCRIPT_TIMEOUT_MS = 5_000;
const SCREENSHOT_TIMEOUT_MS = 10_000;
const MAX_ACTION_LOG_ENTRIES = 50;
const ENABLED_TAB_STORAGE_PREFIX = 'enabledTab:';
const ACTION_LOG_STORAGE_KEY = 'actionLog';
const SIDEPANEL_PATH = 'packages/extension/ui/sidepanel.html';
const ENABLED_BADGE_TEXT = 'AI';
const DEBUGGER_PROTOCOL_VERSION = '1.3';

/** @type {ExtensionState} */
const state = {
  nativePort: null,
  sessions: new Map(),
  enabledScopes: new Map(),
  actionLog: [],
  uiPorts: new Map()
};

const tabDebugger = new TabDebuggerCoordinator({
  attach: (target, protocolVersion) => chrome.debugger.attach(target, protocolVersion),
  detach: (target) => chrome.debugger.detach(target),
  protocolVersion: DEBUGGER_PROTOCOL_VERSION
});

void initializeState().catch(reportAsyncError);
connectNative();

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.tabs.onActivated.addListener(() => {
  void emitUiState().catch(reportAsyncError);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void handleTabUpdated(tabId, changeInfo, tab).catch(reportAsyncError);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void handleTabRemoved(tabId).catch(reportAsyncError);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'ui') {
    state.uiPorts.set(port, { scopeTabId: null });
    port.onMessage.addListener((message) => {
      void handleUiMessage(port, message).catch(reportAsyncError);
    });
    port.onDisconnect.addListener(() => {
      state.uiPorts.delete(port);
    });
    void emitUiStateForPort(port);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'bridge.open-sidepanel' && typeof message.tabId === 'number' && typeof message.windowId === 'number') {
    void openSidePanelForTab(message.tabId, message.windowId).then(() => {
      sendResponse({ ok: true });
    }).catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return true;
  }

  if (message?.type === 'bridge.open-sidepanel' && sender.tab?.id && sender.tab.windowId) {
    void openSidePanelForTab(sender.tab.id, sender.tab.windowId).then(() => {
      sendResponse({ ok: true });
    }).catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return true;
  }

  return false;
});

/**
 * Restore persisted session state when the service worker starts so client-side
 * saved sessions survive extension worker restarts.
 *
 * @returns {Promise<void>}
 */
async function initializeState() {
  await restorePersistedSessions();
  await restoreEnabledScopes();
  await restoreActionLog();
  await refreshActionIndicators();
}

/**
 * Connect the extension service worker to the local Native Messaging host and
 * fan connection state out to the popup and side panel UIs.
 *
 * @returns {void}
 */
function connectNative() {
  try {
    const candidatePort = chrome.runtime.connectNative(NATIVE_APP_NAME);
    const stabilityTimer = setTimeout(() => {
      state.nativePort = candidatePort;
      broadcastUi({ type: 'native.status', connected: true });
      void emitUiState();
    }, 500);
    candidatePort.onMessage.addListener((request) => {
      void handleBridgeRequest(request).catch(reportAsyncError);
    });
    candidatePort.onDisconnect.addListener(() => {
      clearTimeout(stabilityTimer);
      // lastError must always be read in onDisconnect to suppress the unchecked warning
      const disconnectError = chrome.runtime.lastError?.message ?? 'Native host disconnected.';
      if (state.nativePort === candidatePort) {
        state.nativePort = null;
        broadcastUi({
          type: 'native.status',
          connected: false,
          error: disconnectError
        });
      }
      setTimeout(connectNative, 2_000);
    });
  } catch (error) {
    broadcastUi({ type: 'native.status', connected: false, error: error.message });
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
  const actionContext = shouldLogAction(request.method)
    ? await getActionContext(request)
    : null;
  /** @type {BridgeResponse} */
  let response;

  try {
    response = await dispatchBridgeRequest(request);
  } catch (error) {
    response = toFailureResponse(request, error);
  }

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
      return createSuccess(request.id, { extension: 'ok' }, { method: request.method });
    case 'skill.get_runtime_context':
      return createSuccess(request.id, createRuntimeContext(), { method: request.method });
    case 'tabs.list':
      return handleListTabs(request);
    case 'tabs.create':
      return handleCreateTab(request);
    case 'tabs.close':
      return handleCloseTab(request);
    case 'session.request_access':
      return handleAccessRequest(request);
    case 'session.get_status':
      return handleSessionStatus(request);
    case 'session.revoke':
      return handleRevoke(request);
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
    case 'patch.apply_styles':
    case 'patch.apply_dom':
    case 'patch.list':
    case 'patch.rollback':
    case 'patch.commit_session_baseline':
    case 'screenshot.capture_region':
    case 'screenshot.capture_element':
      return handleTabBoundRequest(request);
    case 'cdp.get_document':
    case 'cdp.get_dom_snapshot':
    case 'cdp.get_box_model':
    case 'cdp.get_computed_styles_for_node':
      return handleCdpRequest(request);
    default:
      return createFailure(request.id, ERROR_CODES.INVALID_REQUEST, `Unhandled method ${request.method}`);
  }
}

/**
 * Create or reuse a session only when the current tab scope has been explicitly
 * enabled by the operator in the extension UI.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handleAccessRequest(request) {
  const access = await resolveAccessRequest(normalizeAccessRequest(request.params));
  const tab = await chrome.tabs.get(access.tabId);
  if (!isTabEnabled(access.tabId)) {
    const prompt = await promptForTabAccess(tab);
    return createFailure(
      request.id,
      ERROR_CODES.APPROVAL_PENDING,
      prompt.attentionSent
        ? 'Waiting for operator approval in the side panel.'
        : 'Permission request opened for the tab.',
      {
        tabId: access.tabId,
        url: tab.url ?? '',
        popupOpened: prompt.popupOpened,
        sidePanelOpened: prompt.sidePanelOpened,
        attentionSent: prompt.attentionSent
      },
      { method: request.method }
    );
  }

  const session = await createScopedSession({
    ...access,
    origin: safeOrigin(tab.url ?? '')
  });
  await emitUiState();
  return createSuccess(request.id, session, { method: request.method });
}

/**
 * Restore previously persisted enabled tab scopes into in-memory worker state.
 *
 * @returns {Promise<void>}
 */
async function restoreEnabledScopes() {
  const stored = await chrome.storage.session.get(null);

  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(ENABLED_TAB_STORAGE_PREFIX) || !value || typeof value !== 'object') {
      continue;
    }

    const scope = /** @type {EnabledScope} */ (value);
    state.enabledScopes.set(String(scope.tabId), scope);
  }
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
    state.actionLog = /** @type {ActionLogEntry[]} */ (entries);
  }
}

/**
 * Restore previously persisted sessions into the in-memory worker state so
 * access survives service-worker restarts until the tab is disabled.
 *
 * @returns {Promise<void>}
 */
async function restorePersistedSessions() {
  const stored = await chrome.storage.session.get(null);

  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith('session:') || !value || typeof value !== 'object') {
      continue;
    }

    const session = /** @type {SessionState} */ (value);
    state.sessions.set(session.sessionId, session);
  }
}

/**
 * Return the current session metadata for the requested session id.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handleSessionStatus(request) {
  const session = await getSessionById(request.session_id);
  if (!session) {
    return createFailure(request.id, ERROR_CODES.SESSION_EXPIRED, 'Session not found.', null, { method: request.method });
  }
  return createSuccess(request.id, session, { method: request.method });
}

/**
 * Revoke a previously created session.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handleRevoke(request) {
  state.sessions.delete(request.session_id);
  await chrome.storage.session.remove(`session:${request.session_id}`);
  await emitUiState();
  return createSuccess(request.id, { revoked: true }, { method: request.method });
}

/**
 * Summarize the currently open tabs so the client can choose a scope.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handleListTabs(request) {
  const tabs = await chrome.tabs.query({});
  const summarized = tabs
    .filter((tab) => typeof tab.id === 'number' && typeof tab.url === 'string')
    .map((tab) => ({
      tabId: tab.id,
      windowId: tab.windowId,
      active: Boolean(tab.active),
      title: tab.title ?? '',
      origin: safeOrigin(tab.url),
      url: tab.url
    }));
  return createSuccess(request.id, { tabs: summarized }, { method: request.method });
}

/**
 * Dispatch a tab-bound request to the content script after enforcing the
 * session scope and capability requirements.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
/** @type {Record<string, ((params: Record<string, unknown>) => Record<string, unknown>) | undefined>} */
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
  'page.get_text': normalizePageTextParams
};

async function handleTabBoundRequest(request) {
  const session = await requireSession(request, inferCapability(request.method));
  await ensureContentScript(session.tabId);
  const normalizer = TAB_BOUND_NORMALIZERS[request.method];
  const payload = normalizer ? normalizer(request.params) : request.params;

  if (request.method.startsWith('screenshot.')) {
    const result = await handleScreenshot(session, request.method, request.params);
    return createSuccess(request.id, result, { method: request.method });
  }

  const timeoutMs = getContentScriptTimeout(request.method, payload);
  const response = await sendTabMessage(session.tabId, {
    type: 'bridge.execute',
    method: request.method,
    params: payload,
    session
  }, timeoutMs);
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
  const session = await requireSession(request, inferCapability(request.method));
  const action = normalizeNavigationAction(request.params);

  if (request.method === 'navigation.navigate') {
    if (!action.url) {
      throw new Error(ERROR_CODES.INVALID_REQUEST);
    }
    await chrome.tabs.update(session.tabId, { url: action.url });
  } else if (request.method === 'navigation.reload') {
    await chrome.tabs.reload(session.tabId);
  } else if (request.method === 'navigation.go_back') {
    await chrome.tabs.goBack(session.tabId);
  } else {
    await chrome.tabs.goForward(session.tabId);
  }

  const tab = action.waitForLoad
    ? await waitForTabComplete(session.tabId, action.timeoutMs)
    : await chrome.tabs.get(session.tabId);

  if (tab.url) {
    await syncTabSessionsOrigin(session.tabId, tab.url);
  }
  await emitUiState();

  return createSuccess(request.id, summarizeTabResult(tab, request.method), { method: request.method });
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
  const session = await requireSession(request, CAPABILITIES.PAGE_EVALUATE);
  const params = normalizeEvaluateParams(request.params);
  if (!params.expression) {
    return createFailure(request.id, ERROR_CODES.INVALID_REQUEST, 'expression is required.', null, { method: request.method });
  }
  return tabDebugger.run(session.tabId, async (target) => {
    const result = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: params.expression,
      returnByValue: params.returnByValue,
      awaitPromise: params.awaitPromise,
      timeout: params.timeoutMs,
      userGesture: true,
      generatePreview: false,
      replMode: true
    });
    const cdpResult = /** @type {{ result?: { type?: string, value?: unknown, description?: string }, exceptionDetails?: { text?: string, exception?: { description?: string } } }} */ (result);
    if (cdpResult.exceptionDetails) {
      const errText = cdpResult.exceptionDetails.exception?.description
        || cdpResult.exceptionDetails.text
        || 'Evaluation failed.';
      return createFailure(request.id, ERROR_CODES.INTERNAL_ERROR, errText, null, { method: request.method });
    }
    return createSuccess(request.id, {
      value: cdpResult.result?.value ?? null,
      type: cdpResult.result?.type ?? 'undefined'
    }, { method: request.method });
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
  const session = await requireSession(request, CAPABILITIES.PAGE_READ);
  const params = normalizeConsoleParams(request.params);

  await ensureConsoleInterceptor(session.tabId);

  const entries = await readConsoleBuffer(session.tabId, params.clear);
  const filtered = params.level === 'all'
    ? entries
    : entries.filter((/** @type {{ level: string }} */ e) => e.level === params.level);
  const limited = filtered.slice(-params.limit);

  return createSuccess(request.id, { entries: limited, count: limited.length, total: entries.length }, { method: request.method });
}

/**
 * Create a new tab with an optional URL.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handleCreateTab(request) {
  const params = normalizeTabCreateParams(request.params);
  const tab = await chrome.tabs.create({ url: params.url, active: params.active });
  return createSuccess(request.id, summarizeTabResult(tab, request.method), { method: request.method });
}

/**
 * Close a tab by tabId.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handleCloseTab(request) {
  const params = normalizeTabCloseParams(request.params);
  await chrome.tabs.remove(params.tabId);
  return createSuccess(request.id, { closed: true, tabId: params.tabId }, { method: request.method });
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
  const session = await requireSession(request, CAPABILITIES.DOM_READ);
  const params = normalizeAccessibilityTreeParams(request.params);
  return tabDebugger.run(session.tabId, async (target) => {
    await chrome.debugger.sendCommand(target, 'Accessibility.enable', {});
    const result = await chrome.debugger.sendCommand(target, 'Accessibility.getFullAXTree', {
      depth: params.maxDepth
    });
    const cdpResult = /** @type {{ nodes?: Array<Record<string, unknown>> }} */ (result);
    const rawNodes = cdpResult.nodes || [];
    const pruned = rawNodes.slice(0, params.maxNodes).map(simplifyAXNode);
    await chrome.debugger.sendCommand(target, 'Accessibility.disable', {});
    return createSuccess(request.id, {
      nodes: pruned,
      count: pruned.length,
      total: rawNodes.length,
      truncated: rawNodes.length > params.maxNodes
    }, { method: request.method });
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
  const session = await requireSession(request, CAPABILITIES.PAGE_READ);
  const params = normalizeNetworkParams(request.params);
  await ensureNetworkInterceptor(session.tabId);
  const entries = await readNetworkBuffer(session.tabId, params.clear);
  const filtered = params.urlPattern
    ? entries.filter((/** @type {{ url: string }} */ e) => e.url.includes(params.urlPattern))
    : entries;
  const limited = filtered.slice(-params.limit);
  return createSuccess(request.id, { entries: limited, count: limited.length, total: entries.length }, { method: request.method });
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
      const MAX = 200;

      const origFetch = globalThis.fetch;
      // @ts-ignore - intentional main-world global override
      globalThis.fetch = async function (...args) {
        // @ts-ignore
        const req = new Request(...args);
        const entry = { method: req.method, url: req.url, status: 0, duration: 0, type: 'fetch', ts: Date.now(), size: 0 };
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
          if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
        }
      };

      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        // @ts-ignore - stashing method/url for XHR interception
        this.__bb_method = method;
        // @ts-ignore
        this.__bb_url = String(url);
        return origOpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function (...args) {
        // @ts-ignore
        const entry = { method: this.__bb_method || 'GET', url: this.__bb_url || '', status: 0, duration: 0, type: 'xhr', ts: Date.now(), size: 0 };
        const startTime = performance.now();
        this.addEventListener('loadend', () => {
          entry.status = this.status;
          entry.duration = Math.round(performance.now() - startTime);
          const cl = this.getResponseHeader('content-length');
          if (cl) entry.size = Number(cl);
          buffer.push(entry);
          if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
        });
        return origSend.apply(this, args);
      };
    }
  });
}

/**
 * Read and optionally clear the network buffer from the page's main world.
 *
 * @param {number} tabId
 * @param {boolean} clear
 * @returns {Promise<Array<{method: string, url: string, status: number, duration: number, type: string, ts: number, size: number}>>}
 */
async function readNetworkBuffer(tabId, clear) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (shouldClear) => {
      // @ts-ignore
      const buf = globalThis.__bb_network_buffer || [];
      const copy = [...buf];
      // @ts-ignore
      if (shouldClear) globalThis.__bb_network_buffer = [];
      return copy;
    },
    args: [clear]
  });
  return /** @type {any} */ (results?.[0]?.result) || [];
}

/**
 * Resize the browser viewport via CDP Emulation.setDeviceMetricsOverride
 * or reset to natural size when width/height are 0.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handleViewportResize(request) {
  const session = await requireSession(request, CAPABILITIES.VIEWPORT_CONTROL);
  const params = normalizeViewportResizeParams(request.params);
  return tabDebugger.run(session.tabId, async (target) => {
    if (params.reset || (params.width === 0 && params.height === 0)) {
      await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride', {});
    } else {
      await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
        width: params.width,
        height: params.height,
        deviceScaleFactor: params.deviceScaleFactor,
        mobile: params.width < 768
      });
    }
    return createSuccess(request.id, {
      width: params.width,
      height: params.height,
      deviceScaleFactor: params.deviceScaleFactor,
      reset: params.reset
    }, { method: request.method });
  });
}

/**
 * Return browser performance metrics via CDP Performance.getMetrics.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handlePerformanceMetrics(request) {
  const session = await requireSession(request, CAPABILITIES.PAGE_READ);
  return tabDebugger.run(session.tabId, async (target) => {
    await chrome.debugger.sendCommand(target, 'Performance.enable', { timeDomain: 'timeTicks' });
    const result = await chrome.debugger.sendCommand(target, 'Performance.getMetrics', {});
    await chrome.debugger.sendCommand(target, 'Performance.disable', {});
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
  const session = await requireSession(request, CAPABILITIES.PAGE_READ);
  const params = normalizeWaitForLoadStateParams(request.params);
  const tab = params.waitForLoad
    ? await waitForTabComplete(session.tabId, params.timeoutMs)
    : await chrome.tabs.get(session.tabId);
  if (tab.url) {
    await syncTabSessionsOrigin(session.tabId, tab.url);
  }
  return createSuccess(request.id, summarizeTabResult(tab, request.method), { method: request.method });
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
      const MAX = 200;
      const orig = /** @type {Record<string, Function>} */ ({});
      for (const level of ['log', 'warn', 'error', 'info', 'debug']) {
        orig[level] = /** @type {any} */ (console)[level];
        /** @type {any} */ (console)[level] = function (...args) {
          buffer.push({
            level,
            args: args.map((a) => {
              try { return typeof a === 'object' ? JSON.stringify(a).slice(0, 500) : String(a).slice(0, 500); }
              catch { return String(a).slice(0, 500); }
            }),
            ts: Date.now()
          });
          if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
          orig[level].apply(console, args);
        };
      }
      globalThis.addEventListener('error', (e) => {
        buffer.push({
          level: 'exception',
          args: [e.message || 'Unknown error', e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : ''],
          ts: Date.now()
        });
        if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
      });
      globalThis.addEventListener('unhandledrejection', (e) => {
        buffer.push({
          level: 'rejection',
          args: [String(e.reason).slice(0, 500)],
          ts: Date.now()
        });
        if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
      });
    }
  });
}

/**
 * Read and optionally clear the console buffer from the page's main world.
 *
 * @param {number} tabId
 * @param {boolean} clear
 * @returns {Promise<Array<{level: string, args: string[], ts: number}>>}
 */
async function readConsoleBuffer(tabId, clear) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (shouldClear) => {
      // @ts-ignore
      const buf = globalThis.__bb_console_buffer || [];
      const copy = [...buf];
      // @ts-ignore
      if (shouldClear) globalThis.__bb_console_buffer = [];
      return copy;
    },
    args: [clear]
  });
  return /** @type {any} */ (results?.[0]?.result) || [];
}

/**
 * Capture a targeted screenshot for the current session by asking the content
 * script for an element rect and then cropping the visible tab image.
 *
 * @param {SessionState} session
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @returns {Promise<{ rect: unknown, image: string }>}
 */
async function handleScreenshot(session, method, params) {
  /** @type {{ x: number, y: number, width: number, height: number, scale: number }} */
  let clip;

  if (method === 'screenshot.capture_element') {
    await ensureContentScript(session.tabId);
    try {
      clip = await sendTabMessage(session.tabId, {
        type: 'bridge.execute', method, params, session
      }, CONTENT_SCRIPT_TIMEOUT_MS);
    } catch (err) {
      // Retry once after a brief pause - the page may have been mid-render
      if (err instanceof Error && /stale/i.test(err.message)) {
        await new Promise(r => setTimeout(r, 250));
        clip = await sendTabMessage(session.tabId, {
          type: 'bridge.execute', method, params, session
        }, CONTENT_SCRIPT_TIMEOUT_MS);
      } else {
        throw err;
      }
    }
    // Defensively coerce content-script values — NaN / undefined / negative
    // would slip past the < 1 guard and reach CDP as invalid values.
    clip = {
      x: Math.max(0, Number(clip.x) || 0),
      y: Math.max(0, Number(clip.y) || 0),
      width: Math.max(0, Number(clip.width) || 0),
      height: Math.max(0, Number(clip.height) || 0),
      scale: Number(clip.scale) || 1
    };
  } else {
    // capture_region: params already carry viewport coordinates
    const scale = Number(params.scale) || 1;
    clip = {
      x: Number(params.x) || 0,
      y: Number(params.y) || 0,
      width: Math.max(1, Number(params.width) || 1),
      height: Math.max(1, Number(params.height) || 1),
      scale
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
  return tabDebugger.run(session.tabId, async (target) => {
    const dpr = clip.scale || 1;
    const cdpResult = /** @type {{ data?: string }} */ (
      await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
        format: 'png',
        clip: {
          x: Math.max(0, clip.x),
          y: Math.max(0, clip.y),
          width: clip.width,
          height: clip.height,
          scale: dpr
        },
        captureBeyondViewport: false
      })
    );
    if (!cdpResult?.data) {
      throw new Error('CDP Page.captureScreenshot returned empty data.');
    }
    return {
      rect: clip,
      image: `data:image/png;base64,${cdpResult.data}`
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
  return Promise.race([
    chrome.tabs.sendMessage(tabId, message),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for content script response after ${timeoutMs}ms.`)), timeoutMs);
    })
  ]);
}

/**
 * Race a promise against a timeout, throwing on expiry.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    })
  ]);
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
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        'packages/extension/src/content-script-helpers.js',
        'packages/extension/src/content-script.js'
      ]
    });
  }
}

/**
 * Crop a full-tab screenshot down to the requested rectangle.
 *
 * @param {{ image: string, rect: Record<string, unknown> }} input
 * @returns {Promise<string>}
 */
async function cropImage({ image, rect }) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({
    type: 'bridge.crop-image',
    image,
    rect
  });
}

/**
 * Lazily create the offscreen document used for screenshot cropping.
 *
 * @returns {Promise<void>}
 */
async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: 'packages/extension/ui/offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Crop targeted screenshots for token-efficient capture.'
  });
}

/**
 * Execute a restricted Chrome DevTools Protocol request against the enabled
 * tab.
 *
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
async function handleCdpRequest(request) {
  const session = await requireSession(request, inferCapability(request.method));
  return tabDebugger.run(session.tabId, async (target) => {
    let command;
    let params = {};
    if (request.method === 'cdp.get_document') {
      command = 'DOM.getDocument';
      params = { depth: 2, pierce: false };
    } else if (request.method === 'cdp.get_dom_snapshot') {
      command = 'DOMSnapshot.captureSnapshot';
      params = { computedStyles: request.params?.computedStyles ?? [] };
    } else if (request.method === 'cdp.get_box_model') {
      command = 'DOM.getBoxModel';
      params = { nodeId: request.params?.nodeId };
    } else {
      command = 'CSS.getComputedStyleForNode';
      params = { nodeId: request.params?.nodeId };
    }
    const result = await chrome.debugger.sendCommand(
      target,
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
      reject(new Error(`Timed out waiting for tab ${tabId} to finish loading after ${timeoutMs}ms.`));
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
 * Validate that a request belongs to an active session and that the
 * tab still matches the stored origin/capability scope.
 *
 * @param {BridgeRequest} request
 * @param {Capability | null} capability
 * @returns {Promise<SessionState>}
 */
async function requireSession(request, capability) {
  const session = await getSessionById(request.session_id);
  if (!session) {
    if (request.session_id) {
      state.sessions.delete(request.session_id);
      await chrome.storage.session.remove(`session:${request.session_id}`);
    }
    throw new Error(ERROR_CODES.SESSION_EXPIRED);
  }

  const tab = await chrome.tabs.get(session.tabId);
  if (!isTabEnabled(session.tabId)) {
    throw new Error(ERROR_CODES.ACCESS_DENIED);
  }

  if (capability && !session.capabilities.includes(capability)) {
    throw new Error(ERROR_CODES.CAPABILITY_MISSING);
  }

  const currentOrigin = safeOrigin(tab.url ?? '');
  if (currentOrigin && session.origin !== currentOrigin) {
    session.origin = currentOrigin;
    state.sessions.set(session.sessionId, session);
    await chrome.storage.session.set({
      [`session:${session.sessionId}`]: session
    });
  }

  return session;
}

/**
 * Read a session from memory first, then fall back to persisted worker storage.
 *
 * @param {string | null} sessionId
 * @returns {Promise<SessionState | null>}
 */
async function getSessionById(sessionId) {
  if (!sessionId) {
    return null;
  }

  const inMemory = state.sessions.get(sessionId);
  if (inMemory) {
    return inMemory;
  }

  const stored = await chrome.storage.session.get(`session:${sessionId}`);
  const session = stored[`session:${sessionId}`];
  if (!session || typeof session !== 'object') {
    return null;
  }

  const typedSession = /** @type {SessionState} */ (session);
  state.sessions.set(typedSession.sessionId, typedSession);
  return typedSession;
}

/**
 * Create a new scoped session or reuse one that already covers the requested
 * tab, origin, and capabilities.
 *
 * @param {NormalizedAccessRequest} access
 * @returns {Promise<SessionState>}
 */
async function createScopedSession(access) {
  for (const session of state.sessions.values()) {
    if (
      session.tabId === access.tabId &&
      access.capabilities.every((capability) => session.capabilities.includes(capability))
    ) {
      if (session.origin !== access.origin) {
        session.origin = access.origin;
        state.sessions.set(session.sessionId, session);
        await chrome.storage.session.set({
          [`session:${session.sessionId}`]: session
        });
      }
      return session;
    }
  }

  const sessionId = crypto.randomUUID();
  const session = {
    sessionId,
    tabId: access.tabId,
    origin: access.origin,
    capabilities: access.capabilities,
    expiresAt: Date.now() + access.ttlMs
  };
  state.sessions.set(sessionId, session);
  await chrome.storage.session.set({
    [`session:${sessionId}`]: session
  });
  return session;
}

/**
 * Fill in missing tab or origin fields from the current active tab so the CLI
 * can request access without forcing the user to pass identifiers manually.
 *
 * @param {ReturnType<typeof normalizeAccessRequest>} access
 * @returns {Promise<ReturnType<typeof normalizeAccessRequest>>}
 */
async function resolveAccessRequest(access) {
  if (access.tabId && access.origin) {
    return access;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab?.id || !activeTab.url) {
    throw new Error(ERROR_CODES.TAB_MISMATCH);
  }

  return {
    ...access,
    tabId: access.tabId ?? activeTab.id,
    origin: access.origin || safeOrigin(activeTab.url)
  };
}

/**
 * Resolve the current active tab in the last-focused window so the popup and
 * side panel can reflect and toggle its bridge enablement state.
 *
 * @returns {Promise<CurrentTabState | null>}
 */
async function getCurrentTabState() {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab?.id || typeof activeTab.windowId !== 'number' || !activeTab.url) {
    return null;
  }

  return {
    tabId: activeTab.id,
    windowId: activeTab.windowId,
    title: activeTab.title ?? '',
    url: activeTab.url,
    enabled: isTabEnabled(activeTab.id)
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
      enabled: isTabEnabled(tab.id)
    };
  } catch {
    return null;
  }
}

/**
 * Enable or disable bridge communication for the active tab. Disabling also
 * revokes any live sessions bound to that tab.
 *
 * @param {boolean} enabled
 * @returns {Promise<void>}
 */
async function setCurrentTabEnabled(enabled) {
  const currentTab = await getCurrentTabState();
  if (!currentTab?.url) {
    throw new Error(ERROR_CODES.TAB_MISMATCH);
  }

  await setTabEnabled(currentTab.tabId, currentTab.title, enabled);
}

/**
 * Enable or disable bridge communication for one specific tab.
 *
 * @param {number} tabId
 * @param {string} title
 * @param {boolean} enabled
 * @returns {Promise<void>}
 */
async function setTabEnabled(tabId, title, enabled) {
  const scope = {
    tabId,
    title,
    enabledAt: Date.now()
  };

  if (enabled) {
    state.enabledScopes.set(String(scope.tabId), scope);
    await chrome.storage.session.set({
      [`${ENABLED_TAB_STORAGE_PREFIX}${scope.tabId}`]: scope
    });
  } else {
    await disableTab(scope.tabId);
  }

  await updateActionIndicatorForTab(scope.tabId);
  await emitUiState();
}

/**
 * Remove one enabled tab and revoke all sessions that are bound to it.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function disableTab(tabId) {
  state.enabledScopes.delete(String(tabId));
  await chrome.storage.session.remove(`${ENABLED_TAB_STORAGE_PREFIX}${tabId}`);
  await revokeSessionsForScope(tabId, null);
  await updateActionIndicatorForTab(tabId);
}

/**
 * Revoke sessions for one tab.
 *
 * @param {number} tabId
 * @param {string | null} _origin
 * @returns {Promise<void>}
 */
async function revokeSessionsForScope(tabId, _origin) {
  /** @type {string[]} */
  const storageKeys = [];

  for (const [sessionId, session] of state.sessions.entries()) {
    if (session.tabId !== tabId) {
      continue;
    }

    state.sessions.delete(sessionId);
    storageKeys.push(`session:${sessionId}`);
  }

  if (storageKeys.length) {
    await chrome.storage.session.remove(storageKeys);
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
  if (typeof changeInfo.title === 'string' && isTabEnabled(tabId)) {
    const enabledTab = state.enabledScopes.get(String(tabId));
    if (enabledTab) {
      enabledTab.title = changeInfo.title;
      state.enabledScopes.set(String(tabId), enabledTab);
      await chrome.storage.session.set({
        [`${ENABLED_TAB_STORAGE_PREFIX}${tabId}`]: enabledTab
      });
    }
  }

  if (typeof changeInfo.url === 'string' || typeof changeInfo.title === 'string' || changeInfo.status === 'complete') {
    if (tab.url) {
      await syncTabSessionsOrigin(tabId, tab.url);
    }
    await updateActionIndicatorForTab(tabId);
    await emitUiState();
  }
}

/**
 * Remove any persisted enablement and live sessions when a tab closes.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function handleTabRemoved(tabId) {
  await disableTab(tabId);
  await emitUiState();
}

/**
 * Refresh the extension action badge and title across the currently open tabs.
 *
 * @returns {Promise<void>}
 */
async function refreshActionIndicators() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs
    .filter((tab) => typeof tab.id === 'number')
    .map((tab) => updateActionIndicatorForTab(tab.id)));
}

/**
 * Update the action badge and title for one tab so enabled scopes are visibly
 * marked from the Chrome toolbar.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function updateActionIndicatorForTab(tabId) {
  const enabled = isTabEnabled(tabId);
  try {
    if (enabled) {
      await chrome.action.setBadgeBackgroundColor({
        tabId,
        color: '#787878'
      });
      await chrome.action.setBadgeTextColor({
        tabId,
        color: '#ffffff'
      });
    }
    await chrome.action.setBadgeText({
      tabId,
      text: enabled ? ENABLED_BADGE_TEXT : ''
    });
  } catch (error) {
    if (normalizeRuntimeErrorMessage(getErrorMessage(error)) === ERROR_CODES.TAB_MISMATCH) {
      return;
    }
    throw error;
  }
}

/**
 * Check whether the user explicitly enabled bridge communication for a given
 * tab.
 *
 * @param {number} tabId
 * @returns {boolean}
 */
function isTabEnabled(tabId) {
  return state.enabledScopes.has(String(tabId));
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
    if (request.method === 'session.request_access') {
      const access = await resolveAccessRequest(normalizeAccessRequest(request.params));
      const tab = await chrome.tabs.get(access.tabId);
      return {
        tabId: access.tabId,
        url: tab.url ?? ''
      };
    }

    const session = await getSessionById(request.session_id);
    if (!session) {
      return null;
    }

    const tab = await chrome.tabs.get(session.tabId);

    return {
      tabId: session.tabId,
      url: tab.url ?? ''
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

  const tokenEstimate = estimateResponseTokens(response);

  state.actionLog = [
    ...state.actionLog,
    {
      id: crypto.randomUUID(),
      at: Date.now(),
      method: request.method,
      tabId: actionContext?.tabId ?? null,
      url: actionContext?.url ?? '',
      ok: response.ok,
      summary: summarizeActionResult(response),
      responseBytes: tokenEstimate.responseBytes,
      approxTokens: tokenEstimate.approxTokens,
      hasScreenshot: tokenEstimate.hasScreenshot,
      nodeCount: tokenEstimate.nodeCount
    }
  ].slice(-MAX_ACTION_LOG_ENTRIES);

  await chrome.storage.session.set({
    [ACTION_LOG_STORAGE_KEY]: state.actionLog
  });
  await emitUiState();
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

  return createFailure(request.id, code, message, null, { method: request.method });
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
    port.postMessage(message);
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

  const currentTab = portState.scopeTabId
    ? await getTabState(portState.scopeTabId)
    : await getCurrentTabState();
  const scopedTabId = currentTab?.tabId ?? portState.scopeTabId ?? null;

  port.postMessage({
    type: 'state.sync',
    state: {
      nativeConnected: Boolean(state.nativePort),
      currentTab,
      actionLog: [...state.actionLog]
        .filter((entry) => scopedTabId == null || entry.tabId === scopedTabId)
        .reverse()
    }
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
  if (message?.type === 'state.request') {
    const scopeTabId = Number(message.scopeTabId);
    state.uiPorts.set(port, {
      scopeTabId: Number.isFinite(scopeTabId) && scopeTabId > 0 ? scopeTabId : null
    });
    await emitUiStateForPort(port);
    return;
  }

  if (message?.type === 'scope.set_enabled') {
    const requestedTabId = Number(message.tabId);
    if (Number.isFinite(requestedTabId) && requestedTabId > 0) {
      const tabState = await getTabState(requestedTabId);
      if (!tabState) {
        throw new Error(ERROR_CODES.TAB_MISMATCH);
      }
      await setTabEnabled(tabState.tabId, tabState.title, Boolean(message.enabled));
    } else {
      await setCurrentTabEnabled(Boolean(message.enabled));
    }
    return;
  }
}

/**
 * Keep stored session origins in sync with the tab's current URL so bridge
 * results stay descriptive after in-tab navigation.
 *
 * @param {number} tabId
 * @param {string} url
 * @returns {Promise<void>}
 */
async function syncTabSessionsOrigin(tabId, url) {
  const currentOrigin = safeOrigin(url);
  if (!currentOrigin) {
    return;
  }

  /** @type {Record<string, SessionState>} */
  const updated = {};

  for (const session of state.sessions.values()) {
    if (session.tabId !== tabId || session.origin === currentOrigin) {
      continue;
    }

    session.origin = currentOrigin;
    state.sessions.set(session.sessionId, session);
    updated[`session:${session.sessionId}`] = session;
  }

  if (Object.keys(updated).length) {
    await chrome.storage.session.set(updated);
  }
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
    enabled: true
  });
  await chrome.sidePanel.open({
    tabId,
    windowId
  });
}

/**
 * Timestamps of the most recent access prompt per tab so repeated agent
 * retries do not keep reopening the popup or side panel.
 *
 * @type {Map<number, number>}
 */
const recentAccessPrompts = new Map();

/** Stale prompt threshold – 90 seconds. */
const ACCESS_PROMPT_COOLDOWN_MS = 90_000;

/**
 * Ask the operator to grant bridge access for one tab by surfacing the popup,
 * with the tab-scoped side panel as a fallback when popup opening is blocked.
 *
 * On retries (within the cooldown window) or when a side panel is already
 * connected, the function sends an attention pulse to the open UI instead of
 * reopening the popup.
 *
 * @param {chrome.tabs.Tab} tab
 * @returns {Promise<{ popupOpened: boolean, sidePanelOpened: boolean, attentionSent: boolean }>}
 */
async function promptForTabAccess(tab) {
  let popupOpened = false;
  let sidePanelOpened = false;
  let attentionSent = false;

  if (typeof tab.id === 'number' && typeof tab.windowId === 'number') {
    if (!tab.active) {
      await chrome.tabs.update(tab.id, { active: true });
    }

    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});

    const hasUiPort = state.uiPorts.size > 0;
    const lastPrompt = recentAccessPrompts.get(tab.id);
    const isRetry = lastPrompt != null && (Date.now() - lastPrompt) < ACCESS_PROMPT_COOLDOWN_MS;

    if (hasUiPort) {
      // Side panel already open – draw attention instead of opening popup.
      broadcastAttention(tab.id);
      attentionSent = true;
    } else if (isRetry) {
      // Already prompted recently – open side panel as a gentler nudge.
      await openSidePanelForTab(tab.id, tab.windowId);
      sidePanelOpened = true;
    } else {
      try {
        await chrome.action.openPopup({ windowId: tab.windowId });
        popupOpened = true;
      } catch {
        await openSidePanelForTab(tab.id, tab.windowId);
        sidePanelOpened = true;
      }
    }

    recentAccessPrompts.set(tab.id, Date.now());
  }

  return { popupOpened, sidePanelOpened, attentionSent };
}

/**
 * Send an attention pulse to every connected UI port that is scoped to the
 * given tab (or globally scoped).
 *
 * @param {number} tabId
 * @returns {void}
 */
function broadcastAttention(tabId) {
  for (const [port, portState] of state.uiPorts) {
    if (portState.scopeTabId == null || portState.scopeTabId === tabId) {
      port.postMessage({ type: 'attention.request', tabId });
    }
  }
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
