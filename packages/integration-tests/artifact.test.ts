import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import { ARTIFACT_CHUNK_BYTES } from '../protocol/src/index.js';
import {
  connectFakeExtension,
  connectTestClient,
  startTestDaemon,
} from '../../tests/_helpers/daemonHarness.ts';
import type { BridgeRequest } from '../protocol/src/types.js';
import type { FakeExtension } from '../../tests/_helpers/daemonHarness.ts';

type ArtifactDescriptor = {
  artifactId: string;
  kind: 'screenshot' | 'har';
  mimeType: string;
  byteLength: number;
  sha256: string;
  chunkSize: number;
  chunkCount: number;
  createdAt: string;
  expiresAt: string;
};

function buildPayload(byteLength: number): Buffer {
  const payload = randomBytes(byteLength);
  return payload;
}

function artifactId(seed: string): string {
  return `art_${seed.repeat(43)}`;
}

function sendArtifactTransfer(
  extension: FakeExtension,
  request: BridgeRequest,
  descriptor: ArtifactDescriptor,
  payload: Buffer
): void {
  extension.sendMessage({
    type: 'extension.artifact.begin',
    artifact: {
      requestId: request.id,
      artifactId: descriptor.artifactId,
      kind: descriptor.kind,
      mimeType: descriptor.mimeType,
      byteLength: descriptor.byteLength,
      sha256: descriptor.sha256,
      chunkCount: descriptor.chunkCount,
      createdAt: descriptor.createdAt,
      expiresAt: descriptor.expiresAt,
    },
  });
  for (let chunkIndex = 0; chunkIndex < descriptor.chunkCount; chunkIndex += 1) {
    const start = chunkIndex * ARTIFACT_CHUNK_BYTES;
    extension.sendMessage({
      type: 'extension.artifact.chunk',
      artifact: { requestId: request.id },
      artifactId: descriptor.artifactId,
      chunkIndex,
      data: payload.subarray(start, start + ARTIFACT_CHUNK_BYTES).toString('base64'),
    });
  }
  extension.sendMessage({
    type: 'extension.artifact.commit',
    artifact: { requestId: request.id },
    artifactId: descriptor.artifactId,
  });
}

async function requestScreenshotArtifact(
  client: Awaited<ReturnType<typeof connectTestClient>>,
  extension: FakeExtension,
  payload: Buffer,
  expiresAt: string,
  seed: string
): Promise<{ descriptor: ArtifactDescriptor }> {
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const descriptor: ArtifactDescriptor = {
    artifactId: artifactId(seed),
    kind: 'screenshot',
    mimeType: 'image/png',
    byteLength: payload.length,
    sha256,
    chunkSize: ARTIFACT_CHUNK_BYTES,
    chunkCount: Math.ceil(payload.length / ARTIFACT_CHUNK_BYTES),
    createdAt: new Date().toISOString(),
    expiresAt,
  };

  const responsePromise = client.request({
    method: 'screenshot.capture_region',
    params: { x: 0, y: 0, width: 100, height: 100, format: 'png', delivery: 'artifact' },
    meta: { source: 'cli' },
  });

  const forwarded = await extension.nextRequest();
  assert.equal(forwarded.method, 'screenshot.capture_region');
  assert.equal(forwarded.params.delivery, 'artifact');

  sendArtifactTransfer(extension, forwarded, descriptor, payload);
  extension.respondOk(forwarded, {
    delivery: 'artifact',
    artifact: descriptor,
    format: 'png',
    mimeType: 'image/png',
    byteLength: payload.length,
  });

  const response = await responsePromise;
  assert.equal(response.ok, true);
  const result = response.result as Record<string, unknown>;
  assert.equal(result.delivery, 'artifact');
  assert.deepEqual(result.artifact, descriptor);
  return { descriptor };
}

test('artifact flow: multi-chunk artifact reads back in bounded chunks and deletes', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);

  try {
    const client = await connectTestClient(ctx);
    try {
      const payload = buildPayload(ARTIFACT_CHUNK_BYTES + 3_392);
      const { descriptor } = await requestScreenshotArtifact(
        client,
        extension,
        payload,
        new Date(Date.now() + 60_000).toISOString(),
        'a'
      );
      assert.equal(descriptor.chunkCount, 2);

      const chunks: Buffer[] = [];
      let offset = 0;
      let reads = 0;
      for (;;) {
        const read = await client.request({
          method: 'artifact.read',
          params: { artifactId: descriptor.artifactId, offset, maxBytes: 50_000 },
          meta: { source: 'cli' },
        });
        assert.equal(read.ok, true);
        const result = read.result as Record<string, unknown>;
        assert.equal(result.artifactId, descriptor.artifactId);
        assert.equal(result.offset, offset);
        assert.equal(result.sha256, descriptor.sha256);
        assert.equal(result.totalBytes, payload.length);
        assert.equal(result.chunkCount, descriptor.chunkCount);
        assert.equal(typeof result.expiresAt, 'string');
        const bytes = Buffer.from(String(result.data), 'base64');
        assert.equal(bytes.length, result.byteLength);
        assert.ok(bytes.length <= 50_000);
        chunks.push(bytes);
        reads += 1;
        if (result.nextOffset === null) {
          break;
        }
        assert.equal(typeof result.nextOffset, 'number');
        offset = result.nextOffset as number;
      }
      assert.ok(reads > 1, 'expected the artifact to require multiple bounded reads');
      assert.deepEqual(Buffer.concat(chunks), payload);

      const deleted = await client.request({
        method: 'artifact.delete',
        params: { artifactId: descriptor.artifactId },
        meta: { source: 'cli' },
      });
      assert.equal(deleted.ok, true);
      assert.deepEqual(deleted.result, { artifactId: descriptor.artifactId, deleted: true });

      const readAfterDelete = await client.request({
        method: 'artifact.read',
        params: { artifactId: descriptor.artifactId, offset: 0 },
        meta: { source: 'cli' },
      });
      assert.equal(readAfterDelete.ok, false);
      assert.equal(readAfterDelete.error?.code, 'ARTIFACT_NOT_FOUND');
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    extension.destroy();
    await ctx.stop();
  }
});

