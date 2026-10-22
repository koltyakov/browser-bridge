// @ts-check

export const RECOVERY_WINDOW_MS = 5 * 60 * 1000;
export const RECOVERY_BUCKET_MS = 5 * 1000;
export const RECOVERY_LOOP_WINDOW_MS = 60 * 1000;
export const RECOVERY_LOOP_THRESHOLD = 3;
export const RECOVERY_MAX_GROUPS = 64;
export const RECOVERY_PUBLIC_COUNT_LIMIT = 10_000;

/** @type {readonly import('./types.js').RecoveryEventKind[]} */
export const RECOVERY_EVENT_KINDS = Object.freeze([
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
  /** @param {{ now?: () => number }} [options] */
  constructor({ now = Date.now } = {}) {
    this.now = now;
    /** @type {Array<{ start: number, events: Map<import('./types.js').RecoveryEventKind, { attempts: number, successes: number, failures: number, lastEventAt: number }> } | null>} */
    this.buckets = Array.from({ length: BUCKET_COUNT }, () => null);
    /** @type {Map<string, { failures: [number, number, number], next: number, count: number, touchedAt: number, kind: import('./types.js').RecoveryEventKind }>} */
    this.groups = new Map();
  }

  /**
   * @param {import('./types.js').RecoveryEventKind} kind
   * @param {'success' | 'failure'} outcome
   * @param {string} [group='default']
   */
  record(kind, outcome, group = 'default') {
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

  /** @param {import('./types.js').RecoveryScope} scope */
  snapshot(scope) {
    const now = normalizeNow(this.now());
    this.pruneGroups(now);
    /** @type {Record<import('./types.js').RecoveryEventKind, import('./types.js').RecoveryEventSummary>} */
    const events =
      /** @type {Record<import('./types.js').RecoveryEventKind, import('./types.js').RecoveryEventSummary>} */ ({});
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

  /** @param {number} now */
  pruneGroups(now) {
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

/**
 * Strictly reconstruct a public summary from an untrusted transport value.
 * @param {unknown} value
 * @param {import('./types.js').RecoveryScope} expectedScope
 * @returns {import('./types.js').RecoveryTelemetrySummary | null}
 */
export function normalizeRecoveryTelemetrySummary(value, expectedScope) {
  const source = asRecord(value);
  if (!source || source.scope !== expectedScope) return null;
  const asOf = strictTimestamp(source.asOf);
  if (asOf === null) return null;
  const eventsSource = asRecord(source.events);
  if (!eventsSource) return null;
  /** @type {Record<import('./types.js').RecoveryEventKind, import('./types.js').RecoveryEventSummary>} */
  const events =
    /** @type {Record<import('./types.js').RecoveryEventKind, import('./types.js').RecoveryEventSummary>} */ ({});
  for (const kind of RECOVERY_EVENT_KINDS) {
    const event = asRecord(eventsSource[kind]);
    if (!event) return null;
    const attempts = rawCount(event.attempts);
    const successes = rawCount(event.successes);
    const failures = rawCount(event.failures);
    const pending = rawCount(event.pending);
    const saturated = event.saturated;
    if (
      attempts === null ||
      successes === null ||
      failures === null ||
      pending === null ||
      typeof saturated !== 'boolean' ||
      successes + failures + pending !== attempts ||
      (saturated
        ? attempts !== RECOVERY_PUBLIC_COUNT_LIMIT
        : attempts > RECOVERY_PUBLIC_COUNT_LIMIT)
    ) {
      return null;
    }
    const lastEventAt = normalizeLastEventAt(event.lastEventAt, attempts, asOf);
    if (lastEventAt === undefined) return null;
    events[kind] = {
      attempts,
      successes,
      failures,
      pending,
      saturated,
      successRate: saturated || attempts === 0 ? null : roundRate(successes / attempts),
      failureRate: saturated || attempts === 0 ? null : roundRate(failures / attempts),
      activeLoop: event.activeLoop === true && failures >= RECOVERY_LOOP_THRESHOLD,
      lastEventAt,
    };
  }
  return {
    scope: expectedScope,
    windowMs: RECOVERY_WINDOW_MS,
    bucketMs: RECOVERY_BUCKET_MS,
    loopWindowMs: RECOVERY_LOOP_WINDOW_MS,
    loopThreshold: RECOVERY_LOOP_THRESHOLD,
    asOf,
    activeLoop: RECOVERY_EVENT_KINDS.some((kind) => events[kind].activeLoop),
    events,
  };
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/** @param {unknown} value @returns {number | null} */
function rawCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** @param {unknown} value @returns {number | null} */
function strictTimestamp(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** @param {number} value */
function normalizeNow(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * @param {unknown} value
 * @param {number} attempts
 * @param {number} asOf
 * @returns {number | null | undefined}
 */
function normalizeLastEventAt(value, attempts, asOf) {
  if (attempts === 0) return value === null ? null : undefined;
  const timestamp = strictTimestamp(value);
  if (
    timestamp === null ||
    timestamp > asOf ||
    timestamp < asOf - RECOVERY_WINDOW_MS - RECOVERY_BUCKET_MS
  ) {
    return undefined;
  }
  return timestamp;
}

/** @param {number} value */
function roundRate(value) {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * @param {number} attempts
 * @param {number} successes
 * @param {number} failures
 * @param {boolean} activeLoop
 * @param {number} lastEventAt
 * @returns {import('./types.js').RecoveryEventSummary}
 */
function createPublicEventSummary(attempts, successes, failures, activeLoop, lastEventAt) {
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
