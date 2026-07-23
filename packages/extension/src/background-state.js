// @ts-check

import {
  BridgeError,
  ERROR_CODES,
  createFailure,
  sanitizeIncidentalText,
  sanitizeIncidentalUrl,
  sanitizeIncidentalValue,
} from '../../protocol/src/index.js';
import { getErrorMessage, normalizeRuntimeErrorMessage } from './background-helpers.js';

/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */
/** @typedef {import('../../protocol/src/types.js').ErrorCode} ErrorCode */

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
 *   windowId: number,
 *   tabId: number,
 *   source: 'cli' | 'mcp' | null,
 *   intent: import('../../protocol/src/types.js').AccessIntent,
 *   title: string,
 *   origin: string | null
 * }} AccessRequestContext
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
 *   severity?: 'info' | 'warning',
 *   sensitiveAccess?: { source: 'local_storage' | 'session_storage', category: 'storage_value', keyLength: number } | null,
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
 *   accessRequestContext?: AccessRequestContext
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
 *   enabled: boolean,
 *   endpoint: string | null
 * }} DaemonProxyStatus
 */

/**
 * @typedef {{
 *   nativePort: chrome.runtime.Port | null,
 *   pendingNativePort: chrome.runtime.Port | null,
 *   nativeHostVersion: string | null,
 *   nativeHostVersionRequestId: string | null,
 *   daemonProxy: DaemonProxyStatus | null,
 *   enabledWindow: EnabledWindowState | null,
 *   requestedAccessWindowId: number | null,
 *   requestedAccessContext?: AccessRequestContext | null,
 *   requestedAccessPopupWindowId: number | null,
 *   nativeReconnectAttempts: number,
 *   nativeDisconnectTimes: number[],
 *   nativeUnstable: boolean,
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

/** @typedef {import('../../protocol/src/types.js').SetupStatus} SetupStatus */

/**
 * @param {unknown} value
 * @returns {value is number}
 */
export function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export const NATIVE_APP_NAME = 'com.browserbridge.browser_bridge';
export const CONTENT_SCRIPT_TIMEOUT_MS = 5_000;
export const MAX_ACTION_LOG_ENTRIES = 50;
export const ENABLED_WINDOW_STORAGE_KEY = 'enabledWindow';
export const ACTION_LOG_STORAGE_KEY = 'actionLog';
export const SIDEPANEL_PATH = 'packages/extension/ui/sidepanel.html';
export const POPUP_PATH = 'packages/extension/ui/popup.html';
export const ENABLED_BADGE_TEXT = 'AI';
export const ACCESS_REQUEST_BADGE_TEXT = '!';
export const RESTRICTED_BADGE_TEXT = '!';
export const DEBUGGER_PROTOCOL_VERSION = '1.3';
export const SETUP_STATUS_STALE_MS = 30_000;
export const SETUP_STATUS_TIMEOUT_MS = 5_000;
export const ACCESS_DENIED_WINDOW_OFF = 'Browser Bridge is off for this window.';
export const ACCESS_DENIED_REASON_WINDOW_OFF = 'window_access_off';
export const ACCESS_DENIED_REASON_WINDOW_GONE = 'window_access_gone';
export const ACCESS_DENIED_TAB_CLOSE = 'tabs.close only works inside the enabled window.';
export const KEEPALIVE_ALARM_NAME = 'bb-keepalive';
export const NATIVE_RECONNECT_BASE_MS = 2_000;
export const NATIVE_RECONNECT_MAX_MS = 30_000;
export const NATIVE_FLAP_WINDOW_MS = 60_000;
export const NATIVE_FLAP_THRESHOLD = 3;

/**
 * Create a fresh extension state object. Called once by the background
 * orchestrator so each dynamic import in tests gets its own state.
 *
 * @returns {ExtensionState}
 */
export function createExtensionState() {
  return {
    nativePort: null,
    pendingNativePort: null,
    nativeHostVersion: null,
    nativeHostVersionRequestId: null,
    daemonProxy: null,
    enabledWindow: null,
    requestedAccessWindowId: null,
    requestedAccessContext: null,
    requestedAccessPopupWindowId: null,
    nativeReconnectAttempts: 0,
    nativeDisconnectTimes: [],
    nativeUnstable: false,
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
}

/** @type {ExtensionState | null} */
let _state = null;

/**
 * Return the shared extension state, initializing it on first access.
 * The background orchestrator should call {@link setExtensionState} during
 * startup so the module-level functions (appendActionLogEntry, etc.) operate
 * on the correct state instance.
 *
 * @returns {ExtensionState}
 */
export function getExtensionState() {
  if (!_state) {
    _state = createExtensionState();
  }
  return _state;
}

/**
 * Install the extension state singleton. Called once by the background
 * orchestrator after creating a fresh state via {@link createExtensionState}.
 *
 * @param {ExtensionState} newState
 */
export function setExtensionState(newState) {
  _state = newState;
}

/**
 * @param {unknown} source
 * @returns {string}
 */
export function normalizeActionLogSource(source) {
  return source === 'cli' || source === 'mcp' ? source : '';
}

/**
 * @param {unknown} entry
 * @returns {ActionLogEntry | null}
 */
export function normalizeActionLogEntry(entry) {
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
    url: typeof candidate.url === 'string' ? sanitizeIncidentalUrl(candidate.url) : '',
    ok: candidate.ok === true,
    summary: typeof candidate.summary === 'string' ? sanitizeIncidentalText(candidate.summary) : '',
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
    severity: candidate.severity === 'warning' ? 'warning' : 'info',
    sensitiveAccess:
      candidate.sensitiveAccess && typeof candidate.sensitiveAccess === 'object'
        ? normalizeSensitiveAccess(candidate.sensitiveAccess)
        : null,
  };
}

