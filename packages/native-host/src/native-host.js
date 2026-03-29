// @ts-check

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFailure, ERROR_CODES } from '../../protocol/src/index.js';
import { getSocketPath } from './config.js';
import { createNativeMessageReader, writeJsonLine, writeNativeMessage } from './framing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonEntryPath = path.resolve(__dirname, '../bin/bridge-daemon.js');

/**
 * @typedef {{
 *   type?: string,
 *   request?: unknown
 * }} HostBridgeRequestMessage
 */

/**
 * @typedef {{
 *   type?: string,
 *   requestId?: string
 * }} HostStatusRequestMessage
 */

/**
 * @param {unknown} message
 * @returns {message is HostBridgeRequestMessage}
 */
function isHostBridgeRequest(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && /** @type {Record<string, unknown>} */ (message).type === 'host.bridge_request'
    && typeof /** @type {Record<string, unknown>} */ (message).request === 'object'
  );
}

/**
 * @param {unknown} message
 * @returns {message is HostStatusRequestMessage}
 */
function isHostStatusRequest(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && /** @type {Record<string, unknown>} */ (message).type === 'host.setup_status.request'
    && typeof /** @type {Record<string, unknown>} */ (message).requestId === 'string'
  );
}

/**
 * @param {{ socketPath?: string }} [options={}]
 * @returns {Promise<void>}
 */
export async function runNativeHost({ socketPath = getSocketPath() } = {}) {
  let socket;
  try {
    socket = await connectWithBootstrap(socketPath);
  } catch (error) {
    await writeNativeMessage(process.stdout, {
      type: 'agent.response',
      response: createFailure(
        'native_bootstrap',
        ERROR_CODES.NATIVE_HOST_UNAVAILABLE,
        error instanceof Error ? error.message : String(error)
      )
    });
    return;
  }

  socket.setEncoding('utf8');
  bindBridgeSocketLifecycle(socket);
  await writeJsonLine(socket, { type: 'register', role: 'extension' });

  let lineBuffer = '';
  socket.on('data', (chunk) => {
    lineBuffer += chunk;
    while (lineBuffer.includes('\n')) {
      const index = lineBuffer.indexOf('\n');
      const line = lineBuffer.slice(0, index).trim();
      lineBuffer = lineBuffer.slice(index + 1);
      if (!line) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      void (async () => {
        if (message.type === 'extension.request') {
          await writeNativeMessage(process.stdout, message.request);
          return;
        }
        if (message.type === 'agent.response') {
          await writeNativeMessage(process.stdout, {
            type: 'host.bridge_response',
            response: message.response
          });
          return;
        }
        if (message.type === 'extension.setup_status.response' || message.type === 'extension.setup_status.error') {
          await writeNativeMessage(process.stdout, {
            type: message.type === 'extension.setup_status.response'
              ? 'host.setup_status.response'
              : 'host.setup_status.error',
            requestId: message.requestId,
            status: message.status,
            error: message.error
          });
        }
      })().catch((err) => {
        console.error('native-host: socket message handler failed:', err instanceof Error ? err.message : err);
      });
    }
  });

  createNativeMessageReader(process.stdin, (message) => {
    void (async () => {
      if (isHostBridgeRequest(message)) {
        await writeJsonLine(socket, {
          type: 'agent.request',
          request: message.request
        });
        return;
      }
      if (isHostStatusRequest(message)) {
        await writeJsonLine(socket, {
          type: 'extension.setup_status.request',
          requestId: message.requestId
        });
        return;
      }
      await writeJsonLine(socket, {
        type: 'extension.response',
        response: message
      });
    })().catch((err) => {
      console.error('native-host: stdin message handler failed:', err instanceof Error ? err.message : err);
    });
  });
}

/**
 * Exit the native host when its daemon-side bridge socket closes so Chrome can
 * observe a disconnected native host immediately.
 *
 * @param {net.Socket} socket
 * @param {() => void} [onTerminate]
 * @returns {void}
 */
export function bindBridgeSocketLifecycle(socket, onTerminate = () => {
  process.exit(0);
}) {
  let terminated = false;

  /**
   * @returns {void}
   */
  function terminate() {
    if (terminated) {
      return;
    }
    terminated = true;
    onTerminate();
  }

  socket.on('close', terminate);
  socket.on('end', terminate);
  socket.on('error', terminate);
}

/**
 * @param {string} socketPath
 * @returns {Promise<net.Socket>}
 */
async function connectWithBootstrap(socketPath) {
  try {
    return await connectSocket(socketPath);
  } catch (error) {
    if (!shouldBootstrap(error)) {
      throw error;
    }
  }

  spawnBridgeDaemon();

  let lastError = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await delay(200);
    try {
      return await connectSocket(socketPath);
    } catch (error) {
      lastError = error;
      if (!shouldBootstrap(error)) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error('Bridge daemon did not become available.');
}

/**
 * @param {string} socketPath
 * @returns {Promise<net.Socket>}
 */
function connectSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    /**
     * @param {Error} error
     * @returns {void}
     */
    const handleError = (error) => {
      socket.destroy();
      reject(error);
    };

    socket.once('error', handleError);
    socket.once('connect', () => {
      socket.off('error', handleError);
      resolve(socket);
    });
  });
}

/**
 * @returns {void}
 */
function spawnBridgeDaemon() {
  const child = spawn(process.execPath, [daemonEntryPath], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function shouldBootstrap(error) {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED');
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
