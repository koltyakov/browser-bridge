import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { BridgeDaemon } from '../../packages/native-host/src/daemon.js';
import { ArtifactStore } from '../../packages/native-host/src/artifact-store.js';
import { BridgeClient } from '../../packages/agent-client/src/client.js';
import { parseJsonLines, PROTOCOL_VERSION } from '../../packages/protocol/src/index.js';
import type { AddressInfo, Socket } from 'node:net';
import type { BridgeTransport } from '../../packages/native-host/src/config.js';
import type { BridgeRequest } from '../../packages/protocol/src/types.js';

export type TestDaemonContext = {
  daemon: BridgeDaemon;
  address: AddressInfo;
  tempRoot: string;
  connect: () => Promise<Socket>;
  stop: () => Promise<void>;
};

export type FakeExtension = {
  socket: Socket;
  requests: BridgeRequest[];
  nextRequest: (timeoutMs?: number) => Promise<BridgeRequest>;
  respondOk: (request: BridgeRequest, result: unknown) => void;
  respondError: (request: BridgeRequest, code: string, message: string) => void;
  sendMessage: (message: unknown) => void;
  enableAccess: () => void;
  destroy: () => void;
};

export type TestClientOptions = {
  clientId?: string;
  defaultTimeoutMs?: number;
  autoReconnect?: boolean;
  checkProtocolOnConnect?: boolean;
};

// Start an in-process daemon on a loopback TCP port with an isolated artifact
// store so tests never touch the real bridge home.
export async function startTestDaemon(port = 0): Promise<TestDaemonContext> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bbx-it-daemon-'));
  const artifactStore = new ArtifactStore(path.join(tempRoot, 'artifacts'));
  const daemon = new BridgeDaemon({
    transport: {
      type: 'tcp',
      host: '127.0.0.1',
      port,
      label: `127.0.0.1:${port}`,
    } satisfies BridgeTransport,
    listenOptions: { host: '127.0.0.1', port },
    logger: { log() {}, error() {} },
    authToken: null,
    artifactStore,
  });

  let stopped = false;
  try {
    await daemon.start();
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }

  const address = daemon.serverAddress as AddressInfo;
  return {
    daemon,
    address,
    tempRoot,
    connect: () =>
      new Promise((resolve, reject) => {
        const socket = net.createConnection({
          host: '127.0.0.1',
          port: address.port,
        });
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
      }),
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      await daemon.stop();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

// Connect a fake extension that records forwarded requests and auto-answers
// health.ping. Non-ping requests are buffered until nextRequest() consumes them.
export async function connectFakeExtension(
  ctx: TestDaemonContext,
  { autoPing = true }: { autoPing?: boolean } = {}
): Promise<FakeExtension> {
  const socket = await ctx.connect();
  const requests: BridgeRequest[] = [];
  const buffered: BridgeRequest[] = [];
  const waiters: Array<{
    resolve: (request: BridgeRequest) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  function sendMessage(message: unknown): void {
    socket.write(`${JSON.stringify(message)}\n`);
  }

  function respondOk(request: BridgeRequest, result: unknown): void {
    sendMessage({
      type: 'extension.response',
      response: {
        id: request.id,
        ok: true,
        result,
        error: null,
        meta: { protocol_version: PROTOCOL_VERSION, method: request.method },
      },
    });
  }

  function respondError(request: BridgeRequest, code: string, message: string): void {
    sendMessage({
      type: 'extension.response',
      response: {
        id: request.id,
        ok: false,
        result: null,
        error: { code, message, details: null },
        meta: { protocol_version: PROTOCOL_VERSION, method: request.method },
      },
    });
  }

  const registered = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('extension registration timeout')), 3_000);
    parseJsonLines(socket, (raw) => {
      const record = (raw ?? {}) as Record<string, unknown>;
      if (record.type === 'registered' && record.role === 'extension') {
        clearTimeout(timer);
        resolve();
        return;
      }
      if (
        record.type === 'extension.request' &&
        record.request &&
        typeof record.request === 'object'
      ) {
        const request = record.request as BridgeRequest;
        requests.push(request);
        if (autoPing && request.method === 'health.ping') {
          respondOk(request, {
            extension: 'ok',
            access: { enabled: true, routeReady: true, routeTabId: 1, windowId: 1 },
          });
          return;
        }
        const waiter = waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(request);
        } else {
          buffered.push(request);
        }
      }
    });
  });
  sendMessage({ type: 'register', role: 'extension' });
  await registered;

  function nextRequest(timeoutMs = 3_000): Promise<BridgeRequest> {
    const existing = buffered.shift();
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject: (error: Error) => {
          const index = waiters.indexOf(entry);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(error);
        },
        timer: setTimeout(() => {
          entry.reject(new Error('timed out waiting for extension.request'));
        }, timeoutMs),
      };
      waiters.push(entry);
    });
  }

  return {
    socket,
    requests,
    nextRequest,
    respondOk,
    respondError,
    sendMessage,
    enableAccess: () => {
      sendMessage({ type: 'extension.access_update', accessEnabled: true });
    },
    destroy: () => {
      socket.destroy();
    },
  };
}

// Connect a BridgeClient to the in-process daemon.
export async function connectTestClient(
  ctx: TestDaemonContext,
  options: TestClientOptions = {}
): Promise<BridgeClient> {
  const client = new BridgeClient({
    socketPath: undefined,
    defaultTimeoutMs: options.defaultTimeoutMs ?? 2_000,
    autoReconnect: options.autoReconnect ?? false,
    checkProtocolOnConnect: options.checkProtocolOnConnect ?? true,
    ...(options.clientId ? { clientId: options.clientId } : {}),
  });
  client.transport = {
    type: 'tcp',
    host: ctx.address.address,
    port: ctx.address.port,
    label: `${ctx.address.address}:${ctx.address.port}`,
  } satisfies BridgeTransport;
  client.socketPath = '';
  await client.connect();
  return client;
}
