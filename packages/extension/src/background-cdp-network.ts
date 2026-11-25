import {
  BridgeError,
  ERROR_CODES,
  MAX_CDP_BODY_TOTAL_BYTES,
  sanitizeIncidentalUrl,
} from '../../../protocol/src/index.js';
import { compileUrlPattern } from './background-url-pattern.js';

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_HAR_ENTRIES = 200;
const DEFAULT_MAX_INFLIGHT = 400;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TTL_RETRY_MS = 5_000;
const MAX_DIAGNOSTIC_COUNT = 10_000;
const DEFAULT_MAX_BODY_RECORDS = 1_000;
// Chrome reports an evicted or never-buffered body with one of these messages.
const EVICTED_BODY_PATTERN = /No resource with given identifier|No data found for resource/iu;

export type RedirectHop = { url: string; status: number };
export type CdpNetworkEntry = {
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  status: number;
  mimeType: string;
  protocol: string;
  fromCache: boolean;
  fromDiskCache: boolean;
  fromServiceWorker: boolean;
  fromPrefetchCache: boolean;
  redirect: { count: number; hops: RedirectHop[]; truncated: boolean };
  failureReason: string;
  duration: number;
  timestamp: number;
};
export type PendingNetworkEntry = CdpNetworkEntry & {
  startMonotonic: number | null;
  established: boolean;
};
export type HarEvidenceEntry = import('../../../protocol/src/types.js').HarEvidenceEntry;
export type BodyCaptureOptions =
  import('../../../protocol/src/types.js').NormalizedNetworkBodyCaptureParams;
/** Why a response body cannot be read. Each maps to its own typed error. */
export type BodyReadFailure =
  | 'capture_not_armed'
  | 'bodies_not_enabled'
  | 'request_unknown'
  | 'request_other_tab'
  | 'body_not_matched'
  | 'request_failed'
  | 'body_pending'
  | 'body_evicted'
  | 'body_unavailable'
  | 'capture_stopped';
/** Per-request body bookkeeping. Holds no URL, header or body content. */
type BodyRecord = {
  eligible: boolean;
  finished: boolean;
  failed: boolean;
  evicted: boolean;
  mimeType: string;
};
type BodyCaptureState = BodyCaptureOptions & { matcher: { test: (url: string) => boolean } | null };
export type RawResponseBody = {
  requestId: string;
  body: string;
  base64Encoded: boolean;
  mimeType: string;
};
export type PendingHarEvidenceEntry = HarEvidenceEntry & { startMonotonic: number | null };
export type TabCaptureState = {
  entries: CdpNetworkEntry[];
  inflight: Map<string, PendingNetworkEntry>;
  harEntries: HarEvidenceEntry[];
  harInflight: Map<string, PendingHarEvidenceEntry>;
  harDropped: number;
  dropped: number;
  abandoned: number;
  startedAt: number;
  networkEnabled: boolean;
  ownsDebugger: boolean;
  everArmed: boolean;
  status: 'armed' | 'stop_failed';
  ttlTimer?: ReturnType<typeof setTimeout>;
  /** Non-null only while Chrome buffers bodies for this capture. */
  bodies: BodyCaptureState | null;
  bodyIndex: Map<string, BodyRecord>;
};

