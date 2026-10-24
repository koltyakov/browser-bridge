import {
  createFailure,
  ERROR_CODES,
  estimateJsonPayloadCost,
  getMethodCapability,
  getCostClass,
  getUtf8ByteLength,
  isDebuggerBackedMethod,
  serializeJsonPayload,
} from '../../../protocol/src/index.js';
export { simplifyAXNode } from './background-accessibility.js';

export type BridgeResponse = import('../../../protocol/src/types.js').BridgeResponse;
export type Capability = import('../../../protocol/src/types.js').Capability;
export type ErrorCode = import('../../../protocol/src/types.js').ErrorCode;

const CDP_MODIFIER_BITS = Object.freeze({
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
});

const SPECIAL_KEY_DEFINITIONS = Object.freeze({
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
});

export function summarizeTabResult(
  tab: chrome.tabs.Tab,
  method: string
): {
  method: string;
  tabId: number | null;
  windowId: number | null;
  url: string;
  title: string;
  status: string;
} {
  return {
    method,
    tabId: typeof tab.id === 'number' ? tab.id : null,
    windowId: typeof tab.windowId === 'number' ? tab.windowId : null,
    url: tab.url ?? '',
    title: tab.title ?? '',
    status: tab.status ?? 'unknown',
  };
}

function normalizeCdpModifiers(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 15) {
    return value;
  }
  if (!Array.isArray(value)) {
    throw new Error('modifiers must be an array of Alt, Control, Meta, Shift or a bitmask 0-15.');
  }
  return value.reduce((mask, item) => {
    if (typeof item !== 'string' || !Object.hasOwn(CDP_MODIFIER_BITS, item)) {
      throw new Error('modifiers must contain only Alt, Control, Meta, or Shift.');
    }
    return mask | CDP_MODIFIER_BITS[item as keyof typeof CDP_MODIFIER_BITS];
  }, 0);
}

function inferCdpKeyDefinition(key: string): {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
} {
  if (Object.hasOwn(SPECIAL_KEY_DEFINITIONS, key)) {
    return SPECIAL_KEY_DEFINITIONS[key as keyof typeof SPECIAL_KEY_DEFINITIONS];
  }
  if (/^[a-zA-Z]$/.test(key)) {
    const upper = key.toUpperCase();
    return {
      key,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      text: key,
    };
  }
  if (/^[0-9]$/.test(key)) {
    return {
      key,
      code: `Digit${key}`,
      windowsVirtualKeyCode: key.charCodeAt(0),
      text: key,
    };
  }
  if (key.length === 1) {
    return {
      key,
      code: '',
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
      text: key,
    };
  }
  throw new Error(
    'Unsupported key. Use Escape, Enter, Tab, Backspace, arrow keys, or a single character.'
  );
}

/** Build the fixed keyDown/keyUp press pair accepted by CDP
Input.dispatchKeyEvent. */
export function createCdpKeyPressEventPair(
  params: Record<string, unknown>
): Array<Record<string, unknown>> {
  const rawKey = params.key;
  if (typeof rawKey !== 'string' || rawKey.trim() === '') {
    throw new Error('key must be a non-empty string.');
  }
  const keyDefinition = inferCdpKeyDefinition(rawKey);
  const code =
    typeof params.code === 'string' && params.code.trim() ? params.code : keyDefinition.code;
  const modifiers = normalizeCdpModifiers(params.modifiers);
  const base = {
    key: keyDefinition.key,
    code,
    windowsVirtualKeyCode: keyDefinition.windowsVirtualKeyCode,
    nativeVirtualKeyCode: keyDefinition.windowsVirtualKeyCode,
    modifiers,
  };
  const keyDown = {
    type: 'keyDown',
    ...base,
    ...(keyDefinition.text ? { text: keyDefinition.text, unmodifiedText: keyDefinition.text } : {}),
  };
  return [keyDown, { type: 'keyUp', ...base }];
}

