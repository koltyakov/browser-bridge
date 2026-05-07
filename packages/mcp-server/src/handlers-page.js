// @ts-check

import {
  DEFAULT_CONSOLE_LIMIT,
  DEFAULT_NETWORK_LIMIT,
  METHOD_SET,
} from '../../protocol/src/index.js';
import {
  annotateBridgeSummary,
  applyLimitBudgetPreset,
  applyTextBudgetPreset,
  bridgeMethodNeedsTab,
  callBridgeTool,
  createToolResult,
  getToolTokenBudget,
  requestBridge,
  requestBridgeWithRetry,
  summarizeBatchErrorItem,
  summarizeBatchResponseItem,
  summarizeBridgeResponse,
  summarizeToolError,
  withToolClient,
  REQUEST_SOURCE,
} from './handlers-utils.js';

/** @typedef {import('../../protocol/src/types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('./handlers-utils.js').ToolResult} ToolResult */

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
 * @param {{ action: string, expression?: string, awaitPromise?: boolean, timeoutMs?: number, returnByValue?: boolean, level?: string, clear?: boolean, limit?: number, type?: string, keys?: string[], textBudget?: number, urlPattern?: string, tabId?: number, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
 * @returns {Promise<ToolResult>}
 */
export async function handlePageTool(args) {
  let normalizedArgs = args;
  if (args.action === 'text') {
    normalizedArgs = applyTextBudgetPreset(args);
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
  return callBridgeTool(entry.method, entry.params(normalizedArgs), {
    tabId: typeof normalizedArgs.tabId === 'number' ? normalizedArgs.tabId : null,
    tokenBudget: getToolTokenBudget(normalizedArgs),
  });
}

/**
 * @param {{ calls?: Array<{ method?: string, params?: Record<string, unknown>, tabId?: number, budgetPreset?: 'quick' | 'normal' | 'deep' }> }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleBatchTool(args) {
  if (!Array.isArray(args.calls) || args.calls.length === 0) {
    return summarizeToolError('calls must be a non-empty array.');
  }

  const calls = args.calls;
  return withToolClient(async (client) => {
    const results = await Promise.all(
      calls.map(async (call) => {
        if (!call || typeof call !== 'object' || typeof call.method !== 'string') {
          return {
            method: '',
            tabId: null,
            ok: false,
            summary: 'INVALID_REQUEST: Each batch call needs a method.',
            evidence: null,
            error: {
              code: 'INVALID_REQUEST',
              message: 'Each batch call needs a method.',
            },
            response: null,
          };
        }

        if (!METHOD_SET.has(/** @type {BridgeMethod} */ (call.method))) {
          return {
            method: call.method,
            tabId: null,
            ok: false,
            summary: `INVALID_REQUEST: Unknown bridge method "${call.method}".`,
            evidence: null,
            error: {
              code: 'INVALID_REQUEST',
              message: `Unknown bridge method "${call.method}".`,
            },
            response: null,
          };
        }

        const method = /** @type {BridgeMethod} */ (call.method);
        const tabId = bridgeMethodNeedsTab(method)
          ? typeof call.tabId === 'number'
            ? call.tabId
            : null
          : null;
        const tokenBudget = getToolTokenBudget(call);

        const startTime = Date.now();
        try {
          const response = await client.request({
            method,
            params: call.params || {},
            tabId,
            meta: {
              source: REQUEST_SOURCE,
              ...(tokenBudget != null ? { token_budget: tokenBudget } : {}),
            },
          });
          return summarizeBatchResponseItem({
            method,
            tabId,
            response,
            durationMs: Date.now() - startTime,
          });
        } catch (error) {
          return summarizeBatchErrorItem({
            method,
            tabId,
            error,
            durationMs: Date.now() - startTime,
          });
        }
      })
    );

    const failureCount = results.filter((result) => !result.ok).length;
    const summary =
      failureCount === 0
        ? `Batch executed ${results.length} call(s).`
        : `Batch executed ${results.length} call(s) with ${failureCount} error(s).`;
    return createToolResult(
      summary,
      {
        ok: failureCount === 0,
        results,
      },
      failureCount > 0
    );
  });
}

/**
 * @param {{ method: string, params?: Record<string, unknown>, tabId?: number }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleRawCallTool(args) {
  if (!METHOD_SET.has(/** @type {BridgeMethod} */ (args.method))) {
    return summarizeToolError(`Unknown bridge method "${args.method}".`);
  }

  return withToolClient(async (client) => {
    const response = await requestBridge(
      client,
      /** @type {BridgeMethod} */ (args.method),
      args.params || {},
      {
        tabId: typeof args.tabId === 'number' ? args.tabId : null,
        source: REQUEST_SOURCE,
      }
    );

    if (!response.ok) {
      return createToolResult(
        response.error.message,
        {
          ok: false,
          error: response.error,
          response,
        },
        true
      );
    }

    return createToolResult(`Called ${args.method}.`, {
      ok: true,
      response: response.result,
    });
  });
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
 * @param {{ objective: string, scope?: 'quick' | 'normal' | 'deep', tabId?: number, selector?: string }} args
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

  return withToolClient(async (client) => {
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
  });
}
