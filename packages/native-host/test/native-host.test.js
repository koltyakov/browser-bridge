// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';

import { ERROR_CODES, MAX_NATIVE_MESSAGE_BYTES } from '../../protocol/src/index.js';
import {
  bindBridgeSocketLifecycle,
  connectWithBootstrap,
  runNativeHost,
  shouldBootstrap,
} from '../src/native-host.js';
import {
  decodeNativeMessages,
  frameNativeMessage,
} from '../../../tests/_helpers/nativeMessaging.js';
import { fakeStreamThatErrorsAfterNBytes } from '../../../tests/_helpers/faultInjection.js';

/**
 * @returns {Promise<void>}
 */
async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * @returns {{ data: Function[], end: Function[] }}
 */
function captureStdinListeners() {
  return {
    data: process.stdin.listeners('data'),
    end: process.stdin.listeners('end'),
  };
}

/**
 * @param {{ data: Function[], end: Function[] }} saved
 * @returns {void}
 */
function restoreStdinListeners(saved) {
  for (const eventName of /** @type {const} */ (['data', 'end'])) {
    const before = saved[eventName];
    for (const listener of process.stdin.listeners(eventName)) {
      if (!before.includes(listener)) {
        process.stdin.removeListener(eventName, listener);
      }
    }
  }
  process.stdin.pause();
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

test('shouldBootstrap returns false for non-network errors', () => {
  const accessError = /** @type {NodeJS.ErrnoException} */ (new Error('Permission denied'));
  accessError.code = 'EACCES';

  for (const error of [accessError, new Error('plain failure')]) {
    assert.equal(shouldBootstrap(error), false);
  }
});

test('connectWithBootstrap spawns daemon when initial connect returns ENOENT', async () => {
  /** @type {import('node:net').Socket} */
  const socket = /** @type {any} */ ({ connected: true });
  /** @type {string[]} */
  const connectCalls = [];
  /** @type {number[]} */
  const delayCalls = [];
  let spawnCalls = 0;

  await assert.doesNotReject(async () => {
    const connectedSocket = await connectWithBootstrap('/tmp/bootstrap.sock', {
      connectSocketFn: async (socketPath) => {
        connectCalls.push(socketPath);
        if (connectCalls.length === 1) {
          const error = /** @type {NodeJS.ErrnoException} */ (new Error('missing socket'));
          error.code = 'ENOENT';
          throw error;
        }
        return socket;
      },
      spawnBridgeDaemonFn: () => {
        spawnCalls += 1;
      },
      delayFn: async (ms) => {
        delayCalls.push(ms);
      },
    });

    assert.equal(connectedSocket, socket);
  });

  assert.deepEqual(connectCalls, ['/tmp/bootstrap.sock', '/tmp/bootstrap.sock']);
  assert.deepEqual(delayCalls, [200]);
  assert.equal(spawnCalls, 1);
});

test('connectWithBootstrap exhausts retries and rethrows the last bootstrap error', async () => {
  /** @type {number[]} */
  const delayCalls = [];
  let connectCalls = 0;
  const finalError = /** @type {NodeJS.ErrnoException} */ (new Error('still missing'));
  finalError.code = 'ENOENT';

  await assert.rejects(
    connectWithBootstrap('/tmp/bootstrap.sock', {
      connectSocketFn: async () => {
        connectCalls += 1;
        throw connectCalls === 11
          ? finalError
          : /** @type {NodeJS.ErrnoException} */ (
              Object.assign(new Error('retry failed'), { code: 'ENOENT' })
            );
      },
      spawnBridgeDaemonFn: () => {},
      delayFn: async (ms) => {
        delayCalls.push(ms);
      },
    }),
    (error) => {
      assert.equal(error, finalError);
      return true;
    }
  );

  assert.equal(connectCalls, 11);
  assert.deepEqual(delayCalls, new Array(10).fill(200));
});

test('runNativeHost bridges daemon socket messages and stdin frames', async () => {
  const originalCreateConnection = net.createConnection;
  const originalStdoutWrite = process.stdout.write;
  /** @type {Buffer[]} */
  const stdoutChunks = [];
  const stdinListenersBefore = captureStdinListeners();
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

    socket.emit(
      'data',
      `${JSON.stringify({ type: 'extension.request', request: { id: 'ext-1', ok: true } })}\n`
    );
    socket.emit(
      'data',
      `${JSON.stringify({ type: 'agent.response', response: { ok: true, result: { pong: true } } })}\n`
    );
    socket.emit(
      'data',
      `${JSON.stringify({
        type: 'extension.setup_status.response',
        requestId: 'setup-1',
        status: { configured: true },
      })}\n`
    );
    socket.emit(
      'data',
      `${JSON.stringify({
        type: 'extension.setup_status.error',
        requestId: 'setup-2',
        error: { code: 'BROKEN', message: 'No extension' },
      })}\n`
    );
    process.stdin.emit(
      'data',
      frameNativeMessage({
        type: 'host.bridge_request',
        request: { id: 'agent-1', method: 'tabs.list' },
      })
    );
    process.stdin.emit(
      'data',
      frameNativeMessage({
        type: 'host.setup_status.request',
        requestId: 'setup-3',
      })
    );
    process.stdin.emit(
      'data',
      frameNativeMessage({
        type: 'host.identity',
        browserName: 'chrome',
        profileLabel: 'Default',
      })
    );
    process.stdin.emit(
      'data',
      frameNativeMessage({
        type: 'host.access_update',
        accessEnabled: true,
      })
    );
    process.stdin.emit(
      'data',
      frameNativeMessage({
        type: 'host.activity',
        at: 12345,
      })
    );
    process.stdin.emit(
      'data',
      frameNativeMessage({
        id: 'plain-1',
        ok: true,
      })
    );

    await flushAsyncWork();

    assert.deepEqual(decodeNativeMessages(stdoutChunks), [
      { id: 'ext-1', ok: true },
      {
        type: 'host.bridge_response',
        response: { ok: true, result: { pong: true } },
      },
      {
        type: 'host.setup_status.response',
        requestId: 'setup-1',
        status: { configured: true },
      },
      {
        type: 'host.setup_status.error',
        requestId: 'setup-2',
        error: { code: 'BROKEN', message: 'No extension' },
      },
    ]);
    assert.deepEqual(socketWrites.slice(1), [
      '{"type":"agent.request","request":{"id":"agent-1","method":"tabs.list"}}\n',
      '{"type":"extension.setup_status.request","requestId":"setup-3"}\n',
      '{"type":"extension.identity","browserName":"chrome","profileLabel":"Default"}\n',
      '{"type":"extension.access_update","accessEnabled":true}\n',
      '{"type":"extension.activity","at":12345}\n',
      '{"type":"extension.response","response":{"id":"plain-1","ok":true}}\n',
    ]);
  } finally {
    net.createConnection = originalCreateConnection;
    process.stdout.write = originalStdoutWrite;
    restoreStdinListeners(stdinListenersBefore);
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
              hint: 'Native host not reachable. Run `bbx doctor` to diagnose the installation.',
            },
          },
          meta: { protocol_version: '1.0' },
        },
      },
    ]);
  } finally {
    net.createConnection = originalCreateConnection;
    process.stdout.write = originalStdoutWrite;
    process.stdin.pause();
  }
});

