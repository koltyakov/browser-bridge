// @ts-check

import { BRIDGE_METHODS, BRIDGE_METHOD_REGISTRY } from './registry.js';

/**
 * Shared Browser Bridge defaults used by the protocol, MCP layer, and runtime
 * guidance. Keep this as the source of truth for default limits and presets.
 */

export const DEFAULT_MAX_NODES = 25;
export const DEFAULT_MAX_DEPTH = 4;
export const DEFAULT_TEXT_BUDGET = 600;
export const DEFAULT_PAGE_TEXT_BUDGET = 8000;
export const DEFAULT_EXTRACT_SETTLE_TIMEOUT_MS = 2000;
export const MAX_EXTRACT_SETTLE_TIMEOUT_MS = 10_000;
export const EXTRACT_SETTLE_QUIET_MS = 100;
export const DEFAULT_WAIT_TIMEOUT_MS = 5000;
export const DEFAULT_EVAL_TIMEOUT_MS = 5000;
export const DEFAULT_NAV_TIMEOUT_MS = 15000;
export const DEFAULT_MAX_HTML_LENGTH = 2000;
export const DEFAULT_A11Y_MAX_NODES = 500;
export const DEFAULT_A11Y_MAX_DEPTH = 6;
export const DEFAULT_NETWORK_LIMIT = 50;
export const DEFAULT_CONSOLE_LIMIT = 50;
export const DEFAULT_VIEWPORT_WIDTH = 1280;
export const DEFAULT_VIEWPORT_HEIGHT = 720;
export const DEFAULT_DEVICE_SCALE_FACTOR = 0;
/** @type {'continue'} */
export const DEFAULT_NETWORK_INTERCEPT_ACTION = 'continue';

/** Maximum size of a Chrome native messaging message in bytes. */
export const MAX_NATIVE_MESSAGE_BYTES = 1_048_576;

/** Maximum size of one newline-delimited daemon socket message in bytes. */
export const MAX_JSON_LINE_BYTES = MAX_NATIVE_MESSAGE_BYTES;

/** Maximum UTF-8 size of an exact sensitive value returned atomically. */
export const MAX_SENSITIVE_VALUE_BYTES = 262_144;

/** Maximum calls accepted by any read-only batch surface. */
export const MAX_BATCH_CALLS = 20;

/** Maximum read-only batch calls executing concurrently. */
export const MAX_BATCH_CONCURRENCY = 5;
export const SCREENSHOT_AUTO_INLINE_BYTES = 262_144;
export const SCREENSHOT_MAX_INLINE_BYTES = 524_288;
export const ARTIFACT_CHUNK_BYTES = 196_608;
export const MAX_ARTIFACT_BYTES = 33_554_432;
export const MAX_ARTIFACT_CLIENT_BYTES = 67_108_864;
export const MAX_ARTIFACT_TOTAL_BYTES = 268_435_456;
export const MAX_ARTIFACTS_PER_CLIENT = 16;
export const ARTIFACT_TTL_MS = 300_000;

/** DOM baseline retention and storage limits. */
export const DOM_BASELINE_TTL_MS = 300_000;
export const MAX_DOM_BASELINES_PER_TAB = 8;
export const MAX_DOM_BASELINES_GLOBAL = 32;
export const MAX_DOM_BASELINE_BYTES_PER_TAB = 1_048_576;
export const MAX_DOM_BASELINE_BYTES_GLOBAL = 4_194_304;
export const MAX_DOM_BASELINE_BYTES = 262_144;

/** Default timeout for a bridge request awaiting an extension response (ms). */
export const DEFAULT_DAEMON_PENDING_TIMEOUT_MS = 30_000;

/** Transport allowance added after an operation's own normalized timeout. */
export const DAEMON_PENDING_TIMEOUT_MARGIN_MS = 2_000;

/** Upper bound for a daemon request awaiting an extension response. */
export const MAX_DAEMON_PENDING_TIMEOUT_MS = 122_000;

/** Default timeout for a BridgeClient request (ms). */
export const DEFAULT_CLIENT_REQUEST_TIMEOUT_MS = 8_000;

