import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';

import {
  connectFakeExtension,
  connectTestClient,
  startTestDaemon,
} from '../../tests/_helpers/daemonHarness.ts';

test('daemon restart: pending request rejects and the client reconnects with backoff', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);
  const port = ctx.address.port;

  const client = await connectTestClient(ctx, {
    autoReconnect: true,
    defaultTimeoutMs: 10_000,
  });

  try {
    const responsePromise = client.request({
      method: 'page.get_state',
      params: {},
      meta: { source: 'cli' },
    });

    const forwarded = await extension.nextRequest();
    assert.equal(forwarded.method, 'page.get_state');

    const reconnected = once(client, 'reconnected');
    await ctx.daemon.stop();

    await assert.rejects(responsePromise, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Bridge socket closed/);
      return true;
    });

    const restarted = await startTestDaemon(port);
    try {
      await Promise.race([
        reconnected,
        new Promise((resolve, reject) =>
          setTimeout(() => reject(new Error('client did not reconnect within 20s')), 20_000)
        ),
      ]);
      assert.equal(client.connected, true);

      const health = await client.request({ method: 'health.ping' });
      assert.equal(health.ok, true);
      const result = health.result as Record<string, unknown>;
      assert.equal(result.daemon, 'ok');
      assert.equal(result.extensionConnected, false);
    } finally {
      await restarted.stop();
    }
  } finally {
    await client.close().catch(() => {});
    extension.destroy();
    fs.rmSync(ctx.tempRoot, { recursive: true, force: true });
  }
});

test('daemon clears stale pending requests when the extension socket drops mid-flight', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);

  try {
    const client = await connectTestClient(ctx);
    try {
      const responsePromise = client.request({
        method: 'page.get_text',
        params: {},
        meta: { source: 'cli' },
      });

      const forwarded = await extension.nextRequest();
      assert.equal(forwarded.method, 'page.get_text');
      assert.equal(ctx.daemon.pendingRequests.size, 1);

      extension.destroy();

      const response = await responsePromise;
      assert.equal(response.ok, false);
      assert.equal(response.error?.code, 'EXTENSION_DISCONNECTED');
      assert.equal(ctx.daemon.pendingRequests.size, 0);

      const metrics = await client.request({ method: 'daemon.metrics' });
      assert.equal(metrics.ok, true);
      const result = metrics.result as Record<string, unknown>;
      assert.equal(result.pendingRequests, 0);
      assert.equal(result.activeExtensions, 0);

      const afterDisconnect = await client.request({
        method: 'page.get_text',
        params: {},
        meta: { source: 'cli' },
      });
      assert.equal(afterDisconnect.ok, false);
      assert.equal(afterDisconnect.error?.code, 'EXTENSION_DISCONNECTED');
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    await ctx.stop();
  }
});
