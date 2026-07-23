// @ts-check

import { BridgeError, createSuccess, ERROR_CODES } from '../../protocol/src/index.js';

/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('./background-state.js').ResolvedTabTarget} ResolvedTabTarget */
/** @typedef {{ documentToken: string, representation: string, selector: string | null, nodes: Array<Record<string, unknown> & { nodeId: string | number }>, stats?: { nodeCount?: number, byteLength?: number, digest?: string } }} DomBaselineSnapshot */
/** @typedef {{ baselineId: string, scope: { windowId: number, tabId: number, frameId: number, selector: string | null, documentToken: string, representation: string }, options: Record<string, unknown> }} DomBaselineDescriptor */
/** @typedef {{ create: (input: { windowId: number, tabId: number, frameId: number, selector: string | null, options: Record<string, unknown>, snapshot: DomBaselineSnapshot }) => unknown, get: (baselineId: string) => DomBaselineDescriptor, compare: (baselineId: string, snapshot: DomBaselineSnapshot, maxChanges?: number) => unknown, release: (baselineId: string) => { baselineId: string, released: boolean }, invalidate: (baselineId: string, reason?: string) => unknown, getScopeGeneration: (tabId: number) => string }} DomBaselineController */

const BASELINE_METHODS = new Set([
  'dom.baseline.create',
  'dom.baseline.compare',
  'dom.baseline.describe',
  'dom.baseline.release',
]);

/**
 * @param {DomBaselineController} controller
 * @param {{
 *   resolveRequestTarget: (request: BridgeRequest) => Promise<ResolvedTabTarget>,
 *   ensureContentScript: (tabId: number) => Promise<void>,
 *   sendTabMessage: (tabId: number, message: Record<string, unknown>, timeoutMs: number) => Promise<unknown>,
 *   contentScriptTimeoutMs: number,
 * }} deps
 */
export function createDomBaselineRequestHandler(controller, deps) {
  /** @param {string} method */
  function handles(method) {
    return BASELINE_METHODS.has(method);
  }

  /** @param {BridgeRequest} request */
  async function handle(request) {
    const params = request.params ?? {};
    if (request.method === 'dom.baseline.create') {
      const target = await deps.resolveRequestTarget(request);
      const scopeGeneration = controller.getScopeGeneration(target.tabId);
      const options = readCreateOptions(params);
      const snapshot = await captureSnapshot(target.tabId, options);
      const currentTarget = await deps.resolveRequestTarget(request);
      if (
        currentTarget.tabId !== target.tabId ||
        currentTarget.windowId !== target.windowId ||
        controller.getScopeGeneration(target.tabId) !== scopeGeneration
      ) {
        throw new BridgeError(
          ERROR_CODES.DOM_BASELINE_INVALIDATED,
          'The page or access scope changed while the DOM baseline was being created.',
          { reason: 'scope_changed_during_capture' }
        );
      }
      const { selector, ...storedOptions } = options;
      return createSuccess(
        request.id,
        controller.create({
          windowId: target.windowId,
          tabId: target.tabId,
          frameId: 0,
          selector,
          options: storedOptions,
          snapshot,
        }),
        { method: request.method }
      );
    }

    const baselineId = String(params.baselineId ?? '');
    if (request.method === 'dom.baseline.release') {
      try {
        const descriptor = controller.get(baselineId);
        await resolveStoredTarget(request, descriptor.scope.tabId);
      } catch (error) {
        if (isBaselineUnavailable(error)) {
          controller.release(baselineId);
          return createSuccess(
            request.id,
            { baselineId, released: false },
            { method: request.method }
          );
        }
        throw error;
      }
      return createSuccess(request.id, controller.release(baselineId), {
        method: request.method,
      });
    }

    const descriptor = controller.get(baselineId);
    await resolveStoredTarget(request, descriptor.scope.tabId);
    if (request.method === 'dom.baseline.describe') {
      return createSuccess(request.id, descriptor, { method: request.method });
    }

    const options = readCreateOptions({
      ...descriptor.options,
      selector: descriptor.scope.selector,
    });
    const snapshot = await captureSnapshot(descriptor.scope.tabId, {
      ...options,
      expectedDocumentToken: descriptor.scope.documentToken,
      allowMissingRoot: true,
    });
    const result = controller.compare(baselineId, snapshot, Number(params.maxChanges));
    return createSuccess(request.id, result, { method: request.method });
  }

  /** @param {BridgeRequest} request @param {number} tabId */
  async function resolveStoredTarget(request, tabId) {
    if (request.tab_id !== null && request.tab_id !== tabId) {
      throw new BridgeError(ERROR_CODES.TAB_MISMATCH, 'DOM baseline belongs to a different tab.', {
        requestedTabId: request.tab_id,
        baselineTabId: tabId,
      });
    }
    return deps.resolveRequestTarget({ ...request, tab_id: tabId });
  }

  /** @param {number} tabId @param {Record<string, unknown>} params */
  async function captureSnapshot(tabId, params) {
    await deps.ensureContentScript(tabId);
    const response = await deps.sendTabMessage(
      tabId,
      { type: 'bridge.execute', method: 'dom.baseline.snapshot', params },
      deps.contentScriptTimeoutMs
    );
    if (response && typeof response === 'object' && 'error' in response) {
      const failure =
        response.error && typeof response.error === 'object'
          ? /** @type {Record<string, unknown>} */ (response.error)
          : {};
      throw new BridgeError(
        typeof failure.code === 'string'
          ? /** @type {import('../../protocol/src/types.js').ErrorCode} */ (failure.code)
          : ERROR_CODES.INTERNAL_ERROR,
        typeof failure.message === 'string' ? failure.message : 'Semantic DOM capture failed.',
        failure.details ?? null
      );
    }
    return /** @type {DomBaselineSnapshot} */ (response);
  }

  return Object.freeze({ handles, handle });
}

/** @param {Record<string, unknown>} value */
function readCreateOptions(value) {
  return {
    selector: typeof value.selector === 'string' ? value.selector : 'body',
    maxNodes: Number(value.maxNodes),
    maxDepth: Number(value.maxDepth),
    textBudget: Number(value.textBudget),
    attributeAllowlist: Array.isArray(value.attributeAllowlist)
      ? value.attributeAllowlist.filter((item) => typeof item === 'string')
      : [],
    ...(typeof value.expectedDocumentToken === 'string'
      ? { expectedDocumentToken: value.expectedDocumentToken }
      : {}),
    ...(value.allowMissingRoot === true ? { allowMissingRoot: true } : {}),
  };
}

/** @param {unknown} error */
function isBaselineNotFound(error) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === ERROR_CODES.DOM_BASELINE_NOT_FOUND
  );
}

/** @param {unknown} error */
function isBaselineUnavailable(error) {
  return isBaselineNotFound(error) || isBaselineInvalidated(error);
}

/** @param {unknown} error */
function isBaselineInvalidated(error) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === ERROR_CODES.DOM_BASELINE_INVALIDATED
  );
}
