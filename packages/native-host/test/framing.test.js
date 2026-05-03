// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { MAX_NATIVE_MESSAGE_BYTES } from '../../protocol/src/index.js';
import { fakeSocketThatStalls } from '../../../tests/_helpers/faultInjection.js';
import { createNativeMessageReader, writeJsonLine, writeNativeMessage } from '../src/framing.js';

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

/**
 * @param {number} targetBytes
 * @returns {{ data: string }}
 */
function createSizedMessage(targetBytes) {
  const overhead = Buffer.byteLength(JSON.stringify({ data: '' }), 'utf8');
  const message = { data: 'x'.repeat(targetBytes - overhead) };
  assert.equal(Buffer.byteLength(JSON.stringify(message), 'utf8'), targetBytes);
  return message;
}

/**
 * @param {number} seed
 * @returns {() => number}
 */
function createDeterministicRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * @param {Buffer} buffer
 * @param {() => number} nextRandom
 * @param {number} [maxChunkSize=64]
 * @returns {Buffer[]}
 */
function splitBufferRandomly(buffer, nextRandom, maxChunkSize = 64) {
  /** @type {Buffer[]} */
  const chunks = [];
  let offset = 0;

  while (offset < buffer.length) {
    const remaining = buffer.length - offset;
    const chunkSize = Math.max(1, Math.min(remaining, Math.floor(nextRandom() * maxChunkSize) + 1));
    chunks.push(buffer.subarray(offset, offset + chunkSize));
    offset += chunkSize;
  }

  return chunks;
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

test('writeNativeMessage round-trips a payload at the native message size cap', async () => {
  const stream = new PassThrough();
  const message = createSizedMessage(MAX_NATIVE_MESSAGE_BYTES);
  const received = new Promise((resolve, reject) => {
    createNativeMessageReader(stream, resolve, reject);
  });

  await writeNativeMessage(stream, message);

  assert.deepEqual(await received, message);
});

test('writeNativeMessage rejects payloads above the native message size cap before writing', async () => {
  const stream = new EventEmitter();
  /** @type {Buffer[]} */
  const writes = [];

  /** @type {NodeJS.WritableStream & EventEmitter} */
  const writable = /** @type {any} */ (stream);
  writable.write = (chunk) => {
    writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  };

  await assert.rejects(
    () => writeNativeMessage(writable, createSizedMessage(MAX_NATIVE_MESSAGE_BYTES + 1)),
    /Native message exceeds/u
  );
  assert.deepEqual(writes, []);
});

test('createNativeMessageReader parses a max-size frame from many small chunks without concat churn', async (t) => {
  const input = new PassThrough();
  const message = createSizedMessage(MAX_NATIVE_MESSAGE_BYTES);
  const framed = frameMessage(message);
  /** @type {unknown[]} */
  const messages = [];
  /** @type {Error[]} */
  const protocolErrors = [];
  let concatCalls = 0;
  const originalBufferConcat = Buffer.concat;

  createNativeMessageReader(
    input,
    (parsedMessage) => {
      messages.push(parsedMessage);
    },
    (error) => {
      protocolErrors.push(error);
    }
  );

  t.mock.method(
    Buffer,
    'concat',
    /** @type {typeof Buffer.concat} */ (
      (list, totalLength) => {
        concatCalls += 1;
        return originalBufferConcat(list, totalLength);
      }
    )
  );

  for (let offset = 0; offset < framed.length; offset += 256) {
    input.write(framed.subarray(offset, offset + 256));
  }
  input.end();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(protocolErrors, []);
  assert.deepEqual(messages, [message]);
  assert.equal(concatCalls, 0);
});

test('createNativeMessageReader handles split frames, malformed JSON, and closes on oversized payloads', async () => {
  const input = new PassThrough();
  /** @type {unknown[]} */
  const messages = [];
  /** @type {Error[]} */
  const protocolErrors = [];
  createNativeMessageReader(
    input,
    (message) => {
      messages.push(message);
    },
    (error) => {
      protocolErrors.push(error);
    }
  );

  const split = frameMessage({ id: 1, type: 'ok' });
  input.write(split.subarray(0, 2));
  input.write(split.subarray(2, 7));
  input.write(split.subarray(7));

  input.write(framePayload(Buffer.from('{"broken"', 'utf8')));

  const oversizeHeader = Buffer.alloc(4);
  oversizeHeader.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1, 0);
  const closed = new Promise((resolve) => input.once('close', resolve));
  input.end(Buffer.concat([oversizeHeader, frameMessage({ id: 2, type: 'after-reset' })]));

  await closed;

  assert.equal(protocolErrors.length, 1);
  assert.match(protocolErrors[0].message, /Native message exceeds/u);
  assert.deepEqual(messages, [{ id: 1, type: 'ok' }]);
});