export function shouldLogAction(method: string): boolean {
  return ![
    'log.tail',
    'skill.get_runtime_context',
    'setup.get_status',
    'setup.install',
    'tabs.list',
  ].includes(method);
}

/** Treat page exceptions as part of the error stream so filtered reads return
runtime failures alongside explicit `console.error` calls. */
export function matchesConsoleLevel(requestedLevel: string, entryLevel: string): boolean {
  if (requestedLevel === 'all') return true;
  if (requestedLevel === 'exception' || requestedLevel === 'rejection') {
    return entryLevel === requestedLevel;
  }

  const severity: Record<string, number> = {
    debug: 10,
    log: 20,
    info: 20,
    warn: 30,
    error: 40,
    exception: 40,
    rejection: 40,
  };
  const requestedSeverity = severity[requestedLevel];
  const entrySeverity = severity[entryLevel];
  return requestedSeverity !== undefined && entrySeverity !== undefined
    ? entrySeverity >= requestedSeverity
    : false;
}

export function summarizeActionResult(response: BridgeResponse): string {
  if (!response.ok) {
    return response.error.message;
  }

  const result =
    response.result && typeof response.result === 'object'
      ? (response.result as Record<string, unknown>)
      : {};

  if (typeof result.patchId === 'string') {
    return `Patch ${result.patchId} applied.`;
  }

  if (Array.isArray(result.nodes)) {
    return `${result.nodes.length} node(s) returned.`;
  }

  if (typeof result.image === 'string') {
    return 'Partial screenshot captured.';
  }

  return 'Completed successfully.';
}

/** Estimate approximate token cost from a bridge response. */
export function estimateResponseTokens(
  response: BridgeResponse,
  serializedPayload?: string
): {
  responseBytes: number;
  approxTokens: number;
  textBytes: number;
  textApproxTokens: number;
  imageApproxTokens: number;
  imageBytes: number;
  hasScreenshot: boolean;
  nodeCount: number | null;
} {
  const payload = response.ok ? response.result : { error: response.error };
  const payloadJson =
    typeof serializedPayload === 'string' ? serializedPayload : serializeJsonPayload(payload);
  const estimate = estimateJsonPayloadCost(payload, payloadJson);
  const responseBytes = estimate.bytes;
  const result =
    response.ok && response.result && typeof response.result === 'object'
      ? (response.result as Record<string, unknown>)
      : null;
  const hasInlineScreenshot = result != null && typeof result.image === 'string';
  const hasArtifactScreenshot =
    result?.delivery === 'artifact' &&
    result.artifact != null &&
    typeof result.artifact === 'object';
  const hasScreenshot = hasInlineScreenshot || hasArtifactScreenshot;
  const nodeCount = result != null && Array.isArray(result.nodes) ? result.nodes.length : null;
  const textPayload = hasInlineScreenshot && result != null ? omitScreenshotImage(result) : payload;
  const textEstimate = estimateJsonPayloadCost(
    textPayload,
    textPayload === payload ? payloadJson : serializeJsonPayload(textPayload)
  );
  const imageTransportBytes = Math.max(0, responseBytes - textEstimate.bytes);
  const imageBytes =
    hasInlineScreenshot && result != null
      ? estimateInlineImageBytes(result.image)
      : hasArtifactScreenshot && typeof result?.byteLength === 'number'
        ? result.byteLength
        : 0;

  return {
    responseBytes,
    approxTokens: estimate.approxTokens,
    textBytes: textEstimate.bytes,
    textApproxTokens: textEstimate.approxTokens,
    imageApproxTokens: imageTransportBytes === 0 ? 0 : Math.ceil(imageTransportBytes / 4),
    imageBytes,
    hasScreenshot,
    nodeCount,
  };
}

