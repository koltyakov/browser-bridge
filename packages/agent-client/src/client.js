// @ts-check

import { once } from 'node:events';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

import { createRequest } from '../../protocol/src/index.js';
import { getSocketPath } from '../../native-host/src/config.js';

/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */
/** @typedef {import('../../protocol/src/types.js').BridgeMeta} BridgeMeta */
/** @typedef {import('../../protocol/src/types.js').BridgeMethod} BridgeMethod */

/**
 * @typedef {{
 *   type: 'registered',
 *   role: 'agent' | 'extension',
 *   clientId?: string
 * } | {
 *   type: 'agent.response',
 *   response: BridgeResponse
 * }} ClientMessage
 */

/**
 * @typedef {{
 *   resolve: (value: any) => void,
 *   reject: (error: Error) => void,
 *   timeoutId: NodeJS.Timeout
 * }} PendingRequest
 */

/**
 * @param {net.Socket} socket
 * @param {(message: ClientMessage) => void} onMessage
 * @returns {void}
 */
function parseJsonLines(socket, onMessage) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) {
        continue;
      }
      onMessage(/** @type {ClientMessage} */ (JSON.parse(line)));
    }
  });
}

/**
 * @param {string} method
 * @param {number} timeoutMs
 * @returns {Error & { code: string }}
 */
function createTimeoutError(method, timeoutMs) {
  const error = /** @type {Error & { code: string }} */ (
    new Error(`Timed out waiting for bridge response to ${method} after ${timeoutMs}ms.`)
  );
  error.code = 'BRIDGE_TIMEOUT';
  return error;
}

export class BridgeClient {
  constructor({
    socketPath = getSocketPath(),
    clientId = `agent_${randomUUID()}`,
    defaultTimeoutMs = 8_000
  } = {}) {
    this.socketPath = socketPath;
    this.clientId = clientId;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.socket = null;
    this.connected = false;
    /** @type {Map<string, PendingRequest>} */
    this.waiting = new Map();
  }

  /**
   * @returns {Promise<void>}
   */
  async connect() {
    this.socket = net.createConnection(this.socketPath);
    await new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('error', reject);
    });

    parseJsonLines(this.socket, (message) => {
      if (message.type === 'registered') {
        const pending = this.waiting.get('registered');
        if (pending) {
          this.waiting.delete('registered');
          this.connected = true;
          clearTimeout(pending.timeoutId);
          pending.resolve(message);
        }
        return;
      }

      if (message.type === 'agent.response') {
        const pending = this.waiting.get(message.response.id);
        if (pending) {
          this.waiting.delete(message.response.id);
          clearTimeout(pending.timeoutId);
          pending.resolve(message.response);
        }
      }
    });

    this.socket.on('close', () => {
      this.rejectAllPending(new Error('Bridge socket closed.'));
    });

    this.socket.on('error', (error) => {
      this.rejectAllPending(error);
    });

    this.socket.write(`${JSON.stringify({ type: 'register', role: 'agent', clientId: this.clientId })}\n`);
    await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.waiting.delete('registered');
        reject(createTimeoutError('register', this.defaultTimeoutMs));
      }, this.defaultTimeoutMs);
      this.waiting.set('registered', {
        resolve,
        reject,
        timeoutId
      });
    });
  }

  /**
   * @param {{
   *   method: BridgeMethod,
   *   params?: Record<string, unknown>,
   *   sessionId?: string | null,
   *   meta?: BridgeMeta,
   *   timeoutMs?: number
   * }} options
   * @returns {Promise<BridgeResponse>}
   */
  async request({ method, params = {}, sessionId = null, meta = {}, timeoutMs = this.defaultTimeoutMs }) {
    const request = createRequest({
      id: `req_${randomUUID()}`,
      method,
      params,
      sessionId,
      meta
    });

    const responsePromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.waiting.delete(request.id);
        reject(createTimeoutError(method, timeoutMs));
      }, timeoutMs);

      this.waiting.set(request.id, {
        resolve,
        reject,
        timeoutId
      });
    });

    if (!this.socket.write(`${JSON.stringify({ type: 'agent.request', request })}\n`)) {
      await once(this.socket, 'drain');
    }
    return responsePromise;
  }

  /**
   * @returns {Promise<void>}
   */
  async close() {
    if (!this.socket) {
      return;
    }
    await new Promise((resolve) => {
      this.socket?.end(() => resolve(undefined));
    });
  }

  /**
   * @param {Error} error
   * @returns {void}
   */
  rejectAllPending(error) {
    for (const [key, pending] of this.waiting.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
      this.waiting.delete(key);
    }
  }
}
