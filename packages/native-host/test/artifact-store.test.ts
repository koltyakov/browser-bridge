import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { ArtifactStore } from '../src/artifact-store.js';
import { ARTIFACT_CHUNK_BYTES, ERROR_CODES } from '../../protocol/src/index.js';

const artifactId = `art_${'a'.repeat(43)}`;

test('ArtifactStore commits, reads, authorizes, and deletes private artifacts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bbx-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storePath = path.join(root, 'store');
  const store = new ArtifactStore(storePath);
  store.reset();
  const bytes = Buffer.alloc(ARTIFACT_CHUNK_BYTES + 5, 0x61);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const now = Date.now();
  store.begin({
    artifactId,
    requestId: 'capture-1',
    ownerId: 'client-1',
    extensionId: 'extension-1',
    kind: 'screenshot',
    mimeType: 'image/png',
    totalBytes: bytes.length,
    sha256,
    chunkCount: 2,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  store.writeChunk(artifactId, 0, bytes.subarray(0, ARTIFACT_CHUNK_BYTES).toString('base64'));
  store.writeChunk(artifactId, 1, bytes.subarray(ARTIFACT_CHUNK_BYTES).toString('base64'));
  const record = store.commit(artifactId);

  assert.equal(record.byteLength, bytes.length);
  assert.equal(store.ownsCommitted(artifactId, 'client-1', 'capture-1'), true);
  assert.deepEqual(store.read(artifactId, 'client-1', 0, 10), {
    artifactId,
    data: bytes.subarray(0, 10).toString('base64'),
    offset: 0,
    byteLength: 10,
    chunkIndex: 0,
    chunkCount: 2,
    nextOffset: 10,
    totalBytes: bytes.length,
    sha256,
    expiresAt: record.expiresAt,
  });
  assert.throws(
    () => store.read(artifactId, 'client-2', 0, 10),
    (error: { code?: string }) => error.code === ERROR_CODES.ARTIFACT_NOT_FOUND
  );
  assert.deepEqual(store.delete(artifactId, 'client-1'), { artifactId, deleted: true });
  assert.throws(
    () => store.read(artifactId, 'client-1', 0, 10),
    (error: { code?: string }) => error.code === ERROR_CODES.ARTIFACT_NOT_FOUND
  );
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(storePath).mode & 0o777, 0o700);
  }
});

test('ArtifactStore rejects corrupt transfers', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bbx-artifacts-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ArtifactStore(path.join(root, 'store'));
  store.reset();
  const bytes = Buffer.from('expired');
  store.begin({
    artifactId,
    requestId: 'capture-2',
    ownerId: 'client-1',
    extensionId: 'extension-1',
    kind: 'screenshot',
    mimeType: 'image/png',
    totalBytes: bytes.length,
    sha256: '0'.repeat(64),
    chunkCount: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  store.writeChunk(artifactId, 0, bytes.toString('base64'));
  assert.throws(
    () => store.commit(artifactId),
    (error: { code?: string }) => error.code === ERROR_CODES.ARTIFACT_TRANSFER_INVALID
  );
});

test('ArtifactStore expires committed data and clears it on restart', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bbx-artifacts-expiry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = Date.now();
  const storePath = path.join(root, 'store');
  const store = new ArtifactStore(storePath, () => now);
  store.reset();
  const bytes = Buffer.from('expiring');
  const expiresAt = now + 60_000;
  store.begin({
    artifactId,
    requestId: 'capture-expiry',
    ownerId: 'client-1',
    extensionId: 'extension-1',
    kind: 'screenshot',
    mimeType: 'image/png',
    totalBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    chunkCount: 1,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  });
  store.writeChunk(artifactId, 0, bytes.toString('base64'));
  store.commit(artifactId);
  now = expiresAt;
  assert.throws(
    () => store.read(artifactId, 'client-1', 0, 10),
    (error: { code?: string }) => error.code === ERROR_CODES.ARTIFACT_NOT_FOUND
  );
  assert.equal(fs.existsSync(path.join(storePath, `${artifactId}.bin`)), false);

  store.reset();
  assert.deepEqual(fs.readdirSync(storePath), []);
});

test('ArtifactStore rejects duplicate IDs and removes interrupted extension transfers', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bbx-artifacts-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storePath = path.join(root, 'store');
  const store = new ArtifactStore(storePath);
  store.reset();
  const bytes = Buffer.from('pending');
  const input = {
    artifactId,
    requestId: 'capture-3',
    ownerId: 'client-1',
    extensionId: 'extension-1',
    kind: 'screenshot' as const,
    mimeType: 'image/png',
    totalBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    chunkCount: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  store.begin(input);
  assert.throws(
    () => store.begin(input),
    (error: { code?: string }) => error.code === ERROR_CODES.ARTIFACT_TRANSFER_INVALID
  );
  store.writeChunk(artifactId, 0, bytes.toString('base64'));
  store.deleteByExtension('extension-1');
  assert.equal(fs.existsSync(path.join(storePath, `${artifactId}.part`)), false);
  assert.throws(
    () => store.commit(artifactId),
    (error: { code?: string }) => error.code === ERROR_CODES.ARTIFACT_TRANSFER_INVALID
  );

  const committedId = `art_${'b'.repeat(43)}`;
  store.begin({ ...input, artifactId: committedId, requestId: 'capture-4' });
  store.writeChunk(committedId, 0, bytes.toString('base64'));
  store.commit(committedId);
  store.deleteRequest('capture-4');
  assert.throws(
    () => store.read(committedId, 'client-1', 0, 10),
    (error: { code?: string }) => error.code === ERROR_CODES.ARTIFACT_NOT_FOUND
  );
});

test('ArtifactStore enforces the per-client artifact count quota', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bbx-artifacts-quota-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ArtifactStore(path.join(root, 'store'));
  store.reset();
  const bytes = Buffer.from('q');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const now = Date.now();
  for (let index = 0; index < 16; index += 1) {
    const itemId = `art_${index.toString().padStart(43, '0')}`;
    store.begin({
      artifactId: itemId,
      requestId: `capture-quota-${index}`,
      ownerId: 'quota-client',
      extensionId: 'quota-extension',
      kind: 'screenshot',
      mimeType: 'image/png',
      totalBytes: bytes.length,
      sha256,
      chunkCount: 1,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    store.writeChunk(itemId, 0, bytes.toString('base64'));
    store.commit(itemId);
  }
  assert.throws(
    () =>
      store.begin({
        artifactId: `art_${'z'.repeat(43)}`,
        requestId: 'capture-quota-overflow',
        ownerId: 'quota-client',
        extensionId: 'quota-extension',
        kind: 'screenshot',
        mimeType: 'image/png',
        totalBytes: bytes.length,
        sha256,
        chunkCount: 1,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
      }),
    (error: { code?: string }) => error.code === ERROR_CODES.ARTIFACT_QUOTA_EXCEEDED
  );
});
