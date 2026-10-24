import { BridgeError, ERROR_CODES } from '../../../protocol/src/index.js';
import { requestLifetimes } from './background-request-lifetime.js';

type BridgeRequest = import('../../../protocol/src/types.js').BridgeRequest;
type Target = { tabId: number; windowId: number; url: string };
type Snapshot = { documentId: string; url: string };
export type SnapshotScope = 'document' | 'tab';

/** Navigation replaces the document, so it is checked at tab level. Reading the
 * page would hang on the unresponsive renderer that navigation must recover. */
export function mutationSnapshotScope(method: string): SnapshotScope {
  return method.startsWith('navigation.') ? 'tab' : 'document';
}

/** A native scheduling grant is not permission. Capture the existing window
 * grant, pin the resolved tab, and recheck the committed document after waiting. */
export function createMutationGate(dependencies: {
  resolveTarget: (request: BridgeRequest) => Promise<Target>;
  captureAccess: () => () => void;
  snapshot: (tabId: number, scope: SnapshotScope) => Promise<Snapshot>;
  send: (message: import('../../../protocol/src/types.js').MutationReadyMessage) => void;
}) {
  const waiting = new Map<
    string,
    { tabId: number; grant: () => void; reject: (error: unknown) => void }
  >();

  async function prepare(request: BridgeRequest): Promise<BridgeRequest> {
    if (request.meta.mutation_schedule !== true) return request;
    const assertAccess = dependencies.captureAccess();
    const assertActive = requestLifetimes.guard(request.id, request.meta.deadline_ms);
    const scope = mutationSnapshotScope(request.method);
    // A snapshot only reads the page, so cancellation may abandon it. Without
    // this, a hung renderer would hold the request lifetime indefinitely.
    const snapshotUntilCanceled = (tabId: number) =>
      new Promise<Snapshot>((resolve, reject) => {
        const untrack = requestLifetimes.track(request.id, () =>
          reject(
            new BridgeError(ERROR_CODES.TIMEOUT, 'Mutation preparation canceled.', {
              dispatched: false,
            })
          )
        );
        dependencies.snapshot(tabId, scope).then(resolve, reject).finally(untrack);
      });
    const target = await dependencies.resolveTarget(request);
    assertAccess();
    assertActive();
    let untrack = () => {};
    let snapshot: Snapshot;
    try {
      // Report the tab before reading the page. The daemon orders later
      // mutations behind one whose tab it does not know, so a hung renderer
      // would otherwise stall every tab. The read also overlaps the round trip.
      const granted = new Promise<void>((resolve, reject) => {
        waiting.set(request.id, { tabId: target.tabId, grant: resolve, reject });
        untrack = requestLifetimes.track(request.id, () =>
          reject(
            new BridgeError(
              ERROR_CODES.TIMEOUT,
              'Queued mutation canceled. Inspect postconditions before retrying.',
              { outcomeUncertain: true }
            )
          )
        );
        assertActive();
        dependencies.send({
          type: 'host.mutation_ready',
          requestId: request.id,
          tabId: target.tabId,
        });
      });
      [snapshot] = await Promise.all([snapshotUntilCanceled(target.tabId), granted]);
    } finally {
      waiting.delete(request.id);
      untrack();
    }
    assertAccess();
    assertActive();
    const current = await snapshotUntilCanceled(target.tabId);
    assertAccess();
    assertActive();
    if (current.documentId !== snapshot.documentId || current.url !== snapshot.url) {
      throw new BridgeError(
        ERROR_CODES.TAB_MISMATCH,
        'The document changed while this mutation was queued. Inspect the current page before issuing a new action.',
        { reason: 'queued_document_changed', dispatched: false }
      );
    }
    return { ...request, tab_id: target.tabId };
  }

  function handle(message: unknown): boolean {
    if (
      !message ||
      typeof message !== 'object' ||
      !('type' in message) ||
      message.type !== 'host.mutation_granted'
    )
      return false;
    if ('requestId' in message && typeof message.requestId === 'string')
      waiting.get(message.requestId)?.grant();
    return true;
  }

  function invalidate(tabId: number): void {
    for (const entry of waiting.values()) {
      if (entry.tabId === tabId)
        entry.reject(
          new BridgeError(
            ERROR_CODES.TAB_MISMATCH,
            'The queued mutation target navigated, moved, or closed. Inspect the current page before issuing a new action.',
            { reason: 'queued_document_changed', dispatched: false }
          )
        );
    }
  }

  return { prepare, handle, invalidate };
}
