// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { BridgeDaemon } from '../native-host/src/daemon.js';
import { BridgeClient } from '../agent-client/src/client.js';
import { parseJsonLines } from '../protocol/src/index.js';

/** @typedef {import('../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../protocol/src/types.js').BridgeResponse} BridgeResponse */

/**
 * @typedef {{
 *   daemon: BridgeDaemon,
 *   address: import('node:net').AddressInfo,
 *   connect: () => Promise<net.Socket>,
 * }} TestDaemon
 */

/**
 * Start a daemon on a random TCP port.
 *
 * @returns {Promise<TestDaemon>}
 */
async function startTestDaemon() {
  const daemon = new BridgeDaemon({
    transport: /** @type {import('../native-host/src/config.js').BridgeTransport} */ ({
      type: 'tcp',
      host: '127.0.0.1',
      port: 0,
      label: '127.0.0.1:0',
    }),
    listenOptions: { host: '127.0.0.1', port: 0 },
    logger: { log() {}, error() {} },
  });
  await daemon.start();
  const address = /** @type {import('node:net').AddressInfo} */ (daemon.serverAddress);
  return {
    daemon,
    address,
    connect: () =>
      new Promise((resolve, reject) => {
        const socket = net.createConnection({
          host: '127.0.0.1',
          port: address.port,
        });
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
      }),
  };
}

/**
 * @param {TestDaemon} ctx
 * @param {{ autoPing?: boolean }} [options]
 * @returns {Promise<net.Socket>}
 */
async function connectFakeExtension(ctx, { autoPing = true } = {}) {
  const socket = await ctx.connect();
  /** @type {Promise<void>} */
  const registered = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('extension registration timeout')), 3_000);
    parseJsonLines(socket, (msg) => {
      const rec = /** @type {Record<string, unknown>} */ (msg ?? {});
      if (rec.type === 'registered' && rec.role === 'extension') {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  socket.write(`${JSON.stringify({ type: 'register', role: 'extension' })}\n`);
  await registered;

  if (autoPing) {
    parseJsonLines(socket, (raw) => {
      const rec = /** @type {Record<string, unknown>} */ (raw ?? {});
      if (rec.type === 'extension.request' && rec.request && typeof rec.request === 'object') {
        const req = /** @type {BridgeRequest} */ (rec.request);
        if (req.method === 'health.ping') {
          socket.write(
            `${JSON.stringify({
              type: 'extension.response',
              response: {
                id: req.id,
                ok: true,
                result: {
                  extension: 'ok',
                  access: { enabled: true, routeReady: true, routeTabId: 1, windowId: 1 },
                },
                error: null,
                meta: { protocol_version: '1.0', method: 'health.ping' },
              },
            })}\n`
          );
        }
      }
    });
  }

  return socket;
}

/**
 * @param {TestDaemon} ctx
 * @returns {Promise<BridgeClient>}
 */
async function connectTestClient(ctx) {
  const client = new BridgeClient({
    socketPath: undefined,
    defaultTimeoutMs: 2_000,
  });
  client.transport = /** @type {import('../native-host/src/config.js').BridgeTransport} */ ({
    type: 'tcp',
    host: ctx.address.address,
    port: ctx.address.port,
    label: `${ctx.address.address}:${ctx.address.port}`,
  });
  client.socketPath = '';
  await client.connect();
  return client;
}

/**
 * @param {net.Socket} socket
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<BridgeRequest>}
 */
function waitForExtensionRequest(socket, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('timed out waiting for extension.request')),
      timeoutMs
    );
    parseJsonLines(socket, (raw) => {
      const rec = /** @type {Record<string, unknown>} */ (raw ?? {});
      if (rec.type === 'extension.request' && rec.request && typeof rec.request === 'object') {
        clearTimeout(timeout);
        resolve(/** @type {BridgeRequest} */ (rec.request));
      }
    });
  });
}

/**
 * @param {net.Socket} socket
 * @param {BridgeResponse} response
 */
function sendExtensionResponse(socket, response) {
  socket.write(`${JSON.stringify({ type: 'extension.response', response })}\n`);
}