test('createNativeMessageReader skips malformed JSON payloads and continues reading later frames', async () => {
  const input = new PassThrough();
  /** @type {unknown[]} */
  const messages = [];
  /** @type {Error[]} */
  const protocolErrors = [];

  createNativeMessageReader(
    input,
    (message) => {
      messages.push(message);
    },
    (error) => {
      protocolErrors.push(error);
    }
  );

  input.write(framePayload(Buffer.from('{"broken"', 'utf8')));
  input.end(frameMessage({ id: 2, type: 'after-malformed-json' }));

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(protocolErrors, []);
  assert.deepEqual(messages, [{ id: 2, type: 'after-malformed-json' }]);
});

test('createNativeMessageReader parses a frame split across three ticks', async () => {
  const input = new PassThrough();
  const message = { id: 3, type: 'three-chunks', nested: { ok: true } };
  const framed = frameMessage(message);
  /** @type {unknown[]} */
  const messages = [];
  /** @type {Error[]} */
  const protocolErrors = [];

  createNativeMessageReader(
    input,
    (parsedMessage) => {
      messages.push(parsedMessage);
    },
    (error) => {
      protocolErrors.push(error);
    }
  );

  input.write(framed.subarray(0, 3));
  await new Promise((resolve) => setImmediate(resolve));
  input.write(framed.subarray(3, 9));
  await new Promise((resolve) => setImmediate(resolve));
  input.end(framed.subarray(9));

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(protocolErrors, []);
  assert.deepEqual(messages, [message]);
});

test('createNativeMessageReader fuzzes deterministic random chunk splits for valid and malformed frames', async () => {
  const seed = 0x5eed1234;
  const nextRandom = createDeterministicRandom(seed);

  for (let iteration = 0; iteration < 40; iteration += 1) {
    const input = new PassThrough();
    /** @type {unknown[]} */
    const messages = [];
    /** @type {Error[]} */
    const protocolErrors = [];
    /** @type {Buffer[]} */
    const frames = [];
    /** @type {Array<Record<string, unknown>>} */
    const expectedMessages = [];
    const frameCount = 6 + Math.floor(nextRandom() * 6);

    createNativeMessageReader(
      input,
      (message) => {
        messages.push(message);
      },
      (error) => {
        protocolErrors.push(error);
      }
    );

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      if (nextRandom() < 0.35) {
        frames.push(framePayload(Buffer.from('{"broken":', 'utf8')));
        continue;
      }

      const payload = {
        iteration,
        frameIndex,
        ok: frameIndex % 2 === 0,
        label: `msg-${Math.floor(nextRandom() * 1_000_000)}`,
        nested: {
          count: Math.floor(nextRandom() * 50),
          text: 'x'.repeat(1 + Math.floor(nextRandom() * 48)),
        },
      };
      expectedMessages.push(payload);
      frames.push(frameMessage(payload));
    }

    const streamBytes = Buffer.concat(frames);
    for (const chunk of splitBufferRandomly(streamBytes, nextRandom)) {
      input.write(chunk);
    }
    input.end();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(protocolErrors, [], `seed=${seed} iteration=${iteration}`);
    assert.deepEqual(messages, expectedMessages, `seed=${seed} iteration=${iteration}`);
  }
});

