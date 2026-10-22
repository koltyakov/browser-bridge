import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';

import { parseJsonLines } from '../src/json-lines.js';
import { MAX_JSON_LINE_BYTES } from '../src/defaults.js';

class FakeSocket extends EventEmitter {
  encoding: BufferEncoding | null;
  destroyed: boolean;

  constructor() {
    super();
    this.encoding = null;
    this.destroyed = false;
  }

  setEncoding(encoding: BufferEncoding): void {
    this.encoding = encoding;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function createHarness(options?: {
  maxLineBytes?: number;
  onProtocolError?: (error: Error) => void;
}): { socket: FakeSocket; messages: unknown[]; errors: Error[] } {
  const socket = new FakeSocket();
  const messages: unknown[] = [];
  const errors: Error[] = [];
  parseJsonLines(
    socket as unknown as Socket,
    (message) => {
      messages.push(message);
    },
    { ...options, onProtocolError: options?.onProtocolError ?? ((error) => errors.push(error)) }
  );
  return { socket, messages, errors };
}

test('parseJsonLines configures utf8 encoding on the socket', () => {
  const { socket } = createHarness();
  assert.equal(socket.encoding, 'utf8');
});

test('parseJsonLines buffers a partial line until the newline arrives', () => {
  const { socket, messages } = createHarness();

  socket.emit('data', '{"id":1,"par');
  assert.deepEqual(messages, []);

  socket.emit('data', 'tial":true');
  assert.deepEqual(messages, []);

  socket.emit('data', '}\n');
  assert.deepEqual(messages, [{ id: 1, partial: true }]);
});

test('parseJsonLines delivers multiple messages from a single chunk', () => {
  const { socket, messages } = createHarness();

  socket.emit('data', '{"a":1}\n{"b":2}\n[3,4]\n"text"\nnull\n');
  assert.deepEqual(messages, [{ a: 1 }, { b: 2 }, [3, 4], 'text', null]);
});

test('parseJsonLines skips blank and whitespace-only lines', () => {
  const { socket, messages, errors } = createHarness();

  socket.emit('data', '\n  \n\t\n{"ok":true}\n\n');
  assert.deepEqual(messages, [{ ok: true }]);
  assert.deepEqual(errors, []);
});

test('parseJsonLines skips malformed JSON without reporting a protocol error', () => {
  const { socket, messages, errors } = createHarness();

  socket.emit('data', '{"broken"\n{not json}\n{"ok":true}\n');
  assert.deepEqual(messages, [{ ok: true }]);
  assert.deepEqual(errors, []);
});

test('parseJsonLines destroys the socket when a buffered line exceeds the byte limit', () => {
  const { socket, messages, errors } = createHarness({ maxLineBytes: 8 });

  socket.emit('data', '{"oversized":true');

  assert.equal(socket.destroyed, true);
  assert.deepEqual(messages, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /JSON line exceeds 8 bytes/);
});

test('parseJsonLines destroys the socket when a completed line exceeds the byte limit', () => {
  const { socket, messages, errors } = createHarness({ maxLineBytes: 8 });

  socket.emit('data', '{"a":123456}\n');

  assert.equal(socket.destroyed, true);
  assert.deepEqual(messages, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /JSON line exceeds 8 bytes/);
});

test('parseJsonLines measures the byte limit in UTF-8 bytes, not characters', () => {
  const { socket, messages, errors } = createHarness({ maxLineBytes: 11 });

  // 'é' is 2 UTF-8 bytes, so this 7-character line is 11 bytes and passes.
  socket.emit('data', '"aééébc"\n');
  assert.deepEqual(messages, ['aééébc']);
  assert.equal(errors.length, 0);

  // 8 characters but 13 bytes once encoded: over the limit.
  socket.emit('data', '"aéééébc"\n');
  assert.equal(socket.destroyed, true);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /JSON line exceeds 11 bytes/);
});

test('parseJsonLines works without an onProtocolError hook', () => {
  const socket = new FakeSocket();
  const messages: unknown[] = [];
  parseJsonLines(
    socket as unknown as Socket,
    (message) => {
      messages.push(message);
    },
    { maxLineBytes: 4 }
  );

  socket.emit('data', '{"tooLong":true');
  assert.equal(socket.destroyed, true);
  assert.deepEqual(messages, []);
});

test('parseJsonLines falls back to the default line limit for invalid maxLineBytes', () => {
  const socket = new FakeSocket();
  const messages: unknown[] = [];
  parseJsonLines(
    socket as unknown as Socket,
    (message) => {
      messages.push(message);
    },
    { maxLineBytes: Number.NaN }
  );

  const payload = { data: 'x'.repeat(1024) };
  socket.emit('data', `${JSON.stringify(payload)}\n`);
  assert.deepEqual(messages, [payload]);
  assert.equal(socket.destroyed, false);

  assert.equal(MAX_JSON_LINE_BYTES > 1024, true);
});

test('parseJsonLines floors fractional maxLineBytes and enforces a minimum of 1', () => {
  const { socket, messages, errors } = createHarness({ maxLineBytes: 10.9 });

  socket.emit('data', '{"a":1}\n');
  assert.deepEqual(messages, [{ a: 1 }]);
  assert.equal(errors.length, 0);

  socket.emit('data', '{"abc":123}\n');
  assert.equal(socket.destroyed, true);
  assert.match(errors[0].message, /JSON line exceeds 10 bytes/);
});