test('runNativeHost ignores malformed daemon payloads and forwards completed lines', async () => {
  const originalCreateConnection = net.createConnection;
  const originalStdoutWrite = process.stdout.write;
  /** @type {Buffer[]} */
  const stdoutChunks = [];
  const stdinListenersBefore = captureStdinListeners();
  const socket = new EventEmitter();

  /** @type {import('node:net').Socket & EventEmitter} */
  const bridgeSocket = /** @type {any} */ (socket);
  bridgeSocket.destroy = () => bridgeSocket;
  bridgeSocket.setEncoding = () => bridgeSocket;
  bridgeSocket.write = () => true;

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

    socket.emit('data', 'not-json\n');
    socket.emit('data', '\n');
    socket.emit('data', '{"type":"extension.request","request":{"id":"ext-split"');
    socket.emit('data', ',"ok":true}}\n');

    await flushAsyncWork();

    assert.deepEqual(decodeNativeMessages(stdoutChunks), [{ id: 'ext-split', ok: true }]);
  } finally {
    net.createConnection = originalCreateConnection;
    process.stdout.write = originalStdoutWrite;
    restoreStdinListeners(stdinListenersBefore);
  }
});

test('runNativeHost destroys the bridge socket when stdin framing fails', async () => {
  const originalCreateConnection = net.createConnection;
  const stdinListenersBefore = captureStdinListeners();
  const socket = new EventEmitter();
  let destroyCalls = 0;

  /** @type {import('node:net').Socket & EventEmitter} */
  const bridgeSocket = /** @type {any} */ (socket);
  bridgeSocket.destroy = () => {
    destroyCalls += 1;
    return bridgeSocket;
  };
  bridgeSocket.setEncoding = () => bridgeSocket;
  bridgeSocket.write = () => true;

  net.createConnection = /** @type {typeof net.createConnection} */ (
    () => {
      setImmediate(() => socket.emit('connect'));
      return bridgeSocket;
    }
  );

  try {
    await runNativeHost({ socketPath: '/tmp/browser-bridge-test.sock' });

    const oversizeHeader = Buffer.alloc(4);
    oversizeHeader.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1, 0);
    process.stdin.emit('data', oversizeHeader);
    process.stdin.emit('data', oversizeHeader);

    await flushAsyncWork();

    assert.equal(destroyCalls, 1);
  } finally {
    net.createConnection = originalCreateConnection;
    restoreStdinListeners(stdinListenersBefore);
  }
});

