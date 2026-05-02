// @ts-check

import assert from 'node:assert/strict';

/**
 * Assert the stable public summary surface without coupling tests to any extra
 * bookkeeping fields that may be added later.
 *
 * @param {{ summary?: unknown, evidence?: unknown, recovery?: unknown }} actual
 * @param {{ summary?: unknown, evidence?: unknown, recovery?: unknown }} expected
 * @returns {void}
 */
export function assertSummary(actual, expected) {
  assert.deepEqual(
    {
      ...(Object.hasOwn(expected, 'summary') ? { summary: actual.summary } : {}),
      ...(Object.hasOwn(expected, 'evidence') ? { evidence: actual.evidence } : {}),
      ...(Object.hasOwn(expected, 'recovery') ? { recovery: actual.recovery } : {}),
    },
    expected
  );
}
