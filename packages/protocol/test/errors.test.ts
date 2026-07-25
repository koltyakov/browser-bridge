import test from 'node:test';
import assert from 'node:assert/strict';

import { BridgeError, ERROR_CODES, ERROR_RECOVERY, getErrorRecovery } from '../src/errors.js';
import { isBridgeMethod } from '../src/registry.js';
import type { ErrorCode } from '../src/types.js';

const EXPECTED_ERROR_CODES: readonly string[] = [
  'ACCESS_DENIED',
  'TAB_MISMATCH',
  'ELEMENT_STALE',
  'ELEMENT_AMBIGUOUS',
  'ELEMENT_NOT_ACTIONABLE',
  'ELEMENT_OBSCURED',
  'ELEMENT_NOT_FOUND',
  'INPUT_UNSUPPORTED',
  'INPUT_INVALID_TARGET',
  'INPUT_FOCUS_CHANGED',
  'DIALOG_NOT_OPEN',
  'DIALOG_ACTION_CONFLICT',
  'RESULT_TRUNCATED',
  'RESULT_TOO_LARGE',
  'SENSITIVE_TARGET_NOT_FOUND',
  'CONTENT_SCRIPT_UNAVAILABLE',
  'ARTIFACT_NOT_FOUND',
  'ARTIFACT_QUOTA_EXCEEDED',
  'ARTIFACT_TRANSFER_INVALID',
  'DOM_BASELINE_NOT_FOUND',
  'DOM_BASELINE_INVALIDATED',
  'DOM_BASELINE_QUOTA_EXCEEDED',
  'INTERNAL_ERROR',
  'INVALID_REQUEST',
  'NATIVE_HOST_UNAVAILABLE',
  'EXTENSION_DISCONNECTED',
  'TIMEOUT',
];

test('ERROR_CODES maps every declared name to its identical string value', () => {
  assert.equal(Object.isFrozen(ERROR_CODES), true);
  assert.deepEqual(Object.keys(ERROR_CODES).sort(), [...EXPECTED_ERROR_CODES].sort());

  for (const [name, value] of Object.entries(ERROR_CODES)) {
    assert.equal(value, name, `ERROR_CODES.${name} must equal its own name`);
  }
});

test('ERROR_RECOVERY covers every error code with a well-formed entry', () => {
  assert.equal(Object.isFrozen(ERROR_RECOVERY), true);
  assert.deepEqual(Object.keys(ERROR_RECOVERY).sort(), Object.keys(ERROR_CODES).sort());

  for (const [code, recovery] of Object.entries(ERROR_RECOVERY)) {
    assert.equal(typeof recovery.retry, 'boolean', `${code} retry must be boolean`);
    assert.equal(typeof recovery.hint, 'string', `${code} hint must be a string`);
    assert.ok(recovery.hint.length > 0, `${code} hint must not be empty`);

    if (recovery.retry) {
      assert.equal(
        typeof recovery.retryAfterMs,
        'number',
        `${code} retryable entries must declare retryAfterMs`
      );
      assert.ok(recovery.retryAfterMs! > 0, `${code} retryAfterMs must be positive`);
    }
    if (recovery.alternativeMethod !== undefined) {
      assert.equal(
        isBridgeMethod(recovery.alternativeMethod),
        true,
        `${code} alternativeMethod must be a registered bridge method`
      );
    }
  }
});

test('ERROR_RECOVERY marks exactly the retryable codes', () => {
  const retryable = Object.entries(ERROR_RECOVERY)
    .filter(([, recovery]) => recovery.retry)
    .map(([code]) => code)
    .sort();

  assert.deepEqual(retryable, ['EXTENSION_DISCONNECTED', 'INTERNAL_ERROR', 'TIMEOUT']);

  assert.equal(ERROR_RECOVERY[ERROR_CODES.TIMEOUT].retryAfterMs, 1000);
  assert.equal(ERROR_RECOVERY[ERROR_CODES.EXTENSION_DISCONNECTED].retryAfterMs, 3000);
  assert.equal(ERROR_RECOVERY[ERROR_CODES.INTERNAL_ERROR].retryAfterMs, 1000);
});

test('getErrorRecovery returns the frozen entry for known codes and null otherwise', () => {
  const recovery = getErrorRecovery(ERROR_CODES.ACCESS_DENIED);
  assert.equal(recovery, ERROR_RECOVERY[ERROR_CODES.ACCESS_DENIED]);
  assert.equal(recovery?.retry, false);
  assert.match(recovery?.hint ?? '', /Enable/);

  assert.equal(getErrorRecovery('NOT_A_REAL_CODE'), null);
  assert.equal(getErrorRecovery(''), null);
});

test('BridgeError carries code, message, and structured details', () => {
  const error = new BridgeError(ERROR_CODES.INVALID_REQUEST, 'Bad request', {
    field: 'method',
  });

  assert.equal(error instanceof Error, true);
  assert.equal(error instanceof BridgeError, true);
  assert.equal(error.name, 'BridgeError');
  assert.equal(error.message, 'Bad request');
  assert.equal(error.code, 'INVALID_REQUEST');
  assert.deepEqual(error.details, { field: 'method' });
});

test('BridgeError defaults details to null and accepts every declared code', () => {
  for (const code of Object.values(ERROR_CODES)) {
    const error = new BridgeError(code as ErrorCode, `failed: ${code}`);
    assert.equal(error.code, code);
    assert.equal(error.details, null);
  }
});
