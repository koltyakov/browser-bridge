import {
  BridgeError,
  ERROR_CODES,
  METHOD_SET,
  isBatchSafeBridgeCall,
} from '../../../protocol/src/index.js';
import { requestLifetimes } from './background-request-lifetime.js';
import { isUnavailableDocumentError } from './background-helpers.js';

/** How long a timed-out mutation keeps its tab turn while its content command
 * is still running. A hung renderer never settles, so the turn is released. */
export const UNSETTLED_COMMAND_GRACE_MS = 15_000;

/** Pause before re-reading after a navigation interrupted a read. */
const NAVIGATION_RETRY_DELAY_MS = 250;

/** Longest one content-script injection may take before it counts as hung. */
export const SCRIPT_INJECTION_TIMEOUT_MS = 10_000;
/** Frame enumeration runs on every fan-out read, so it fails faster. */
const FRAME_DISCOVERY_TIMEOUT_MS = 5_000;

export type ContentScriptBridgeDeps = {
  contentScriptTimeoutMs: number;
  /** Override for tests; defaults to UNSETTLED_COMMAND_GRACE_MS. */
  unsettledCommandGraceMs?: number;
  /** Override for tests; defaults to SCRIPT_INJECTION_TIMEOUT_MS. */
  scriptInjectionTimeoutMs?: number;
  isRestrictedAutomationUrl: (url: string) => boolean;
  recordReinjection?: (outcome: 'success' | 'failure', group: string) => void;
};

const CONTENT_SCRIPT_FILES: string[] = [
  'src/content-script-helpers.js',
  'src/content-dom-baseline.js',
  'src/content-element-registry.js',
  'src/content-dom-query.js',
  'src/content-input.js',
  'src/content-patch.js',
  'src/content-script.js',
];
/** Detect Chrome scripting errors that indicate a restricted or unscriptable page. */
export function isRestrictedScriptingError(message: string): boolean {
  return (
    /Cannot access contents of/i.test(message) ||
    /The extensions gallery cannot be scripted/i.test(message) ||
    /Cannot access a chrome:\/\//i.test(message) ||
    /Cannot script/i.test(message) ||
    isUnavailableDocumentError(message)
  );
}

/** Chrome returns this when a tab is scriptable, but the current document does
not have our content-script listener anymore, commonly during reloads or SPA
document swaps between the preflight ping and the actual command. */
export function isMissingContentScriptReceiverError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /Could not establish connection/i.test(message) && /Receiving end does not exist/i.test(message)
  );
}

/** True when the document holding the content script went away while a
message was in flight: navigation into the back/forward cache or unload. */
export function isDocumentUnloadedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /back\/forward cache|message channel (?:is )?closed|message port closed before a response/i.test(
    message
  );
}

