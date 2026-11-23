import { BridgeError, ERROR_CODES } from '../../../protocol/src/index.js';

type Request = import('../../../protocol/src/types.js').BridgeRequest;
type Lifetime = {
  artifactAck: boolean;
  owner: string;
  controller: AbortController;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  cancelers: Set<() => void>;
};

/** Grace after a request's deadline before its slot is reclaimed. Work past
 * the deadline has already been aborted; a slot still held this long later
 * belongs to work that will never settle (a wedged command). */
export const REQUEST_SLOT_REAP_GRACE_MS = 30_000;

/** Retain canceled work until it settles, within a grace period. Capacity is
 * not reclaimed when a caller times out while its browser command still runs,
 * only once the command is long past its deadline. */
export function createRequestLifetimes(maxPending = 128, reapGraceMs = REQUEST_SLOT_REAP_GRACE_MS) {
  const active = new Map<string, Lifetime>();
  const key = (id: string) => id.split('#', 1)[0];
  const error = () =>
    new BridgeError(
      ERROR_CODES.TIMEOUT,
      'Request canceled or expired. Inspect postconditions before retrying a mutation.',
      { outcomeUncertain: true }
    );

  /** Drop slots whose work is far past its deadline and was already aborted. */
  function reap(now: number): number {
    let reaped = 0;
    for (const [id, lifetime] of active) {
      if (now < lifetime.deadline + reapGraceMs) continue;
      lifetime.controller.abort(error());
      clearTimeout(lifetime.timer);
      active.delete(id);
      reaped += 1;
    }
    return reaped;
  }

  function begin(request: Request) {
    if (active.has(request.id))
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        `Request id ${request.id.slice(0, 80)} is already in flight. Use a new id for each request.`,
        { reason: 'duplicate_request_id' }
      );
    if (active.size >= maxPending) reap(Date.now());
    if (active.size >= maxPending)
      throw new BridgeError(
        ERROR_CODES.BRIDGE_BUSY,
        `The extension is running ${active.size} requests, its limit. Nothing was dispatched; retry shortly.`,
        { retryAfterMs: 500, inFlight: active.size, limit: maxPending }
      );
    const controller = new AbortController();
    const requested = request.meta?.deadline_ms;
    const deadline = Math.min(
      Date.now() + 122000,
      typeof requested === 'number' && Number.isFinite(requested) ? requested : Date.now() + 122000
    );
    const timer = setTimeout(() => controller.abort(error()), Math.max(0, deadline - Date.now()));
    timer.unref?.();
    const cancelers = new Set<() => void>();
    controller.signal.addEventListener(
      'abort',
      () => {
        for (const cancel of cancelers) cancel();
      },
      { once: true }
    );
    const lifetime = {
      artifactAck: request.meta?.artifact_ack === true,
      owner: String(request.meta?.transport_owner ?? ''),
      controller,
      deadline,
      timer,
      cancelers,
    };
    active.set(request.id, lifetime);
    return () => {
      clearTimeout(timer);
      if (active.get(request.id) === lifetime) active.delete(request.id);
    };
  }

  function guard(id: string, deadline?: unknown): () => void {
    const lifetime = active.get(key(id));
    return () => {
      if (
        (lifetime && (lifetime.controller.signal.aborted || Date.now() >= lifetime.deadline)) ||
        (typeof deadline === 'number' && Number.isFinite(deadline) && Date.now() >= deadline)
      )
        throw error();
    };
  }

  function isActive(id: string): boolean {
    const lifetime = active.get(key(id));
    return Boolean(lifetime && !lifetime.controller.signal.aborted);
  }
  function cancel(id: string) {
    active.get(key(id))?.controller.abort(error());
  }
  function track(id: string, cancel: () => void): () => void {
    const lifetime = active.get(key(id));
    if (!lifetime) return () => {};
    if (lifetime.controller.signal.aborted) cancel();
    else lifetime.cancelers.add(cancel);
    return () => {
      lifetime.cancelers.delete(cancel);
    };
  }
  function cancelOwner(owner: string) {
    for (const lifetime of active.values())
      if (lifetime.owner === owner) lifetime.controller.abort(error());
  }
  function disconnect() {
    for (const lifetime of active.values()) lifetime.controller.abort(error());
  }
  return {
    begin,
    guard,
    track,
    isActive,
    cancel,
    cancelOwner,
    disconnect,
    size: () => active.size,
    acknowledgesArtifacts: (id: string) => active.get(key(id))?.artifactAck === true,
  };
}

export const requestLifetimes = createRequestLifetimes();
