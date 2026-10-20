// @ts-check

import {
  BridgeError,
  ERROR_CODES,
  sanitizeIncidentalText,
  sanitizeIncidentalUrl,
  sanitizeIncidentalValue,
} from '../../protocol/src/index.js';

/** @typedef {import('./recording-types.js').RecordingState} RecordingState */
/** @typedef {import('./recording-types.js').RecordingEvent} RecordingEvent */
const MAX_EVENTS = 4000;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** @param {import('./recording-types.js').RecordingDependencies} deps */
export function createRecordingController(deps) {
  /** @type {Map<number, RecordingState>} */
  const sessions = new Map();

  /** @param {number} tabId @param {string} owner @param {string} id */
  function owned(tabId, owner, id) {
    const state = sessions.get(tabId);
    if (!state || state.id !== id || state.owner !== owner)
      throw new BridgeError(
        ERROR_CODES.ARTIFACT_NOT_FOUND,
        'Recording expired or belongs to another connection, tab, or session.'
      );
    return state;
  }
  /** @param {RecordingState} state */
  function wake(state) {
    for (const callback of [...state.waiters]) callback();
  }
  /** @param {RecordingState} state */
  function summary(state) {
    return {
      sessionId: state.id,
      active: state.active,
      reason: state.reason,
      startedAt: state.startedAt,
      nextCursor: state.next,
      events: state.events.length,
      dropped: state.dropped,
      gaps: state.gaps,
      bodies: state.bodies.length,
      pendingBodies: state.bodyTasks.size + state.queue.length,
      frames: state.frames.length,
      bytes: state.bytes + state.bodyBytes + state.frameBytes,
      sources: state.options,
    };
  }
  /** @param {RecordingState} state @param {Record<string, unknown>} input @returns {RecordingEvent | null} */
  function append(state, input) {
    const event = /** @type {RecordingEvent} */ ({
      ...input,
      at: typeof input.at === 'number' ? input.at : Date.now(),
      seq: state.next,
      type: String(input.type),
    });
    const size = new TextEncoder().encode(JSON.stringify(event)).length;
    if (state.events.length >= MAX_EVENTS || state.bytes + size > MAX_EVENT_BYTES) {
      state.dropped++;
      if (state.active) void stopState(state, 'event_quota').catch(() => {});
      return null;
    }
    state.next++;
    state.events.push(event);
    state.bytes += size;
    wake(state);
    return event;
  }
  /** @param {RecordingState} state @param {string} reason */
  function gap(state, reason) {
    state.gaps++;
    append(state, { type: 'gap', reason });
  }

  /** @param {RecordingState} state @param {Awaited<ReturnType<import('./recording-types.js').RecordingDependencies['page']>>} result */
  function ingest(state, result) {
    if (state.epoch && result.epoch && state.epoch !== result.epoch) gap(state, 'document_changed');
    if (result.epoch) state.epoch = result.epoch;
    state.dropped += Math.max(0, result.dropped);
    if (result.dropped) gap(state, 'page_buffer_overflow');
    for (const input of result.events.slice(0, 128)) {
      // A strict copy keeps unexpected page data out of the recorder.
      if (!['click', 'input', 'change', 'submit', 'scroll'].includes(String(input.type))) continue;
      append(state, {
        type: String(input.type),
        at:
          typeof input.at === 'number' && Number.isFinite(input.at)
            ? Math.max(state.startedAt, Math.min(Date.now(), input.at))
            : Date.now(),
        label: sanitizeIncidentalText(String(input.label ?? '').slice(0, 160)),
        role: String(input.role ?? '').slice(0, 40),
        origin: 'trusted-event',
        ...(input.type === 'input'
          ? { value: '[redacted]', count: Math.max(1, Math.min(100000, Number(input.count) || 1)) }
          : {}),
        ...(input.type === 'scroll'
          ? { x: boundedCoordinate(input.x), y: boundedCoordinate(input.y) }
          : {}),
      });
    }
  }

  /** @param {RecordingState} state */
  async function collect(state) {
    await state.assertAccess();
    if (!state.active) return;
    if (state.options.activity) {
      const result = await deps.page(state.tabId, 'drain', state.id);
      await state.assertAccess();
      if (!state.active) return;
      if (result.missing || !result.active) {
        gap(state, 'recorder_missing_or_navigation');
        const started = await deps.page(state.tabId, 'start', state.id);
        state.epoch = started.epoch;
      } else ingest(state, result);
    }
    if (state.options.visual && Date.now() - state.lastFrame >= 2000) {
      state.lastFrame = Date.now();
      try {
        const data = await deps.captureFrame(state.tabId);
        await state.assertAccess();
        if (!state.active) return;
        if (data.length > 1024 * 1024 || state.frameBytes + data.length > MAX_FRAME_BYTES) {
          gap(state, 'frame_quota');
          void stopState(state, 'frame_quota').catch(() => {});
          return;
        }
        state.frames.push({ at: Date.now(), data });
        state.frameBytes += data.length;
      } catch {
        gap(state, 'frame_unavailable');
      }
    }
  }
  /** @param {RecordingState} state */
  function schedule(state) {
    if (!state.active) return;
    state.timer = setTimeout(
      () => {
        if (!state.active) return;
        if (Date.now() - state.startedAt >= state.options.durationMs) {
          void stopState(state, 'duration').catch(() => {});
          return;
        }
        state.poll = collect(state)
          .catch(() => {
            gap(state, 'access_or_document_unavailable');
            void stopState(state, 'capture_unavailable').catch(() => {});
          })
          .finally(() => {
            state.poll = null;
            schedule(state);
          });
      },
      Math.max(
        1,
        Math.min(
          state.options.activity ? 500 : state.options.visual ? 2000 : 5000,
          state.options.durationMs - (Date.now() - state.startedAt)
        )
      )
    );
    state.timer.unref?.();
  }

  /** @param {number} tabId @param {string} owner @param {import('./recording-types.js').RecordingOptions} options @param {() => Promise<void>} assertAccess */
  async function start(tabId, owner, options, assertAccess) {
    if (sessions.has(tabId) || sessions.size >= 2)
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        'A recording already exists for this tab, or two recordings are retained. Export/release it before starting another.'
      );
    /** @type {() => void} */
    let started = () => {};
    const starting = new Promise((resolve) => {
      started = () => resolve(undefined);
    });
    /** @type {RecordingState} */
    const state = {
      id: `session_${crypto.randomUUID()}`,
      owner,
      tabId,
      options,
      active: false,
      networkOwned: false,
      stopping: null,
      starting,
      reason: null,
      epoch: '',
      startedAt: Date.now(),
      lastFrame: 0,
      events: [],
      bytes: 0,
      bodyBytes: 0,
      frameBytes: 0,
      dropped: 0,
      gaps: 0,
      next: 0,
      pending: new Map(),
      bodies: [],
      frames: [],
      bodyTasks: new Set(),
      queue: [],
      waiters: new Set(),
      poll: null,
      assertAccess,
    };
    sessions.set(tabId, state);
    try {
      await assertAccess();
      if (options.network) {
        await deps.startNetwork(tabId);
        state.networkOwned = true;
        if (options.bodies)
          await deps.send(tabId, 'Network.enable', {
            maxTotalBufferSize: 2 * 1024 * 1024,
            maxResourceBufferSize: 128 * 1024,
            maxPostDataSize: 0,
          });
      }
      await assertAccess();
      if (sessions.get(tabId) !== state || state.reason !== null)
        throw new Error('Recording cancelled during startup.');
      if (options.activity) state.epoch = (await deps.page(tabId, 'start', state.id)).epoch;
      await assertAccess();
      if (sessions.get(tabId) !== state || state.reason !== null)
        throw new Error('Recording cancelled during startup.');
      state.active = true;
      append(state, {
        type: 'start',
        coverage: 'top-document activity; CDP tab network; sampled renderer frames',
        values: 'redacted',
        visualPrivacy: options.visual ? 'visible pixels may contain sensitive data' : 'disabled',
      });
      schedule(state);
      started();
      return summary(state);
    } catch (error) {
      started();
      await stopState(state, 'start_failed').catch(() => {});
      sessions.delete(tabId);
      throw error;
    }
  }

  /** Stop intake, collect final activity, drain bounded body tasks, then release instrumentation.
   * @param {RecordingState} state @param {string} reason */
  function stopState(state, reason) {
    if (state.stopping) return state.stopping;
    state.active = false;
    state.reason = reason;
    if (reason === 'revoked') {
      for (const job of state.queue) job.event.bodyError = 'cancelled';
      state.queue.length = 0;
    }
    clearTimeout(state.timer);
    wake(state);
    state.stopping = (async () => {
      await state.starting;
      await state.poll;
      if (state.options.activity) {
        try {
          ingest(state, await deps.page(state.tabId, 'stop', state.id));
        } catch {
          gap(state, 'final_activity_unavailable');
        }
      }
      // Complete queued response-body reads while Network is still enabled.
      while (state.bodyTasks.size) await Promise.allSettled([...state.bodyTasks]);
      if (state.networkOwned) {
        await deps.stopNetwork(state.tabId);
        state.networkOwned = false;
      }
      if (state.pending.size) {
        gap(state, 'unfinished_network_requests');
        state.pending.clear();
      }
      append(state, { type: 'stop', reason });
      state.expiry = setTimeout(() => {
        if (sessions.get(state.tabId) === state) sessions.delete(state.tabId);
      }, 300000);
      state.expiry.unref?.();
    })().catch((error) => {
      state.stopping = null;
      state.reason = 'stop_failed';
      throw error;
    });
    return state.stopping;
  }

  /** @param {number} tabId @param {string} owner @param {string} id */
  async function status(tabId, owner, id) {
    const state = owned(tabId, owner, id);
    await state.assertAccess();
    const live =
      state.active && state.options.activity
        ? await deps.page(tabId, 'status', id).catch(() => null)
        : null;
    return {
      ...summary(state),
      recorderAlive: state.options.activity
        ? live?.active === true && live.epoch === state.epoch
        : null,
    };
  }
  /** @param {number} tabId @param {string} owner @param {string} id @param {number} cursor @param {number} limit @param {number} waitMs */
  async function read(tabId, owner, id, cursor, limit, waitMs) {
    const state = owned(tabId, owner, id);
    if (cursor > state.next)
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        'Cursor is ahead of this recording. Use this sessionId and its returned nextCursor.'
      );
    if (waitMs && state.active && cursor === state.next) {
      if (state.waiters.size >= 4)
        throw new BridgeError(
          ERROR_CODES.INVALID_REQUEST,
          'At most four pending reads per recording.'
        );
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          state.waiters.delete(done);
          resolve(undefined);
        };
        const timer = setTimeout(done, waitMs);
        state.waiters.add(done);
      });
    }
    owned(tabId, owner, id);
    await state.assertAccess();
    const candidates = state.events.filter((entry) => entry.seq >= cursor).slice(0, limit);
    /** @type {RecordingEvent[]} */
    const events = [];
    let bytes = 0;
    for (const entry of candidates) {
      const { data, ...metadata } = entry;
      const compact = {
        ...metadata,
        ...(typeof data === 'string' ? { payloadCharacters: data.length } : {}),
      };
      const size = JSON.stringify(compact).length;
      if (bytes + size > 16000) break;
      events.push(compact);
      bytes += size;
    }
    return {
      sessionId: id,
      active: state.active,
      events,
      nextCursor: events.length ? Number(events.at(-1)?.seq) + 1 : cursor,
      hasMore: events.length ? Number(events.at(-1)?.seq) + 1 < state.next : false,
      gaps: state.gaps,
      dropped: state.dropped,
    };
  }
  /** @param {number} tabId @param {string} owner @param {string} id */
  async function stop(tabId, owner, id) {
    const state = owned(tabId, owner, id);
    await stopState(state, 'requested');
    return summary(state);
  }
  /** @param {number} tabId @param {string} owner @param {string} id */
  async function exportSession(tabId, owner, id) {
    const state = owned(tabId, owner, id);
    await stopState(state, 'exported');
    await state.assertAccess();
    return {
      ...summary(state),
      integrity: 'untrusted browser evidence',
      events: state.events,
      bodies: state.bodies,
      frames: state.frames,
      replay: 'sampled frames, not video; no external assets are loaded',
    };
  }
  /** @param {number} tabId */
  async function clear(tabId) {
    const state = sessions.get(tabId);
    if (!state) return;
    try {
      await stopState(state, 'revoked');
    } finally {
      if (sessions.get(tabId) === state) sessions.delete(tabId);
      clearTimeout(state.expiry);
      state.events.length = 0;
      state.bodies.length = 0;
      state.frames.length = 0;
      wake(state);
    }
  }
  /** @param {number} tabId @param {string} owner @param {string} id */
  async function release(tabId, owner, id) {
    owned(tabId, owner, id);
    await clear(tabId);
    return { released: true, sessionId: id };
  }
  /** @param {string} ownerId */
  async function clearTransportOwner(ownerId) {
    await Promise.allSettled(
      [...sessions.values()]
        .filter((state) => state.owner.startsWith(`${ownerId}:`))
        .map((state) => clear(state.tabId))
    );
  }

  /** @param {RecordingState} state */
  function pumpBodies(state) {
    while (state.queue.length && state.bodyTasks.size < 2) {
      const job = state.queue.shift();
      if (!job) break;
      const task = (async () => {
        try {
          const raw = await timedBodyRead(() =>
            deps.send(state.tabId, 'Network.getResponseBody', { requestId: job.requestId })
          );
          if (sessions.get(state.tabId) !== state || state.reason === 'revoked') return;
          if (!raw || typeof raw !== 'object' || !('body' in raw) || typeof raw.body !== 'string')
            throw new Error('Body unavailable');
          const base64 = 'base64Encoded' in raw && raw.base64Encoded === true;
          const maximum = base64 ? 174760 : 131072;
          const truncated = raw.body.length > maximum;
          const data = base64
            ? raw.body.slice(0, maximum - (maximum % 4))
            : redactPayload(raw.body.slice(0, maximum));
          const storedBytes = new TextEncoder().encode(data).length;
          if (state.bodyBytes + storedBytes > MAX_BODY_BYTES) {
            job.event.bodyError = 'body_quota';
            return;
          }
          state.bodyBytes += storedBytes;
          state.bodies.push({
            requestId: job.requestId,
            encoding: base64 ? 'base64' : 'utf8',
            data,
            truncated,
          });
          job.event.body = {
            storedBytes,
            encoding: base64 ? 'base64' : 'utf8',
            truncated,
            redaction: base64 ? 'none-binary' : 'best-effort',
          };
          delete job.event.bodyError;
        } catch {
          job.event.bodyError = 'unavailable_or_evicted';
        }
      })().finally(() => {
        state.bodyTasks.delete(task);
        pumpBodies(state);
        wake(state);
      });
      state.bodyTasks.add(task);
    }
  }

  /** @param {number} tabId @param {string} method @param {unknown} raw */
  function handleNetwork(tabId, method, raw) {
    const state = sessions.get(tabId);
    if (!state?.active || !state.options.network || !raw || typeof raw !== 'object') return;
    const p = /** @type {Record<string, unknown>} */ (raw);
    const requestId = typeof p.requestId === 'string' ? p.requestId.slice(0, 128) : '';
    if (!requestId) return;
    if (method === 'Network.webSocketCreated') {
      append(state, { type: 'websocket-open', requestId, url: sanitizeIncidentalUrl(p.url) });
    } else if (method === 'Network.webSocketClosed' || method === 'Network.webSocketFrameError') {
      append(state, {
        type: method === 'Network.webSocketClosed' ? 'websocket-close' : 'websocket-error',
        requestId,
        ...(method === 'Network.webSocketFrameError'
          ? { error: sanitizeIncidentalText(String(p.errorMessage ?? '').slice(0, 160)) }
          : {}),
      });
    } else if (
      method === 'Network.requestWillBeSent' &&
      p.request &&
      typeof p.request === 'object'
    ) {
      const request = /** @type {Record<string, unknown>} */ (p.request);
      if (state.pending.has(requestId)) {
        append(state, { ...state.pending.get(requestId), type: 'redirect', at: Date.now() });
      }
      if (state.pending.size >= 400) {
        gap(state, 'network_inflight_quota');
        state.dropped++;
        return;
      }
      state.pending.set(requestId, {
        seq: -1,
        at: Date.now(),
        type: 'request',
        requestId,
        url: sanitizeIncidentalUrl(request.url),
        method: String(request.method ?? '').slice(0, 16),
      });
    } else if (method === 'Network.responseReceived') {
      const entry = state.pending.get(requestId);
      const response =
        p.response && typeof p.response === 'object'
          ? /** @type {Record<string, unknown>} */ (p.response)
          : {};
      if (entry) {
        entry.status = Number(response.status) || 0;
        entry.mimeType = String(response.mimeType ?? '').slice(0, 120);
      }
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      const entry = state.pending.get(requestId);
      if (!entry) return;
      state.pending.delete(requestId);
      entry.durationMs = Date.now() - entry.at;
      if (method === 'Network.loadingFailed')
        entry.error = sanitizeIncidentalText(String(p.errorText ?? '').slice(0, 160));
      const saved = append(state, entry);
      if (saved && state.options.bodies && method === 'Network.loadingFinished') {
        saved.bodyError = 'pending';
        if (state.queue.length >= 32) saved.bodyError = 'queue_full';
        else {
          state.queue.push({ requestId, event: saved });
          pumpBodies(state);
        }
      }
    } else if (
      state.options.messages &&
      [
        'Network.webSocketFrameReceived',
        'Network.webSocketFrameSent',
        'Network.eventSourceMessageReceived',
      ].includes(method)
    ) {
      const response =
        p.response && typeof p.response === 'object'
          ? /** @type {Record<string, unknown>} */ (p.response)
          : p;
      const data = String(response.payloadData ?? response.data ?? '');
      append(state, {
        type: method === 'Network.eventSourceMessageReceived' ? 'sse' : 'websocket',
        requestId,
        direction: method.endsWith('Sent') ? 'sent' : 'received',
        opcode: Number(response.opcode) || null,
        data: redactPayload(data.slice(0, 4096)),
        truncated: data.length > 4096,
      });
    }
  }
  /** @param {number} tabId */
  function handleDetach(tabId) {
    const state = sessions.get(tabId);
    if (!state?.networkOwned || state.stopping) return;
    gap(state, 'debugger_detached');
    state.networkOwned = false;
    void stopState(state, 'debugger_detached').catch(() => {});
  }
  return {
    start,
    status,
    read,
    stop,
    exportSession,
    clear,
    release,
    clearTransportOwner,
    handleNetwork,
    handleDetach,
    has: (/** @type {number} */ tabId) => {
      const state = sessions.get(tabId);
      return Boolean(
        state?.options.network && (state.active || state.reason === null || state.networkOwned)
      );
    },
    tabIds: () => [...sessions.keys()],
  };
}

/** @param {unknown} value */
function boundedCoordinate(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(-1e7, Math.min(1e7, Math.round(value)))
    : 0;
}

/** @param {string} text */
export function redactPayload(text) {
  try {
    return JSON.stringify(sanitizeIncidentalValue(JSON.parse(text), { maxStringLength: 131072 }));
  } catch {
    return sanitizeIncidentalText(text, 131072)
      .replace(
        /(["']?(?:password|token|secret|api[_-]?key|authorization)["']?\s*[:=]\s*)[^,\s}]+/giu,
        '$1[redacted]'
      )
      .replace(/\bBearer\s+\S+/giu, 'Bearer [redacted]');
  }
}

/** @param {() => Promise<unknown>} send */
async function timedBodyRead(send) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    return await Promise.race([
      send(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Body read timeout')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
