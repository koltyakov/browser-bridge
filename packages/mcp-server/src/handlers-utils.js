// @ts-check

import { AsyncLocalStorage } from 'node:async_hooks';
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
  getBudgetPresetName,
  getErrorRecovery,
  summarizeBatchErrorItem,
  summarizeBatchResponseItem,
} from '../../protocol/src/index.js';

export {
  applyHtmlBudgetPreset,
  applyLimitBudgetPreset,
  applyMethodBudgetPreset,
  applyPageTextBudgetPreset,
  applyTextBudgetPreset,
  applyTreeBudgetPreset,
  getBudgetPresetName,
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
/** @type {AsyncLocalStorage<{ era: import('../../protocol/src/types.js').McpProtocolEra, signal?: AbortSignal }>} */
const MCP_REQUEST_ERA = new AsyncLocalStorage();

/**
 * @template T
 * @param {import('../../protocol/src/types.js').McpProtocolEra} era
 * @param {() => T} callback
 * @param {AbortSignal} [signal]
 * @returns {T}
 */
export function runWithMcpRequestEra(era, callback, signal) {
  return MCP_REQUEST_ERA.run({ era, signal }, callback);
}

/** @returns {void} */
export function throwIfMcpRequestCancelled() {
  MCP_REQUEST_ERA.getStore()?.signal?.throwIfAborted();
}

/**
 * Race request-owned work against cancellation and an optional absolute budget.
 * Connection attempts can finish after close(), so dispose late completions too.
 *
 * @template T
 * @param {() => Promise<T>} operation
 * @param {{ timeoutMs?: number, onCancel?: () => void }} [options]
 * @returns {Promise<T>}
 */
function awaitMcpOperation(operation, options = {}) {
  const signal = MCP_REQUEST_ERA.getStore()?.signal;
  const deadline = options.timeoutMs === undefined ? null : Date.now() + options.timeoutMs;
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancelled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    /** @param {unknown} error */
    const cancel = (error) => {
      if (settled) return;
      settled = true;
      cancelled = true;
      cleanup();
      options.onCancel?.();
      reject(error);
    };
    const onAbort = () => cancel(signal?.reason);
    const onTimeout = () => cancel(new BridgeError('TIMEOUT', 'MCP connection deadline exceeded.'));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (deadline !== null) {
      timer = setTimeout(onTimeout, Math.max(0, deadline - Date.now()));
    }
    Promise.resolve()
      .then(() => {
        if (deadline !== null && Date.now() >= deadline) onTimeout();
        if (settled) return undefined;
        return operation();
      })
      .then(
        (result) => {
          if (cancelled) options.onCancel?.();
          if (!settled && deadline !== null && Date.now() >= deadline) onTimeout();
          if (settled) return;
          settled = true;
          cleanup();
          resolve(/** @type {T} */ (result));
        },
        (error) => {
          if (cancelled) options.onCancel?.();
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        }
      );
  });
}

/**
 * @param {number} delayMs
 * @returns {Promise<void>}
 */
function waitForMcpRequest(delayMs) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  return awaitMcpOperation(
    () =>
      new Promise((resolve) => {
        timer = setTimeout(resolve, delayMs);
      }),
    { onCancel: () => clearTimeout(timer) }
  );
}

/**
 * @param {import('../../agent-client/src/client.js').BridgeClient} client
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function connectMcpClient(client, timeoutMs) {
  return awaitMcpOperation(() => client.connect(), {
    timeoutMs,
    onCancel: () => {
      void client.close().catch(() => {});
    },
  });
}

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
  'dom.baseline.compare',
  'dom.baseline.describe',
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
  'artifact.read',
  'network.intercept.list',
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
      (params.clear === undefined || params.clear === false) &&
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
    return await withMcpRequestClient(callback, options);
  } catch (error) {
    return summarizeToolError(error);
  }
}

/**
 * @template T
 * @param {(client: import('../../agent-client/src/client.js').BridgeClient) => Promise<T>} callback
 * @param {{ destinationId?: string | null }} [options]
 * @returns {Promise<T>}
 */
export async function withMcpRequestClient(callback, options = {}) {
  throwIfMcpRequestCancelled();
  const client = await createBridgeClientForDestination(options.destinationId, {
    checkProtocolOnConnect: false,
    clientId: MCP_CLIENT_ID,
  });
  let completed = false;
  try {
    const result = await awaitMcpOperation(
      async () => {
        await connectMcpClient(client, client.defaultTimeoutMs);
        throwIfMcpRequestCancelled();
        return callback(client);
      },
      {
        onCancel: () => {
          void client.close().catch(() => {});
        },
      }
    );
    completed = true;
    return result;
  } finally {
    if (completed) {
      await client.close();
    } else {
      await client.close().catch(() => {});
    }
  }
}

/**
 * @param {import('../../agent-client/src/client.js').BridgeClient} client
 * @param {{ elementRef?: string | undefined, selector?: string | undefined }} input
 * @param {number | null | undefined} [tabId]
 * @returns {Promise<string>}
 */
