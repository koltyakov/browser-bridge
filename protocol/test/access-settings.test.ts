import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFailure,
  normalizeAccessWaitForChangeParams,
  normalizeRequestParams,
} from '../src/index.js';

test('access-setting waits have strict bounded parameters', () => {
  assert.deepEqual(normalizeAccessWaitForChangeParams({ revision: 'old' }), {
    revision: 'old',
    timeoutMs: 25_000,
  });
  assert.deepEqual(
    normalizeRequestParams('access.wait_for_change', { revision: 'old', timeoutMs: 0 }),
    { revision: 'old', timeoutMs: 0 }
  );
  for (const params of [
    {},
    { revision: '' },
    { revision: 'x'.repeat(129) },
    { revision: 1 },
    { revision: 'old', timeoutMs: -1 },
    { revision: 'old', timeoutMs: 25_001 },
    { revision: 'old', timeoutMs: 0.5 },
    { revision: 'old', timeoutMs: '100' },
    { revision: 'old', extra: true },
  ]) {
    assert.throws(() => normalizeAccessWaitForChangeParams(params), { code: 'INVALID_REQUEST' });
  }
});

test('policy-denial recovery describes a setting change, not a new window-access prompt', () => {
  const response = createFailure('denied', 'ACCESS_DENIED', 'Tab creation disabled', {
    reason: 'policy_setting_disabled',
    setting: 'allowCreatingTabs',
    settingsRevision: 'old',
    dispatched: false,
  });
  assert.equal(response.error.recovery?.retry, false);
  assert.equal(response.error.recovery?.alternativeMethod, 'access.wait_for_change');
  assert.match(response.error.recovery?.hint ?? '', /Do not request window access again/);
});
