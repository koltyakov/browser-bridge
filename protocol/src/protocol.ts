import { normalizeBridgeCaller } from './caller.js';
import { applyBudget } from './budget.js';
import { normalizeWebMcpParams } from './webmcp.js';
import { normalizeEmulation, onlyKeys } from './emulation.js';
import { normalizeFileParams } from './files.js';
import { normalizeDownload } from './downloads.js';
import { normalizeRecording } from './recording.js';
import {
  ARTIFACT_CHUNK_BYTES,
  BUDGET_PRESETS,
  DEFAULT_A11Y_MAX_DEPTH,
  DEFAULT_A11Y_MAX_NODES,
  DEFAULT_CONSOLE_LIMIT,
  DEFAULT_DEVICE_SCALE_FACTOR,
  DEFAULT_EVAL_TIMEOUT_MS,
  DEFAULT_EXTRACT_SETTLE_TIMEOUT_MS,
  DEFAULT_HAR_LIMIT,
  DEFAULT_LOG_TAIL_LIMIT,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_HTML_LENGTH,
  DEFAULT_MAX_NODES,
  DEFAULT_NAV_TIMEOUT_MS,
  DEFAULT_NETWORK_INTERCEPT_ACTION,
  DEFAULT_NETWORK_LIMIT,
  DEFAULT_PAGE_TEXT_BUDGET,
  DEFAULT_PERFORM_TIMEOUT_MS,
  DEFAULT_TEXT_BUDGET,
  DEFAULT_TOUCH_HOLD_MS,
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_EXTRACT_SETTLE_TIMEOUT_MS,
  MAX_ARTIFACT_BYTES,
  MAX_HAR_ENTRIES,
  MAX_INPUT_HOLD_MS,
  DEFAULT_INPUT_WAIT_MS,
  MAX_INPUT_WAIT_MS,
  DEFAULT_OBSERVE_SETTLE_MS,
  MAX_OBSERVE_SETTLE_MS,
  MAX_INTERCEPT_BODY_BYTES,
  MAX_INTERCEPT_HEADER_BYTES,
  MAX_INTERCEPT_HEADERS,
  MAX_INTERCEPT_HEADER_VALUE_BYTES,
  MAX_INTERCEPT_URL_PATTERN_LENGTH,
  MAX_PERFORM_STEPS,
  MAX_PERFORM_TIMEOUT_MS,
  MAX_SENSITIVE_VALUE_BYTES,
  MAX_TOUCH_POINTS,
} from './defaults.js';
import { BridgeError, ERROR_CODES, getErrorRecovery } from './errors.js';
import { METHOD_SET, createBridgeMethodGroups } from './registry.js';

export type AccessibilityTreeParams = import('./types.js').AccessibilityTreeParams;
export type ArtifactDeleteParams = import('./types.js').ArtifactDeleteParams;
export type ArtifactReadParams = import('./types.js').ArtifactReadParams;
export type AccessRequestParams = import('./types.js').AccessRequestParams;
export type BridgeFailureResponse = import('./types.js').BridgeFailureResponse;
export type BridgeMeta = import('./types.js').BridgeMeta;
export type BridgeMethod = import('./types.js').BridgeMethod;
export type BridgeRequest = import('./types.js').BridgeRequest;
export type BridgeSuccessResponse = import('./types.js').BridgeSuccessResponse;
export type CheckedActionParams = import('./types.js').CheckedActionParams;
export type CdpDispatchKeyEventParams = import('./types.js').CdpDispatchKeyEventParams;
export type CdpDomSnapshotParams = import('./types.js').CdpDomSnapshotParams;
export type CdpNodeIdParams = import('./types.js').CdpNodeIdParams;
export type ConsoleParams = import('./types.js').ConsoleParams;
export type DomQueryParams = import('./types.js').DomQueryParams;
export type DomBaselineCreateParams = import('./types.js').DomBaselineCreateParams;
export type DomBaselineCompareParams = import('./types.js').DomBaselineCompareParams;
export type DomBaselineHandleParams = import('./types.js').DomBaselineHandleParams;
export type DragParams = import('./types.js').DragParams;
export type EvaluateParams = import('./types.js').EvaluateParams;
export type ExtractContentParams = import('./types.js').ExtractContentParams;
export type FindByRoleParams = import('./types.js').FindByRoleParams;
export type FindByTextParams = import('./types.js').FindByTextParams;
export type GetHtmlParams = import('./types.js').GetHtmlParams;
export type HoverParams = import('./types.js').HoverParams;
export type HarExportParams = import('./types.js').HarExportParams;
export type HandleDialogParams = import('./types.js').HandleDialogParams;
export type HealthPingParams = import('./types.js').HealthPingParams;
export type InputActionParams = import('./types.js').InputActionParams;
export type LogTailParams = import('./types.js').LogTailParams;
export type NavigationActionParams = import('./types.js').NavigationActionParams;
export type NetworkInterceptAddParams = import('./types.js').NetworkInterceptAddParams;
export type NetworkParams = import('./types.js').NetworkParams;
export type NormalizedAccessibilityTreeParams =
  import('./types.js').NormalizedAccessibilityTreeParams;
export type NormalizedArtifactReadParams = import('./types.js').NormalizedArtifactReadParams;
export type NormalizedAccessRequestParams = import('./types.js').NormalizedAccessRequestParams;
export type NormalizedCheckedAction = import('./types.js').NormalizedCheckedAction;
export type NormalizedCdpDispatchKeyEventParams =
  import('./types.js').NormalizedCdpDispatchKeyEventParams;
export type NormalizedCdpDomSnapshotParams = import('./types.js').NormalizedCdpDomSnapshotParams;
export type NormalizedCdpNodeIdParams = import('./types.js').NormalizedCdpNodeIdParams;
export type NormalizedConsoleParams = import('./types.js').NormalizedConsoleParams;
export type NormalizedDomQuery = import('./types.js').NormalizedDomQuery;
export type NormalizedDomBaselineCreateParams =
  import('./types.js').NormalizedDomBaselineCreateParams;
export type NormalizedDomBaselineCompareParams =
  import('./types.js').NormalizedDomBaselineCompareParams;
export type NormalizedDomBaselineHandleParams =
  import('./types.js').NormalizedDomBaselineHandleParams;
export type NormalizedDragParams = import('./types.js').NormalizedDragParams;
export type NormalizedEvaluateParams = import('./types.js').NormalizedEvaluateParams;
export type NormalizedExtractContentParams = import('./types.js').NormalizedExtractContentParams;
export type NormalizedFindByRoleParams = import('./types.js').NormalizedFindByRoleParams;
export type NormalizedFindByTextParams = import('./types.js').NormalizedFindByTextParams;
export type NormalizedGetHtmlParams = import('./types.js').NormalizedGetHtmlParams;
export type NormalizedHoverParams = import('./types.js').NormalizedHoverParams;
export type NormalizedHarExportParams = import('./types.js').NormalizedHarExportParams;
export type NormalizedHandleDialogParams = import('./types.js').NormalizedHandleDialogParams;
export type NormalizedHealthPingParams = import('./types.js').NormalizedHealthPingParams;
export type NormalizedInputAction = import('./types.js').NormalizedInputAction;
export type NormalizedLogTailParams = import('./types.js').NormalizedLogTailParams;
export type NormalizedNavigationAction = import('./types.js').NormalizedNavigationAction;
export type NormalizedNetworkInterceptAddParams =
  import('./types.js').NormalizedNetworkInterceptAddParams;
export type NormalizedNetworkParams = import('./types.js').NormalizedNetworkParams;
export type NormalizedPageTextParams = import('./types.js').NormalizedPageTextParams;
export type NormalizedPatchOperation = import('./types.js').NormalizedPatchOperation;
export type NormalizedPerformParams = import('./types.js').NormalizedPerformParams;
export type NormalizedPerformStep = import('./types.js').NormalizedPerformStep;
export type NormalizedSelectAction = import('./types.js').NormalizedSelectAction;
export type NormalizedScreenshotParams = import('./types.js').NormalizedScreenshotParams;
export type NormalizedStorageParams = import('./types.js').NormalizedStorageParams;
export type NormalizedSensitiveReadParams = import('./types.js').NormalizedSensitiveReadParams;
export type NormalizedStyleQuery = import('./types.js').NormalizedStyleQuery;
export type NormalizedTabCloseParams = import('./types.js').NormalizedTabCloseParams;
export type NormalizedTabCreateParams = import('./types.js').NormalizedTabCreateParams;
export type NormalizedTouchParams = import('./types.js').NormalizedTouchParams;
export type NormalizedTouchPoint = import('./types.js').NormalizedTouchPoint;
export type NormalizedTouchPosition = import('./types.js').NormalizedTouchPosition;
export type NormalizedViewportAction = import('./types.js').NormalizedViewportAction;
export type NormalizedViewportResizeParams = import('./types.js').NormalizedViewportResizeParams;
export type NormalizedWaitForLoadStateParams =
  import('./types.js').NormalizedWaitForLoadStateParams;
export type NormalizedWaitForParams = import('./types.js').NormalizedWaitForParams;
export type PageTextParams = import('./types.js').PageTextParams;
export type PerformParams = import('./types.js').PerformParams;
export type PerformStepMethod = import('./types.js').PerformStepMethod;
export type TouchParams = import('./types.js').TouchParams;
export type PatchOperationParams = import('./types.js').PatchOperationParams;
export type SelectActionParams = import('./types.js').SelectActionParams;
export type ScreenshotParams = import('./types.js').ScreenshotParams;
export type StorageParams = import('./types.js').StorageParams;
export type SensitiveReadParams = import('./types.js').SensitiveReadParams;
export type StyleQueryParams = import('./types.js').StyleQueryParams;
export type TabCloseParams = import('./types.js').TabCloseParams;
export type TabCreateParams = import('./types.js').TabCreateParams;
export type ViewportActionParams = import('./types.js').ViewportActionParams;
export type ViewportResizeParams = import('./types.js').ViewportResizeParams;
export type WaitForLoadStateParams = import('./types.js').WaitForLoadStateParams;
export type WaitForParams = import('./types.js').WaitForParams;

