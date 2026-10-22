import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { normalizeDownload } from '../src/downloads.js';
import { normalizeEmulation } from '../src/emulation.js';
import { FILE_CHUNK_BYTES, FILE_MAX_BYTES, normalizeFileParams } from '../src/files.js';
import { isHarDocument, isHarLog } from '../src/har.js';
import { normalizeRecording } from '../src/recording.js';
import { correlateReplayEvents, parseRecordingJournal, renderReplay } from '../src/replay.js';

const invalidRequest = { code: 'INVALID_REQUEST' };

test('recording options preserve explicit opt-ins and reject impossible sources and unsafe ranges', () => {
  assert.deepEqual(normalizeRecording('session.start', {}), {
    activity: true,
    network: false,
    bodies: false,
    messages: false,
    visual: false,
    followTabs: false,
    durable: false,
    replay: false,
    durationMs: 60000,
  });
  const options = {
    activity: false,
    network: true,
    bodies: true,
    messages: true,
    visual: true,
    followTabs: true,
    durable: true,
    replay: true,
    durationMs: 1800000,
  };
  assert.deepEqual(normalizeRecording('session.start', options), options);
  assert.equal(normalizeRecording('session.start', { activity: false, replay: true }).replay, true);
  for (const params of [
    { activity: false },
    { bodies: true },
    { messages: true },
    { network: 'true' },
    { durationMs: 999 },
    { durationMs: 1800001 },
    { durationMs: NaN },
    { cookies: true },
  ]) {
    assert.throws(() => normalizeRecording('session.start', params), invalidRequest);
  }
  const sessionId = 'session_example';
  assert.deepEqual(normalizeRecording('session.read', { sessionId }), {
    sessionId,
    cursor: 0,
    limit: 25,
    waitMs: 0,
  });
  assert.deepEqual(
    normalizeRecording('session.read', { sessionId, cursor: 12, limit: 100, waitMs: 25000 }),
    { sessionId, cursor: 12, limit: 100, waitMs: 25000 }
  );
  for (const params of [{ cursor: 0.5 }, { limit: 2.5 }, { limit: 101 }, { waitMs: 25001 }]) {
    assert.throws(
      () => normalizeRecording('session.read', { sessionId, ...params }),
      invalidRequest
    );
  }
  for (const method of ['session.status', 'session.stop', 'session.release']) {
    assert.deepEqual(normalizeRecording(method, { sessionId }), { sessionId });
    assert.throws(() => normalizeRecording(method, { sessionId, cursor: 1 }), invalidRequest);
  }
  assert.deepEqual(normalizeRecording('session.export', { sessionId }), {
    sessionId,
    format: 'json',
  });
  assert.deepEqual(normalizeRecording('session.export', { sessionId, format: 'html' }), {
    sessionId,
    format: 'html',
  });
  assert.throws(
    () => normalizeRecording('session.export', { sessionId, format: 'js' }),
    invalidRequest
  );
  assert.throws(() => normalizeRecording('session.stop', { sessionId: '' }), invalidRequest);

  const journalId = `journal_${'a'.repeat(64)}`;
  assert.deepEqual(normalizeRecording('session.journal_read', { journalId }), {
    journalId,
    offset: 0,
    maxBytes: 196608,
  });
  assert.deepEqual(normalizeRecording('session.journal_delete', { journalId }), { journalId });
  assert.deepEqual(
    normalizeRecording('session.journal_read', { journalId, offset: 17, maxBytes: 1 }),
    { journalId, offset: 17, maxBytes: 1 }
  );
  for (const params of [
    { journalId: '../recording' },
    { journalId: `journal_${'A'.repeat(64)}` },
    { offset: -1 },
    { offset: 0.5 },
    { maxBytes: 0.5 },
    { maxBytes: 196609 },
  ]) {
    assert.throws(
      () => normalizeRecording('session.journal_read', { journalId, ...params }),
      invalidRequest
    );
  }
  assert.throws(
    () => normalizeRecording('session.journal_delete', { journalId, offset: 1 }),
    invalidRequest
  );
});

