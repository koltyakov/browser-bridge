import test from 'node:test';
import assert from 'node:assert/strict';

import { createCdpNetworkCapture } from '../src/background-cdp-network.js';
import { createFetchInterceptor } from '../src/background-fetch-intercept.js';
import { TabDebuggerCoordinator } from '../src/debugger-coordinator.js';

type EventParams = Record<string, unknown>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHarness(options: { maxEntries?: number; ttlMs?: number } = {}) {
  const commands: string[] = [];
  const acquired: number[] = [];
  const released: number[] = [];
  const capture = createCdpNetworkCapture({
    maxEntries: options.maxEntries,
    ttlMs: options.ttlMs,
    async acquireDebugger(tabId) {
      acquired.push(tabId);
    },
    async releaseDebugger(tabId) {
      released.push(tabId);
    },
    async sendCommand(_target, method) {
      commands.push(method);
      return {};
    },
  });
  return { capture, commands, acquired, released };
}

function emitRequest(
  capture: ReturnType<typeof createCdpNetworkCapture>,
  requestId: string,
  type: string,
  timestamp: number,
  extra: EventParams = {}
) {
  capture.handleEvent(1, 'Network.requestWillBeSent', {
    requestId,
    type,
    timestamp,
    wallTime: 1_700_000_000 + timestamp,
    request: {
      url: `https://example.com/${requestId}`,
      method: 'GET',
      headers: { Authorization: 'Bearer do-not-return', Cookie: 'secret=1' },
      postData: 'private body',
    },
    initiator: { stack: { callFrames: [{ url: 'private-source.js' }] } },
    ...extra,
  });
}

test('CDP network capture has explicit start, clear, read, and stop lifecycle', async () => {
  const { capture, commands, acquired, released } = createHarness();
  const before = await capture.read(1);
  assert.equal(before.armed, false);

  const started = await capture.start(1);
  assert.equal(started.armed, true);
  assert.deepEqual(acquired, [1]);
  assert.deepEqual(commands, ['Network.enable']);
  assert.deepEqual(capture.getDiagnostics(), {
    status: 'armed',
    activeTabCount: 1,
    ownershipCount: 1,
    inflightCount: 0,
  });

  emitRequest(capture, 'first', 'Document', 1);
  emitRequest(capture, 'abandoned-by-clear', 'Fetch', 1.01);
  capture.handleEvent(1, 'Network.loadingFinished', { requestId: 'first', timestamp: 1.025 });
  assert.equal((await capture.read(1)).entries.length, 1);
  const cleared = await capture.clear(1);
  assert.equal(cleared.entries.length, 0);
  assert.equal(cleared.abandoned, 1);
  assert.equal((await capture.read(1)).entries.length, 0);

  emitRequest(capture, 'second', 'Script', 2);
  assert.equal(capture.getDiagnostics().inflightCount, 1);
  capture.handleEvent(1, 'Network.loadingFinished', { requestId: 'second', timestamp: 2.05 });
  const stopped = await capture.stop(1);
  assert.equal(stopped.armed, false);
  assert.equal(stopped.armedDuringCapture, true);
  assert.equal(stopped.entries.length, 1);
  assert.deepEqual(commands, ['Network.enable', 'Network.disable']);
  assert.deepEqual(released, [1]);
  assert.equal((await capture.read(1)).captureState, 'stopped');
  assert.deepEqual(capture.getDiagnostics(), {
    status: 'stopped',
    activeTabCount: 0,
    ownershipCount: 0,
    inflightCount: 0,
  });
});