export function deriveProtocolVersion(packageVersion: string | null | undefined): string {
  const match = typeof packageVersion === 'string' ? /^(\d+)\.(\d+)/.exec(packageVersion) : null;
  return match ? `${match[1]}.${match[2]}` : '0.0';
}

/** Minor and patch releases are compatible in either direction within a major. */
export function isProtocolVersionSupported(
  requestedVersion: string,
  supportedVersions: readonly string[]
): boolean {
  const major = /^(\d+)\.\d+$/.exec(requestedVersion)?.[1];
  return (
    major !== undefined &&
    supportedVersions.some((version) => /^(\d+)\.\d+$/.exec(version)?.[1] === major)
  );
}

export function getProtocolVersion(): string {
  return deriveProtocolVersion(globalThis.chrome?.runtime?.getManifest?.().version);
}

/** Versions this build can speak. Newest first. */
export function getSupportedProtocolVersions() {
  return Object.freeze([getProtocolVersion()]);
}

/** Clamp a numeric value between min and max, falling back to a default. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  const integer = Number.isFinite(numeric) && numeric !== 0 ? Math.trunc(numeric) : fallback;
  return Math.min(Math.max(integer, min), max);
}

/** Clamp a finite number without discarding its fractional component. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(numeric, min), max);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function createRequest({
  id,
  method,
  tabId = null,
  params = {},
  meta = {},
}: {
  id: string;
  method: BridgeMethod;
  tabId?: number | null;
  params?: Record<string, unknown>;
  meta?: BridgeMeta;
}): BridgeRequest {
  return validateBridgeRequest({
    id,
    method,
    tab_id: tabId,
    params,
    meta: {
      protocol_version: getProtocolVersion(),
      ...meta,
    },
  });
}

export function createSuccess(
  id: string,
  result: unknown,
  meta: Record<string, unknown> = {}
): BridgeSuccessResponse {
  return {
    id,
    ok: true,
    result,
    error: null,
    meta: {
      protocol_version: getProtocolVersion(),
      ...meta,
    },
  };
}

export function createFailure(
  id: string,
  code: import('./types.js').ErrorCode,
  message: string,
  details: unknown = null,
  meta: Record<string, unknown> = {}
): BridgeFailureResponse {
  const recovery = getRoutingRecovery(code, details) ?? getErrorRecovery(code);
  const effectiveRecovery =
    meta.method === 'webmcp.execute_tool'
      ? {
          retry: false,
          hint: 'WebMCP executions are never retried automatically. Inspect postconditions if dispatch may have started; never replay through DOM fallback.',
        }
      : recovery && meta.method === 'sensitive.read'
        ? {
            retry: false,
            ...(recovery.alternativeMethod
              ? { alternativeMethod: recovery.alternativeMethod }
              : {}),
            hint: `Sensitive reads are never retried automatically. ${recovery.hint}`,
          }
        : recovery;
  return {
    id,
    ok: false,
    result: null,
    error: {
      code,
      message,
      details,
      ...(effectiveRecovery && { recovery: effectiveRecovery }),
    },
    meta: {
      protocol_version: getProtocolVersion(),
      ...meta,
    },
  };
}

/** Routing errors need selection guidance, not closed-tab or global enable hints. */
function getRoutingRecovery(
  code: import('./types.js').ErrorCode,
  details: unknown
): import('./types.js').BridgeRecovery | null {
  const reason =
    details && typeof details === 'object' && 'reason' in details ? details.reason : null;
  if (
    (code === ERROR_CODES.TAB_MISMATCH && reason === 'ambiguous_browser_target') ||
    (code === ERROR_CODES.EXTENSION_DISCONNECTED && reason === 'browser_target_disconnected')
  ) {
    return {
      retry: false,
      alternativeMethod: 'health.ping',
      hint: 'Discover connectedExtensions with health.ping or list enabled profiles with MCP tabs.list. Select extensionId and tabId for the intended page. Do not disable unrelated windows or fall back to another profile.',
    };
  }
  if (code === ERROR_CODES.ACCESS_DENIED && reason === 'no_enabled_browser_profiles') {
    return {
      retry: false,
      alternativeMethod: 'health.ping',
      hint: "Choose the intended extensionId from connectedExtensions before requesting access. Ask the user to enable only that profile's window.",
    };
  }
  return null;
}

export function validateBridgeRequest(request: unknown): BridgeRequest {
  if (!request || typeof request !== 'object') {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'Request must be an object.');
  }

  const candidate = request as Record<string, unknown>;

  if (
    typeof candidate.id !== 'string' ||
    !candidate.id.trim() ||
    candidate.id.length > 128 ||
    hasAsciiControlCharacters(candidate.id)
  ) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'Request id must be a non-empty string of at most 128 characters without controls.'
    );
  }

  if (typeof candidate.method !== 'string' || !METHOD_SET.has(candidate.method as BridgeMethod)) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      `Unsupported method: ${String(candidate.method)}`
    );
  }

  if (
    candidate.meta != null &&
    (typeof candidate.meta !== 'object' || Array.isArray(candidate.meta))
  ) {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'Request meta must be an object.');
  }

  const meta =
    candidate.meta && typeof candidate.meta === 'object'
      ? (candidate.meta as Record<string, unknown>)
      : {};
  if (candidate.session_id != null) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'session_id is no longer supported. Use tab_id or window-scoped default routing.'
    );
  }
  if (
    candidate.params != null &&
    (typeof candidate.params !== 'object' || Array.isArray(candidate.params))
  ) {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'Request params must be an object.');
  }
  const hasTabId = Object.hasOwn(candidate, 'tab_id');
  const candidateTabId = candidate.tab_id;

  let tabId: number | null = null;
  if (hasTabId && candidateTabId !== null) {
    if (
      typeof candidateTabId !== 'number' ||
      !Number.isSafeInteger(candidateTabId) ||
      candidateTabId <= 0
    ) {
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        'Request tab_id must be null or a positive safe integer.'
      );
    }
    tabId = candidateTabId;
  }

  const method = candidate.method as BridgeMethod;
  const params =
    candidate.params && typeof candidate.params === 'object'
      ? (candidate.params as Record<string, unknown>)
      : {};

  return {
    id: candidate.id,
    method,
    tab_id: tabId,
    params: normalizeRequestParams(method, params),
    meta: {
      ...meta,
      ...normalizeBrowserTargetMeta(meta),
      protocol_version:
        typeof meta.protocol_version === 'string' ? meta.protocol_version : getProtocolVersion(),
      token_budget: typeof meta.token_budget === 'number' ? meta.token_budget : null,
      source: meta.source === 'cli' || meta.source === 'mcp' ? meta.source : undefined,
      mcp_era: normalizeMcpEra(meta.source, meta.mcp_era),
      caller:
        meta.source === 'cli' || meta.source === 'mcp'
          ? normalizeBridgeCaller(meta.caller)
          : undefined,
      automatic_retry: normalizeAutomaticRetryMeta(meta.source, meta.automatic_retry),
      agent_session:
        typeof meta.agent_session === 'string' &&
        /^[A-Za-z0-9_.:-]{1,128}$/.test(meta.agent_session.trim())
          ? meta.agent_session.trim()
          : undefined,
    },
  };
}

/** Never turn a malformed explicit selector into implicit routing. */
function normalizeBrowserTargetMeta(
  meta: Record<string, unknown>
): Pick<BridgeMeta, 'target_extension' | 'target_browser' | 'target_profile'> {
  const target: Pick<BridgeMeta, 'target_extension' | 'target_browser' | 'target_profile'> = {};
  for (const field of ['target_extension', 'target_browser', 'target_profile'] as const) {
    const value = meta[field];
    if (value === undefined) continue;
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > 256 ||
      hasAsciiControlCharacters(value)
    ) {
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        `meta.${field} must be a non-empty string of at most 256 characters without control characters.`
      );
    }
    target[field] = value.trim();
  }
  return target;
}

function hasAsciiControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function normalizeMcpEra(
  source: unknown,
  value: unknown
): import('./types.js').McpProtocolEra | undefined {
  return source === 'mcp' && (value === 'legacy' || value === 'modern') ? value : undefined;
}

