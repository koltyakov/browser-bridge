import {
  BridgeError,
  ERROR_CODES,
  METHOD_SET,
  isBatchSafeBridgeCall,
} from '../../../protocol/src/index.js';
import { requestLifetimes } from './background-request-lifetime.js';

/** How long a timed-out mutation keeps its tab turn while its content command
 * is still running. A hung renderer never settles, so the turn is released. */
export const UNSETTLED_COMMAND_GRACE_MS = 15_000;

export type ContentScriptBridgeDeps = {
  contentScriptTimeoutMs: number;
  /** Override for tests; defaults to UNSETTLED_COMMAND_GRACE_MS. */
  unsettledCommandGraceMs?: number;
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
    /Cannot script/i.test(message)
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
    timeoutMs: number
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
  installNavigationSignals: (tabId: number, channel: string) => Promise<void>;
  uninstallNavigationSignals: (tabId: number, channel: string) => Promise<void>;
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
  async function injectContentScript(tabId: number): Promise<void> {
    try {
      await chromeObj.scripting.executeScript({
        target: { tabId },
        files: CONTENT_SCRIPT_FILES,
      });
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
    timeoutMs: number
  ): Promise<unknown> {
    try {
      return await sendTabMessageWithTimeout(tabId, message, timeoutMs);
    } catch (error) {
      if (!isMissingContentScriptReceiverError(error)) {
        throw error;
      }
      await recoverContentScript(tabId);
      return await sendTabMessageWithTimeout(tabId, message, timeoutMs);
    }
  }

  async function sendTabMessageWithTimeout(
    tabId: number,
    message: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown> {
    trackPatchFrame(tabId, 0, message);
    return sendMessageWithTimeout(tabId, 0, message, timeoutMs);
  }

  async function sendMessageWithTimeout(
    tabId: number,
    frameId: number,
    message: Record<string, unknown>,
    timeoutMs: number
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
      clearTimeout(timeoutId);
    }
  }

  type Frame = { frameId: number; tag: string | null };
  const frameCache = new Map<number, { at: number; frames: Frame[] }>();
  const frameDiscoveries = new Map<number, Promise<Frame[]>>();
  const FRAME_CACHE_TTL_MS = 3_000;
  const MAX_SCRIPTED_FRAMES = 12;

  /** Enumerate scriptable frames and their element-ref tags. Child frames are
injected on demand so their DOM is reachable (including cross-origin
frames, which `<all_urls>` host access permits). */
  function listFrames(tabId: number, options: { refresh?: boolean } = {}): Promise<Frame[]> {
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
      const results = await chromeObj.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: readFrameRefTag,
      });
      return (results ?? [])
        .filter((entry) => typeof entry?.frameId === 'number')
        .map((entry) => ({
          frameId: entry.frameId,
          tag: typeof entry.result === 'string' ? entry.result : null,
        }))
        .slice(0, MAX_SCRIPTED_FRAMES);
    };
    let frames = [];
    try {
      frames = await read();
      if (frames.some((frame) => frame.frameId !== 0 && frame.tag === null)) {
        const frameIds = frames
          .filter((frame) => frame.frameId !== 0 && frame.tag === null)
          .map((frame) => frame.frameId);
        await chromeObj.scripting
          .executeScript({ target: { tabId, frameIds }, files: CONTENT_SCRIPT_FILES })
          .catch(() => {});
        frames = await read();
      }
    } catch {
      frames = [{ frameId: 0, tag: null }];
    }
    return frames;
  }

  /** Find the frame that minted an element ref (refs embed a per-document tag). */
  async function getFrameForRef(tabId: number, elementRef: string): Promise<number> {
    const tag = /^el_([0-9a-z]{4})_/.exec(elementRef)?.[1];
    if (!tag) return 0;
    for (const refresh of [false, true]) {
      const frames = await listFrames(tabId, { refresh });
      const owner = frames.find((frame) => frame.tag === tag);
      if (owner) return owner.frameId;
    }
    return 0;
  }

  async function sendFrameMessage(
    tabId: number,
    frameId: number,
    message: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown> {
    if (frameId === 0) return sendTabMessage(tabId, message, timeoutMs);
    trackPatchFrame(tabId, frameId, message);
    return sendMessageWithTimeout(tabId, frameId, message, timeoutMs);
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

  /** Proactively inject content scripts into all scriptable tabs in a window
when Bridge access is enabled. Errors on restricted pages are silently
ignored since ensureContentScript will handle them on demand. */
  async function injectContentScriptsForWindow(windowId: number): Promise<void> {
    const tabs = await chromeObj.tabs.query({ windowId });
    await Promise.allSettled(
      tabs
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
    },
    installNavigationSignals,
    uninstallNavigationSignals,
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
