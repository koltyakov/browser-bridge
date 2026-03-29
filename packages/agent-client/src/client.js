// @ts-check

import { once } from 'node:events';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

import { createRequest, PROTOCOL_VERSION, parseJsonLines } from '../../protocol/src/index.js';
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
    if (this.socket) {
      throw new Error('BridgeClient is already connected.');
    }
    this.socket = net.createConnection(this.socketPath);
    await new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('error', reject);
    });

    parseJsonLines(this.socket, (raw) => {
      const message = /** @type {ClientMessage} */ (raw);
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
   *   tabId?: number | null,
   *   meta?: BridgeMeta,
   *   timeoutMs?: number
   * }} options
   * @returns {Promise<BridgeResponse>}
   */
  async request({ method, params = {}, tabId = null, meta = {}, timeoutMs = this.defaultTimeoutMs }) {
    const request = createRequest({
      id: `req_${randomUUID()}`,
      method,
      params,
      tabId,
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
      await Promise.race([
        once(this.socket, 'drain'),
        once(this.socket, 'close').then(() => { throw new Error('Bridge socket closed while writing.'); })
      ]);
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
   * Check whether the remote side supports our protocol version.
   * Call after a successful health.ping to get early warnings about version drift.
   *
   * @param {{ supported_versions?: string[], deprecated_since?: string, migration_hint?: string }} healthResult
   * @returns {{ compatible: boolean, localVersion: string, remoteVersions: string[], warning?: string }}
   */
  static checkProtocolVersion(healthResult) {
    const remoteVersions = Array.isArray(healthResult?.supported_versions)
      ? healthResult.supported_versions
      : [];
    if (remoteVersions.length === 0) {
      return { compatible: true, localVersion: PROTOCOL_VERSION, remoteVersions };
    }
    const compatible = remoteVersions.includes(PROTOCOL_VERSION);
    return {
      compatible,
      localVersion: PROTOCOL_VERSION,
      remoteVersions,
      ...(!compatible && {
        warning:
          typeof healthResult?.migration_hint === 'string' &&
          healthResult.migration_hint
            ? healthResult.migration_hint
            : `Protocol mismatch: client speaks ${PROTOCOL_VERSION} but remote supports [${remoteVersions.join(', ')}]. Update the ${remoteVersions[0] > PROTOCOL_VERSION ? 'client (npm)' : 'extension'} to match.`
      })
    };
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
