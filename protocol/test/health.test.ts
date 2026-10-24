import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BRIDGE_METHOD_REGISTRY,
  ERROR_CODES,
  normalizeHealthPingParams,
  validateBridgeRequest,
} from '../src/index.js';

test('health ping defaults to compact output and accepts explicit diagnostic booleans', () => {
  assert.deepEqual(normalizeHealthPingParams(), { diagnostics: false });
  for (const diagnostics of [true, false]) {
    const request = validateBridgeRequest({
      id: 'health',
      method: 'health.ping',
      params: { diagnostics },
    });
    assert.deepEqual(request.params, { diagnostics });
  }
  assert.deepEqual(BRIDGE_METHOD_REGISTRY['health.ping'].params, ['diagnostics']);
  assert.equal(BRIDGE_METHOD_REGISTRY['health.ping'].discovery?.paramsType, 'HealthPingParams');
});

test('health ping rejects non-boolean diagnostics instead of treating them as opt-in', () => {
  for (const diagnostics of ['true', 'false', 0, 1, null, {}, []]) {
    assert.throws(
      () => validateBridgeRequest({ id: 'health', method: 'health.ping', params: { diagnostics } }),
      { code: ERROR_CODES.INVALID_REQUEST, message: 'diagnostics must be a boolean.' }
    );
  }
});