export function createContentScriptBridge(
  chromeObj: typeof globalThis.chrome,
  deps: ContentScriptBridgeDeps
): {
  sendTabMessage: (
    tabId: number,
    message: Record<string, unknown>,
    timeoutMs: number
  ) => Promise<unknown>;
  sendFrameMessage: (
    tabId: number,
    frameId: number,
    message: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ) => Promise<unknown>;
  listFrames: (
    tabId: number,
    options?: { refresh?: boolean }
  ) => Promise<Array<{ frameId: number; tag: string | null }>>;
  getFrameForRef: (tabId: number, elementRef: string) => Promise<number>;
  injectContentScriptsForWindow: (windowId: number) => Promise<void>;
  ensureContentScript: (tabId: number) => Promise<void>;
  getCleanupFrames: (tabId: number) => Promise<Array<{ frameId: number }>>;
  clearCleanupFrames: (tabId: number) => void;
  /** Forget a tab's frame list after navigation or a child frame load. */
  invalidateFrames: (tabId: number) => void;
  installNavigationSignals: (tabId: number, channel: string) => Promise<void>;
  uninstallNavigationSignals: (tabId: number, channel: string) => Promise<void>;
  /** Track page requests in one frame while an observed action settles. */
  installActivitySignals: (tabId: number, frameId: number, channel: string) => Promise<boolean>;
  uninstallActivitySignals: (tabId: number, frameId: number, channel: string) => Promise<void>;
} {
  const patchFrames = new Map<number, Set<number>>();
  const contentScriptChecks = new Map<number, Promise<void>>();
  const contentScriptRecoveries = new Map<number, Promise<void>>();
  function trackPatchFrame(tabId: number, frameId: number, message: Record<string, unknown>) {
    if (message.method !== 'patch.apply_styles' && message.method !== 'patch.apply_dom') return;
    const frames = patchFrames.get(tabId) ?? new Set<number>();
    if (
      (!patchFrames.has(tabId) && patchFrames.size >= 64) ||
      (!frames.has(frameId) && frames.size >= 64)
    )
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        'Patch frame capacity reached. Roll back patches before targeting more frames.'
      );
    frames.add(frameId);
    patchFrames.set(tabId, frames);
  }
  /** executeScript never settles for a hung renderer, and callers share
coalesced promises, so one stuck injection would block every later request
for the tab. Bound each call; the coalesced entry clears when it rejects. */
  function withScriptingDeadline<T>(
    operation: Promise<T>,
    stage: string,
    timeoutMs = deps.scriptInjectionTimeoutMs ?? SCRIPT_INJECTION_TIMEOUT_MS
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new BridgeError(
              ERROR_CODES.TIMEOUT,
              `Chrome did not finish ${stage} within ${timeoutMs} ms. The page may be busy or blocked by a dialog; the next request tries again.`,
              { stage }
            )
          ),
        timeoutMs
      );
    });
    operation.catch(() => {});
    return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
  }

  async function injectContentScript(tabId: number): Promise<void> {
    try {
      await withScriptingDeadline(
        chromeObj.scripting.executeScript({
          target: { tabId },
          files: CONTENT_SCRIPT_FILES,
        }),
        'content script injection'
      );
    } catch (injectError) {
      const msg = injectError instanceof Error ? injectError.message : String(injectError);
      if (isRestrictedScriptingError(msg)) {
        throw new BridgeError(
          ERROR_CODES.CONTENT_SCRIPT_UNAVAILABLE,
          'Content script not available on this page (restricted or extension page).',
          { cause: injectError instanceof Error ? injectError.message : String(injectError) }
        );
      }
      throw injectError;
    }
  }

  function recoverContentScript(tabId: number): Promise<void> {
    const pending = contentScriptRecoveries.get(tabId);
    if (pending) return pending;
    // Preflights and missing-receiver retries can race in the same batch.
    // Share only the injection, never an executable command or its result.
    const recovery = (async () => {
      try {
        await injectContentScript(tabId);
        deps.recordReinjection?.('success', String(tabId));
      } catch (error) {
        deps.recordReinjection?.('failure', String(tabId));
        throw error;
      }
    })().finally(() => contentScriptRecoveries.delete(tabId));
    contentScriptRecoveries.set(tabId, recovery);
    return recovery;
  }

  /** Install idempotent history hooks in the page's MAIN world. The hooks only
emit navigation-kind events; the background re-reads the authoritative URL. */
  async function installNavigationSignals(tabId: number, channel: string): Promise<void> {
    let isolatedInstalled = false;
    try {
      await chromeObj.scripting.executeScript({
        target: { tabId },
        func: installIsolatedNavigationSignals,
        args: [channel],
      });
      isolatedInstalled = true;
      await chromeObj.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: installMainNavigationSignals,
        args: [channel],
      });
    } catch (error) {
      if (isolatedInstalled) await uninstallNavigationSignals(tabId, channel);
      throw error;
    }
  }

  async function uninstallNavigationSignals(tabId: number, channel: string): Promise<void> {
    await Promise.allSettled([
      chromeObj.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: uninstallMainNavigationSignals,
        args: [channel],
      }),
      chromeObj.scripting.executeScript({
        target: { tabId },
        func: uninstallIsolatedNavigationSignals,
        args: [channel],
      }),
    ]);
  }

  /** Send a message to the content script and fail fast if it does not respond. */
  async function sendTabMessage(
    tabId: number,
    message: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    try {
      return await sendTabMessageWithTimeout(tabId, message, timeoutMs, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (isNavigationInterruptedRead(error, message)) {
        // A read that raced a navigation has no side effects: let the new
        // document commit, inject into it, and read once more.
        await new Promise((resolve) => setTimeout(resolve, NAVIGATION_RETRY_DELAY_MS));
        if (signal?.aborted) throw error;
        await recoverContentScript(tabId);
        return await sendTabMessageWithTimeout(tabId, message, timeoutMs, signal);
      }
      if (!isMissingContentScriptReceiverError(error)) {
        throw error;
      }
      await recoverContentScript(tabId);
      return await sendTabMessageWithTimeout(tabId, message, timeoutMs, signal);
    }
  }

  /** A batch-safe read whose document unloaded before it answered. */
  function isNavigationInterruptedRead(error: unknown, message: Record<string, unknown>): boolean {
    if (!(error instanceof BridgeError) || error.code !== ERROR_CODES.CONTENT_SCRIPT_UNAVAILABLE) {
      return false;
    }
    const details = error.details as { reason?: unknown } | null | undefined;
    if (details?.reason !== 'document_unloaded' || message.type !== 'bridge.execute') return false;
    const method = String(
      message.method ?? ''
    ) as import('../../../protocol/src/types.js').BridgeMethod;
    const params =
      message.params && typeof message.params === 'object'
        ? (message.params as Record<string, unknown>)
        : {};
    return METHOD_SET.has(method) && isBatchSafeBridgeCall(method, params);
  }

  async function sendTabMessageWithTimeout(
    tabId: number,
    message: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    trackPatchFrame(tabId, 0, message);
    return sendMessageWithTimeout(tabId, 0, message, timeoutMs, signal);
  }

  async function sendMessageWithTimeout(
    tabId: number,
    frameId: number,
    message: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    const executable = message.type === 'bridge.execute';
    const requestId =
      typeof message.requestId === 'string'
        ? message.requestId
        : executable
          ? crypto.randomUUID()
          : '';
    const deadlineMs = Math.min(
      Date.now() + timeoutMs,
      typeof message.deadlineMs === 'number' && Number.isFinite(message.deadlineMs)
        ? message.deadlineMs
        : Infinity
    );
    const payload = executable ? { ...message, requestId, deadlineMs } : message;
    const method = String(
      message.method ?? ''
    ) as import('../../../protocol/src/types.js').BridgeMethod;
    const params =
      message.params && typeof message.params === 'object'
        ? (message.params as Record<string, unknown>)
        : {};
    const awaitSettlement =
      executable && (!METHOD_SET.has(method) || !isBatchSafeBridgeCall(method, params));
    const assertActive = requestLifetimes.guard(requestId, deadlineMs);
    assertActive();
    let canceled = false;
    const cancel = () => {
      if (!executable || canceled) return;
      canceled = true;
      void chromeObj.tabs
        .sendMessage(tabId, { type: 'bridge.cancel', requestId }, { frameId })
        .catch(() => {});
    };
    signal?.throwIfAborted();
    signal?.addEventListener('abort', cancel, { once: true });
    const untrack = requestLifetimes.track(requestId, cancel);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => {
          timedOut = true;
          cancel();
          reject(
            new BridgeError(
              ERROR_CODES.TIMEOUT,
              `Timed out waiting for ${frameId === 0 ? 'content script response' : `frame ${frameId}`} after ${timeoutMs}ms.`,
              { outcomeUncertain: awaitSettlement }
            )
          );
        },
        Math.max(0, deadlineMs - Date.now())
      );
    });
    // Keep cancellation attached to the real operation, not the timeout race.
    const operation = Promise.resolve()
      .then(() => {
        signal?.throwIfAborted();
        assertActive();
        return chromeObj.tabs.sendMessage(tabId, payload, { frameId });
      })
      .finally(untrack);
    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      // A caller timing out does not mean a mutation has stopped. Hold its
      // debugger/scheduler turn until the original content command settles,
      // but not past the grace period: an unresponsive page never settles.
      if (!timedOut && isDocumentUnloadedError(error)) {
        // The page navigated away mid-call. Report it as a typed, recoverable
        // condition; a mutation's outcome stays uncertain.
        throw new BridgeError(
          ERROR_CODES.CONTENT_SCRIPT_UNAVAILABLE,
          'The page navigated before the content script answered.',
          {
            reason: 'document_unloaded',
            ...(awaitSettlement ? { outcomeUncertain: true } : {}),
          }
        );
      }
      if (timedOut && awaitSettlement) {
        let graceId: ReturnType<typeof setTimeout> | undefined;
        const grace = new Promise<void>((resolve) => {
          graceId = setTimeout(resolve, deps.unsettledCommandGraceMs ?? UNSETTLED_COMMAND_GRACE_MS);
        });
        await Promise.race([
          operation.then(
            () => {},
            () => {}
          ),
          grace,
        ]);
        clearTimeout(graceId);
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      clearTimeout(timeoutId);
    }
  }

  type Frame = { frameId: number; tag: string | null };
  const frameCache = new Map<number, { at: number; frames: Frame[] }>();
  const frameDiscoveries = new Map<number, Promise<Frame[]>>();
  /** Child frames that stayed unscriptable after injection (other extensions'
   * pages, sandboxed frames), so discovery does not retry them every time. */
  const uninjectableFrames = new Map<number, Set<number>>();
  const FRAME_CACHE_TTL_MS = 3_000;
  const MAX_SCRIPTED_FRAMES = 12;
  const MAX_REMEMBERED_UNINJECTABLE_FRAMES = 256;

  /** Enumerate scriptable frames and their element-ref tags. Child frames are
injected on demand so their DOM is reachable (including cross-origin
frames, which `<all_urls>` host access permits). */
  function listFrames(tabId: number, options: { refresh?: boolean } = {}): Promise<Frame[]> {
    return listAllFrames(tabId, options).then((frames) => frames.slice(0, MAX_SCRIPTED_FRAMES));
  }

  /** Every frame Chrome reported, ranked: the top frame, frames whose content
script answered, then the rest. Fan-out reads use the first
MAX_SCRIPTED_FRAMES; ref routing searches all of them. */
  function listAllFrames(tabId: number, options: { refresh?: boolean } = {}): Promise<Frame[]> {
    const pending = frameDiscoveries.get(tabId);
    if (pending) return pending;
    const cached = frameCache.get(tabId);
    if (!options.refresh && cached && Date.now() - cached.at < FRAME_CACHE_TTL_MS) {
      return Promise.resolve(cached.frames);
    }

    const discovery = discoverFrames(tabId)
      .then((frames) => {
        // Cleanup may invalidate this lookup while Chrome is still responding.
        if (frameDiscoveries.get(tabId) === discovery) {
          frameCache.set(tabId, { at: Date.now(), frames });
          while (frameCache.size > 64) {
            const oldest = frameCache.keys().next().value;
            if (oldest === undefined) break;
            frameCache.delete(oldest);
          }
        }
        return frames;
      })
      .finally(() => {
        if (frameDiscoveries.get(tabId) === discovery) frameDiscoveries.delete(tabId);
      });
    frameDiscoveries.set(tabId, discovery);
    return discovery;
  }

  async function discoverFrames(tabId: number): Promise<Frame[]> {
    const read = async (): Promise<Frame[]> => {
      const results = await withScriptingDeadline(
        chromeObj.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: readFrameRefTag,
        }),
        'frame discovery',
        FRAME_DISCOVERY_TIMEOUT_MS
      );
      return (results ?? [])
        .filter((entry) => typeof entry?.frameId === 'number')
        .map((entry) => ({
          frameId: entry.frameId,
          tag: typeof entry.result === 'string' ? entry.result : null,
        }));
    };
    const rank = (frames: Frame[]): Frame[] =>
      [...frames].sort(
        (a, b) =>
          Number(b.frameId === 0) - Number(a.frameId === 0) ||
          Number(b.tag !== null) - Number(a.tag !== null)
      );
    // Another extension's frame (chrome-extension://) makes the whole
    // allFrames read fail. Fall back to the frames known from the last
    // discovery, read one at a time, and leave out the ones that fail.
    const readKnownFrames = async (): Promise<Frame[]> => {
      const known = frameCache.get(tabId)?.frames ?? [];
      const ids = [0, ...known.map((frame) => frame.frameId).filter((id) => id !== 0)];
      const results = await Promise.all(
        ids.map(async (frameId) => {
          try {
            const [entry] = await withScriptingDeadline(
              chromeObj.scripting.executeScript({
                target: { tabId, frameIds: [frameId] },
                func: readFrameRefTag,
              }),
              'frame discovery',
              FRAME_DISCOVERY_TIMEOUT_MS
            );
            return { frameId, tag: typeof entry?.result === 'string' ? entry.result : null };
          } catch {
            return frameId === 0 ? { frameId: 0, tag: null } : null;
          }
        })
      );
      return results.filter((frame): frame is Frame => frame !== null);
    };
    let frames: Frame[] = [];
    try {
      frames = await read().catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!/Cannot access a chrome-extension:\/\//i.test(message)) throw error;
        return readKnownFrames();
      });
      const skipped = uninjectableFrames.get(tabId) ?? new Set<number>();
      const frameIds = frames
        .filter((frame) => frame.frameId !== 0 && frame.tag === null && !skipped.has(frame.frameId))
        .map((frame) => frame.frameId)
        .slice(0, MAX_SCRIPTED_FRAMES);
      if (frameIds.length) {
        await withScriptingDeadline(
          chromeObj.scripting.executeScript({
            target: { tabId, frameIds },
            files: CONTENT_SCRIPT_FILES,
          }),
          'frame content script injection',
          FRAME_DISCOVERY_TIMEOUT_MS
        ).catch(() => {});
        frames = await read();
        for (const frame of frames) {
          if (!frameIds.includes(frame.frameId) || frame.tag !== null) continue;
          if (skipped.size >= MAX_REMEMBERED_UNINJECTABLE_FRAMES) break;
          skipped.add(frame.frameId);
        }
        if (skipped.size) uninjectableFrames.set(tabId, skipped);
      }
    } catch {
      frames = [{ frameId: 0, tag: null }];
    }
    return rank(frames);
  }

  /** Find the frame that minted an element ref (refs embed a per-document tag). */
  async function getFrameForRef(tabId: number, elementRef: string): Promise<number> {
    const tag = /^el_([0-9a-z]{4})_/.exec(elementRef)?.[1];
    if (!tag) return 0;
    for (const refresh of [false, true]) {
      const frames = await listAllFrames(tabId, { refresh });
      const owner = frames.find((frame) => frame.tag === tag);
      if (owner) return owner.frameId;
    }
    return 0;
  }

  async function sendFrameMessage(
    tabId: number,
    frameId: number,
    message: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (frameId === 0) return sendTabMessage(tabId, message, timeoutMs, signal);
    trackPatchFrame(tabId, frameId, message);
    return sendMessageWithTimeout(tabId, frameId, message, timeoutMs, signal);
  }

  /** Ensure the content script is present on the target tab before issuing
content-script-backed requests. This makes page operations resilient after
extension reloads or on tabs that predate the current extension version. */
  function ensureContentScript(tabId: number): Promise<void> {
    const pending = contentScriptChecks.get(tabId);
    if (pending) return pending;
    // Coalesce overlapping checks without caching readiness across navigation.
    const check = (async () => {
      try {
        await sendTabMessageWithTimeout(
          tabId,
          { type: 'bridge.ping' },
          deps.contentScriptTimeoutMs
        );
      } catch {
        await recoverContentScript(tabId);
      }
    })().finally(() => contentScriptChecks.delete(tabId));
    contentScriptChecks.set(tabId, check);
    return check;
  }

  /** Prepare the window's active tab when Bridge access is enabled, so the
first request there skips injection. Other tabs are injected on demand by
ensureContentScript; injecting every tab of a large window at once costs
renderer time in pages the agent may never touch. */
  async function injectContentScriptsForWindow(windowId: number): Promise<void> {
    const tabs = await chromeObj.tabs.query({ windowId });
    await Promise.allSettled(
      tabs
        .filter((tab) => tab.active !== false)
        .map((tab) =>
          typeof tab.id === 'number' &&
          Number.isFinite(tab.id) &&
          tab.url &&
          !deps.isRestrictedAutomationUrl(tab.url)
            ? tab.id
            : null
        )
        .filter((tabId) => tabId !== null)
        .map((tabId) => ensureContentScript(tabId))
    );
  }

  return {
    sendTabMessage,
    sendFrameMessage,
    listFrames,
    getFrameForRef,
    injectContentScriptsForWindow,
    ensureContentScript,
    getCleanupFrames: async (tabId) => {
      const frames = new Set(patchFrames.get(tabId));
      // Content registries survive a worker restart. Read only a boolean in
      // every existing frame so restored cleanup cannot miss old child patches
      // or a touched frame displaced from the bounded discovery list.
      try {
        const results = await chromeObj.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: frameHasPatches,
        });
        for (const result of results) if (result.result === true) frames.add(result.frameId);
      } catch (error) {
        if (
          !isRestrictedScriptingError(String(error)) &&
          !/No tab|not found|frame.*removed/iu.test(String(error))
        )
          throw error;
      }
      return [...frames].map((frameId) => ({ frameId }));
    },
    clearCleanupFrames: (tabId) => {
      patchFrames.delete(tabId);
      frameCache.delete(tabId);
      frameDiscoveries.delete(tabId);
      uninjectableFrames.delete(tabId);
    },
    invalidateFrames: (tabId) => {
      // A navigated document gets new frames, and a reloaded child frame needs
      // its content script again; a cached list would route probes to neither.
      frameCache.delete(tabId);
      frameDiscoveries.delete(tabId);
      uninjectableFrames.delete(tabId);
    },
    installNavigationSignals,
    uninstallNavigationSignals,
    installActivitySignals: async (tabId, frameId, channel) => {
      try {
        await chromeObj.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          world: 'MAIN',
          func: installMainActivitySignals,
          args: [channel],
        });
        return true;
      } catch {
        // Restricted pages keep the fixed observation window.
        return false;
      }
    },
    uninstallActivitySignals: async (tabId, frameId, channel) => {
      await chromeObj.scripting
        .executeScript({
          target: { tabId, frameIds: [frameId] },
          world: 'MAIN',
          func: uninstallMainActivitySignals,
          args: [channel],
        })
        .catch(() => {});
    },
  };
}

