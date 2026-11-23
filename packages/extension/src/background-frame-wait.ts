import { BridgeError, createSuccess, ERROR_CODES } from '../../../protocol/src/index.js';
import { isMissingContentScriptReceiverError } from './background-content-script.js';
import { isUnavailableDocumentError } from './background-helpers.js';
import { requestLifetimes } from './background-request-lifetime.js';
import type {
  BridgeRequest,
  BridgeResponse,
  TabBoundRequestDependencies,
} from './background-tab-bound.js';

const waitingTabs = new Map<number, Set<() => void>>();

/** A content signal is only a hint. The next Chrome enumeration supplies the
 * frame IDs and document tags; unrelated tabs and completed waits do no work. */
export function notifyFrameWaits(tabId: number): void {
  for (const wake of waitingTabs.get(tabId) ?? []) wake();
}

/** Keep one content-side DOM observer per current document. Rediscovery only
 * installs watchers for new/replaced documents; it never rescans a stable frame. */
export function waitAcrossFrames(
  request: BridgeRequest,
  params: Record<string, unknown>,
  tabId: number,
  frames: NonNullable<TabBoundRequestDependencies['frames']>,
  toFailure: TabBoundRequestDependencies['toFailureResponse'],
  assertAccess: () => void
): Promise<BridgeResponse> {
  const started = performance.now();
  const deadline = started + Number(params.timeoutMs);
  const watches = new Map<number, { tag?: string | null; controller: AbortController }>();
  return new Promise((resolve, reject) => {
    let done = false;
    let generation = 0;
    let refresh: ReturnType<typeof setTimeout>;
    let discovering = false;
    let changed = false;
    const listeners = waitingTabs.get(tabId) ?? new Set<() => void>();
    waitingTabs.set(tabId, listeners);
    listeners.add(frameChanged);
    function frameChanged() {
      if (done || changed) return;
      changed = true;
      if (!discovering) {
        clearTimeout(refresh);
        refresh = setTimeout(() => void discover(), 16);
      }
    }
    const elapsed = () => Math.round(performance.now() - started);
    const timeout = setTimeout(
      () =>
        finish(() =>
          createSuccess(
            request.id,
            {
              found: false,
              elementRef: null,
              duration: elapsed(),
            },
            { method: request.method }
          )
        ),
      Number(params.timeoutMs)
    );
    let untrack = () => {};
    function finish(result: () => BridgeResponse) {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      clearTimeout(refresh);
      listeners.delete(frameChanged);
      if (!listeners.size) waitingTabs.delete(tabId);
      untrack();
      for (const watch of watches.values()) watch.controller.abort();
      watches.clear();
      try {
        assertAccess();
        resolve(result());
      } catch (error) {
        reject(error);
      }
    }
    function fail(error: unknown) {
      finish(() => {
        throw error;
      });
    }
    function watchFrame(frameId: number, tag?: string | null) {
      const previous = watches.get(frameId);
      if (previous && (previous.tag === undefined || previous.tag === tag)) {
        previous.tag = tag;
        return;
      }
      previous?.controller.abort();
      const controller = new AbortController();
      const watch = { controller, tag };
      watches.set(frameId, watch);
      const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
      void frames
        .sendFrameMessage(
          tabId,
          frameId,
          {
            type: 'bridge.execute',
            method: request.method,
            watchFrameTree: true,
            requestId: `${request.id}#watch${++generation}`,
            deadlineMs: request.meta?.deadline_ms,
            params: { ...params, timeoutMs: remaining },
          },
          remaining + 2000,
          controller.signal
        )
        .then((result) => {
          if (done || watches.get(frameId) !== watch) return;
          if (!result || typeof result !== 'object') return;
          if ('error' in result) {
            finish(() => toFailure(request, result.error));
          } else if ('found' in result && result.found === true) {
            watches.delete(frameId);
            finish(() =>
              createSuccess(
                request.id,
                {
                  ...result,
                  duration: elapsed(),
                  ...(frameId ? { frameId } : {}),
                },
                { method: request.method }
              )
            );
          }
        })
        .catch((error: unknown) => {
          if (done || watches.get(frameId) !== watch) return;
          watches.delete(frameId);
          // Navigation can close a content message port before the replacement
          // document is ready. Only transport loss gets a new watcher.
          if (
            !isMissingContentScriptReceiverError(error) &&
            !isUnavailableDocumentError(String(error)) &&
            !/message (?:port|channel) closed/i.test(String(error))
          ) {
            fail(error);
          } else if (watch.tag && !isMissingContentScriptReceiverError(error)) {
            // A previously armed document disappeared, e.g. a frame navigated
            // itself. Do not spin on frames that simply lack a receiver.
            frameChanged();
          }
        });
    }
    async function discover() {
      if (done) return;
      discovering = true;
      changed = false;
      try {
        assertAccess();
        const current = await frames.listFrames(tabId, { refresh: true });
        if (done) return;
        assertAccess();
        for (const [id, watch] of watches) {
          if (id !== 0 && !current.some((frame) => frame.frameId === id)) {
            watches.delete(id);
            watch.controller.abort();
          }
        }
        watchFrame(0, current.find((frame) => frame.frameId === 0)?.tag);
        for (const frame of current) if (frame.frameId !== 0) watchFrame(frame.frameId, frame.tag);
        // Leave one last discovery near the deadline even for sub-second waits.
        const untilFinalCheck = deadline - performance.now() - 50;
        if (changed) {
          // Attachment/navigation raced the Chrome snapshot. Re-enumerate
          // once even if several hints arrived while it was in flight.
          refresh = setTimeout(() => void discover(), 16);
        } else if (untilFinalCheck > 5)
          refresh = setTimeout(() => void discover(), Math.min(500, Math.ceil(untilFinalCheck)));
      } catch (error) {
        fail(error);
      } finally {
        discovering = false;
      }
    }
    untrack = requestLifetimes.track(request.id, () =>
      finish(() => {
        throw new BridgeError(
          ERROR_CODES.REQUEST_CANCELED,
          'The frame wait was canceled before a frame matched.',
          { stage: 'frame_wait' }
        );
      })
    );
    if (!done) {
      watchFrame(0);
      refresh = setTimeout(() => void discover(), 0);
    }
  });
}
