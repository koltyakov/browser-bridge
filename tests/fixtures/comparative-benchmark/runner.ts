import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Fixture } from './fixture.ts';
import { Metrics, percentile, successInterval } from './metrics.ts';
import { assess } from './scoring.ts';
import type { Driver, EpisodeResult, Task } from './types.ts';
import {
  AdapterValidationError,
  observation,
  runResult,
  sessionClose,
  validateDriver,
  validateSession,
  type SessionBoundary,
} from './validation.ts';

export function pairedOrder<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  // Hash-derived Fisher-Yates; independent of tool runtime and prior failures.
  for (let index = result.length - 1; index > 0; index--) {
    const bytes = createHash('sha256').update(`${seed}:${index}`).digest();
    const other = bytes.readUInt32LE(0) % (index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

async function deadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let canceled: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Benchmark deadline exceeded')), timeoutMs);
        canceled = () => reject(new Error('Benchmark canceled'));
        if (signal?.aborted) canceled();
        else signal?.addEventListener('abort', canceled, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (canceled) signal?.removeEventListener('abort', canceled);
  }
}

export async function runEpisode(
  driver: Driver,
  task: Task,
  seed: number,
  output: string,
  signal?: AbortSignal
): Promise<EpisodeResult> {
  driver = validateDriver(driver);
  const result: EpisodeResult = {
    schemaVersion: 1,
    task: task.id,
    seed,
    driver: driver.identity,
    status: 'unsupported',
    assessment: null,
    counts: null,
    latencyMs: null,
    setupMs: 0,
    auditMs: 0,
    cleanupMs: 0,
    cleanup: false,
    faultObserved: false,
    recoveryMs: null,
    timedOut: false,
    reported: null,
    observation: null,
    error: null,
    provenance: {},
  };
  if (!driver.supportedTasks.includes(task.id)) return result;
  await mkdir(output, { recursive: true });
  const fixture = new Fixture(task, seed);
  const metrics = new Metrics(driver.browserRequestsObservable);
  const measurements: Array<{ atMs: number; event: unknown }> = [];
  const abort = new AbortController();
  const cancel = () => abort.abort();
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  let session: SessionBoundary | undefined;
  let rawSession: unknown;
  let receivedSession = false;
  let opening: Promise<unknown> | undefined;
  let invalidAdapter: AdapterValidationError | undefined;
  const rememberValidation = (error: unknown) => {
    if (error instanceof AdapterValidationError) {
      invalidAdapter ??= error;
      abort.abort();
    }
  };
  let finished = false;
  let opened = false;
  let openingPending = false;
  let closeIfLate = false;
  let expectedOrigin: string | undefined;
  let faultAt: number | null = null;
  const setup = performance.now();
  try {
    await fixture.start();
    expectedOrigin = new URL(fixture.url).origin;
    // Driver open may only prepare an isolated browser/session. Agent inference
    // and task discovery belong in run(), where their full usage is counted.
    openingPending = true;
    opening = driver.open({
      task,
      seed,
      url: fixture.url,
      output,
      signal: abort.signal,
      measure: (event) => {
        try {
          if (!opened)
            throw new AdapterValidationError(
              'measurement',
              'Task measurements are not allowed during infrastructure setup'
            );
          metrics.record(event);
          measurements.push({ atMs: performance.now() - setup, event: structuredClone(event) });
        } catch (error) {
          // Adapter code can catch exceptions. That must not erase invalid
          // telemetry and turn the remaining counters into a successful run.
          rememberValidation(error);
          throw error;
        }
      },
      waitForCommit: (operation, record) => fixture.waitForCommit(operation, record, abort.signal),
      markFault: () => {
        if (!opened || !task.fault || faultAt !== null)
          throw new Error('Fault must be marked once during its declared task');
        result.faultObserved = true;
        faultAt = performance.now();
      },
      markRecovery: () => {
        if (faultAt === null) throw new Error('Recovery requires an observed fault');
        if (task.expected.length && fixture.goalAtMs() === null)
          throw new Error('Recovery requires independent goal evidence');
        result.recoveryMs = performance.now() - faultAt;
      },
      releaseReply: () => fixture.releaseReply(),
    });
    // Join late setup so timeout cannot leave a newly opened browser orphaned.
    opening.then(
      (late) => {
        openingPending = false;
        if (closeIfLate) {
          try {
            void sessionClose(late)?.().catch(() => {});
          } catch {
            /* Unconfirmed cleanup stays failed. */
          }
        }
      },
      () => {
        openingPending = false;
      }
    );
    rawSession = await deadline(opening, 60000, abort.signal);
    receivedSession = true;
    session = validateSession(rawSession);
    opened = true;
    result.setupMs = performance.now() - setup;
    result.provenance = session.provenance;
    fixture.begin();
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          result.timedOut = true;
          abort.abort();
          reject(new Error('Task deadline exceeded'));
        }, task.timeoutMs);
      });
      const response = runResult(
        await deadline(Promise.race([session.run(), expired]), task.timeoutMs + 100, abort.signal),
        driver.identity.track === 'agent'
      );
      if (driver.identity.track === 'agent') {
        await writeFile(path.join(output, 'final.txt'), response.finalText!, { flag: 'wx' });
      }
      result.reported = response.reported;
      finished = true;
    } catch (error) {
      rememberValidation(error);
      result.error = String(error);
    } finally {
      clearTimeout(timer);
      result.latencyMs = performance.now() - started;
    }
    const auditing = performance.now();
    // Fixed observation window catches delayed continuation after a result/error.
    await delay(task.settleMs);
    const observed = observation(await deadline(session.observe(), 5000));
    result.observation = {
      ...observed,
      effects: fixture.effects.map((effect) => ({ ...effect })),
      goalAtMs: fixture.goalAtMs(),
    };
    result.auditMs = performance.now() - auditing;
    result.counts = metrics.snapshot();
    result.status = 'measured';
  } catch (error) {
    rememberValidation(error);
    result.error = String(error);
    result.status = 'invalid';
    result.setupMs ||= performance.now() - setup;
  } finally {
    // Teardown may implicitly dismiss a dialog by closing its document. That
    // is not a task action; the declared post-result observation window is over.
    fixture.end();
    abort.abort();
    const cleaning = performance.now();
    try {
      // A canceled setup may already own a browser. Join it before reporting
      // cleanup, rather than letting process exit race a fire-and-forget close.
      if (!receivedSession && opening) {
        rawSession = await deadline(opening, 20000);
        receivedSession = true;
      }
      const close = sessionClose(rawSession);
      if (receivedSession && !close)
        rememberValidation(
          new AdapterValidationError('session.close', 'expected a cleanup function')
        );
      if (close) await deadline(close(), 20000);
      await fixture.close();
      result.cleanup = Boolean(close) && !openingPending;
    } catch (error) {
      rememberValidation(error);
      closeIfLate = true;
      result.error = [result.error, `Cleanup: ${String(error)}`].filter(Boolean).join('; ');
      await fixture.close();
    }
    result.cleanupMs = performance.now() - cleaning;
    signal?.removeEventListener('abort', cancel);
  }
  // Preserve independently observed unsafe effects even when browser observation
  // fails. Invalid episodes must not disappear from safety reporting.
  result.observation ??= {
    effects: fixture.effects.map((effect) => ({ ...effect })),
    goalAtMs: fixture.goalAtMs(),
    focusThefts: null,
    url: null,
    dialogOpened: null,
    dialogClosed: null,
  };
  result.observation.effects = fixture.effects.map((effect) => ({ ...effect }));
  result.counts = metrics.snapshot();
  if (invalidAdapter) {
    result.status = 'invalid';
    if (!result.error?.includes(invalidAdapter.message))
      result.error = [result.error, String(invalidAdapter)].filter(Boolean).join('; ');
  }
  if (result.observation) {
    result.assessment = assess(task, result.observation, {
      finished,
      reported: result.reported,
      cleanup: result.cleanup,
      faultObserved: result.faultObserved,
      expectedOrigin,
    });
    if (!result.assessment.valid) result.status = 'invalid';
  }
  if (driver.identity.track === 'agent' && !result.counts?.modelRequests) {
    result.status = 'invalid';
    result.error = 'Agent driver supplied no model-request accounting';
  }
  if (result.status === 'invalid' && result.assessment) {
    result.assessment.success = false;
    result.assessment.reasons.push('invalid_episode');
  }
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2), {
    flag: 'wx',
  });
  await writeFile(
    path.join(output, 'measurements.jsonl'),
    measurements.map((event) => JSON.stringify(event)).join('\n'),
    { flag: 'wx' }
  );
  return result;
}

