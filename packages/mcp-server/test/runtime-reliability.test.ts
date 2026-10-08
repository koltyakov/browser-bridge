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
  handleTabsTool,
} from '../src/handlers.js';
import {
  requestBridgeWithRetry,
  runWithMcpRequestEra,
  runWithMcpRequestTarget,
  waitForClientReconnect,
  withToolClient,
  type ToolResult,
} from '../src/handlers-utils.js';

type Request = Parameters<BridgeClient['request']>[0];

test('MCP routing stays isolated across concurrent tools and selector resolution', async (t) => {
  const bridge = mockBridge(t, async (request) => {
    await nextTurn();
    return ok(
      request.method === 'dom.query'
        ? { nodes: [{ elementRef: 'el_one' }] }
        : { patchId: 'patch_one' }
    );
  });
  await Promise.all(
    ['work', 'personal'].map((extensionId) =>
      runWithMcpRequestTarget(
        { extensionId, targetBrowser: 'Chrome', targetProfile: extensionId },
        () =>
          handlePatchTool({
            action: 'apply_styles',
            selector: 'main',
            declarations: { color: 'red' },
            tabId: 42,
          })
      )
    )
  );
  for (const extensionId of ['work', 'personal']) {
    const requests = bridge.requests.filter(
      (request) => request.meta?.target_extension === extensionId
    );
    assert.deepEqual(
      requests.map((request) => request.method),
      ['dom.query', 'patch.apply_styles']
    );
    assert.ok(
      requests.every(
        (request) =>
          request.tabId === 42 &&
          request.meta?.target_profile === extensionId &&
          request.meta?.target_browser === 'Chrome'
      )
    );
  }
});

test('unscoped raw tabs.list discovers enabled profiles without dropping colliding tab IDs', async (t) => {
  const bridge = mockBridge(t, async (request) => {
    if (request.method === 'health.ping')
      return ok({
        connectedExtensions: [
          { extensionId: 'work', browserName: 'Chrome', profileLabel: 'Work', accessEnabled: true },
          {
            extensionId: 'personal',
            browserName: 'Chrome',
            profileLabel: null,
            accessEnabled: true,
          },
          { extensionId: 'off', accessEnabled: false },
        ],
      });
    return ok({
      tabs: [
        {
          tabId: 42,
          windowId: 1,
          active: true,
          title: request.meta?.target_extension,
          url: `https://${request.meta?.target_extension}.example`,
        },
      ],
    });
  });
  const result = await handleRawCallTool({ method: 'tabs.list' });
  const evidence = result.structuredContent.evidence as { tabs: Array<Record<string, unknown>> };
  assert.deepEqual(
    evidence.tabs.map((tab) => [tab.extensionId, tab.tabId]),
    [
      ['work', 42],
      ['personal', 42],
    ]
  );
  assert.equal(evidence.tabs[0].url, 'https://work.example');
  assert.deepEqual(
    bridge.requests.map((request) => [request.method, request.meta?.target_extension]),
    [
      ['health.ping', undefined],
      ['tabs.list', 'work'],
      ['tabs.list', 'personal'],
    ]
  );
});

test('batch items can independently target profiles with the same tab ID', async (t) => {
  const bridge = mockBridge(t, async () => ok({}));
  await handleBatchTool({
    calls: ['work', 'personal'].map((extensionId) => ({
      method: 'page.get_state',
      extensionId,
      tabId: 42,
    })),
  });
  assert.deepEqual(
    bridge.requests.map((request) => request.meta?.target_extension),
    ['work', 'personal']
  );
});

test('profile-scoped tab listing skips discovery and retains the connection target', async (t) => {
  const bridge = mockBridge(t, async () => ok({ tabs: [] }));
  await runWithMcpRequestTarget({ extensionId: 'work' }, () => handleTabsTool({ action: 'list' }));
  assert.deepEqual(
    bridge.requests.map((request) => [request.method, request.meta?.target_extension]),
    [['tabs.list', 'work']]
  );
});

test('tab discovery reports disabled profiles without requesting access in an arbitrary window', async (t) => {
  const bridge = mockBridge(t, async () =>
    ok({
      connectedExtensions: [
        { extensionId: 'work', accessEnabled: false },
        { extensionId: 'personal', accessEnabled: false },
      ],
    })
  );
  const result = await handleRawCallTool({ method: 'tabs.list' });
  assert.equal(result.isError, true);
  assert.deepEqual(
    bridge.requests.map((request) => request.method),
    ['health.ping']
  );
  assert.match(result.content[0].text, /Select an extensionId/);
});

test('batch tab discovery keeps target IDs and puts working tabs ahead of truncated evidence', async (t) => {
  mockBridge(t, async (request) =>
    request.method === 'health.ping'
      ? ok({ connectedExtensions: [{ extensionId: 'work', accessEnabled: true }] })
      : ok({
          tabs: Array.from({ length: 150 }, (_, index) => ({
            tabId: index + 1,
            active: index === 149,
            working: index === 149,
            title: `Page ${index}`,
            url: `https://example.com/${index}?${'x'.repeat(700)}`,
          })),
        })
  );
  const result = await handleBatchTool({ calls: [{ method: 'tabs.list' }] });
  const results = result.structuredContent.results as Array<{
    evidence: { tabs: Array<Record<string, unknown>>; tabCount: number };
    outputTruncated: boolean;
  }>;
  assert.equal(results[0].evidence.tabCount, 150);
  assert.equal(results[0].evidence.tabs[0].tabId, 150);
  assert.equal(results[0].evidence.tabs[0].extensionId, 'work');
  assert.equal(results[0].evidence.tabs[0].urlTruncated, true);
  assert.equal(results[0].outputTruncated, true);
});

test('profile discovery preserves partial failures and leaves disabled profiles untouched', async (t) => {
  mockBridge(t, async (request) => {
    if (request.method === 'health.ping')
      return ok({
        connectedExtensions: [
          { extensionId: 'work', accessEnabled: true },
          { extensionId: 'gone', accessEnabled: true },
        ],
      });
    return request.meta?.target_extension === 'work'
      ? ok({ tabs: [{ tabId: 42 }] })
      : fail('TAB_MISMATCH', 'Window closed');
  });
  const result = await handleRawCallTool({ method: 'tabs.list' });
  const evidence = result.structuredContent.evidence as {
    partial: boolean;
    profiles: Array<{ ok: boolean }>;
  };
  assert.equal(evidence.partial, true);
  assert.deepEqual(
    evidence.profiles.map((profile) => profile.ok),
    [true, false]
  );
  assert.match(result.content[0].text, /Some browser profiles could not be listed/);
});

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
    {
      action: 'apply_styles',
      selector: '#target',
      declarations: { color: 'red' },
      extensionId: 'work',
      tabId: 42,
    },
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
  assert.equal(bridge.requests[0].meta?.target_extension, 'work');
  assert.equal(bridge.requests[0].tabId, 42);
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
