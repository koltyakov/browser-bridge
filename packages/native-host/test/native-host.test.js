// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';

import { ERROR_CODES } from '../../protocol/src/index.js';
import { bindBridgeSocketLifecycle, runNativeHost } from '../src/native-host.js';

/**
 * @param {unknown} message
 * @returns {Buffer}
 */
function frameNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * @param {Buffer[]} chunks
 * @returns {unknown[]}
 */
function decodeNativeMessages(chunks) {
  /** @type {unknown[]} */
  const messages = [];

  for (let index = 0; index < chunks.length - 1; index += 1) {
    const header = chunks[index];
    const payload = chunks[index + 1];
    if (header.length !== 4) {
      continue;
    }

    const expectedLength = header.readUInt32LE(0);
    if (payload.length !== expectedLength) {
      continue;
    }

    messages.push(JSON.parse(payload.toString('utf8')));
    index += 1;
  }

  return messages;
}

/**
 * @returns {Promise<void>}
 */
async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** Ensure daemon socket teardown terminates the native host promptly. */
test('bindBridgeSocketLifecycle terminates once on socket close', () => {
  const socket = new EventEmitter();
  let terminated = 0;

  bindBridgeSocketLifecycle(
    /** @type {import('node:net').Socket} */ (/** @type {unknown} */ (socket)),
    () => {
      terminated += 1;
    }
  );

  socket.emit('end');
  socket.emit('close');
  socket.emit('error', new Error('daemon stopped'));

  assert.equal(terminated, 1);
});

test('runNativeHost bridges daemon socket messages and stdin frames', async () => {
  const originalCreateConnection = net.createConnection;
  const originalStdoutWrite = process.stdout.write;
  /** @type {Buffer[]} */
  const stdoutChunks = [];
  /** @type {Function[]} */
  const stdinListenersBefore = process.stdin.listeners('data');
  /** @type {string[]} */
  const socketWrites = [];
  const socket = new EventEmitter();

  /** @type {import('node:net').Socket & EventEmitter} */
  const bridgeSocket = /** @type {any} */ (socket);
  bridgeSocket.destroy = () => bridgeSocket;
  bridgeSocket.setEncoding = () => bridgeSocket;
  bridgeSocket.write = (chunk) => {
    socketWrites.push(String(chunk));
    return true;
  };

  net.createConnection = /** @type {typeof net.createConnection} */ (
    () => {
      setImmediate(() => socket.emit('connect'));
      return bridgeSocket;
    }
  );
  process.stdout.write = /** @type {typeof process.stdout.write} */ (
    (chunk) => {
      if (Buffer.isBuffer(chunk)) {
        stdoutChunks.push(chunk);
      }
      return true;
    }
  );

  try {
    await runNativeHost({ socketPath: '/tmp/browser-bridge-test.sock' });

    assert.equal(socketWrites[0], '{"type":"register","role":"extension"}\n');

    socket.emit('data', `${JSON.stringify({ type: 'extension.request', request: { id: 'ext-1', ok: true } })}\n`);
    socket.emit('data', `${JSON.stringify({ type: 'agent.response', response: { ok: true, result: { pong: true } } })}\n`);
    socket.emit('data', `${JSON.stringify({
      type: 'extension.setup_status.response',
      requestId: 'setup-1',
      status: { configured: true }
    })}\n`);
    socket.emit('data', `${JSON.stringify({
      type: 'extension.setup_status.error',
      requestId: 'setup-2',
      error: { code: 'BROKEN', message: 'No extension' }
    })}\n`);
    process.stdin.emit('data', frameNativeMessage({
      type: 'host.bridge_request',
      request: { id: 'agent-1', method: 'tabs.list' }
    }));
    process.stdin.emit('data', frameNativeMessage({
      type: 'host.setup_status.request',
      requestId: 'setup-3'
    }));
    process.stdin.emit('data', frameNativeMessage({
      id: 'plain-1',
      ok: true
    }));

    await flushAsyncWork();

    assert.deepEqual(decodeNativeMessages(stdoutChunks), [
      { id: 'ext-1', ok: true },
      {
        type: 'host.bridge_response',
        response: { ok: true, result: { pong: true } }
      },
      {
        type: 'host.setup_status.response',
        requestId: 'setup-1',
        status: { configured: true }
      },
      {
        type: 'host.setup_status.error',
        requestId: 'setup-2',
        error: { code: 'BROKEN', message: 'No extension' }
      }
    ]);
    assert.deepEqual(socketWrites.slice(1), [
      '{"type":"agent.request","request":{"id":"agent-1","method":"tabs.list"}}\n',
      '{"type":"extension.setup_status.request","requestId":"setup-3"}\n',
      '{"type":"extension.response","response":{"id":"plain-1","ok":true}}\n'
    ]);
  } finally {
    net.createConnection = originalCreateConnection;
    process.stdout.write = originalStdoutWrite;

    for (const listener of process.stdin.listeners('data')) {
      if (!stdinListenersBefore.includes(listener)) {
        process.stdin.removeListener('data', listener);
      }
    }
    process.stdin.pause();
  }
});

test('runNativeHost reports bootstrap failures as native error responses', async () => {
  const originalCreateConnection = net.createConnection;
  const originalStdoutWrite = process.stdout.write;
  /** @type {Buffer[]} */
  const stdoutChunks = [];

  net.createConnection = /** @type {typeof net.createConnection} */ (
    () => {
      const socket = new EventEmitter();
      /** @type {import('node:net').Socket & EventEmitter} */
      const failingSocket = /** @type {any} */ (socket);
      failingSocket.destroy = () => failingSocket;
      setImmediate(() => {
        const error = /** @type {NodeJS.ErrnoException} */ (new Error('Permission denied'));
        error.code = 'EPERM';
        socket.emit('error', error);
      });
      return failingSocket;
    }
  );
  process.stdout.write = /** @type {typeof process.stdout.write} */ (
    (chunk) => {
      if (Buffer.isBuffer(chunk)) {
        stdoutChunks.push(chunk);
      }
      return true;
    }
  );

  try {
    await runNativeHost({ socketPath: '/tmp/browser-bridge-test.sock' });

    assert.deepEqual(decodeNativeMessages(stdoutChunks), [
      {
        type: 'agent.response',
        response: {
          id: 'native_bootstrap',
          ok: false,
          result: null,
          error: {
            code: ERROR_CODES.NATIVE_HOST_UNAVAILABLE,
            message: 'Permission denied',
            details: null,
            recovery: {
              retry: false,
              hint: 'Native host not reachable. Run `bbx doctor` to diagnose the installation.'
            }
          },
          meta: { protocol_version: '1.0' }
        }
      }
    ]);
  } finally {
    net.createConnection = originalCreateConnection;
    process.stdout.write = originalStdoutWrite;
    process.stdin.pause();
  }
});