test('artifact flow: unknown, foreign, and expired artifact ids are rejected', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);

  try {
    const owner = await connectTestClient(ctx);
    const stranger = await connectTestClient(ctx);
    try {
      const unknownRead = await owner.request({
        method: 'artifact.read',
        params: { artifactId: artifactId('u'), offset: 0 },
        meta: { source: 'cli' },
      });
      assert.equal(unknownRead.ok, false);
      assert.equal(unknownRead.error?.code, 'ARTIFACT_NOT_FOUND');

      const unknownDelete = await owner.request({
        method: 'artifact.delete',
        params: { artifactId: artifactId('u') },
        meta: { source: 'cli' },
      });
      assert.equal(unknownDelete.ok, false);
      assert.equal(unknownDelete.error?.code, 'ARTIFACT_NOT_FOUND');

      const payload = buildPayload(1_024);
      const { descriptor } = await requestScreenshotArtifact(
        owner,
        extension,
        payload,
        new Date(Date.now() + 60_000).toISOString(),
        'b'
      );

      const foreignRead = await stranger.request({
        method: 'artifact.read',
        params: { artifactId: descriptor.artifactId, offset: 0 },
        meta: { source: 'cli' },
      });
      assert.equal(foreignRead.ok, false);
      assert.equal(foreignRead.error?.code, 'ARTIFACT_NOT_FOUND');

      const foreignDelete = await stranger.request({
        method: 'artifact.delete',
        params: { artifactId: descriptor.artifactId },
        meta: { source: 'cli' },
      });
      assert.equal(foreignDelete.ok, false);
      assert.equal(foreignDelete.error?.code, 'ARTIFACT_NOT_FOUND');

      const ownerRead = await owner.request({
        method: 'artifact.read',
        params: { artifactId: descriptor.artifactId, offset: 0 },
        meta: { source: 'cli' },
      });
      assert.equal(ownerRead.ok, true);

      const expiringPayload = buildPayload(512);
      const expiring = await requestScreenshotArtifact(
        owner,
        extension,
        expiringPayload,
        new Date(Date.now() + 1_200).toISOString(),
        'c'
      );

      await new Promise((resolve) => setTimeout(resolve, 2_000));

      const expiredRead = await owner.request({
        method: 'artifact.read',
        params: { artifactId: expiring.descriptor.artifactId, offset: 0 },
        meta: { source: 'cli' },
      });
      assert.equal(expiredRead.ok, false);
      assert.equal(expiredRead.error?.code, 'ARTIFACT_NOT_FOUND');
    } finally {
      await owner.close().catch(() => {});
      await stranger.close().catch(() => {});
    }
  } finally {
    extension.destroy();
    await ctx.stop();
  }
});

test('artifact flow: response referencing an uncommitted artifact is rejected', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);

  try {
    const client = await connectTestClient(ctx);
    try {
      const responsePromise = client.request({
        method: 'screenshot.capture_region',
        params: { x: 0, y: 0, width: 10, height: 10, format: 'png', delivery: 'artifact' },
        meta: { source: 'cli' },
      });

      const forwarded = await extension.nextRequest();
      const payload = buildPayload(256);
      const descriptor: ArtifactDescriptor = {
        artifactId: artifactId('x'),
        kind: 'screenshot',
        mimeType: 'image/png',
        byteLength: payload.length,
        sha256: createHash('sha256').update(payload).digest('hex'),
        chunkSize: ARTIFACT_CHUNK_BYTES,
        chunkCount: 1,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      extension.respondOk(forwarded, { delivery: 'artifact', artifact: descriptor });

      const response = await responsePromise;
      assert.equal(response.ok, false);
      assert.equal(response.error?.code, 'ARTIFACT_TRANSFER_INVALID');
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    extension.destroy();
    await ctx.stop();
  }
});
