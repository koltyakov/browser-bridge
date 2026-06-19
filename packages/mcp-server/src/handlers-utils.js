// @ts-check

import {
  bridgeMethodNeedsTab,
  DEFAULT_MAX_HTML_LENGTH,
  DEFAULT_PAGE_TEXT_BUDGET,
  estimateJsonPayloadCost,
  getBudgetPreset,
  getErrorRecovery,
  isBudgetPresetName,
  summarizeBatchErrorItem,
  summarizeBatchResponseItem,
} from '../../protocol/src/index.js';
import {
  getDoctorReport,
  requestBridge,
  resolveRef,
  withBridgeClient,
} from '../../agent-client/src/runtime.js';
import {
  createBridgeClientForDestination,
  listBridgeDestinations,
} from '../../agent-client/src/remotes.js';
import { annotateBridgeSummary, summarizeBridgeResponse } from '../../agent-client/src/subagent.js';

/** @typedef {import('../../protocol/src/types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */

export const REQUEST_SOURCE = 'mcp';

/** @type {ReadonlySet<BridgeMethod>} */
const RETRY_SAFE_METHODS = new Set([
  'skill.get_runtime_context',
  'setup.get_status',
  'log.tail',
  'health.ping',
  'daemon.metrics',
  'tabs.list',
  'page.get_state',
  'page.get_storage',
  'page.get_text',
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
  'screenshot.capture_region',
  'screenshot.capture_element',
  'screenshot.capture_full_page',
  'performance.get_metrics',
  'cdp.get_document',
  'cdp.get_dom_snapshot',
  'cdp.get_box_model',
  'cdp.get_computed_styles_for_node',
]);

/**
 * @param {BridgeMethod} method
 * @param {Record<string, unknown>} params
 * @returns {boolean}
 */
export function isRetrySafeBridgeMethod(method, params) {
  if (method === 'page.get_console' || method === 'page.get_network') {
    return params.clear !== true;
  }
  return RETRY_SAFE_METHODS.has(method);
}

/**
 * @typedef {{
 *   content: Array<{ type: 'text', text: string }>,
 *   structuredContent: Record<string, unknown>,
 *   isError?: boolean
 * }} ToolResult
 */

/**
 * @param {string} summary
 * @param {Record<string, unknown>} [structuredContent={}]
 * @param {boolean} [isError=false]
 * @returns {ToolResult}
 */
