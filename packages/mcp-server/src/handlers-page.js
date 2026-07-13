// @ts-check

import {
  DEFAULT_CONSOLE_LIMIT,
  DEFAULT_NETWORK_LIMIT,
  ERROR_CODES,
  getErrorRecovery,
  METHOD_SET,
} from '../../protocol/src/index.js';
import { createBridgeClientForDestination } from '../../agent-client/src/remotes.js';
import {
  annotateBridgeSummary,
  applyLimitBudgetPreset,
  applyMethodBudgetPreset,
  applyPageTextBudgetPreset,
  boundToolValue,
  bridgeMethodNeedsTab,
  callBridgeTool,
  createToolResult,
  getToolTokenBudget,
  requestBridgeWithRetry,
  summarizeBatchErrorItem,
  summarizeBatchResponseItem,
  summarizeBridgeResponse,
  summarizeToolError,
  summarizeToolResponse,
  withToolClient,
  REQUEST_SOURCE,
} from './handlers-utils.js';
import { createScreenshotResult } from './handlers-capture.js';

/** @typedef {import('../../protocol/src/types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('../../agent-client/src/client.js').BridgeClient} BridgeClient */
/** @typedef {import('./handlers-utils.js').ToolResult} ToolResult */

export const MAX_BATCH_CALLS = 20;
export const MAX_BATCH_CONCURRENCY = 5;

/** @type {ReadonlySet<BridgeMethod>} */
const BATCH_SAFE_METHODS = new Set([
  'health.ping',
  'daemon.metrics',
  'tabs.list',
  'skill.get_runtime_context',
  'setup.get_status',
  'log.tail',
  'page.get_state',
  'page.get_console',
  'page.wait_for_load_state',
  'page.get_storage',
  'page.get_text',
  'page.get_network',
  'dom.query',
  'dom.describe',
  'dom.get_text',
  'dom.get_attributes',
  'dom.wait_for',
  'dom.find_by_text',
  'dom.find_by_role',
  'dom.get_html',
  'dom.get_accessibility_tree',
  'layout.get_box_model',
  'layout.hit_test',
  'styles.get_computed',
  'styles.get_matched_rules',
  'network.intercept.list',
  'patch.list',
  'performance.get_metrics',
]);

/**
 * @param {BridgeMethod} method
 * @param {Record<string, unknown>} params
 * @returns {boolean}
 */
export function isBatchSafeBridgeCall(method, params) {
  if (!BATCH_SAFE_METHODS.has(method)) return false;
  if ((method === 'page.get_console' || method === 'page.get_network') && params.clear === true) {
    return false;
  }
  return true;
}

/** @type {Record<string, { method: BridgeMethod, params: (a: Record<string, unknown>) => Record<string, unknown> }>} */
export const PAGE_ACTIONS = {
  state: { method: 'page.get_state', params: () => ({}) },
  evaluate: {
    method: 'page.evaluate',
    params: (a) => ({
      expression: a.expression,
      awaitPromise: a.awaitPromise,
      timeoutMs: a.timeoutMs,
      returnByValue: a.returnByValue,
    }),
  },
  console: {
    method: 'page.get_console',
    params: (a) => ({ level: a.level, clear: a.clear, limit: a.limit }),
  },
  wait_for_load: {
    method: 'page.wait_for_load_state',
    params: (a) => ({ timeoutMs: a.timeoutMs }),
  },
  storage: {
    method: 'page.get_storage',
    params: (a) => ({ type: a.type, keys: a.keys }),
  },
  text: {
    method: 'page.get_text',
    params: (a) => ({ textBudget: a.textBudget }),
  },
  network: {
    method: 'page.get_network',
    params: (a) => ({
      clear: a.clear,
      limit: a.limit,
      urlPattern: a.urlPattern,
    }),
  },
  performance: { method: 'performance.get_metrics', params: () => ({}) },
};

/**
 * @param {{ action: string, expression?: string, awaitPromise?: boolean, timeoutMs?: number, returnByValue?: boolean, level?: string, clear?: boolean, limit?: number, type?: string, keys?: string[], textBudget?: number, urlPattern?: string, tabId?: number, destinationId?: string, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
 * @returns {Promise<ToolResult>}
 */
export async function handlePageTool(args) {
  let normalizedArgs = args;
  if (args.action === 'text') {
    normalizedArgs = applyPageTextBudgetPreset(args);
  } else if (args.action === 'console') {
    normalizedArgs = applyLimitBudgetPreset(args, {
      quick: 10,
      normal: DEFAULT_CONSOLE_LIMIT,
      deep: 100,
    });
  } else if (args.action === 'network') {
    normalizedArgs = applyLimitBudgetPreset(args, {
      quick: 10,
      normal: DEFAULT_NETWORK_LIMIT,
      deep: 100,
    });
  }
  const entry = PAGE_ACTIONS[normalizedArgs.action];
  if (!entry) return summarizeToolError(`Unsupported page action "${args.action}".`);
  if (
    normalizedArgs.action === 'evaluate' &&
    (typeof normalizedArgs.expression !== 'string' || !normalizedArgs.expression.trim())
  ) {
    return summarizeToolError('expression is required for page evaluate.');
  }
  return callBridgeTool(entry.method, entry.params(normalizedArgs), {
    tabId: typeof normalizedArgs.tabId === 'number' ? normalizedArgs.tabId : null,
    tokenBudget: getToolTokenBudget(normalizedArgs),
    destinationId: normalizedArgs.destinationId ?? null,
  });
}

