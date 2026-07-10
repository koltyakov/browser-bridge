// @ts-check

import {
  bridgeMethodNeedsTab,
  createFailure,
  ERROR_CODES,
  estimateJsonPayloadCost,
  MAX_NATIVE_MESSAGE_BYTES,
  normalizeTabCloseParams,
  serializeJsonPayload,
  summarizeBridgeResponse,
} from '../../protocol/src/index.js';
import {
  enforceTokenBudget,
  getResponseDiagnostics,
  shouldLogAction,
  summarizeActionResult,
} from './background-helpers.js';
import {
  ACTION_LOG_STORAGE_KEY,
  MAX_ACTION_LOG_ENTRIES,
  normalizeActionLogEntry,
  normalizeActionLogSource,
} from './background-state.js';

/** @typedef {import('./background-state.js').ExtensionState} ExtensionState */
/** @typedef {import('./background-state.js').ResolvedTabTarget} ResolvedTabTarget */
/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */

const RESPONSE_SIZE_HEADROOM_BYTES = 4096;
const MAX_BRIDGE_RESPONSE_BYTES = MAX_NATIVE_MESSAGE_BYTES - RESPONSE_SIZE_HEADROOM_BYTES;

/**
 * @typedef {{ tabId: number | null, url: string }} ActionContext
 */

/**
 * @typedef {{
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
 *   continuationHint?: string | null,
 * }} ActionLogEntryInput
 */

/**
 * @typedef {{
 *   resolveRequestTarget: (
 *     request: BridgeRequest,
 *     options?: { requireScriptable?: boolean }
 *   ) => Promise<ResolvedTabTarget>,
 *   emitUiState: () => Promise<void>,
 * }} ActionLogControllerDeps
 */

/**
 * Create the action-log helpers used by the background worker. Keeping them in
 * a small controller keeps the main worker focused on request orchestration.
 *
 * @param {ExtensionState} state
 * @param {typeof globalThis.chrome} chromeObj
 * @param {ActionLogControllerDeps} deps
 * @returns {{
 *   appendActionLogEntry: (entry: ActionLogEntryInput) => Promise<void>,
 *   getActionContext: (request: BridgeRequest) => Promise<ActionContext | null>,
 *   logBridgeAction: (
 *     request: BridgeRequest,
 *     response: BridgeResponse,
 *     actionContext: ActionContext | null
 *   ) => Promise<void>,
 *   restoreActionLog: () => Promise<void>,
 * }}
 */
export function createActionLogController(state, chromeObj, deps) {
  /**
   * Resolve the scope context for a bridge request so the action log can show
   * where an operation happened even if that operation later revokes the session.
   *
   * @param {BridgeRequest} request
   * @returns {Promise<ActionContext | null>}
   */
  async function getActionContext(request) {
    try {
      if (request.method === 'tabs.close') {
        const params = normalizeTabCloseParams(request.params);
        const tab = await chromeObj.tabs.get(params.tabId);
        return {
          tabId: params.tabId,
          url: tab.url ?? '',
        };
      }
      if (!bridgeMethodNeedsTab(request.method)) {
        return null;
      }
      const tab = await deps.resolveRequestTarget(request, {
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
   * Restore the recent action log that powers the side panel activity view.
   *
   * @returns {Promise<void>}
   */
  async function restoreActionLog() {
    const stored = await chromeObj.storage.session.get(ACTION_LOG_STORAGE_KEY);
    const entries = stored[ACTION_LOG_STORAGE_KEY];
    if (Array.isArray(entries)) {
      state.actionLog = entries
        .map((entry) => normalizeActionLogEntry(entry))
        .filter((entry) => entry !== null);
    }
  }

  /**
   * Append one action log entry and persist the bounded history.
   *
   * @param {ActionLogEntryInput} entry
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

    await chromeObj.storage.session.set({
      [ACTION_LOG_STORAGE_KEY]: state.actionLog,
    });
  }

  /**
   * Append one operator-facing action log entry and persist the bounded history.
   *
   * @param {BridgeRequest} request
   * @param {BridgeResponse} response
   * @param {ActionContext | null} actionContext
   * @returns {Promise<void>}
   */
  async function logBridgeAction(request, response, actionContext) {
    if (!shouldLogAction(request.method)) {
      return;
    }

    const diagnostics = getResponseDiagnostics(request.method, response);
    const summaryPayload = summarizeBridgeResponse(response, request.method);
    const summaryCost = estimateJsonPayloadCost(summaryPayload);

    try {
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
          typeof response.meta?.continuation_hint === 'string'
            ? response.meta.continuation_hint
            : null,
      });
    } catch {
      // Action persistence must never affect bridge response delivery.
    }
    try {
      await deps.emitUiState();
    } catch {
      // UI surfaces are best-effort and may disappear between request and reply.
    }
  }

  return {
    appendActionLogEntry,
    getActionContext,
    logBridgeAction,
    restoreActionLog,
  };
}

/**
 * Apply token-budget truncation and attach cost/debugger metadata for the
 * response that will be sent back to the agent.
 *
 * @param {BridgeRequest} request
 * @param {BridgeResponse} response
 * @returns {BridgeResponse}
 */
export function enrichBridgeResponse(request, response) {
  const budgetedResponse = enforceTokenBudget(request.method, response, request.meta?.token_budget);
  const transportSafeResponse = enforceTransportPayloadLimit(request, budgetedResponse);
  const responsePayload = transportSafeResponse.ok
    ? transportSafeResponse.result
    : { error: transportSafeResponse.error };
  const diagnostics = getResponseDiagnostics(
    request.method,
    transportSafeResponse,
    serializeJsonPayload(responsePayload)
  );
  return {
    ...transportSafeResponse,
    meta: {
      ...transportSafeResponse.meta,
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
 * Keep responses below Chrome native-messaging's outbound frame limit. Token
 * budgets are optional, but transport safety is not.
 *
 * @param {BridgeRequest} request
 * @param {BridgeResponse} response
 * @returns {BridgeResponse}
 */
export function enforceTransportPayloadLimit(request, response) {
  if (!response.ok) {
    return response;
  }
  const responsePayload = response.result;
  const payloadBytes = estimateJsonPayloadCost(responsePayload).bytes;
  if (payloadBytes <= MAX_BRIDGE_RESPONSE_BYTES) {
    return response;
  }

  return createFailure(
    request.id,
    ERROR_CODES.RESULT_TRUNCATED,
    `Result is too large to return safely (${payloadBytes} bytes).`,
    {
      method: request.method,
      responseBytes: payloadBytes,
      maxResponseBytes: MAX_BRIDGE_RESPONSE_BYTES,
    },
    {
      ...response.meta,
      method: request.method,
      budget_applied: true,
      budget_truncated: true,
      continuation_hint: `Retry ${request.method} with a tighter scope or smaller capture region.`,
    }
  );
}
