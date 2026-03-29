// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { MAX_NATIVE_MESSAGE_BYTES } from '../../protocol/src/index.js';
import {
  createNativeMessageReader,
  writeJsonLine,
  writeNativeMessage,
} from '../src/framing.js';

/**
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function framePayload(payload) {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * @param {unknown} message
 * @returns {Buffer}
 */
function frameMessage(message) {
  return framePayload(Buffer.from(JSON.stringify(message), 'utf8'));
}

test('writeNativeMessage writes framed JSON and respects drain backpressure', async () => {
  const stream = new EventEmitter();
  /** @type {Buffer[]} */
  const writes = [];
  let callCount = 0;

  /** @type {NodeJS.WritableStream & EventEmitter} */
  const writable = /** @type {any} */ (stream);
  writable.write = (chunk) => {
    writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callCount += 1;
    if (callCount <= 2) {
      setImmediate(() => stream.emit('drain'));
      return false;
    }
    return true;
  };

  await writeNativeMessage(writable, { ok: true, nested: { value: 1 } });

  assert.equal(writes.length, 2);
  const length = writes[0].readUInt32LE(0);
  assert.equal(length, writes[1].length);
  assert.deepEqual(JSON.parse(writes[1].toString('utf8')), {
    ok: true,
    nested: { value: 1 },
  });
});

test('createNativeMessageReader handles split frames, malformed JSON, and oversized payloads', async () => {
  const input = new PassThrough();
  /** @type {unknown[]} */
  const messages = [];
  createNativeMessageReader(input, (message) => {
    messages.push(message);
  });

  const split = frameMessage({ id: 1, type: 'ok' });
  input.write(split.subarray(0, 2));
  input.write(split.subarray(2, 7));
  input.write(split.subarray(7));

  input.write(framePayload(Buffer.from('{"broken"', 'utf8')));

  const oversizeHeader = Buffer.alloc(4);
  oversizeHeader.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1, 0);
  input.write(oversizeHeader);

  input.write(frameMessage({ id: 2, type: 'after-reset' }));
  input.end();

  await new Promise((resolve) => input.once('end', resolve));

  assert.deepEqual(messages, [
    { id: 1, type: 'ok' },
    { id: 2, type: 'after-reset' },
  ]);
});

test('writeJsonLine appends a newline and waits for drain when needed', async () => {
  const socket = new EventEmitter();
  /** @type {string[]} */
  const writes = [];

  /** @type {import('node:net').Socket & EventEmitter} */
  const typedSocket = /** @type {any} */ (socket);
  typedSocket.write = (chunk) => {
    writes.push(String(chunk));
    setImmediate(() => socket.emit('drain'));
    return false;
  };

  await writeJsonLine(typedSocket, { type: 'ping', ok: true });

  assert.deepEqual(writes, ['{"type":"ping","ok":true}\n']);
});