/** Transport allowance added after an operation timeout on the client side. */
export const CLIENT_REQUEST_TIMEOUT_MARGIN_MS = 4_000;

/** Upper bound for a client request, kept beyond the daemon's maximum deadline. */
export const MAX_CLIENT_REQUEST_TIMEOUT_MS = 124_000;

/** Maximum number of recent log entries retained by the daemon. */
export const DAEMON_RECENT_LOG_LIMIT = 200;

/** Maximum time to wait when probing an existing daemon socket during startup. */
export const DAEMON_EXISTING_SOCKET_PING_TIMEOUT_MS = 500;

/** Number of recent daemon log entries returned by `log.tail`. */
export const DEFAULT_LOG_TAIL_LIMIT = 20;

/** @typedef {'quick' | 'normal' | 'deep'} BudgetPresetName */

/** @type {Readonly<Record<BudgetPresetName, { maxNodes: number, maxDepth: number, textBudget: number, tokenBudget: number }>>} */
export const BUDGET_PRESETS = Object.freeze({
  quick: { maxNodes: 5, maxDepth: 2, textBudget: 300, tokenBudget: 500 },
  normal: {
    maxNodes: DEFAULT_MAX_NODES,
    maxDepth: DEFAULT_MAX_DEPTH,
    textBudget: DEFAULT_TEXT_BUDGET,
    tokenBudget: 1500,
  },
  deep: { maxNodes: 100, maxDepth: 8, textBudget: 2000, tokenBudget: 4000 },
});

/** @type {readonly import('./types.js').BridgeMethod[]} */
const LEGACY_DEBUGGER_BACKED_METHOD_ORDER = [
  'page.evaluate',
  'dom.get_accessibility_tree',
  'viewport.resize',
  'performance.get_metrics',
  'screenshot.capture_element',
  'screenshot.capture_region',
  'screenshot.capture_full_page',
  'network.intercept.add',
  'network.intercept.remove',
  'network.intercept.list',
  'network.intercept.clear',
  'cdp.get_document',
  'cdp.get_dom_snapshot',
  'cdp.get_box_model',
  'cdp.get_computed_styles_for_node',
  'cdp.dispatch_key_event',
];

const LEGACY_DEBUGGER_BACKED_METHODS = new Set(LEGACY_DEBUGGER_BACKED_METHOD_ORDER);

/** @type {ReadonlySet<string>} */
export const DEBUGGER_BACKED_METHODS = new Set([
  ...LEGACY_DEBUGGER_BACKED_METHOD_ORDER.filter(
    (method) => BRIDGE_METHOD_REGISTRY[method].debuggerBacked
  ),
  ...BRIDGE_METHODS.filter(
    (method) =>
      BRIDGE_METHOD_REGISTRY[method].debuggerBacked && !LEGACY_DEBUGGER_BACKED_METHODS.has(method)
  ),
]);

/**
 * @param {unknown} value
 * @returns {value is BudgetPresetName}
 */
export function isBudgetPresetName(value) {
  return value === 'quick' || value === 'normal' || value === 'deep';
}

/**
 * @param {BudgetPresetName | null | undefined} presetName
 * @returns {{ maxNodes: number, maxDepth: number, textBudget: number, tokenBudget: number }}
 */
export function getBudgetPreset(presetName) {
  if (presetName && isBudgetPresetName(presetName)) {
    return BUDGET_PRESETS[presetName];
  }
  return BUDGET_PRESETS.normal;
}

/**
 * @param {number} approxTokens
 * @returns {'cheap' | 'moderate' | 'heavy' | 'extreme'}
 */
export function getCostClass(approxTokens) {
  if (approxTokens <= 250) {
    return 'cheap';
  }
  if (approxTokens <= 1000) {
    return 'moderate';
  }
  if (approxTokens <= 3000) {
    return 'heavy';
  }
  return 'extreme';
}

/**
 * @param {string} method
 * @returns {boolean}
 */
export function isDebuggerBackedMethod(method) {
  return DEBUGGER_BACKED_METHODS.has(method);
}
