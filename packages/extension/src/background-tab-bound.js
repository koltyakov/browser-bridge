// @ts-check

import {
  createSuccess,
  normalizeCheckedAction,
  normalizeDomQuery,
  normalizeDragParams,
  normalizeFindByRoleParams,
  normalizeFindByTextParams,
  normalizeGetHtmlParams,
  normalizeHoverParams,
  normalizeInputAction,
  normalizePageTextParams,
  normalizePatchOperation,
  normalizeSelectAction,
  normalizeStorageParams,
  normalizeSensitiveReadParams,
  normalizeStyleQuery,
  normalizeViewportAction,
  normalizeWaitForParams,
} from '../../protocol/src/index.js';

/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */

/**
 * @typedef {{
 *   tabId: number,
 *   windowId: number,
 *   title: string,
 *   url: string,
 * }} ResolvedTabTarget
 */

/**
 * @typedef {{
 *   resolveRequestTarget: (request: BridgeRequest, options?: { requireScriptable?: boolean }) => Promise<ResolvedTabTarget>,
 *   ensureContentScript: (tabId: number) => Promise<void>,
 *   handleScreenshot: (
 *     target: ResolvedTabTarget,
 *     method: string,
 *     params: Record<string, unknown> | undefined,
 *     requestId: string
 *   ) => Promise<unknown>,
 *   handleNativeInput: (
 *     request: BridgeRequest,
 *     target: ResolvedTabTarget,
 *     params: Record<string, unknown>
 *   ) => Promise<Record<string, unknown>>,
 *   sendTabMessage: (
 *     tabId: number,
 *     payload: Record<string, unknown>,
 *     timeoutMs?: number
 *   ) => Promise<any>,
 *   toFailureResponse: (request: BridgeRequest, error: unknown) => BridgeResponse,
 *   recordStaleRecovery?: (outcome: 'success' | 'failure', group: string) => void,
 *   contentScriptTimeoutMs: number,
 * }} TabBoundRequestDependencies
 */

/**
 * Normalizers for tab-bound request params. Each entry maps a bridge method to
 * a function that coerces and defaults the raw request params.
 *
 * @type {Record<string, ((params: Record<string, unknown>) => Record<string, unknown>) | undefined>}
 */
const TAB_BOUND_NORMALIZERS = {
  'dom.query': normalizeDomQuery,
  'dom.wait_for': normalizeWaitForParams,
  'dom.find_by_text': normalizeFindByTextParams,
  'dom.find_by_role': normalizeFindByRoleParams,
  'dom.get_html': normalizeGetHtmlParams,
  'styles.get_computed': normalizeStyleQuery,
  'styles.get_matched_rules': normalizeStyleQuery,
  'viewport.scroll': normalizeViewportAction,
  'input.click': normalizeInputAction,
  'input.focus': normalizeInputAction,
  'input.type': normalizeInputAction,
  'input.fill': normalizeInputAction,
  'input.press_key': normalizeInputAction,
  'input.set_checked': normalizeCheckedAction,
  'input.select_option': normalizeSelectAction,
  'input.hover': normalizeHoverParams,
  'input.drag': normalizeDragParams,
  'patch.apply_styles': normalizePatchOperation,
  'patch.apply_dom': normalizePatchOperation,
  'patch.list': normalizePatchOperation,
  'patch.rollback': normalizePatchOperation,
  'patch.commit_session_baseline': normalizePatchOperation,
  'page.get_storage': normalizeStorageParams,
  'sensitive.read': normalizeSensitiveReadParams,
  'page.get_text': normalizePageTextParams,
};

const TAB_BOUND_METHODS = new Set([
  'page.get_state',
  'page.get_storage',
  'sensitive.read',
  'page.get_text',
  'dom.query',
  'dom.describe',
  'dom.get_text',
  'dom.get_attributes',
  'dom.wait_for',
  'dom.find_by_text',
  'dom.find_by_role',
  'dom.get_html',
  'layout.get_box_model',
  'layout.hit_test',
  'styles.get_computed',
  'styles.get_matched_rules',
  'viewport.scroll',
  'input.click',
  'input.focus',
  'input.type',
  'input.fill',
  'input.press_key',
  'input.set_checked',
  'input.select_option',
  'input.hover',
  'input.drag',
  'input.scroll_into_view',
  'patch.apply_styles',
  'patch.apply_dom',
  'patch.list',
  'patch.rollback',
  'patch.commit_session_baseline',
  'screenshot.capture_region',
  'screenshot.capture_element',
  'screenshot.capture_full_page',
]);