export function createToolResult(summary, structuredContent = {}, isError = false) {
  const toolResult = {
    content: [{ type: /** @type {'text'} */ ('text'), text: summary }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
  const delivered = estimateJsonPayloadCost(toolResult);
  return {
    ...toolResult,
    structuredContent: {
      ...structuredContent,
      deliveredBytes: delivered.bytes,
      deliveredTokens: delivered.approxTokens,
      deliveredCostClass: delivered.costClass,
    },
  };
}

/**
 * @param {BridgeResponse} response
 * @param {string} [method]
 * @returns {ToolResult}
 */
export function summarizeToolResponse(response, method) {
  const summary = annotateBridgeSummary(summarizeBridgeResponse(response, method), response);
  return createToolResult(summary.summary, summary, !summary.ok);
}

/**
 * @param {unknown} error
 * @returns {ToolResult}
 */
export function summarizeToolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return createToolResult(
    `ERROR: ${message}`,
    {
      ok: false,
      evidence: null,
    },
    true
  );
}

/**
 * @param {(client: import('../../agent-client/src/client.js').BridgeClient) => Promise<ToolResult>} callback
 * @param {{ destinationId?: string | null }} [options]
 * @returns {Promise<ToolResult>}
 */
export async function withToolClient(callback, options = {}) {
  try {
    if (!options.destinationId) {
      return await withBridgeClient(callback);
    }
    const client = await createBridgeClientForDestination(options.destinationId);
    await client.connect();
    try {
      return await callback(client);
    } finally {
      await client.close();
    }
  } catch (error) {
    return summarizeToolError(error);
  }
}

/**
 * @param {import('../../agent-client/src/client.js').BridgeClient} client
 * @param {{ elementRef?: string | undefined, selector?: string | undefined }} input
 * @param {number | null | undefined} [tabId]
 * @returns {Promise<string>}
 */
export async function resolveToolRef(client, input, tabId = null) {
  if (typeof input.elementRef === 'string' && input.elementRef) {
    return input.elementRef;
  }
  if (typeof input.selector === 'string' && input.selector) {
    return resolveRef(client, input.selector, tabId, REQUEST_SOURCE);
  }
  throw new Error('Provide either elementRef or selector.');
}

/**
 * @param {unknown} value
 * @returns {'quick' | 'normal' | 'deep' | null}
 */
export function getBudgetPresetName(value) {
  return isBudgetPresetName(value) ? value : null;
}

/**
 * @param {{ budgetPreset?: unknown, selector?: unknown, elementRef?: unknown }} args
 * @returns {'quick' | 'normal' | 'deep' | null}
 */
export function inferBudgetFromSelector(args) {
  if (getBudgetPresetName(args.budgetPreset)) return null;
  if (typeof args.elementRef === 'string' && args.elementRef) return 'quick';
  const sel = typeof args.selector === 'string' ? args.selector.trim() : '';
  if (!sel || sel === '*' || sel === 'body') return null;
  if (/^#[\w-]+$/.test(sel)) return 'quick';
  if ((sel.match(/\s/g) || []).length >= 3) return 'deep';
  return 'normal';
}

/**
 * @param {{ budgetPreset?: unknown }} args
 * @returns {number | null}
 */
export function getToolTokenBudget(args) {
  const presetName = getBudgetPresetName(args.budgetPreset);
  return presetName ? getBudgetPreset(presetName).tokenBudget : null;
}

/**
 * @template {{ budgetPreset?: unknown, maxNodes?: unknown, maxDepth?: unknown, textBudget?: unknown }} T
 * @param {T} args
 * @returns {T}
 */
export function applyTreeBudgetPreset(args) {
  const presetName = getBudgetPresetName(args.budgetPreset);
  if (!presetName) {
    return args;
  }
  const preset = getBudgetPreset(presetName);
  return /** @type {T} */ ({
    ...args,
    maxNodes: args.maxNodes ?? preset.maxNodes,
    maxDepth: args.maxDepth ?? preset.maxDepth,
    textBudget: args.textBudget ?? preset.textBudget,
  });
}

/**
 * @template {{ budgetPreset?: unknown, textBudget?: unknown }} T
 * @param {T} args
 * @returns {T}
 */
export function applyTextBudgetPreset(args) {
  const presetName = getBudgetPresetName(args.budgetPreset);
  if (!presetName) {
    return args;
  }
  const preset = getBudgetPreset(presetName);
  return /** @type {T} */ ({
    ...args,
    textBudget: args.textBudget ?? preset.textBudget,
  });
}

/**
 * @template {{ budgetPreset?: unknown, textBudget?: unknown }} T
 * @param {T} args
 * @returns {T}
 */
export function applyPageTextBudgetPreset(args) {
  const presetName = getBudgetPresetName(args.budgetPreset);
  if (!presetName) {
    return args;
  }
  const textBudgetByPreset = {
    quick: 2000,
    normal: DEFAULT_PAGE_TEXT_BUDGET,
    deep: DEFAULT_PAGE_TEXT_BUDGET * 2,
  };
  return /** @type {T} */ ({
    ...args,
    textBudget: args.textBudget ?? textBudgetByPreset[presetName],
  });
}

/**
 * @template {{ budgetPreset?: unknown, limit?: unknown }} T
 * @param {T} args
 * @param {{ quick: number, normal: number, deep: number }} defaults
 * @returns {T}
 */
export function applyLimitBudgetPreset(args, defaults) {
  const presetName = getBudgetPresetName(args.budgetPreset);
  if (!presetName) {
    return args;
  }
  return /** @type {T} */ ({
    ...args,
    limit: args.limit ?? defaults[presetName],
  });
}

/**
 * @template {{ budgetPreset?: unknown, maxLength?: unknown }} T
 * @param {T} args
 * @returns {T}
 */
export function applyHtmlBudgetPreset(args) {
  const presetName = getBudgetPresetName(args.budgetPreset);
  if (!presetName) {
    return args;
  }
  const maxLengthByPreset = {
    quick: 600,
    normal: DEFAULT_MAX_HTML_LENGTH,
    deep: 6000,
  };
  return /** @type {T} */ ({
    ...args,
    maxLength: args.maxLength ?? maxLengthByPreset[presetName],
  });
}

/**
 * @param {import('../../agent-client/src/client.js').BridgeClient} client
 * @param {BridgeMethod} method
 * @param {Record<string, unknown>} params
 * @param {{ tabId?: number | null, source?: import('../../protocol/src/types.js').BridgeRequestSource, tokenBudget?: number | null }} options
 * @returns {Promise<BridgeResponse>}
 */
export async function requestBridgeWithRetry(client, method, params, options) {
  const response = await requestBridge(client, method, params, options);
  const recovery = !response.ok && response.error ? getErrorRecovery(response.error.code) : null;
  if (!response.ok && recovery?.retry && isRetrySafeBridgeMethod(method, params)) {
    const delay = recovery.retryAfterMs ?? 1000;
    process.stderr.write(
      `[bbx-mcp] Retrying ${method} after ${delay}ms (${response.error.code})\n`
    );
    await new Promise((r) => setTimeout(r, delay));
    return requestBridge(client, method, params, options);
  }
  return response;
}

/**
 * @param {BridgeMethod} method
 * @param {Record<string, unknown>} [params={}]
 * @param {{ tabId?: number | null, summaryMethod?: string, tokenBudget?: number | null, destinationId?: string | null }} [options]
 * @returns {Promise<ToolResult>}
 */
export async function callBridgeTool(method, params = {}, options = {}) {
  return withToolClient(
    async (client) => {
      const response = await requestBridgeWithRetry(client, method, params, {
        tabId: options.tabId ?? null,
        source: REQUEST_SOURCE,
        tokenBudget: options.tokenBudget ?? null,
      });
      return summarizeToolResponse(response, options.summaryMethod || method);
    },
    { destinationId: options.destinationId ?? null }
  );
}

/**
 * @returns {Promise<Array<{ id: string, local: boolean, host: string | null, port: number | null }>>}
 */
export async function getBridgeDestinations() {
  return listBridgeDestinations();
}

/**
 * @typedef {{ ref: boolean, method: BridgeMethod, params: (args: Record<string, unknown>, ref?: string) => Record<string, unknown> }} ToolAction
 */

/**
 * @param {Record<string, ToolAction>} actions
 * @param {Record<string, unknown> & { action: string }} args
 * @param {string} toolName
 * @returns {Promise<ToolResult>}
 */
export async function dispatchToolAction(actions, args, toolName) {
  const entry = actions[args.action];
  if (!entry) return summarizeToolError(`Unsupported ${toolName} action "${args.action}".`);
  return withToolClient(
    async (client) => {
      const requestedTabId = typeof args.tabId === 'number' ? args.tabId : null;
      const ref = entry.ref
        ? await resolveToolRef(
            client,
            /** @type {{ elementRef?: string, selector?: string }} */ (args),
            requestedTabId
          )
        : undefined;
      const response = await requestBridgeWithRetry(client, entry.method, entry.params(args, ref), {
        tabId: requestedTabId,
        source: REQUEST_SOURCE,
        tokenBudget: getToolTokenBudget(/** @type {{ budgetPreset?: unknown }} */ (args)),
      });
      return summarizeToolResponse(response, entry.method);
    },
    { destinationId: typeof args.destinationId === 'string' ? args.destinationId : null }
  );
}

export {
  bridgeMethodNeedsTab,
  getDoctorReport,
  requestBridge,
  resolveRef,
  withBridgeClient,
  listBridgeDestinations,
  annotateBridgeSummary,
  summarizeBridgeResponse,
  summarizeBatchErrorItem,
  summarizeBatchResponseItem,
};
