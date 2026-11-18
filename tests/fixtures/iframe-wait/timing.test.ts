import test from 'node:test';
import assert from 'node:assert/strict';
import { measure, summarize, explain, type Sample, type Stage } from './timing.ts';

const clock = { offsetMs: 20, uncertaintyMs: 1 };
const sample: Sample = {
  build: 'current',
  seed: 1,
  workload: 'attach',
  startedAt: 1000,
  returnedAt: 1600,
  browserReadyAt: 1500,
  clock,
  frameId: 3,
  ...measure(1000, 1600, 1500, clock),
};
test('ready-to-match uses observed readiness, not invocation or nominal fixture delay', () => {
  assert.equal(sample.totalWaitMs, 600);
  assert.equal(sample.readyToMatchMs, 80);
  assert.deepEqual(measure(1000, 1010, 950, clock), { totalWaitMs: 10, readyToMatchMs: 40 });
  assert.equal(measure(1000, 2000, null, clock).readyToMatchMs, null);
  assert.throws(() => measure(1000, 1010, 1200, clock));
});
test('replay requires repeated over-target readiness on distinct seeds', () => {
  assert.deepEqual(summarize([sample, sample], 79).traceSeeds, []);
  assert.deepEqual(summarize([sample, { ...sample, seed: 2 }], 79).traceSeeds, [1, 2]);
  assert.deepEqual(summarize([sample, { ...sample, seed: 2 }], 80).traceSeeds, []);
});
test('fallback attribution follows the winning watcher, not elapsed time alone', () => {
  const stages: Stage[] = [
    { stage: 'arm-fallback', at: 1300 },
    { stage: 'discover', at: 1550 },
    { stage: 'watch', at: 1552, frameId: 3 },
    { stage: 'match', at: 1560, frameId: 3 },
  ];
  assert.equal(explain(stages, sample), 'ready-before-fallback; no-worker-hint-observed');
  assert.equal(
    explain([{ stage: 'hint', at: 1200 }, ...stages], sample),
    'ready-before-fallback; earlier-hint-observed'
  );
  assert.equal(
    explain([stages[0], { stage: 'arm-event', at: 1530 }, ...stages.slice(1)], sample),
    'discovered-via-event'
  );
  assert.equal(explain(stages, { ...sample, frameId: 42 }), 'inconclusive');
});
