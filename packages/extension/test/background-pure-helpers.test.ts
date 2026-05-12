import test from 'node:test';
import assert from 'node:assert/strict';

import { loadBackground } from '../../../tests/_helpers/loadBackground.ts';
import type { LoadedBackground } from '../../../tests/_helpers/loadBackground.ts';
import type { BridgeRequest, BridgeResponse } from '../../protocol/src/types.js';
import {
  BridgeError,
  createRequest,
  createSuccess,
  ERROR_CODES,
  MAX_NATIVE_MESSAGE_BYTES,
} from '../../protocol/src/index.js';

type AccessPopupPlacement = { left: number; top: number } | null;
type SetupAction = { action: string; kind: string; target: string };
type PureHelperModule = {
  isNumber: (value: unknown) => boolean;
  getContentScriptTimeout: (method: string, params: Record<string, unknown>) => number;
  isRecoverableInstrumentationError: (error: unknown) => boolean;
  isRestrictedScriptingError: (error: unknown) => boolean;
  getRequestedAccessPopupPlacement: (
    windowId: number,
    popupWidth: number
  ) => Promise<AccessPopupPlacement>;
  reportAsyncError: (error: unknown) => void;
  toFailureResponse: (request: BridgeRequest, error: unknown) => BridgeResponse;
  enrichBridgeResponse: (request: BridgeRequest, response: BridgeResponse) => BridgeResponse;
  getSetupInstallKey: (action: SetupAction) => string;
  getSetupActionMethodLabel: (action: SetupAction) => string;
  getSetupActionTargetLabel: (action: SetupAction) => string;
  getSetupActionStartSummary: (action: SetupAction) => string;
  getSetupActionSuccessSummary: (action: SetupAction) => string;
  getSetupActionErrorSummary: (action: SetupAction, message: string) => string;
};
type WindowsApi = { get: (windowId: number) => Promise<Record<string, unknown>> };

let loaded: LoadedBackground;

function module(): PureHelperModule {
  return loaded.module as unknown as PureHelperModule;
}

function windowsApi(): WindowsApi {
  return (loaded.chrome as Record<string, unknown>).windows as WindowsApi;
}

test.before(async () => {
  loaded = await loadBackground({
    query: `test-background-pure-helpers-${Date.now()}`,
  });
});

test('background pure helpers classify numbers and content-script timeouts', () => {
  const { isNumber, getContentScriptTimeout } = module();

  assert.equal(isNumber(0), true);
  assert.equal(isNumber(42.5), true);
  assert.equal(isNumber(Number.NaN), false);
  assert.equal(isNumber(Number.POSITIVE_INFINITY), false);
  assert.equal(isNumber('42'), false);
  assert.equal(isNumber(null), false);

  assert.equal(getContentScriptTimeout('dom.wait_for', { timeoutMs: 50 }), 2_100);
  assert.equal(getContentScriptTimeout('input.hover', { duration: 7_500 }), 11_000);
  assert.equal(getContentScriptTimeout('dom.query', {}), 5_000);
});

test('background pure helpers recognize recoverable and restricted scripting errors', () => {
  const { isRecoverableInstrumentationError, isRestrictedScriptingError } = module();

  assert.equal(isRecoverableInstrumentationError(new Error('No tab with id: 7.')), true);
  assert.equal(isRecoverableInstrumentationError(new Error('Cannot attach to this target')), true);
  assert.equal(isRecoverableInstrumentationError(new Error('boom')), false);

  assert.equal(isRestrictedScriptingError('Cannot access contents of the page.'), true);
  assert.equal(isRestrictedScriptingError('Cannot script this page.'), true);
  assert.equal(isRestrictedScriptingError('Something unrelated failed.'), false);
});

test('background pure helpers position access popups when window bounds are available', async () => {
  const windows = windowsApi();
  const originalGetWindow = windows.get;

  try {
    windows.get = async () => ({
      left: 100,
      top: 20,
      width: 1_200,
    });
    assert.deepEqual(await module().getRequestedAccessPopupPlacement(7, 420), {
      left: 840,
      top: 92,
    });

    windows.get = async () => ({
      left: 40,
      top: 10,
      width: 300,
    });
    assert.deepEqual(await module().getRequestedAccessPopupPlacement(7, 420), {
      left: 64,
      top: 82,
    });

    windows.get = async () => ({ id: 7 });
    assert.equal(await module().getRequestedAccessPopupPlacement(7, 420), null);

    windows.get = async () => {
      throw new Error('window missing');
    };
    assert.equal(await module().getRequestedAccessPopupPlacement(7, 420), null);
  } finally {
    windows.get = originalGetWindow;
  }
});

test('background pure helpers only log unexpected async errors', () => {
  const captured: unknown[] = [];
  const originalConsoleError = console.error;

  console.error = (...args: unknown[]) => {
    captured.push(args[0]);
  };

  try {
    module().reportAsyncError(new Error('No tab with id: 7.'));

    const boom = new Error('boom');
    module().reportAsyncError(boom);

    assert.deepEqual(captured, [boom]);
  } finally {
    console.error = originalConsoleError;
  }
});