test('runNativeHost logs stdin handler failures when writes to the daemon socket fail', async () => {
  const originalCreateConnection = net.createConnection;
  const originalConsoleError = console.error;
  const stdinListenersBefore = captureStdinListeners();
  /** @type {string[]} */
  const loggedErrors = [];
  const registrationLine = '{"type":"register","role":"extension"}\n';
  const erroringStream = fakeStreamThatErrorsAfterNBytes(Buffer.byteLength(registrationLine));
  const bridgeSocket = erroringStream.stream;

  net.createConnection = /** @type {typeof net.createConnection} */ (
    () => {
      setImmediate(() => bridgeSocket.emit('connect'));
      return bridgeSocket;
    }
  );
  console.error = (...args) => {
    loggedErrors.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    await runNativeHost({ socketPath: '/tmp/browser-bridge-test.sock' });

    process.stdin.emit(
      'data',
      frameNativeMessage({
        type: 'host.bridge_request',
        request: { id: 'agent-2', method: 'tabs.list' },
      })
    );

    await flushAsyncWork();

    assert.deepEqual(erroringStream.writes, [registrationLine]);
    assert.equal(loggedErrors.length, 1);
    assert.match(loggedErrors[0], /native-host: stdin message handler failed:/u);
    assert.match(
      loggedErrors[0],
      new RegExp(erroringStream.error.message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u')
    );
  } finally {
    net.createConnection = originalCreateConnection;
    console.error = originalConsoleError;
    restoreStdinListeners(stdinListenersBefore);
  }
});

test('runNativeHost tears down the bridge socket and exits when stdin ends', async () => {
  const originalCreateConnection = net.createConnection;
  const originalProcessExit = process.exit;
  const stdinListenersBefore = captureStdinListeners();
  const socket = new EventEmitter();
  /** @type {number[]} */
  const exitCodes = [];
  let destroyCalls = 0;

  /** @type {import('node:net').Socket & EventEmitter} */
  const bridgeSocket = /** @type {any} */ (socket);
  bridgeSocket.setEncoding = () => bridgeSocket;
  bridgeSocket.write = () => true;
  bridgeSocket.destroy = () => {
    destroyCalls += 1;
    socket.emit('close');
    return bridgeSocket;
  };

  net.createConnection = /** @type {typeof net.createConnection} */ (
    () => {
      setImmediate(() => socket.emit('connect'));
      return bridgeSocket;
    }
  );
  process.exit = /** @type {typeof process.exit} */ (
    (code) => {
      exitCodes.push(typeof code === 'number' ? code : 0);
      return /** @type {never} */ (undefined);
    }
  );

  try {
    await runNativeHost({ socketPath: '/tmp/browser-bridge-test.sock' });

    process.stdin.emit('end');
    await flushAsyncWork();

    assert.equal(destroyCalls, 1);
    assert.deepEqual(exitCodes, [0]);
  } finally {
    net.createConnection = originalCreateConnection;
    process.exit = originalProcessExit;
    restoreStdinListeners(stdinListenersBefore);
  }
});
