// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadBackground } from '../../../tests/_helpers/loadBackground.js';
import { createRequest, createSuccess, ERROR_CODES } from '../../protocol/src/index.js';

/** @type {Awaited<ReturnType<typeof loadBackground>>} */
let loaded;

test.before(async () => {
  loaded = await loadBackground({
    query: `test-background-pure-helpers-${Date.now()}`,
  });
});

test('background pure helpers classify numbers and content-script timeouts', () => {
  const { isNumber, getContentScriptTimeout } = loaded.module;

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
  const { isRecoverableInstrumentationError, isRestrictedScriptingError } = loaded.module;

  assert.equal(isRecoverableInstrumentationError(new Error('No tab with id: 7.')), true);
  assert.equal(isRecoverableInstrumentationError(new Error('Cannot attach to this target')), true);
  assert.equal(isRecoverableInstrumentationError(new Error('boom')), false);

  assert.equal(isRestrictedScriptingError('Cannot access contents of the page.'), true);
  assert.equal(isRestrictedScriptingError('Cannot script this page.'), true);
  assert.equal(isRestrictedScriptingError('Something unrelated failed.'), false);
});

test('background pure helpers position access popups when window bounds are available', async () => {
  const originalGetWindow = loaded.chrome.windows.get;

  try {
    loaded.chrome.windows.get = async () => ({
      left: 100,
      top: 20,
      width: 1_200,
    });
    assert.deepEqual(await loaded.module.getRequestedAccessPopupPlacement(7, 420), {
      left: 840,
      top: 92,
    });

    loaded.chrome.windows.get = async () => ({
      left: 40,
      top: 10,
      width: 300,
    });
    assert.deepEqual(await loaded.module.getRequestedAccessPopupPlacement(7, 420), {
      left: 64,
      top: 82,
    });

    loaded.chrome.windows.get = async () => ({ id: 7 });
    assert.equal(await loaded.module.getRequestedAccessPopupPlacement(7, 420), null);

    loaded.chrome.windows.get = async () => {
      throw new Error('window missing');
    };
    assert.equal(await loaded.module.getRequestedAccessPopupPlacement(7, 420), null);
  } finally {
    loaded.chrome.windows.get = originalGetWindow;
  }
});

test('background pure helpers only log unexpected async errors', () => {
  /** @type {unknown[]} */
  const captured = [];
  const originalConsoleError = console.error;

  console.error = /** @type {typeof console.error} */ (
    (...args) => {
      captured.push(args[0]);
    }
  );

  try {
    loaded.module.reportAsyncError(new Error('No tab with id: 7.'));

    const boom = new Error('boom');
    loaded.module.reportAsyncError(boom);

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

  const staleResponse = loaded.module.toFailureResponse(
    request,
    new Error('Element reference is stale.')
  );
  assert.equal(staleResponse.ok, false);
  assert.equal(staleResponse.error.code, ERROR_CODES.ELEMENT_STALE);
  assert.equal(staleResponse.error.message, 'Element reference is stale.');
  assert.equal(staleResponse.meta.method, 'page.evaluate');

  const objectResponse = loaded.module.toFailureResponse(request, { code: 'mystery' });
  assert.equal(objectResponse.ok, false);
  assert.equal(objectResponse.error.code, ERROR_CODES.INTERNAL_ERROR);
  assert.equal(objectResponse.error.message, 'Unexpected extension error.');

  const codeResponse = loaded.module.toFailureResponse(request, ERROR_CODES.ACCESS_DENIED);
  assert.equal(codeResponse.ok, false);
  assert.equal(codeResponse.error.code, ERROR_CODES.ACCESS_DENIED);
  assert.equal(codeResponse.error.message, ERROR_CODES.ACCESS_DENIED);
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

  const enriched = loaded.module.enrichBridgeResponse(request, response);

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

  assert.equal(loaded.module.getSetupInstallKey(installMcp), 'mcp:cursor');
  assert.equal(loaded.module.getSetupInstallKey(uninstallSkill), 'skill:opencode');

  assert.equal(loaded.module.getSetupActionMethodLabel(installMcp), 'Host setup: MCP');
  assert.equal(loaded.module.getSetupActionMethodLabel(uninstallSkill), 'Host setup: Skills');
  assert.equal(loaded.module.getSetupActionTargetLabel(installMcp), 'cursor');
  assert.equal(loaded.module.getSetupActionTargetLabel(uninstallSkill), 'opencode');

  assert.equal(
    loaded.module.getSetupActionStartSummary(installMcp),
    'Installing MCP for cursor\u2026'
  );
  assert.equal(loaded.module.getSetupActionSuccessSummary(installMcp), 'Installed MCP for cursor.');
  assert.equal(
    loaded.module.getSetupActionErrorSummary(installMcp, 'permission denied'),
    'Install failed for MCP on cursor: permission denied'
  );

  assert.equal(
    loaded.module.getSetupActionStartSummary(uninstallSkill),
    'Removing SKILL for opencode\u2026'
  );
  assert.equal(
    loaded.module.getSetupActionSuccessSummary(uninstallSkill),
    'Removed SKILL for opencode.'
  );
  assert.equal(
    loaded.module.getSetupActionErrorSummary(uninstallSkill, 'timed out'),
    'Removal failed for SKILL on opencode: timed out'
  );
});