function normalizeAutomaticRetryMeta(
  source: unknown,
  value: unknown
): { attempt: 2; reason: 'retryable_error' } | undefined {
  if (source !== 'mcp' || !isPlainRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  return keys.length === 2 &&
    keys[0] === 'attempt' &&
    keys[1] === 'reason' &&
    value.attempt === 2 &&
    value.reason === 'retryable_error'
    ? { attempt: 2, reason: 'retryable_error' }
    : undefined;
}

/** Normalize request params early so malformed payloads fail at the shared
protocol boundary before daemon or extension dispatch. Exported so later
stages re-normalize with the same per-method options (auto-wait, observe). */
export function normalizeRequestParams(
  method: BridgeMethod,
  params: Record<string, unknown>
): Record<string, unknown> {
  switch (method) {
    case 'download.start':
    case 'download.status':
    case 'download.pause':
    case 'download.resume':
    case 'download.cancel':
    case 'download.release':
      return normalizeDownload(method, params);
    case 'session.start':
    case 'session.journal_read':
    case 'session.journal_delete':
    case 'session.status':
    case 'session.read':
    case 'session.stop':
    case 'session.export':
    case 'session.release':
      return normalizeRecording(method, params);
    case 'files.stage':
    case 'files.release':
    case 'download.resource':
      return normalizeFileParams(method, params);
    case 'input.set_files':
    case 'input.paste_image':
      return {
        ...normalizeFileParams(method, params),
        target: normalizeInputAction(params).target,
      };
    case 'emulation.apply':
      return normalizeEmulation(params);
    case 'emulation.status':
    case 'emulation.reset':
      onlyKeys(params, []);
      return {};
    case 'webmcp.list_tools':
    case 'webmcp.get_tool':
    case 'webmcp.execute_tool': {
      const normalized = normalizeWebMcpParams(params);
      if (method !== 'webmcp.list_tools' && !normalized.toolRef) {
        throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'toolRef is required.');
      }
      return normalized;
    }
    case 'access.request':
      return normalizeAccessRequestParams(params);
    case 'log.tail':
      return normalizeLogTailParams(params);
    case 'health.ping':
      return normalizeHealthPingParams(params);
    case 'dom.query':
      return normalizeDomQuery(params);
    case 'dom.baseline.create':
      return normalizeDomBaselineCreateParams(params);
    case 'dom.baseline.compare':
      return normalizeDomBaselineCompareParams(params);
    case 'dom.baseline.describe':
    case 'dom.baseline.release':
      return normalizeDomBaselineHandleParams(params);
    case 'page.evaluate':
      return normalizeEvaluateParams(params);
    case 'page.get_console':
      return normalizeConsoleParams(params);
    case 'page.handle_dialog':
      return normalizeHandleDialogParams(params);
    case 'page.wait_for_load_state':
      return normalizeWaitForLoadStateParams(params);
    case 'page.get_storage':
      return normalizeStorageParams(params);
    case 'sensitive.read':
      return normalizeSensitiveReadParams(params);
    case 'page.get_text':
      return normalizePageTextParams(params);
    case 'page.extract_content':
      return normalizeExtractContentParams(params);
    case 'page.get_network':
      return normalizeNetworkParams(params);
    case 'network.export_har':
      return normalizeHarExportParams(params);
    case 'network.intercept.add':
      return normalizeNetworkInterceptAddParams(params);
    case 'navigation.navigate':
    case 'navigation.reload':
    case 'navigation.go_back':
    case 'navigation.go_forward':
      return normalizeNavigationAction(params);
    case 'dom.wait_for':
      return normalizeWaitForParams(params);
    case 'dom.find_by_text':
      return normalizeFindByTextParams(params);
    case 'dom.find_by_role':
      return normalizeFindByRoleParams(params);
    case 'dom.get_html':
      return normalizeGetHtmlParams(params);
    case 'dom.get_accessibility_tree':
      return normalizeAccessibilityTreeParams(params);
    case 'styles.get_computed':
    case 'styles.get_matched_rules':
      return normalizeStyleQuery(params);
    case 'viewport.scroll':
      return normalizeViewportAction(params);
    case 'viewport.resize':
      return normalizeViewportResizeParams(params);
    case 'input.click':
    case 'input.focus':
    case 'input.type':
    case 'input.fill':
    case 'input.press_key':
      return withInputOptions(method, normalizeInputAction(params), params);
    case 'cdp.dispatch_key_event':
      return normalizeCdpDispatchKeyEventParams(params);
    case 'cdp.get_box_model':
    case 'cdp.get_computed_styles_for_node':
      return normalizeCdpNodeIdParams(params);
    case 'cdp.get_dom_snapshot':
      return normalizeCdpDomSnapshotParams(params);
    case 'input.set_checked':
      return withInputOptions(method, normalizeCheckedAction(params), params);
    case 'input.select_option':
      return withInputOptions(method, normalizeSelectAction(params), params);
    case 'input.hover':
      return withInputOptions(method, normalizeHoverParams(params), params);
    case 'input.drag':
      return withInputOptions(method, normalizeDragParams(params), params);
    case 'input.touch':
      return normalizeTouchParams(params);
    case 'input.perform':
      return normalizeInputPerformParams(params);
    case 'screenshot.capture_region':
      return { ...params, ...normalizeScreenshotParams(params) };
    case 'screenshot.capture_element':
    case 'screenshot.capture_full_page':
      return {
        ...params,
        ...normalizeScreenshotParams(params),
        ...(params.scale === undefined ? { scale: undefined } : {}),
      };
    case 'artifact.read':
      return normalizeArtifactReadParams(params);
    case 'artifact.delete':
      return normalizeArtifactDeleteParams(params);
    case 'patch.apply_styles':
    case 'patch.apply_dom':
    case 'patch.list':
    case 'patch.rollback':
    case 'patch.commit_session_baseline':
      return normalizePatchOperation(params);
    case 'tabs.create':
      return normalizeTabCreateParams(params);
    case 'tabs.close':
      return normalizeTabCloseParams(params);
    default:
      return params;
  }
}

export function normalizeAccessRequestParams(
  params: AccessRequestParams = {}
): NormalizedAccessRequestParams {
  const intent = params.intent ?? 'general';
  if (
    intent !== 'inspect' &&
    intent !== 'interact' &&
    intent !== 'capture' &&
    intent !== 'navigate' &&
    intent !== 'debugger' &&
    intent !== 'general'
  ) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'intent must be one of inspect, interact, capture, navigate, debugger, or general.'
    );
  }
  return { intent };
}

export function normalizeDomQuery(params: DomQueryParams = {}): NormalizedDomQuery {
  const nestedBudget =
    params.budget && typeof params.budget === 'object' ? params.budget : undefined;
  return {
    selector:
      typeof params.selector === 'string' && params.selector.trim() ? params.selector : 'body',
    withinRef: typeof params.withinRef === 'string' ? params.withinRef : null,
    budget: applyBudget({ ...nestedBudget, ...params }),
  };
}

export function normalizeDomBaselineCreateParams(
  params: DomBaselineCreateParams = {}
): NormalizedDomBaselineCreateParams {
  const selector = typeof params.selector === 'string' ? params.selector.trim() : '';
  if (selector.length > 2_048) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'selector must not exceed 2,048 characters.'
    );
  }

  const attributeAllowlist = Array.isArray(params.attributeAllowlist)
    ? [
        ...new Set(
          params.attributeAllowlist
            .filter((name) => typeof name === 'string')
            .map((name) => name.trim().toLowerCase())
            .filter(
              (name) =>
                name.length > 0 &&
                name.length <= 128 &&
                name !== 'value' &&
                !name.startsWith('on') &&
                /^[a-z_][a-z0-9_.:-]*$/u.test(name)
            )
        ),
      ]
    : [];
  if (attributeAllowlist.length > 16) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'attributeAllowlist must contain at most 16 unique attribute names.'
    );
  }

  return {
    selector: selector || 'body',
    maxNodes: clampInt(params.maxNodes, 1, 1_000, 100),
    maxDepth: clampInt(params.maxDepth, 1, 20, 8),
    textBudget: clampInt(params.textBudget, 32, 1_000, 160),
    attributeAllowlist,
  };
}

export function normalizeDomBaselineCompareParams(
  params: DomBaselineCompareParams = {}
): NormalizedDomBaselineCompareParams {
  return {
    baselineId: normalizeDomBaselineId(params.baselineId),
    maxChanges: clampInt(params.maxChanges, 1, 200, 50),
  };
}

export function normalizeDomBaselineHandleParams(
  params: DomBaselineHandleParams = {}
): NormalizedDomBaselineHandleParams {
  return { baselineId: normalizeDomBaselineId(params.baselineId) };
}

function normalizeDomBaselineId(value: unknown): string {
  if (typeof value !== 'string' || !/^baseline_[A-Za-z0-9_-]{32,64}$/u.test(value)) {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'baselineId is invalid.');
  }
  return value;
}

export function normalizeStyleQuery(params: StyleQueryParams = {}): NormalizedStyleQuery {
  const target = normalizeTarget(
    params.target && typeof params.target === 'object'
      ? (params.target as { elementRef?: string; selector?: string })
      : undefined
  );
  const elementRef = String(params.elementRef || target.elementRef || '');
  if (!elementRef && !target.selector) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'elementRef or target is required for style queries. Pass a selector as target.selector.'
    );
  }
  return {
    elementRef,
    target,
    properties: Array.isArray(params.properties) ? params.properties.filter(Boolean) : [],
  };
}

const TARGET_LOCATOR_KEYS = ['role', 'name', 'text', 'label', 'placeholder', 'testId'] as const;
const MAX_LOCATOR_VALUE_LENGTH = 500;

/** Normalize an input target. Besides `elementRef` and `selector`, a target can
be a semantic locator (`role` + `name`, `text`, `label`, `placeholder`,
`testId`) so one action call can find and act on an element. `selector`
then narrows locator candidates; `nth` picks one of several matches. */
function normalizeTarget(
  target: Record<string, unknown> | null | undefined
): import('./types.js').InputTarget {
  const normalized: import('./types.js').InputTarget = {
    elementRef: typeof target?.elementRef === 'string' ? target.elementRef : undefined,
    selector: typeof target?.selector === 'string' ? target.selector : undefined,
  };
  if (!target) return normalized;
  for (const key of TARGET_LOCATOR_KEYS) {
    const value = target[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (value.length > MAX_LOCATOR_VALUE_LENGTH) {
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        `target.${key} must not exceed ${MAX_LOCATOR_VALUE_LENGTH} characters.`
      );
    }
    normalized[key] = value.trim();
  }
  if (target.exact === true) normalized.exact = true;
  if (target.nth !== undefined && target.nth !== null) {
    const nth = Number(target.nth);
    if (!Number.isInteger(nth) || nth < 0 || nth > 49) {
      throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'target.nth must be an integer 0-49.');
    }
    normalized.nth = nth;
  }
  return normalized;
}