export function getResponseDiagnostics(
  method: string,
  response: BridgeResponse,
  serializedPayload?: string
): {
  responseBytes: number;
  approxTokens: number;
  textBytes: number;
  textApproxTokens: number;
  imageApproxTokens: number;
  imageBytes: number;
  hasScreenshot: boolean;
  nodeCount: number | null;
  costClass: 'cheap' | 'moderate' | 'heavy' | 'extreme';
  textCostClass: 'cheap' | 'moderate' | 'heavy' | 'extreme';
  debuggerBacked: boolean;
} {
  const estimate = estimateResponseTokens(response, serializedPayload);
  return {
    ...estimate,
    costClass: getCostClass(estimate.approxTokens),
    textCostClass: getCostClass(estimate.textApproxTokens),
    debuggerBacked:
      typeof response.meta?.debugger_backed === 'boolean'
        ? response.meta.debugger_backed
        : isDebuggerBackedMethod(method),
  };
}

/** Keep screenshot metadata while excluding the large inline image payload from
token-oriented UI estimates. */
function omitScreenshotImage(result: Record<string, unknown>): Record<string, unknown> {
  const textPayload = { ...result };
  delete textPayload.image;
  return textPayload;
}

/** Estimate decoded image bytes for data URLs so the UI can show image size
without pretending the base64 blob is text-token traffic. */
function estimateInlineImageBytes(image: unknown): number {
  if (typeof image !== 'string' || image.length === 0) {
    return 0;
  }

  const match = /^data:[^;]+;base64,([A-Za-z0-9+/=\s]+)$/u.exec(image);
  if (!match) {
    return getUtf8ByteLength(image);
  }

  const base64 = match[1].replace(/\s+/gu, '');
  if (base64.length === 0) {
    return 0;
  }

  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/** Deterministically trim oversized success payloads to fit within an
approximate token budget. This prefers shrinking large strings and slicing
top-level result arrays before falling back to a compact continuation payload. */
export function enforceTokenBudget(
  method: string,
  response: BridgeResponse,
  tokenBudget: number | null | undefined
): BridgeResponse {
  // Schemas and tool results are atomic JSON. Never shorten them or advise
  // repeating an execution that may already have committed a side effect.
  if (method.startsWith('webmcp.')) {
    if (
      !response.ok ||
      typeof tokenBudget !== 'number' ||
      tokenBudget <= 0 ||
      !Number.isFinite(tokenBudget)
    )
      return response;
    if (estimateJsonPayloadCost(response.result).bytes <= tokenBudget * 4) return response;
    return createFailure(
      response.id,
      ERROR_CODES.RESULT_TOO_LARGE,
      'Complete WebMCP response exceeds the token budget.',
      {
        method,
        dispatched: method === 'webmcp.execute_tool',
        outcome: method === 'webmcp.execute_tool' ? 'inspect_postconditions' : 'not_dispatched',
      },
      {
        ...response.meta,
        method,
        continuation_hint:
          method === 'webmcp.execute_tool'
            ? 'Inspect postconditions; do not replay the tool.'
            : 'Use a larger budget or narrower discovery.',
      }
    );
  }
  if (
    method.startsWith('screenshot.baseline.') ||
    method === 'dom.baseline.create' ||
    method === 'dom.baseline.describe' ||
    method === 'dom.baseline.release' ||
    method === 'network.export_har'
  ) {
    return response;
  }
  if (
    !response.ok ||
    typeof tokenBudget !== 'number' ||
    !Number.isFinite(tokenBudget) ||
    tokenBudget <= 0
  ) {
    return response;
  }

  const maxBytes = Math.max(128, Math.floor(tokenBudget * 4));
  const responseBytes = estimateJsonPayloadCost(response.result).bytes;
  if (responseBytes <= maxBytes) {
    return {
      ...response,
      meta: {
        ...response.meta,
        budget_applied: false,
        budget_truncated: false,
        continuation_hint: null,
      },
    };
  }

  if (method === 'input.perform') {
    // Progress, failures, timing, and verified outcomes describe completed
    // mutations. Never slice them or tell a caller to repeat the sequence.
    // Only the optional final-step evidence may be omitted, atomically.
    const result = response.result;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const sequence = result as Record<string, unknown>;
      const last = sequence.lastResult;
      if (last && typeof last === 'object' && !Array.isArray(last) && 'result' in last) {
        const evidence = last as Record<string, unknown>;
        const omitted = {
          index: evidence.index,
          method: evidence.method,
          byteLength: evidence.byteLength,
          truncated: true,
          maxBytes: 0,
        };
        const compact = { ...sequence, lastResult: omitted };
        omitted.maxBytes = Math.max(0, maxBytes - estimateJsonPayloadCost(compact).bytes);
        return {
          ...response,
          result: compact,
          meta: {
            ...response.meta,
            budget_applied: true,
            budget_truncated: true,
            continuation_hint:
              'Final-step evidence was omitted to preserve sequence progress. Inspect current state with a separate bounded read; do not replay input.perform.',
          },
        };
      }
    }
    // Protocol limits already bound the control envelope. Exceed a smaller
    // caller budget rather than discard evidence of actions that already ran.
    return response;
  }

  const cloned = cloneJsonValue(response.result);
  let truncated = false;
  let iterations = 0;
  const MAX_BUDGET_ITERATIONS = 100;
  while (
    estimateJsonPayloadCost(cloned).bytes > maxBytes &&
    shrinkForBudget(cloned) &&
    iterations < MAX_BUDGET_ITERATIONS
  ) {
    truncated = true;
    iterations += 1;
  }

  let result = cloned;
  const continuationHint = `Retry ${method} with a larger token budget or tighter params.`;
  if (estimateJsonPayloadCost(result).bytes > maxBytes) {
    const compactFallback =
      method === 'dom.baseline.compare' && result && typeof result === 'object'
        ? createCompactBaselineDiff(result as Record<string, unknown>, continuationHint)
        : {
            truncated: true,
            continuationHint,
          };
    if (estimateJsonPayloadCost(compactFallback).bytes > maxBytes) {
      return createFailure(
        response.id,
        ERROR_CODES.RESULT_TRUNCATED,
        'Result was truncated to fit the response budget.',
        {
          method,
          tokenBudget,
        },
        {
          ...response.meta,
          budget_applied: true,
          budget_truncated: true,
          continuation_hint: continuationHint,
        }
      );
    }
    result = compactFallback;
    truncated = true;
  }

  return {
    ...response,
    result,
    meta: {
      ...response.meta,
      budget_applied: true,
      budget_truncated: truncated,
      continuation_hint: truncated ? continuationHint : null,
    },
  };
}