/** @param {object} value */
function normalizeSensitiveAccess(value) {
  const candidate = /** @type {Record<string, unknown>} */ (value);
  if (candidate.source !== 'local_storage' && candidate.source !== 'session_storage') {
    return null;
  }
  return {
    source: /** @type {'local_storage' | 'session_storage'} */ (candidate.source),
    category: /** @type {'storage_value'} */ ('storage_value'),
    keyLength:
      typeof candidate.keyLength === 'number' && Number.isFinite(candidate.keyLength)
        ? Math.max(0, Math.trunc(candidate.keyLength))
        : 0,
  };
}

/**
 * Check whether the user explicitly enabled bridge communication for a given
 * window.
 *
 * @param {number} windowId
 * @returns {boolean}
 */
export function isWindowEnabled(windowId) {
  return getExtensionState().enabledWindow?.windowId === windowId;
}

/**
 * @param {number} windowId
 * @returns {boolean}
 */
export function isAccessRequestedWindow(windowId) {
  return getExtensionState().requestedAccessWindowId === windowId;
}

/**
 * @param {number | null} [windowId=null]
 * @returns {void}
 */
export function clearRequestedAccessWindow(windowId = null) {
  const state = getExtensionState();
  if (windowId == null || state.requestedAccessWindowId === windowId) {
    state.requestedAccessWindowId = null;
    state.requestedAccessContext = null;
  }
}

/**
 * @param {number | null} [windowId=null]
 * @returns {void}
 */
export function clearRequestedAccessPopupWindow(windowId = null) {
  const state = getExtensionState();
  if (windowId == null || state.requestedAccessPopupWindowId === windowId) {
    state.requestedAccessPopupWindowId = null;
  }
}

/**
 * Map thrown runtime errors to structured bridge failures.
 *
 * @param {BridgeRequest} request
 * @param {unknown} error
 * @returns {BridgeResponse}
 */
export function toFailureResponse(request, error) {
  if (error instanceof BridgeError) {
    return createFailure(
      request.id,
      error.code,
      sanitizeIncidentalText(error.message),
      sanitizeIncidentalValue(error.details),
      {
        method: request.method,
      }
    );
  }

  if (error && typeof error === 'object') {
    const structured = /** @type {{ code?: unknown, message?: unknown, details?: unknown }} */ (
      error
    );
    const knownErrorCodes = /** @type {string[]} */ (Object.values(ERROR_CODES));
    if (
      typeof structured.code === 'string' &&
      knownErrorCodes.includes(structured.code) &&
      typeof structured.message === 'string'
    ) {
      return createFailure(
        request.id,
        /** @type {ErrorCode} */ (structured.code),
        sanitizeIncidentalText(structured.message),
        sanitizeIncidentalValue(structured.details ?? null),
        { method: request.method }
      );
    }
  }

  const message = normalizeRuntimeErrorMessage(getErrorMessage(error));
  const knownErrorCodes = /** @type {string[]} */ (Object.values(ERROR_CODES));
  /** @type {ErrorCode} */
  const code = knownErrorCodes.includes(message)
    ? /** @type {ErrorCode} */ (message)
    : message === 'Element reference is stale.'
      ? ERROR_CODES.ELEMENT_STALE
      : ERROR_CODES.INTERNAL_ERROR;

  return createFailure(request.id, code, sanitizeIncidentalText(message), null, {
    method: request.method,
  });
}

/**
 * @param {BridgeResponse} response
 * @returns {boolean}
 */
export function isWindowAccessDeniedResponse(response) {
  if (response.ok || response.error.code !== ERROR_CODES.ACCESS_DENIED) {
    return false;
  }
  if (response.error.message === ACCESS_DENIED_WINDOW_OFF) {
    return true;
  }
  const details = response.error.details;
  if (!details || typeof details !== 'object') {
    return false;
  }
  const reason = Reflect.get(details, 'reason');
  return reason === ACCESS_DENIED_REASON_WINDOW_OFF || reason === ACCESS_DENIED_REASON_WINDOW_GONE;
}

/**
 * Keep fire-and-forget async listener failures out of the browser's uncaught
 * promise surface so extension errors stay actionable and structured.
 *
 * @param {unknown} error
 * @returns {void}
 */
export function reportAsyncError(error) {
  if (normalizeRuntimeErrorMessage(getErrorMessage(error)) === ERROR_CODES.TAB_MISMATCH) {
    return;
  }
  console.error(sanitizeIncidentalText(getErrorMessage(error)));
}

/**
 * Expose the live module state to tests that need to seed or inspect routing,
 * access-request, or instrumentation state directly.
 *
 * @returns {ExtensionState}
 */
export function getStateForTest() {
  return getExtensionState();
}
