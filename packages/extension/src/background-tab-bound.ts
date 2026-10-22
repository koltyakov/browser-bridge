import {
  BridgeError,
  ERROR_CODES,
  createSuccess,
  normalizeDomQuery,
  normalizeFindByRoleParams,
  normalizeFindByTextParams,
  normalizeGetHtmlParams,
  normalizePageTextParams,
  normalizeRequestParams,
  normalizePatchOperation,
  normalizeStorageParams,
  normalizeSensitiveReadParams,
  normalizeStyleQuery,
  normalizeTouchParams,
  normalizeViewportAction,
  normalizeWaitForParams,
} from '../../../protocol/src/index.js';

export type BridgeRequest = import('../../../protocol/src/types.js').BridgeRequest;
export type BridgeResponse = import('../../../protocol/src/types.js').BridgeResponse;

export type ResolvedTabTarget = {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
};

export type TabBoundRequestDependencies = {
  resolveRequestTarget: (
    request: BridgeRequest,
    options?: { requireScriptable?: boolean }
  ) => Promise<ResolvedTabTarget>;
  ensureContentScript: (tabId: number) => Promise<void>;
  assertNoDialog?: (tabId: number) => void;
  runWithDialogGuard?: (
    tabId: number,
    operation: () => Promise<BridgeResponse>
  ) => Promise<BridgeResponse>;
  handleScreenshot: (
    target: ResolvedTabTarget,
    method: string,
    params: Record<string, unknown> | undefined,
    requestId: string
  ) => Promise<unknown>;
  handleNativeInput: (
    request: BridgeRequest,
    target: ResolvedTabTarget,
    params: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  sendTabMessage: (
    tabId: number,
    payload: Record<string, unknown>,
    timeoutMs?: number
  ) => Promise<unknown>;
  toFailureResponse: (request: BridgeRequest, error: unknown) => BridgeResponse;
  recordStaleRecovery?: (outcome: 'success' | 'failure', group: string) => void;
  frames?: {
    listFrames: (
      tabId: number,
      options?: { refresh?: boolean }
    ) => Promise<Array<{ frameId: number; tag: string | null }>>;
    getFrameForRef: (tabId: number, elementRef: string) => Promise<number>;
    sendFrameMessage: (
      tabId: number,
      frameId: number,
      message: Record<string, unknown>,
      timeoutMs: number
    ) => Promise<unknown>;
  };
  chooseInputExecutionMode?: (
    tabId: number,
    method: string,
    params: Record<string, unknown>
  ) => Promise<{ mode: 'dom' | 'cdp'; reason: string }>;
  contentScriptTimeoutMs: number;
};

/** Normalizers for tab-bound request params. Each entry maps a bridge method to
a function that coerces and defaults the raw request params. */
const TAB_BOUND_NORMALIZERS: Record<
  string,
  ((params: Record<string, unknown>) => Record<string, unknown>) | undefined
> = {
  'dom.query': normalizeDomQuery,
  'dom.wait_for': normalizeWaitForParams,
  'dom.find_by_text': normalizeFindByTextParams,
  'dom.find_by_role': normalizeFindByRoleParams,
  'dom.get_html': normalizeGetHtmlParams,
  'styles.get_computed': normalizeStyleQuery,
  'styles.get_matched_rules': normalizeStyleQuery,
  'viewport.scroll': normalizeViewportAction,
  'input.click': (params) => normalizeRequestParams('input.click', params),
  'input.focus': (params) => normalizeRequestParams('input.focus', params),
  'input.type': (params) => normalizeRequestParams('input.type', params),
  'input.fill': (params) => normalizeRequestParams('input.fill', params),
  'input.press_key': (params) => normalizeRequestParams('input.press_key', params),
  'input.set_checked': (params) => normalizeRequestParams('input.set_checked', params),
  'input.select_option': (params) => normalizeRequestParams('input.select_option', params),
  'input.hover': (params) => normalizeRequestParams('input.hover', params),
  'input.drag': (params) => normalizeRequestParams('input.drag', params),
  'input.touch': normalizeTouchParams,
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
  'input.touch',
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

export function isTabBoundMethod(method: string): boolean {
  return TAB_BOUND_METHODS.has(method);
}

/** Compute a per-method content script timeout that accommodates long-running
operations such as dom.wait_for or hover-with-duration. */
export function getContentScriptTimeout(
  method: string,
  params: Record<string, unknown> | undefined,
  contentScriptTimeoutMs: number = 5_000
): number {
  if (method === 'dom.wait_for') {
    return Math.min(Math.max(Number(params?.timeoutMs) || 5_000, 100), 30_000) + 2_000;
  }
  const hoverDuration = Number(params?.duration);
  if (method === 'input.hover' && hoverDuration > 0) {
    return contentScriptTimeoutMs + Math.min(hoverDuration, 5_000) + 1_000;
  }
  const holdMs = Number(params?.holdMs);
  const holdAllowance =
    (method === 'input.click' || method === 'input.press_key' || method === 'input.touch') &&
    holdMs > 0
      ? Math.min(holdMs, 10_000) + 1_000
      : 0;
  // Auto-wait and post-action observation run inside the content script.
  const waitMs = method.startsWith('input.') ? Math.min(Number(params?.timeoutMs) || 0, 15_000) : 0;
  const observe = params?.observe as { settleMs?: unknown } | null | undefined;
  const settleMs =
    method.startsWith('input.') && observe ? Math.min(Number(observe.settleMs) || 0, 5_000) : 0;
  return contentScriptTimeoutMs + holdAllowance + waitMs + settleMs;
}

/** Dispatch a tab-bound request to the content script after enforcing the
session scope and capability requirements. */
export async function handleTabBoundRequest(
  request: BridgeRequest,
  dependencies: TabBoundRequestDependencies
): Promise<BridgeResponse> {
  const target = await dependencies.resolveRequestTarget(request);
  dependencies.assertNoDialog?.(target.tabId);
  await dependencies.ensureContentScript(target.tabId);
  const normalizer = TAB_BOUND_NORMALIZERS[request.method];
  let payload = normalizer ? normalizer(request.params) : request.params;

  if (request.method.startsWith('screenshot.')) {
    const result = await dependencies.handleScreenshot(
      target,
      request.method,
      request.params,
      request.id
    );
    return createSuccess(request.id, result, { method: request.method });
  }

  const frameId = await chooseFrame(request.method, payload, target.tabId, dependencies);
  if (frameId !== 0 && payload.executionMode === 'cdp') {
    throw new BridgeError(
      ERROR_CODES.INPUT_UNSUPPORTED,
      'executionMode=cdp does not support targets inside iframes; use dom or auto.',
      { frameId }
    );
  }
  if (frameId !== 0 && payload.executionMode === 'auto') {
    payload = { ...payload, executionMode: 'dom' };
  }

  let autoSelection: string | null = null;
  if (payload.executionMode === 'auto' && request.method.startsWith('input.')) {
    const choice = AUTO_CDP_METHODS.has(request.method)
      ? await dependencies.chooseInputExecutionMode?.(target.tabId, request.method, payload)
      : null;
    payload = { ...payload, executionMode: choice?.mode ?? 'dom' };
    autoSelection = choice?.reason ?? 'synthetic-dom-default';
  }

  if (payload.executionMode === 'cdp' && request.method.startsWith('input.')) {
    try {
      const result = markInputExecution(
        await dependencies.handleNativeInput(request, target, payload),
        autoSelection
      );
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

  const guarded = request.method.startsWith('input.') && Boolean(dependencies.runWithDialogGuard);

  const execute = async (): Promise<BridgeResponse> => {
    const timeoutMs = getContentScriptTimeout(
      request.method,
      payload,
      dependencies.contentScriptTimeoutMs
    );
    const message = { type: 'bridge.execute', method: request.method, params: payload };
    let response =
      frameId !== 0 && dependencies.frames
        ? await dependencies.frames.sendFrameMessage(target.tabId, frameId, message, timeoutMs)
        : await dependencies.sendTabMessage(target.tabId, message, timeoutMs);
    if (frameId !== 0 && response && typeof response === 'object' && !('error' in response)) {
      response = { ...response, frameId };
    } else if (frameId === 0 && FAN_OUT_METHODS.has(request.method) && dependencies.frames) {
      response = await mergeChildFrameResults(
        request.method,
        message,
        response,
        target.tabId,
        dependencies
      );
    }
    if (response && typeof response === 'object' && 'error' in response && response.error) {
      const staleOutcome = getStaleRecoveryOutcome(response.error);
      if (staleOutcome) dependencies.recordStaleRecovery?.(staleOutcome, request.method);
      const failure = dependencies.toFailureResponse(request, response.error);
      return staleOutcome
        ? { ...failure, meta: { ...failure.meta, stale_recovery: staleOutcome } }
        : failure;
    }
    const staleOutcome = getStaleRecoveryOutcome(response);
    if (staleOutcome) dependencies.recordStaleRecovery?.(staleOutcome, request.method);
    return createSuccess(request.id, markInputExecution(response, autoSelection, guarded), {
      method: request.method,
      ...(guarded ? { debugger_backed: true } : {}),
      ...(staleOutcome ? { stale_recovery: staleOutcome } : {}),
    });
  };
  return guarded && dependencies.runWithDialogGuard
    ? dependencies.runWithDialogGuard(target.tabId, execute)
    : execute();
}

/** Reads that also search child frames (merged into the top frame's result). */
const FAN_OUT_METHODS = new Set([
  'dom.find_by_text',
  'dom.find_by_role',
  'dom.get_accessibility_tree',
]);
/** Methods whose selector/locator target is probed across frames. */
const FRAME_PROBE_METHODS = new Set([
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
  'dom.query',
  'dom.wait_for',
]);
const FRAME_PROBE_TIMEOUT_MS = 1_500;

/** Collect element refs carried by a request payload. */
function collectPayloadRefs(payload: Record<string, unknown>): string[] {
  const refs: string[] = [];
  for (const value of [payload.elementRef, payload.withinRef]) {
    if (typeof value === 'string' && value) refs.push(value);
  }
  for (const key of ['target', 'source', 'destination']) {
    const spec = payload[key];
    if (spec && typeof spec === 'object') {
      const ref = (spec as { elementRef?: unknown }).elementRef;
      if (typeof ref === 'string' && ref) refs.push(ref);
    }
  }
  return refs;
}

/** Pick the frame a tab-bound request runs in. Refs route to the frame that
minted them; selector/locator inputs not found in the top document are
probed in child frames. Everything else stays in the top frame. */
async function chooseFrame(
  method: string,
  payload: Record<string, unknown>,
  tabId: number,
  dependencies: TabBoundRequestDependencies
): Promise<number> {
  const frames = dependencies.frames;
  if (!frames) return 0;
  const refs = collectPayloadRefs(payload);
  if (refs.length) return frames.getFrameForRef(tabId, refs[0]);
  if (!FRAME_PROBE_METHODS.has(method)) return 0;
  const spec =
    payload.target ??
    payload.source ??
    (typeof payload.selector === 'string' ? { selector: payload.selector } : undefined);
  if (!spec || typeof spec !== 'object') return 0;

  const probe = async (frameId: number) => {
    try {
      const result = (await frames.sendFrameMessage(
        tabId,
        frameId,
        { type: 'bridge.execute', method: 'dom.probe_target', params: { target: spec } },
        FRAME_PROBE_TIMEOUT_MS
      )) as { found?: boolean } | null;
      return result?.found === true;
    } catch {
      return false;
    }
  };
  if (await probe(0)) return 0;
  const childFrames = (await frames.listFrames(tabId)).filter((frame) => frame.frameId !== 0);
  for (const frame of childFrames) {
    if (await probe(frame.frameId)) return frame.frameId;
  }
  return 0;
}

/** Merge finder/outline results from child frames into the top-frame result.
Finders only fan out when the top frame found nothing. */
async function mergeChildFrameResults(
  method: string,
  message: Record<string, unknown>,
  topResponse: unknown,
  tabId: number,
  dependencies: TabBoundRequestDependencies
): Promise<unknown> {
  const frames = dependencies.frames;
  if (!frames || !topResponse || typeof topResponse !== 'object' || 'error' in topResponse) {
    return topResponse;
  }
  const top = topResponse as Record<string, unknown>;
  const isOutline = method === 'dom.get_accessibility_tree';
  if (!isOutline && top.found === true) return topResponse;
  const childFrames = (await frames.listFrames(tabId)).filter((frame) => frame.frameId !== 0);
  if (!childFrames.length) return topResponse;
  const childResults = await Promise.all(
    childFrames.map(async (frame) => {
      try {
        const result = await frames.sendFrameMessage(
          tabId,
          frame.frameId,
          message,
          FRAME_PROBE_TIMEOUT_MS
        );
        return result && typeof result === 'object' && !('error' in result)
          ? { frameId: frame.frameId, result: result as Record<string, unknown> }
          : null;
      } catch {
        return null;
      }
    })
  );
  const usable = childResults.filter((entry) => entry !== null);
  if (isOutline) {
    const sections = usable
      .filter((entry) => typeof entry.result.outline === 'string' && entry.result.outline)
      .map(
        (entry) =>
          `- iframe [frame ${entry.frameId}]\n${String(entry.result.outline)
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n')}`
      );
    if (!sections.length) return topResponse;
    return {
      ...top,
      outline: [top.outline, ...sections].filter(Boolean).join('\n'),
      count:
        Number(top.count ?? 0) +
        usable.reduce((total, entry) => total + Number(entry.result.count ?? 0), 0),
      frames: usable.length,
    };
  }
  const nodes = [
    ...(Array.isArray(top.nodes) ? top.nodes : ([] as unknown[])),
    ...usable.flatMap((entry) =>
      (Array.isArray(entry.result.nodes) ? entry.result.nodes : []).map((node) => ({
        ...(node as Record<string, unknown>),
        frameId: entry.frameId,
      }))
    ),
  ];
  return {
    ...top,
    found: nodes.length > 0,
    nodes,
    count: nodes.length,
    scanned:
      Number(top.scanned ?? 0) +
      usable.reduce((total, entry) => total + Number(entry.result.scanned ?? 0), 0),
  };
}

/** Input methods that auto mode may route through debugger (trusted) input. */
const AUTO_CDP_METHODS = new Set([
  'input.click',
  'input.hover',
  'input.drag',
  'input.type',
  'input.fill',
  'input.press_key',
]);

/** Record auto-mode selection and debugger use for native-dialog observation. */
function markInputExecution<T>(
  result: T,
  selection: string | null,
  dialogGuard: boolean = false
): T {
  if ((!selection && !dialogGuard) || !result || typeof result !== 'object') return result;
  const record = result as Record<string, unknown>;
  const execution =
    record.execution && typeof record.execution === 'object'
      ? (record.execution as Record<string, unknown>)
      : {};
  return {
    ...record,
    execution: {
      ...execution,
      ...(selection ? { requestedMode: 'auto', selectionReason: selection } : {}),
      ...(dialogGuard ? { debuggerUsed: true } : {}),
    },
  } as T;
}

export function getStaleRecoveryOutcome(value: unknown): 'success' | 'failure' | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.recoveryAttempted === true) return 'failure';
  if (record.recovered === true && record.strategy === 'stale-recovery') return 'success';
  for (const key of ['details', 'resolution', 'source', 'destination']) {
    const outcome = getStaleRecoveryOutcome(record[key]);
    if (outcome) return outcome;
  }
  return null;
}