export async function resolveToolRef(client, input, tabId = null) {
  throwIfMcpRequestCancelled();
  if (typeof input.elementRef === 'string' && input.elementRef) {
    return input.elementRef;
  }
  if (typeof input.selector === 'string' && input.selector) {
    const response = await requestBridgeWithRetry(
      client,
      'dom.query',
      {
        selector: input.selector,
      },
      { tabId, source: REQUEST_SOURCE }
    );
    if (!response.ok) {
      throw new BridgeError(response.error.code, response.error.message, response.error.details);
    }
    const result = /** @type {{ nodes?: Array<{ elementRef: string }> }} */ (response.result);
    if (!result.nodes?.length) {
      throw new BridgeError(
        'INVALID_REQUEST',
        `No element found for selector "${input.selector}".`,
        {
          selector: input.selector,
        }
      );
    }
    return result.nodes[0].elementRef;
  }
  throw new BridgeError('INVALID_REQUEST', 'Provide either elementRef or selector.');
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
  if (method?.startsWith('network.intercept.')) {
    const bounded = boundToolValue(result, { maxEntries: 100, maxCharacters: 10_000 });
    return {
      value: bounded.value,
      truncated: bounded.truncated,
      limit: { maxEntries: 100, maxCharacters: 10_000 },
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
 * Socket-level Node error codes that mean the daemon connection itself was
 * lost, as opposed to an application-level bridge failure.
 *
 * @type {ReadonlySet<string>}
 */
const CONNECTION_LOSS_CODES = new Set([
  'ENOTCONN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ERR_SOCKET_CLOSED',
]);

const RECONNECT_WAIT_TIMEOUT_MS = 5_000;
const RECONNECT_POLL_INTERVAL_MS = 250;

/**
 * Detect thrown transport errors caused by a lost daemon connection. These
 * never arrive as bridge failure responses because the socket died before (or
 * while) the daemon could reply.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isConnectionLossError(error) {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = /** @type {{ code?: unknown }} */ (error).code;
  if (typeof code === 'string' && CONNECTION_LOSS_CODES.has(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : '';
  return /Bridge socket closed|BridgeClient is not connected/u.test(message);
}

/**
 * Wait, bounded, for the client to regain its daemon connection.
 *
 * When the client's own auto-reconnect loop is active it owns reconnecting and
 * reconnects independently; otherwise one manual connect is attempted per poll
 * interval. Application state is never touched here - this only restores the
 * transport.
 *
 * @param {import('../../agent-client/src/client.js').BridgeClient} client
 * @param {number} [timeoutMs=RECONNECT_WAIT_TIMEOUT_MS]
 * @returns {Promise<boolean>}
 */
export async function waitForClientReconnect(client, timeoutMs = RECONNECT_WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  throwIfMcpRequestCancelled();
  while (!client.connected && Date.now() < deadline) {
    if (client.autoReconnect) {
      await waitForMcpRequest(Math.min(RECONNECT_POLL_INTERVAL_MS, deadline - Date.now()));
      continue;
    }
    try {
      await connectMcpClient(client, deadline - Date.now());
    } catch (error) {
      throwIfMcpRequestCancelled();
      if (error instanceof BridgeError && error.code === 'TIMEOUT') return false;
      if (error instanceof Error && /already connected/u.test(error.message)) {
        break;
      }
      // Daemon still unreachable; keep waiting inside the bounded window.
    }
    if (!client.connected) {
      const remaining = Math.max(0, deadline - Date.now());
      await waitForMcpRequest(Math.min(RECONNECT_POLL_INTERVAL_MS, remaining));
    }
  }
  return client.connected;
}

/**
 * @param {import('../../agent-client/src/client.js').BridgeClient} client
 * @param {BridgeMethod} method
 * @param {Record<string, unknown>} params
 * @param {{ tabId?: number | null, source?: import('../../protocol/src/types.js').BridgeRequestSource, mcpEra?: import('../../protocol/src/types.js').McpProtocolEra, tokenBudget?: number | null, automaticRetry?: 'mcp_second_attempt' }} options
 * @returns {Promise<BridgeResponse>}
 */
export async function requestBridgeWithRetry(client, method, params, options) {
  const requestOptions = {
    ...options,
    mcpEra: options.mcpEra ?? MCP_REQUEST_ERA.getStore()?.era,
  };
  /** @param {typeof requestOptions} attemptOptions */
  const attempt = (attemptOptions) =>
    awaitMcpOperation(async () => {
      throwIfMcpRequestCancelled();
      if (!client.connected) await connectMcpClient(client, client.defaultTimeoutMs);
      throwIfMcpRequestCancelled();
      return requestBridge(client, method, params, attemptOptions);
    });
  /** @type {BridgeResponse} */
  let response;
  try {
    response = await attempt(requestOptions);
  } catch (error) {
    throwIfMcpRequestCancelled();
    if (!isConnectionLossError(error) || !isRetrySafeBridgeMethod(method, params)) {
      throw error;
    }
    process.stderr.write(
      `[bbx-mcp] ${method} lost its daemon connection; waiting up to ${RECONNECT_WAIT_TIMEOUT_MS}ms for reconnect before one retry.\n`
    );
    if (!(await waitForClientReconnect(client))) {
      throw error;
    }
    return attempt({
      ...requestOptions,
      automaticRetry: 'mcp_second_attempt',
    });
  }
  const recovery =
    !response.ok && response.error
      ? (response.error.recovery ?? getErrorRecovery(response.error.code))
      : null;
  if (!response.ok && recovery?.retry && isRetrySafeBridgeMethod(method, params)) {
    const delay = recovery.retryAfterMs ?? 1000;
    process.stderr.write(
      `[bbx-mcp] Retrying ${method} after ${delay}ms (${response.error.code})\n`
    );
    await waitForMcpRequest(delay);
    return attempt({
      ...requestOptions,
      automaticRetry: 'mcp_second_attempt',
    });
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
