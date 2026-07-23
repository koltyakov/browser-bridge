// @ts-check

import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

import {
  createFailure,
  createRequest,
  createSuccess,
  DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
  ERROR_CODES,
  getProtocolVersion,
  parseJsonLines,
  setProtocolPackageVersion,
} from '../../protocol/src/index.js';
import { extractContentFromHtml } from './content-extract.js';
import {
  createSocketBridgeTransport,
  getBridgeTransport,
  getSocketPath,
} from '../../native-host/src/config.js';
import { normalizeBridgeAuthToken, readBridgeAuthToken } from '../../native-host/src/auth-token.js';
import { restartBridgeDaemon } from '../../native-host/src/daemon-process.js';

/** @typedef {import('./types.js').BridgeMeta} BridgeMeta */
/** @typedef {import('./types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('./types.js').BridgeResponse} BridgeResponse */
/** @typedef {import('./types.js').BridgeClientOptions} BridgeClientOptions */
/** @typedef {import('./types.js').ClientMessage} ClientMessage */
/** @typedef {import('./types.js').PendingRequest} PendingRequest */
/** @typedef {import('./types.js').ProtocolHealthResult} ProtocolHealthResult */

setProtocolPackageVersion(loadPackageVersion());

/**
 * @returns {string | null}
 */