export function summarize(results: readonly EpisodeResult[]) {
  const identities = [
    ...new Set(
      results.map(
        (result) => `${result.driver.name}@${result.driver.version}:${result.driver.track}`
      )
    ),
  ];
  return identities.map((identity) => {
    const episodes = results.filter(
      (result) =>
        `${result.driver.name}@${result.driver.version}:${result.driver.track}` === identity
    );
    const measured = episodes.filter((result) => result.status === 'measured');
    const attempted = episodes.filter((result) => result.status !== 'unsupported');
    const successes = measured.filter((result) => result.assessment?.success);
    const successfulLatency = successes.flatMap((result) =>
      result.latencyMs === null ? [] : [result.latencyMs]
    );
    const safe = measured.filter((result) => result.assessment?.safe === true).length;
    return {
      identity,
      planned: episodes.length,
      measured: measured.length,
      unsupported: episodes.filter((result) => result.status === 'unsupported').length,
      invalid: episodes.filter((result) => result.status === 'invalid').length,
      successes: successes.length,
      // Planned denominator prevents unsupported cells from disappearing.
      completionRate: episodes.length ? successes.length / episodes.length : null,
      success95: successInterval(successes.length, episodes.length),
      safe,
      safetyViolations: episodes.filter((result) => result.assessment?.safe === false).length,
      duplicateAttempts: episodes.reduce(
        (sum, result) => sum + (result.assessment?.duplicateAttempts ?? 0),
        0
      ),
      duplicateCommits: episodes.reduce(
        (sum, result) => sum + (result.assessment?.duplicateCommits ?? 0),
        0
      ),
      unauthorizedAttempts: episodes.reduce(
        (sum, result) => sum + (result.assessment?.unauthorizedAttempts ?? 0),
        0
      ),
      unauthorizedCommits: episodes.reduce(
        (sum, result) => sum + (result.assessment?.unauthorizedCommits ?? 0),
        0
      ),
      wrongValues: episodes.reduce((sum, result) => sum + (result.assessment?.wrongValues ?? 0), 0),
      focusObservedEpisodes: episodes.filter(
        (result) =>
          result.observation?.focusThefts !== null && result.observation?.focusThefts !== undefined
      ).length,
      focusThefts: episodes.some(
        (result) =>
          result.observation?.focusThefts !== null && result.observation?.focusThefts !== undefined
      )
        ? episodes.reduce((sum, result) => sum + (result.observation?.focusThefts ?? 0), 0)
        : null,
      successfulLatencyMs: {
        p50: percentile(successfulLatency, 0.5),
        p95: percentile(successfulLatency, 0.95),
        n: successfulLatency.length,
      },
      timeouts: episodes.filter((result) => result.timedOut).length,
      allTaskLatencyMs: {
        p50: percentile(
          episodes.flatMap((result) => (result.latencyMs === null ? [] : [result.latencyMs])),
          0.5
        ),
        p95: percentile(
          episodes.flatMap((result) => (result.latencyMs === null ? [] : [result.latencyMs])),
          0.95
        ),
      },
      hostToolCalls: episodes.reduce((sum, result) => sum + (result.counts?.hostToolCalls ?? 0), 0),
      modelRequests: episodes.reduce((sum, result) => sum + (result.counts?.modelRequests ?? 0), 0),
      browserRequests:
        measured.length && measured.every((result) => result.counts?.browserRequests !== null)
          ? measured.reduce((sum, result) => sum + (result.counts?.browserRequests ?? 0), 0)
          : null,
      responseBytes: episodes.reduce((sum, result) => sum + (result.counts?.responseBytes ?? 0), 0),
      // Null if even one measured episode lacks provider usage. No chars/4 estimates.
      tokens:
        attempted.length && attempted.every((result) => result.counts?.tokens)
          ? attempted.reduce(
              (sum, result) => sum + result.counts!.tokens!.input + result.counts!.tokens!.output,
              0
            )
          : null,
    };
  });
}

