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
  socket.on('data', async (chunk) => {
    lineBuffer += chunk;
    while (lineBuffer.includes('\n')) {
      const index = lineBuffer.indexOf('\n');
      const line = lineBuffer.slice(0, index).trim();
      lineBuffer = lineBuffer.slice(index + 1);
      if (!line) {
        continue;
      }
      const message = JSON.parse(line);
      if (message.type === 'extension.request') {
        await writeNativeMessage(process.stdout, message.request);
      }
    }
  });

  createNativeMessageReader(process.stdin, async (message) => {
    await writeJsonLine(socket, {
      type: 'extension.response',
      response: message
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