function loadPackageVersion() {
  try {
    const raw = fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareProtocolVersions(left, right) {
  const leftParts = left.split('.').map((part) => Number(part) || 0);
  const rightParts = right.split('.').map((part) => Number(part) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (delta !== 0) {
      return delta > 0 ? 1 : -1;
    }
  }
  return 0;
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

/**
 * npm exec often runs a checkout-local CLI against an already-connected global
 * daemon. In that mode, protocol drift should warn instead of replacing the
 * user's working daemon and temporarily disconnecting the extension.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
function shouldAutoRestartDaemonOnVersionMismatch(env = process.env) {
  return env.npm_command !== 'exec';
}

/**
 * @param {net.Socket} socket
 * @param {string} line
 * @returns {Promise<void>}
 */
async function writeSocketLine(socket, line) {
  if (!socket.write(line)) {
    await Promise.race([
      once(socket, 'drain'),
      once(socket, 'close').then(() => {
        throw new Error('Bridge socket closed while writing.');
      }),
    ]);
  }
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
    checkProtocolOnConnect = true,
    restartDaemonOnVersionMismatch = shouldAutoRestartDaemonOnVersionMismatch(),
    restartDaemonFn = restartBridgeDaemon,
    authToken = undefined,
  } = {}) {
    super();
    this.transport = socketPath ? createSocketBridgeTransport(socketPath) : transport;
    this.socketPath =
      this.transport.type === 'socket' ? this.transport.socketPath : getSocketPath();
    this.clientId = clientId;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.autoReconnect = autoReconnect;
    this.checkProtocolOnConnect = checkProtocolOnConnect;
    this.restartDaemonOnVersionMismatch = restartDaemonOnVersionMismatch;
    this.restartDaemonFn = restartDaemonFn;
    this.authToken = authToken;
    this.socket = null;
    this.connected = false;
    this.protocolCompatibility = null;
    this.protocolWarning = null;
    /** @type {Map<string, PendingRequest>} */
    this.waiting = new Map();
    this._reconnecting = false;
    this._attemptedVersionMismatchRestart = false;
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

    const registrationPromise = new Promise((resolve, reject) => {
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

      if (message.type === 'registration_failed') {
        const pending = this.waiting.get('registered');
        if (pending) {
          this.waiting.delete('registered');
          clearTimeout(pending.timeoutId);
          pending.reject(new Error(message.error?.message || 'Bridge daemon registration failed.'));
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

    const authToken =
      this.authToken === undefined
        ? this.transport.type === 'tcp'
          ? await readBridgeAuthToken()
          : null
        : normalizeBridgeAuthToken(this.authToken);
    try {
      await writeSocketLine(
        socket,
        `${JSON.stringify({
          type: 'register',
          role: 'agent',
          clientId: this.clientId,
          ...(authToken ? { authToken } : {}),
        })}\n`
      );
    } catch (error) {
      const pending = this.waiting.get('registered');
      if (pending) {
        clearTimeout(pending.timeoutId);
        this.waiting.delete('registered');
      }
      throw error;
    }
    await registrationPromise;

    this.protocolCompatibility = null;
    this.protocolWarning = null;
    if (!this.checkProtocolOnConnect) {
      return;
    }

    /** @type {ProtocolHealthResult | null} */
    let healthResult = null;
    try {
      const healthResponse = await this.request({
        method: 'health.ping',
      });
      if (healthResponse.ok) {
        healthResult = /** @type {ProtocolHealthResult} */ (healthResponse.result);
      }
    } catch {
      this.protocolCompatibility = null;
      this.protocolWarning = null;
      return;
    }

    if (!healthResult) {
      return;
    }

    this.protocolCompatibility = BridgeClient.checkProtocolVersion(healthResult);
    this.protocolWarning = this.protocolCompatibility.warning ?? null;
    if (this.protocolCompatibility.compatible) {
      this._attemptedVersionMismatchRestart = false;
    }
    if (this.shouldRestartDaemonForProtocolMismatch(healthResult)) {
      this._attemptedVersionMismatchRestart = true;
      await this.disconnectForDaemonRestart();
      await this.restartDaemonFn({ transport: this.transport });
      await this.connect();
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

    if (method === 'page.extract_content') {
      const params =
        /** @type {import('../../protocol/src/types.js').NormalizedExtractContentParams} */ (
          request.params
        );
      const titleResponse = params.includeMetadata
        ? await this.request({ method: 'page.get_state', tabId, meta, timeoutMs })
        : null;
      if (titleResponse && !titleResponse.ok) {
        return {
          ...titleResponse,
          id: request.id,
          meta: { ...titleResponse.meta, method },
        };
      }
      const titleResult =
        titleResponse?.ok && titleResponse.result && typeof titleResponse.result === 'object'
          ? /** @type {Record<string, unknown>} */ (titleResponse.result)
          : {};
      const readSnapshot = () =>
        this.request({
          method: 'dom.get_html',
          tabId,
          params: {
            target: { selector: params.selector ?? 'body' },
            outer: true,
            maxLength: 50_000,
          },
          meta: { ...meta, token_budget: null },
          timeoutMs,
        });

      let snapshotResponse = await readSnapshot();
      if (!snapshotResponse.ok) {
        return {
          ...snapshotResponse,
          id: request.id,
          meta: { ...snapshotResponse.meta, method },
        };
      }
      let snapshot = normalizeHtmlSnapshot(snapshotResponse.result);
      if (snapshot.truncated) {
        return createFailure(
          request.id,
          ERROR_CODES.RESULT_TRUNCATED,
          'The bounded HTML snapshot was too large for semantic extraction.',
          {
            selector: params.selector,
            omitted: snapshot.omitted,
            maxLength: 50_000,
          },
          {
            method,
            continuation_hint: 'Retry with a narrower selector.',
          }
        );
      }

      let settlement;
      if (params.consistency === 'settled') {
        const deadline = Date.now() + params.settleTimeoutMs;
        let timedOut = false;
        while (true) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const nextResponse = await readSnapshot();
          if (!nextResponse.ok) {
            return {
              ...nextResponse,
              id: request.id,
              meta: { ...nextResponse.meta, method },
            };
          }
          const nextSnapshot = normalizeHtmlSnapshot(nextResponse.result);
          if (nextSnapshot.truncated) {
            return createFailure(
              request.id,
              ERROR_CODES.RESULT_TRUNCATED,
              'The bounded HTML snapshot was too large for semantic extraction.',
              { selector: params.selector, omitted: nextSnapshot.omitted, maxLength: 50_000 },
              { method, continuation_hint: 'Retry with a narrower selector.' }
            );
          }
          if (nextSnapshot.html === snapshot.html) {
            snapshot = nextSnapshot;
            break;
          }
          snapshot = nextSnapshot;
          if (Date.now() >= deadline) {
            timedOut = true;
            break;
          }
        }
        settlement = { requested: true, quietMs: 100, timedOut };
      }

      const result = extractContentFromHtml(snapshot.html, params, {
        title: typeof titleResult.title === 'string' ? titleResult.title : undefined,
        settlement,
      });
      return this.attachProtocolWarning(
        createSuccess(request.id, result, {
          method,
          node_processed: true,
        })
      );
    }

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

    try {
      await writeSocketLine(this.socket, `${JSON.stringify({ type: 'agent.request', request })}\n`);
    } catch (error) {
      const pending = this.waiting.get(request.id);
      if (pending) {
        clearTimeout(pending.timeoutId);
        this.waiting.delete(request.id);
      }
      throw error;
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
   * @param {ProtocolHealthResult} healthResult
   * @returns {boolean}
   */
  shouldRestartDaemonForProtocolMismatch(healthResult) {
    if (
      !this.restartDaemonOnVersionMismatch ||
      this._attemptedVersionMismatchRestart ||
      !this.protocolCompatibility ||
      this.protocolCompatibility.compatible
    ) {
      return false;
    }

    const remoteVersions = Array.isArray(healthResult?.daemon_supported_versions)
      ? healthResult.daemon_supported_versions
      : healthResult?.extensionConnected === true
        ? []
        : Array.isArray(healthResult?.supported_versions)
          ? healthResult.supported_versions
          : [];
    const latestRemote = remoteVersions[0];
    const extensionVersions = Array.isArray(healthResult?.extension_supported_versions)
      ? healthResult.extension_supported_versions
      : healthResult?.supported_versions;
    if (
      healthResult?.extensionConnected === true &&
      Array.isArray(extensionVersions) &&
      !extensionVersions.includes(getProtocolVersion())
    ) {
      return false;
    }
    return (
      typeof latestRemote === 'string' &&
      compareProtocolVersions(latestRemote, getProtocolVersion()) < 0
    );
  }

  /**
   * Drop the current socket before forcing a daemon restart so the next
   * connect() call observes a fresh local process rather than the existing one.
   *
   * @returns {Promise<void>}
   */
  async disconnectForDaemonRestart() {
    const socket = this.socket;
    if (!socket) {
      return;
    }

    const previousAutoReconnect = this.autoReconnect;
    this.autoReconnect = false;
    this.connected = false;
    this.socket = null;

    if (!socket.destroyed) {
      const closed = once(socket, 'close').catch(() => {});
      socket.destroy();
      await closed;
    }

    this.autoReconnect = previousAutoReconnect;
  }

  /**
   * Check whether the remote side supports our protocol version.
   * Call after a successful health.ping to get early warnings about version drift.
   *
   * @param {ProtocolHealthResult} healthResult
   * @returns {{ compatible: boolean, localVersion: string, remoteVersions: string[], warning?: string }}
   */
  static checkProtocolVersion(healthResult) {
    const remoteVersions = Array.isArray(healthResult?.extension_supported_versions)
      ? healthResult.extension_supported_versions
      : Array.isArray(healthResult?.supported_versions)
        ? healthResult.supported_versions
        : [];
    if (remoteVersions.length === 0) {
      return {
        compatible: true,
        localVersion: getProtocolVersion(),
        remoteVersions,
      };
    }
    const localVersion = getProtocolVersion();
    const compatible = remoteVersions.includes(localVersion);
    return {
      compatible,
      localVersion,
      remoteVersions,
      ...(!compatible && {
        warning:
          typeof healthResult?.migration_hint === 'string' && healthResult.migration_hint
            ? healthResult.migration_hint
            : `Protocol mismatch: client speaks ${localVersion} but remote supports [${remoteVersions.join(', ')}]. Update the ${remoteVersions[0] > localVersion ? 'client (npm)' : 'extension'} to match.`,
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

/**
 * @param {unknown} result
 * @returns {{ html: string, truncated: boolean, omitted: number }}
 */
function normalizeHtmlSnapshot(result) {
  const value =
    result && typeof result === 'object' ? /** @type {Record<string, unknown>} */ (result) : {};
  return {
    html: typeof value.html === 'string' ? value.html : '',
    truncated: value.truncated === true,
    omitted: typeof value.omitted === 'number' ? value.omitted : 0,
  };
}