test('createNativeMessageReader rejects oversized frames and destroys the stream', async () => {
  const input = new EventEmitter();
  /** @type {Error[]} */
  const protocolErrors = [];
  let destroyCalls = 0;

  /** @type {NodeJS.ReadableStream & EventEmitter & { destroy: () => void }} */
  const readable = /** @type {any} */ (input);
  readable.destroy = () => {
    destroyCalls += 1;
  };

  createNativeMessageReader(
    readable,
    () => {
      throw new Error('onMessage should not be called for oversized frames');
    },
    (error) => {
      protocolErrors.push(error);
    }
  );

  const oversizeLength = MAX_NATIVE_MESSAGE_BYTES + 1;
  const oversizeHeader = Buffer.alloc(4);
  oversizeHeader.writeUInt32LE(oversizeLength, 0);

  input.emit('data', oversizeHeader);

  assert.equal(protocolErrors.length, 1);
  assert.match(
    protocolErrors[0].message,
    new RegExp(`Native message exceeds ${MAX_NATIVE_MESSAGE_BYTES} bytes: ${oversizeLength}`, 'u')
  );
  assert.equal(destroyCalls, 1);
});

test('createNativeMessageReader closes only once after repeated oversized frames', async () => {
  const input = new EventEmitter();
  /** @type {Error[]} */
  const protocolErrors = [];
  let destroyCalls = 0;

  /** @type {NodeJS.ReadableStream & EventEmitter & { destroy: () => void }} */
  const readable = /** @type {any} */ (input);
  readable.destroy = () => {
    destroyCalls += 1;
  };

  createNativeMessageReader(
    readable,
    () => {
      throw new Error('onMessage should not be called for oversized frames');
    },
    (error) => {
      protocolErrors.push(error);
    }
  );

  const oversizeHeader = Buffer.alloc(4);
  oversizeHeader.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1, 0);

  input.emit('data', oversizeHeader);
  input.emit('data', oversizeHeader);

  assert.equal(protocolErrors.length, 1);
  assert.match(protocolErrors[0].message, /Native message exceeds/u);
  assert.equal(destroyCalls, 1);
});

test('createNativeMessageReader does not silently desync after an oversized frame with payload bytes', async () => {
  const input = new PassThrough();
  /** @type {unknown[]} */
  const messages = [];
  /** @type {Error[]} */
  const protocolErrors = [];
  createNativeMessageReader(
    input,
    (message) => {
      messages.push(message);
    },
    (error) => {
      protocolErrors.push(error);
    }
  );

  const oversizeHeader = Buffer.alloc(4);
  oversizeHeader.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1, 0);
  const nextMessage = { id: 2, type: 'after-oversize-payload' };

  input.end(Buffer.concat([oversizeHeader, Buffer.alloc(1024, 0x61), frameMessage(nextMessage)]));
  await new Promise((resolve) => setImmediate(resolve));

  const deliveredNextMessage = messages.some(
    (message) => JSON.stringify(message) === JSON.stringify(nextMessage)
  );
  assert.equal(deliveredNextMessage || protocolErrors.length === 1, true);
  if (protocolErrors.length === 1) {
    assert.match(protocolErrors[0].message, /Native message exceeds/u);
  }
});

test('writeJsonLine appends a newline and stays pending until drain when needed', async () => {
  const stalled = fakeSocketThatStalls();
  let resolved = false;

  const writePromise = writeJsonLine(stalled.socket, { type: 'ping', ok: true }).then(() => {
    resolved = true;
  });

  await Promise.resolve();

  assert.deepEqual(stalled.writes, ['{"type":"ping","ok":true}\n']);
  assert.equal(resolved, false);

  stalled.emitDrain();
  await writePromise;

  assert.equal(resolved, true);
});

test('writeJsonLine preserves write order under sustained backpressure', async () => {
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

  await Promise.all([
    writeJsonLine(typedSocket, { seq: 1 }),
    writeJsonLine(typedSocket, { seq: 2 }),
    writeJsonLine(typedSocket, { seq: 3 }),
  ]);

  assert.deepEqual(writes, ['{"seq":1}\n', '{"seq":2}\n', '{"seq":3}\n']);
});
