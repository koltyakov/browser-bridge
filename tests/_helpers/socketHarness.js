// @ts-check

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { parseJsonLines } from '../../packages/protocol/src/index.js';

/** @typedef {import('../../packages/protocol/src/types.js').BridgeRequest} BridgeRequest */

/**
 * @typedef {{
 *   socket: net.Socket,
 *   server: net.Server,
 *   requests: BridgeRequest[],
 *   messages: unknown[],
 * }} BridgeSocketMessageContext
 */

/**
 * @typedef {{
 *   bridgeHome: string,
 *   socketPath: string,
 *   messages: unknown[],
 *   requests: BridgeRequest[],
 *   errors: Error[],
 *   close: () => Promise<void>,
 * }} BridgeSocketServer
 */

/**
 * @returns {string}
 */
function getTempSocketRoot() {
  return process.platform === 'win32' ? os.tmpdir() : fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
}

/**
 * @param {{ prefix?: string, socketName?: string }} [options]
 * @returns {{ bridgeHome: string, socketPath: string }}
 */
function createTempSocketPath({ prefix = 'bbx-it-', socketName = 'bridge.sock' } = {}) {
  const bridgeHome = fs.mkdtempSync(path.join(getTempSocketRoot(), prefix));
  return {
    bridgeHome,
    socketPath: path.join(bridgeHome, socketName),
  };
}

/**
 * Create a temporary bridge home and socket path for a test callback.
 *
 * @template T
 * @param {(paths: { bridgeHome: string, socketPath: string }) => Promise<T> | T} callback
 * @param {{ prefix?: string, socketName?: string }} [options]
 * @returns {Promise<T>}
 */
export async function withTempSocketPath(callback, options) {
  const { bridgeHome, socketPath } = createTempSocketPath(options);

  try {
    return await callback({ bridgeHome, socketPath });
  } finally {
    fs.rmSync(bridgeHome, { recursive: true, force: true });
  }
}

/**
 * Start a JSON-line bridge socket server for integration tests.
 * The harness auto-acknowledges `register` frames and records incoming messages,
 * requests, and async callback failures.
 *
 * @param {(message: unknown, context: BridgeSocketMessageContext) => Promise<void> | void} onMessage
 * @param {{ prefix?: string, socketName?: string }} [options]
 * @returns {Promise<BridgeSocketServer>}
 */
export async function startBridgeSocketServer(onMessage, options) {
  const { bridgeHome, socketPath } = createTempSocketPath(options);
  /** @type {unknown[]} */
  const messages = [];
  /** @type {BridgeRequest[]} */
  const requests = [];
  /** @type {Error[]} */
  const errors = [];
  /** @type {Set<net.Socket>} */
  const sockets = new Set();
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
          message && typeof message === 'object'
            ? /** @type {Record<string, unknown>} */ (message)
            : null;
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
          requests.push(/** @type {BridgeRequest} */ (record.request));
        }
        await onMessage(message, { socket, server, requests, messages });
      })().catch((error) => {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      });
    });
  });

  try {
    await new Promise((resolve, reject) => {
      /** @param {Error} error */
      const handleError = (error) => {
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