/**
 * @param {{ calls?: Array<{ method?: string, params?: Record<string, unknown>, tabId?: number, destinationId?: string, budgetPreset?: 'quick' | 'normal' | 'deep' }> }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleBatchTool(args) {
  if (!Array.isArray(args.calls) || args.calls.length === 0) {
    return summarizeToolError('calls must be a non-empty array.');
  }
  if (args.calls.length > MAX_BATCH_CALLS) {
    return summarizeToolError(`calls must contain at most ${MAX_BATCH_CALLS} entries.`);
  }

  const calls = args.calls;
  for (const [index, call] of calls.entries()) {
    if (!call || typeof call !== 'object' || typeof call.method !== 'string') {
      return summarizeToolError(`calls[${index}] needs a method.`);
    }
    if (!METHOD_SET.has(/** @type {BridgeMethod} */ (call.method))) {
      return summarizeToolError(`Unknown bridge method "${call.method}" at calls[${index}].`);
    }
    const method = /** @type {BridgeMethod} */ (call.method);
    if (!isBatchSafeBridgeCall(method, call.params || {})) {
      return summarizeToolError(
        `${method} is not safe for parallel batch execution. Use its specialized tool or browser_call sequentially.`
      );
    }
  }

  const results = await mapWithConcurrency(calls, MAX_BATCH_CONCURRENCY, async (call) => {
    const method = /** @type {BridgeMethod} */ (call.method);
    const tabId = bridgeMethodNeedsTab(method)
      ? typeof call.tabId === 'number'
        ? call.tabId
        : null
      : null;
    const tokenBudget = getToolTokenBudget(call);
    const destinationId = typeof call.destinationId === 'string' ? call.destinationId : null;
    const startTime = Date.now();
    /** @type {BridgeClient | null} */
    let callClient = null;
    /** @type {import('../../protocol/src/types.js').BridgeResponse | null} */
    let response = null;
    /** @type {unknown} */
    let callError = null;
    try {
      callClient = await createBridgeClientForDestination(destinationId);
      await callClient.connect();
      const params = applyMethodBudgetPreset(method, call.params || {}, call.budgetPreset);
      response = await requestBridgeWithRetry(callClient, method, params, {
        tabId,
        source: REQUEST_SOURCE,
        tokenBudget,
      });
    } catch (error) {
      callError = error;
    } finally {
      if (callClient) {
        try {
          await callClient.close();
        } catch (error) {
          callError ??= error;
        }
      }
    }
    if (callError || !response) {
      return {
        destinationId,
        ...summarizeThrownBatchError(method, tabId, callError, Date.now() - startTime),
      };
    }
    return {
      destinationId,
      ...summarizeBatchResponseItem(
        { method, tabId, response, durationMs: Date.now() - startTime },
        { compact: true }
      ),
    };
  });

  const failureCount = results.filter((result) => !result.ok).length;
  const summary =
    failureCount === 0
      ? `Batch executed ${results.length} call(s).`
      : `Batch executed ${results.length} call(s) with ${failureCount} error(s).`;
  return createToolResult(
    summary,
    {
      ok: failureCount === 0,
      successCount: results.length - failureCount,
      failureCount,
      compactOutput: true,
      results,
    },
    failureCount > 0
  );
}

/** @type {ReadonlySet<string>} */
const RECOGNIZED_ERROR_CODES = new Set(Object.values(ERROR_CODES));

/**
 * @param {BridgeMethod} method
 * @param {number | null} tabId
 * @param {unknown} error
 * @param {number} durationMs
 */
function summarizeThrownBatchError(method, tabId, error, durationMs) {
  const item = summarizeBatchErrorItem({ method, tabId, error, durationMs }, { compact: true });
  const record =
    error && typeof error === 'object' ? /** @type {Record<string, unknown>} */ (error) : {};
  const code = /** @type {import('../../protocol/src/types.js').ErrorCode} */ (
    typeof record.code === 'string' && RECOGNIZED_ERROR_CODES.has(record.code)
      ? record.code
      : 'INTERNAL_ERROR'
  );
  const message = error instanceof Error ? error.message : String(error ?? 'Bridge call failed.');
  const details = Object.hasOwn(record, 'details') ? record.details : null;
  const boundedDetails = boundToolValue(details);
  const recovery = getErrorRecovery(code);
  return {
    ...item,
    summary: `${code}: ${message}${recovery?.hint ? ` ${recovery.hint}` : ''}`,
    evidence: boundedDetails.value,
    recovery,
    error: { code, message, details: boundedDetails.value },
    ...(boundedDetails.truncated ? { outputTruncated: true } : {}),
  };
}

/**
 * @template T, R
 * @param {T[]} values
 * @param {number} concurrency
 * @param {(value: T, index: number) => Promise<R>} callback
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(values, concurrency, callback) {
  /** @type {R[]} */
  const results = new Array(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(values[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => worker())
  );
  return results;
}

