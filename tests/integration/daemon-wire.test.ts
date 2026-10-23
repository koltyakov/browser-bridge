import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { getProtocolVersion, normalizeDomQuery, parseJsonLines } from '../../protocol/src/index.js';
import {
  connectFakeExtension,
  connectTestClient,
  startTestDaemon,
} from '../_helpers/daemonHarness.ts';
import { runCli } from '../_helpers/runCli.ts';

test('Go daemon accepts same-major protocol versions and rejects incompatible majors', async () => {
  const ctx = await startTestDaemon();
  const client = await connectTestClient(ctx);
  try {
    const current = getProtocolVersion();
    for (const version of [current, `${current.split('.')[0]}.99`, '99.0', '0.5']) {
      const response = await client.request({
        method: 'health.ping',
        meta: { protocol_version: version },
      });
      if (version === '99.0' || version === '0.5') {
        assert.equal(response.ok, false);
        assert.equal(response.error?.code, 'INVALID_REQUEST');
        assert.match(response.error?.message ?? '', /protocol majors differ/);
        continue;
      }
      assert.equal(response.ok, true);
      const result = response.result as Record<string, unknown>;
      assert.equal(result.daemon, 'ok');
      assert.equal(result.extensionConnected, false);
      assert.ok(Array.isArray(result.supported_versions));
    }
  } finally {
    await client.close();
    await ctx.stop();
  }
});

test('Go CLI preserves custom DOM budgets through the daemon for extension normalization', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);
  const params = {
    selector: 'main',
    maxNodes: 5,
    maxDepth: 2,
    textBudget: 300,
    includeBbox: false,
    attributeAllowlist: ['id', 'data-testid'],
  };
  try {
    const pending = runCli({ args: ['call', 'dom.query', JSON.stringify(params)], env: ctx.env });
    const forwarded = await extension.nextRequest();
    assert.equal(forwarded.method, 'dom.query');
    assert.equal(forwarded.meta.source, 'cli');
    assert.equal(forwarded.meta.artifact_ack, true);
    assert(Number(forwarded.meta.deadline_ms) > Date.now());
    assert.deepEqual(normalizeDomQuery(forwarded.params), {
      selector: 'main',
      withinRef: null,
      budget: {
        maxNodes: 5,
        maxDepth: 2,
        textBudget: 300,
        includeBbox: false,
        attributeAllowlist: ['id', 'data-testid'],
      },
    });
    extension.respondOk(forwarded, { nodes: [{ elementRef: 'el_main', text: 'Budget kept' }] });
    const result = await pending;
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.json, { nodes: [{ elementRef: 'el_main', text: 'Budget kept' }] });
  } finally {
    extension.destroy();
    await ctx.stop();
  }
});

test('Go CLI timeout propagates a remapped cancellation without restarting the daemon', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);
  const client = await connectTestClient(ctx);
  try {
    const canceled = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Cancellation was not forwarded')), 5000);
      parseJsonLines(extension.socket, (message) => {
        if (
          message &&
          typeof message === 'object' &&
          'type' in message &&
          message.type === 'extension.request_cancelled'
        ) {
          clearTimeout(timer);
          resolve(message as Record<string, unknown>);
        }
      });
    });
    const result = runCli({
      args: ['call', 'input.click', '{}'],
      env: { ...ctx.env, BBX_CLIENT_REQUEST_TIMEOUT_MS: '1000' },
    });
    const forwarded = await extension.nextRequest();
    assert.equal((await canceled).requestId, forwarded.id);
    assert.notEqual((await result).status, 0);
    const metrics = await client.request({ method: 'daemon.metrics' });
    assert.equal((metrics.result as Record<string, unknown>).pendingRequests, 0);
    assert.equal((metrics.result as Record<string, unknown>).activeExtensions, 1);
  } finally {
    await client.close();
    extension.destroy();
    await ctx.stop();
  }
});

test('Go daemon merges extension health and clears pending requests on disconnect', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);
  const client = await connectTestClient(ctx);
  try {
    const health = await client.request({ method: 'health.ping' });
    assert.equal(health.ok, true);
    const result = health.result as Record<string, unknown>;
    assert.equal(result.extensionConnected, true);
    assert.equal(result.extension, 'ok');

    const pending = client.request({ method: 'page.get_text' });
    await extension.nextRequest();
    extension.destroy();
    const response = await pending;
    assert.equal(response.ok, false);
    assert.equal(response.error?.code, 'EXTENSION_DISCONNECTED');
    const metrics = await client.request({ method: 'daemon.metrics' });
    assert.equal(metrics.ok, true);
    assert.equal((metrics.result as Record<string, unknown>).pendingRequests, 0);
    assert.equal((metrics.result as Record<string, unknown>).activeExtensions, 0);
    const after = await client.request({ method: 'page.get_text' });
    assert.equal(after.error?.code, 'EXTENSION_DISCONNECTED');
  } finally {
    await client.close();
    extension.destroy();
    await ctx.stop();
  }
});

test('Go daemon restart rejects in-flight work and accepts a fresh connection on the same port', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);
  const client = await connectTestClient(ctx);
  try {
    const pending = client.request({ method: 'page.get_state' });
    const rejected = assert.rejects(pending, /socket closed/i);
    await extension.nextRequest();
    const exited = once(ctx.child, 'exit');
    ctx.child.kill('SIGKILL');
    await exited;
    await rejected;
    const restarted = await startTestDaemon(ctx.address.port);
    try {
      const result = await runCli({ args: ['call', 'health.ping'], env: restarted.env });
      assert.equal(result.status, 0, result.stderr);
      assert.equal((result.json as { daemon: string }).daemon, 'ok');
    } finally {
      await restarted.stop();
    }
  } finally {
    await client.close();
    extension.destroy();
    await ctx.stop();
  }
});