/** Injected into every frame to report the frame's element-ref tag (or null
when Browser Bridge content scripts are not loaded there yet). */
export function readFrameRefTag(): string | null {
  const registry = (
    globalThis as unknown as { __BBX_CONTENT_REGISTRY__?: { refDocumentTag?: unknown } }
  ).__BBX_CONTENT_REGISTRY__;
  return typeof registry?.refDocumentTag === 'string' ? registry.refDocumentTag : null;
}

/** Tiny isolated-world probe for rollback after a service-worker restart. */
export function frameHasPatches(): boolean {
  const registry = Reflect.get(globalThis, '__BBX_CONTENT_REGISTRY__') as
    | { getPatchRegistry?: () => Map<unknown, unknown> }
    | undefined;
  return Boolean(registry?.getPatchRegistry?.().size);
}

/** Install the isolated-world half of one randomized navigation signal channel.
The page cannot access this world's registry. Reinstallation first removes
the prior listeners, preventing duplicate or half-installed state. */
export function installIsolatedNavigationSignals(channel: string): void {
  const scope = window as Window &
    typeof globalThis & { __BBX_NAVIGATION_CLEANUPS__?: Map<string, () => void> };
  const cleanups = scope.__BBX_NAVIGATION_CLEANUPS__ ?? new Map();
  scope.__BBX_NAVIGATION_CLEANUPS__ = cleanups;
  cleanups.get(channel)?.();
  scope.__BBX_NAVIGATION_CLEANUPS__ = cleanups;

  const listeners: Array<{ eventName: string; listener: () => void }> = [];
  for (const kind of ['pushState', 'replaceState', 'popstate', 'hashchange'] as const) {
    const eventName = `bbx:navigation:${channel}:${kind}`;
    const listener = () => {
      void chrome.runtime
        .sendMessage({ type: 'bridge.navigation-signal', channel, kind })
        .catch(() => {});
    };
    window.addEventListener(eventName, listener);
    listeners.push({ eventName, listener });
  }
  cleanups.set(channel, () => {
    for (const { eventName, listener } of listeners) {
      window.removeEventListener(eventName, listener);
    }
    cleanups.delete(channel);
    if (cleanups.size === 0) delete scope.__BBX_NAVIGATION_CLEANUPS__;
  });
}