export function cloneJsonValue(value: unknown): unknown {
  return value == null ? value : structuredClone(value);
}

function shrinkForBudget(input: unknown): boolean {
  if (!input || typeof input !== 'object') {
    return false;
  }

  if (Array.isArray(input)) {
    if (input.length > 1) {
      const nextLength = Math.max(1, Math.floor(input.length * 0.75));
      input.splice(nextLength);
      return true;
    }
    return input.length === 1 ? shrinkForBudget(input[0]) : false;
  }

  const value = input as Record<string, unknown>;
  if (value.counts && typeof value.counts === 'object') {
    const counts = value.counts as Record<string, unknown>;
    const categories = ['added', 'removed', 'changed', 'moved'];
    const candidates = categories
      .map((key) => ({ key, items: Array.isArray(value[key]) ? value[key] : [] }))
      .filter((entry) => entry.items.length > 0)
      .sort((left, right) => right.items.length - left.items.length);
    const candidate = candidates[0];
    if (candidate) {
      candidate.items.pop();
      const returnedCounts = (value.returnedCounts ?? {}) as Record<string, number>;
      for (const key of categories) {
        returnedCounts[key] = Array.isArray(value[key]) ? value[key].length : 0;
      }
      returnedCounts.total = categories.reduce((total, key) => total + returnedCounts[key], 0);
      value.returnedCounts = returnedCounts;
      const exactTotal = categories.reduce((total, key) => total + (Number(counts[key]) || 0), 0);
      const omittedChanges = Math.max(0, exactTotal - returnedCounts.total);
      value.omittedChanges = omittedChanges;
      value.truncated = omittedChanges > 0;
      value.guidance = 'Narrow the selector or increase maxChanges or the token budget.';
      return true;
    }
    return false;
  }

  for (const key of ['image', 'html', 'text', 'value']) {
    if (typeof value[key] === 'string' && value[key].length > 64) {
      value[key] =
        key === 'image'
          ? '[omitted image over token budget]'
          : `${value[key].slice(0, Math.max(32, Math.floor(value[key].length * 0.75) - 1))}\u2026`;
      if (typeof value.truncated !== 'boolean') {
        value.truncated = true;
      }
      return true;
    }
  }

  for (const key of ['nodes', 'entries', 'tabs', 'patches']) {
    if (Array.isArray(value[key]) && value[key].length > 1) {
      const originalLength = value[key].length;
      const nextLength = Math.max(1, Math.floor(originalLength * 0.75));
      value[key].splice(nextLength);
      if (typeof value.count !== 'number') {
        value.count = originalLength;
      }
      if (typeof value.total !== 'number') {
        value.total = originalLength;
      }
      value.truncated = true;
      return true;
    }
  }

  for (const entry of Object.values(value)) {
    if (shrinkForBudget(entry)) {
      if (typeof value.truncated !== 'boolean') {
        value.truncated = true;
      }
      return true;
    }
  }

  const keys = Object.keys(value);
  if (keys.length > 2) {
    delete value[keys[keys.length - 1]];
    value.truncated = true;
    return true;
  }

  return false;
}

