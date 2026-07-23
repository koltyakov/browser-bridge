// @ts-check

import { sanitizeIncidentalUrl } from '../../protocol/src/index.js';

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_INFLIGHT = 400;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TTL_RETRY_MS = 5_000;
const MAX_DIAGNOSTIC_COUNT = 10_000;

/** @typedef {{ url: string, status: number }} RedirectHop */
/**
 * @typedef {{
 *   requestId: string,
 *   url: string,
 *   method: string,
 *   resourceType: string,
 *   status: number,
 *   mimeType: string,
 *   protocol: string,
 *   fromCache: boolean,
 *   fromDiskCache: boolean,
 *   fromServiceWorker: boolean,
 *   fromPrefetchCache: boolean,
 *   redirect: { count: number, hops: RedirectHop[], truncated: boolean },
 *   failureReason: string,
 *   duration: number,
 *   timestamp: number
 * }} CdpNetworkEntry
 */
/** @typedef {CdpNetworkEntry & { startMonotonic: number | null, established: boolean }} PendingNetworkEntry */
/**
 * @typedef {{
 *   entries: CdpNetworkEntry[],
 *   inflight: Map<string, PendingNetworkEntry>,
 *   dropped: number,
 *   abandoned: number,
 *   startedAt: number,
 *   networkEnabled: boolean,
 *   ownsDebugger: boolean,
 *   everArmed: boolean,
 *   status: 'armed' | 'stop_failed',
 *   ttlTimer?: ReturnType<typeof setTimeout>
 * }} TabCaptureState
 */

/**
 * @param {{
 *   acquireDebugger: (tabId: number) => Promise<void>,
 *   releaseDebugger: (tabId: number) => Promise<void>,
 *   assertDebuggerAvailable?: (tabId: number) => void,
 *   sendCommand: (target: { tabId: number }, method: string, params: Record<string, unknown>) => Promise<unknown>,
 *   maxEntries?: number,
 *   maxInflight?: number,
 *   ttlMs?: number,
 *   ttlRetryMs?: number
 * }} deps
 */