/** Shared target auto-wait and post-action observation bounds (ms). */
export {
  DEFAULT_INPUT_WAIT_MS,
  MAX_INPUT_WAIT_MS,
  DEFAULT_OBSERVE_SETTLE_MS,
  MAX_OBSERVE_SETTLE_MS,
} from './defaults.js';

/** Actions that report their observed effects unless `observe: false`. */
const OBSERVE_BY_DEFAULT_METHODS = new Set([
  'input.click',
  'input.press_key',
  'input.select_option',
  'input.set_checked',
]);

function normalizeObserveOption(
  method: string,
  value: unknown,
  normalized: { submit?: boolean }
): { settleMs: number } | null {
  if (value === false || value === null) return null;
  if (value && typeof value === 'object') {
    const settleMs = (value as { settleMs?: unknown }).settleMs;
    return {
      settleMs: clampInt(settleMs, 0, MAX_OBSERVE_SETTLE_MS, DEFAULT_OBSERVE_SETTLE_MS),
    };
  }
  const observeByDefault =
    OBSERVE_BY_DEFAULT_METHODS.has(method) ||
    ((method === 'input.type' || method === 'input.fill') && normalized.submit === true);
  return value === true || observeByDefault ? { settleMs: DEFAULT_OBSERVE_SETTLE_MS } : null;
}

/** Add the shared auto-wait and observation options to normalized input params. */
function withInputOptions<T extends Record<string, unknown>>(
  method: string,
  normalized: T,
  raw: Record<string, unknown>
): T & { timeoutMs: number; observe: { settleMs: number } | null } {
  return {
    ...normalized,
    timeoutMs:
      typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)
        ? Math.round(clampNumber(raw.timeoutMs, 0, MAX_INPUT_WAIT_MS, DEFAULT_INPUT_WAIT_MS))
        : DEFAULT_INPUT_WAIT_MS,
    observe: normalizeObserveOption(method, raw.observe, normalized),
  };
}

function normalizeInputExecutionMode(value: unknown): import('./types.js').InputExecutionMode {
  if (value !== undefined && value !== 'dom' && value !== 'cdp' && value !== 'auto') {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'executionMode must be dom, cdp, or auto.');
  }
  return value === 'cdp' || value === 'auto' ? value : 'dom';
}

export function normalizeInputAction(params: InputActionParams = {}): NormalizedInputAction {
  const button = params.button === 'middle' || params.button === 'right' ? params.button : 'left';
  const mode =
    params.mode === 'setter' || params.mode === 'keystrokes' || params.mode === 'auto'
      ? params.mode
      : 'auto';

  return {
    target: normalizeTarget(
      params.target && typeof params.target === 'object'
        ? (params.target as { elementRef?: string; selector?: string })
        : undefined
    ),
    button,
    clickCount: clampInt(params.clickCount, 1, 2, 1),
    text: typeof params.text === 'string' ? params.text : '',
    value: typeof params.value === 'string' ? params.value : '',
    mode,
    clear: Boolean(params.clear),
    submit: Boolean(params.submit),
    key: typeof params.key === 'string' ? params.key : '',
    modifiers: Array.isArray(params.modifiers)
      ? params.modifiers.filter((modifier) => typeof modifier === 'string' && modifier.trim())
      : [],
    holdMs: normalizeHoldMs(params.holdMs, 0),
    executionMode: normalizeInputExecutionMode(params.executionMode),
    recoverStale: params.recoverStale === true,
  };
}

/** Normalize a press-and-hold duration, honoring an explicit zero. */
function normalizeHoldMs(value: unknown, fallback: number): number {
  return Math.round(clampNumber(value, 0, MAX_INPUT_HOLD_MS, fallback));
}

function normalizeTouchPosition(value: unknown, label: string): NormalizedTouchPosition {
  if (!isPlainRecord(value)) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      `${label} must be an object with either target or numeric x and y.`
    );
  }
  const hasTarget = isPlainRecord(value.target);
  const hasPoint =
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y);
  if (hasTarget === hasPoint) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      `${label} needs exactly one of target or numeric x and y.`
    );
  }
  if (hasTarget) {
    return {
      target: normalizeTarget(value.target as { elementRef?: string; selector?: string }),
      x: null,
      y: null,
    };
  }
  return { target: null, x: value.x as number, y: value.y as number };
}

/** Normalize a simultaneous touch gesture: one to MAX_TOUCH_POINTS fingers,
each placed on a target or viewport point and optionally moved to an end
position while all fingers stay down for holdMs. */
export function normalizeTouchParams(params: TouchParams = {}): NormalizedTouchParams {
  const rawPoints = params.points;
  if (!Array.isArray(rawPoints) || rawPoints.length < 1 || rawPoints.length > MAX_TOUCH_POINTS) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      `points must be an array of 1 to ${MAX_TOUCH_POINTS} touch points.`
    );
  }

  const points: NormalizedTouchPoint[] = rawPoints.map((point, index) => {
    const start = normalizeTouchPosition(point, `points[${index}]`);
    const rawEnd = isPlainRecord(point) ? point.to : undefined;
    return {
      ...start,
      to: rawEnd == null ? null : normalizeTouchPosition(rawEnd, `points[${index}].to`),
    };
  });
  return {
    points,
    holdMs: normalizeHoldMs(params.holdMs, DEFAULT_TOUCH_HOLD_MS),
    moveSteps: clampInt(params.moveSteps, 1, 60, 10),
    executionMode: normalizeInputExecutionMode(params.executionMode),
    recoverStale: params.recoverStale === true,
  };
}

/** Input, wait, and bounded inspection methods allowed in input.perform steps. */
const PERFORM_STEP_METHODS = new Set([
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
  'viewport.scroll',
  'dom.wait_for',
  'page.wait_for_load_state',
  'page.get_state',
  'page.get_text',
  'dom.query',
  'dom.get_text',
]);

/** Step methods that accept executionMode=cdp. */
const CDP_CAPABLE_STEP_METHODS = new Set([
  'input.click',
  'input.hover',
  'input.drag',
  'input.type',
  'input.fill',
  'input.press_key',
  'input.touch',
]);

function normalizeStepTiming(value: unknown, label: string, maximum: number): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      `${label} must be a number between 0 and the sequence timeoutMs (${maximum}).`
    );
  }
  return Math.round(value);
}

