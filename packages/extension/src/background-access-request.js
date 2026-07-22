// @ts-check

import { createFailure, createSuccess, ERROR_CODES } from '../../protocol/src/index.js';
import { normalizeRequestedAccessTab } from './background-routing.js';

/** @typedef {import('./background-state.js').ExtensionState} ExtensionState */
/** @typedef {import('./background-state.js').ResolvedTabTarget} ResolvedTabTarget */
/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */

/**
 * @typedef {{
 *   getTab: (tabId: number) => Promise<chrome.tabs.Tab>,
 *   queryTabs: (queryInfo: { active?: boolean, lastFocusedWindow?: boolean }) => Promise<chrome.tabs.Tab[]>,
 *   getLastFocusedWindow: () => Promise<chrome.windows.Window>,
 *   getAccessStatus: () => Promise<Record<string, unknown>>,
 *   appendActionLogEntry: (entry: {
 *     method: string,
 *     source?: string,
 *     tabId?: number | null,
 *     url?: string,
 *     ok: boolean,
 *     summary: string,
 *   }) => Promise<void>,
 *   refreshActionIndicators: () => Promise<void>,
 *   emitUiState: () => Promise<void>,
 *   openRequestedAccessUi: (target: ResolvedTabTarget) => Promise<void>,
 * }} AccessRequestControllerDeps
 */

/**
 * Keep the bridge access-request workflow isolated from the background worker's
 * wider routing logic so the worker can stay focused on orchestration.
 *
 * @param {ExtensionState} state
 * @param {AccessRequestControllerDeps} deps
 * @returns {{
 *   handleAccessRequest: (request: BridgeRequest) => Promise<BridgeResponse>,
 *   requestEnableFromAgentSide: (request: BridgeRequest) => Promise<BridgeResponse | null>,
 *   resolveRequestedAccessTarget: (request: BridgeRequest) => Promise<ResolvedTabTarget | null>,
 * }}
 */
export function createAccessRequestController(state, deps) {
  /**
   * @param {BridgeRequest} request
   * @returns {Promise<ResolvedTabTarget | null>}
   */
  async function resolveRequestedAccessTarget(request) {
    if (typeof request.tab_id === 'number' && request.tab_id > 0) {
      try {
        const tab = await deps.getTab(request.tab_id);
        return normalizeRequestedAccessTab(tab);
      } catch {
        return null;
      }
    }

    const tabs = await deps.queryTabs({
      active: true,
      lastFocusedWindow: true,
    });
    return normalizeRequestedAccessTab(tabs[0] ?? null);
  }

  /**
   * @returns {Promise<boolean>}
   */
  async function isBrowserForeground() {
    try {
      const browserWindow = await deps.getLastFocusedWindow();
      return browserWindow.focused === true;
    } catch {
      return false;
    }
  }

  /**
   * @param {BridgeRequest} request
   * @param {ResolvedTabTarget} target
   * @returns {BridgeResponse}
   */
  function createBackgroundAccessFailure(request, target) {
    return createFailure(
      request.id,
      ERROR_CODES.ACCESS_DENIED,
      'Browser Bridge cannot request access while this browser is in the background. Bring the browser to the foreground and enable access manually in the Browser Bridge popup or side panel. Do not retry until the user confirms access is enabled.',
      {
        reason: 'browser_background',
        requestedTargetWindowId: target.windowId,
        requestedTargetTabId: target.tabId,
      },
      { method: request.method }
    );
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
   * @param {ResolvedTabTarget} target
   * @param {unknown} source
   * @returns {Promise<void>}
   */
  async function queueAccessRequest(target, source) {
    state.requestedAccessWindowId = target.windowId;
    try {
      await deps.appendActionLogEntry({
        method: 'access.requested',
        source: typeof source === 'string' ? source : undefined,
        tabId: target.tabId,
        url: target.url,
        ok: true,
        summary: 'Window access requested; waiting for confirmation.',
      });
    } catch {
      // Activity persistence must never prevent an access prompt from opening.
    }
    await deps.refreshActionIndicators();
    await deps.emitUiState();
    await deps.openRequestedAccessUi(target);
  }

  /**
   * Surface an enable cue in the extension UI when an agent-side request fails
   * because Browser Bridge is off for the target window.
   *
   * @param {BridgeRequest} request
   * @returns {Promise<BridgeResponse | null>}
   */
  async function requestEnableFromAgentSide(request) {
    const target = await resolveRequestedAccessTarget(request);
    if (!target || state.requestedAccessWindowId != null) {
      return null;
    }

    if (!(await isBrowserForeground())) {
      return createBackgroundAccessFailure(request, target);
    }

    await queueAccessRequest(target, request.meta?.source);
    return null;
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
      if (target && target.windowId !== state.enabledWindow.windowId) {
        return createFailure(
          request.id,
          ERROR_CODES.ACCESS_DENIED,
          'Browser Bridge access is already enabled for another window. Disable that window before requesting access for this tab.',
          {
            enabledWindowId: state.enabledWindow.windowId,
            requestedTargetWindowId: target.windowId,
            requestedTargetTabId: target.tabId,
          },
          { method: request.method }
        );
      }
      const access = await deps.getAccessStatus();
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

    if (!(await isBrowserForeground())) {
      return createBackgroundAccessFailure(request, target);
    }

    await queueAccessRequest(target, request.meta?.source);

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

  return {
    handleAccessRequest,
    requestEnableFromAgentSide,
    resolveRequestedAccessTarget,
  };
}
