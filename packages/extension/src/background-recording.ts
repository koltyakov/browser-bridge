import {
  BridgeError,
  ERROR_CODES,
  sanitizeIncidentalText,
  sanitizeIncidentalUrl,
  sanitizeIncidentalValue,
} from '../../../protocol/src/index.js';
import { correlateReplayEvents } from '../../../protocol/src/replay.js';

export type RecordingState = import('./recording-types.js').RecordingState;
export type RecordingEvent = import('./recording-types.js').RecordingEvent;
const MAX_EVENTS = 4000;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export function createRecordingController(
  deps: import('./recording-types.js').RecordingDependencies
) {
  const sessions: Map<number, RecordingState> = new Map();

  const findSession = (tabId: number) =>
    sessions.get(tabId) ?? [...sessions.values()].find((state) => state.children.has(tabId));

  function owned(tabId: number, owner: string, id: string) {
    const state = sessions.get(tabId);
    if (!state || state.id !== id || state.owner !== owner)
      throw new BridgeError(
        ERROR_CODES.ARTIFACT_NOT_FOUND,
        'Recording expired or belongs to another connection, tab, or session.'
      );
    return state;
  }

  function wake(state: RecordingState) {
    for (const callback of [...state.waiters]) callback();
  }

  function summary(state: RecordingState) {
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
      tabs: [state.tabId, ...state.children.keys()],
      ...(state.journal
        ? {
            journalId: state.journal.journalId,
            journalError: state.journalError,
            retention: '24 hours after last write; capability-protected daemon journal',
          }
        : {}),
    };
  }

  function persist(state: RecordingState, record: Record<string, unknown>) {
    if (!state.journal || state.journalError) return;
    const encoded = JSON.stringify(record);
    if (state.journalBytes + encoded.length > 2 * 1024 * 1024) {
      state.journalError = 'Journal backpressure limit reached.';
      void stopState(state, 'journal_backpressure').catch(() => {});
      return;
    }
    state.journalBytes += encoded.length;
    state.journalPending = state.journalPending
      .then(async () => {
        if (!state.journalError) await state.journal?.append(JSON.parse(encoded));
      })
      .catch((error) => {
        state.journalError = error instanceof Error ? error.message : String(error);
        void stopState(state, 'journal_write_failed').catch(() => {});
      })
      .finally(() => {
        state.journalBytes -= encoded.length;
      });
  }

  function append(state: RecordingState, input: Record<string, unknown>): RecordingEvent | null {
    const event = {
      ...input,
      at: typeof input.at === 'number' ? input.at : Date.now(),
      seq: state.next,
      type: String(input.type),
    } as RecordingEvent;
    const size = new TextEncoder().encode(JSON.stringify(event)).length;
    if (state.journal) {
      while (
        state.events.length &&
        (state.events.length >= MAX_EVENTS || state.bytes + size > MAX_EVENT_BYTES)
      ) {
        const removed = state.events.shift();
        state.bytes -= new TextEncoder().encode(JSON.stringify(removed)).length;
      }
    }
    if (state.events.length >= MAX_EVENTS || state.bytes + size > MAX_EVENT_BYTES) {
      state.dropped++;
      if (state.active) void stopState(state, 'event_quota').catch(() => {});
      return null;
    }
    state.next++;
    state.events.push(event);
    state.bytes += size;
    persist(state, { kind: 'event', event });
    wake(state);
    return event;
  }

  function gap(state: RecordingState, reason: string) {
    state.gaps++;
    append(state, { type: 'gap', reason });
  }

  function ingest(
    state: RecordingState,
    result: Awaited<ReturnType<import('./recording-types.js').RecordingDependencies['page']>>,
    tabId: number = state.tabId
  ) {
    const document = state.children.get(tabId) ?? state;
    if (document.epoch && result.epoch && document.epoch !== result.epoch)
      gap(state, 'document_changed');
    if (result.epoch) document.epoch = result.epoch;
    state.dropped += Math.max(0, result.dropped);
    if (result.dropped) gap(state, 'page_buffer_overflow');
    for (const input of result.events.slice(0, 128)) {
      // A strict copy keeps unexpected page data out of the recorder.
      if (
        !['click', 'input', 'change', 'submit', 'scroll', 'navigation', 'page-error'].includes(
          String(input.type)
        )
      )
        continue;
      append(state, {
        type: String(input.type),
        tabId,
        at:
          typeof input.at === 'number' && Number.isFinite(input.at)
            ? Math.max(state.startedAt, Math.min(Date.now(), input.at))
            : Date.now(),
        label: sanitizeIncidentalText(String(input.label ?? '').slice(0, 160)),
        role: String(input.role ?? '').slice(0, 40),
        origin: 'trusted-event',
        ...(input.type === 'navigation'
          ? { url: sanitizeIncidentalUrl(input.url), origin: 'location-observation' }
          : {}),
        ...(input.type === 'page-error'
          ? { message: 'Uncaught page error', origin: 'page-event' }
          : {}),
        ...(input.target &&
        typeof input.target === 'object' &&
        'selector' in input.target &&
        typeof input.target.selector === 'string'
          ? { target: { selector: input.target.selector.slice(0, 1024) } }
          : {}),
        ...(input.type === 'input'
          ? { value: '[redacted]', count: Math.max(1, Math.min(100000, Number(input.count) || 1)) }
          : {}),
        ...(['scroll', 'click'].includes(String(input.type))
          ? { x: boundedCoordinate(input.x), y: boundedCoordinate(input.y) }
          : {}),
      });
    }
  }

  async function collect(state: RecordingState) {
    await state.assertAccess();
    if (!state.active) return;
    if (state.options.followTabs && deps.childTabs) {
      const tabs = await deps.childTabs(state.tabId);
      const visible = new Set(tabs.map((tab) => tab.id));
      for (const [id, child] of state.children) {
        if (visible.has(id)) continue;
        await deps.page(id, 'stop', state.id).catch(() => {});
        if (child.networkOwned) await deps.stopNetwork(id).catch(() => {});
        state.children.delete(id);
        append(state, { type: 'tab-left', tabId: id });
      }
      for (const tab of tabs) {
        if (state.children.size >= 8) break;
        if (
          tab.id === state.tabId ||
          findSession(tab.id) ||
          !(tab.openerTabId === state.tabId || state.children.has(tab.openerTabId ?? -1))
        )
          continue;
        await state.assertAccess();
        await deps.assertTab?.(tab.id);
        state.children.set(tab.id, { epoch: '', networkOwned: false });
        const child = state.children.get(tab.id);
        if (child && state.options.network) {
          await deps.startNetwork(tab.id);
          child.networkOwned = true;
        }
        append(state, { type: 'tab-joined', tabId: tab.id, openerTabId: tab.openerTabId });
      }
      for (const [id, child] of state.children) {
        await state.assertAccess();
        await deps.assertTab?.(id);
        if (!state.active) return;
        if (state.options.activity) {
          const result = await deps.page(id, 'drain', state.id);
          if (result.missing || !result.active)
            child.epoch = (
              await deps.page(
                id,
                'start',
                state.id,
                state.options.durationMs - (Date.now() - state.startedAt)
              )
            ).epoch;
          else ingest(state, result, id);
        }
      }
    }
    if (state.options.activity) {
      const result = await deps.page(state.tabId, 'drain', state.id);
      await state.assertAccess();
      if (!state.active) return;
      if (result.missing || !result.active) {
        gap(state, 'recorder_missing_or_navigation');
        const started = await deps.page(
          state.tabId,
          'start',
          state.id,
          state.options.durationMs - (Date.now() - state.startedAt)
        );
        state.epoch = started.epoch;
      } else ingest(state, result);
    }
    if (state.options.visual && !state.options.replay && Date.now() - state.lastFrame >= 2000) {
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
        persist(state, { kind: 'frame', frame: state.frames.at(-1) });
      } catch {
        gap(state, 'frame_unavailable');
      }
    }
  }

  function schedule(state: RecordingState) {
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

  async function start(
    tabId: number,
    owner: string,
    options: import('./recording-types.js').RecordingOptions,
    assertAccess: () => Promise<void>,
    journal?: RecordingState['journal']
  ) {
    if (findSession(tabId) || sessions.size >= 2)
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        'A recording already exists for this tab, or two recordings are retained. Export/release it before starting another.'
      );

    let started: () => void = (): void => {};
    const starting = new Promise<void>((resolve) => {
      started = () => resolve(undefined);
    });

    const state: RecordingState = {
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
      children: new Map(),
      journal,
      journalPending: Promise.resolve(),
      journalBytes: 0,
      journalError: null,
      replayOwned: false,
    };
    sessions.set(tabId, state);
    try {
      await assertAccess();
      if (options.replay) {
        if (!deps.acquireReplay) throw new Error('Renderer replay is unavailable.');
        await deps.acquireReplay(tabId);
        state.replayOwned = true;
      }
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
      if (options.activity)
        state.epoch = (await deps.page(tabId, 'start', state.id, options.durationMs)).epoch;
      await assertAccess();
      if (sessions.get(tabId) !== state || state.reason !== null)
        throw new Error('Recording cancelled during startup.');
      state.active = true;
      persist(state, {
        kind: 'header',
        sessionId: state.id,
        startedAt: state.startedAt,
        tabId,
        options,
      });
      if (options.replay)
        await deps.send(tabId, 'Page.startScreencast', {
          format: 'jpeg',
          quality: 50,
          maxWidth: 1280,
          maxHeight: 900,
          everyNthFrame: 6,
        });
      append(state, {
        type: 'start',
        coverage: options.followTabs
          ? 'root and up to eight opener descendants: top-document activity and CDP network; root-tab visuals'
          : 'top-document activity; CDP tab network; root-tab visuals',
        values: 'redacted',
        visualPrivacy: options.visual ? 'visible pixels may contain sensitive data' : 'disabled',
      });
      schedule(state);
      await state.journalPending;
      if (state.journalError) throw new Error(state.journalError);
      started();
      return summary(state);
    } catch (error) {
      started();
      await stopState(state, 'start_failed').catch(() => {});
      sessions.delete(tabId);
      throw error;
    }
  }

  /** Stop intake, collect final activity, drain bounded body tasks, then release instrumentation. */
  function stopState(state: RecordingState, reason: string) {
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
      if (state.replayOwned) {
        await deps.send(state.tabId, 'Page.stopScreencast', {}).catch(() => {
          gap(state, 'replay_stop_failed');
        });
        await deps.releaseReplay?.(state.tabId);
        state.replayOwned = false;
      }
      for (const [id] of state.children) {
        try {
          if (state.options.activity) ingest(state, await deps.page(id, 'stop', state.id), id);
        } catch {
          gap(state, 'child_activity_unavailable');
        }
      }
      if (state.options.activity) {
        try {
          ingest(state, await deps.page(state.tabId, 'stop', state.id));
        } catch {
          gap(state, 'final_activity_unavailable');
        }
      }
      // Complete queued response-body reads while Network is still enabled.
      while (state.bodyTasks.size) await Promise.allSettled([...state.bodyTasks]);
      for (const [id, child] of state.children) {
        if (child.networkOwned) {
          await deps.stopNetwork(id);
          child.networkOwned = false;
        }
      }
      if (state.networkOwned) {
        await deps.stopNetwork(state.tabId);
        state.networkOwned = false;
      }
      if (state.pending.size) {
        gap(state, 'unfinished_network_requests');
        state.pending.clear();
      }
      append(state, { type: 'stop', reason });
      persist(state, { kind: 'end', ...summary(state) });
      await state.journalPending;
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

  async function status(tabId: number, owner: string, id: string) {
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

  async function read(
    tabId: number,
    owner: string,
    id: string,
    cursor: number,
    limit: number,
    waitMs: number
  ) {
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
    const candidates = correlateReplayEvents(state.events)
      .filter((entry) => entry.seq >= cursor)
      .slice(0, limit);

    const events: RecordingEvent[] = [];
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
      droppedBeforeCursor: Math.max(0, (state.events[0]?.seq ?? cursor) - cursor),
      journalError: state.journalError,
    };
  }

  async function stop(tabId: number, owner: string, id: string) {
    const state = owned(tabId, owner, id);
    await stopState(state, 'requested');
    return summary(state);
  }

  async function exportSession(tabId: number, owner: string, id: string) {
    const state = owned(tabId, owner, id);
    await stopState(state, 'exported');
    await state.assertAccess();
    return {
      ...summary(state),
      integrity: 'untrusted browser evidence',
      events: correlateReplayEvents(state.events),
      bodies: state.bodies,
      frames: state.frames,
      replay: state.options.replay
        ? 'continuous renderer frames with timed playback; no external assets'
        : 'sampled frames, not video; no external assets are loaded',
      replayMode: state.options.replay ? 'renderer-stream' : 'sampled-frames',
      memoryWindow: Boolean(state.journal),
    };
  }

  async function clear(tabId: number) {
    const state = findSession(tabId);
    if (!state) return;
    try {
      await stopState(state, 'revoked');
    } finally {
      if (sessions.get(state.tabId) === state) sessions.delete(state.tabId);
      clearTimeout(state.expiry);
      state.events.length = 0;
      state.bodies.length = 0;
      state.frames.length = 0;
      wake(state);
    }
  }

  async function release(tabId: number, owner: string, id: string) {
    owned(tabId, owner, id);
    await clear(tabId);
    return { released: true, sessionId: id };
  }

  async function clearTransportOwner(ownerId: string) {
    await Promise.allSettled(
      [...sessions.values()]
        .filter((state) => state.owner.startsWith(`${ownerId}:`))
        .map((state) => clear(state.tabId))
    );
  }

  function pumpBodies(state: RecordingState) {
    while (state.queue.length && state.bodyTasks.size < 2) {
      const job = state.queue.shift();
      if (!job) break;
      const task = (async () => {
        try {
          const raw = await timedBodyRead(() =>
            deps.send(job.tabId, 'Network.getResponseBody', { requestId: job.requestId })
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
          if (state.journal)
            while (state.bodies.length && state.bodyBytes + storedBytes > MAX_BODY_BYTES) {
              const removed = state.bodies.shift();
              state.bodyBytes -= new TextEncoder().encode(removed?.data ?? '').length;
            }
          if (state.bodyBytes + storedBytes > MAX_BODY_BYTES) {
            job.event.bodyError = 'body_quota';
            return;
          }
          state.bodyBytes += storedBytes;
          state.bodies.push({
            requestId: job.requestId,
            tabId: job.tabId,
            encoding: base64 ? 'base64' : 'utf8',
            data,
            truncated,
          });
          persist(state, { kind: 'body', body: state.bodies.at(-1) });
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
        persist(state, { kind: 'event-update', event: job.event });
        state.bodyTasks.delete(task);
        pumpBodies(state);
        wake(state);
      });
      state.bodyTasks.add(task);
    }
  }

  function handleNetwork(tabId: number, method: string, raw: unknown) {
    const state = findSession(tabId);
    if (method === 'Page.screencastFrame' && state?.replayOwned && raw && typeof raw === 'object') {
      const frame = raw as {
        sessionId?: number;
        data?: string;
        metadata?: { deviceWidth?: number; deviceHeight?: number };
      };
      // Acknowledge even when stopping so Chrome cannot stall its renderer stream.
      void deps
        .send(tabId, 'Page.screencastFrameAck', { sessionId: frame.sessionId })
        .catch(() => {});
      if (!state.active || typeof frame.data !== 'string') return;
      if (frame.data.length > 1024 * 1024) {
        gap(state, 'oversized_replay_frame');
        return;
      }
      if (state.journal)
        while (state.frames.length && state.frameBytes + frame.data.length > MAX_FRAME_BYTES)
          state.frameBytes -= state.frames.shift()?.data.length ?? 0;
      if (state.frameBytes + frame.data.length > MAX_FRAME_BYTES) {
        gap(state, 'frame_quota');
        void stopState(state, 'frame_quota').catch(() => {});
        return;
      }
      const saved = {
        at: Date.now(),
        data: frame.data,
        width: frame.metadata?.deviceWidth,
        height: frame.metadata?.deviceHeight,
        tabId,
      };
      state.frames.push(saved);
      state.frameBytes += frame.data.length;
      persist(state, { kind: 'frame', frame: saved });
      return;
    }
    if (!state?.active || !state.options.network || !raw || typeof raw !== 'object') return;
    const p = raw as Record<string, unknown>;
    const requestId = typeof p.requestId === 'string' ? p.requestId.slice(0, 128) : '';
    if (!requestId) return;
    if (method === 'Network.webSocketCreated') {
      append(state, {
        type: 'websocket-open',
        requestId,
        tabId,
        url: sanitizeIncidentalUrl(p.url),
      });
    } else if (method === 'Network.webSocketClosed' || method === 'Network.webSocketFrameError') {
      append(state, {
        type: method === 'Network.webSocketClosed' ? 'websocket-close' : 'websocket-error',
        tabId,
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
      const request = p.request as Record<string, unknown>;
      if (state.pending.has(`${tabId}:${requestId}`)) {
        append(state, {
          ...state.pending.get(`${tabId}:${requestId}`),
          type: 'redirect',
          at: Date.now(),
        });
      }
      if (state.pending.size >= 400) {
        gap(state, 'network_inflight_quota');
        state.dropped++;
        return;
      }
      state.pending.set(`${tabId}:${requestId}`, {
        seq: -1,
        at: Date.now(),
        type: 'request',
        requestId,
        tabId,
        url: sanitizeIncidentalUrl(request.url),
        method: String(request.method ?? '').slice(0, 16),
      });
    } else if (method === 'Network.responseReceived') {
      const entry = state.pending.get(`${tabId}:${requestId}`);
      const response =
        p.response && typeof p.response === 'object' ? (p.response as Record<string, unknown>) : {};
      if (entry) {
        entry.status = Number(response.status) || 0;
        entry.mimeType = String(response.mimeType ?? '').slice(0, 120);
      }
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      const entry = state.pending.get(`${tabId}:${requestId}`);
      if (!entry) return;
      state.pending.delete(`${tabId}:${requestId}`);
      entry.durationMs = Date.now() - entry.at;
      if (method === 'Network.loadingFailed')
        entry.error = sanitizeIncidentalText(String(p.errorText ?? '').slice(0, 160));
      const saved = append(state, entry);
      if (saved && state.options.bodies && method === 'Network.loadingFinished') {
        saved.bodyError = 'pending';
        if (state.queue.length >= 32) saved.bodyError = 'queue_full';
        else {
          state.queue.push({ requestId, event: saved, tabId });
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
        p.response && typeof p.response === 'object' ? (p.response as Record<string, unknown>) : p;
      const data = String(response.payloadData ?? response.data ?? '');
      append(state, {
        type: method === 'Network.eventSourceMessageReceived' ? 'sse' : 'websocket',
        tabId,
        requestId,
        direction: method.endsWith('Sent') ? 'sent' : 'received',
        opcode: Number(response.opcode) || null,
        data: redactPayload(data.slice(0, 4096)),
        truncated: data.length > 4096,
      });
    }
  }

  function handleDetach(tabId: number) {
    const state = findSession(tabId);
    if ((!state?.networkOwned && !state?.replayOwned) || state.stopping) return;
    gap(state, 'debugger_detached');
    if (tabId === state.tabId) state.networkOwned = false;
    else {
      const child = state.children.get(tabId);
      if (child) child.networkOwned = false;
    }
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
    has: (tabId: number) => {
      const state = findSession(tabId);
      return Boolean(
        state?.options.network && (state.active || state.reason === null || state.networkOwned)
      );
    },
    tabIds: () => [...sessions.keys()],
  };
}

function boundedCoordinate(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(-1e7, Math.min(1e7, Math.round(value)))
    : 0;
}

export function redactPayload(text: string) {
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

async function timedBodyRead(send: () => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
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
