import { BridgeError, ERROR_CODES } from '../../../protocol/src/index.js';
import { requestLifetimes } from './background-request-lifetime.js';

type BridgeRequest = import('../../../protocol/src/types.js').BridgeRequest;
type BridgeResponse = import('../../../protocol/src/types.js').BridgeResponse;
type Condition = import('../../../protocol/src/types.js').NormalizedPerformOutcome;
type Result = import('../../../protocol/src/types.js').PerformOutcomeResult;

export type OutcomeNetworkSnapshot = {
  cursor?: import('./background-network.js').NetworkCaptureCursor;
  dropped: number;
  entries: Array<{ sequence?: number; method: string; url: string; status: number }>;
};

export type OutcomeDependencies = {
  dispatch: (request: BridgeRequest) => Promise<BridgeResponse>;
  armNetwork?: (tabId: number) => Promise<void>;
  readNetwork?: (tabId: number) => Promise<OutcomeNetworkSnapshot>;
};

/** Network evidence is latched while steps execute. DOM and URL conditions are
 * final-state checks, not claims that an observed event caused that state. */
export async function armPerformOutcomes(
  request: BridgeRequest,
  tabId: number,
  conditions: Condition[],
  timeoutMs: number,
  dependencies: OutcomeDependencies
) {
  const controller = new AbortController();
  const untrack = requestLifetimes.track(request.id, () => controller.abort());
  const deadline = performance.now() + timeoutMs;
  const network = conditions.flatMap((condition, index) =>
    condition.kind === 'network' ? [{ condition, index }] : []
  );
  let initial: OutcomeNetworkSnapshot | null = null;
  try {
    if (network.length) {
      if (!dependencies.armNetwork || !dependencies.readNetwork)
        throw new BridgeError(
          ERROR_CODES.INPUT_UNSUPPORTED,
          'Network outcome observation is unavailable.'
        );
      const armed = await untilStopped(
        dependencies.armNetwork(tabId).then(() => dependencies.readNetwork!(tabId)),
        controller.signal,
        deadline
      );
      if (!armed)
        throw new BridgeError(
          ERROR_CODES.TIMEOUT,
          'Network outcome capture did not arm before the request ended. No sequence steps ran.',
          { dispatched: false }
        );
      initial = armed.value;
      if (
        !initial.cursor?.epoch ||
        initial.cursor.nextSequence < 0 ||
        initial.cursor.generation < 0
      )
        throw new BridgeError(
          ERROR_CODES.OUTCOME_NOT_MET,
          'Network outcome capture could not be armed. No sequence steps ran.'
        );
    }
  } catch (error) {
    untrack();
    throw error;
  }

  const networkTask = watchNetwork();

  async function watchNetwork(): Promise<Result[]> {
    if (!initial?.cursor || !dependencies.readNetwork) return [];
    const baseline = initial.cursor;
    const readNetwork = dependencies.readNetwork;
    const results = new Map<number, Result>();
    const pending = new Map(network.map((entry) => [entry.index, entry.condition]));
    const interrupt = (status: 'timeout' | 'interrupted', reason: string) => {
      for (const index of pending.keys())
        results.set(index, {
          index,
          kind: 'network',
          status,
          evidence: { reason, provenance: 'page_main_world', integrity: 'untrusted' },
        });
      pending.clear();
    };
    try {
      while (pending.size && !controller.signal.aborted && performance.now() < deadline) {
        // A hung renderer never answers the page read. Stop waiting for it at
        // the deadline or on cancellation so the request can still settle.
        const read = await untilStopped(readNetwork(tabId), controller.signal, deadline);
        if (controller.signal.aborted) {
          interrupt('interrupted', 'observation_stopped');
          break;
        }
        if (!read) break;
        const snapshot = read.value;
        const cursor = snapshot.cursor;
        // A full buffer evicts its oldest entries on every request. That loses
        // evidence only when an evicted entry is at or after the baseline.
        const lostFresh =
          cursor?.evictedThrough !== undefined
            ? cursor.evictedThrough >= baseline.nextSequence
            : snapshot.dropped > initial!.dropped;
        if (
          !cursor ||
          cursor.epoch !== baseline.epoch ||
          cursor.generation !== baseline.generation ||
          cursor.nextSequence < baseline.nextSequence ||
          lostFresh
        ) {
          interrupt('interrupted', 'capture_gap_or_document_changed');
          break;
        }
        for (const entry of snapshot.entries) {
          if (entry.sequence === undefined || entry.sequence < baseline.nextSequence) continue;
          for (const [index, condition] of pending) {
            if (
              !entry.url.includes(condition.urlPattern) ||
              (condition.method && entry.method.toUpperCase() !== condition.method)
            )
              continue;
            const status =
              entry.status >= condition.statusMin && entry.status <= condition.statusMax
                ? 'matched'
                : 'failed';
            results.set(index, {
              index,
              kind: 'network',
              status,
              evidence: {
                method: entry.method,
                url: entry.url,
                status: entry.status,
                provenance: 'page_main_world',
                integrity: 'untrusted',
              },
            });
            pending.delete(index);
          }
        }
        if (pending.size)
          await pause(Math.min(100, Math.max(0, deadline - performance.now())), controller.signal);
      }
      if (pending.size)
        interrupt(
          controller.signal.aborted ? 'interrupted' : 'timeout',
          controller.signal.aborted ? 'observation_stopped' : 'deadline_elapsed'
        );
    } catch {
      interrupt('interrupted', 'capture_unavailable');
    }
    return [...results.values()];
  }

  async function complete(): Promise<Result[]> {
    const results = await Promise.all(
      conditions.map(async (condition, index): Promise<Result | null> => {
        if (condition.kind === 'network') return null;
        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= 0 || controller.signal.aborted)
          return {
            index,
            kind: condition.kind,
            status: controller.signal.aborted ? 'interrupted' : 'timeout',
          };
        const method = condition.kind === 'dom' ? 'dom.wait_for' : 'page.wait_for_load_state';
        try {
          const { kind: _kind, ...params } = condition;
          const response = await dependencies.dispatch({
            ...request,
            id: `${request.id}#outcome_${index}`,
            method,
            tab_id: tabId,
            params: { ...params, timeoutMs: Math.max(100, remaining) },
            meta: {
              ...request.meta,
              deadline_ms: Math.min(
                Number(request.meta.deadline_ms) || Infinity,
                Date.now() + remaining
              ),
            },
          });
          if (!response.ok)
            return {
              index,
              kind: condition.kind,
              status: response.error.code === 'TIMEOUT' ? 'timeout' : 'interrupted',
              evidence: { code: response.error.code },
            };
          const result =
            response.result && typeof response.result === 'object'
              ? (response.result as Record<string, unknown>)
              : {};
          if (condition.kind === 'dom')
            return {
              index,
              kind: 'dom',
              status: result.found === true ? 'matched' : 'timeout',
              evidence: {
                found: result.found === true,
                ...(typeof result.elementRef === 'string' ? { elementRef: result.elementRef } : {}),
              },
            };
          return { index, kind: 'url', status: 'matched', evidence: { matched: true } };
        } catch {
          return { index, kind: condition.kind, status: 'interrupted' };
        }
      })
    );
    return [...results.filter((result) => result !== null), ...(await networkTask)].sort(
      (a, b) => a.index - b.index
    );
  }

  return {
    complete,
    stop: () => {
      controller.abort();
      untrack();
    },
  };
}

/** Resolve with the operation's value, or null once the signal aborts or the
 * performance-clock deadline passes. The abandoned operation keeps running. */
function untilStopped<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  deadline: number
): Promise<{ value: T } | null> {
  if (signal.aborted) {
    operation.catch(() => {});
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    };
    const stop = () => {
      cleanup();
      resolve(null);
    };
    const timer = setTimeout(stop, Math.max(0, deadline - performance.now()));
    signal.addEventListener('abort', stop, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve({ value });
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
