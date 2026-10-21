import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingController, redactPayload } from '../src/background-recording.js';
import { renderRecording } from '../src/recording-export.js';
import { normalizeRecording } from '../../protocol/src/recording.js';
import type { RecordingDependencies, RecordingOptions } from '../src/recording-types.js';

const options: RecordingOptions = {
  activity: false,
  network: true,
  bodies: true,
  messages: true,
  visual: false,
  durationMs: 60000,
};
function setup(overrides: Partial<RecordingDependencies> = {}) {
  return createRecordingController({
    page: async () => ({ epoch: 'document', active: true, events: [], dropped: 0 }),
    captureFrame: async () => 'YQ==',
    startNetwork: async () => ({}),
    stopNetwork: async () => ({}),
    send: async () => ({ body: '{"token":"secret","ok":true}', base64Encoded: false }),
    ...overrides,
  });
}
function request(controller: ReturnType<typeof setup>, id: string, failed = false) {
  controller.handleNetwork(1, 'Network.requestWillBeSent', {
    requestId: id,
    request: { url: 'https://example.com/api?token=secret', method: 'GET' },
  });
  controller.handleNetwork(1, 'Network.responseReceived', {
    requestId: id,
    response: { status: 200, mimeType: 'application/json' },
  });
  controller.handleNetwork(1, failed ? 'Network.loadingFailed' : 'Network.loadingFinished', {
    requestId: id,
    errorText: 'failed',
  });
}

test('recording isolates connections and cursors, wakes readers, and keeps payloads in export only', async (t) => {
  const recorder = setup();
  t.after(() => recorder.clear(1));
  const started = await recorder.start(1, 'owner', options, async () => {});
  await assert.rejects(recorder.read(1, 'other', started.sessionId, 0, 25, 0), /belongs/);
  await assert.rejects(recorder.read(1, 'owner', 'other-session', 0, 25, 0), /belongs/);
  await assert.rejects(recorder.read(1, 'owner', started.sessionId, 100, 25, 0), /ahead/);
  const waiting = recorder.read(1, 'owner', started.sessionId, started.nextCursor, 25, 1000);
  recorder.handleNetwork(1, 'Network.eventSourceMessageReceived', {
    requestId: 'sse',
    data: '{"password":"secret","ok":true}',
  });
  const read = await waiting;
  assert.equal(read.events[0].type, 'sse');
  assert.equal('data' in read.events[0], false);
  request(recorder, 'http');
  const exported = await recorder.exportSession(1, 'owner', started.sessionId);
  assert.equal(exported.active, false);
  assert.equal(exported.bodies.length, 1);
  assert.doesNotMatch(JSON.stringify(exported), /secret/);
  assert.equal(exported.events.find((event) => event.requestId === 'http')?.status, 200);
  assert.equal(exported.events.find((event) => event.requestId === 'http')?.bodyError, undefined);
  assert.ok(exported.events.some((event) => event.type === 'stop'));
});

test('body failures stay separate from request success and network-only capture never reads bodies', async (t) => {
  let reads = 0;
  const recorder = setup({
    send: async (_tab, method) => {
      if (method === 'Network.getResponseBody') {
        reads++;
        throw new Error('evicted');
      }
      return {};
    },
  });
  t.after(() => recorder.clear(1));
  const started = await recorder.start(1, 'owner', options, async () => {});
  request(recorder, 'request');
  const exported = await recorder.exportSession(1, 'owner', started.sessionId);
  const entry = exported.events.find((event) => event.requestId === 'request');
  assert.equal(entry?.status, 200);
  assert.equal(entry?.error, undefined);
  assert.equal(entry?.bodyError, 'unavailable_or_evicted');
  assert.equal(reads, 1);
  await recorder.release(1, 'owner', started.sessionId);
  const metadata = await recorder.start(1, 'owner', { ...options, bodies: false }, async () => {});
  request(recorder, 'metadata');
  await recorder.stop(1, 'owner', metadata.sessionId);
  assert.equal(reads, 1);
});