test('background pure helpers map thrown values to structured failures', () => {
  const request = createRequest({
    id: 'req-failure',
    method: 'page.evaluate',
  });

  const staleResponse = module().toFailureResponse(
    request,
    new Error('Element reference is stale.')
  );
  assert.equal(staleResponse.ok, false);
  assert.equal(staleResponse.error.code, ERROR_CODES.ELEMENT_STALE);
  assert.equal(staleResponse.error.message, 'Element reference is stale.');
  assert.equal(staleResponse.meta.method, 'page.evaluate');

  const objectResponse = module().toFailureResponse(request, { code: 'mystery' });
  assert.equal(objectResponse.ok, false);
  assert.equal(objectResponse.error.code, ERROR_CODES.INTERNAL_ERROR);
  assert.equal(objectResponse.error.message, 'Unexpected extension error.');

  const codeResponse = module().toFailureResponse(request, ERROR_CODES.ACCESS_DENIED);
  assert.equal(codeResponse.ok, false);
  assert.equal(codeResponse.error.code, ERROR_CODES.ACCESS_DENIED);
  assert.equal(codeResponse.error.message, ERROR_CODES.ACCESS_DENIED);
});

test('background pure helpers extract code and details from BridgeError in toFailureResponse', () => {
  const request = createRequest({
    id: 'req-bridge-error',
    method: 'dom.query',
  });

  const bridgeErr = new BridgeError(ERROR_CODES.ACCESS_DENIED, 'No window enabled', {
    retry: true,
  });
  const response = module().toFailureResponse(request, bridgeErr);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.ACCESS_DENIED);
  assert.equal(response.error.message, 'No window enabled');
  assert.deepEqual(response.error.details, { retry: true });
  assert.equal(response.meta.method, 'dom.query');
});

test('background pure helpers preserve response metadata while enriching diagnostics', () => {
  const request = createRequest({
    id: 'req-success',
    method: 'health.ping',
  });
  const response = createSuccess(
    request.id,
    { value: 'ok' },
    { method: 'health.ping', custom: 'kept' }
  );

  const enriched = module().enrichBridgeResponse(request, response);

  assert.equal(enriched.ok, true);
  assert.deepEqual(enriched.result, { value: 'ok' });
  assert.equal(enriched.meta.method, 'health.ping');
  assert.equal(enriched.meta.custom, 'kept');
  assert.equal(typeof enriched.meta.transport_bytes, 'number');
  assert.equal(typeof enriched.meta.transport_approx_tokens, 'number');
  assert.equal(typeof enriched.meta.text_bytes, 'number');
  assert.equal(typeof enriched.meta.image_bytes, 'number');
  assert.equal(typeof enriched.meta.debugger_backed, 'boolean');
});

test('background pure helpers reject responses above the native messaging size limit', () => {
  const request = createRequest({
    id: 'req-huge',
    method: 'page.evaluate',
  });
  const response = createSuccess(request.id, {
    value: 'x'.repeat(MAX_NATIVE_MESSAGE_BYTES),
  });

  const enriched = module().enrichBridgeResponse(request, response);

  assert.equal(enriched.ok, false);
  assert.equal(enriched.error.code, ERROR_CODES.RESULT_TRUNCATED);
  assert.equal(enriched.meta.budget_truncated, true);
});

test('background pure helpers summarize setup actions for install and uninstall flows', () => {
  const installMcp = {
    action: 'install',
    kind: 'mcp',
    target: 'cursor',
  };
  const uninstallSkill = {
    action: 'uninstall',
    kind: 'skill',
    target: 'opencode',
  };

  assert.equal(module().getSetupInstallKey(installMcp), 'mcp:cursor');
  assert.equal(module().getSetupInstallKey(uninstallSkill), 'skill:opencode');

  assert.equal(module().getSetupActionMethodLabel(installMcp), 'Host setup: MCP');
  assert.equal(module().getSetupActionMethodLabel(uninstallSkill), 'Host setup: Skills');
  assert.equal(module().getSetupActionTargetLabel(installMcp), 'cursor');
  assert.equal(module().getSetupActionTargetLabel(uninstallSkill), 'opencode');

  assert.equal(module().getSetupActionStartSummary(installMcp), 'Installing MCP for cursor\u2026');
  assert.equal(module().getSetupActionSuccessSummary(installMcp), 'Installed MCP for cursor.');
  assert.equal(
    module().getSetupActionErrorSummary(installMcp, 'permission denied'),
    'Install failed for MCP on cursor: permission denied'
  );

  assert.equal(
    module().getSetupActionStartSummary(uninstallSkill),
    'Removing SKILL for opencode\u2026'
  );
  assert.equal(
    module().getSetupActionSuccessSummary(uninstallSkill),
    'Removed SKILL for opencode.'
  );
  assert.equal(
    module().getSetupActionErrorSummary(uninstallSkill, 'timed out'),
    'Removal failed for SKILL on opencode: timed out'
  );
});
