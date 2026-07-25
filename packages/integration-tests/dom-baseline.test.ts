import test from 'node:test';
import assert from 'node:assert/strict';

import {
  connectFakeExtension,
  connectTestClient,
  startTestDaemon,
} from '../../tests/_helpers/daemonHarness.ts';
import type { BridgeClient } from '../agent-client/src/client.js';
import type { FakeExtension } from '../../tests/_helpers/daemonHarness.ts';

function baselineId(seed: string): string {
  return `baseline_${seed.repeat(43)}`;
}

async function createBaseline(
  client: BridgeClient,
  extension: FakeExtension,
  id: string
): Promise<void> {
  const responsePromise = client.request({
    method: 'dom.baseline.create',
    params: { selector: 'main' },
    meta: { source: 'cli' },
  });

  const forwarded = await extension.nextRequest();
  assert.equal(forwarded.method, 'dom.baseline.create');

  extension.respondOk(forwarded, {
    baselineId: id,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    snapshot: { nodeCount: 12, byteLength: 340 },
    evicted: [],
  });

  const response = await responsePromise;
  assert.equal(response.ok, true);
  const result = response.result as Record<string, unknown>;
  assert.equal(result.baselineId, id);
}

test('dom baseline: ownership routes compare/describe/release across client processes', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);
  extension.enableAccess();

  try {
    const id = baselineId('a');
    const creator = await connectTestClient(ctx);
    await createBaseline(creator, extension, id);
    assert.equal(ctx.daemon.domBaselines.size, 1);
    await creator.close();

    // A different agent client can still use the baseline: ownership is
    // tracked per extension socket, not per agent connection.
    const comparer = await connectTestClient(ctx);
    try {
      const comparePromise = comparer.request({
        method: 'dom.baseline.compare',
        params: { baselineId: id },
        meta: { source: 'cli' },
      });
      const compareForwarded = await extension.nextRequest();
      assert.equal(compareForwarded.method, 'dom.baseline.compare');
      assert.equal(compareForwarded.params.baselineId, id);
      extension.respondOk(compareForwarded, {
        baselineId: id,
        matches: false,
        added: 1,
        removed: 0,
        changed: 2,
        moved: 0,
        truncated: false,
      });
      const compareResponse = await comparePromise;
      assert.equal(compareResponse.ok, true);
      const compareResult = compareResponse.result as Record<string, unknown>;
      assert.equal(compareResult.baselineId, id);

      const describePromise = comparer.request({
        method: 'dom.baseline.describe',
        params: { baselineId: id },
        meta: { source: 'cli' },
      });
      const describeForwarded = await extension.nextRequest();
      assert.equal(describeForwarded.method, 'dom.baseline.describe');
      extension.respondOk(describeForwarded, {
        baselineId: id,
        snapshot: { nodeCount: 12, byteLength: 340 },
      });
      const describeResponse = await describePromise;
      assert.equal(describeResponse.ok, true);

      const releasePromise = comparer.request({
        method: 'dom.baseline.release',
        params: { baselineId: id },
        meta: { source: 'cli' },
      });
      const releaseForwarded = await extension.nextRequest();
      assert.equal(releaseForwarded.method, 'dom.baseline.release');
      extension.respondOk(releaseForwarded, { baselineId: id, released: true });
      const releaseResponse = await releasePromise;
      assert.equal(releaseResponse.ok, true);
      assert.equal(ctx.daemon.domBaselines.size, 0);

      const afterRelease = await comparer.request({
        method: 'dom.baseline.compare',
        params: { baselineId: id },
        meta: { source: 'cli' },
      });
      assert.equal(afterRelease.ok, false);
      assert.equal(afterRelease.error?.code, 'DOM_BASELINE_NOT_FOUND');
    } finally {
      await comparer.close().catch(() => {});
    }
  } finally {
    extension.destroy();
    await ctx.stop();
  }
});

test('dom baseline: releasing an unknown baseline succeeds with released=false', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);
  extension.enableAccess();

  try {
    const client = await connectTestClient(ctx);
    try {
      const response = await client.request({
        method: 'dom.baseline.release',
        params: { baselineId: baselineId('z') },
        meta: { source: 'cli' },
      });
      assert.equal(response.ok, true);
      assert.deepEqual(response.result, { baselineId: baselineId('z'), released: false });
      assert.equal(
        extension.requests.some((request) => request.method === 'dom.baseline.release'),
        false,
        'unknown baselines must be resolved locally without forwarding'
      );
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    extension.destroy();
    await ctx.stop();
  }
});

test('dom baseline: ownership is dropped when the extension socket disconnects', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);
  extension.enableAccess();

  try {
    const client = await connectTestClient(ctx);
    try {
      const id = baselineId('d');
      await createBaseline(client, extension, id);
      const trackedCount: number = ctx.daemon.domBaselines.size;
      assert.equal(trackedCount, 1);

      extension.destroy();
      const deadline = Date.now() + 3_000;
      while (ctx.daemon.domBaselines.size !== 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(ctx.daemon.domBaselines.size, 0);

      const response = await client.request({
        method: 'dom.baseline.compare',
        params: { baselineId: id },
        meta: { source: 'cli' },
      });
      assert.equal(response.ok, false);
      assert.equal(response.error?.code, 'DOM_BASELINE_NOT_FOUND');
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    await ctx.stop();
  }
});
