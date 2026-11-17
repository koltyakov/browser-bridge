import {
  BridgeError,
  ERROR_CODES,
  BRIDGE_METHOD_REGISTRY,
  isBridgeMethod,
} from '../../../protocol/src/index.js';
import type {
  BridgeRequest,
  RuntimeCapabilitiesParams,
  RuntimeCapabilitiesResult,
  RuntimeCapability,
  RuntimeCapabilityCall,
  InputExecutionMode,
} from '../../../protocol/src/types.js';
import { isRestrictedAutomationUrl } from './background-routing.js';
import { isTabBoundMethod } from './background-tab-bound.js';
import {
  NATIVE_INPUT_METHODS,
  requiresNativeKeyboard,
  requiresNativePointer,
} from './background-helpers.js';
import type { ResolvedTabTarget } from './background-routing.js';
import type { AccessSettingsSnapshot } from '../../../protocol/src/types.js';
import { isNavigationAllowed } from './access-settings.js';

export type CapabilityProbe = { webmcp: boolean };

export type CapabilityDependencies = {
  resolveTarget: (request: BridgeRequest) => Promise<ResolvedTabTarget>;
  captureAccess: () => (tab: ResolvedTabTarget) => void;
  assertActive: () => void;
  getTab: (tabId: number) => Promise<Pick<chrome.tabs.Tab, 'active' | 'windowId' | 'url'>>;
  probeFrame: (tabId: number, frameId: number) => Promise<CapabilityProbe>;
  settings: () => AccessSettingsSnapshot;
  ownsTab: (tabId: number) => boolean;
  debuggerReason: (tabId: number) => string | null;
  downloadsAvailable: boolean;
};

function mode(value: unknown): InputExecutionMode {
  if (value === undefined) return 'dom';
  if (value === 'dom' || value === 'cdp' || value === 'auto') return value;
  throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'executionMode must be dom, cdp, or auto.');
}

export function normalizeCapabilityParams(
  params: Record<string, unknown>
): RuntimeCapabilitiesParams {
  const calls = params.calls;
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 32)
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'calls must contain 1..32 RPCs.');
  const frameId = params.frameId === undefined ? 0 : params.frameId;
  if (!Number.isSafeInteger(frameId) || Number(frameId) < 0)
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'frameId must be a nonnegative safe integer.'
    );
  const normalized: RuntimeCapabilityCall[] = calls.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'Each call must be an RPC object.');
    const call = value as Record<string, unknown>;
    if (typeof call.method !== 'string' || !isBridgeMethod(call.method))
      throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'Each call must name a known RPC.');
    if (
      call.params !== undefined &&
      (!call.params || typeof call.params !== 'object' || Array.isArray(call.params))
    )
      throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'call.params must be an object.');
    const callParams = (call.params ?? {}) as Record<string, unknown>;
    if (callParams.executionMode !== undefined) mode(callParams.executionMode);
    return { method: call.method, params: callParams };
  });
  return { calls: normalized, frameId: Number(frameId), executionMode: mode(params.executionMode) };
}

/** A read-only eligibility snapshot, never an authorization token or a promise
 * of target actionability. Do not inject content modules or attach the debugger. */
