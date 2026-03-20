// @ts-check

import {
  CAPABILITIES,
  ERROR_CODES,
  createFailure,
  createRuntimeContext,
  createSuccess,
  normalizeAccessRequest,
  normalizeInputAction,
  normalizePatchOperation,
  normalizeStyleQuery
} from '../../protocol/src/index.js';

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
 *   summary: string
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

const NATIVE_APP_NAME = 'com.codex.browser_bridge';
const CONTENT_SCRIPT_TIMEOUT_MS = 5_000;
const MAX_ACTION_LOG_ENTRIES = 50;
const ENABLED_TAB_STORAGE_PREFIX = 'enabledTab:';
const ACTION_LOG_STORAGE_KEY = 'actionLog';
const SIDEPANEL_PATH = 'packages/extension/ui/sidepanel.html';
const ENABLED_BADGE_TEXT = 'AI';

/** @type {ExtensionState} */
const state = {
  nativePort: null,
  sessions: new Map(),
  enabledScopes: new Map(),
  actionLog: [],
  uiPorts: new Map()
};

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
    state.nativePort = chrome.runtime.connectNative(NATIVE_APP_NAME);
    state.nativePort.onMessage.addListener((request) => {
      void handleBridgeRequest(request).catch(reportAsyncError);
    });
    state.nativePort.onDisconnect.addListener(() => {
      state.nativePort = null;
      broadcastUi({
        type: 'native.status',
        connected: false,
        error: chrome.runtime.lastError?.message ?? 'Native host disconnected.'
      });
      setTimeout(connectNative, 2_000);
    });
    broadcastUi({ type: 'native.status', connected: true });
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
    case 'session.request_access':
      return handleAccessRequest(request);
    case 'session.get_status':
      return handleSessionStatus(request);
    case 'session.revoke':
      return handleRevoke(request);
    case 'dom.query':
    case 'dom.describe':
    case 'dom.get_text':
    case 'dom.get_attributes':
    case 'layout.get_box_model':
    case 'layout.hit_test':
    case 'styles.get_computed':
    case 'styles.get_matched_rules':
    case 'input.click':
    case 'input.focus':
    case 'input.type':
    case 'input.press_key':
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
      'Permission request opened for the tab.',
      {
        tabId: access.tabId,
        url: tab.url ?? '',
        popupOpened: prompt.popupOpened,
        sidePanelOpened: prompt.sidePanelOpened
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
async function handleTabBoundRequest(request) {
  const session = await requireSession(request, inferCapability(request.method));
  await ensureContentScript(session.tabId);
  const payload = request.method.startsWith('styles.')
    ? normalizeStyleQuery(request.params)
    : request.method.startsWith('input.')
      ? normalizeInputAction(request.params)
    : request.method.startsWith('patch.')
      ? normalizePatchOperation(request.params)
      : request.params;

  if (request.method.startsWith('screenshot.')) {
    const result = await handleScreenshot(session, request.method, request.params);
    return createSuccess(request.id, result, { method: request.method });
  }

  const response = await sendTabMessage(session.tabId, {
    type: 'bridge.execute',
    method: request.method,
    params: payload,
    session
  }, CONTENT_SCRIPT_TIMEOUT_MS);
  if (response?.error) {
    return toFailureResponse(request, response.error);
  }
  return createSuccess(request.id, response, { method: request.method });
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
  await ensureContentScript(session.tabId);
  const rect = method === 'screenshot.capture_element'
    ? await sendTabMessage(session.tabId, {
      type: 'bridge.execute',
      method,
      params,
      session
    }, CONTENT_SCRIPT_TIMEOUT_MS)
    : params;

  const tab = await chrome.tabs.get(session.tabId);
  const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const cropped = await cropImage({ image, rect: normalizeCropRect(rect) });
  return {
    rect,
    image: cropped
  };
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
      files: ['packages/extension/src/content-script.js']
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
  const target = { tabId: session.tabId };
  await chrome.debugger.attach(target, '1.3');

  try {
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
  } finally {
    await chrome.debugger.detach(target);
  }
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
  if (enabled) {
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: '#8e331a'
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
 * Decide whether a bridge method should appear in the operator-facing action
 * log.
 *
 * @param {string} method
 * @returns {boolean}
 */
function shouldLogAction(method) {
  return ![
    'health.ping',
    'log.tail',
    'skill.get_runtime_context',
    'tabs.list',
    'session.get_status'
  ].includes(method);
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

  state.actionLog = [
    ...state.actionLog,
    {
      id: crypto.randomUUID(),
      at: Date.now(),
      method: request.method,
      tabId: actionContext?.tabId ?? null,
      url: actionContext?.url ?? '',
      ok: response.ok,
      summary: summarizeActionResult(response)
    }
  ].slice(-MAX_ACTION_LOG_ENTRIES);

  await chrome.storage.session.set({
    [ACTION_LOG_STORAGE_KEY]: state.actionLog
  });
  await emitUiState();
}

/**
 * Turn one bridge response into a short human-readable log line.
 *
 * @param {BridgeResponse} response
 * @returns {string}
 */
function summarizeActionResult(response) {
  if (!response.ok) {
    return response.error.message;
  }

  const result = response.result && typeof response.result === 'object'
    ? /** @type {Record<string, unknown>} */ (response.result)
    : {};

  if (typeof result.patchId === 'string') {
    return `Patch ${result.patchId} applied.`;
  }

  if (Array.isArray(result.nodes)) {
    return `${result.nodes.length} node(s) returned.`;
  }

  if (result.revoked === true) {
    return 'Session revoked.';
  }

  if (typeof result.sessionId === 'string') {
    return 'Session ready.';
  }

  if (typeof result.image === 'string') {
    return 'Partial screenshot captured.';
  }

  return 'Completed successfully.';
}

/**
 * Map thrown runtime errors to structured bridge failures.
 *
 * @param {BridgeRequest} request
 * @param {unknown} error
 * @returns {BridgeResponse}
 */
function toFailureResponse(request, error) {
  const message = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : 'Unexpected extension error.';
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
 * Normalize screenshot crop coordinates into positive integer pixel bounds.
 *
 * @param {{ x?: number, y?: number, width?: number, height?: number, scale?: number }} [rect={}]
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function normalizeCropRect(rect = {}) {
  const scale = Number(rect.scale) || 1;
  return {
    x: Math.max(0, Math.round((rect.x || 0) * scale)),
    y: Math.max(0, Math.round((rect.y || 0) * scale)),
    width: Math.max(1, Math.round((rect.width || 1) * scale)),
    height: Math.max(1, Math.round((rect.height || 1) * scale))
  };
}

/**
 * Convert a possibly invalid URL string into an origin for display/scoping.
 *
 * @param {string} url
 * @returns {string}
 */
function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Infer the required capability gate for a bridge method.
 *
 * @param {string} method
 * @returns {Capability | null}
 */
function inferCapability(method) {
  if (method.startsWith('dom.')) {
    return CAPABILITIES.DOM_READ;
  }
  if (method.startsWith('styles.')) {
    return CAPABILITIES.STYLES_READ;
  }
  if (method.startsWith('layout.')) {
    return CAPABILITIES.LAYOUT_READ;
  }
  if (method.startsWith('input.')) {
    return CAPABILITIES.AUTOMATION_INPUT;
  }
  if (method.startsWith('patch.apply_styles')) {
    return CAPABILITIES.PATCH_STYLES;
  }
  if (method.startsWith('patch.')) {
    return CAPABILITIES.PATCH_DOM;
  }
  if (method.startsWith('screenshot.')) {
    return CAPABILITIES.SCREENSHOT_PARTIAL;
  }
  if (method.startsWith('cdp.')) {
    return CAPABILITIES.CDP_DOM_SNAPSHOT;
  }
  return null;
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
 * Ask the operator to grant bridge access for one tab by surfacing the popup,
 * with the tab-scoped side panel as a fallback when popup opening is blocked.
 *
 * @param {chrome.tabs.Tab} tab
 * @returns {Promise<{ popupOpened: boolean, sidePanelOpened: boolean }>}
 */
async function promptForTabAccess(tab) {
  let popupOpened = false;
  let sidePanelOpened = false;

  if (typeof tab.id === 'number' && typeof tab.windowId === 'number') {
    if (!tab.active) {
      await chrome.tabs.update(tab.id, { active: true });
    }

    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});

    try {
      await chrome.action.openPopup({ windowId: tab.windowId });
      popupOpened = true;
    } catch {
      await openSidePanelForTab(tab.id, tab.windowId);
      sidePanelOpened = true;
    }
  }

  return { popupOpened, sidePanelOpened };
}

/**
 * Keep fire-and-forget async listener failures out of the browser's uncaught
 * promise surface so extension errors stay actionable and structured.
 *
 * @param {unknown} error
 * @returns {void}
 */
function reportAsyncError(error) {
  console.error(error);
}
