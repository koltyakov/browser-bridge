import assert from 'node:assert/strict';

export type SummarySurface = {
  summary?: unknown;
  evidence?: unknown;
  recovery?: unknown;
};

// Assert the stable public summary surface without coupling tests to extra
// bookkeeping fields that may be added later.
export function assertSummary(actual: SummarySurface, expected: SummarySurface): void {
  assert.deepEqual(
    {
      ...(Object.hasOwn(expected, 'summary') ? { summary: actual.summary } : {}),
      ...(Object.hasOwn(expected, 'evidence') ? { evidence: actual.evidence } : {}),
      ...(Object.hasOwn(expected, 'recovery') ? { recovery: actual.recovery } : {}),
    },
    expected
  );
}
