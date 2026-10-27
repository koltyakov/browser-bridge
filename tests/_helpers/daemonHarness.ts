import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import { getProtocolVersion } from '../../protocol/src/index.js';
import { parseJsonLines } from './jsonLines.js';
import { setProtocolPackageVersion } from './protocolVersion.js';
import { isolatedBridgeEnv, nativeExecutable } from './runCli.ts';
import { NativeWireClient } from './nativeWire.ts';
import type { AddressInfo, Socket } from 'node:net';
import type { BridgeRequest } from '../../protocol/src/types.js';

const agentToken = 'test_agent_'.padEnd(43, 'a');
const extensionToken = 'test_extension_'.padEnd(43, 'b');
const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
setProtocolPackageVersion(pkg.version);

export type TestDaemonContext = {
  child: ChildProcessWithoutNullStreams;
  address: AddressInfo;
  tempRoot: string;
  env: NodeJS.ProcessEnv;
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

// Start the Go daemon with isolated credentials and storage. The extension peer
// below implements only test framing; runtime behavior stays in the Go process.
export async function startTestDaemon(port = 0): Promise<TestDaemonContext> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bbx-it-daemon-'));
  fs.writeFileSync(path.join(tempRoot, 'daemon.auth'), agentToken, { mode: 0o600 });
  fs.writeFileSync(path.join(tempRoot, 'daemon.extension.auth'), extensionToken, { mode: 0o600 });
  const listener = net.createServer();
  listener.listen(port, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve()))
  );
  const env = {
    ...isolatedBridgeEnv(process.env),
    BROWSER_BRIDGE_HOME: tempRoot,
    BBX_TCP_PORT: String(address.port),
  };
  const child = spawn(nativeExecutable, ['--bridge-daemon'], { env, stdio: 'pipe' });
  let stderr = '';
  let startupError: Error | undefined;
  child.on('error', (error) => {
    startupError = error;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout.resume();
  let stopped = false;
  const ctx: TestDaemonContext = {
    child,
    address,
    tempRoot,
    env,
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
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        const exited = once(child, 'exit');
        child.kill();
        const force = setTimeout(() => child.kill('SIGKILL'), 3_000);
        try {
          await exited;
        } finally {
          clearTimeout(force);
        }
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null || child.signalCode !== null) break;
      try {
        const probe = await connectTestClient(ctx);
        await probe.close();
        return ctx;
      } catch {
        await delay(20);
      }
    }
    throw new Error(`Go daemon did not start: ${stderr}`);
  } catch (error) {
    await ctx.stop();
    throw error;
  }
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
        meta: { protocol_version: getProtocolVersion(), method: request.method },
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
        meta: { protocol_version: getProtocolVersion(), method: request.method },
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
  sendMessage({ type: 'register', role: 'extension', authToken: extensionToken });
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

export function connectTestClient(ctx: TestDaemonContext): Promise<NativeWireClient> {
  return NativeWireClient.connect(ctx.address.port, agentToken);
}