export function uninstallIsolatedNavigationSignals(channel: string): void {
  const scope = window as Window &
    typeof globalThis & { __BBX_NAVIGATION_CLEANUPS__?: Map<string, () => void> };
  scope.__BBX_NAVIGATION_CLEANUPS__?.get(channel)?.();
}

/** Install reversible MAIN-world hooks without writing a page-visible marker.
A randomized uninstall event owns the closure that contains original methods. */
export function installMainNavigationSignals(channel: string): void {
  const eventPrefix = `bbx:navigation:${channel}`;
  const uninstallEvent = `${eventPrefix}:uninstall`;
  window.dispatchEvent(new Event(uninstallEvent));

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  const signal = (kind: 'pushState' | 'replaceState' | 'popstate' | 'hashchange') =>
    window.dispatchEvent(new Event(`${eventPrefix}:${kind}`));

  const wrappedPushState: History['pushState'] = function (data, unused, url) {
    originalPushState.call(history, data, unused, url);
    signal('pushState');
  };

  const wrappedReplaceState: History['replaceState'] = function (data, unused, url) {
    originalReplaceState.call(history, data, unused, url);
    signal('replaceState');
  };
  const onPopState = () => signal('popstate');
  const onHashChange = () => signal('hashchange');
  const restore = () => {
    if (history.pushState === wrappedPushState) history.pushState = originalPushState;
    if (history.replaceState === wrappedReplaceState) history.replaceState = originalReplaceState;
    window.removeEventListener('popstate', onPopState);
    window.removeEventListener('hashchange', onHashChange);
    window.removeEventListener(uninstallEvent, restore);
  };

  window.addEventListener(uninstallEvent, restore, { once: true });
  try {
    history.pushState = wrappedPushState;
    history.replaceState = wrappedReplaceState;
    window.addEventListener('popstate', onPopState);
    window.addEventListener('hashchange', onHashChange);
  } catch (error) {
    restore();
    throw error;
  }
}

