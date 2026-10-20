// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { BridgeError, ERROR_CODES } from '../../protocol/src/index.js';

const MAX_BYTES = 128 * 1024 * 1024;
const TOTAL_BYTES = 256 * 1024 * 1024;
const TTL = 24 * 60 * 60 * 1000;
const validId = /^journal_[a-f0-9]{64}$/u;

/** Durable append-only journals. The random ID is a read/delete capability, never a path.
 * Writes require the original extension connection as well as the capability.
 * Existing files survive process restarts; the last partial line is reported by replay readers. */
export class RecordingStore {
  /** @param {string} directory */
  constructor(directory) {
    this.directory = directory;
    /** @type {Map<string, string>} */
    this.writers = new Map();
  }
  /** @param {string} id */
  filename(id) {
    if (!validId.test(id))
      throw new BridgeError(ERROR_CODES.ARTIFACT_NOT_FOUND, 'Unknown recording journal.');
    return path.join(this.directory, `${id}.jsonl`);
  }
  /** @returns {number} */
  prune() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    let bytes = 0;
    for (const name of fs.readdirSync(this.directory)) {
      const id = name.replace(/\.jsonl$/u, '');
      if (!validId.test(id)) continue;
      const filename = this.filename(id);
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (Date.now() - stat.mtimeMs > TTL) {
        fs.unlinkSync(filename);
        this.writers.delete(id);
      } else bytes += stat.size;
    }
    return bytes;
  }
  /** @param {string} extensionId */
  begin(extensionId) {
    const used = this.prune();
    if (used >= TOTAL_BYTES || fs.readdirSync(this.directory).length >= 32)
      throw new BridgeError(
        ERROR_CODES.ARTIFACT_QUOTA_EXCEEDED,
        'Recording journal quota exceeded. Delete old journals.'
      );
    const journalId = `journal_${randomBytes(32).toString('hex')}`;
    const fd = fs.openSync(this.filename(journalId), 'wx', 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    this.writers.set(journalId, extensionId);
    return { journalId, nextOffset: 0, expiresAt: new Date(Date.now() + TTL).toISOString() };
  }
  /** @param {string} id @param {string} extensionId @param {number} offset @param {string} data */
  append(id, extensionId, offset, data) {
    if (this.writers.get(id) !== extensionId)
      throw new BridgeError(ERROR_CODES.ACCESS_DENIED, 'Journal writer connection does not match.');
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      data.length > 262144 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)
    )
      throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'Invalid journal chunk.');
    const bytes = Buffer.from(data, 'base64');
    if (this.prune() + bytes.length > TOTAL_BYTES || offset + bytes.length > MAX_BYTES)
      throw new BridgeError(
        ERROR_CODES.ARTIFACT_QUOTA_EXCEEDED,
        'Recording journal byte quota exceeded.'
      );
    const fd = fs.openSync(
      this.filename(id),
      fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0)
    );
    try {
      if (fs.fstatSync(fd).size !== offset)
        throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'Journal offset mismatch.');
      let written = 0;
      while (written < bytes.length) {
        const count = fs.writeSync(fd, bytes, written, bytes.length - written, offset + written);
        if (!count) throw new Error('Journal write made no progress.');
        written += count;
      }
      fs.fsyncSync(fd);
      return { journalId: id, nextOffset: offset + written };
    } finally {
      fs.closeSync(fd);
    }
  }
  /** @param {string} id @param {number} offset @param {number} limit */
  read(id, offset, limit) {
    this.prune();
    const filename = this.filename(id);
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const size = fs.fstatSync(fd).size;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > size ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 196608
      )
        throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'Invalid journal read range.');
      const data = Buffer.alloc(Math.min(limit, size - offset));
      const count = fs.readSync(fd, data, 0, data.length, offset);
      return {
        journalId: id,
        offset,
        byteLength: count,
        totalBytes: size,
        nextOffset: offset + count < size ? offset + count : null,
        data: data.subarray(0, count).toString('base64'),
      };
    } finally {
      fs.closeSync(fd);
    }
  }
  /** @param {string} id */
  delete(id) {
    fs.unlinkSync(this.filename(id));
    this.writers.delete(id);
    return { deleted: true };
  }
  /** @param {string} extensionId */
  disconnect(extensionId) {
    for (const [id, owner] of this.writers) if (owner === extensionId) this.writers.delete(id);
  }
}