/** Captured URLs are sanitized before outcome matching: the fragment is dropped,
the path is percent-encoded, and the query is reserialized with every value
redacted. Write the pattern in that form so a literal substring can match. */
function normalizeNetworkUrlPattern(pattern: string): string {
  const invalid = (message: string) => new BridgeError(ERROR_CODES.INVALID_REQUEST, message);
  if (pattern.includes('#'))
    throw invalid('Network outcome urlPattern cannot include a fragment; captured URLs omit it.');
  // Without '?', a pattern can still begin inside the query at an '&'.
  const queryStart = pattern.includes('?') ? pattern.indexOf('?') : pattern.indexOf('&');
  const separator = queryStart >= 0 ? pattern[queryStart] : '';
  const query = queryStart >= 0 ? pattern.slice(queryStart + 1) : null;
  // Every captured parameter has a redacted value, so a match can include at
  // most one parameter name, ending the pattern. Text before a bare '&' is the
  // tail of a redacted value, so it cannot hold a value of its own either.
  if (
    query !== null &&
    (/=.|&/u.test(query) || (separator === '&' && pattern.slice(0, queryStart).includes('=')))
  )
    throw invalid(
      'Captured query values are redacted. End the pattern at one parameter name, for example /api/items?id=.'
    );
  const authority = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/iu.exec(pattern)?.[0] ?? '';
  const path = pattern.slice(authority.length, queryStart >= 0 ? queryStart : undefined);
  try {
    // The URL path percent-encode set, plus every non-ASCII code point.
    const encodedPath = path.replace(/[^\x21-\x7e]|["<>`{}]/gu, (c) => encodeURIComponent(c));
    // URLSearchParams decodes the name, then reserializes it form-encoded.
    let encodedQuery = '';
    const name = query === null ? undefined : [...new URLSearchParams(query).keys()][0];
    if (name !== undefined) {
      encodedQuery = new URLSearchParams([[name, '']]).toString().slice(0, -1);
      if (query?.includes('=')) encodedQuery += '=';
    }
    return `${authority.toLowerCase()}${encodedPath}${separator}${encodedQuery}`;
  } catch {
    throw invalid('Network outcome urlPattern must be well-formed Unicode text.');
  }
}

/** Normalize an ordered, timed input sequence. Each step reuses an existing
bridge method and its own normalizer; the sequence adds only scheduling. */
export function normalizeInputPerformParams(params: PerformParams = {}): NormalizedPerformParams {
  const timeoutMs = clampInt(
    params.timeoutMs,
    100,
    MAX_PERFORM_TIMEOUT_MS,
    DEFAULT_PERFORM_TIMEOUT_MS
  );
  const executionMode =
    params.executionMode === undefined ? null : normalizeInputExecutionMode(params.executionMode);
  const rawSteps = params.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length < 1 || rawSteps.length > MAX_PERFORM_STEPS) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      `steps must be an array of 1 to ${MAX_PERFORM_STEPS} steps.`
    );
  }

  const steps: NormalizedPerformStep[] = rawSteps.map((step, index) => {
    if (!isPlainRecord(step)) {
      throw new BridgeError(ERROR_CODES.INVALID_REQUEST, `steps[${index}] must be an object.`);
    }
    const method = step.method;
    if (typeof method !== 'string' || !PERFORM_STEP_METHODS.has(method)) {
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        `steps[${index}].method must be one of ${[...PERFORM_STEP_METHODS].join(', ')}.`
      );
    }
    if (step.params !== undefined && !isPlainRecord(step.params)) {
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        `steps[${index}].params must be an object.`
      );
    }
    const rawParams = step.params ?? ({} as Record<string, unknown>);
    const stepParams =
      executionMode && CDP_CAPABLE_STEP_METHODS.has(method) && rawParams.executionMode === undefined
        ? { ...rawParams, executionMode }
        : rawParams;
    const delayMs = normalizeStepTiming(step.delayMs, `steps[${index}].delayMs`, timeoutMs);
    const atMs = normalizeStepTiming(step.atMs, `steps[${index}].atMs`, timeoutMs);
    if (delayMs && atMs !== null) {
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        `steps[${index}] accepts either delayMs or atMs, not both.`
      );
    }
    const stepMethod = method as PerformStepMethod;
    const normalizedStepParams = normalizeRequestParams(stepMethod, stepParams);
    // Timed sequences keep their schedule: steps observe effects only on request.
    if (rawParams.observe === undefined && 'observe' in normalizedStepParams) {
      normalizedStepParams.observe = null;
    }
    return {
      method: stepMethod,
      params: normalizedStepParams,
      delayMs: delayMs ?? 0,
      atMs,
    };
  });

  let outcomes: import('./types.js').NormalizedPerformOutcome[] | undefined;
  if (params.outcomes !== undefined) {
    if (
      !Array.isArray(params.outcomes) ||
      params.outcomes.length < 1 ||
      params.outcomes.length > 8 ||
      params.continueOnError === true
    )
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        'outcomes must contain 1 to 8 conditions and requires continueOnError=false.'
      );
    const rawOutcomes = params.outcomes as unknown[];
    outcomes = rawOutcomes.map((condition, index) => {
      if (!isPlainRecord(condition))
        throw new BridgeError(ERROR_CODES.INVALID_REQUEST, `outcomes[${index}] must be an object.`);
      if (condition.kind === 'dom') {
        if (typeof condition.selector !== 'string' || !condition.selector.trim())
          throw new BridgeError(
            ERROR_CODES.INVALID_REQUEST,
            'DOM outcomes require a non-empty selector.'
          );
        return { kind: 'dom', ...normalizeWaitForParams({ ...condition, timeoutMs }) };
      }
      if (condition.kind === 'url') {
        if (typeof condition.url !== 'string' || !condition.url.trim())
          throw new BridgeError(
            ERROR_CODES.INVALID_REQUEST,
            'URL outcomes require a non-empty url.'
          );
        return {
          kind: 'url',
          ...normalizeWaitForLoadStateParams({ ...condition, waitForLoad: false, timeoutMs }),
        };
      }
      if (
        condition.kind !== 'network' ||
        typeof condition.urlPattern !== 'string' ||
        !condition.urlPattern.trim() ||
        condition.urlPattern.length > 500
      )
        throw new BridgeError(
          ERROR_CODES.INVALID_REQUEST,
          'Network outcomes require a non-empty urlPattern of at most 500 characters.'
        );
      const method = condition.method == null ? null : condition.method;
      if (method !== null && (typeof method !== 'string' || !/^[A-Za-z]{1,16}$/u.test(method)))
        throw new BridgeError(
          ERROR_CODES.INVALID_REQUEST,
          'Network outcome method must be an HTTP method.'
        );
      const statusMin = condition.statusMin ?? 200;
      const statusMax = condition.statusMax ?? 299;
      if (
        !Number.isInteger(statusMin) ||
        !Number.isInteger(statusMax) ||
        Number(statusMin) < 0 ||
        Number(statusMax) > 599 ||
        Number(statusMin) > Number(statusMax)
      )
        throw new BridgeError(
          ERROR_CODES.INVALID_REQUEST,
          'Network outcome status bounds must be integers from 0 to 599, in order.'
        );
      return {
        kind: 'network',
        urlPattern: normalizeNetworkUrlPattern(condition.urlPattern),
        method: method?.toUpperCase() ?? null,
        statusMin: Number(statusMin),
        statusMax: Number(statusMax),
      };
    });
  }
  return {
    steps,
    timeoutMs,
    continueOnError: params.continueOnError === true,
    returnLastResult: params.returnLastResult === true,
    ...(outcomes ? { outcomes } : {}),
  };
}

export function normalizeCdpDispatchKeyEventParams(
  params: CdpDispatchKeyEventParams = {}
): NormalizedCdpDispatchKeyEventParams {
  if (typeof params.key !== 'string' || !params.key.trim()) {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'key must be a non-empty string.');
  }

  if (
    params.modifiers != null &&
    typeof params.modifiers !== 'number' &&
    !Array.isArray(params.modifiers)
  ) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'modifiers must be an array of Alt, Control, Meta, Shift or a bitmask 0-15.'
    );
  }

  if (
    typeof params.modifiers === 'number' &&
    (!Number.isInteger(params.modifiers) || params.modifiers < 0 || params.modifiers > 15)
  ) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'modifiers must be an array of Alt, Control, Meta, Shift or a bitmask 0-15.'
    );
  }

  if (Array.isArray(params.modifiers)) {
    for (const modifier of params.modifiers) {
      if (typeof modifier !== 'string' || !['Alt', 'Control', 'Meta', 'Shift'].includes(modifier)) {
        throw new BridgeError(
          ERROR_CODES.INVALID_REQUEST,
          'modifiers must contain only Alt, Control, Meta, or Shift.'
        );
      }
    }
  }

  return {
    key: params.key,
    code: typeof params.code === 'string' ? params.code.trim() : '',
    modifiers: params.modifiers ?? [],
  };
}

export function normalizeCdpNodeIdParams(params: CdpNodeIdParams = {}): NormalizedCdpNodeIdParams {
  if (typeof params.nodeId !== 'number' || !Number.isFinite(params.nodeId)) {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'nodeId must be a finite number.');
  }

  return {
    nodeId: params.nodeId,
  };
}

export function normalizeCdpDomSnapshotParams(
  params: CdpDomSnapshotParams = {}
): NormalizedCdpDomSnapshotParams {
  const computedStyles = Array.isArray(params.computedStyles)
    ? params.computedStyles.filter(
        (property) => typeof property === 'string' && property.length > 0 && property.length <= 128
      )
    : [];
  if (computedStyles.length > 100) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'computedStyles must contain at most 100 CSS property names.'
    );
  }
  return { computedStyles };
}

export function normalizeCheckedAction(params: CheckedActionParams = {}): NormalizedCheckedAction {
  return {
    target: normalizeTarget(
      params.target && typeof params.target === 'object'
        ? (params.target as { elementRef?: string; selector?: string })
        : undefined
    ),
    checked: params.checked !== false,
    executionMode: normalizeInputExecutionMode(params.executionMode),
    recoverStale: params.recoverStale === true,
  };
}

export function normalizeSelectAction(params: SelectActionParams = {}): NormalizedSelectAction {
  return {
    target: normalizeTarget(
      params.target && typeof params.target === 'object'
        ? (params.target as { elementRef?: string; selector?: string })
        : undefined
    ),
    values: Array.isArray(params.values)
      ? params.values.filter((value) => typeof value === 'string' && value.trim())
      : [],
    labels: Array.isArray(params.labels)
      ? params.labels.filter((label) => typeof label === 'string' && label.trim())
      : [],
    indexes: Array.isArray(params.indexes)
      ? params.indexes
          .map((index) => Number(index))
          .filter((index) => Number.isInteger(index) && index >= 0)
      : [],
    executionMode: normalizeInputExecutionMode(params.executionMode),
    recoverStale: params.recoverStale === true,
  };
}

export function normalizeViewportAction(
  params: ViewportActionParams = {}
): NormalizedViewportAction {
  return {
    target: normalizeTarget(
      params.target && typeof params.target === 'object'
        ? (params.target as { elementRef?: string; selector?: string })
        : undefined
    ),
    top: Number.isFinite(Number(params.top)) ? Number(params.top) : 0,
    left: Number.isFinite(Number(params.left)) ? Number(params.left) : 0,
    behavior: params.behavior === 'smooth' ? 'smooth' : 'auto',
    relative: Boolean(params.relative),
  };
}

export function normalizeNavigationAction(
  params: NavigationActionParams = {}
): NormalizedNavigationAction {
  const url = typeof params.url === 'string' ? params.url.trim() : '';
  if (url) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:', 'about:'].includes(parsed.protocol)) {
        throw new BridgeError(
          ERROR_CODES.INVALID_REQUEST,
          `Navigation blocked: unsupported protocol "${parsed.protocol}". Only http:, https:, and about: are allowed.`
        );
      }
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(ERROR_CODES.INVALID_REQUEST, `Invalid navigation URL: ${url}`);
    }
  }
  return {
    url,
    waitForLoad: params.waitForLoad !== false,
    timeoutMs: clampInt(params.timeoutMs, 500, 120_000, DEFAULT_NAV_TIMEOUT_MS),
  };
}