test('file staging preserves binary chunks, empty files, and transfer offsets without accepting paths', () => {
  const bytes = Buffer.from([0, 1, 127, 128, 254, 255]);
  const first = normalizeFileParams('files.stage', {
    name: 'résumé.bin',
    size: bytes.length,
    data: bytes.toString('base64'),
  });
  assert.deepEqual(first, {
    name: 'résumé.bin',
    mimeType: 'application/octet-stream',
    size: 6,
    offset: 0,
    data: 'AAF/gP7/',
  });
  assert.deepEqual(Buffer.from(String(first.data), 'base64'), bytes);
  assert.deepEqual(normalizeFileParams('files.stage', { name: 'empty.txt', size: 0 }), {
    name: 'empty.txt',
    mimeType: 'application/octet-stream',
    size: 0,
    offset: 0,
    data: '',
  });
  const transferId = 'transfer_example';
  const chunk = Buffer.alloc(FILE_CHUNK_BYTES, 255).toString('base64');
  assert.deepEqual(
    normalizeFileParams('files.stage', { transferId, offset: FILE_CHUNK_BYTES, data: chunk }),
    {
      transferId,
      offset: FILE_CHUNK_BYTES,
      data: chunk,
    }
  );
  assert.deepEqual(normalizeFileParams('files.release', { transferId }), { transferId });
  for (const params of [
    { name: '../secret' },
    { name: 'C:\\secret' },
    { size: FILE_MAX_BYTES + 1 },
    { size: 1.5 },
    { offset: 0.5 },
    { data: 'YQ=' },
    { data: 'YQ==\n' },
    { data: 123 },
    { data: `${chunk}YQ==` },
    { extra: true },
  ]) {
    assert.throws(
      () => normalizeFileParams('files.stage', { name: 'upload.bin', size: 1, ...params }),
      invalidRequest
    );
  }
});

test('file inputs distinguish staged handles from absolute browser-local paths', () => {
  const target = { selector: 'input[type=file]' };
  assert.deepEqual(normalizeFileParams('input.set_files', { target, files: [] }), {
    target,
    files: [],
  });
  assert.deepEqual(
    normalizeFileParams('input.set_files', {
      target: { elementRef: 'el_1' },
      files: ['file_1', 'file_2'],
    }),
    {
      target: { elementRef: 'el_1' },
      files: ['file_1', 'file_2'],
    }
  );
  const paths = [
    '/home/user/report.txt',
    'C:\\Users\\user\\report.txt',
    '\\\\server\\share\\report.txt',
  ];
  assert.deepEqual(normalizeFileParams('input.set_files', { target, paths }), { target, paths });
  assert.deepEqual(normalizeFileParams('input.paste_image', { target, transferId: 'transfer_1' }), {
    target,
    transferId: 'transfer_1',
  });
  for (const params of [
    { target },
    { target, files: [], paths: [] },
    { target, paths: ['relative.txt'] },
    { target: { elementRef: 'el_1' }, paths: ['/file'] },
    { target: { selector: '' }, paths: ['/file'] },
    { target, files: Array(11).fill('file_1') },
    { target, files: 'file_1' },
    { target, files: [''] },
    { target: [], files: [] },
  ])
    assert.throws(() => normalizeFileParams('input.set_files', params), invalidRequest);
  assert.throws(() => normalizeFileParams('files.unknown', {}), invalidRequest);
});