/**
 * @param {{ method: string, params?: Record<string, unknown>, tabId?: number, destinationId?: string, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleRawCallTool(args) {
  if (!METHOD_SET.has(/** @type {BridgeMethod} */ (args.method))) {
    return summarizeToolError(`Unknown bridge method "${args.method}".`);
  }
  return withToolClient(
    async (client) => {
      const method = /** @type {BridgeMethod} */ (args.method);
      const params = applyMethodBudgetPreset(method, args.params || {}, args.budgetPreset);
      const response = await requestBridgeWithRetry(client, method, params, {
        tabId: typeof args.tabId === 'number' ? args.tabId : null,
        source: REQUEST_SOURCE,
        tokenBudget: method.startsWith('screenshot.') ? null : getToolTokenBudget(args),
      });
      if (response.ok && method.startsWith('screenshot.')) {
        return createScreenshotResult(response, method);
      }
      return summarizeToolResponse(response, method, params);
    },
    { destinationId: args.destinationId ?? null }
  );
}

/**
 * @typedef {{ method: BridgeMethod, params: (args: Record<string, unknown>) => Record<string, unknown> }} InvestigateStep
 */

/** @type {Record<string, { label: string, steps: InvestigateStep[] }>} */
const INVESTIGATE_SCOPES = {
  quick: {
    label: 'quick',
    steps: [
      { method: 'page.get_state', params: () => ({}) },
      {
        method: 'dom.query',
        params: (a) => ({
          selector: a.selector || 'body',
          maxNodes: 10,
          maxDepth: 2,
          textBudget: 300,
        }),
      },
    ],
  },
  normal: {
    label: 'normal',
    steps: [
      { method: 'page.get_state', params: () => ({}) },
      {
        method: 'dom.query',
        params: (a) => ({
          selector: a.selector || 'body',
          maxNodes: 25,
          maxDepth: 4,
          textBudget: 600,
        }),
      },
      { method: 'page.get_text', params: () => ({ textBudget: 4000 }) },
    ],
  },
  deep: {
    label: 'deep',
    steps: [
      { method: 'page.get_state', params: () => ({}) },
      {
        method: 'dom.query',
        params: (a) => ({
          selector: a.selector || 'body',
          maxNodes: 50,
          maxDepth: 6,
          textBudget: 1000,
        }),
      },
      { method: 'page.get_text', params: () => ({ textBudget: 8000 }) },
      {
        method: 'page.get_console',
        params: () => ({ level: 'warn', limit: 20 }),
      },
      { method: 'page.get_network', params: () => ({ limit: 20 }) },
    ],
  },
};

/**
 * @param {{ objective: string, scope?: 'quick' | 'normal' | 'deep', tabId?: number, destinationId?: string, selector?: string }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleInvestigateTool(args) {
  const objective = typeof args.objective === 'string' ? args.objective.trim() : '';
  if (!objective) {
    return summarizeToolError('objective is required for browser_investigate.');
  }

  const scopeName = args.scope || 'normal';
  const scope = INVESTIGATE_SCOPES[scopeName];
  if (!scope) {
    return summarizeToolError(`Unsupported investigation scope "${scopeName}".`);
  }

  return withToolClient(
    async (client) => {
      const requestedTabId = typeof args.tabId === 'number' ? args.tabId : null;

      /** @type {Array<{ method: string, ok: boolean, summary: string, evidence: unknown, durationMs: number }>} */
      const stepResults = [];

      for (const step of scope.steps) {
        const startTime = Date.now();
        try {
          const response = await requestBridgeWithRetry(client, step.method, step.params(args), {
            tabId: requestedTabId,
            source: REQUEST_SOURCE,
            tokenBudget: null,
          });
          const bridgeSummary = annotateBridgeSummary(
            summarizeBridgeResponse(response, step.method),
            response
          );
          stepResults.push({
            method: step.method,
            ok: bridgeSummary.ok,
            summary: bridgeSummary.summary,
            evidence: bridgeSummary.evidence,
            durationMs: Date.now() - startTime,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          stepResults.push({
            method: step.method,
            ok: false,
            summary: `ERROR: ${message}`,
            evidence: null,
            durationMs: Date.now() - startTime,
          });
        }
      }

      const failedSteps = stepResults.filter((s) => !s.ok);
      const allOk = failedSteps.length === 0;
      const totalDuration = stepResults.reduce((sum, s) => sum + s.durationMs, 0);

      const summaryText = allOk
        ? `Investigation complete (${scope.label}, ${stepResults.length} steps, ${totalDuration}ms). Objective: ${objective}`
        : `Investigation partial (${scope.label}, ${stepResults.length} steps, ${failedSteps.length} failed, ${totalDuration}ms). Objective: ${objective}`;

      return createToolResult(
        summaryText,
        {
          ok: allOk,
          objective,
          scope: scopeName,
          heuristicFallback: true,
          steps: stepResults,
          failedSteps,
        },
        !allOk
      );
    },
    { destinationId: args.destinationId ?? null }
  );
}
