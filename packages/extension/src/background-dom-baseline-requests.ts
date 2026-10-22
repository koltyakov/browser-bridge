import { BridgeError, createSuccess, ERROR_CODES } from '../../../protocol/src/index.js';

export type BridgeRequest = import('../../../protocol/src/types.js').BridgeRequest;
export type ResolvedTabTarget = import('./background-state.js').ResolvedTabTarget;
export type DomBaselineSnapshot = {
  documentToken: string;
  representation: string;
  selector: string | null;
  nodes: Array<Record<string, unknown> & { nodeId: string | number }>;
  stats?: { nodeCount?: number; byteLength?: number; digest?: string };
};
export type DomBaselineDescriptor = {
  baselineId: string;
  scope: {
    windowId: number;
    tabId: number;
    frameId: number;
    selector: string | null;
    documentToken: string;
    representation: string;
  };
  options: Record<string, unknown>;
};
export type DomBaselineController = {
  create: (input: {
    windowId: number;
    tabId: number;
    frameId: number;
    selector: string | null;
    options: Record<string, unknown>;
    snapshot: DomBaselineSnapshot;
  }) => unknown;
  get: (baselineId: string) => DomBaselineDescriptor;
  compare: (baselineId: string, snapshot: DomBaselineSnapshot, maxChanges?: number) => unknown;
  release: (baselineId: string) => { baselineId: string; released: boolean };
  invalidate: (baselineId: string, reason?: string) => unknown;
  getScopeGeneration: (tabId: number) => string;
};

const BASELINE_METHODS = new Set([
  'dom.baseline.create',
  'dom.baseline.compare',
  'dom.baseline.describe',
  'dom.baseline.release',
]);

export function createDomBaselineRequestHandler(
  controller: DomBaselineController,
  deps: {
    resolveRequestTarget: (request: BridgeRequest) => Promise<ResolvedTabTarget>;
    ensureContentScript: (tabId: number) => Promise<void>;
    sendTabMessage: (
      tabId: number,
      message: Record<string, unknown>,
      timeoutMs: number
    ) => Promise<unknown>;
    contentScriptTimeoutMs: number;
  }
) {
  function handles(method: string) {
    return BASELINE_METHODS.has(method);
  }

  async function handle(request: BridgeRequest) {
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

  async function resolveStoredTarget(request: BridgeRequest, tabId: number) {
    if (request.tab_id !== null && request.tab_id !== tabId) {
      throw new BridgeError(ERROR_CODES.TAB_MISMATCH, 'DOM baseline belongs to a different tab.', {
        requestedTabId: request.tab_id,
        baselineTabId: tabId,
      });
    }
    return deps.resolveRequestTarget({ ...request, tab_id: tabId });
  }

  async function captureSnapshot(tabId: number, params: Record<string, unknown>) {
    await deps.ensureContentScript(tabId);
    const response = await deps.sendTabMessage(
      tabId,
      { type: 'bridge.execute', method: 'dom.baseline.snapshot', params },
      deps.contentScriptTimeoutMs
    );
    if (response && typeof response === 'object' && 'error' in response) {
      const failure =
        response.error && typeof response.error === 'object'
          ? (response.error as Record<string, unknown>)
          : {};
      throw new BridgeError(
        typeof failure.code === 'string'
          ? (failure.code as import('../../../protocol/src/types.js').ErrorCode)
          : ERROR_CODES.INTERNAL_ERROR,
        typeof failure.message === 'string' ? failure.message : 'Semantic DOM capture failed.',
        failure.details ?? null
      );
    }
    return response as DomBaselineSnapshot;
  }

  return Object.freeze({ handles, handle });
}

function readCreateOptions(value: Record<string, unknown>) {
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

function isBaselineNotFound(error: unknown) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === ERROR_CODES.DOM_BASELINE_NOT_FOUND
  );
}

function isBaselineUnavailable(error: unknown) {
  return isBaselineNotFound(error) || isBaselineInvalidated(error);
}

function isBaselineInvalidated(error: unknown) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === ERROR_CODES.DOM_BASELINE_INVALIDATED
  );
}
