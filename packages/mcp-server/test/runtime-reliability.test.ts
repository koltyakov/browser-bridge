import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/server';

import { BridgeClient } from '../../agent-client/src/client.js';
import { MAX_BATCH_CONCURRENCY } from '../../protocol/src/index.js';
import type { BridgeResponse } from '../../protocol/src/types.js';
import {
  makeSuccess as ok,
  makeFailure as fail,
} from '../../../tests/_helpers/protocolFactories.ts';
import { createBridgeMcpServer } from '../src/server.js';
import {
  handleArtifactTool,
  handleBatchTool,
  handlePatchTool,
  handleRawCallTool,
} from '../src/handlers.js';
import {
  requestBridgeWithRetry,
  runWithMcpRequestEra,
  waitForClientReconnect,
  withToolClient,
  type ToolResult,
} from '../src/handlers-utils.js';

type Request = Parameters<BridgeClient['request']>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mockBridge(t: TestContext, responder: (request: Request) => Promise<BridgeResponse>) {
  const requests: Request[] = [];
  const clients = new Set<BridgeClient>();
  const closed = new Set<BridgeClient>();
  t.mock.method(BridgeClient.prototype, 'connect', async function (this: BridgeClient) {
    clients.add(this);
    this.connected = true;
  });
  t.mock.method(BridgeClient.prototype, 'close', async function (this: BridgeClient) {
    closed.add(this);
    this.connected = false;
  });
  t.mock.method(BridgeClient.prototype, 'request', async function (request: Request) {
    requests.push(request);
    return responder(request);
  });
  return { requests, clients, closed };
}

test('raw artifact reads preserve exact bytes and pagination like the dedicated tool', async (t) => {
  const data = Buffer.alloc(8_000, 7).toString('base64');
  mockBridge(t, async (request) =>
    ok({
      artifactId: 'art_parity',
      data,
      offset: request.params?.offset ?? 0,
      byteLength: 8_000,
      totalBytes: 16_000,
      sha256: 'ab'.repeat(32),
      nextOffset: request.params?.offset === 8_000 ? null : 8_000,
      chunkIndex: request.params?.offset === 8_000 ? 1 : 0,
      chunkCount: 2,
    })
  );
  for (const offset of [0, 8_000]) {
    const raw = await handleRawCallTool({
      method: 'artifact.read',
      params: {
        artifactId: 'art_parity',
        offset,
        maxBytes: 8_000,
      },
    });
    const dedicated = await handleArtifactTool({
      action: 'read',
      artifactId: 'art_parity',
      offset,
      limit: 8_000,
    });
    assert.deepEqual(raw, dedicated);
    assert.equal(raw.structuredContent.data, data);
    assert.equal(raw.structuredContent.nextOffset, offset === 0 ? 8_000 : null);
    assert.equal(raw.structuredContent.sha256, 'ab'.repeat(32));
  }
});