export async function discoverRuntimeCapabilities(
  request: BridgeRequest,
  dependencies: CapabilityDependencies
): Promise<RuntimeCapabilitiesResult> {
  const params = normalizeCapabilityParams(request.params);
  const frameId = params.frameId ?? 0;
  const settings = dependencies.settings();
  const result: RuntimeCapabilitiesResult = {
    advisory: true,
    checkedAt: Date.now(),
    tabId: request.tab_id,
    frameId,
    active: null,
    grant: {
      status: 'denied',
      reason: 'access_unavailable',
      settingsRevision: settings.settingsRevision,
    },
    operations: [],
  };
  const operations = (status: RuntimeCapability['status'], reason: string) =>
    params.calls.map((call): RuntimeCapability => ({
      method: call.method,
      executionMode: call.method.startsWith('cdp.')
        ? 'cdp'
        : mode(call.params?.executionMode ?? params.executionMode),
      status,
      reason,
    }));
  const assertGrant = dependencies.captureAccess();
  let tab: ResolvedTabTarget;
  let active: boolean;
  let restricted = false;
  try {
    dependencies.assertActive();
    tab = await dependencies.resolveTarget(request);
    dependencies.assertActive();
    assertGrant(tab);
    const current = await dependencies.getTab(tab.tabId);
    dependencies.assertActive();
    assertGrant(tab);
    if (current.windowId !== tab.windowId)
      throw new BridgeError(ERROR_CODES.ACCESS_DENIED, 'Target moved.', {
        reason: 'tab_outside_access_scope',
      });
    if (dependencies.settings().settingsRevision !== settings.settingsRevision)
      throw new BridgeError(ERROR_CODES.ACCESS_DENIED, 'Settings changed.', {
        reason: 'access_settings_changed',
      });
    restricted = isRestrictedAutomationUrl(current.url ?? tab.url);
    tab = { ...tab, url: current.url ?? tab.url };
    active = current.active === true;
  } catch (error) {
    dependencies.assertActive();
    const details =
      error instanceof BridgeError ? (error.details as Record<string, unknown> | null) : null;
    const reason =
      typeof details?.reason === 'string'
        ? details.reason
        : error instanceof BridgeError
          ? error.code.toLowerCase()
          : 'target_unavailable';
    result.grant.reason = reason;
    result.operations = operations('unavailable', reason);
    return result;
  }
  let probe: CapabilityProbe | null = null;
  let probeReason = 'frame_probe_failed';
  try {
    assertGrant(tab);
    if (!restricted) probe = await dependencies.probeFrame(tab.tabId, frameId);
  } catch {
    // A probe failure is not proof that a frame or browser feature is absent.
  }
  try {
    dependencies.assertActive();
    assertGrant(tab);
    if (dependencies.settings().settingsRevision !== settings.settingsRevision)
      throw new BridgeError(ERROR_CODES.ACCESS_DENIED, 'Settings changed.', {
        reason: 'access_settings_changed',
      });
  } catch (error) {
    dependencies.assertActive();
    const details =
      error instanceof BridgeError ? (error.details as Record<string, unknown> | null) : null;
    probeReason = typeof details?.reason === 'string' ? details.reason : 'window_access_changed';
    result.grant.reason = probeReason;
    result.operations = operations('unavailable', probeReason);
    return result;
  }
  result.tabId = tab.tabId;
  result.active = active;
  result.grant = { ...result.grant, status: 'granted', reason: 'enabled' };
  result.operations = params.calls.map((call): RuntimeCapability => {
    const method = call.method;
    const raw = call.params ?? {};
    // Match input normalization before checking option-dependent native flows.
    const args: Record<string, unknown> = {
      ...raw,
      clear: Boolean(raw.clear),
      submit: Boolean(raw.submit),
    };
    const executionMode = method.startsWith('cdp.')
      ? 'cdp'
      : mode(args.executionMode ?? params.executionMode);
    const entry = BRIDGE_METHOD_REGISTRY[method];
    const answer = (status: RuntimeCapability['status'], reason: string): RuntimeCapability => ({
      method,
      executionMode,
      status,
      reason,
    });
    if (!entry.tab && !method.startsWith('tabs.')) return answer('unknown', 'not_tab_scoped');
    if (restricted && !method.startsWith('tabs.') && !method.startsWith('navigation.'))
      return answer('unavailable', 'restricted_page');
    const contentInput = method.startsWith('input.') && isTabBoundMethod(method);
    const contentFrame =
      (isTabBoundMethod(method) &&
        method !== 'page.get_state' &&
        (!method.startsWith('screenshot.') || method === 'screenshot.capture_element')) ||
      (method === 'dom.get_accessibility_tree' && args.source === 'dom');
    if (frameId !== 0 && !contentFrame) return answer('unavailable', 'top_frame_only');
    if (contentInput && executionMode === 'cdp') {
      if (!NATIVE_INPUT_METHODS.has(method))
        return answer('unavailable', 'native_method_unsupported');
      if (frameId !== 0) return answer('unavailable', 'native_iframe_unsupported');
    }
    if (executionMode === 'cdp' || method.startsWith('cdp.')) {
      if (!active && requiresNativeKeyboard(method, args))
        return answer('unavailable', 'inactive_native_keyboard_target');
      if (!active && requiresNativePointer(method))
        return answer('unavailable', 'inactive_native_pointer_target');
    }
    if (method === 'tabs.create' && !settings.settings.allowCreatingTabs)
      return answer('unavailable', 'allowCreatingTabs_disabled');
    if (method === 'tabs.close' && !settings.settings.allowClosingUserTabs) {
      if (typeof args.tabId !== 'number') return answer('unknown', 'close_target_required');
      if (args.tabId !== tab.tabId) return answer('unknown', 'different_target_requires_discovery');
      if (!dependencies.ownsTab(args.tabId))
        return answer('unavailable', 'allowClosingUserTabs_disabled');
    }
    if (method === 'navigation.navigate' && !settings.settings.allowOffDomainNavigation) {
      if (typeof args.url !== 'string') return answer('unknown', 'navigation_url_required');
      try {
        if (!isNavigationAllowed(tab.url, args.url, settings.settings.allowOffDomainNavigation))
          return answer('unavailable', 'allowOffDomainNavigation_disabled');
      } catch {
        return answer('unknown', 'navigation_url_invalid');
      }
    }
    const native = method.startsWith('cdp.') || (contentInput && executionMode === 'cdp');
    const needsDebugger =
      native ||
      (entry.debuggerBacked &&
        !method.startsWith('input.') &&
        !(method === 'dom.get_accessibility_tree' && args.source === 'dom'));
    if (needsDebugger) {
      const reason = dependencies.debuggerReason(tab.tabId);
      if (reason) return answer('unavailable', reason);
    }
    if (!probe && !method.startsWith('tabs.') && !method.startsWith('navigation.'))
      return answer('unknown', probeReason);
    if (method.startsWith('webmcp.') && !probe?.webmcp)
      return answer('unavailable', 'webmcp_unavailable');
    if (
      method.startsWith('download.') &&
      method !== 'download.resource' &&
      !dependencies.downloadsAvailable
    )
      return answer('unavailable', 'downloads_api_unavailable');
    if (method === 'input.perform') return answer('unknown', 'sequence_requires_per_step_checks');
    if (
      method.startsWith('files.') ||
      method.startsWith('session.') ||
      method.startsWith('download.') ||
      method === 'input.set_files' ||
      method === 'input.paste_image'
    )
      return answer('unknown', 'operation_requires_resource_checks');
    if (contentInput && executionMode === 'auto' && frameId === 0)
      return answer('unknown', 'auto_mode_requires_target_inspection');
    return answer('available', 'eligible_dispatch_checks_required');
  });
  return result;
}