function createCompactBaselineDiff(result: Record<string, unknown>, continuationHint: string) {
  const counts =
    result.counts && typeof result.counts === 'object'
      ? (result.counts as Record<string, unknown>)
      : {};
  const ambiguity =
    result.ambiguity && typeof result.ambiguity === 'object'
      ? (result.ambiguity as Record<string, unknown>)
      : {};
  return {
    baselineId: result.baselineId,
    equal: result.equal === true,
    comparedAt: result.comparedAt,
    counts,
    returnedCounts: { added: 0, removed: 0, changed: 0, moved: 0, total: 0 },
    added: [],
    removed: [],
    changed: [],
    moved: [],
    truncated: true,
    omittedChanges: ['added', 'removed', 'changed', 'moved'].reduce(
      (total, key) => total + (Number(counts[key]) || 0),
      0
    ),
    ambiguity: {
      count: Number(ambiguity.count) || 0,
      examples: [],
    },
    guidance: continuationHint,
  };
}

export function getErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unexpected extension error.';
}

export function normalizeRuntimeErrorMessage(message: string): string {
  const normalizedMessage = message.replace(/^Error:\s*/i, '');
  return /^No tab with id[: ]/i.test(normalizedMessage)
    ? ERROR_CODES.TAB_MISMATCH
    : normalizedMessage;
}

export function normalizeCropRect(
  rect: { x?: number; y?: number; width?: number; height?: number; scale?: number } = {}
): { x: number; y: number; width: number; height: number } {
  const scale = Number(rect.scale) || 1;
  return {
    x: Math.max(0, Math.round((rect.x || 0) * scale)),
    y: Math.max(0, Math.round((rect.y || 0) * scale)),
    width: Math.max(1, Math.round((rect.width || 1) * scale)),
    height: Math.max(1, Math.round((rect.height || 1) * scale)),
  };
}

export function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export function inferCapability(method: string): Capability | null {
  return getMethodCapability(method as import('../../../protocol/src/types.js').BridgeMethod);
}
