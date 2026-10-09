// @ts-check

import {
  bridgeMethodNeedsTab,
  createFailure,
  ERROR_CODES,
  estimateJsonPayloadCost,
  MAX_NATIVE_MESSAGE_BYTES,
  MAX_SENSITIVE_VALUE_BYTES,
  normalizeTabCloseParams,
  sanitizeIncidentalText,
  sanitizeIncidentalUrl,
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
  normalizeActionLogMcpEra,
  normalizeActionLogSource,
} from './background-state.js';

/** @typedef {import('./background-state.js').ExtensionState} ExtensionState */
/** @typedef {import('./background-state.js').ActionLogEntry} ActionLogEntry */
/** @typedef {import('./background-state.js').CurrentTabState} CurrentTabState */
/** @typedef {import('./background-state.js').ResolvedTabTarget} ResolvedTabTarget */
/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */

const RESPONSE_SIZE_HEADROOM_BYTES = 4096;
const MAX_BRIDGE_RESPONSE_BYTES = MAX_NATIVE_MESSAGE_BYTES - RESPONSE_SIZE_HEADROOM_BYTES;
const CONNECTION_CHECK_COALESCE_MS = 2_000;

/**
 * @typedef {{ tabId: number | null, url: string }} ActionContext
 */

/**
 * @typedef {{
 *   method: string,
 *   source?: string,
 *   mcpEra?: import('../../protocol/src/types.js').McpProtocolEra | null,
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
 *   severity?: 'info' | 'warning',
 *   sensitiveAccess?: { source: 'local_storage' | 'session_storage', category: 'storage_value', keyLength: number } | null,
 * }} ActionLogEntryInput
 */

/**
 * @typedef {{
 *   resolveRequestTarget: (
 *     request: BridgeRequest,
 *     options?: { requireScriptable?: boolean, peek?: boolean }
 *   ) => Promise<ResolvedTabTarget>,
 *   getCurrentTabState: () => Promise<CurrentTabState | null>,
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
 *   clearActionLogForTab: (tabId: number) => Promise<void>,
 * }}
 */