test('resource and browser downloads reject credentials, executable schemes, and path traversal', () => {
  const url = 'https://example.test/report?format=csv';
  assert.deepEqual(normalizeFileParams('download.resource', { url }), {
    url,
    maxBytes: 8388608,
    timeoutMs: 30000,
  });
  assert.deepEqual(normalizeFileParams('download.resource', { url, maxBytes: 1, timeoutMs: 100 }), {
    url,
    maxBytes: 1,
    timeoutMs: 100,
  });
  assert.deepEqual(normalizeDownload('download.start', { url }), { url, saveAs: false });
  assert.deepEqual(
    normalizeDownload('download.start', { url, filename: 'résumé.csv', saveAs: true }),
    {
      url,
      filename: 'résumé.csv',
      saveAs: true,
    }
  );
  for (const badUrl of [
    'not a url',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/plain,hi',
    'https://user:pass@example.test/',
    'https://user@example.test/',
  ]) {
    assert.throws(() => normalizeDownload('download.start', { url: badUrl }), invalidRequest);
    assert.throws(() => normalizeFileParams('download.resource', { url: badUrl }), invalidRequest);
  }
  for (const filename of [
    '../secret',
    'folder/file',
    'folder\\file',
    'C:secret',
    '.',
    '..',
    'line\nbreak',
  ]) {
    assert.throws(() => normalizeDownload('download.start', { url, filename }), invalidRequest);
  }
  assert.throws(() => normalizeDownload('download.start', { url, saveAs: 1 }), invalidRequest);
  assert.throws(
    () => normalizeFileParams('download.resource', { url, maxBytes: FILE_MAX_BYTES + 1 }),
    invalidRequest
  );
  assert.throws(
    () => normalizeFileParams('download.resource', { url, timeoutMs: 60001 }),
    invalidRequest
  );
  for (const method of [
    'download.status',
    'download.pause',
    'download.resume',
    'download.cancel',
    'download.release',
  ]) {
    assert.deepEqual(normalizeDownload(method, { downloadId: 'download_1' }), {
      downloadId: 'download_1',
    });
    assert.throws(
      () => normalizeDownload(method, { downloadId: 'download_1', url }),
      invalidRequest
    );
  }
});

test('emulation expands presets without user-agent spoofing and preserves normalized settings', () => {
  const config = normalizeEmulation({
    device: { preset: 'phone', width: 400.4 },
    network: 'slow-3g',
    cpuRate: 4,
    locale: 'fr-CA',
    timezoneId: 'America/Toronto',
    geolocation: { latitude: 45.5, longitude: -73.6 },
  });
  assert.deepEqual(config, {
    device: { width: 400, height: 844, deviceScaleFactor: 3, mobile: true, touch: true },
    network: { offline: false, latencyMs: 2000, downloadKbps: 400, uploadKbps: 400 },
    cpuRate: 4,
    locale: 'fr-CA',
    timezoneId: 'America/Toronto',
    geolocation: { latitude: 45.5, longitude: -73.6, accuracy: 100 },
  });
  assert.deepEqual(normalizeEmulation(config), config);
  assert.deepEqual(normalizeEmulation({ device: { width: 800, height: 600 }, network: {} }), {
    device: { width: 800, height: 600, deviceScaleFactor: 1, mobile: false, touch: false },
    network: { offline: false, latencyMs: 0, downloadKbps: -1, uploadKbps: -1 },
  });
  assert.equal(normalizeEmulation({ device: 'tablet' }).device?.width, 820);
  assert.equal(normalizeEmulation({ network: 'offline' }).network?.offline, true);
  for (const params of [
    {},
    { device: 'toString' },
    { network: 'constructor' },
    { device: { width: 0, height: 1 } },
    { network: { downloadKbps: -0.5 } },
    { network: { uploadKbps: -0.5 } },
    { locale: 'invalid_locale' },
    { timezoneId: 'Not/AZone' },
    { cpuRate: Infinity },
    { geolocation: { latitude: 91, longitude: 0 } },
    { userAgent: 'OtherBrowser' },
  ])
    assert.throws(() => normalizeEmulation(params), invalidRequest);
});

test('HAR guards accept the 1.2 envelope while leaving entry validation to consumers', () => {
  const log = { version: '1.2', entries: [{ request: { method: 'GET' } }] };
  assert.equal(isHarLog(log), true);
  assert.equal(isHarDocument({ log }), true);
  assert.equal(isHarDocument({ log: { version: '1.2', entries: [] } }), true);
  for (const value of [
    null,
    undefined,
    0,
    '1.2',
    [],
    {},
    { version: '1.1', entries: [] },
    { version: '1.2', entries: {} },
  ]) {
    assert.equal(isHarLog(value), false);
    assert.equal(isHarDocument({ log: value }), false);
  }
  for (const value of [null, [], 'log', 1, {}]) assert.equal(isHarDocument(value), false);
});

