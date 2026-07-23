// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  ARTIFACT_CHUNK_BYTES,
  ARTIFACT_TTL_MS,
  BridgeError,
  ERROR_CODES,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_CLIENT_BYTES,
  MAX_ARTIFACT_TOTAL_BYTES,
  MAX_ARTIFACTS_PER_CLIENT,
} from '../../protocol/src/index.js';

/** @typedef {import('../../protocol/src/types.js').ArtifactKind} ArtifactKind */
/** @typedef {{ artifactId: string, requestId: string, ownerId: string, extensionId: string, kind: ArtifactKind, mimeType: string, totalBytes: number, sha256: string, chunkCount: number, createdAt: string, expiresAt: string, fd: number, temporaryPath: string, finalPath: string, written: number, nextChunk: number, hash: import('node:crypto').Hash }} ArtifactTransfer */
/** @typedef {{ artifactId: string, requestId: string, ownerId: string, extensionId: string, kind: ArtifactKind, mimeType: string, byteLength: number, sha256: string, chunkCount: number, createdAt: string, expiresAt: string, filePath: string }} ArtifactRecord */

export class ArtifactStore {
  /** @param {string} rootPath @param {() => number} [now] */
  constructor(rootPath, now = Date.now) {
    this.rootPath = rootPath;
    this.now = now;
    /** @type {Map<string, ArtifactTransfer>} */
    this.transfers = new Map();
    /** @type {Map<string, ArtifactRecord>} */
    this.artifacts = new Map();
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    this.expiryTimers = new Map();
  }