test('body work is concurrency-bounded, overflow is explicit, and stop drains queued writes', async (t) => {
  let running = 0;
  let maximum = 0;
  const pending: Array<() => void> = [];
  let stopped = false;
  const recorder = setup({
    send: async (_tab, method) => {
      if (method !== 'Network.getResponseBody') return {};
      running++;
      maximum = Math.max(maximum, running);
      return new Promise((resolve) =>
        pending.push(() => {
          running--;
          resolve({ body: 'body' });
        })
      );
    },
    stopNetwork: async () => {
      stopped = true;
      assert.equal(running, 0);
    },
  });
  t.after(() => recorder.clear(1));
  const started = await recorder.start(1, 'owner', options, async () => {});
  for (let i = 0; i < 40; i++) request(recorder, `request-${i}`);
  assert.equal(maximum, 2);
  const stopping = recorder.stop(1, 'owner', started.sessionId);
  assert.equal(stopped, false);
  for (let i = 0; i < 20 && !stopped; i++) {
    for (const resolve of pending.splice(0)) resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await stopping;
  const exported = await recorder.exportSession(1, 'owner', started.sessionId);
  assert.equal(maximum, 2);
  assert.equal(exported.bodies.length, 34);
  assert.equal(exported.events.filter((event) => event.bodyError === 'queue_full').length, 6);
});

test('revocation during startup cannot leave a live recorder or release a different network owner', async () => {
  let resolveStart: () => void = () => {};
  let networkStops = 0;
  const recorder = setup({
    startNetwork: () =>
      new Promise<void>((resolve) => {
        resolveStart = resolve;
      }),
    stopNetwork: async () => {
      networkStops++;
    },
  });
  const starting = recorder.start(1, 'owner', options, async () => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  const clearing = recorder.clear(1);
  resolveStart();
  await assert.rejects(starting, /cancelled/);
  await clearing;
  assert.equal(networkStops, 1);
  assert.deepEqual(recorder.tabIds(), []);
  const blocked = setup({
    startNetwork: async () => {
      throw new Error('already owned');
    },
    stopNetwork: async () => {
      networkStops++;
    },
  });
  await assert.rejects(
    blocked.start(1, 'owner', options, async () => {}),
    /already owned/
  );
  assert.equal(networkStops, 1);
});

test('status probes the live recorder and final drain retains source time and redacts values', async (t) => {
  const at = Date.now();
  const recorder = setup({
    page: async (_tab, action) => ({
      epoch: 'doc',
      active: action !== 'status',
      events:
        action === 'stop'
          ? [
              {
                type: 'input',
                at,
                value: 'secret',
                label: 'safe',
                count: 2,
                html: '<script>bad</script>',
              },
            ]
          : [],
      dropped: 0,
    }),
  });
  t.after(() => recorder.clear(1));
  const started = await recorder.start(
    1,
    'owner',
    { ...options, activity: true, network: false, bodies: false, messages: false },
    async () => {}
  );
  assert.equal((await recorder.status(1, 'owner', started.sessionId)).recorderAlive, false);
  const exported = await recorder.exportSession(1, 'owner', started.sessionId);
  const input = exported.events.find((event) => event.type === 'input');
  assert.equal(input?.value, '[redacted]');
  assert.equal(input?.count, 2);
  assert.equal(input?.html, undefined);
  assert.doesNotMatch(JSON.stringify(exported), /secret/);
});

test('recording validation is strict and exported replay cannot execute site markup', () => {
  for (const params of [
    { bodies: true },
    { messages: true },
    { visual: 'true' },
    { durationMs: Infinity },
    { unknown: true },
  ])
    assert.throws(() => normalizeRecording('session.start', params));
  assert.throws(() => normalizeRecording('session.read', { sessionId: 'a', cursor: -1 }));
  assert.throws(() => normalizeRecording('session.export', { sessionId: 'a', format: 'js' }));
  assert.doesNotMatch(redactPayload('{"password":"secret","nested":{"token":"secret"}}'), /secret/);
  const html = renderRecording({
    frames: [
      { at: 0, data: 'YQ==' },
      { at: 0, data: '"><script>alert(1)</script>' },
    ],
    events: [{ type: '<script>evil()</script>' }],
    gaps: 1,
    dropped: 2,
  });
  assert.doesNotMatch(html, /<script|onerror|https?:\/\//u);
  assert.match(html, /&lt;script&gt;/u);
  assert.match(html, /default-src 'none'/u);
  assert.match(html, /1 capture gaps; 2 dropped events/u);
});

test('watch follows only opener descendants and correlates late-drained actions without claiming causality', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const startedTabs: number[] = [];
  const stoppedTabs: number[] = [];
  let clickAt = 0;
  let joined: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    joined = resolve;
  });
  const recorder = setup({
    childTabs: async () => [{ id: 1 }, { id: 2, openerTabId: 1 }, { id: 3 }],
    assertTab: async () => {},
    startNetwork: async (tab) => {
      startedTabs.push(tab);
    },
    stopNetwork: async (tab) => {
      stoppedTabs.push(tab);
    },
    page: async (tab, action) => {
      if (tab === 2 && action === 'drain') joined();
      return {
        epoch: String(tab),
        active: true,
        dropped: 0,
        events:
          action === 'stop' && tab === 2
            ? [{ type: 'click', at: clickAt, target: { selector: '#export' } }]
            : [],
      };
    },
  });
  t.after(() => recorder.clear(1));
  const started = await recorder.start(
    1,
    'owner',
    { ...options, activity: true, bodies: false, followTabs: true },
    async () => {}
  );
  // Drive the unreferenced poll timer without relying on other event-loop work.
  t.mock.timers.tick(500);
  await ready;
  clickAt = Date.now();
  recorder.handleNetwork(2, 'Network.requestWillBeSent', {
    requestId: 'child',
    request: { url: 'https://example.test/export', method: 'GET' },
  });
  recorder.handleNetwork(2, 'Network.loadingFinished', { requestId: 'child' });
  const exported = await recorder.exportSession(1, 'owner', started.sessionId);
  assert.deepEqual(startedTabs, [1, 2]);
  assert.deepEqual(stoppedTabs.sort(), [1, 2]);
  const request = exported.events.find((event) => event.requestId === 'child');
  assert.equal(request?.tabId, 2);
  assert.ok(request);
  assert.equal((request.correlation as { causality: boolean }).causality, false);
  assert.deepEqual(exported.events.find((event) => event.type === 'click')?.target, {
    selector: '#export',
  });
});

