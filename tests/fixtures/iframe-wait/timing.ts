import assert from 'node:assert/strict';
import { percentile } from '../comparative-benchmark/metrics.ts';

export type Workload = 'existing' | 'missing' | 'attach' | 'navigate';
export type Sample = {
  build: string;
  seed: number;
  workload: Workload;
  startedAt: number;
  returnedAt: number;
  browserReadyAt: number | null;
  clock: { offsetMs: number; uncertaintyMs: number };
  frameId: number | null;
  totalWaitMs: number;
  readyToMatchMs: number | null;
};

export function measure(
  startedAt: number,
  returnedAt: number,
  browserReadyAt: number | null,
  clock: Sample['clock']
) {
  const totalWaitMs = returnedAt - startedAt;
  assert(Number.isFinite(totalWaitMs) && totalWaitMs >= 0);
  if (browserReadyAt === null) return { totalWaitMs, readyToMatchMs: null };
  assert(Number.isFinite(browserReadyAt) && browserReadyAt > 0, 'Missing fixture readiness mark');
  const latency = returnedAt - (browserReadyAt + clock.offsetMs);
  assert(latency >= -clock.uncertaintyMs, 'Target readiness was timestamped after the match');
  // A target can already be ready before the host submits the wait.
  return { totalWaitMs, readyToMatchMs: Math.max(0, latency) };
}

export function summarize(samples: Sample[], targetMs: number) {
  const slow = samples.filter((s) => s.readyToMatchMs !== null && s.readyToMatchMs > targetMs);
  const seeds = [...new Set(slow.map((s) => s.seed))];
  const spread = (v: number[]) => ({
    n: v.length,
    p50: percentile(v, 0.5),
    p95: percentile(v, 0.95),
    max: percentile(v, 1),
  });
  return {
    totalWaitMs: spread(samples.map((s) => s.totalWaitMs)),
    readyToMatchMs: spread(
      samples.flatMap((s) => (s.readyToMatchMs === null ? [] : [s.readyToMatchMs]))
    ),
    overTargetSeeds: seeds,
    traceSeeds: seeds.length >= 2 ? seeds.slice(0, 3) : [],
  };
}

export type Stage = { stage: string; at: number; frameId?: number; frameIds?: number[] };

/** The worker has one active wait in the isolated fixture. Follow the timer
 * actually armed before the scan that installed the winning document watcher.
 * Do not infer a fallback from the length of a sample. */
export function explain(stages: Stage[], sample: Sample) {
  if (sample.browserReadyAt === null || sample.frameId === null) return 'no-matching-frame';
  const match = stages.findLastIndex((s) => s.stage === 'match' && s.frameId === sample.frameId);
  const watch = stages
    .slice(0, match < 0 ? 0 : match)
    .findLastIndex((s) => s.stage === 'watch' && s.frameId === sample.frameId);
  const scan = stages.slice(0, Math.max(watch, 0)).findLastIndex((s) => s.stage === 'discover');
  const arm = stages.slice(0, Math.max(scan, 0)).findLast((s) => s.stage.startsWith('arm-'));
  if (!arm || scan < 0 || watch < 0 || match < 0) return 'inconclusive';
  if (arm.stage !== 'arm-fallback') return `discovered-via-${arm.stage.slice(4)}`;
  if (stages[scan].at <= sample.browserReadyAt) return 'fallback-scan-started-before-readiness';
  return stages.slice(0, scan).some((s) => s.stage === 'hint')
    ? 'ready-before-fallback; earlier-hint-observed'
    : 'ready-before-fallback; no-worker-hint-observed';
}
