import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  createSuccess,
  deriveProtocolVersion,
  parseJsonLines,
} from '../../packages/protocol/src/index.js';
import type { BridgeRequest, BridgeResponse } from '../../packages/protocol/src/types.js';

export type BridgeSocketMessageContext = {
  socket: net.Socket;
  server: net.Server;
  requests: BridgeRequest[];
  messages: unknown[];
};

export type BridgeSocketServer = {
  bridgeHome: string;
  socketPath: string;
  messages: unknown[];
  requests: BridgeRequest[];
  errors: Error[];
  close: () => Promise<void>;
};

export type BridgeRequestHandler = (
  request: BridgeRequest,
  context: BridgeSocketMessageContext & { message: unknown }
) => Promise<BridgeResponse | void> | BridgeResponse | void;

export type SocketPathOptions = {
  prefix?: string;
  socketName?: string;
};

export type SocketPathSet = {
  bridgeHome: string;
  socketPath: string;
};

function loadRepositoryProtocolVersion(): string {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  );
  const packageVersion =
    parsed && typeof parsed === 'object' && 'version' in parsed ? parsed.version : null;
  return deriveProtocolVersion(typeof packageVersion === 'string' ? packageVersion : null);
}

const TEST_PROTOCOL_VERSION = loadRepositoryProtocolVersion();

function getTempSocketRoot(): string {
  return process.platform === 'win32' ? os.tmpdir() : fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
}

function createTempSocketPath({
  prefix = 'bbx-it-',
  socketName = 'bridge.sock',
}: SocketPathOptions = {}): SocketPathSet {
  const bridgeHome = fs.mkdtempSync(path.join(getTempSocketRoot(), prefix));
  return {
    bridgeHome,
    socketPath: path.join(bridgeHome, socketName),
  };
}

// Create a temporary bridge home and socket path for a test callback.
export async function withTempSocketPath<T>(
  callback: (paths: SocketPathSet) => Promise<T> | T,
  options?: SocketPathOptions
): Promise<T> {
  const { bridgeHome, socketPath } = createTempSocketPath(options);

  try {
    return await callback({ bridgeHome, socketPath });
  } finally {
    fs.rmSync(bridgeHome, { recursive: true, force: true });
  }
}

// Start a JSON-line bridge socket server for integration tests. The harness
// auto-acknowledges `register` frames and records incoming messages, requests,
// and async callback failures.
export async function startBridgeSocketServer(
  onMessage: (message: unknown, context: BridgeSocketMessageContext) => Promise<void> | void,
  options?: SocketPathOptions
): Promise<BridgeSocketServer> {
  const { bridgeHome, socketPath } = createTempSocketPath(options);
  const messages: unknown[] = [];
  const requests: BridgeRequest[] = [];
  const errors: Error[] = [];
  const sockets = new Set<net.Socket>();
  let closed = false;

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });

    parseJsonLines(socket, (message) => {
      messages.push(message);
      void (async () => {
        const record =
          message && typeof message === 'object' ? (message as Record<string, unknown>) : null;
        if (record?.type === 'register') {
          socket.write(
            `${JSON.stringify({
              type: 'registered',
              role: typeof record.role === 'string' ? record.role : 'agent',
              clientId: typeof record.clientId === 'string' ? record.clientId : 'test_client',
            })}\n`
          );
          return;
        }
        if (
          record?.type === 'agent.request' &&
          record.request &&
          typeof record.request === 'object'
        ) {
          requests.push(record.request as BridgeRequest);
        }
        await onMessage(message, { socket, server, requests, messages });
      })().catch((error) => {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      });
    });
  });

  try {
    await new Promise((resolve, reject) => {
      const handleError = (error: Error) => {
        server.removeListener('listening', handleListening);
        reject(error);
      };
      const handleListening = () => {
        server.removeListener('error', handleError);
        resolve(undefined);
      };
      server.once('error', handleError);
      server.once('listening', handleListening);
      server.listen(socketPath);
    });
  } catch (error) {
    fs.rmSync(bridgeHome, { recursive: true, force: true });
    throw error;
  }

  return {
    bridgeHome,
    socketPath,
    messages,
    requests,
    errors,
    async close() {
      if (closed) {
        return;
      }
      closed = true;

      for (const socket of sockets) {
        socket.destroy();
      }
      if (server.listening) {
        await new Promise((resolve) => {
          server.close(() => resolve(undefined));
        });
      }
      fs.rmSync(bridgeHome, { recursive: true, force: true });
    },
  };
}

// Start a bridge socket server backed by per-method request handlers. Returning
// a response auto-writes the matching `agent.response` frame.
export async function bridgeServerWith(
  handlers: Record<string, BridgeRequestHandler>,
  options?: SocketPathOptions
): Promise<BridgeSocketServer> {
  return startBridgeSocketServer(async (message, context) => {
    const record =
      message && typeof message === 'object' ? (message as Record<string, unknown>) : null;

    if (record?.type !== 'agent.request' || !record.request || typeof record.request !== 'object') {
      return;
    }

    const request = record.request as BridgeRequest;
    const handler = handlers[request.method];
    let response: BridgeResponse | void;

    if (handler) {
      response = await handler(request, { ...context, message });
    } else if (request.method === 'health.ping') {
      response = createSuccess(request.id, {
        daemon: 'ok',
        supported_versions: [TEST_PROTOCOL_VERSION],
        extensionConnected: false,
        connectedExtensions: [],
        access: {
          enabled: false,
          routeReady: false,
          routeTabId: null,
          windowId: null,
          reason: 'access_disabled',
        },
      });
    } else {
      return;
    }

    if (response === undefined) {
      return;
    }

    context.socket.write(
      `${JSON.stringify({
        type: 'agent.response',
        response,
      })}\n`
    );
  }, options);
}