test('continuous replay acknowledges frames, journals in order, and surfaces disk failures', async (t) => {
  const commands: string[] = [];
  const records: Record<string, unknown>[] = [];
  let released = false;
  let fail = false;
  const recorder = setup({
    acquireReplay: async () => {},
    releaseReplay: async () => {
      released = true;
    },
    send: async (_tab, method) => {
      commands.push(method);
      return {};
    },
  });
  t.after(() => recorder.clear(1));
  const started = await recorder.start(
    1,
    'owner',
    { ...options, network: false, bodies: false, replay: true, durable: true },
    async () => {},
    {
      journalId: 'journal_test',
      append: async (record) => {
        if (fail) throw new Error('Disk full');
        records.push(record);
      },
    }
  );
  recorder.handleNetwork(1, 'Page.screencastFrame', {
    sessionId: 1,
    data: 'YQ==',
    metadata: { deviceWidth: 800, deviceHeight: 600 },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(records.some((record) => record.kind === 'frame'));
  fail = true;
  recorder.handleNetwork(1, 'Page.screencastFrame', { sessionId: 2, data: 'Yg==' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stopped = await recorder.stop(1, 'owner', started.sessionId);
  assert.equal(stopped.journalError, 'Disk full');
  assert.equal(stopped.reason, 'journal_write_failed');
  assert.equal(released, true);
  assert.ok(commands.includes('Page.stopScreencast'));
  assert.equal(commands.filter((command) => command === 'Page.screencastFrameAck').length, 2);
});
