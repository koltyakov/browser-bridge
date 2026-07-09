import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { BridgeTransport } from '../src/config.js';

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
} from '../../../tests/_helpers/nativeMessaging.ts';
import { fakeStreamThatErrorsAfterNBytes } from '../../../tests/_helpers/faultInjection.ts';

type StdinListeners = {
  data: ReturnType<typeof process.stdin.listeners>;
  end: ReturnType<typeof process.stdin.listeners>;
};
type BridgeSocket = net.Socket & EventEmitter;

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function captureStdinListeners(): StdinListeners {
  return {
    data: process.stdin.listeners('data'),
    end: process.stdin.listeners('end'),
  };
}

function restoreStdinListeners(saved: StdinListeners): void {
  for (const eventName of ['data', 'end'] as const) {
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

  bindBridgeSocketLifecycle(socket as unknown as net.Socket, () => {
    terminated += 1;
  });

  socket.emit('end');
  socket.emit('close');
  socket.emit('error', new Error('daemon stopped'));

  assert.equal(terminated, 1);
});

test('shouldBootstrap returns false for non-network errors', () => {
  const accessError = new Error('Permission denied') as NodeJS.ErrnoException;
  accessError.code = 'EACCES';

  for (const error of [accessError, new Error('plain failure')]) {
    assert.equal(shouldBootstrap(error), false);
  }
});

test('connectWithBootstrap spawns daemon when initial connect returns ENOENT', async () => {
  const socket = { connected: true } as unknown as net.Socket;
  const connectCalls: string[] = [];
  const delayCalls: number[] = [];
  let spawnCalls = 0;

  await assert.doesNotReject(async () => {
    const connectedSocket = await connectWithBootstrap('/tmp/bootstrap.sock', {
      connectSocketFn: async (transport) => {
        connectCalls.push(transport.type === 'socket' ? transport.socketPath : transport.label);
        if (connectCalls.length === 1) {
          const error = new Error('missing socket') as NodeJS.ErrnoException;
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
  const delayCalls: number[] = [];
  let connectCalls = 0;
  const finalError = new Error('still missing') as NodeJS.ErrnoException;
  finalError.code = 'ENOENT';

  await assert.rejects(
    connectWithBootstrap('/tmp/bootstrap.sock', {
      connectSocketFn: async () => {
        connectCalls += 1;
        throw connectCalls === 11
          ? finalError
          : (Object.assign(new Error('retry failed'), { code: 'ENOENT' }) as NodeJS.ErrnoException);
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

test('connectWithBootstrap passes tcp transport through to the connector', async () => {
  const socket = { connected: true } as unknown as net.Socket;
  const connectCalls: BridgeTransport[] = [];

  const transport: BridgeTransport = {
    type: 'tcp',
    host: '127.0.0.1',
    port: 9223,
    label: '127.0.0.1:9223',
  };
  const connectedSocket = await connectWithBootstrap(transport, {
    connectSocketFn: async (receivedTransport) => {
      connectCalls.push(receivedTransport);
      return socket;
    },
  });

  assert.equal(connectedSocket, socket);
  assert.deepEqual(connectCalls, [transport]);
});

test('runNativeHost bridges daemon socket messages and stdin frames', async () => {
  const originalCreateConnection = net.createConnection;
  const originalStdoutWrite = process.stdout.write;
  const stdoutChunks: Buffer[] = [];
  const stdinListenersBefore = captureStdinListeners();
  const socketWrites: string[] = [];
  const socket = new EventEmitter();

  const bridgeSocket = socket as unknown as BridgeSocket;
  bridgeSocket.destroy = () => bridgeSocket;
  bridgeSocket.setEncoding = () => bridgeSocket;
  bridgeSocket.write = (chunk: string | Uint8Array) => {
    socketWrites.push(String(chunk));
    return true;
  };

  net.createConnection = (() => {
    setImmediate(() => socket.emit('connect'));
    return bridgeSocket;
  }) as typeof net.createConnection;
  process.stdout.write = ((chunk) => {
    if (Buffer.isBuffer(chunk)) {
      stdoutChunks.push(chunk);
    }
    return true;
  }) as typeof process.stdout.write;

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
  const stdoutChunks: Buffer[] = [];

  net.createConnection = (() => {
    const socket = new EventEmitter();
    const failingSocket = socket as unknown as BridgeSocket;
    failingSocket.destroy = () => failingSocket;
    setImmediate(() => {
      const error = new Error('Permission denied') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      socket.emit('error', error);
    });
    return failingSocket;
  }) as typeof net.createConnection;
  process.stdout.write = ((chunk) => {
    if (Buffer.isBuffer(chunk)) {
      stdoutChunks.push(chunk);
    }
    return true;
  }) as typeof process.stdout.write;

  try {
    await runNativeHost({ socketPath: '/tmp/browser-bridge-test.sock' });

    assert.deepEqual(decodeNativeMessages(stdoutChunks), [
      {
        type: 'host.bridge_response',
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
  const stdoutChunks: Buffer[] = [];
  const stdinListenersBefore = captureStdinListeners();
  const socket = new EventEmitter();

  const bridgeSocket = socket as unknown as BridgeSocket;
  bridgeSocket.destroy = () => bridgeSocket;
  bridgeSocket.setEncoding = () => bridgeSocket;
  bridgeSocket.write = () => true;

  net.createConnection = (() => {
    setImmediate(() => socket.emit('connect'));
    return bridgeSocket;
  }) as typeof net.createConnection;
  process.stdout.write = ((chunk) => {
    if (Buffer.isBuffer(chunk)) {
      stdoutChunks.push(chunk);
    }
    return true;
  }) as typeof process.stdout.write;

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

  const bridgeSocket = socket as unknown as BridgeSocket;
  bridgeSocket.destroy = () => {
    destroyCalls += 1;
    return bridgeSocket;
  };
  bridgeSocket.setEncoding = () => bridgeSocket;
  bridgeSocket.write = () => true;

  net.createConnection = (() => {
    setImmediate(() => socket.emit('connect'));
    return bridgeSocket;
  }) as typeof net.createConnection;

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
  const loggedErrors: string[] = [];
  const registrationLine = '{"type":"register","role":"extension"}\n';
  const erroringStream = fakeStreamThatErrorsAfterNBytes(Buffer.byteLength(registrationLine));
  const bridgeSocket = erroringStream.stream;

  net.createConnection = (() => {
    setImmediate(() => bridgeSocket.emit('connect'));
    return bridgeSocket;
  }) as typeof net.createConnection;
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
  const exitCodes: number[] = [];
  let destroyCalls = 0;

  const bridgeSocket = socket as unknown as BridgeSocket;
  bridgeSocket.setEncoding = () => bridgeSocket;
  bridgeSocket.write = () => true;
  bridgeSocket.destroy = () => {
    destroyCalls += 1;
    socket.emit('close');
    return bridgeSocket;
  };

  net.createConnection = (() => {
    setImmediate(() => socket.emit('connect'));
    return bridgeSocket;
  }) as typeof net.createConnection;
  process.exit = ((code?: string | number | null) => {
    exitCodes.push(typeof code === 'number' ? code : 0);
    return undefined as never;
  }) as typeof process.exit;

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