test('round-trip: client request reaches extension and response returns to client', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);

  try {
    const client = await connectTestClient(ctx);

    const responsePromise = client.request({
      method: 'tabs.list',
      params: {},
      meta: { source: 'cli' },
    });

    const forwarded = await waitForExtensionRequest(extension);
    assert.equal(forwarded.method, 'tabs.list');
    assert.equal(forwarded.meta?.source, 'cli');

    sendExtensionResponse(extension, {
      id: forwarded.id,
      ok: true,
      result: {
        tabs: [
          {
            tabId: 99,
            active: true,
            origin: 'https://round-trip.test',
            title: 'Round Trip Test',
          },
        ],
      },
      error: null,
      meta: { protocol_version: '1.0', method: 'tabs.list' },
    });

    const response = await responsePromise;
    assert.equal(response.ok, true);
    assert.deepEqual(response.result, {
      tabs: [
        {
          tabId: 99,
          active: true,
          origin: 'https://round-trip.test',
          title: 'Round Trip Test',
        },
      ],
    });

    await client.close();
  } finally {
    extension.destroy();
    await ctx.daemon.stop();
  }
});

test('round-trip: extension error response propagates to client', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);

  try {
    const client = await connectTestClient(ctx);

    const responsePromise = client.request({
      method: 'dom.query',
      params: { selector: '#missing' },
      meta: { source: 'cli' },
    });

    const forwarded = await waitForExtensionRequest(extension);
    assert.equal(forwarded.method, 'dom.query');

    sendExtensionResponse(extension, {
      id: forwarded.id,
      ok: false,
      result: null,
      error: {
        code: 'ELEMENT_STALE',
        message: 'No element found matching selector.',
        details: null,
      },
      meta: { protocol_version: '1.0', method: 'dom.query' },
    });

    const response = await responsePromise;
    assert.equal(response.ok, false);
    assert.equal(response.error?.code, 'ELEMENT_STALE');
    assert.match(String(response.error?.message ?? ''), /selector/i);

    await client.close();
  } finally {
    extension.destroy();
    await ctx.daemon.stop();
  }
});

test('round-trip: extension disconnect mid-flight returns EXTENSION_DISCONNECTED', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);

  try {
    const client = await connectTestClient(ctx);

    const responsePromise = client.request({
      method: 'page.get_text',
      params: {},
      meta: { source: 'cli' },
    });

    await waitForExtensionRequest(extension);
    extension.destroy();

    const response = await responsePromise;
    assert.equal(response.ok, false);
    assert.equal(response.error?.code, 'EXTENSION_DISCONNECTED');

    await client.close();
  } finally {
    await ctx.daemon.stop();
  }
});

test('round-trip: health.ping responds immediately when no extension connected', async () => {
  const ctx = await startTestDaemon();

  try {
    const client = await connectTestClient(ctx);

    const response = await client.request({ method: 'health.ping' });
    assert.equal(response.ok, true);
    const result = /** @type {Record<string, unknown>} */ (response.result);
    assert.equal(result.daemon, 'ok');
    assert.equal(result.extensionConnected, false);

    await client.close();
  } finally {
    await ctx.daemon.stop();
  }
});

test('round-trip: health.ping merges extension data when extension connected', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);

  try {
    const client = await connectTestClient(ctx);

    const responsePromise = client.request({ method: 'health.ping' });

    const forwarded = await waitForExtensionRequest(extension);
    assert.equal(forwarded.method, 'health.ping');

    sendExtensionResponse(extension, {
      id: forwarded.id,
      ok: true,
      result: {
        extension: 'ok',
        access: { enabled: true, routeReady: true, routeTabId: 1, windowId: 1 },
      },
      error: null,
      meta: { protocol_version: '1.0', method: 'health.ping' },
    });

    const response = await responsePromise;
    assert.equal(response.ok, true);
    const result = /** @type {Record<string, unknown>} */ (response.result);
    assert.equal(result.extensionConnected, true);
    assert.equal(result.extension, 'ok');

    await client.close();
  } finally {
    extension.destroy();
    await ctx.daemon.stop();
  }
});

test('round-trip: client throws BRIDGE_TIMEOUT when extension never responds', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);

  try {
    const client = await connectTestClient(ctx);

    await assert.rejects(
      () =>
        client.request({
          method: 'page.get_state',
          params: {},
          meta: { source: 'cli' },
          timeoutMs: 500,
        }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(/** @type {Error & { code?: string }} */ (err).code, 'BRIDGE_TIMEOUT');
        return true;
      }
    );

    await client.close();
  } finally {
    extension.destroy();
    await ctx.daemon.stop();
  }
});