/**
 * @param {string} method
 * @returns {boolean}
 */
export function isTabBoundMethod(method) {
  return TAB_BOUND_METHODS.has(method);
}

/**
 * Compute a per-method content script timeout that accommodates long-running
 * operations such as dom.wait_for or hover-with-duration.
 *
 * @param {string} method
 * @param {Record<string, unknown> | undefined} params
 * @param {number} contentScriptTimeoutMs
 * @returns {number}
 */
export function getContentScriptTimeout(method, params, contentScriptTimeoutMs = 5_000) {
  if (method === 'dom.wait_for') {
    return Math.min(Math.max(Number(params?.timeoutMs) || 5_000, 100), 30_000) + 2_000;
  }
  const hoverDuration = Number(params?.duration);
  if (method === 'input.hover' && hoverDuration > 0) {
    return contentScriptTimeoutMs + Math.min(hoverDuration, 5_000) + 1_000;
  }
  return contentScriptTimeoutMs;
}

/**
 * Dispatch a tab-bound request to the content script after enforcing the
 * session scope and capability requirements.
 *
 * @param {BridgeRequest} request
 * @param {TabBoundRequestDependencies} dependencies
 * @returns {Promise<BridgeResponse>}
 */
export async function handleTabBoundRequest(request, dependencies) {
  const target = await dependencies.resolveRequestTarget(request);
  await dependencies.ensureContentScript(target.tabId);
  const normalizer = TAB_BOUND_NORMALIZERS[request.method];
  const payload = normalizer ? normalizer(request.params) : request.params;

  if (request.method.startsWith('screenshot.')) {
    const result = await dependencies.handleScreenshot(
      target,
      request.method,
      request.params,
      request.id
    );
    return createSuccess(request.id, result, { method: request.method });
  }

  if (payload.executionMode === 'cdp' && request.method.startsWith('input.')) {
    try {
      const result = await dependencies.handleNativeInput(request, target, payload);
      const staleOutcome = getStaleRecoveryOutcome(result);
      if (staleOutcome) dependencies.recordStaleRecovery?.(staleOutcome, request.method);
      return createSuccess(request.id, result, {
        method: request.method,
        debugger_backed: true,
        ...(staleOutcome ? { stale_recovery: staleOutcome } : {}),
      });
    } catch (error) {
      const staleOutcome = getStaleRecoveryOutcome(error);
      if (staleOutcome) dependencies.recordStaleRecovery?.(staleOutcome, request.method);
      throw error;
    }
  }

  const timeoutMs = getContentScriptTimeout(
    request.method,
    payload,
    dependencies.contentScriptTimeoutMs
  );
  const response = await dependencies.sendTabMessage(
    target.tabId,
    {
      type: 'bridge.execute',
      method: request.method,
      params: payload,
    },
    timeoutMs
  );
  if (response?.error) {
    const staleOutcome = getStaleRecoveryOutcome(response.error);
    if (staleOutcome) dependencies.recordStaleRecovery?.(staleOutcome, request.method);
    const failure = dependencies.toFailureResponse(request, response.error);
    return staleOutcome
      ? { ...failure, meta: { ...failure.meta, stale_recovery: staleOutcome } }
      : failure;
  }
  const staleOutcome = getStaleRecoveryOutcome(response);
  if (staleOutcome) dependencies.recordStaleRecovery?.(staleOutcome, request.method);
  return createSuccess(request.id, response, {
    method: request.method,
    ...(staleOutcome ? { stale_recovery: staleOutcome } : {}),
  });
}

/** @param {unknown} value @returns {'success' | 'failure' | null} */
export function getStaleRecoveryOutcome(value) {
  if (!value || typeof value !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (record.recoveryAttempted === true) return 'failure';
  if (record.recovered === true && record.strategy === 'stale-recovery') return 'success';
  for (const key of ['details', 'resolution', 'source', 'destination']) {
    const outcome = getStaleRecoveryOutcome(record[key]);
    if (outcome) return outcome;
  }
  return null;
}