test('journal recovery updates events in place, preserves bodies, and reports incomplete tails', () => {
  const records = [
    { kind: 'header', version: 1 },
    { kind: 'event', event: { seq: 2, type: 'request', tabId: 7, at: 110 } },
    {
      kind: 'event',
      event: {
        seq: 1,
        type: 'click',
        tabId: 7,
        at: 100,
        origin: 'trusted-event',
        label: 'é</script>',
      },
    },
    { kind: 'event-update', event: { seq: 2, type: 'request', tabId: 7, at: 110, status: 200 } },
    { kind: 'event-update', event: { seq: 3, type: 'page-error', tabId: 7, at: 120 } },
    { kind: 'event', event: { type: 'navigation', tabId: 8, at: 120 } },
    { kind: 'body', body: { requestId: 'request_1', data: 'résultat' } },
    { kind: 'frame', frame: { at: 100, data: 'YQ==' } },
    { kind: 'frame', frame: { at: 'bad', data: 'YQ==' } },
    { kind: 'end', gaps: 2, dropped: 3 },
  ];
  const text = `${records.map((record) => JSON.stringify(record)).join('\n')}\n\n`;
  const parsed = parseRecordingJournal(text);
  assert.equal(parsed.gaps, 2);
  assert.equal(parsed.dropped, 3);
  assert.deepEqual(parsed.frames, [{ at: 100, data: 'YQ==' }]);
  assert.deepEqual(parsed.bodies, [{ requestId: 'request_1', data: 'résultat' }]);
  assert.deepEqual(
    parsed.events.map((event) => event.seq),
    [2, 1, 3, undefined]
  );
  assert.equal(parsed.events[0].status, 200);
  assert.deepEqual(parsed.events[0].correlation, {
    actionSeq: 1,
    deltaMs: 10,
    basis: 'same-tab-time-window',
    causality: false,
  });
  assert.equal(parsed.events[3].correlation, undefined);
  assert.equal(parseRecordingJournal(`${text}{"kind":`).gaps, 3);
  assert.equal(parseRecordingJournal(`${JSON.stringify(records[1])}\n`).gaps, 1);
  assert.equal(parseRecordingJournal(`${JSON.stringify(records[1])}\n{"kind":`).gaps, 2);
  assert.throws(() => parseRecordingJournal('null\n'), /Invalid journal record/);
  assert.throws(() => parseRecordingJournal('{broken}\n'), SyntaxError);
});

test('replay correlation uses the latest preceding trusted action in the same tab and bounded time window', () => {
  const events: Array<Record<string, unknown>> = [
    { seq: 3, type: 'submit', at: 200, tabId: 1, origin: 'trusted-event' },
    { seq: 1, type: 'click', at: 100, tabId: 1, origin: 'trusted-event' },
    { seq: 2, type: 'input', at: 150, tabId: 2, origin: 'trusted-event' },
    { seq: 4, type: 'click', at: 201, tabId: 1, origin: 'synthetic' },
    { type: 'scroll', at: 202, tabId: 1, origin: 'trusted-event' },
    { type: 'click', at: NaN, tabId: 1, origin: 'trusted-event' },
    { type: 'request', at: 99, tabId: 1 },
    { type: 'request', at: 175, tabId: 1 },
    { type: 'navigation', at: 210, tabId: 2 },
    { type: 'page-error', at: 2200, tabId: 1 },
    { type: 'request', at: 2201, tabId: 1 },
    { type: 'request', at: 210, tabId: 3 },
    { type: 'request', at: Infinity, tabId: 1 },
  ];
  const correlated = correlateReplayEvents(events);
  assert.deepEqual(correlated[7].correlation, {
    actionSeq: 1,
    deltaMs: 75,
    basis: 'same-tab-time-window',
    causality: false,
  });
  assert.deepEqual(correlated[8].correlation, {
    actionSeq: 2,
    deltaMs: 60,
    basis: 'same-tab-time-window',
    causality: false,
  });
  assert.deepEqual(correlated[9].correlation, {
    actionSeq: 3,
    deltaMs: 2000,
    basis: 'same-tab-time-window',
    causality: false,
  });
  for (const index of [6, 10, 11, 12]) assert.equal(correlated[index].correlation, undefined);
  assert(
    events.every((event) => event.correlation === undefined),
    'correlation does not mutate recorded evidence'
  );
});

