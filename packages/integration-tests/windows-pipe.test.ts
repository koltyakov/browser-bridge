import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import type { BridgeRequest } from '../protocol/src/types.js';

import { BridgeDaemon, isWindowsNamedPipePath } from '../native-host/src/daemon.js';
import { BridgeClient } from '../agent-client/src/client.js';
import { parseJsonLines, PROTOCOL_VERSION } from '../protocol/src/index.js';

// --- Unit: named pipe path detection (all platforms) ---

test('isWindowsNamedPipePath detects Windows named pipe paths', () => {
  assert.equal(isWindowsNamedPipePath('\\\\.\\pipe\\myapp'), true);
  assert.equal(isWindowsNamedPipePath('\\\\.\\pipe\\com.browserbridge.browser_bridge'), true);
  assert.equal(isWindowsNamedPipePath('\\\\.\\pipe\\bbx-test-1234'), true);
});

test('isWindowsNamedPipePath returns false for non-pipe paths', () => {
  assert.equal(isWindowsNamedPipePath('/tmp/bridge.sock'), false);
  assert.equal(isWindowsNamedPipePath('C:\\Users\\test\\bridge.sock'), false);
  assert.equal(isWindowsNamedPipePath('./relative.sock'), false);
  assert.equal(isWindowsNamedPipePath(''), false);
});

// --- Unit: daemon transport detection for named pipe paths (all platforms) ---

test('daemon classifies named pipe socketPath as socket transport with pipe detection', () => {
  const pipePath = '\\\\.\\pipe\\bbx-fs-skip-test';
  const daemon = new BridgeDaemon({
    socketPath: pipePath,
    logger: { log() {}, error() {} },
  });

  assert.equal(daemon.transport.type, 'socket');
  assert.equal(daemon.socketPath, pipePath);
  assert.equal(isWindowsNamedPipePath(daemon.socketPath), true);
});

// --- Integration: daemon over Windows Named Pipe (Windows only) ---

function connectToPipe(pipePath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

test(
  'daemon starts and handles health.ping over Windows Named Pipe',
  {
    skip:
      process.platform !== 'win32'
        ? 'Windows Named Pipe transport test only runs on Windows'
        : false,
  },
  async () => {
    const pipePath = `\\\\.\\pipe\\bbx-test-${Date.now()}`;
    const daemon = new BridgeDaemon({
      socketPath: pipePath,
      logger: { log() {}, error() {} },
    });

    try {
      await daemon.start();
      assert.equal(daemon.serverAddress, pipePath);

      const client = new BridgeClient({
        socketPath: pipePath,
        defaultTimeoutMs: 2_000,
      });

      try {
        await client.connect();
        const response = await client.request({ method: 'health.ping' });
        assert.equal(response.ok, true);
        const result = response.result as Record<string, unknown>;
        assert.equal(result.daemon, 'ok');
        assert.equal(result.extensionConnected, false);
      } finally {
        await client.close().catch(() => {});
      }
    } finally {
      await daemon.stop();
      assert.equal(daemon.server, null);
    }
  }
);

test(
  'daemon round-trips an extension request over Windows Named Pipe',
  {
    skip:
      process.platform !== 'win32'
        ? 'Windows Named Pipe transport test only runs on Windows'
        : false,
  },
  async () => {
    const pipePath = `\\\\.\\pipe\\bbx-ext-test-${Date.now()}`;
    const daemon = new BridgeDaemon({
      socketPath: pipePath,
      logger: { log() {}, error() {} },
    });

    try {
      await daemon.start();

      const extSocket = await connectToPipe(pipePath);
      const registered = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('extension registration timeout')), 2_000);
        parseJsonLines(extSocket, (msg) => {
          clearTimeout(timer);
          resolve(msg as Record<string, unknown>);
        });
        extSocket.write(`${JSON.stringify({ type: 'register', role: 'extension' })}\n`);
      });

      assert.equal(registered.type, 'registered');

      const client = new BridgeClient({
        socketPath: pipePath,
        defaultTimeoutMs: 2_000,
      });

      try {
        await client.connect();
        const responsePromise = client.request({
          method: 'page.get_state',
          params: {},
        });

        const fwd = await new Promise<{ type?: unknown; request: BridgeRequest }>(
          (resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('forwarded request timeout')), 2_000);
            parseJsonLines(extSocket, (msg) => {
              clearTimeout(timer);
              const record = msg as Record<string, unknown>;
              resolve({ type: record.type, request: record.request as BridgeRequest });
            });
          }
        );
        assert.equal(fwd.type, 'extension.request');

        extSocket.write(
          `${JSON.stringify({
            type: 'extension.response',
            response: {
              id: fwd.request.id,
              ok: true,
              result: { url: 'https://pipe-test.example/' },
              error: null,
              meta: { protocol_version: PROTOCOL_VERSION, method: 'page.get_state' },
            },
          })}\n`
        );

        const response = await responsePromise;
        assert.equal(response.ok, true);
        const result = response.result as Record<string, unknown>;
        assert.equal(result.url, 'https://pipe-test.example/');
      } finally {
        await client.close().catch(() => {});
        extSocket.destroy();
      }
    } finally {
      await daemon.stop();
    }
  }
);