export function createCdpNetworkCapture(deps: {
  acquireDebugger: (tabId: number) => Promise<void>;
  releaseDebugger: (tabId: number) => Promise<void>;
  assertDebuggerAvailable?: (tabId: number) => void;
  sendCommand: (
    target: { tabId: number },
    method: string,
    params: Record<string, unknown>
  ) => Promise<unknown>;
  maxEntries?: number;
  maxHarEntries?: number;
  maxInflight?: number;
  maxBodyRecords?: number;
  ttlMs?: number;
  ttlRetryMs?: number;
}) {
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxHarEntries = deps.maxHarEntries ?? DEFAULT_MAX_HAR_ENTRIES;
  const maxInflight = deps.maxInflight ?? DEFAULT_MAX_INFLIGHT;
  const maxBodyRecords = deps.maxBodyRecords ?? DEFAULT_MAX_BODY_RECORDS;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const ttlRetryMs = deps.ttlRetryMs ?? DEFAULT_TTL_RETRY_MS;

  const states: Map<number, TabCaptureState> = new Map();

  const lifecycleQueues: Map<number, Promise<void>> = new Map();

  const detachEpochs: Map<number, number> = new Map();

  const stopEpochs: Map<number, number> = new Map();

  function getDetachEpoch(tabId: number) {
    return detachEpochs.get(tabId) ?? 0;
  }

  function assertNotDetached(tabId: number, expected: number) {
    if (getDetachEpoch(tabId) !== expected) {
      throw new Error('Debugger detached while starting CDP network capture.');
    }
  }

  /** Serialize state publication and debugger ownership transitions per tab. */
  async function runLifecycle<T>(tabId: number, task: () => Promise<T> | T): Promise<T> {
    const previous = lifecycleQueues.get(tabId) ?? Promise.resolve();

    let releaseTurn: (value?: void | PromiseLike<void>) => void = (): void => {};
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const queuedTurn = previous.catch(() => {}).then(() => turn);
    lifecycleQueues.set(tabId, queuedTurn);
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      releaseTurn();
      if (lifecycleQueues.get(tabId) === queuedTurn) {
        lifecycleQueues.delete(tabId);
        if (!states.has(tabId)) {
          detachEpochs.delete(tabId);
          stopEpochs.delete(tabId);
        }
      }
    }
  }

  /** Arm capture. Without options.bodies Chrome buffers no bodies, as before. */
  function start(tabId: number, options: { bodies?: BodyCaptureOptions | null } = {}) {
    deps.assertDebuggerAvailable?.(tabId);
    const stopEpoch = stopEpochs.get(tabId) ?? 0;
    const bodies = options.bodies ?? null;
    return runLifecycle(tabId, async () => {
      const epoch = getDetachEpoch(tabId);
      const existing = states.get(tabId);
      if (existing?.status === 'armed') {
        // Body buffering changes need fresh Chrome buffers. Disabling Network
        // drops every buffered body, so earlier requestIds become unreadable.
        if (existing.bodies || bodies) await reconfigureBodies(tabId, existing, bodies, epoch);
        clearState(existing);
        existing.bodyIndex.clear();
        resetTtl(tabId, existing);
        return snapshot(existing, true);
      }
      if (existing) {
        await enableOwnedState(tabId, existing, epoch, bodies);
        clearState(existing);
        existing.bodyIndex.clear();
        resetTtl(tabId, existing);
        if ((stopEpochs.get(tabId) ?? 0) !== stopEpoch) {
          return stopState(tabId, existing, true);
        }
        return snapshot(existing, true);
      }

      let acquired = false;
      let enabled = false;
      try {
        await deps.acquireDebugger(tabId);
        acquired = true;
        assertNotDetached(tabId, epoch);
        await deps.sendCommand({ tabId }, 'Network.enable', networkEnableParams(bodies));
        enabled = true;
        assertNotDetached(tabId, epoch);
        const state = createState();
        state.bodies = compileBodyCapture(bodies);
        states.set(tabId, state);
        resetTtl(tabId, state);
        if ((stopEpochs.get(tabId) ?? 0) !== stopEpoch) {
          return stopState(tabId, state, true);
        }
        return snapshot(state, true);
      } catch (error) {
        if (acquired && getDetachEpoch(tabId) === epoch) {
          let networkEnabled = enabled;
          let cleanupFailed = false;
          try {
            if (networkEnabled) {
              await deps.sendCommand({ tabId }, 'Network.disable', {});
              networkEnabled = false;
            }
          } catch {
            cleanupFailed = true;
          }
          if (!cleanupFailed) {
            try {
              await deps.releaseDebugger(tabId);
            } catch {
              cleanupFailed = true;
            }
          }
          if (cleanupFailed) {
            const state = createState(networkEnabled);
            state.networkEnabled = networkEnabled;
            state.status = networkEnabled ? 'armed' : 'stop_failed';
            states.set(tabId, state);
            resetTtl(tabId, state, ttlRetryMs);
          }
        }
        throw error;
      }
    });
  }

  function clear(tabId: number) {
    return runLifecycle(tabId, () => {
      const state = states.get(tabId);
      if (!state) return emptySnapshot();
      clearState(state);
      state.bodyIndex.clear();
      if (state.status === 'armed') resetTtl(tabId, state);
      return snapshot(state, state.status === 'armed');
    });
  }

  function read(tabId: number, shouldClear: boolean = false) {
    return runLifecycle(tabId, () => {
      const state = states.get(tabId);
      if (!state) return emptySnapshot();
      const result = snapshot(state, state.status === 'armed');
      if (shouldClear) clearState(state);
      return result;
    });
  }

  function readHar(tabId: number) {
    return runLifecycle(tabId, () => {
      const state = states.get(tabId);
      if (!state || state.status !== 'armed' || !state.networkEnabled) return emptyHarSnapshot();
      return {
        entries: state.harEntries.map((entry) => structuredClone(entry)),
        dropped: state.harDropped,
        abandoned: state.abandoned,
        armed: true,
        captureState: 'armed',
        startedAt: state.startedAt,
        inflight: state.harInflight.size,
      };
    });
  }

  function stop(tabId: number) {
    stopEpochs.set(tabId, (stopEpochs.get(tabId) ?? 0) + 1);
    return runLifecycle(tabId, async () => {
      const state = states.get(tabId);
      if (!state) return emptySnapshot();
      return stopState(tabId, state, state.status === 'armed');
    });
  }

  async function stopState(tabId: number, state: TabCaptureState, wasArmed: boolean) {
    if (state.networkEnabled) {
      try {
        await deps.sendCommand({ tabId }, 'Network.disable', {});
      } catch (error) {
        state.status = 'armed';
        resetTtl(tabId, state, ttlRetryMs);
        throw error;
      }
      state.networkEnabled = false;
      state.status = 'stop_failed';
      abandonInflight(state);
    }
    // Disabled Network holds no bodies; never let a retained record claim one.
    if (!state.networkEnabled) dropBodies(state);
    if (state.ownsDebugger) {
      try {
        await deps.releaseDebugger(tabId);
      } catch (error) {
        resetTtl(tabId, state, ttlRetryMs);
        throw error;
      }
      state.ownsDebugger = false;
    }
    if (state.ttlTimer) clearTimeout(state.ttlTimer);
    const result = snapshot(state, wasArmed, false);
    states.delete(tabId);
    return result;
  }

  /** Invalidate an external detach synchronously so an in-flight start cannot
publish an armed state after Chrome has already detached the target. */
  function handleDetach(tabId: number) {
    detachEpochs.set(tabId, getDetachEpoch(tabId) + 1);
    return runLifecycle(tabId, () => {
      const state = states.get(tabId);
      if (!state) return emptySnapshot();
      if (state.ttlTimer) clearTimeout(state.ttlTimer);
      abandonInflight(state);
      state.networkEnabled = false;
      state.ownsDebugger = false;
      state.status = 'stop_failed';
      dropBodies(state);
      const result = snapshot(state, false, false);
      states.delete(tabId);
      return result;
    });
  }

  function handleEvent(tabId: number, method: string, params: unknown) {
    const state = states.get(tabId);
    if (!state || state.status !== 'armed' || !state.networkEnabled || !isRecord(params)) return;
    if (method === 'Network.requestWillBeSent') {
      handleRequestWillBeSent(state, params);
      handleHarRequestWillBeSent(state, params);
      recordBodyRequest(state, params);
    } else if (method === 'Network.responseReceived') {
      handleResponseReceived(state, params);
      handleHarResponseReceived(state, params);
      const record = getBodyRecord(state, params.requestId);
      if (record && isRecord(params.response))
        record.mimeType = boundString(params.response.mimeType, 256);
    } else if (method === 'Network.requestServedFromCache') {
      const entry = getPending(state, params.requestId);
      if (entry) entry.fromCache = true;
      const harEntry = getPendingHar(state, params.requestId);
      if (harEntry) harEntry.fromCache = true;
    } else if (method === 'Network.loadingFinished') {
      finishRequest(state, params.requestId, params.timestamp, '');
      finishHarRequest(state, params.requestId, params.timestamp, '');
      const record = getBodyRecord(state, params.requestId);
      if (record) record.finished = true;
    } else if (method === 'Network.loadingFailed') {
      const record = getBodyRecord(state, params.requestId);
      if (record) record.failed = true;
      finishRequest(state, params.requestId, params.timestamp, boundString(params.errorText, 256));
      finishHarRequest(
        state,
        params.requestId,
        params.timestamp,
        boundString(params.errorText, 256)
      );
    } else if (method === 'Network.webSocketCreated') {
      handleWebSocketCreated(state, params);
    } else if (method === 'Network.webSocketWillSendHandshakeRequest') {
      handleWebSocketHandshakeRequest(state, params);
    } else if (method === 'Network.webSocketHandshakeResponseReceived') {
      handleWebSocketHandshakeResponse(state, params);
    } else if (method === 'Network.webSocketFrameError') {
      const entry = getPending(state, params.requestId);
      if (entry) entry.failureReason = boundString(params.errorMessage, 256);
      const harEntry = getPendingHar(state, params.requestId);
      if (harEntry) harEntry.failureReason = boundString(params.errorMessage, 256);
    } else if (method === 'Network.webSocketClosed') {
      finishRequest(state, params.requestId, params.timestamp, undefined);
      finishHarRequest(state, params.requestId, params.timestamp, undefined);
    } else if (method === 'Network.webTransportCreated') {
      handleWebTransportCreated(state, params);
    } else if (method === 'Network.webTransportConnectionEstablished') {
      const entry = getPending(state, params.transportId);
      if (entry) {
        entry.established = true;
        entry.protocol = 'webtransport';
      }
      const harEntry = getPendingHar(state, params.transportId);
      if (harEntry) harEntry.protocol = 'webtransport';
    } else if (method === 'Network.webTransportClosed') {
      const entry = getPending(state, params.transportId);
      const failureReason = entry?.established ? undefined : 'closed before connection established';
      finishRequest(state, params.transportId, params.timestamp, failureReason);
      finishHarRequest(state, params.transportId, params.timestamp, failureReason);
    }
  }

  function getDiagnostics(): {
    status: 'stopped' | 'armed' | 'stop_failed';
    activeTabCount: number;
    ownershipCount: number;
    inflightCount: number;
  } {
    let activeTabCount = 0;
    let ownershipCount = 0;
    let inflightCount = 0;
    let stopFailed = false;
    for (const state of states.values()) {
      if (state.status === 'armed') activeTabCount += 1;
      if (state.ownsDebugger) ownershipCount += 1;
      inflightCount += state.inflight.size;
      stopFailed ||= state.status === 'stop_failed';
    }
    return {
      status: stopFailed ? 'stop_failed' : activeTabCount > 0 ? 'armed' : 'stopped',
      activeTabCount: Math.min(activeTabCount, MAX_DIAGNOSTIC_COUNT),
      ownershipCount: Math.min(ownershipCount, MAX_DIAGNOSTIC_COUNT),
      inflightCount: Math.min(inflightCount, MAX_DIAGNOSTIC_COUNT),
    };
  }

  function resetTtl(tabId: number, state: TabCaptureState, delayMs: number = ttlMs) {
    if (state.ttlTimer) clearTimeout(state.ttlTimer);
    state.ttlTimer = setTimeout(() => {
      if (states.get(tabId) !== state) return;
      void stop(tabId).catch(() => {});
    }, delayMs);
    state.ttlTimer.unref?.();
  }

  async function enableOwnedState(
    tabId: number,
    state: TabCaptureState,
    epoch: number,
    bodies: BodyCaptureOptions | null = null
  ) {
    try {
      await deps.sendCommand({ tabId }, 'Network.enable', networkEnableParams(bodies));
      assertNotDetached(tabId, epoch);
      state.networkEnabled = true;
      state.status = 'armed';
      state.everArmed = true;
      state.bodies = compileBodyCapture(bodies);
    } catch (error) {
      resetTtl(tabId, state, ttlRetryMs);
      throw error;
    }
  }

  /** Replace an armed capture's Chrome buffers. Any failure leaves the state
  claiming no bodies and schedules the TTL stop to release the debugger. */
  async function reconfigureBodies(
    tabId: number,
    state: TabCaptureState,
    bodies: BodyCaptureOptions | null,
    epoch: number
  ) {
    dropBodies(state);
    try {
      await deps.sendCommand({ tabId }, 'Network.disable', {});
      state.networkEnabled = false;
      abandonInflight(state);
      await deps.sendCommand({ tabId }, 'Network.enable', networkEnableParams(bodies));
      assertNotDetached(tabId, epoch);
      state.networkEnabled = true;
      state.bodies = compileBodyCapture(bodies);
    } catch (error) {
      if (!state.networkEnabled) state.status = 'stop_failed';
      resetTtl(tabId, state, ttlRetryMs);
      throw error;
    }
  }

  function recordBodyRequest(state: TabCaptureState, event: Record<string, unknown>) {
    if (!state.bodies) return;
    const requestId = boundString(event.requestId, 256);
    if (!requestId || !isRecord(event.request)) return;
    const url = typeof event.request.url === 'string' ? event.request.url : '';
    // A redirect reuses the requestId; the body belongs to the final URL.
    const eligible = Boolean(url) && (state.bodies.matcher?.test(url) ?? true);
    const existing = state.bodyIndex.get(requestId);
    if (existing) {
      existing.eligible = eligible;
      existing.mimeType = '';
      return;
    }
    if (state.bodyIndex.size >= maxBodyRecords) {
      const oldest = state.bodyIndex.keys().next().value;
      if (typeof oldest === 'string') state.bodyIndex.delete(oldest);
    }
    state.bodyIndex.set(requestId, {
      eligible,
      finished: false,
      failed: false,
      evicted: false,
      mimeType: '',
    });
  }

  function getBodyRecord(state: TabCaptureState, requestId: unknown) {
    const id = boundString(requestId, 256);
    return id && state.bodies ? state.bodyIndex.get(id) : undefined;
  }

  function bodyFailure(reason: BodyReadFailure): BridgeError {
    const messages: Record<BodyReadFailure, string> = {
      capture_not_armed:
        'No CDP network capture is armed on this tab. Start one with page.get_network {source: "cdp", capture: "start", bodies: {...}}.',
      bodies_not_enabled:
        'This tab\'s CDP capture does not buffer response bodies. Restart it with capture: "start" and bodies.',
      request_unknown:
        "The requestId was not recorded by this tab's current capture. Use a requestId from page.get_network source=cdp.",
      request_other_tab:
        "The requestId belongs to another tab's capture. Read it with that tab's tabId.",
      body_not_matched: "The request does not match the capture's bodies.urlPattern.",
      request_failed: 'The request failed, so Chrome holds no response body for it.',
      body_pending: 'The response has not finished loading. Read it after the request completes.',
      body_evicted:
        'Chrome no longer holds this response body (evicted, navigated, or over the buffer cap).',
      body_unavailable: 'Chrome did not return a response body for this request.',
      capture_stopped:
        'The capture stopped or the debugger detached during the read. No body was returned.',
    };
    return new BridgeError(ERROR_CODES.SENSITIVE_TARGET_NOT_FOUND, messages[reason], {
      source: 'response_body',
      reason,
    });
  }

  function heldByOtherTab(tabId: number, requestId: string) {
    for (const [otherTabId, other] of states) {
      if (otherTabId !== tabId && other.bodyIndex.has(requestId)) return true;
    }
    return false;
  }

  /** Read one buffered body recorded by this tab's own capture. Reads share the
  lifecycle queue, so stop and detach cannot interleave with a read. */
  function readBody(tabId: number, requestId: string): Promise<RawResponseBody> {
    return runLifecycle(tabId, async () => {
      const state = states.get(tabId);
      if (!state || state.status !== 'armed' || !state.networkEnabled)
        throw bodyFailure(
          heldByOtherTab(tabId, requestId) ? 'request_other_tab' : 'capture_not_armed'
        );
      if (!state.bodies) throw bodyFailure('bodies_not_enabled');
      const record = state.bodyIndex.get(requestId);
      if (!record)
        throw bodyFailure(
          heldByOtherTab(tabId, requestId) ? 'request_other_tab' : 'request_unknown'
        );
      if (!record.eligible) throw bodyFailure('body_not_matched');
      if (record.failed) throw bodyFailure('request_failed');
      if (!record.finished) throw bodyFailure('body_pending');
      if (record.evicted) throw bodyFailure('body_evicted');
      const epoch = getDetachEpoch(tabId);
      let raw: unknown;
      try {
        raw = await deps.sendCommand({ tabId }, 'Network.getResponseBody', { requestId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (getDetachEpoch(tabId) !== epoch || states.get(tabId) !== state)
          throw bodyFailure('capture_stopped');
        if (EVICTED_BODY_PATTERN.test(message)) {
          record.evicted = true;
          throw bodyFailure('body_evicted');
        }
        throw bodyFailure('body_unavailable');
      }
      if (
        getDetachEpoch(tabId) !== epoch ||
        states.get(tabId) !== state ||
        state.status !== 'armed' ||
        !state.bodies
      )
        throw bodyFailure('capture_stopped');
      if (!isRecord(raw) || typeof raw.body !== 'string') throw bodyFailure('body_unavailable');
      return {
        requestId,
        body: raw.body,
        base64Encoded: raw.base64Encoded === true,
        mimeType: record.mimeType,
      };
    });
  }

  function handleRequestWillBeSent(state: TabCaptureState, event: Record<string, unknown>) {
    const requestId = boundString(event.requestId, 256);
    if (!requestId || !isRecord(event.request)) return;
    const request = event.request;
    let entry = state.inflight.get(requestId);
    if (entry && isRecord(event.redirectResponse)) {
      const hops = entry.redirect.hops;
      if (hops.length < 5) {
        hops.push({ url: entry.url, status: finiteNumber(event.redirectResponse.status) ?? 0 });
      }
      entry.redirect.count += 1;
      entry.redirect.truncated = entry.redirect.count > hops.length;
    }
    if (!entry) {
      entry = createPendingEntry(requestId, event);
      addPending(state, requestId, entry);
    }
    entry.url = sanitizeIncidentalUrl(request.url);
    entry.method = boundString(request.method, 32).toUpperCase();
    entry.resourceType = boundString(event.type, 64) || entry.resourceType;
  }

  function handleHarRequestWillBeSent(state: TabCaptureState, event: Record<string, unknown>) {
    const requestId = boundString(event.requestId, 256);
    if (!requestId || !isRecord(event.request)) return;
    const existing = state.harInflight.get(requestId);
    if (existing && isRecord(event.redirectResponse)) {
      applyResponseToHar(existing, event.redirectResponse);
      existing.redirectURL = sanitizeIncidentalUrl(event.request.url);
      finishHarRequest(state, requestId, event.timestamp, undefined);
    }
    addHarPending(state, requestId, createPendingHarEntry(event));
  }

  function handleResponseReceived(state: TabCaptureState, event: Record<string, unknown>) {
    const entry = getPending(state, event.requestId);
    if (!entry || !isRecord(event.response)) return;
    const response = event.response;
    entry.status = finiteNumber(response.status) ?? entry.status;
    entry.mimeType = boundString(response.mimeType, 256);
    entry.protocol = boundString(response.protocol, 64);
    entry.fromDiskCache = response.fromDiskCache === true;
    entry.fromServiceWorker = response.fromServiceWorker === true;
    entry.fromPrefetchCache = response.fromPrefetchCache === true;
    entry.fromCache ||= entry.fromDiskCache || entry.fromServiceWorker || entry.fromPrefetchCache;
    entry.resourceType = boundString(event.type, 64) || entry.resourceType;
  }

  function handleHarResponseReceived(state: TabCaptureState, event: Record<string, unknown>) {
    const entry = getPendingHar(state, event.requestId);
    if (!entry || !isRecord(event.response)) return;
    applyResponseToHar(entry, event.response);
    entry.resourceType = boundString(event.type, 64) || entry.resourceType;
  }

  function handleWebSocketCreated(state: TabCaptureState, event: Record<string, unknown>) {
    const requestId = boundString(event.requestId, 256);
    if (!requestId) return;
    const entry = createSpecialPendingEntry(requestId, event.url, '', 'WebSocket', event.timestamp);
    entry.protocol = 'websocket';
    addPending(state, requestId, entry);
    const harEntry = createSpecialPendingHarEntry(event.url, '', 'WebSocket', event.timestamp);
    harEntry.protocol = 'websocket';
    addHarPending(state, requestId, harEntry);
  }

  function handleWebSocketHandshakeRequest(state: TabCaptureState, event: Record<string, unknown>) {
    const entry = getPending(state, event.requestId);
    if (!entry) return;
    entry.startMonotonic = finiteNumber(event.timestamp) ?? entry.startMonotonic;
    const wallTime = finiteNumber(event.wallTime);
    if (wallTime !== null) entry.timestamp = Math.round(wallTime * 1000);
    const harEntry = getPendingHar(state, event.requestId);
    if (harEntry) {
      harEntry.startMonotonic = finiteNumber(event.timestamp) ?? harEntry.startMonotonic;
      if (wallTime !== null) harEntry.startedAt = Math.round(wallTime * 1000);
    }
  }

  function handleWebSocketHandshakeResponse(
    state: TabCaptureState,
    event: Record<string, unknown>
  ) {
    const entry = getPending(state, event.requestId);
    if (!entry || !isRecord(event.response)) return;
    entry.status = finiteNumber(event.response.status) ?? 0;
    entry.established = entry.status >= 100 && entry.status < 400;
    const harEntry = getPendingHar(state, event.requestId);
    if (harEntry) applyResponseToHar(harEntry, event.response);
  }

  function handleWebTransportCreated(state: TabCaptureState, event: Record<string, unknown>) {
    const transportId = boundString(event.transportId, 256);
    if (!transportId) return;
    addPending(
      state,
      transportId,
      createSpecialPendingEntry(transportId, event.url, '', 'WebTransport', event.timestamp)
    );
    addHarPending(
      state,
      transportId,
      createSpecialPendingHarEntry(event.url, '', 'WebTransport', event.timestamp)
    );
  }

  function addPending(state: TabCaptureState, id: string, entry: PendingNetworkEntry) {
    if (!state.inflight.has(id) && state.inflight.size >= maxInflight) {
      const oldest = state.inflight.keys().next().value;
      if (typeof oldest === 'string') state.inflight.delete(oldest);
      state.dropped += 1;
      state.abandoned += 1;
    }
    state.inflight.set(id, entry);
  }

  function addHarPending(state: TabCaptureState, id: string, entry: PendingHarEvidenceEntry) {
    if (!state.harInflight.has(id) && state.harInflight.size >= maxInflight) {
      const oldest = state.harInflight.keys().next().value;
      if (typeof oldest === 'string') state.harInflight.delete(oldest);
      state.harDropped += 1;
    }
    state.harInflight.set(id, entry);
  }

  function finishRequest(
    state: TabCaptureState,
    requestId: unknown,
    timestamp: unknown,
    failureReason: string | undefined
  ) {
    const id = boundString(requestId, 256);
    const entry = state.inflight.get(id);
    if (!entry) return;
    state.inflight.delete(id);
    if (failureReason !== undefined) entry.failureReason = failureReason;
    const end = finiteNumber(timestamp);
    entry.duration =
      end !== null && entry.startMonotonic !== null
        ? Math.max(0, Math.round((end - entry.startMonotonic) * 1000))
        : 0;
    const { startMonotonic: _startMonotonic, established: _established, ...complete } = entry;
    state.entries.push(complete);
    if (state.entries.length > maxEntries) {
      const overflow = state.entries.length - maxEntries;
      state.entries.splice(0, overflow);
      state.dropped += overflow;
    }
  }

  function finishHarRequest(
    state: TabCaptureState,
    requestId: unknown,
    timestamp: unknown,
    failureReason: string | undefined
  ) {
    const id = boundString(requestId, 256);
    const entry = state.harInflight.get(id);
    if (!entry) return;
    state.harInflight.delete(id);
    if (failureReason !== undefined) entry.failureReason = failureReason;
    const end = finiteNumber(timestamp);
    entry.duration =
      end !== null && entry.startMonotonic !== null
        ? Math.max(0, Math.round((end - entry.startMonotonic) * 1000))
        : 0;
    const { startMonotonic: _startMonotonic, ...complete } = entry;
    state.harEntries.push(complete);
    if (state.harEntries.length > maxHarEntries) {
      const overflow = state.harEntries.length - maxHarEntries;
      state.harEntries.splice(0, overflow);
      state.harDropped += overflow;
    }
  }

  return {
    start,
    clear,
    read,
    readHar,
    readBody,
    stop,
    handleDetach,
    handleEvent,
    getDiagnostics,
  };
}

function networkEnableParams(bodies: BodyCaptureOptions | null) {
  // maxPostDataSize stays 0: request bodies are never buffered.
  return bodies
    ? {
        maxTotalBufferSize: MAX_CDP_BODY_TOTAL_BYTES,
        maxResourceBufferSize: bodies.maxResourceBytes,
        maxPostDataSize: 0,
      }
    : { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 };
}

function compileBodyCapture(bodies: BodyCaptureOptions | null): BodyCaptureState | null {
  if (!bodies) return null;
  return {
    urlPattern: bodies.urlPattern,
    maxResourceBytes: bodies.maxResourceBytes,
    matcher: bodies.urlPattern ? compileUrlPattern(bodies.urlPattern) : null,
  };
}

function dropBodies(state: TabCaptureState) {
  state.bodies = null;
  state.bodyIndex.clear();
}

function isBodyAvailable(state: TabCaptureState, requestId: string) {
  if (!state.bodies || state.status !== 'armed' || !state.networkEnabled) return false;
  const record = state.bodyIndex.get(requestId);
  return Boolean(record && record.eligible && record.finished && !record.failed && !record.evicted);
}

function createState(armed: boolean = true): TabCaptureState {
  return {
    entries: [],
    inflight: new Map(),
    harEntries: [],
    harInflight: new Map(),
    harDropped: 0,
    dropped: 0,
    abandoned: 0,
    startedAt: Date.now(),
    networkEnabled: armed,
    ownsDebugger: true,
    everArmed: armed,
    status: armed ? 'armed' : 'stop_failed',
    bodies: null,
    bodyIndex: new Map(),
  };
}

function clearState(state: TabCaptureState) {
  state.entries.length = 0;
  state.abandoned = state.inflight.size;
  state.inflight.clear();
  state.harEntries.length = 0;
  state.harInflight.clear();
  state.harDropped = 0;
  state.dropped = 0;
  state.startedAt = Date.now();
}

function abandonInflight(state: TabCaptureState) {
  state.abandoned += state.inflight.size;
  state.inflight.clear();
  state.harInflight.clear();
}

function createPendingEntry(
  requestId: string,
  event: Record<string, unknown>
): PendingNetworkEntry {
  const request = isRecord(event.request) ? event.request : {};
  const wallTime = finiteNumber(event.wallTime);
  return {
    ...createSpecialPendingEntry(
      requestId,
      request.url,
      request.method,
      event.type,
      event.timestamp
    ),
    timestamp: wallTime === null ? Date.now() : Math.round(wallTime * 1000),
  };
}

function createPendingHarEntry(event: Record<string, unknown>): PendingHarEvidenceEntry {
  const request = isRecord(event.request) ? event.request : {};
  const wallTime = finiteNumber(event.wallTime);
  return {
    ...createSpecialPendingHarEntry(request.url, request.method, event.type, event.timestamp),
    startedAt: wallTime === null ? Date.now() : Math.round(wallTime * 1000),
  };
}

function createSpecialPendingHarEntry(
  url: unknown,
  method: unknown,
  resourceType: unknown,
  timestamp: unknown
): PendingHarEvidenceEntry {
  return {
    url: sanitizeIncidentalUrl(url),
    method: boundString(method, 32).toUpperCase(),
    resourceType: boundString(resourceType, 64),
    status: 0,
    mimeType: '',
    protocol: '',
    fromCache: false,
    fromDiskCache: false,
    fromServiceWorker: false,
    fromPrefetchCache: false,
    failureReason: '',
    redirectURL: '',
    duration: 0,
    startedAt: Date.now(),
    startMonotonic: finiteNumber(timestamp),
  };
}

function applyResponseToHar(entry: PendingHarEvidenceEntry, response: Record<string, unknown>) {
  entry.status = finiteNumber(response.status) ?? entry.status;
  entry.mimeType = boundString(response.mimeType, 256) || entry.mimeType;
  entry.protocol = boundString(response.protocol, 64) || entry.protocol;
  entry.fromDiskCache = response.fromDiskCache === true;
  entry.fromServiceWorker = response.fromServiceWorker === true;
  entry.fromPrefetchCache = response.fromPrefetchCache === true;
  entry.fromCache ||= entry.fromDiskCache || entry.fromServiceWorker || entry.fromPrefetchCache;
}

function createSpecialPendingEntry(
  requestId: string,
  url: unknown,
  method: unknown,
  resourceType: unknown,
  timestamp: unknown
): PendingNetworkEntry {
  return {
    requestId,
    url: sanitizeIncidentalUrl(url),
    method: boundString(method, 32).toUpperCase(),
    resourceType: boundString(resourceType, 64),
    status: 0,
    mimeType: '',
    protocol: '',
    fromCache: false,
    fromDiskCache: false,
    fromServiceWorker: false,
    fromPrefetchCache: false,
    redirect: { count: 0, hops: [], truncated: false },
    failureReason: '',
    duration: 0,
    timestamp: Date.now(),
    startMonotonic: finiteNumber(timestamp),
    established: false,
  };
}

function getPending(state: TabCaptureState, requestId: unknown) {
  const id = boundString(requestId, 256);
  return id ? state.inflight.get(id) : undefined;
}

function getPendingHar(state: TabCaptureState, requestId: unknown) {
  const id = boundString(requestId, 256);
  return id ? state.harInflight.get(id) : undefined;
}

function snapshot(
  state: TabCaptureState,
  armedDuringCapture: boolean,
  armed: boolean = state.status === 'armed'
) {
  return {
    entries: state.entries.map((entry) => ({
      ...structuredClone(entry),
      bodyAvailable: isBodyAvailable(state, entry.requestId),
    })),
    dropped: state.dropped,
    abandoned: state.abandoned,
    armed,
    armedDuringCapture: armedDuringCapture || state.everArmed,
    ownershipHeld: state.ownsDebugger,
    captureState: armed ? 'armed' : state.ownsDebugger ? 'stop_failed' : 'stopped',
    startedAt: state.startedAt,
    inflight: state.inflight.size,
    ...(armed && state.bodies
      ? {
          bodyCapture: {
            urlPattern: state.bodies.urlPattern,
            maxResourceBytes: state.bodies.maxResourceBytes,
          },
        }
      : {}),
  };
}

function emptySnapshot() {
  return {
    entries: [],
    dropped: 0,
    abandoned: 0,
    armed: false,
    armedDuringCapture: false,
    ownershipHeld: false,
    captureState: 'stopped',
    startedAt: null,
    inflight: 0,
  };
}

function emptyHarSnapshot() {
  return {
    entries: [],
    dropped: 0,
    abandoned: 0,
    armed: false,
    captureState: 'stopped',
    startedAt: null,
    inflight: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundString(value: unknown, maxLength: number) {
  return typeof value === 'string'
    ? replaceControlCharacters(value, ' ').trim().slice(0, maxLength)
    : '';
}

function replaceControlCharacters(value: string, replacement: string) {
  let result = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    result += code <= 31 || (code >= 127 && code <= 159) ? replacement : character;
  }
  return result;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