test('offline replay escapes hostile timeline data and plays ordered frames with tab-scoped click markers', () => {
  const hostile = '</script><script>globalThis.compromised=true</script>&';
  const html = renderReplay({
    frames: [
      { at: 3000, data: 'Yw==', tabId: 2, width: 400, height: 200 },
      { at: 1000, data: 'YQ==', tabId: 1, width: 200, height: 100 },
      { at: 2000, data: 'Yg==', tabId: 2, width: 400, height: 200 },
      { at: 1500, data: hostile },
      { at: Infinity, data: 'ZA==' },
    ],
    events: [
      { type: 'click', at: 1100, tabId: 1, x: 50, y: 20, label: hostile },
      { type: 'click', at: 2100, tabId: 1, x: 10, y: 10 },
      { type: 'click', at: 2200, tabId: 2, x: 100, y: 100 },
    ],
    gaps: NaN,
    dropped: 2,
    memoryWindow: true,
  });
  assert(!html.includes(hostile));
  assert.match(html, /0 capture gaps; 2 dropped events/);
  assert.match(html, /Retained memory window only/);
  const { document, Event } = parseHTML(html);
  const scripts = [...document.querySelectorAll('script')];
  assert.equal(scripts.length, 3, 'page data cannot introduce executable scripts');
  const nonce = scripts[2].getAttribute('nonce');
  assert(nonce);
  assert(scripts.every((script) => script.getAttribute('nonce') === nonce));
  assert(
    document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute('content')
      ?.includes(`script-src 'nonce-${nonce}'`)
  );
  const data = JSON.parse(scripts[0].textContent ?? '') as { frames: Array<{ at: number }> };
  assert.deepEqual(
    data.frames.map((frame) => frame.at),
    [1000, 2000, 3000]
  );
  const get = (id: string): HTMLElement => {
    const element = document.getElementById(id);
    assert(element);
    return element;
  };
  const callbacks = new Map<number, (now: number) => void>();
  let nextFrame = 0;
  Object.defineProperty(get('speed'), 'value', { configurable: true, writable: true, value: '1' });
  const context = vm.createContext({
    document,
    performance: { now: () => 0 },
    requestAnimationFrame: (callback: (now: number) => void) => {
      callbacks.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id: number) => callbacks.delete(id),
  });
  vm.runInContext(scripts[2].textContent ?? '', context);
  assert.equal(context.compromised, undefined);
  assert(get('events').textContent?.includes(hostile), 'hostile data remains visible as text');
  assert.equal(get('frame').getAttribute('src'), 'data:image/jpeg;base64,YQ==');
  const seek = get('seek') as HTMLInputElement;
  const setPosition = (value: number) => {
    seek.value = String(value);
    seek.dispatchEvent(new Event('input'));
  };
  setPosition(100);
  assert.equal(get('click').style.display, 'block');
  assert.equal(get('click').style.left, '25%');
  assert.equal(get('click').style.top, '20%');
  setPosition(1100);
  assert.equal(get('frame').getAttribute('src'), 'data:image/jpeg;base64,Yg==');
  assert.equal(get('click').style.display, 'none', 'other-tab click is not shown');
  setPosition(1200);
  assert.equal(get('click').style.top, '50%');
  setPosition(2000);
  assert.equal(get('click').style.display, 'none');
  get('play').click();
  assert.equal(get('play').textContent, 'Pause');
  const tick = (now: number) => {
    const entry = callbacks.entries().next().value;
    assert(entry);
    callbacks.delete(entry[0]);
    entry[1](now);
  };
  tick(100);
  assert.equal(seek.value, '100', 'playing from the end restarts');
  Reflect.set(get('speed'), 'value', '2');
  tick(600);
  assert.equal(seek.value, '1100');
  tick(1100);
  assert.equal(get('play').textContent, 'Play');
  assert.equal(callbacks.size, 0);
  assert.equal(get('time').textContent, '2.0 / 2.0 s');
  assert.match(
    renderReplay({ frames: [], events: [], gaps: 0, dropped: Infinity }),
    /0 dropped events/
  );
});
