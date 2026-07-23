// @ts-check

import { randomUUID } from 'node:crypto';

import {
  BridgeError,
  bridgeMethodNeedsTab,
  DEFAULT_CONSOLE_LIMIT,
  DEFAULT_LOG_TAIL_LIMIT,
  DEFAULT_MAX_HTML_LENGTH,
  DEFAULT_MAX_NODES,
  DEFAULT_NETWORK_LIMIT,
  DEFAULT_PAGE_TEXT_BUDGET,
  DEFAULT_TEXT_BUDGET,
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
const MCP_CLIENT_ID = `mcp_${randomUUID()}`;

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
  'page.extract_content',
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
    return (
      params.clear !== true &&
      (method !== 'page.get_network' ||
        params.source !== 'cdp' ||
        params.capture === undefined ||
        params.capture === 'read')
    );
  }
  return RETRY_SAFE_METHODS.has(method);
}

/**
 * @typedef {{
 *   content: [
 *     { type: 'text', text: string },
 *     ...Array<{ type: 'image', data: string, mimeType: string }>
 *   ],
 *   structuredContent: Record<string, unknown>,
 *   isError?: boolean
 * }} ToolResult
 */

/**
 * @param {string} summary
 * @param {Record<string, unknown>} [structuredContent={}]
 * @param {boolean} [isError=false]
 * @param {Array<{ type: 'image', data: string, mimeType: string }>} [additionalContent=[]]
 * @returns {ToolResult}
 */
