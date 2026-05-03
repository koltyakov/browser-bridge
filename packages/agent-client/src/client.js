// @ts-check

import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

import {
  createRequest,
  DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
  PROTOCOL_VERSION,
  parseJsonLines,
} from '../../protocol/src/index.js';
import {
  createSocketBridgeTransport,
  getBridgeTransport,
  getSocketPath,
} from '../../native-host/src/config.js';

/** @typedef {import('../../native-host/src/config.js').BridgeTransport} BridgeTransport */

/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */
/** @typedef {import('../../protocol/src/types.js').BridgeMeta} BridgeMeta */
/** @typedef {import('../../protocol/src/types.js').BridgeMethod} BridgeMethod */
/**
 * @typedef {{
 *   supported_versions?: string[],
 *   deprecated_since?: string,
 *   migration_hint?: string
 * }} ProtocolHealthResult
 */

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
 * @typedef {{
 *   transport?: BridgeTransport,
 *   socketPath?: string,
 *   clientId?: string,
 *   defaultTimeoutMs?: number,
 *   autoReconnect?: boolean,
 * }} BridgeClientOptions
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

export class BridgeClient extends EventEmitter {
  /**
   * @param {BridgeClientOptions} [options={}]
   */
  constructor({
    transport = getBridgeTransport(),
    socketPath = undefined,
    clientId = `agent_${randomUUID()}`,
    defaultTimeoutMs = DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
    autoReconnect = false,
  } = {}) {
    super();
    this.transport = socketPath ? createSocketBridgeTransport(socketPath) : transport;
    this.socketPath =
      this.transport.type === 'socket' ? this.transport.socketPath : getSocketPath();
    this.clientId = clientId;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.autoReconnect = autoReconnect;
    this.socket = null;
    this.connected = false;
    this.protocolCompatibility = null;
    this.protocolWarning = null;
    /** @type {Map<string, PendingRequest>} */
    this.waiting = new Map();
    this._reconnecting = false;
  }