export function uninstallMainNavigationSignals(channel: string): void {
  window.dispatchEvent(new Event(`bbx:navigation:${channel}:uninstall`));
}

/** Count page fetch/XHR requests while one observed action settles. Like the
navigation hooks, a randomized uninstall event owns the original methods and no
page-visible marker is written. The isolated world sees `start`/`end` events
and confirms installation with a synchronous `ping`/`pong`. */
export function installMainActivitySignals(channel: string): void {
  const eventPrefix = `bbx:activity:${channel}`;
  const uninstallEvent = `${eventPrefix}:uninstall`;
  window.dispatchEvent(new Event(uninstallEvent));

  const emit = (kind: 'start' | 'end' | 'pong') =>
    window.dispatchEvent(new Event(`${eventPrefix}:${kind}`));
  const track = () => {
    let settled = false;
    emit('start');
    return () => {
      if (settled) return;
      settled = true;
      emit('end');
    };
  };
  const originalFetch = window.fetch;
  const originalSend = XMLHttpRequest.prototype.send;
  const wrappedFetch: typeof window.fetch = function (input, init) {
    const done = track();
    try {
      const response = Reflect.apply(originalFetch, window, [input, init]) as Promise<Response>;
      response.then(done, done);
      return response;
    } catch (error) {
      done();
      throw error;
    }
  };
  const wrappedSend: XMLHttpRequest['send'] = function (this: XMLHttpRequest, body) {
    const done = track();
    this.addEventListener('loadend', done, { once: true });
    try {
      return Reflect.apply(originalSend, this, [body]) as void;
    } catch (error) {
      done();
      throw error;
    }
  };
  const onPing = () => emit('pong');
  const restore = () => {
    if (window.fetch === wrappedFetch) window.fetch = originalFetch;
    if (XMLHttpRequest.prototype.send === wrappedSend) XMLHttpRequest.prototype.send = originalSend;
    window.removeEventListener(`${eventPrefix}:ping`, onPing);
    window.removeEventListener(uninstallEvent, restore);
  };

  window.addEventListener(uninstallEvent, restore, { once: true });
  try {
    window.fetch = wrappedFetch;
    XMLHttpRequest.prototype.send = wrappedSend;
    window.addEventListener(`${eventPrefix}:ping`, onPing);
  } catch (error) {
    restore();
    throw error;
  }
}

export function uninstallMainActivitySignals(channel: string): void {
  window.dispatchEvent(new Event(`bbx:activity:${channel}:uninstall`));
}