export function createToolResult(
  summary,
  structuredContent = {},
  isError = false,
  additionalContent = []
) {
  const toolResult = {
    content: /** @type {ToolResult['content']} */ ([
      { type: 'text', text: summary },
      ...additionalContent,
    ]),
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
 * @param {Record<string, unknown>} [params]
 * @returns {ToolResult}
 */
export function summarizeToolResponse(response, method, params = {}) {
  const summary = annotateBridgeSummary(summarizeBridgeResponse(response, method), response);
  const summaryRecord = /** @type {Record<string, unknown>} */ (summary);
  if (response.ok) {
    const evidence = getRequestAwareEvidence(response.result, method, params, summary.evidence);
    summary.evidence = evidence.value;
    if (evidence.metadata) summaryRecord.evidenceMeta = evidence.metadata;
    if (evidence.truncated) {
      summaryRecord.outputTruncated = true;
      summaryRecord.outputLimit = evidence.limit;
    }
  } else {
    const bounded = boundToolValue(summary.evidence);
    summary.evidence = bounded.value;
    summaryRecord.error = {
      ...response.error,
      details: boundToolValue(response.error.details).value,
    };
    if (bounded.truncated) summaryRecord.outputTruncated = true;
  }
  return createToolResult(summary.summary, summary, !summary.ok);
}

/**
 * @param {unknown} error
 * @returns {ToolResult}
 */
export function summarizeToolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const record =
    error && typeof error === 'object' ? /** @type {Record<string, unknown>} */ (error) : {};
  const code =
    typeof record.code === 'string'
      ? record.code
      : typeof error === 'string'
        ? 'INVALID_REQUEST'
        : 'INTERNAL_ERROR';
  const details = Object.hasOwn(record, 'details') ? record.details : null;
  const boundedDetails = boundToolValue(details);
  const recovery = getErrorRecovery(code);
  return createToolResult(
    `${code}: ${message}${recovery?.hint ? ` ${recovery.hint}` : ''}`,
    {
      ok: false,
      evidence: boundedDetails.value,
      error: { code, message, details: boundedDetails.value },
      recovery,
      ...(boundedDetails.truncated ? { outputTruncated: true } : {}),
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
      return await withBridgeClient(callback, {
        checkProtocolOnConnect: false,
        clientId: MCP_CLIENT_ID,
      });
    }
    const client = await createBridgeClientForDestination(options.destinationId, {
      checkProtocolOnConnect: false,
      clientId: MCP_CLIENT_ID,
    });
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
  throw new BridgeError('INVALID_REQUEST', 'Provide either elementRef or selector.');
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
 * Apply a preset to method parameters before dispatch. Explicit method params
 * always win over preset defaults.
 *
 * @param {BridgeMethod} method
 * @param {Record<string, unknown>} params
 * @param {unknown} budgetPreset
 * @returns {Record<string, unknown>}
 */
export function applyMethodBudgetPreset(method, params, budgetPreset) {
  const args = { ...params, budgetPreset };
  let normalized = args;
  if (method === 'dom.query' || method === 'dom.get_accessibility_tree') {
    normalized = applyTreeBudgetPreset(args);
  } else if (method === 'dom.get_text') {
    normalized = applyTextBudgetPreset(args);
  } else if (method === 'dom.get_html') {
    normalized = applyHtmlBudgetPreset(args);
  } else if (method === 'page.get_text' || method === 'page.extract_content') {
    normalized = applyPageTextBudgetPreset(args);
  } else if (method === 'page.get_console') {
    normalized = applyLimitBudgetPreset(args, {
      quick: 10,
      normal: DEFAULT_CONSOLE_LIMIT,
      deep: 100,
    });
  } else if (method === 'page.get_network') {
    normalized = applyLimitBudgetPreset(args, {
      quick: 10,
      normal: DEFAULT_NETWORK_LIMIT,
      deep: 100,
    });
  } else if (method === 'log.tail') {
    normalized = applyLimitBudgetPreset(args, {
      quick: 10,
      normal: DEFAULT_LOG_TAIL_LIMIT,
      deep: 100,
    });
  }
  const { budgetPreset: _budgetPreset, ...methodParams } = normalized;
  return methodParams;
}

/**
 * @param {unknown} input
 * @param {{ maxEntries?: number, maxCharacters?: number, maxStringLength?: number }} [options]
 * @returns {{ value: unknown, truncated: boolean, limit: Record<string, number>, metadata?: Record<string, unknown> }}
 */
export function boundToolValue(input, options = {}) {
  const maxEntries = options.maxEntries ?? 500;
  const maxCharacters = options.maxCharacters ?? 20_000;
  const maxStringLength = options.maxStringLength ?? 4_000;
  const state = { entries: 0, characters: 0, truncated: false };
  /** @type {(value: unknown, depth: number) => unknown} */
  const visit = (value, depth) => {
    if (state.entries >= maxEntries || state.characters >= maxCharacters || depth > 8) {
      state.truncated = true;
      return '[truncated]';
    }
    state.entries += 1;
    if (typeof value === 'string') {
      const limit = Math.min(value.length, maxStringLength, maxCharacters - state.characters);
      state.characters += limit;
      if (limit === value.length) return value;
      state.truncated = true;
      return value.slice(0, Math.max(0, limit));
    }
    if (Array.isArray(value)) {
      const limit = Math.min(value.length, 100, maxEntries - state.entries);
      if (limit < value.length) state.truncated = true;
      return value.slice(0, limit).map((entry) => visit(entry, depth + 1));
    }
    if (value && typeof value === 'object') {
      /** @type {Record<string, unknown>} */
      const output = {};
      const entries = Object.entries(/** @type {Record<string, unknown>} */ (value));
      const limit = Math.min(entries.length, 100);
      if (limit < entries.length) state.truncated = true;
      for (const [key, entry] of entries.slice(0, limit)) {
        if (state.entries >= maxEntries || state.characters >= maxCharacters) {
          state.truncated = true;
          break;
        }
        state.characters += key.length;
        output[key] = visit(entry, depth + 1);
      }
      return output;
    }
    return value;
  };
  return {
    value: visit(input, 0),
    truncated: state.truncated,
    limit: { maxEntries, maxCharacters, maxStringLength },
  };
}

/**
 * Preserve useful evidence up to the caller's requested limits instead of
 * fetching normal/deep results and silently returning only a fixed preview.
 *
 * @param {unknown} rawResult
 * @param {string | undefined} method
 * @param {Record<string, unknown>} params
 * @param {unknown} fallback
 * @returns {{ value: unknown, truncated: boolean, limit: Record<string, number>, metadata?: Record<string, unknown> }}
 */
function getRequestAwareEvidence(rawResult, method, params, fallback) {
  const result =
    rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)
      ? /** @type {Record<string, unknown>} */ (rawResult)
      : {};
  if (method === 'page.extract_content' && typeof result.content === 'string') {
    const requested = positiveInteger(params.textBudget) ?? DEFAULT_PAGE_TEXT_BUDGET;
    const maxCharacters = Math.min(requested, 16_000);
    const content = result.content.slice(0, maxCharacters);
    return {
      value: {
        ...result,
        content,
        returnedChars: content.length,
      },
      truncated: result.content.length > maxCharacters,
      limit: { maxCharacters },
    };
  }
  if (method === 'page.get_text' || method === 'dom.get_text') {
    const text = typeof result.text === 'string' ? result.text : result.value;
    if (typeof text === 'string') {
      const defaultLimit =
        method === 'page.get_text' ? DEFAULT_PAGE_TEXT_BUDGET : DEFAULT_TEXT_BUDGET;
      const requested = positiveInteger(params.textBudget) ?? defaultLimit;
      const maxCharacters = Math.min(requested, 16_000);
      const outputTruncated = text.length > maxCharacters;
      return {
        value: {
          text: text.slice(0, maxCharacters),
          length: typeof result.length === 'number' ? result.length : text.length,
          truncated: result.truncated === true,
          returnedChars: Math.min(text.length, maxCharacters),
        },
        truncated: outputTruncated,
        limit: { maxCharacters },
      };
    }
  }
  if (method === 'dom.get_html' && typeof result.html === 'string') {
    const requested = positiveInteger(params.maxLength) ?? DEFAULT_MAX_HTML_LENGTH;
    const maxCharacters = Math.min(requested, 10_000);
    return {
      value: {
        html: result.html.slice(0, maxCharacters),
        truncated: result.truncated === true,
        returnedChars: Math.min(result.html.length, maxCharacters),
      },
      truncated: result.html.length > maxCharacters,
      limit: { maxCharacters },
    };
  }
  if (method === 'dom.query' && Array.isArray(result.nodes)) {
    const maxEntries = Math.min(positiveInteger(params.maxNodes) ?? DEFAULT_MAX_NODES, 100);
    const nodes = result.nodes.slice(0, maxEntries).map(compactDomNode);
    return {
      value: nodes,
      truncated: result.truncated === true || result.nodes.length > maxEntries,
      limit: { maxEntries },
    };
  }
  if (method === 'dom.get_accessibility_tree' && Array.isArray(result.nodes)) {
    const maxEntries = Math.min(positiveInteger(params.maxNodes) ?? DEFAULT_MAX_NODES, 100);
    const nodes = result.nodes.slice(0, maxEntries).map((value) => {
      const node =
        value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
      return {
        nodeId: node.nodeId,
        role: node.role,
        name: node.name,
        ...(node.interactive === true ? { interactive: true } : {}),
        ...(node.semanticInteractive === true ? { semanticInteractive: true } : {}),
        ...(node.focusableAndEnabled === true ? { focusableAndEnabled: true } : {}),
        ...(node.value !== undefined ? { value: node.value } : {}),
        childIds: Array.isArray(node.childIds) ? node.childIds : [],
      };
    });
    return {
      value: nodes,
      metadata: {
        rootIds: Array.isArray(result.rootIds) ? result.rootIds : [],
        count: result.count,
        total: result.total,
        rawTotal: result.rawTotal,
        source: result.source,
        compact: result.compact,
        interactiveOnly: result.interactiveOnly,
        truncated: result.truncated,
        truncation: result.truncation,
        continuationHint: result.continuationHint,
      },
      truncated: result.truncated === true || result.nodes.length > maxEntries,
      limit: { maxEntries },
    };
  }
  if (
    (method === 'page.get_console' || method === 'page.get_network' || method === 'log.tail') &&
    Array.isArray(result.entries)
  ) {
    const defaultLimit =
      method === 'page.get_console'
        ? DEFAULT_CONSOLE_LIMIT
        : method === 'page.get_network'
          ? DEFAULT_NETWORK_LIMIT
          : DEFAULT_LOG_TAIL_LIMIT;
    const maxEntries = Math.min(positiveInteger(params.limit) ?? defaultLimit, 100);
    const selected =
      method === 'log.tail'
        ? result.entries.slice(-maxEntries)
        : result.entries.slice(0, maxEntries);
    const bounded = boundToolValue(selected, { maxEntries: 500, maxCharacters: 20_000 });
    return {
      value:
        method === 'page.get_network'
          ? {
              entries: bounded.value,
              count: result.count,
              total: result.total,
              filteredTotal: result.filteredTotal,
              dropped: result.dropped,
              abandoned: result.abandoned,
              source: result.source,
              capture: result.capture,
              armed: result.armed,
              armedDuringCapture: result.armedDuringCapture,
              captureState: result.captureState,
              startedAt: result.startedAt,
              inflight: result.inflight,
              ownershipHeld: result.ownershipHeld,
              truncated: result.truncated,
              truncation: result.truncation,
            }
          : bounded.value,
      truncated: result.entries.length > maxEntries || bounded.truncated,
      limit: { maxEntries, maxCharacters: 20_000 },
    };
  }
  return boundToolValue(fallback);
}

/** @param {unknown} value */
function positiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function compactDomNode(value) {
  const node =
    value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
  const attrs =
    node.attrs && typeof node.attrs === 'object'
      ? /** @type {Record<string, unknown>} */ (node.attrs)
      : {};
  /** @type {Record<string, unknown>} */
  const compact = { ref: node.elementRef, tag: node.tag };
  if (node.id ?? attrs.id) compact.id = node.id ?? attrs.id;
  if (typeof attrs.class === 'string') compact.cls = attrs.class.split(' ').slice(0, 3).join(' ');
  if (node.role ?? attrs.role) compact.role = node.role ?? attrs.role;
  if (node.name ?? attrs['aria-label']) compact.label = node.name ?? attrs['aria-label'];
  if (attrs['data-testid']) compact.testId = attrs['data-testid'];
  const text = typeof node.textExcerpt === 'string' ? node.textExcerpt : node.text;
  if (typeof text === 'string' && text) compact.text = text.slice(0, 120);
  if (Array.isArray(node.children) && node.children.length)
    compact.childCount = node.children.length;
  return compact;
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
  const recovery =
    !response.ok && response.error
      ? (response.error.recovery ?? getErrorRecovery(response.error.code))
      : null;
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
      return summarizeToolResponse(response, options.summaryMethod || method, params);
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
      const params = entry.params(args, ref);
      const response = await requestBridgeWithRetry(client, entry.method, params, {
        tabId: requestedTabId,
        source: REQUEST_SOURCE,
        tokenBudget: getToolTokenBudget(/** @type {{ budgetPreset?: unknown }} */ (args)),
      });
      return summarizeToolResponse(response, entry.method, params);
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