export function normalizePatchOperation(
  params: PatchOperationParams = {}
): NormalizedPatchOperation {
  const operation = typeof params.operation === 'string' ? params.operation : null;
  if (
    operation !== null &&
    ![
      'set_text',
      'set_attribute',
      'remove_attribute',
      'add_class',
      'remove_class',
      'toggle_class',
    ].includes(operation)
  ) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      `Unsupported DOM patch operation: ${operation}`
    );
  }
  return {
    patchId: typeof params.patchId === 'string' ? params.patchId : null,
    target:
      params.target && typeof params.target === 'object'
        ? (params.target as Record<string, unknown>)
        : {},
    operation,
    name: typeof params.name === 'string' ? params.name : null,
    declarations:
      params.declarations && typeof params.declarations === 'object'
        ? (params.declarations as Record<string, string>)
        : {},
    value: params.value ?? null,
    important: Boolean(params.important),
    verify: Boolean(params.verify),
  };
}

export function normalizeEvaluateParams(params: EvaluateParams = {}): NormalizedEvaluateParams {
  const expression = typeof params.expression === 'string' ? params.expression : '';
  if (expression.length > 100_000) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      `Expression too large (${expression.length} chars). Maximum is 100,000.`
    );
  }
  if (params.returnByValue === false) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'returnByValue=false is not supported because remote CDP objects cannot be consumed.'
    );
  }
  return {
    expression,
    awaitPromise: Boolean(params.awaitPromise),
    timeoutMs: clampInt(params.timeoutMs, 100, 30_000, DEFAULT_EVAL_TIMEOUT_MS),
    returnByValue: true,
  };
}

export function normalizeConsoleParams(params: ConsoleParams = {}): NormalizedConsoleParams {
  const validLevels = ['all', 'log', 'warn', 'error', 'info', 'debug', 'exception', 'rejection'];
  return {
    level: validLevels.includes(String(params.level ?? '')) ? String(params.level) : 'all',
    clear: Boolean(params.clear),
    limit: clampInt(params.limit, 1, 200, 50),
  };
}

export function normalizeHandleDialogParams(
  params: HandleDialogParams = {}
): NormalizedHandleDialogParams {
  const action = params.action ?? 'inspect';
  if (action !== 'inspect' && action !== 'accept' && action !== 'dismiss') {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'action must be one of inspect, accept, or dismiss.'
    );
  }
  if (
    params.promptText !== undefined &&
    params.promptText !== null &&
    typeof params.promptText !== 'string'
  ) {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'promptText must be a string.');
  }
  if (typeof params.promptText === 'string' && params.promptText.length > 10_000) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'promptText must not exceed 10,000 characters.'
    );
  }
  if (params.promptText !== undefined && params.promptText !== null && action !== 'accept') {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'promptText is only valid when action is accept.'
    );
  }
  if (
    params.expectedDialogId !== undefined &&
    params.expectedDialogId !== null &&
    (typeof params.expectedDialogId !== 'string' ||
      params.expectedDialogId.length === 0 ||
      params.expectedDialogId.length > 128)
  ) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'expectedDialogId must be a non-empty string of at most 128 characters.'
    );
  }
  if (action === 'inspect' && params.expectedDialogId != null) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'expectedDialogId is only valid when action is accept or dismiss.'
    );
  }
  return {
    action,
    promptText: typeof params.promptText === 'string' ? params.promptText : null,
    expectedDialogId: typeof params.expectedDialogId === 'string' ? params.expectedDialogId : null,
  };
}

export function normalizeWaitForParams(params: WaitForParams = {}): NormalizedWaitForParams {
  const validStates = ['attached', 'detached', 'visible', 'hidden'];
  const selector =
    typeof params.selector === 'string' && params.selector.trim() ? params.selector : '';
  const text = typeof params.text === 'string' && params.text.trim() ? params.text : null;
  if (!selector && text === null) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'selector or text is required for dom.wait_for.'
    );
  }
  return {
    selector: selector || '*',
    text,
    state: validStates.includes(String(params.state ?? ''))
      ? (String(params.state) as 'attached' | 'detached' | 'visible' | 'hidden')
      : 'attached',
    timeoutMs: clampInt(params.timeoutMs, 100, 30_000, 5_000),
  };
}

export function normalizeFindByTextParams(
  params: FindByTextParams = {}
): NormalizedFindByTextParams {
  return {
    text: typeof params.text === 'string' ? params.text : '',
    exact: Boolean(params.exact),
    selector: typeof params.selector === 'string' && params.selector.trim() ? params.selector : '*',
    maxResults: clampInt(params.maxResults, 1, 50, 10),
    includeHidden: params.includeHidden === true,
  };
}

export function normalizeFindByRoleParams(
  params: FindByRoleParams = {}
): NormalizedFindByRoleParams {
  return {
    role: typeof params.role === 'string' ? params.role : '',
    name: typeof params.name === 'string' ? params.name : '',
    exact: Boolean(params.exact),
    selector: typeof params.selector === 'string' && params.selector.trim() ? params.selector : '*',
    maxResults: clampInt(params.maxResults, 1, 50, 10),
    includeHidden: params.includeHidden === true,
  };
}

export function normalizeGetHtmlParams(params: GetHtmlParams = {}): NormalizedGetHtmlParams {
  const target = normalizeTarget(
    params.target && typeof params.target === 'object'
      ? (params.target as { elementRef?: string; selector?: string })
      : undefined
  );
  return {
    elementRef: String(params.elementRef || target.elementRef || ''),
    target,
    outer: Boolean(params.outer),
    maxLength: clampInt(params.maxLength, 32, 50_000, 2000),
  };
}

export function normalizeHoverParams(params: HoverParams = {}): NormalizedHoverParams {
  return {
    target: normalizeTarget(
      params.target && typeof params.target === 'object'
        ? (params.target as { elementRef?: string; selector?: string })
        : undefined
    ),
    duration: clampInt(params.duration, 0, 5_000, 0),
    modifiers: Array.isArray(params.modifiers)
      ? params.modifiers.filter((modifier) => typeof modifier === 'string' && modifier.trim())
      : [],
    executionMode: normalizeInputExecutionMode(params.executionMode),
    recoverStale: params.recoverStale === true,
  };
}

export function normalizeDragParams(params: DragParams = {}): NormalizedDragParams {
  return {
    source: normalizeTarget(
      params.source && typeof params.source === 'object'
        ? (params.source as { elementRef?: string; selector?: string })
        : undefined
    ),
    destination: normalizeTarget(
      params.destination && typeof params.destination === 'object'
        ? (params.destination as { elementRef?: string; selector?: string })
        : undefined
    ),
    offsetX: Number.isFinite(Number(params.offsetX)) ? Number(params.offsetX) : 0,
    offsetY: Number.isFinite(Number(params.offsetY)) ? Number(params.offsetY) : 0,
    executionMode: normalizeInputExecutionMode(params.executionMode),
    recoverStale: params.recoverStale === true,
  };
}

export function normalizeStorageParams(params: StorageParams = {}): NormalizedStorageParams {
  const keys = Array.isArray(params.keys)
    ? params.keys.filter((key) => typeof key === 'string')
    : null;
  if (keys && keys.length > 100) {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'keys must contain at most 100 strings.');
  }
  return {
    type: params.type === 'session' ? 'session' : 'local',
    keys,
  };
}

export function normalizeSensitiveReadParams(
  params: Record<string, unknown>
): NormalizedSensitiveReadParams {
  if (params?.source !== 'local_storage' && params?.source !== 'session_storage') {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'source must be local_storage or session_storage.'
    );
  }
  if (typeof params.key !== 'string') {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'key must be a string.');
  }
  if (params.key.length > 2_048) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'key must contain at most 2,048 characters.'
    );
  }
  return {
    source: params.source,
    key: params.key,
    maxBytes: MAX_SENSITIVE_VALUE_BYTES,
  };
}

export function normalizeWaitForLoadStateParams(
  params: WaitForLoadStateParams = {}
): NormalizedWaitForLoadStateParams {
  const url = typeof params.url === 'string' && params.url.length > 0 ? params.url : null;
  const requestedMatch = params.urlMatch ?? (url ? 'exact' : null);
  if (params.url !== undefined && params.url !== null && typeof params.url !== 'string') {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'url must be a string.');
  }
  if (params.urlMatch !== undefined && params.urlMatch !== null && !url) {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'url is required when urlMatch is set.');
  }
  if (
    requestedMatch !== null &&
    requestedMatch !== 'exact' &&
    requestedMatch !== 'contains' &&
    requestedMatch !== 'regex'
  ) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'urlMatch must be one of exact, contains, or regex.'
    );
  }
  if (url && url.length > 2_048) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'url condition must not exceed 2,048 characters.'
    );
  }
  if (requestedMatch === 'regex' && url) {
    validateSafeUrlRegex(url);
  }
  return {
    waitForLoad: params.waitForLoad !== false,
    timeoutMs: clampInt(params.timeoutMs, 500, 120_000, DEFAULT_NAV_TIMEOUT_MS),
    url,
    urlMatch: requestedMatch,
  };
}

/** URL waits accept a deliberately linear regular-expression subset. Patterns
may contain literals, escapes, anchors, dots, and character classes, but no
grouping, alternation, or quantifiers. With both pattern and input bounded,
the accepted subset cannot trigger backtracking through repeated matches. */
function validateSafeUrlRegex(pattern: string): void {
  if (pattern.length > 256) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'Regex URL condition must not exceed 256 characters.'
    );
  }
  let escaped = false;
  let inCharacterClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) {
      if (!inCharacterClass && /[1-9]/.test(character)) {
        throw new BridgeError(
          ERROR_CODES.INVALID_REQUEST,
          'Regex URL condition uses an unsupported backreference.'
        );
      }
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '[' && !inCharacterClass) {
      inCharacterClass = true;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (!inCharacterClass && '(){}*+?|'.includes(character)) {
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        'Regex URL condition uses unsupported grouping, alternation, or quantifiers.'
      );
    }
  }
  try {
    new RegExp(pattern);
  } catch {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'Regex URL condition is invalid.');
  }
}