test('CDP network capture records every resource type with only allowlisted metadata', async () => {
  const { capture } = createHarness();
  await capture.start(1);
  const resourceTypes = [
    'Document',
    'Stylesheet',
    'Image',
    'Media',
    'Font',
    'Script',
    'TextTrack',
    'XHR',
    'Fetch',
    'Prefetch',
    'EventSource',
    'WebSocket',
    'Manifest',
    'SignedExchange',
    'Ping',
    'CSPViolationReport',
    'Preflight',
    'Other',
  ];
  resourceTypes.forEach((type, index) => {
    const id = `resource-${index}`;
    emitRequest(capture, id, type, index + 1);
    capture.handleEvent(1, 'Network.responseReceived', {
      requestId: id,
      type,
      response: {
        status: 200,
        mimeType: 'text/plain',
        protocol: 'h2',
        headers: { 'Set-Cookie': 'private=1' },
        securityDetails: { issuer: 'private' },
      },
    });
    capture.handleEvent(1, 'Network.loadingFinished', {
      requestId: id,
      timestamp: index + 1.01,
      encodedDataLength: 999,
    });
  });

  const result = await capture.read(1);
  assert.deepEqual(
    result.entries.map((entry) => entry.resourceType),
    resourceTypes
  );
  const serialized = JSON.stringify(result);
  for (const secret of [
    'Bearer do-not-return',
    'secret=1',
    'private body',
    'private-source.js',
    'private=1',
    'issuer',
    'headers',
    'postData',
    'securityDetails',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
});

test('CDP network capture summarizes redirects, cache sources, failures, and durations', async () => {
  const { capture } = createHarness();
  await capture.start(1);
  emitRequest(capture, 'redirected', 'Document', 10, {
    request: {
      url: 'https://user:password@example.com/redirect?token=first#private',
      method: 'GET',
    },
  });
  emitRequest(capture, 'redirected', 'Document', 10.1, {
    redirectResponse: { status: 302, headers: { Location: '/final' } },
    request: { url: 'https://example.com/final?code=private#fragment', method: 'GET' },
  });
  capture.handleEvent(1, 'Network.requestServedFromCache', { requestId: 'redirected' });
  capture.handleEvent(1, 'Network.responseReceived', {
    requestId: 'redirected',
    type: 'Document',
    response: {
      status: 200,
      mimeType: 'text/html',
      protocol: 'h3',
      fromDiskCache: true,
      fromServiceWorker: true,
    },
  });
  capture.handleEvent(1, 'Network.loadingFinished', {
    requestId: 'redirected',
    timestamp: 10.25,
  });

  emitRequest(capture, 'failed', 'Image', 20);
  capture.handleEvent(1, 'Network.loadingFailed', {
    requestId: 'failed',
    timestamp: 20.125,
    errorText: 'net::ERR_FAILED',
    blockedReason: 'inspector',
  });

  const [redirected, failed] = (await capture.read(1)).entries;
  assert.equal(redirected?.redirect.count, 1);
  assert.deepEqual(redirected?.redirect.hops, [
    { url: 'https://example.com/redirect?token=%5Bredacted%5D', status: 302 },
  ]);
  assert.equal(redirected?.url, 'https://example.com/final?code=%5Bredacted%5D');
  assert.equal(redirected?.fromCache, true);
  assert.equal(redirected?.fromDiskCache, true);
  assert.equal(redirected?.fromServiceWorker, true);
  assert.equal(redirected?.duration, 250);
  assert.equal(failed?.failureReason, 'net::ERR_FAILED');
  assert.equal(failed?.duration, 125);
});

test('CDP network capture bounds overflow, redacts data and URL credentials, and clears on detach', async () => {
  const { capture } = createHarness({ maxEntries: 2 });
  await capture.start(1);
  for (let index = 0; index < 3; index += 1) {
    emitRequest(capture, `overflow-${index}`, 'Fetch', index + 1, {
      request: {
        url:
          index === 0
            ? 'data:text/plain,private-response-body'
            : 'https://user:password@example.com/resource',
        method: 'POST',
      },
    });
    capture.handleEvent(1, 'Network.loadingFinished', {
      requestId: `overflow-${index}`,
      timestamp: index + 1.01,
    });
  }
  const result = await capture.read(1);
  assert.equal(result.entries.length, 2);
  assert.equal(result.dropped, 1);
  assert.doesNotMatch(JSON.stringify(result), /password|private-response-body/);

  emitRequest(capture, 'detached-inflight', 'Fetch', 10);
  const detached = await capture.handleDetach(1);
  assert.equal(detached.abandoned, 1);
  assert.equal((await capture.read(1)).armed, false);
  assert.deepEqual((await capture.read(1)).entries, []);
});

test('CDP network URL metadata conservatively summarizes data/blob URLs and query values', async () => {
  const { capture } = createHarness({ maxEntries: 4 });
  await capture.start(1);
  const urls = [
    'data:text/html,<p>private payload</p>',
    'blob:https://example.com/private-object-id',
    'https://user:password@example.com/path?token=secret&page=2#private-fragment',
  ];
  urls.forEach((url, index) => {
    emitRequest(capture, `safe-${index}`, 'Fetch', index + 1, {
      request: { url, method: 'GET' },
    });
    capture.handleEvent(1, 'Network.loadingFinished', {
      requestId: `safe-${index}`,
      timestamp: index + 1.01,
    });
  });
  const entries = (await capture.read(1)).entries;
  assert.deepEqual(
    entries.map((entry) => entry.url),
    [
      'data:text/html;[redacted]',
      'blob:https://example.com/[redacted]',
      'https://example.com/path?token=%5Bredacted%5D&page=%5Bredacted%5D',
    ]
  );
  assert.doesNotMatch(JSON.stringify(entries), /private|secret|password|object-id/);
});

test('CDP network capture handles realistic WebSocket and WebTransport lifecycles without frames', async () => {
  const { capture } = createHarness();
  await capture.start(1);
  capture.handleEvent(1, 'Network.webSocketCreated', {
    requestId: 'ws-1',
    url: 'wss://user:password@example.com/socket?token=secret#fragment',
    timestamp: 10,
    initiator: { stack: { callFrames: [{ functionName: 'private' }] } },
  });
  capture.handleEvent(1, 'Network.webSocketWillSendHandshakeRequest', {
    requestId: 'ws-1',
    timestamp: 10.1,
    wallTime: 1_700_000_010,
    request: { headers: { Cookie: 'private=1', Authorization: 'secret' } },
  });
  capture.handleEvent(1, 'Network.webSocketHandshakeResponseReceived', {
    requestId: 'ws-1',
    timestamp: 10.2,
    response: { status: 101, headers: { 'Set-Cookie': 'private=1' } },
  });
  capture.handleEvent(1, 'Network.webSocketFrameReceived', {
    requestId: 'ws-1',
    timestamp: 10.3,
    response: { opcode: 1, payloadData: 'private frame body' },
  });
  capture.handleEvent(1, 'Network.webSocketFrameError', {
    requestId: 'ws-1',
    timestamp: 10.4,
    errorMessage: 'frame decode failed',
  });
  capture.handleEvent(1, 'Network.webSocketClosed', { requestId: 'ws-1', timestamp: 11.1 });

  capture.handleEvent(1, 'Network.webTransportCreated', {
    transportId: 'wt-1',
    url: 'https://example.com/transport?ticket=secret#fragment',
    timestamp: 20,
    initiator: { stack: { callFrames: [{ functionName: 'private' }] } },
  });
  capture.handleEvent(1, 'Network.webTransportConnectionEstablished', {
    transportId: 'wt-1',
    timestamp: 20.2,
  });
  capture.handleEvent(1, 'Network.webTransportClosed', {
    transportId: 'wt-1',
    timestamp: 21,
  });
  capture.handleEvent(1, 'Network.webTransportCreated', {
    transportId: 'wt-failed',
    url: 'https://example.com/failed-transport?ticket=secret',
    timestamp: 30,
  });
  capture.handleEvent(1, 'Network.webTransportClosed', {
    transportId: 'wt-failed',
    timestamp: 30.1,
  });

  const [webSocket, webTransport, failedWebTransport] = (await capture.read(1)).entries;
  assert.deepEqual(
    {
      type: webSocket?.resourceType,
      status: webSocket?.status,
      protocol: webSocket?.protocol,
      duration: webSocket?.duration,
      url: webSocket?.url,
    },
    {
      type: 'WebSocket',
      status: 101,
      protocol: 'websocket',
      duration: 1_000,
      url: 'wss://example.com/socket?token=%5Bredacted%5D',
    }
  );
  assert.equal(webSocket?.failureReason, 'frame decode failed');
  assert.deepEqual(
    {
      type: webTransport?.resourceType,
      status: webTransport?.status,
      protocol: webTransport?.protocol,
      duration: webTransport?.duration,
      url: webTransport?.url,
    },
    {
      type: 'WebTransport',
      status: 0,
      protocol: 'webtransport',
      duration: 1_000,
      url: 'https://example.com/transport?ticket=%5Bredacted%5D',
    }
  );
  assert.equal(failedWebTransport?.failureReason, 'closed before connection established');
  assert.doesNotMatch(
    JSON.stringify([webSocket, webTransport, failedWebTransport]),
    /private|secret|password|payloadData/
  );
});

test('per-tab lifecycle serialization does not publish armed state before enable or duplicate ownership', async () => {
  const acquireGate = deferred();
  let acquireCount = 0;
  let releaseCount = 0;
  const commands: string[] = [];
  const capture = createCdpNetworkCapture({
    async acquireDebugger() {
      acquireCount += 1;
      await acquireGate.promise;
    },
    async releaseDebugger() {
      releaseCount += 1;
    },
    async sendCommand(_target, method) {
      commands.push(method);
      return {};
    },
  });

  const firstStart = capture.start(1);
  const secondStart = capture.start(1);
  let readResolved = false;
  const queuedRead = capture.read(1).then((result) => {
    readResolved = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(readResolved, false);
  assert.equal(commands.length, 0);
  acquireGate.resolve();
  const [first, second, read] = await Promise.all([firstStart, secondStart, queuedRead]);
  assert.equal(first.armed, true);
  assert.equal(second.armed, true);
  assert.equal(read.armed, true);
  assert.equal(acquireCount, 1);
  assert.equal(commands.filter((method) => method === 'Network.enable').length, 1);

  const [stopped, alreadyStopped] = await Promise.all([capture.stop(1), capture.stop(1)]);
  assert.equal(stopped.armed, false);
  assert.equal(alreadyStopped.armed, false);
  assert.equal(releaseCount, 1);
  assert.equal(commands.filter((method) => method === 'Network.disable').length, 1);
});

test('detach invalidates an in-flight start before armed state publication', async () => {
  const enableGate = deferred();
  let enableStarted = false;
  const capture = createCdpNetworkCapture({
    async acquireDebugger() {},
    async releaseDebugger() {
      assert.fail('externally detached ownership must not be released twice');
    },
    async sendCommand(_target, method) {
      if (method === 'Network.enable') {
        enableStarted = true;
        await enableGate.promise;
      }
      return {};
    },
  });
  const starting = capture.start(1);
  while (!enableStarted) await new Promise((resolve) => setTimeout(resolve, 0));
  const detached = capture.handleDetach(1);
  enableGate.resolve();
  await assert.rejects(starting, /detached while starting/);
  await detached;
  const state = await capture.read(1);
  assert.equal(state.armed, false);
  assert.equal(state.ownershipHeld, false);
});

test('a stop requested during enable completes before the start response and releases once', async () => {
  const enableGate = deferred();
  let enableStarted = false;
  let releases = 0;
  const commands: string[] = [];
  const capture = createCdpNetworkCapture({
    async acquireDebugger() {},
    async releaseDebugger() {
      releases += 1;
    },
    async sendCommand(_target, method) {
      commands.push(method);
      if (method === 'Network.enable') {
        enableStarted = true;
        await enableGate.promise;
      }
      return {};
    },
  });
  const starting = capture.start(1);
  while (!enableStarted) await new Promise((resolve) => setTimeout(resolve, 0));
  const stopping = capture.stop(1);
  enableGate.resolve();
  const [startResult, stopResult] = await Promise.all([starting, stopping]);
  assert.equal(startResult.armed, false);
  assert.equal(startResult.captureState, 'stopped');
  assert.equal(stopResult.armed, false);
  assert.deepEqual(commands, ['Network.enable', 'Network.disable']);
  assert.equal(releases, 1);
  assert.equal((await capture.read(1)).ownershipHeld, false);
});

test('a start queued after an in-progress stop starts a fresh capture', async () => {
  const releaseGate = deferred();
  let releaseStarted = false;
  let acquireCount = 0;
  let releaseCount = 0;
  const commands: string[] = [];
  const capture = createCdpNetworkCapture({
    async acquireDebugger() {
      acquireCount += 1;
    },
    async releaseDebugger() {
      releaseCount += 1;
      if (releaseCount === 1) {
        releaseStarted = true;
        await releaseGate.promise;
      }
    },
    async sendCommand(_target, method) {
      commands.push(method);
      return {};
    },
  });

  await capture.start(1);
  const stopping = capture.stop(1);
  while (!releaseStarted) await new Promise((resolve) => setTimeout(resolve, 0));
  const restarting = capture.start(1);
  releaseGate.resolve();

  const [stopped, restarted] = await Promise.all([stopping, restarting]);
  assert.equal(stopped.captureState, 'stopped');
  assert.equal(restarted.armed, true);
  assert.equal(restarted.ownershipHeld, true);
  assert.deepEqual(commands, ['Network.enable', 'Network.disable', 'Network.enable']);
  assert.equal(acquireCount, 2);
  assert.equal(releaseCount, 1);

  await capture.stop(1);
  assert.equal(releaseCount, 2);
});

test('repeated concurrent stop-start-stop-start sequences preserve invocation ordering', async () => {
  let acquireCount = 0;
  let releaseCount = 0;
  let enableCount = 0;
  let disableCount = 0;
  const capture = createCdpNetworkCapture({
    async acquireDebugger() {
      acquireCount += 1;
    },
    async releaseDebugger() {
      releaseCount += 1;
    },
    async sendCommand(_target, method) {
      if (method === 'Network.enable') enableCount += 1;
      if (method === 'Network.disable') disableCount += 1;
      return {};
    },
  });

  await capture.start(1);
  for (let index = 0; index < 5; index += 1) {
    const [firstStop, canceledStart, secondStop, finalStart] = await Promise.all([
      capture.stop(1),
      capture.start(1),
      capture.stop(1),
      capture.start(1),
    ]);
    assert.equal(firstStop.armed, false);
    assert.equal(canceledStart.armed, false);
    assert.equal(secondStop.armed, false);
    assert.equal(finalStart.armed, true);
    assert.equal((await capture.read(1)).armed, true);
  }

  await capture.stop(1);
  assert.equal(acquireCount, releaseCount);
  assert.equal(enableCount, disableCount);
  assert.equal((await capture.read(1)).ownershipHeld, false);
});

test('enable cleanup failure preserves ownership for a later stop retry', async () => {
  let releases = 0;
  const capture = createCdpNetworkCapture({
    async acquireDebugger() {},
    async releaseDebugger() {
      releases += 1;
      if (releases === 1) throw new Error('cleanup release failed');
    },
    async sendCommand(_target, method) {
      if (method === 'Network.enable') throw new Error('enable failed');
      return {};
    },
  });
  await assert.rejects(capture.start(1), /enable failed/);
  const recoverable = await capture.read(1);
  assert.equal(recoverable.armed, false);
  assert.equal(recoverable.captureState, 'stop_failed');
  assert.equal(recoverable.ownershipHeld, true);
  const stopped = await capture.stop(1);
  assert.equal(stopped.captureState, 'stopped');
  assert.equal(stopped.ownershipHeld, false);
  assert.equal(releases, 2);
});

test('disable and release failures preserve retryable ownership without false stopped state', async () => {
  let disableAttempts = 0;
  let releaseAttempts = 0;
  const capture = createCdpNetworkCapture({
    async acquireDebugger() {},
    async releaseDebugger() {
      releaseAttempts += 1;
      if (releaseAttempts === 1) throw new Error('release failed');
    },
    async sendCommand(_target, method) {
      if (method === 'Network.disable') {
        disableAttempts += 1;
        if (disableAttempts === 1) throw new Error('disable failed');
      }
      return {};
    },
  });
  await capture.start(1);
  emitRequest(capture, 'unfinished', 'Fetch', 1);

  await assert.rejects(capture.stop(1), /disable failed/);
  const afterDisableFailure = await capture.read(1);
  assert.equal(afterDisableFailure.armed, true);
  assert.equal(afterDisableFailure.ownershipHeld, true);
  assert.equal(afterDisableFailure.inflight, 1);

  await assert.rejects(capture.stop(1), /release failed/);
  const afterReleaseFailure = await capture.read(1);
  assert.equal(afterReleaseFailure.armed, false);
  assert.equal(afterReleaseFailure.captureState, 'stop_failed');
  assert.equal(afterReleaseFailure.ownershipHeld, true);
  assert.equal(afterReleaseFailure.abandoned, 1);

  const stopped = await capture.stop(1);
  assert.equal(stopped.captureState, 'stopped');
  assert.equal(stopped.ownershipHeld, false);
  assert.equal(stopped.abandoned, 1);
  assert.equal(disableAttempts, 2);
  assert.equal(releaseAttempts, 2);
});

test('CDP Network and Fetch interception release their own domains without fighting holds', async () => {
  const events: string[] = [];
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      events.push('attach');
    },
    detach: async () => {
      events.push('detach');
    },
    initialize: async () => {
      events.push('Page.enable');
    },
    burstIdleMs: 1_000,
  });
  const capture = createCdpNetworkCapture({
    acquireDebugger: (tabId) => coordinator.acquire(tabId),
    releaseDebugger: (tabId) => coordinator.release(tabId),
    async sendCommand(_target, method) {
      events.push(method);
      return {};
    },
  });
  const interceptor = createFetchInterceptor({
    acquireDebugger: (tabId, initialize) => coordinator.acquire(tabId, initialize),
    releaseDebugger: (tabId) => coordinator.release(tabId),
    async sendCommand(_target, method) {
      events.push(method);
      return {};
    },
    addEventFilter() {},
    removeEventFilter() {},
  });

  await capture.start(1);
  await interceptor.addRule(1, { urlPattern: '*api*', action: 'continue' });
  await interceptor.clearAllRules(1);
  assert.equal(events.includes('Fetch.disable'), true);
  assert.equal(events.includes('detach'), false);
  assert.equal((await capture.read(1)).armed, true);

  await capture.stop(1);
  assert.equal(events.at(-1), 'detach');
  assert.equal(events.filter((event) => event === 'attach').length, 1);
});

test('CDP network capture safety TTL disables capture and releases its hold', async () => {
  const { capture, commands, released } = createHarness({ ttlMs: 5 });
  await capture.start(1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await capture.read(1)).armed, false);
  assert.equal(commands.includes('Network.disable'), true);
  assert.deepEqual(released, [1]);
});

test('CDP network safety TTL serializes and retries a failed stop', async () => {
  let disableAttempts = 0;
  let releases = 0;
  const capture = createCdpNetworkCapture({
    ttlMs: 5,
    ttlRetryMs: 5,
    async acquireDebugger() {},
    async releaseDebugger() {
      releases += 1;
    },
    async sendCommand(_target, method) {
      if (method === 'Network.disable') {
        disableAttempts += 1;
        if (disableAttempts === 1) throw new Error('transient disable failure');
      }
      return {};
    },
  });
  await capture.start(1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await capture.read(1)).captureState, 'stopped');
  assert.equal(disableAttempts, 2);
  assert.equal(releases, 1);
});