export function createActionLogController(state, chromeObj, deps) {
  /** @type {Promise<void>} */
  let mutations = Promise.resolve();
  /** @type {Promise<void> | null} */
  let restoration = null;
  let historyRestored = false;

  /**
   * Serialize reads and writes so a slow older snapshot cannot replace newer
   * history, and startup restoration cannot overwrite an arriving event.
   *
   * @param {() => Promise<void>} operation
   * @returns {Promise<void>}
   */
  function mutate(operation) {
    const pending = mutations.then(operation);
    mutations = pending.catch(() => {});
    return pending;
  }

  /**
   * Retain an independent ring for each tab, plus one for unscoped host events.
   * Keep the existing flat storage shape so prior browser-session history can
   * be restored without migration or changes to the panel message format.
   *
   * @param {ActionLogEntry[]} entries
   * @returns {ActionLogEntry[]}
   */
  function boundHistory(entries) {
    /** @type {Map<number | null, number>} */
    const counts = new Map();
    const ids = new Set();
    return entries
      .slice()
      .reverse()
      .filter((entry) => {
        const count = counts.get(entry.tabId) ?? 0;
        if (ids.has(entry.id) || count >= MAX_ACTION_LOG_ENTRIES) return false;
        ids.add(entry.id);
        counts.set(entry.tabId, count + 1);
        return true;
      })
      .reverse();
  }

  /** @returns {Promise<void>} */
  async function persistHistory() {
    if (!historyRestored) return;
    await chromeObj.storage.session.set({
      [ACTION_LOG_STORAGE_KEY]: [...state.actionLog],
    });
  }

  /**
   * Resolve the scope context for a bridge request so the action log can show
   * where an operation happened even if that operation later revokes the session.
   *
   * @param {BridgeRequest} request
   * @returns {Promise<ActionContext | null>}
   */
  async function getActionContext(request) {
    try {
      if (request.method === 'health.ping') {
        const tab = await deps.getCurrentTabState();
        return tab ? { tabId: tab.tabId, url: tab.url } : null;
      }
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
        peek: true,
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
  function restoreActionLog() {
    if (!restoration) {
      restoration = mutate(async () => {
        /** @type {Record<string, unknown>} */
        let stored;
        try {
          stored = await chromeObj.storage.session.get(ACTION_LOG_STORAGE_KEY);
        } catch {
          // Keep collecting in memory, but never overwrite history we could
          // not read. A later event retries restoration and merges both sets.
          restoration = null;
          return;
        }
        const raw = stored[ACTION_LOG_STORAGE_KEY];
        const entries = Array.isArray(raw)
          ? raw.map((entry) => normalizeActionLogEntry(entry)).filter((entry) => entry !== null)
          : [];
        /** @type {Set<number> | null} */
        let openTabIds = null;
        try {
          const tabs = await chromeObj.tabs.query({});
          openTabIds = new Set(tabs.flatMap((tab) => (typeof tab.id === 'number' ? [tab.id] : [])));
        } catch {
          // Do not discard history when Chrome cannot enumerate tabs.
        }
        state.actionLog = boundHistory([...entries, ...state.actionLog]).filter(
          (entry) => entry.tabId === null || !openTabIds || openTabIds.has(entry.tabId)
        );
        historyRestored = true;
        if (Array.isArray(raw) || state.actionLog.length) {
          await persistHistory().catch(() => {});
        }
      });
    }
    return restoration;
  }

  /**
   * Remove only a closed tab's history, including any earlier in-flight write.
   * Late responses are rejected by the tab-existence check in append.
   *
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async function clearActionLogForTab(tabId) {
    await restoreActionLog();
    await mutate(async () => {
      state.actionLog = state.actionLog.filter((entry) => entry.tabId !== tabId);
      await persistHistory();
    });
  }

  /**
   * Append one action log entry and persist the bounded history.
   *
   * @param {ActionLogEntryInput} entry
   * @returns {Promise<void>}
   */
  async function appendActionLogEntry(entry) {
    const at = Date.now();
    await restoreActionLog();
    await mutate(async () => {
      const tabId =
        typeof entry.tabId === 'number' && Number.isSafeInteger(entry.tabId) && entry.tabId > 0
          ? entry.tabId
          : null;
      if (tabId !== null) {
        try {
          await chromeObj.tabs.get(tabId);
        } catch {
          // The tab may have closed before this request completed.
          return;
        }
      }
      const previousIndex = state.actionLog.findLastIndex((item) => item.tabId === tabId);
      const previousEntry = state.actionLog[previousIndex];
      if (
        entry.method === 'health.ping' &&
        previousEntry?.method === 'health.ping' &&
        previousEntry.tabId === tabId &&
        at >= previousEntry.at &&
        at - previousEntry.at <= CONNECTION_CHECK_COALESCE_MS
      ) {
        state.actionLog.splice(previousIndex, 1);
      }
      const source = normalizeActionLogSource(entry.source);
      state.actionLog.push({
        id: crypto.randomUUID(),
        at,
        method: entry.method,
        source,
        mcpEra: normalizeActionLogMcpEra(source, entry.mcpEra),
        tabId,
        url: sanitizeIncidentalUrl(entry.url ?? ''),
        ok: entry.ok,
        summary: sanitizeIncidentalText(entry.summary),
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
        severity: entry.severity === 'warning' ? 'warning' : 'info',
        sensitiveAccess: entry.sensitiveAccess ?? null,
      });
      state.actionLog = boundHistory(state.actionLog);
      await persistHistory();
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

    // Dialog messages and prompt values are intentionally excluded from the
    // persisted action-log path, including its summary-size diagnostics.
    const sensitiveRead = request.method === 'sensitive.read';
    const webMcpActivity = request.method.startsWith('webmcp.');
    const sensitiveActivity = sensitiveRead || request.method === 'page.evaluate' || webMcpActivity;
    const summaryPayload = sensitiveActivity
      ? {
          source: sensitiveRead ? request.params.source : 'page_evaluation',
          exact: response.ok,
        }
      : request.method === 'page.handle_dialog'
        ? summarizeDialogActionForLog(response)
        : summarizeBridgeResponse(response, request.method);
    const diagnostics = sensitiveActivity
      ? {
          responseBytes: 0,
          textApproxTokens: 0,
          imageApproxTokens: 0,
          costClass: /** @type {'cheap'} */ ('cheap'),
          imageBytes: 0,
          debuggerBacked: false,
          hasScreenshot: false,
          nodeCount: null,
        }
      : getResponseDiagnostics(
          request.method,
          request.method === 'page.handle_dialog'
            ? sanitizeDialogResponseForDiagnostics(response, summaryPayload)
            : response
        );
    const summaryCost = sensitiveActivity
      ? { bytes: 0, approxTokens: 0, costClass: /** @type {'cheap'} */ ('cheap') }
      : estimateJsonPayloadCost(summaryPayload);
    const result =
      response.ok && response.result && typeof response.result === 'object'
        ? /** @type {Record<string, unknown>} */ (response.result)
        : null;
    const responseTabId =
      request.method === 'tabs.create' && response.ok ? result?.tabId : response.meta?.tab_id;
    const requestTabId =
      request.method === 'tabs.close' || request.method === 'tabs.activate'
        ? request.params.tabId
        : request.tab_id;
    const tabId =
      typeof responseTabId === 'number'
        ? responseTabId
        : (actionContext?.tabId ?? (typeof requestTabId === 'number' ? requestTabId : null));

    try {
      await appendActionLogEntry({
        method: request.method,
        source: normalizeActionLogSource(request.meta?.source),
        mcpEra:
          request.meta?.mcp_era === 'legacy' || request.meta?.mcp_era === 'modern'
            ? request.meta.mcp_era
            : null,
        tabId,
        url:
          request.method === 'tabs.create' && typeof result?.url === 'string'
            ? result.url
            : actionContext?.tabId === tabId
              ? actionContext.url
              : '',
        ok: response.ok,
        summary: sensitiveActivity
          ? sensitiveRead
            ? `Sensitive ${request.params.source === 'session_storage' ? 'session' : 'local'} storage read ${response.ok ? 'succeeded' : `failed: ${response.error.code}`}.`
            : webMcpActivity
              ? `WebMCP ${request.method.split('.')[1]} ${response.ok ? 'completed' : `failed: ${response.error.code}`}. Website metadata, arguments, and results are not retained.`
              : `Page evaluation with sensitive-data access capability ${response.ok ? 'succeeded' : `failed: ${response.error.code}`}.`
          : request.method === 'page.handle_dialog'
            ? summarizeDialogActionResultForLog(response)
            : request.method === 'health.ping'
              ? summarizeConnectionCheckResult(response)
              : summarizeActionResult(response),
        responseBytes: diagnostics.responseBytes,
        approxTokens: diagnostics.textApproxTokens,
        imageApproxTokens: diagnostics.imageApproxTokens,
        costClass: diagnostics.costClass,
        imageBytes: diagnostics.imageBytes,
        summaryBytes: summaryCost.bytes,
        summaryTokens: summaryCost.approxTokens,
        summaryCostClass: summaryCost.costClass,
        debuggerBacked: response.meta?.debugger_backed === true || diagnostics.debuggerBacked,
        overBudget:
          request.method === 'page.handle_dialog'
            ? false
            : response.meta?.budget_truncated === true,
        hasScreenshot: diagnostics.hasScreenshot,
        nodeCount: diagnostics.nodeCount,
        continuationHint:
          request.method !== 'page.handle_dialog' &&
          typeof response.meta?.continuation_hint === 'string'
            ? response.meta.continuation_hint
            : null,
        severity: sensitiveActivity ? 'warning' : 'info',
        sensitiveAccess: sensitiveRead
          ? {
              source:
                request.params.source === 'session_storage' ? 'session_storage' : 'local_storage',
              category: 'storage_value',
              keyLength: typeof request.params.key === 'string' ? request.params.key.length : 0,
            }
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
    clearActionLogForTab,
  };
}

/**
 * @param {BridgeResponse} response
 * @returns {string}
 */
function summarizeConnectionCheckResult(response) {
  if (!response.ok) return response.error.message;
  const result =
    response.result && typeof response.result === 'object'
      ? /** @type {Record<string, unknown>} */ (response.result)
      : {};
  const access =
    result.access && typeof result.access === 'object'
      ? /** @type {Record<string, unknown>} */ (result.access)
      : null;
  if (!access) return 'Connection check completed.';
  if (access.enabled !== true) {
    return 'Connection check completed; window access is disabled.';
  }
  if (access.routeReady === true) {
    return 'Connection check completed; window access is ready.';
  }
  return 'Connection check completed; window access is enabled but unavailable.';
}

/**
 * @param {BridgeResponse} response
 * @returns {Record<string, unknown>}
 */
function summarizeDialogActionForLog(response) {
  if (!response.ok) {
    return { ok: false, code: response.error.code };
  }
  const result =
    response.result && typeof response.result === 'object'
      ? /** @type {Record<string, unknown>} */ (response.result)
      : {};
  return {
    ok: true,
    open: result.open === true,
    commandDispatched: result.commandDispatched === true,
    action: typeof result.action === 'string' ? result.action : 'inspect',
    type: typeof result.type === 'string' ? result.type : 'unknown',
  };
}

/**
 * @param {BridgeResponse} response
 * @returns {string}
 */
function summarizeDialogActionResultForLog(response) {
  if (!response.ok) return `${response.error.code}: Dialog action was not confirmed.`;
  const result =
    response.result && typeof response.result === 'object'
      ? /** @type {Record<string, unknown>} */ (response.result)
      : {};
  if (result.commandDispatched === true) {
    const action = typeof result.action === 'string' ? result.action : 'action';
    return `Dialog ${action} command dispatched; Chrome did not atomically bind it to the observation identifier.`;
  }
  return 'Dialog inspected; no action was taken.';
}

/**
 * Persisted diagnostics use a fixed redacted payload so dialog message and
 * default-prompt lengths cannot be inferred from byte/token counters.
 *
 * @param {BridgeResponse} response
 * @param {Record<string, unknown>} summary
 * @returns {BridgeResponse}
 */
function sanitizeDialogResponseForDiagnostics(response, summary) {
  if (response.ok) {
    return { ...response, result: summary };
  }
  return {
    ...response,
    error: {
      ...response.error,
      message: 'Dialog action failed.',
      details: null,
    },
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
  if (request.method === 'sensitive.read') {
    return enforceTransportPayloadLimit(request, response);
  }
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
      debugger_backed:
        transportSafeResponse.meta.debugger_backed === true || diagnostics.debuggerBacked,
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
  if (request.method === 'sensitive.read') {
    const result =
      responsePayload && typeof responsePayload === 'object'
        ? /** @type {Record<string, unknown>} */ (responsePayload)
        : {};
    const valueBytes =
      typeof result.value === 'string' ? new TextEncoder().encode(result.value).byteLength : 0;
    if (valueBytes > MAX_SENSITIVE_VALUE_BYTES) {
      return createFailure(
        request.id,
        ERROR_CODES.RESULT_TOO_LARGE,
        `The exact storage value is too large to return atomically (${valueBytes} bytes).`,
        {
          source: result.source,
          characters: typeof result.value === 'string' ? result.value.length : 0,
          bytes: valueBytes,
          maxBytes: MAX_SENSITIVE_VALUE_BYTES,
        },
        { method: request.method }
      );
    }
  }
  const payloadBytes = estimateJsonPayloadCost(responsePayload).bytes;
  if (payloadBytes <= MAX_BRIDGE_RESPONSE_BYTES) {
    return response;
  }

  if (request.method === 'sensitive.read') {
    const result = /** @type {Record<string, unknown>} */ (responsePayload);
    const value = typeof result.value === 'string' ? result.value : '';
    return createFailure(
      request.id,
      ERROR_CODES.RESULT_TOO_LARGE,
      `The exact storage value is too large to return atomically after encoding (${payloadBytes} bytes).`,
      {
        source: result.source,
        characters: value.length,
        bytes: new TextEncoder().encode(value).byteLength,
        responseBytes: payloadBytes,
        maxResponseBytes: MAX_BRIDGE_RESPONSE_BYTES,
        guidance: 'Use a narrower exact target; partial sensitive values are never returned.',
      },
      { method: request.method }
    );
  }

  if (request.method === 'network.export_har') {
    return createFailure(
      request.id,
      ERROR_CODES.RESULT_TOO_LARGE,
      `HAR export is too large to return without truncating fields (${payloadBytes} bytes).`,
      {
        responseBytes: payloadBytes,
        maxResponseBytes: MAX_BRIDGE_RESPONSE_BYTES,
        guidance: 'Use a smaller limit, a narrower urlPattern, or delivery=artifact.',
      },
      { ...response.meta, method: request.method }
    );
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