export function normalizeTabCreateParams(params: TabCreateParams = {}): NormalizedTabCreateParams {
  const url =
    typeof params.url === 'string' && params.url.trim() ? params.url.trim() : 'about:blank';
  if (url !== 'about:blank') {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:', 'about:'].includes(parsed.protocol)) {
        throw new BridgeError(
          ERROR_CODES.INVALID_REQUEST,
          `Tab create blocked: unsupported protocol "${parsed.protocol}". Only http:, https:, and about: are allowed.`
        );
      }
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(ERROR_CODES.INVALID_REQUEST, `Invalid tab create URL: ${url}`);
    }
  }
  return {
    url,
    active: params.active === true,
  };
}

export function normalizeTabCloseParams(params: TabCloseParams = {}): NormalizedTabCloseParams {
  const tabId = Number(params.tabId);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'tabId is required for tabs.close.');
  }
  return { tabId };
}

export function normalizeAccessibilityTreeParams(
  params: AccessibilityTreeParams = {}
): NormalizedAccessibilityTreeParams {
  const source = params.source ?? 'cdp';
  if (source !== 'cdp' && source !== 'dom') {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'source must be cdp or dom.');
  }
  const format = params.format ?? (source === 'dom' ? 'outline' : 'tree');
  if (format !== 'tree' && format !== 'outline') {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'format must be tree or outline.');
  }
  return {
    selector:
      typeof params.selector === 'string' && params.selector.trim() ? params.selector.trim() : null,
    maxDepth: clampInt(params.maxDepth, 1, 20, DEFAULT_A11Y_MAX_DEPTH),
    maxNodes: clampInt(params.maxNodes, 10, 5000, DEFAULT_A11Y_MAX_NODES),
    // An outline of unnamed generic and none nodes says nothing, so outlines
    // are compact unless the caller opts out.
    compact: params.compact === true || (params.compact !== false && format === 'outline'),
    interactiveOnly: params.interactiveOnly === true,
    // Omitted at defaults so existing CDP callers see an unchanged shape.
    ...(source === 'dom' ? { source } : {}),
    ...(source === 'dom' || format === 'outline' ? { format } : {}),
  };
}

export function normalizeScreenshotParams(
  params: ScreenshotParams = {}
): NormalizedScreenshotParams {
  const format = params.format ?? 'png';
  if (format !== 'png' && format !== 'jpeg' && format !== 'webp') {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'format must be png, jpeg, or webp.');
  }
  const numericQuality = Number(params.quality);
  const delivery = params.delivery ?? 'inline';
  if (delivery !== 'auto' && delivery !== 'inline' && delivery !== 'artifact') {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'delivery must be auto, inline, or artifact.'
    );
  }
  return {
    format,
    quality:
      format === 'png' || params.quality === undefined
        ? null
        : Number.isFinite(numericQuality)
          ? Math.min(100, Math.max(0, Math.trunc(numericQuality)))
          : 80,
    delivery,
    scale:
      Number.isFinite(Number(params.scale)) && Number(params.scale) > 0
        ? clampNumber(Number(params.scale), 0.1, 4, 1)
        : 1,
  };
}

export function normalizeArtifactReadParams(
  params: ArtifactReadParams = {}
): NormalizedArtifactReadParams {
  return {
    artifactId: normalizeArtifactId(params.artifactId),
    offset: clampInt(params.offset, 0, MAX_ARTIFACT_BYTES, 0),
    maxBytes: clampInt(params.maxBytes, 1, ARTIFACT_CHUNK_BYTES, ARTIFACT_CHUNK_BYTES),
  };
}

export function normalizeArtifactDeleteParams(params: ArtifactDeleteParams = {}): {
  artifactId: string;
} {
  return { artifactId: normalizeArtifactId(params.artifactId) };
}

function normalizeArtifactId(value: unknown) {
  if (typeof value !== 'string' || !/^art_[A-Za-z0-9_-]{32,64}$/u.test(value)) {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'artifactId is invalid.');
  }
  return value;
}

export function normalizeNetworkParams(params: NetworkParams = {}): NormalizedNetworkParams {
  const source = params.source ?? 'fetch-xhr';
  if (source !== 'fetch-xhr' && source !== 'cdp') {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'source must be fetch-xhr or cdp.');
  }
  const capture = params.capture ?? 'read';
  if (capture !== 'read' && capture !== 'start' && capture !== 'clear' && capture !== 'stop') {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'capture must be read, start, clear, or stop.'
    );
  }
  if (source !== 'cdp' && params.capture !== undefined && params.capture !== 'read') {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'capture is only valid with source "cdp".');
  }
  return {
    clear: Boolean(params.clear),
    limit: clampInt(params.limit, 1, 500, DEFAULT_NETWORK_LIMIT),
    urlPattern:
      typeof params.urlPattern === 'string' && params.urlPattern.trim()
        ? params.urlPattern.trim()
        : null,
    source,
    capture,
  };
}

export function normalizeHarExportParams(
  params: HarExportParams | NormalizedHarExportParams = {}
): NormalizedHarExportParams {
  if (
    params.limit !== undefined &&
    (typeof params.limit !== 'number' ||
      !Number.isSafeInteger(params.limit) ||
      params.limit < 1 ||
      params.limit > MAX_HAR_ENTRIES)
  ) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      `limit must be an integer between 1 and ${MAX_HAR_ENTRIES}.`
    );
  }

  if (
    params.urlPattern !== undefined &&
    params.urlPattern !== null &&
    typeof params.urlPattern !== 'string'
  ) {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'urlPattern must be a string.');
  }
  const urlPattern = params.urlPattern?.trim() || null;
  if (urlPattern && urlPattern.length > 2_048) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'urlPattern must contain at most 2048 characters.'
    );
  }

  const delivery = params.delivery ?? 'auto';
  if (delivery !== 'auto' && delivery !== 'inline' && delivery !== 'artifact') {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'delivery must be auto, inline, or artifact.'
    );
  }

  return {
    limit: params.limit ?? DEFAULT_HAR_LIMIT,
    urlPattern,
    delivery,
  };
}

export function normalizeNetworkInterceptAddParams(
  params: NetworkInterceptAddParams = {}
): NormalizedNetworkInterceptAddParams {
  if (typeof params.urlPattern !== 'string' || !params.urlPattern) {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'urlPattern is required.');
  }
  if (params.urlPattern.length > MAX_INTERCEPT_URL_PATTERN_LENGTH) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      `urlPattern must not exceed ${MAX_INTERCEPT_URL_PATTERN_LENGTH} characters.`
    );
  }

  const action = params.action ?? DEFAULT_NETWORK_INTERCEPT_ACTION;
  if (action !== 'fulfill' && action !== 'continue' && action !== 'block') {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'action must be one of fulfill, continue, or block.'
    );
  }
  if (
    params.statusCode !== undefined &&
    (!Number.isInteger(params.statusCode) || params.statusCode < 100 || params.statusCode > 599)
  ) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'statusCode must be an integer between 100 and 599.'
    );
  }
  if (params.body !== undefined && typeof params.body !== 'string') {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'body must be a string.');
  }
  if (
    typeof params.body === 'string' &&
    new TextEncoder().encode(params.body).byteLength > MAX_INTERCEPT_BODY_BYTES
  ) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      `body must not exceed ${MAX_INTERCEPT_BODY_BYTES} UTF-8 bytes.`
    );
  }

  let headers: Record<string, string> | undefined;
  if (params.headers !== undefined) {
    if (!isPlainRecord(params.headers)) {
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        'headers must be an object containing string values.'
      );
    }
    const entries = Object.entries(params.headers);
    if (entries.length > MAX_INTERCEPT_HEADERS) {
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        `headers must contain at most ${MAX_INTERCEPT_HEADERS} entries.`
      );
    }
    headers = {};
    let headerBytes = 0;
    for (const [name, value] of entries) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
        throw new BridgeError(
          ERROR_CODES.INVALID_REQUEST,
          `Invalid header name: ${name || '(empty)'}.`
        );
      }
      if (typeof value !== 'string' || /[\r\n]/.test(value)) {
        throw new BridgeError(
          ERROR_CODES.INVALID_REQUEST,
          `Header ${name} must have a string value without newlines.`
        );
      }
      const valueBytes = new TextEncoder().encode(value).byteLength;
      if (valueBytes > MAX_INTERCEPT_HEADER_VALUE_BYTES) {
        throw new BridgeError(
          ERROR_CODES.INVALID_REQUEST,
          `Header ${name} must not exceed ${MAX_INTERCEPT_HEADER_VALUE_BYTES} UTF-8 bytes.`
        );
      }
      headerBytes += new TextEncoder().encode(name).byteLength + valueBytes;
      if (headerBytes > MAX_INTERCEPT_HEADER_BYTES) {
        throw new BridgeError(
          ERROR_CODES.INVALID_REQUEST,
          `headers must not exceed ${MAX_INTERCEPT_HEADER_BYTES} UTF-8 bytes in total.`
        );
      }
      headers[name] = value;
    }
  }

  return {
    urlPattern: params.urlPattern,
    action,
    ...(params.statusCode === undefined ? {} : { statusCode: params.statusCode }),
    ...(params.body === undefined ? {} : { body: params.body }),
    ...(headers === undefined ? {} : { headers }),
  };
}