  reset() {
    for (const transfer of this.transfers.values()) {
      try {
        fs.closeSync(transfer.fd);
      } catch {}
    }
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    fs.rmSync(this.rootPath, { recursive: true, force: true });
    fs.mkdirSync(this.rootPath, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(this.rootPath, 0o700);
    this.transfers.clear();
    this.artifacts.clear();
    this.expiryTimers.clear();
  }

  /** @param {Omit<ArtifactTransfer, 'fd' | 'temporaryPath' | 'finalPath' | 'written' | 'nextChunk' | 'hash'>} input */
  begin(input) {
    this.pruneExpired();
    if (!/^art_[A-Za-z0-9_-]{32,64}$/u.test(input.artifactId)) {
      throw new BridgeError(
        ERROR_CODES.ARTIFACT_TRANSFER_INVALID,
        'Artifact identifier is invalid.'
      );
    }
    if (
      !Number.isInteger(input.totalBytes) ||
      input.totalBytes < 1 ||
      input.totalBytes > MAX_ARTIFACT_BYTES ||
      input.chunkCount !== Math.ceil(input.totalBytes / ARTIFACT_CHUNK_BYTES)
    ) {
      throw new BridgeError(ERROR_CODES.ARTIFACT_TRANSFER_INVALID, 'Artifact size is invalid.');
    }
    const now = this.now();
    const createdAt = Date.parse(input.createdAt);
    const expiresAt = Date.parse(input.expiresAt);
    if (
      !/^[a-f0-9]{64}$/u.test(input.sha256) ||
      !isValidKindAndMimeType(input.kind, input.mimeType) ||
      !Number.isFinite(createdAt) ||
      !Number.isFinite(expiresAt) ||
      createdAt > now + 10_000 ||
      createdAt < now - ARTIFACT_TTL_MS ||
      expiresAt <= now ||
      expiresAt <= createdAt ||
      expiresAt > now + ARTIFACT_TTL_MS
    ) {
      throw new BridgeError(ERROR_CODES.ARTIFACT_TRANSFER_INVALID, 'Artifact metadata is invalid.');
    }
    if (this.transfers.has(input.artifactId) || this.artifacts.has(input.artifactId)) {
      throw new BridgeError(
        ERROR_CODES.ARTIFACT_TRANSFER_INVALID,
        'Artifact identifier is already in use.'
      );
    }
    const ownedArtifacts = [...this.artifacts.values()].filter(
      (item) => item.ownerId === input.ownerId
    );
    const ownedTransfers = [...this.transfers.values()].filter(
      (item) => item.ownerId === input.ownerId
    );
    const clientBytes =
      ownedArtifacts.reduce((total, item) => total + item.byteLength, 0) +
      ownedTransfers.reduce((total, item) => total + item.totalBytes, 0);
    const totalBytes =
      [...this.artifacts.values()].reduce((total, item) => total + item.byteLength, 0) +
      [...this.transfers.values()].reduce((total, item) => total + item.totalBytes, 0);
    if (
      ownedArtifacts.length + ownedTransfers.length >= MAX_ARTIFACTS_PER_CLIENT ||
      clientBytes + input.totalBytes > MAX_ARTIFACT_CLIENT_BYTES ||
      totalBytes + input.totalBytes > MAX_ARTIFACT_TOTAL_BYTES
    ) {
      throw new BridgeError(ERROR_CODES.ARTIFACT_QUOTA_EXCEEDED, 'Artifact quota exceeded.');
    }
    const temporaryPath = path.join(this.rootPath, `${input.artifactId}.part`);
    const finalPath = path.join(this.rootPath, `${input.artifactId}.bin`);
    const fd = fs.openSync(temporaryPath, 'wx', 0o600);
    this.transfers.set(input.artifactId, {
      ...input,
      fd,
      temporaryPath,
      finalPath,
      written: 0,
      nextChunk: 0,
      hash: createHash('sha256'),
    });
  }

  /** @param {string} artifactId @param {number} chunkIndex @param {string} data */
  writeChunk(artifactId, chunkIndex, data) {
    const transfer = this.transfers.get(artifactId);
    if (!transfer || chunkIndex !== transfer.nextChunk) {
      throw new BridgeError(
        ERROR_CODES.ARTIFACT_TRANSFER_INVALID,
        'Artifact chunk order is invalid.'
      );
    }
    const bytes = decodeBase64(data);
    if (bytes.length < 1 || bytes.length > ARTIFACT_CHUNK_BYTES) {
      throw new BridgeError(
        ERROR_CODES.ARTIFACT_TRANSFER_INVALID,
        'Artifact chunk size is invalid.'
      );
    }
    if (transfer.written + bytes.length > transfer.totalBytes) {
      throw new BridgeError(
        ERROR_CODES.ARTIFACT_TRANSFER_INVALID,
        'Artifact exceeds declared size.'
      );
    }
    fs.writeSync(transfer.fd, bytes);
    transfer.hash.update(bytes);
    transfer.written += bytes.length;
    transfer.nextChunk += 1;
  }

  /** @param {string} artifactId @returns {ArtifactRecord} */
  commit(artifactId) {
    const transfer = this.transfers.get(artifactId);
    if (!transfer) {
      throw new BridgeError(ERROR_CODES.ARTIFACT_TRANSFER_INVALID, 'Artifact transfer is missing.');
    }
    const digest = transfer.hash.digest('hex');
    if (
      transfer.written !== transfer.totalBytes ||
      transfer.nextChunk !== transfer.chunkCount ||
      digest !== transfer.sha256
    ) {
      this.abort(artifactId);
      throw new BridgeError(ERROR_CODES.ARTIFACT_TRANSFER_INVALID, 'Artifact checksum is invalid.');
    }
    fs.closeSync(transfer.fd);
    fs.renameSync(transfer.temporaryPath, transfer.finalPath);
    if (process.platform !== 'win32') fs.chmodSync(transfer.finalPath, 0o600);
    const record = {
      artifactId: transfer.artifactId,
      requestId: transfer.requestId,
      ownerId: transfer.ownerId,
      extensionId: transfer.extensionId,
      kind: transfer.kind,
      mimeType: transfer.mimeType,
      byteLength: transfer.totalBytes,
      sha256: digest,
      chunkCount: transfer.chunkCount,
      createdAt: transfer.createdAt,
      expiresAt: transfer.expiresAt,
      filePath: transfer.finalPath,
    };
    this.transfers.delete(artifactId);
    this.artifacts.set(artifactId, record);
    const timer = setTimeout(
      () => this.removeCommitted(artifactId),
      Math.max(0, Date.parse(record.expiresAt) - this.now())
    );
    timer.unref?.();
    this.expiryTimers.set(artifactId, timer);
    return record;
  }

  /** @param {string} artifactId @param {string} ownerId @param {number} offset @param {number} maxBytes */
  read(artifactId, ownerId, offset, maxBytes) {
    const record = this.getOwned(artifactId, ownerId);
    const start = Math.min(offset, record.byteLength);
    const byteLength = Math.min(maxBytes, record.byteLength - start);
    const bytes = Buffer.alloc(byteLength);
    const fd = fs.openSync(record.filePath, 'r');
    try {
      fs.readSync(fd, bytes, 0, byteLength, start);
    } finally {
      fs.closeSync(fd);
    }
    const nextOffset = start + byteLength < record.byteLength ? start + byteLength : null;
    return {
      artifactId,
      data: bytes.toString('base64'),
      offset: start,
      byteLength,
      chunkIndex: Math.floor(start / ARTIFACT_CHUNK_BYTES),
      chunkCount: record.chunkCount,
      nextOffset,
      totalBytes: record.byteLength,
      sha256: record.sha256,
      expiresAt: record.expiresAt,
    };
  }

  /** @param {string} artifactId @param {string} ownerId */
  delete(artifactId, ownerId) {
    this.getOwned(artifactId, ownerId);
    this.removeCommitted(artifactId);
    return { artifactId, deleted: true };
  }

  /** @param {string} artifactId @param {string} ownerId @param {string} requestId @param {ArtifactKind} [kind] */
  ownsCommitted(artifactId, ownerId, requestId, kind) {
    const record = this.artifacts.get(artifactId);
    return (
      record?.ownerId === ownerId &&
      record.requestId === requestId &&
      (kind === undefined || record.kind === kind)
    );
  }

  /**
   * @param {string} artifactId
   * @param {string} ownerId
   * @param {string} requestId
   * @param {Record<string, unknown>} descriptor
   * @param {ArtifactKind | undefined} expectedKind
   */
  matchesCommitted(artifactId, ownerId, requestId, descriptor, expectedKind) {
    const record = this.artifacts.get(artifactId);
    return Boolean(
      record &&
      record.ownerId === ownerId &&
      record.requestId === requestId &&
      (expectedKind === undefined || record.kind === expectedKind) &&
      descriptor.kind === record.kind &&
      descriptor.mimeType === record.mimeType &&
      descriptor.byteLength === record.byteLength &&
      descriptor.sha256 === record.sha256 &&
      descriptor.chunkSize === ARTIFACT_CHUNK_BYTES &&
      descriptor.chunkCount === record.chunkCount &&
      descriptor.createdAt === record.createdAt &&
      descriptor.expiresAt === record.expiresAt
    );
  }

  /** @param {string} requestId */
  abortRequest(requestId) {
    for (const transfer of this.transfers.values()) {
      if (transfer.requestId === requestId) this.abort(transfer.artifactId);
    }
  }

  /** @param {string} requestId */
  deleteRequest(requestId) {
    this.abortRequest(requestId);
    for (const record of [...this.artifacts.values()]) {
      if (record.requestId === requestId) this.removeCommitted(record.artifactId);
    }
  }

  /** @param {string} extensionId */
  deleteByExtension(extensionId) {
    for (const transfer of [...this.transfers.values()]) {
      if (transfer.extensionId === extensionId) this.abort(transfer.artifactId);
    }
    for (const record of this.artifacts.values()) {
      if (record.extensionId === extensionId) {
        this.removeCommitted(record.artifactId);
      }
    }
  }

  pruneExpired() {
    const now = this.now();
    for (const transfer of [...this.transfers.values()]) {
      if (Date.parse(transfer.expiresAt) <= now) this.abort(transfer.artifactId);
    }
    for (const record of this.artifacts.values()) {
      if (Date.parse(record.expiresAt) <= now) this.removeCommitted(record.artifactId);
    }
  }

  /** @param {string} artifactId */
  abort(artifactId) {
    const transfer = this.transfers.get(artifactId);
    if (!transfer) return;
    this.transfers.delete(artifactId);
    try {
      fs.closeSync(transfer.fd);
    } catch {}
    fs.rmSync(transfer.temporaryPath, { force: true });
  }

  /** @param {string} artifactId */
  removeCommitted(artifactId) {
    const record = this.artifacts.get(artifactId);
    if (!record) return;
    this.artifacts.delete(artifactId);
    const timer = this.expiryTimers.get(artifactId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(artifactId);
    fs.rmSync(record.filePath, { force: true });
  }

  /** @param {string} artifactId @param {string} ownerId */
  getOwned(artifactId, ownerId) {
    this.pruneExpired();
    const record = this.artifacts.get(artifactId);
    if (!record || record.ownerId !== ownerId) {
      throw new BridgeError(ERROR_CODES.ARTIFACT_NOT_FOUND, 'Artifact was not found.');
    }
    return record;
  }
}

/** @param {ArtifactKind} kind @param {string} mimeType */
function isValidKindAndMimeType(kind, mimeType) {
  return (
    (kind === 'screenshot' && mimeType.startsWith('image/')) ||
    (kind === 'har' && mimeType === 'application/json')
  );
}

/** @param {string} value */
function decodeBase64(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new BridgeError(ERROR_CODES.ARTIFACT_TRANSFER_INVALID, 'Artifact chunk is not base64.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw new BridgeError(
      ERROR_CODES.ARTIFACT_TRANSFER_INVALID,
      'Artifact chunk is not canonical base64.'
    );
  }
  return bytes;
}
