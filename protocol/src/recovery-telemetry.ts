export const RECOVERY_WINDOW_MS = 5 * 60 * 1000;
export const RECOVERY_BUCKET_MS = 5 * 1000;
export const RECOVERY_LOOP_WINDOW_MS = 60 * 1000;
export const RECOVERY_LOOP_THRESHOLD = 3;
export const RECOVERY_MAX_GROUPS = 64;
export const RECOVERY_PUBLIC_COUNT_LIMIT = 10_000;

export const RECOVERY_EVENT_KINDS: readonly import('./types.js').RecoveryEventKind[] =
  Object.freeze([
    'automatic_mcp_retry',
    'stale_ref_recovery',
    'debugger_reattach',
    'content_script_reinjection',
    'native_host_reconnect',
    'request_outcome',
  ]);

const RECOVERY_EVENT_KIND_SET = new Set(RECOVERY_EVENT_KINDS);
const BUCKET_COUNT = RECOVERY_WINDOW_MS / RECOVERY_BUCKET_MS + 1;

/**
 * Fixed-bucket, process-local recovery telemetry. Group names are used only to
 * detect repeated failures and are never included in public snapshots.
 */
export class RecoveryTelemetryCollector {
  declare buckets: Array<{
    start: number;
    events: Map<
      import('./types.js').RecoveryEventKind,
      { attempts: number; successes: number; failures: number; lastEventAt: number }
    >;
  } | null>;
  declare groups: Map<
    string,
    {
      failures: [number, number, number];
      next: number;
      count: number;
      touchedAt: number;
      kind: import('./types.js').RecoveryEventKind;
    }
  >;
  declare now: () => number;

  constructor({ now = Date.now }: { now?: () => number } = {}) {
    this.now = now;

    this.buckets = Array.from({ length: BUCKET_COUNT }, () => null);

    this.groups = new Map();
  }

  record(
    kind: import('./types.js').RecoveryEventKind,
    outcome: 'success' | 'failure',
    group: string = 'default'
  ) {
    if (!RECOVERY_EVENT_KIND_SET.has(kind)) return;
    const now = normalizeNow(this.now());
    const start = Math.floor(now / RECOVERY_BUCKET_MS) * RECOVERY_BUCKET_MS;
    const index = Math.floor(start / RECOVERY_BUCKET_MS) % BUCKET_COUNT;
    let bucket = this.buckets[index];
    if (!bucket || bucket.start !== start) {
      bucket = { start, events: new Map() };
      this.buckets[index] = bucket;
    }
    const event = bucket.events.get(kind) ?? {
      attempts: 0,
      successes: 0,
      failures: 0,
      lastEventAt: 0,
    };
    event.attempts += 1;
    event.successes += outcome === 'success' ? 1 : 0;
    event.failures += outcome === 'failure' ? 1 : 0;
    event.lastEventAt = now;
    bucket.events.set(kind, event);

    this.pruneGroups(now);
    if (outcome !== 'failure') return;
    const groupKey = `${kind}\u0000${group}`;
    let state = this.groups.get(groupKey);
    if (!state) {
      while (this.groups.size >= RECOVERY_MAX_GROUPS) {
        const oldest = [...this.groups].reduce((left, right) =>
          left[1].touchedAt <= right[1].touchedAt ? left : right
        );
        this.groups.delete(oldest[0]);
      }
      state = {
        failures: [0, 0, 0],
        next: 0,
        count: 0,
        touchedAt: now,
        kind,
      };
      this.groups.set(groupKey, state);
    }
    state.failures[state.next] = now;
    state.next = (state.next + 1) % RECOVERY_LOOP_THRESHOLD;
    state.count = Math.min(RECOVERY_LOOP_THRESHOLD, state.count + 1);
    state.touchedAt = now;
  }

  snapshot(scope: import('./types.js').RecoveryScope) {
    const now = normalizeNow(this.now());
    this.pruneGroups(now);

    const events: Record<
      import('./types.js').RecoveryEventKind,
      import('./types.js').RecoveryEventSummary
    > = {} as Record<
      import('./types.js').RecoveryEventKind,
      import('./types.js').RecoveryEventSummary
    >;
    for (const kind of RECOVERY_EVENT_KINDS) {
      let attempts = 0;
      let successes = 0;
      let failures = 0;
      let lastEventAt = 0;
      for (const bucket of this.buckets) {
        if (
          !bucket ||
          bucket.start + RECOVERY_BUCKET_MS <= now - RECOVERY_WINDOW_MS ||
          bucket.start > now
        ) {
          continue;
        }
        const event = bucket.events.get(kind);
        if (!event) continue;
        attempts += event.attempts;
        successes += event.successes;
        failures += event.failures;
        lastEventAt = Math.max(lastEventAt, event.lastEventAt);
      }
      const activeLoop = [...this.groups.values()].some((group) => {
        if (group.kind !== kind || group.count < RECOVERY_LOOP_THRESHOLD) return false;
        return group.failures.every((at) => at >= now - RECOVERY_LOOP_WINDOW_MS && at <= now);
      });
      events[kind] = createPublicEventSummary(
        attempts,
        successes,
        failures,
        activeLoop,
        lastEventAt
      );
    }
    return {
      scope,
      windowMs: RECOVERY_WINDOW_MS,
      bucketMs: RECOVERY_BUCKET_MS,
      loopWindowMs: RECOVERY_LOOP_WINDOW_MS,
      loopThreshold: RECOVERY_LOOP_THRESHOLD,
      asOf: now,
      activeLoop: RECOVERY_EVENT_KINDS.some((kind) => events[kind].activeLoop),
      events,
    };
  }

  pruneGroups(now: number) {
    const cutoff = now - RECOVERY_LOOP_WINDOW_MS;
    for (const [key, group] of this.groups) {
      let recent = 0;
      for (let index = 0; index < group.count; index += 1) {
        const at = group.failures[index];
        if (at >= cutoff && at <= now) recent += 1;
      }
      if (recent === 0) this.groups.delete(key);
    }
  }
}

function normalizeNow(value: number) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function roundRate(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function createPublicEventSummary(
  attempts: number,
  successes: number,
  failures: number,
  activeLoop: boolean,
  lastEventAt: number
): import('./types.js').RecoveryEventSummary {
  if (attempts <= RECOVERY_PUBLIC_COUNT_LIMIT) {
    return {
      attempts,
      successes,
      failures,
      pending: 0,
      saturated: false,
      successRate: attempts > 0 ? roundRate(successes / attempts) : null,
      failureRate: attempts > 0 ? roundRate(failures / attempts) : null,
      activeLoop,
      lastEventAt: attempts > 0 ? lastEventAt : null,
    };
  }
  const proportionalFailures = Math.floor((failures / attempts) * RECOVERY_PUBLIC_COUNT_LIMIT);
  const cappedFailures = Math.min(
    RECOVERY_PUBLIC_COUNT_LIMIT,
    Math.max(activeLoop ? RECOVERY_LOOP_THRESHOLD : 0, proportionalFailures)
  );
  return {
    attempts: RECOVERY_PUBLIC_COUNT_LIMIT,
    successes: RECOVERY_PUBLIC_COUNT_LIMIT - cappedFailures,
    failures: cappedFailures,
    pending: 0,
    saturated: true,
    successRate: null,
    failureRate: null,
    activeLoop,
    lastEventAt,
  };
}