test('cancelling a batch closes active clients without dequeuing more calls', async (t) => {
  const started = deferred<void>();
  const release = deferred<BridgeResponse>();
  let active = 0;
  const bridge = mockBridge(t, async () => {
    if (++active === MAX_BATCH_CONCURRENCY) started.resolve();
    return release.promise;
  });
  const controller = new AbortController();
  const pending = runWithMcpRequestEra(
    'modern',
    () =>
      handleBatchTool({
        calls: Array.from({ length: MAX_BATCH_CONCURRENCY + 2 }, () => ({
          method: 'page.get_state',
        })),
      }),
    controller.signal
  );
  const rejected = assert.rejects(pending, /cancel batch/);
  await started.promise;
  controller.abort(new Error('cancel batch'));
  await rejected;
  release.resolve(ok({}));
  await nextTurn();
  assert.equal(bridge.requests.length, MAX_BATCH_CONCURRENCY);
  assert.deepEqual(bridge.closed, bridge.clients);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('SDK cancellation during selector resolution prevents the patch followup', async (t) => {
  const started = deferred<void>();
  const release = deferred<BridgeResponse>();
  const bridge = mockBridge(t, async () => {
    started.resolve();
    return release.promise;
  });
  let patchHandler:
    | ((
        args: Record<string, unknown>,
        context: { mcpReq: { signal: AbortSignal } }
      ) => Promise<ToolResult>)
    | undefined;
  const register = McpServer.prototype.registerTool;
  t.mock.method(
    McpServer.prototype,
    'registerTool',
    function (this: McpServer, ...args: Parameters<typeof register>) {
      if (args[0] === 'browser_patch')
        patchHandler = args[2] as unknown as NonNullable<typeof patchHandler>;
      return register.apply(this, args);
    }
  );
  const server = createBridgeMcpServer({ era: 'modern' });
  assert.ok(patchHandler);
  const controller = new AbortController();
  const pending = patchHandler(
    { action: 'apply_styles', selector: '#target', declarations: { color: 'red' } },
    {
      mcpReq: { signal: controller.signal },
    }
  );
  await started.promise;
  controller.abort(new Error('cancel patch'));
  assert.equal((await pending).isError, true);
  release.resolve(ok({ nodes: [{ elementRef: 'el_target' }] }));
  await nextTurn();
  assert.deepEqual(
    bridge.requests.map((request) => request.method),
    ['dom.query']
  );
  assert.equal(bridge.requests[0].meta?.mcp_era, 'modern');
  assert.deepEqual(bridge.closed, bridge.clients);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await server.close();
});

test('pre-cancelled calls never connect and do not cancel independent requests', async (t) => {
  const bridge = mockBridge(t, async () => ok({}));
  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  const result = await runWithMcpRequestEra(
    'legacy',
    () =>
      handlePatchTool({
        action: 'apply_styles',
        elementRef: 'el_target',
        declarations: { color: 'red' },
      }),
    controller.signal
  );
  assert.equal(result.isError, true);
  assert.equal(bridge.clients.size, 0);
  assert.equal((await handleRawCallTool({ method: 'page.get_state' })).isError, undefined);
  assert.equal(bridge.requests.length, 1);
});

test('cancellation interrupts retry backoff without a second dispatch', async (t) => {
  const first = deferred<void>();
  const bridge = mockBridge(t, async () => {
    first.resolve();
    const response = fail('TIMEOUT', 'retryable');
    response.error.recovery = { retry: true, retryAfterMs: 60_000, hint: 'retry' };
    return response;
  });
  const controller = new AbortController();
  const pending = runWithMcpRequestEra(
    'legacy',
    () => handleRawCallTool({ method: 'page.get_state' }),
    controller.signal
  );
  await first.promise;
  await nextTurn();
  controller.abort(new Error('cancel retry'));
  assert.equal((await pending).isError, true);
  await nextTurn();
  assert.equal(bridge.requests.length, 1);
  assert.deepEqual(bridge.closed, bridge.clients);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('reconnect deadline closes stalled attempts and cleans up late success', async () => {
  const release = deferred<void>();
  let closes = 0;
  const client = {
    connected: false,
    autoReconnect: false,
    async connect() {
      await release.promise;
      client.connected = true;
    },
    async close() {
      closes++;
      client.connected = false;
    },
  } as unknown as BridgeClient;
  const started = Date.now();
  assert.equal(await waitForClientReconnect(client, 20), false);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(closes, 1);
  release.resolve();
  await nextTurn();
  assert.equal(client.connected, false);
  assert.equal(closes, 2);
});

test('cancellation interrupts stalled reconnect and closes late completion', async () => {
  const started = deferred<void>();
  const release = deferred<void>();
  let closes = 0;
  const client = {
    connected: false,
    autoReconnect: false,
    async connect() {
      started.resolve();
      await release.promise;
      client.connected = true;
    },
    async close() {
      closes++;
      client.connected = false;
    },
  } as unknown as BridgeClient;
  const controller = new AbortController();
  const pending = runWithMcpRequestEra(
    'modern',
    () => waitForClientReconnect(client, 60_000),
    controller.signal
  );
  const rejected = assert.rejects(pending, /cancel connect/);
  await started.promise;
  controller.abort(new Error('cancel connect'));
  await rejected;
  assert.equal(closes, 1);
  release.resolve();
  await nextTurn();
  assert.equal(closes, 2);
  assert.equal(client.connected, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('reconnect rejects completion past the deadline even before the timer fires', async (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  let closes = 0;
  const client = {
    connected: false,
    autoReconnect: false,
    async connect() {
      now += 100;
      client.connected = true;
    },
    async close() {
      closes++;
      client.connected = false;
    },
  } as unknown as BridgeClient;
  assert.equal(await waitForClientReconnect(client, 10), false);
  assert.equal(closes, 1);
  assert.equal(client.connected, false);
});

test('failed connection setup closes clients and preserves the primary error', async (t) => {
  let closes = 0;
  t.mock.method(BridgeClient.prototype, 'connect', async () => {
    throw new Error('registration failed');
  });
  t.mock.method(BridgeClient.prototype, 'close', async () => {
    closes++;
    throw new Error('cleanup failed');
  });
  for (const destinationId of [undefined, 'local']) {
    const result = await withToolClient(
      async () => {
        throw new Error('must not dispatch');
      },
      { destinationId }
    );
    assert.match(result.content[0].text, /registration failed/);
    assert.doesNotMatch(result.content[0].text, /cleanup failed/);
  }
  assert.equal(closes, 2);
});

test('cancelling initial connection setup closes the client and skips the callback', async (t) => {
  const started = deferred<void>();
  const release = deferred<void>();
  const clients = new Set<BridgeClient>();
  const closed = new Set<BridgeClient>();
  t.mock.method(BridgeClient.prototype, 'connect', async function (this: BridgeClient) {
    clients.add(this);
    started.resolve();
    await release.promise;
    this.connected = true;
  });
  t.mock.method(BridgeClient.prototype, 'close', async function (this: BridgeClient) {
    closed.add(this);
    this.connected = false;
  });
  let dispatched = false;
  const controller = new AbortController();
  const pending = runWithMcpRequestEra(
    'legacy',
    () =>
      withToolClient(async () => {
        dispatched = true;
        throw new Error('must not dispatch');
      }),
    controller.signal
  );
  await started.promise;
  controller.abort(new Error('cancel initial connect'));
  assert.equal((await pending).isError, true);
  assert.deepEqual(closed, clients);
  release.resolve();
  await nextTurn();
  assert.equal(dispatched, false);
  for (const client of clients) assert.equal(client.connected, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancellation interrupts automatic reconnect polling', async () => {
  const client = { connected: false, autoReconnect: true } as unknown as BridgeClient;
  const controller = new AbortController();
  const pending = runWithMcpRequestEra(
    'modern',
    () => waitForClientReconnect(client, 60_000),
    controller.signal
  );
  const rejected = assert.rejects(pending, /cancel polling/);
  await nextTurn();
  controller.abort(new Error('cancel polling'));
  await rejected;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('raw destructive flags are never retried after failures or connection loss', async () => {
  for (const method of ['page.get_console', 'page.get_network'] as const) {
    for (const clear of [true, 1, 'false']) {
      for (const lostConnection of [false, true]) {
        let calls = 0;
        const client = {
          connected: true,
          async request() {
            calls++;
            if (lostConnection) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
            const response = fail('TIMEOUT', 'retryable');
            response.error.recovery = { retry: true, retryAfterMs: 0, hint: 'retry' };
            return response;
          },
        } as unknown as BridgeClient;
        const pending = requestBridgeWithRetry(client, method, { clear }, { source: 'mcp' });
        if (lostConnection) await assert.rejects(pending, /reset/);
        else assert.equal((await pending).ok, false);
        assert.equal(calls, 1);
      }
    }
  }
});
