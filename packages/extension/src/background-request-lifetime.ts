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

/** Retain canceled work until it settles. Capacity cannot be reclaimed by
 * timing out a caller while its browser command is still running. */
export function createRequestLifetimes(maxPending = 128) {
  const active = new Map<string, Lifetime>();
  const key = (id: string) => id.split('#', 1)[0];
  const error = () =>
    new BridgeError(
      ERROR_CODES.TIMEOUT,
      'Request canceled or expired. Inspect postconditions before retrying a mutation.',
      { outcomeUncertain: true }
    );

  function begin(request: Request) {
    if (active.size >= maxPending || active.has(request.id))
      throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'Extension request capacity reached.');
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
    cancel,
    cancelOwner,
    disconnect,
    size: () => active.size,
    acknowledgesArtifacts: (id: string) => active.get(key(id))?.artifactAck === true,
  };
}

export const requestLifetimes = createRequestLifetimes();