export function normalizePageTextParams(params: PageTextParams = {}): NormalizedPageTextParams {
  return {
    textBudget: clampInt(params.textBudget, 100, 100_000, DEFAULT_PAGE_TEXT_BUDGET),
  };
}

export function normalizeExtractContentParams(
  params: ExtractContentParams = {}
): NormalizedExtractContentParams {
  const format = params.format ?? 'text';
  if (format !== 'text' && format !== 'markdown') {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'format must be text or markdown.');
  }
  const consistency = params.consistency ?? 'best_effort';
  if (consistency !== 'best_effort' && consistency !== 'settled') {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'consistency must be best_effort or settled.'
    );
  }
  const selector = typeof params.selector === 'string' ? params.selector.trim() : '';
  if (selector.length > 2048) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'selector must not exceed 2,048 characters.'
    );
  }
  return {
    format,
    selector: selector || null,
    includeMetadata: params.includeMetadata !== false,
    consistency,
    textBudget: clampInt(params.textBudget, 100, 100_000, DEFAULT_PAGE_TEXT_BUDGET),
    settleTimeoutMs: clampInt(
      params.settleTimeoutMs,
      100,
      MAX_EXTRACT_SETTLE_TIMEOUT_MS,
      DEFAULT_EXTRACT_SETTLE_TIMEOUT_MS
    ),
  };
}

export function normalizeLogTailParams(params: LogTailParams = {}): NormalizedLogTailParams {
  return {
    limit: clampInt(params.limit, 1, 200, DEFAULT_LOG_TAIL_LIMIT),
  };
}

export function normalizeHealthPingParams(
  params: HealthPingParams = {}
): NormalizedHealthPingParams {
  if (params.diagnostics !== undefined && typeof params.diagnostics !== 'boolean') {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'diagnostics must be a boolean.');
  }
  return { diagnostics: params.diagnostics === true };
}

export function normalizeViewportResizeParams(
  params: ViewportResizeParams = {}
): NormalizedViewportResizeParams {
  return {
    width: clampInt(params.width, 320, 7680, DEFAULT_VIEWPORT_WIDTH),
    height: clampInt(params.height, 200, 4320, DEFAULT_VIEWPORT_HEIGHT),
    deviceScaleFactor: clampNumber(params.deviceScaleFactor, 0, 4, DEFAULT_DEVICE_SCALE_FACTOR),
    reset: Boolean(params.reset),
  };
}

export function createRuntimeContext(): {
  v: string;
  budgets: Record<string, { n: number; d: number; t: number }>;
  methods: Record<string, string[]>;
  errors: Record<string, string>;
  tips: string[];
  flow: BridgeMethod[];
  limits: Record<string, { min: number; max: number; default: number }>;
} {
  const methodGroups = createBridgeMethodGroups();

  return {
    v: getProtocolVersion(),
    budgets: {
      quick: {
        n: BUDGET_PRESETS.quick.maxNodes,
        d: BUDGET_PRESETS.quick.maxDepth,
        t: BUDGET_PRESETS.quick.textBudget,
      },
      normal: {
        n: BUDGET_PRESETS.normal.maxNodes,
        d: BUDGET_PRESETS.normal.maxDepth,
        t: BUDGET_PRESETS.normal.textBudget,
      },
      deep: {
        n: BUDGET_PRESETS.deep.maxNodes,
        d: BUDGET_PRESETS.deep.maxDepth,
        t: BUDGET_PRESETS.deep.textBudget,
      },
    },
    methods: methodGroups,
    errors: {
      ACCESS_DENIED:
        'Browser Bridge is off for this window or the page is restricted; if access is off, the first denied call surfaces an Enable cue in the extension UI',
      TAB_MISMATCH: 'Tab closed or not found',
      ELEMENT_STALE: 'Element removed from DOM - re-query',
      ELEMENT_AMBIGUOUS: 'Input selector matched equally actionable elements - narrow selector',
      ELEMENT_NOT_ACTIONABLE: 'Input target is hidden, disabled, inert, or not rendered',
      ELEMENT_OBSCURED: 'Pointer target is blocked by an unrelated element',
      ELEMENT_NOT_FOUND: 'Input selector did not match an element',
      DOM_BASELINE_NOT_FOUND: 'DOM baseline is missing, expired, or released',
      DOM_BASELINE_INVALIDATED: 'DOM baseline belongs to a different document or scope',
      DOM_BASELINE_QUOTA_EXCEEDED: 'DOM baseline retention quota was exceeded',
      INPUT_UNSUPPORTED: 'Execution mode does not support this input operation',
      INPUT_INVALID_TARGET: 'Input target is incompatible with the requested operation',
      INPUT_FOCUS_CHANGED: 'Focus moved before native text dispatch',
      DIALOG_BLOCKED:
        'Native JavaScript dialog blocked the operation; inspect before responding, never automatically replay',
      DIALOG_NOT_OPEN: 'No JavaScript dialog is currently observable',
      INVALID_REQUEST: 'Malformed method or params',
      TIMEOUT: 'Operation exceeded time limit',
      CONTENT_SCRIPT_UNAVAILABLE: 'Page is restricted or cannot host the content script',
      INTERNAL_ERROR: 'Unexpected extension error',
      EXTENSION_DISCONNECTED: 'Extension not connected to daemon - check Chrome',
    },
    tips: [
      'For known actions use a semantic input target directly; inspect only when new evidence is needed',
      'For scoped DOM inspection start with a quick budget; widen only if truncated',
      "Reuse elementRef; don't re-query",
      'Set attributeAllowlist for focused DOM reads',
      'Use dom.baseline.create / compare for bounded semantic DOM change detection; release when done',
      'Only when DOM diffs cannot verify CSS, canvas, charts or visual regressions: opt in to screenshot.baseline.create with one complete component selector or viewport rect, compare after the action, then release. Useful local changes return context-expanded crops; unchanged, diff_not_useful and not_comparable return no images by default. Do not poll or replay an action for an unhelpful diff: inspect DOM/state or narrow the scope. fallback=current explicitly permits one current full scoped image, never a full before/after pair. Suppressed diffs never advance the reference; geometry changes require a new baseline. Visual differences do not verify application success.',
      'patch.apply_styles before patch.apply_dom',
      'Verify with get_box_model not screenshots',
      'batch independent reads',
      'Use input.perform for known authorized multi-step flows; returnLastResult: true returns the final action or read in the same call. Stop for decisions that require new evidence; never blindly replay a partially completed flow',
      'Input targets accept role/name or label locators and auto-wait for actionability; skip separate find and pre-action wait calls when the target is known',
      'Read action effects before requesting more page data; sequence steps observe only with explicit observe: true',
      'Rollback all patches before finishing',
      'page.evaluate to read framework state (React, Vue, Next.js data)',
      'dom.find_by_text / dom.find_by_role for semantic element finding',
      'dom.get_accessibility_tree with source: "dom" for compact interactive discovery without the debugger',
      'If a tab-bound call returns ACCESS_DENIED because access is off, ask the user to click Enable in the Browser Bridge popup or side panel, then retry once',
      'dom.wait_for after HMR / navigation to detect page updates',
      'page.get_console to catch runtime errors after interactions',
      'page.get_network for fetch/XHR reads or explicit all-resource CDP capture',
      'page.get_text for full-page content extraction',
      'input.hover before screenshot to inspect hover states',
      'performance.get_metrics returns raw Chrome/CDP counters whose names and units vary; it is a point sample with no BBX navigation window or LCP/CLS/INP measurement',
      'viewport.resize to test responsive layouts',
      'Prefer screenshot.capture_element, or a tight screenshot.capture_region when element capture cannot express the needed area',
      'page.get_storage reads localStorage/sessionStorage without evaluate',
    ],
    flow: [
      'health.ping',
      'page.get_state',
      'dom.query',
      'styles.get_computed',
      'patch.apply_styles',
      'layout.get_box_model',
      'page.get_console',
      'patch.rollback',
    ],
    limits: {
      maxNodes: { min: 1, max: 250, default: DEFAULT_MAX_NODES },
      maxDepth: { min: 1, max: 20, default: DEFAULT_MAX_DEPTH },
      textBudget: { min: 32, max: 10000, default: DEFAULT_TEXT_BUDGET },
      evalTimeout: { min: 100, max: 30000, default: DEFAULT_EVAL_TIMEOUT_MS },
      navTimeout: { min: 500, max: 120000, default: DEFAULT_NAV_TIMEOUT_MS },
      waitTimeout: { min: 100, max: 30000, default: DEFAULT_WAIT_TIMEOUT_MS },
      maxHtmlLength: { min: 32, max: 50000, default: DEFAULT_MAX_HTML_LENGTH },
      a11yMaxNodes: { min: 10, max: 5000, default: DEFAULT_A11Y_MAX_NODES },
      networkLimit: { min: 1, max: 500, default: DEFAULT_NETWORK_LIMIT },
      harLimit: { min: 1, max: MAX_HAR_ENTRIES, default: DEFAULT_HAR_LIMIT },
      consoleLimit: { min: 1, max: 200, default: DEFAULT_CONSOLE_LIMIT },
      pageTextBudget: {
        min: 100,
        max: 100000,
        default: DEFAULT_PAGE_TEXT_BUDGET,
      },
      baselineMaxNodes: { min: 1, max: 1000, default: 100 },
      baselineMaxDepth: { min: 1, max: 20, default: 8 },
      baselineTextBudget: { min: 32, max: 1000, default: 160 },
      baselineMaxChanges: { min: 1, max: 200, default: 50 },
    },
  };
}