export function createCdpNetworkCapture(deps) {
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxInflight = deps.maxInflight ?? DEFAULT_MAX_INFLIGHT;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const ttlRetryMs = deps.ttlRetryMs ?? DEFAULT_TTL_RETRY_MS;
  /** @type {Map<number, TabCaptureState>} */
  const states = new Map();
  /** @type {Map<number, Promise<void>>} */
  const lifecycleQueues = new Map();
  /** @type {Map<number, number>} */
  const detachEpochs = new Map();
  /** @type {Map<number, number>} */
  const stopEpochs = new Map();

  /** @param {number} tabId */
  function getDetachEpoch(tabId) {
    return detachEpochs.get(tabId) ?? 0;
  }

  /** @param {number} tabId @param {number} expected */
  function assertNotDetached(tabId, expected) {
    if (getDetachEpoch(tabId) !== expected) {
      throw new Error('Debugger detached while starting CDP network capture.');
    }
  }

  /**
   * Serialize state publication and debugger ownership transitions per tab.
   *
   * @template T
   * @param {number} tabId
   * @param {() => Promise<T> | T} task
   * @returns {Promise<T>}
   */
  async function runLifecycle(tabId, task) {
    const previous = lifecycleQueues.get(tabId) ?? Promise.resolve();
    /** @type {(value?: void | PromiseLike<void>) => void} */
    let releaseTurn = () => {};
    const turn = new Promise((resolve) => {
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

  /** @param {number} tabId */
  function start(tabId) {
    deps.assertDebuggerAvailable?.(tabId);
    const stopEpoch = stopEpochs.get(tabId) ?? 0;
    return runLifecycle(tabId, async () => {
      const epoch = getDetachEpoch(tabId);
      const existing = states.get(tabId);
      if (existing?.status === 'armed') {
        clearState(existing);
        resetTtl(tabId, existing);
        return snapshot(existing, true);
      }
      if (existing) {
        await enableOwnedState(tabId, existing, epoch);
        clearState(existing);
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
        await deps.sendCommand({ tabId }, 'Network.enable', {
          maxTotalBufferSize: 0,
          maxResourceBufferSize: 0,
          maxPostDataSize: 0,
        });
        enabled = true;
        assertNotDetached(tabId, epoch);
        const state = createState();
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

  /** @param {number} tabId */
  function clear(tabId) {
    return runLifecycle(tabId, () => {
      const state = states.get(tabId);
      if (!state) return emptySnapshot();
      clearState(state);
      if (state.status === 'armed') resetTtl(tabId, state);
      return snapshot(state, state.status === 'armed');
    });
  }

  /** @param {number} tabId @param {boolean} shouldClear */
  function read(tabId, shouldClear = false) {
    return runLifecycle(tabId, () => {
      const state = states.get(tabId);
      if (!state) return emptySnapshot();
      const result = snapshot(state, state.status === 'armed');
      if (shouldClear) clearState(state);
      return result;
    });
  }

  /** @param {number} tabId */
  function stop(tabId) {
    stopEpochs.set(tabId, (stopEpochs.get(tabId) ?? 0) + 1);
    return runLifecycle(tabId, async () => {
      const state = states.get(tabId);
      if (!state) return emptySnapshot();
      return stopState(tabId, state, state.status === 'armed');
    });
  }

  /** @param {number} tabId @param {TabCaptureState} state @param {boolean} wasArmed */
  async function stopState(tabId, state, wasArmed) {
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

  /**
   * Invalidate an external detach synchronously so an in-flight start cannot
   * publish an armed state after Chrome has already detached the target.
   *
   * @param {number} tabId
   */
  function handleDetach(tabId) {
    detachEpochs.set(tabId, getDetachEpoch(tabId) + 1);
    return runLifecycle(tabId, () => {
      const state = states.get(tabId);
      if (!state) return emptySnapshot();
      if (state.ttlTimer) clearTimeout(state.ttlTimer);
      abandonInflight(state);
      state.networkEnabled = false;
      state.ownsDebugger = false;
      state.status = 'stop_failed';
      const result = snapshot(state, false, false);
      states.delete(tabId);
      return result;
    });
  }

  /** @param {number} tabId @param {string} method @param {unknown} params */
  function handleEvent(tabId, method, params) {
    const state = states.get(tabId);
    if (!state || state.status !== 'armed' || !state.networkEnabled || !isRecord(params)) return;
    if (method === 'Network.requestWillBeSent') {
      handleRequestWillBeSent(state, params);
    } else if (method === 'Network.responseReceived') {
      handleResponseReceived(state, params);
    } else if (method === 'Network.requestServedFromCache') {
      const entry = getPending(state, params.requestId);
      if (entry) entry.fromCache = true;
    } else if (method === 'Network.loadingFinished') {
      finishRequest(state, params.requestId, params.timestamp, '');
    } else if (method === 'Network.loadingFailed') {
      finishRequest(state, params.requestId, params.timestamp, boundString(params.errorText, 256));
    } else if (method === 'Network.webSocketCreated') {
      handleWebSocketCreated(state, params);
    } else if (method === 'Network.webSocketWillSendHandshakeRequest') {
      handleWebSocketHandshakeRequest(state, params);
    } else if (method === 'Network.webSocketHandshakeResponseReceived') {
      handleWebSocketHandshakeResponse(state, params);
    } else if (method === 'Network.webSocketFrameError') {
      const entry = getPending(state, params.requestId);
      if (entry) entry.failureReason = boundString(params.errorMessage, 256);
    } else if (method === 'Network.webSocketClosed') {
      finishRequest(state, params.requestId, params.timestamp, undefined);
    } else if (method === 'Network.webTransportCreated') {
      handleWebTransportCreated(state, params);
    } else if (method === 'Network.webTransportConnectionEstablished') {
      const entry = getPending(state, params.transportId);
      if (entry) {
        entry.established = true;
        entry.protocol = 'webtransport';
      }
    } else if (method === 'Network.webTransportClosed') {
      const entry = getPending(state, params.transportId);
      const failureReason = entry?.established ? undefined : 'closed before connection established';
      finishRequest(state, params.transportId, params.timestamp, failureReason);
    }
  }

  /**
   * @returns {{ status: 'stopped' | 'armed' | 'stop_failed', activeTabCount: number, ownershipCount: number, inflightCount: number }}
   */
  function getDiagnostics() {
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

  /** @param {number} tabId @param {TabCaptureState} state @param {number} [delayMs] */
  function resetTtl(tabId, state, delayMs = ttlMs) {
    if (state.ttlTimer) clearTimeout(state.ttlTimer);
    state.ttlTimer = setTimeout(() => {
      if (states.get(tabId) !== state) return;
      void stop(tabId).catch(() => {});
    }, delayMs);
    state.ttlTimer.unref?.();
  }

  /** @param {number} tabId @param {TabCaptureState} state @param {number} epoch */
  async function enableOwnedState(tabId, state, epoch) {
    try {
      await deps.sendCommand({ tabId }, 'Network.enable', {
        maxTotalBufferSize: 0,
        maxResourceBufferSize: 0,
        maxPostDataSize: 0,
      });
      assertNotDetached(tabId, epoch);
      state.networkEnabled = true;
      state.status = 'armed';
      state.everArmed = true;
    } catch (error) {
      resetTtl(tabId, state, ttlRetryMs);
      throw error;
    }
  }

  /** @param {TabCaptureState} state @param {Record<string, unknown>} event */
  function handleRequestWillBeSent(state, event) {
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

  /** @param {TabCaptureState} state @param {Record<string, unknown>} event */
  function handleResponseReceived(state, event) {
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

  /** @param {TabCaptureState} state @param {Record<string, unknown>} event */
  function handleWebSocketCreated(state, event) {
    const requestId = boundString(event.requestId, 256);
    if (!requestId) return;
    const entry = createSpecialPendingEntry(requestId, event.url, '', 'WebSocket', event.timestamp);
    entry.protocol = 'websocket';
    addPending(state, requestId, entry);
  }

  /** @param {TabCaptureState} state @param {Record<string, unknown>} event */
  function handleWebSocketHandshakeRequest(state, event) {
    const entry = getPending(state, event.requestId);
    if (!entry) return;
    entry.startMonotonic = finiteNumber(event.timestamp) ?? entry.startMonotonic;
    const wallTime = finiteNumber(event.wallTime);
    if (wallTime !== null) entry.timestamp = Math.round(wallTime * 1000);
  }

  /** @param {TabCaptureState} state @param {Record<string, unknown>} event */
  function handleWebSocketHandshakeResponse(state, event) {
    const entry = getPending(state, event.requestId);
    if (!entry || !isRecord(event.response)) return;
    entry.status = finiteNumber(event.response.status) ?? 0;
    entry.established = entry.status >= 100 && entry.status < 400;
  }

  /** @param {TabCaptureState} state @param {Record<string, unknown>} event */
  function handleWebTransportCreated(state, event) {
    const transportId = boundString(event.transportId, 256);
    if (!transportId) return;
    addPending(
      state,
      transportId,
      createSpecialPendingEntry(transportId, event.url, '', 'WebTransport', event.timestamp)
    );
  }

  /** @param {TabCaptureState} state @param {string} id @param {PendingNetworkEntry} entry */
  function addPending(state, id, entry) {
    if (!state.inflight.has(id) && state.inflight.size >= maxInflight) {
      const oldest = state.inflight.keys().next().value;
      if (typeof oldest === 'string') state.inflight.delete(oldest);
      state.dropped += 1;
      state.abandoned += 1;
    }
    state.inflight.set(id, entry);
  }

  /**
   * @param {TabCaptureState} state
   * @param {unknown} requestId
   * @param {unknown} timestamp
   * @param {string | undefined} failureReason
   */
  function finishRequest(state, requestId, timestamp, failureReason) {
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

  return { start, clear, read, stop, handleDetach, handleEvent, getDiagnostics };
}

/** @param {boolean} [armed] @returns {TabCaptureState} */
function createState(armed = true) {
  return {
    entries: [],
    inflight: new Map(),
    dropped: 0,
    abandoned: 0,
    startedAt: Date.now(),
    networkEnabled: armed,
    ownsDebugger: true,
    everArmed: armed,
    status: armed ? 'armed' : 'stop_failed',
  };
}

/** @param {TabCaptureState} state */
function clearState(state) {
  state.entries.length = 0;
  state.abandoned = state.inflight.size;
  state.inflight.clear();
  state.dropped = 0;
  state.startedAt = Date.now();
}

/** @param {TabCaptureState} state */
function abandonInflight(state) {
  state.abandoned += state.inflight.size;
  state.inflight.clear();
}

/** @param {string} requestId @param {Record<string, unknown>} event @returns {PendingNetworkEntry} */
function createPendingEntry(requestId, event) {
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

/**
 * @param {string} requestId
 * @param {unknown} url
 * @param {unknown} method
 * @param {unknown} resourceType
 * @param {unknown} timestamp
 * @returns {PendingNetworkEntry}
 */
function createSpecialPendingEntry(requestId, url, method, resourceType, timestamp) {
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

/** @param {TabCaptureState} state @param {unknown} requestId */
function getPending(state, requestId) {
  const id = boundString(requestId, 256);
  return id ? state.inflight.get(id) : undefined;
}

/** @param {TabCaptureState} state @param {boolean} armedDuringCapture @param {boolean} [armed] */
function snapshot(state, armedDuringCapture, armed = state.status === 'armed') {
  return {
    entries: state.entries.map((entry) => structuredClone(entry)),
    dropped: state.dropped,
    abandoned: state.abandoned,
    armed,
    armedDuringCapture: armedDuringCapture || state.everArmed,
    ownershipHeld: state.ownsDebugger,
    captureState: armed ? 'armed' : state.ownsDebugger ? 'stop_failed' : 'stopped',
    startedAt: state.startedAt,
    inflight: state.inflight.size,
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

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @param {number} maxLength */
function boundString(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

/** @param {unknown} value @returns {number | null} */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