/** Compare only matched task+seed cells within one track. Unsupported cells
 * remain in the overall table, and are excluded here explicitly, not silently. */
export function comparePairs(results: readonly EpisodeResult[]) {
  const names = [...new Set(results.map((result) => result.driver.name))].sort();
  const comparisons: Array<Record<string, unknown>> = [];
  for (let left = 0; left < names.length; left++) {
    for (let right = left + 1; right < names.length; right++) {
      const matches = results
        .filter((result) => result.driver.name === names[left])
        .flatMap((a) => {
          const b = results.find(
            (entry) =>
              entry.driver.name === names[right] &&
              entry.task === a.task &&
              entry.seed === a.seed &&
              entry.driver.track === a.driver.track
          );
          return b ? [{ a, b }] : [];
        });
      if (!matches.length) continue;
      const supported = matches.filter(
        ({ a, b }) => a.status !== 'unsupported' && b.status !== 'unsupported'
      );
      const both = supported.filter(
        ({ a, b }) =>
          a.assessment?.success &&
          b.assessment?.success &&
          a.status === 'measured' &&
          b.status === 'measured'
      );
      const deltas = both.map(({ a, b }) => a.latencyMs! - b.latencyMs!);
      comparisons.push({
        left: names[left],
        right: names[right],
        plannedPairs: matches.length,
        unsupportedPairs: matches.length - supported.length,
        invalidPairs: supported.filter(
          ({ a, b }) => a.status === 'invalid' || b.status === 'invalid'
        ).length,
        leftOnlySuccess: supported.filter(
          ({ a, b }) => a.assessment?.success && !b.assessment?.success
        ).length,
        rightOnlySuccess: supported.filter(
          ({ a, b }) => b.assessment?.success && !a.assessment?.success
        ).length,
        bothSuccess: both.length,
        bothSuccessfulMeanLatencyDeltaMs: deltas.length
          ? deltas.reduce((sum, ms) => sum + ms, 0) / deltas.length
          : null,
        samples: supported.map(({ a, b }) => ({
          task: a.task,
          seed: a.seed,
          leftSuccess: a.assessment?.success ?? false,
          rightSuccess: b.assessment?.success ?? false,
          leftLatencyMs: a.latencyMs,
          rightLatencyMs: b.latencyMs,
        })),
      });
    }
  }
  return comparisons;
}
