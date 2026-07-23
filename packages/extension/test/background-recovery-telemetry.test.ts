import test from 'node:test';
import assert from 'node:assert/strict';

import { getStaleRecoveryOutcome } from '../src/background-tab-bound.js';

test('stale recovery outcome requires explicit entered metadata', () => {
  assert.equal(getStaleRecoveryOutcome({ recovered: false }), null);
  assert.equal(
    getStaleRecoveryOutcome({ details: { recoveryAttempted: true, elementRef: 'private' } }),
    'failure'
  );
  assert.equal(
    getStaleRecoveryOutcome({
      resolution: { strategy: 'stale-recovery', recovered: true, oldRef: 'private' },
    }),
    'success'
  );
});