  /**
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.socket) {
      throw new Error('BridgeClient is already connected.');
    }
    const socket =
      this.transport.type === 'tcp'
        ? net.createConnection({ host: this.transport.host, port: this.transport.port })
        : net.createConnection(this.transport.socketPath);
    this.socket = socket;
    try {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
    } catch (error) {
      socket.destroy();
      this.socket = null;
      throw error;
    }

    parseJsonLines(socket, (raw) => {
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

    socket.on('close', () => {
      this.connected = false;
      this.socket = null;
      this.rejectAllPending(new Error('Bridge socket closed.'));
      if (this.autoReconnect && !this._reconnecting) {
        void this._scheduleReconnect();
      }
    });

    socket.on('error', (error) => {
      this.rejectAllPending(error);
      // 'close' fires after 'error'; reconnect is triggered there.
    });

    this.socket.write(
      `${JSON.stringify({ type: 'register', role: 'agent', clientId: this.clientId })}\n`
    );
    await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.waiting.delete('registered');
        reject(createTimeoutError('register', this.defaultTimeoutMs));
      }, this.defaultTimeoutMs);
      this.waiting.set('registered', {
        resolve,
        reject,
        timeoutId,
      });
    });

    try {
      const healthResponse = await this.request({
        method: 'health.ping',
      });
      if (healthResponse.ok) {
        this.protocolCompatibility = BridgeClient.checkProtocolVersion(
          /** @type {ProtocolHealthResult} */ (healthResponse.result)
        );
        this.protocolWarning = this.protocolCompatibility.warning ?? null;
      }
    } catch {
      this.protocolCompatibility = null;
      this.protocolWarning = null;
    }
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
  async request({
    method,
    params = {},
    tabId = null,
    meta = {},
    timeoutMs = this.defaultTimeoutMs,
  }) {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) {
      const err = /** @type {Error & { code: string }} */ (
        new Error('BridgeClient is not connected.')
      );
      err.code = 'ENOTCONN';
      throw err;
    }

    const request = createRequest({
      id: `req_${randomUUID()}`,
      method,
      params,
      tabId,
      meta,
    });

    const responsePromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.waiting.delete(request.id);
        reject(createTimeoutError(method, timeoutMs));
      }, timeoutMs);

      this.waiting.set(request.id, {
        resolve,
        reject,
        timeoutId,
      });
    });

    if (!this.socket.write(`${JSON.stringify({ type: 'agent.request', request })}\n`)) {
      await Promise.race([
        once(this.socket, 'drain'),
        once(this.socket, 'close').then(() => {
          throw new Error('Bridge socket closed while writing.');
        }),
      ]);
    }
    const response = /** @type {BridgeResponse} */ (await responsePromise);
    return this.attachProtocolWarning(response);
  }

  /**
   * Send multiple bridge requests without waiting for each response serially.
   *
   * @param {Array<{
   *   method: BridgeMethod,
   *   params?: Record<string, unknown>,
   *   tabId?: number | null,
   *   meta?: BridgeMeta,
   *   timeoutMs?: number
   * }>} calls
   * @returns {Promise<BridgeResponse[]>}
   */
  async batch(calls) {
    if (!Array.isArray(calls)) {
      throw new TypeError('BridgeClient.batch expects an array of request objects.');
    }

    return Promise.all(calls.map((call) => this.request(call)));
  }

  /**
   * @returns {Promise<void>}
   */
  async close() {
    this.autoReconnect = false; // prevent reconnect on intentional close
    if (!this.socket) {
      return;
    }
    await new Promise((resolve) => {
      this.socket?.end(() => resolve(undefined));
    });
  }

  /**
   * Attempt to reconnect with exponential backoff (1s → 2s → 4s … → 30s max).
   * Stops if `autoReconnect` is set to false (e.g., by calling `close()`).
   *
   * @returns {Promise<void>}
   */
  async _scheduleReconnect() {
    this._reconnecting = true;
    const backoffs = [1000, 2000, 4000, 8000, 16000, 30000];
    for (let attempt = 0; ; attempt++) {
      const delay = backoffs[Math.min(attempt, backoffs.length - 1)];
      await new Promise((r) => setTimeout(r, delay));
      if (!this.autoReconnect) break;
      try {
        await this.connect();
        this._reconnecting = false;
        this.emit('reconnected');
        return;
      } catch {
        // connection failed - try again after the next backoff interval
      }
    }
    this._reconnecting = false;
  }

  /**
   * Check whether the remote side supports our protocol version.
   * Call after a successful health.ping to get early warnings about version drift.
   *
   * @param {ProtocolHealthResult} healthResult
   * @returns {{ compatible: boolean, localVersion: string, remoteVersions: string[], warning?: string }}
   */
  static checkProtocolVersion(healthResult) {
    const remoteVersions = Array.isArray(healthResult?.supported_versions)
      ? healthResult.supported_versions
      : [];
    if (remoteVersions.length === 0) {
      return {
        compatible: true,
        localVersion: PROTOCOL_VERSION,
        remoteVersions,
      };
    }
    const compatible = remoteVersions.includes(PROTOCOL_VERSION);
    return {
      compatible,
      localVersion: PROTOCOL_VERSION,
      remoteVersions,
      ...(!compatible && {
        warning:
          typeof healthResult?.migration_hint === 'string' && healthResult.migration_hint
            ? healthResult.migration_hint
            : `Protocol mismatch: client speaks ${PROTOCOL_VERSION} but remote supports [${remoteVersions.join(', ')}]. Update the ${remoteVersions[0] > PROTOCOL_VERSION ? 'client (npm)' : 'extension'} to match.`,
      }),
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

  /**
   * @param {BridgeResponse} response
   * @returns {BridgeResponse}
   */
  attachProtocolWarning(response) {
    if (!this.protocolWarning) {
      return response;
    }
    return {
      ...response,
      meta: {
        ...response.meta,
        protocol_warning: this.protocolWarning,
      },
    };
  }
}
