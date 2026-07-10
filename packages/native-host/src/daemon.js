// @ts-check

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  installAgentFiles,
  isSupportedTarget,
  removeAgentFiles,
} from '../../agent-client/src/install.js';
import {
  installMcpConfig,
  isMcpClientName,
  removeMcpConfig,
} from '../../agent-client/src/mcp-config.js';
import { collectSetupStatus } from '../../agent-client/src/setup-status.js';
import {
  createFailure,
  createSuccess,
  DAEMON_EXISTING_SOCKET_PING_TIMEOUT_MS,
  DAEMON_PENDING_TIMEOUT_MARGIN_MS,
  DAEMON_RECENT_LOG_LIMIT,
  DEFAULT_DAEMON_PENDING_TIMEOUT_MS,
  DEFAULT_LOG_TAIL_LIMIT,
  ERROR_CODES,
  getProtocolVersion,
  getSupportedProtocolVersions,
  MAX_DAEMON_PENDING_TIMEOUT_MS,
  parseJsonLines,
  setProtocolPackageVersion,
  validateBridgeRequest,
} from '../../protocol/src/index.js';
import {
  createSocketBridgeTransport,
  formatBridgeTransport,
  getBridgeListenTarget,
  getBridgeTransport,
  getSocketPath,
} from './config.js';
import {
  ensureBridgeAuthToken,
  normalizeBridgeAuthToken,
  readBridgeAuthToken,
} from './auth-token.js';
import { normalizeDaemonLogger } from './daemon-logger.js';
import { writeJsonLine } from './framing.js';

const DAEMON_VERSION = loadDaemonVersion();
setProtocolPackageVersion(DAEMON_VERSION);

/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../../protocol/src/types.js').SetupInstallParams} SetupInstallParams */
/** @typedef {import('../../protocol/src/types.js').SetupInstallResult} SetupInstallResult */
/** @typedef {import('../../protocol/src/types.js').SetupStatus} SetupStatus */
/** @typedef {import('./config.js').BridgeTransport} BridgeTransport */
/** @typedef {import('./daemon-logger.js').DaemonLoggerLike} DaemonLoggerLike */
/** @typedef {'agent' | 'extension'} SocketRole */
/** @typedef {import('node:net').Socket & { readonly __role?: SocketRole, __clientId?: string, __extensionId?: string, __browserName?: string, __profileLabel?: string, __accessEnabled?: boolean, __lastActiveAt?: number }} ClientSocket */
/** @typedef {{ socket: ClientSocket, timeoutId: NodeJS.Timeout, source?: string, method?: string, protocolVersion?: string, targets: Set<ClientSocket>, lastErrorResponse?: import('../../protocol/src/types.js').BridgeResponse }} PendingEntry */
/**
 * @typedef {{
 *   installAgentFiles: typeof import('../../agent-client/src/install.js').installAgentFiles,
 *   isSupportedTarget: typeof import('../../agent-client/src/install.js').isSupportedTarget,
 *   removeAgentFiles: typeof import('../../agent-client/src/install.js').removeAgentFiles,
 *   installMcpConfig: typeof import('../../agent-client/src/mcp-config.js').installMcpConfig,
 *   isMcpClientName: typeof import('../../agent-client/src/mcp-config.js').isMcpClientName,
 *   removeMcpConfig: typeof import('../../agent-client/src/mcp-config.js').removeMcpConfig,
 *   cwd: string
 * }} SetupInstallDeps
 */

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
 * @param {string | undefined} requestedVersion
 * @returns {{ supported_versions: readonly string[], deprecated_since?: string, migration_hint?: string }}
 */
function getVersionNegotiationPayload(requestedVersion) {
  const supportedVersions = getSupportedProtocolVersions();
  const latestSupported = supportedVersions[0];
  if (!requestedVersion || !latestSupported || supportedVersions.includes(requestedVersion)) {
    return { supported_versions: supportedVersions };
  }

  const localIsNewer = compareProtocolVersions(latestSupported, requestedVersion) > 0;
  return {
    supported_versions: supportedVersions,
    ...(localIsNewer ? { deprecated_since: latestSupported } : {}),
    migration_hint: localIsNewer
      ? `Browser Bridge daemon is newer than the client protocol ${requestedVersion}. Restart or update the Browser Bridge CLI/npm package to ${latestSupported} or later.`
      : `Browser Bridge daemon is older than the client protocol ${requestedVersion}. Restart or update the Browser Bridge CLI so the daemon supports ${requestedVersion}.`,
  };
}

/**
 * @returns {string | null}
 */
function loadDaemonVersion() {
  try {
    const raw = fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} socketPath
 * @returns {boolean}
 */
export function isWindowsNamedPipePath(socketPath) {
  return socketPath.startsWith('\\\\.\\pipe\\');
}

/**
 * @typedef {{
 *   type?: string,
 *   role?: string,
 *   clientId?: string,
 *   requestId?: string,
 *   entry?: Record<string, unknown>,
 *   request?: BridgeRequest,
 *   status?: SetupStatus,
 *   error?: { message?: string },
 *   response?: import('../../protocol/src/types.js').BridgeResponse,
 *   browserName?: string,
 *   profileLabel?: string,
 *   accessEnabled?: boolean,
 *   authToken?: string,
 *   at?: number
 * }} DaemonMessage
 */

export class BridgeDaemon {
  /**
   * @param {{
   *   transport?: BridgeTransport,
   *   socketPath?: string,
   *   listenOptions?: import('node:net').ListenOptions | null,
   *   setupStatusLoader?: () => Promise<SetupStatus>,
   *   setupInstaller?: (params: Record<string, unknown>) => Promise<SetupInstallResult>,
   *   logger?: DaemonLoggerLike | Pick<Console, 'log' | 'error'>,
   *   authToken?: string | null
   * }} [options={}]
   */
  constructor({
    transport = getBridgeTransport(),
    socketPath = undefined,
    listenOptions = null,
    setupStatusLoader = collectSetupStatus,
    setupInstaller = installSetupTarget,
    logger = undefined,
    authToken = undefined,
  } = {}) {
    this.transport = socketPath ? createSocketBridgeTransport(socketPath) : transport;
    this.socketPath =
      this.transport.type === 'socket' ? this.transport.socketPath : getSocketPath();
    this.listenOptions = listenOptions ?? getBridgeListenTarget(this.transport);
    this.setupStatusLoader = setupStatusLoader;
    this.setupInstaller = setupInstaller;
    /** @type {DaemonLoggerLike} */
    this.logger = normalizeDaemonLogger(logger);
    /** @type {net.Server | null} */
    this.server = null;
    /** @type {net.AddressInfo | string | null} */
    this.serverAddress = null;
    /** @type {Map<string, ClientSocket>} */
    this.extensionSockets = new Map();
    /** @type {Map<string, ClientSocket>} */
    this.agentSockets = new Map();
    /** @type {Map<string, PendingEntry>} */
    this.pendingRequests = new Map();
    /** @type {Map<ClientSocket, Set<string>>} */
    this.pendingRequestsByOwnerSocket = new Map();
    /** @type {Map<ClientSocket, Set<string>>} */
    this.pendingRequestsByTargetSocket = new Map();
    this.pendingTimeoutMs = DEFAULT_DAEMON_PENDING_TIMEOUT_MS;
    /** @type {Record<string, unknown>[]} */
    this.recentLog = [];
    /** @type {Array<{ extensionId: string, browserName: string | null, profileLabel: string | null, accessEnabled: boolean }> | null} */
    this.connectedExtensionsCache = null;
    /** @type {Promise<void> | null} */
    this.stopPromise = null;
    /** @type {number} */
    this.startedAt = 0;
    /** @type {number} */
    this.requestsProcessed = 0;
    /** @type {number} */
    this.requestsFailed = 0;
    /** @type {number} */
    this.totalResponseTimeMs = 0;
    /** @type {Map<string, number>} */
    this.requestStartTimes = new Map();
    /** @type {string | null | undefined} */
    this.authToken = authToken;
  }

  /**
   * @returns {boolean}
   */
  isAuthRequired() {
    return Boolean(this.authToken);
  }

  /**
   * @returns {void}
   */
  invalidateConnectedExtensionsCache() {
    this.connectedExtensionsCache = null;
  }

  /**
   * @param {Map<ClientSocket, Set<string>>} index
   * @param {ClientSocket} socket
   * @param {string} requestId
   * @returns {void}
   */
  addPendingRequestIndex(index, socket, requestId) {
    const requestIds = index.get(socket);
    if (requestIds) {
      requestIds.add(requestId);
      return;
    }
    index.set(socket, new Set([requestId]));
  }

  /**
   * @param {Map<ClientSocket, Set<string>>} index
   * @param {ClientSocket} socket
   * @param {string} requestId
   * @returns {void}
   */
  removePendingRequestIndex(index, socket, requestId) {
    const requestIds = index.get(socket);
    if (!requestIds) {
      return;
    }
    requestIds.delete(requestId);
    if (requestIds.size === 0) {
      index.delete(socket);
    }
  }

  /**
   * @param {string} requestId
   * @param {PendingEntry} pending
   * @returns {void}
   */
  trackPendingRequest(requestId, pending) {
    this.pendingRequests.set(requestId, pending);
    this.requestStartTimes.set(requestId, Date.now());
    this.addPendingRequestIndex(this.pendingRequestsByOwnerSocket, pending.socket, requestId);
    for (const targetSocket of pending.targets) {
      this.addPendingRequestIndex(this.pendingRequestsByTargetSocket, targetSocket, requestId);
    }
  }

  /**
   * @param {string} requestId
   * @param {PendingEntry | undefined} [pending]
   * @returns {PendingEntry | undefined}
   */
  clearPendingRequest(requestId, pending = this.pendingRequests.get(requestId)) {
    if (!pending) {
      return undefined;
    }
    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(requestId);
    this.removePendingRequestIndex(this.pendingRequestsByOwnerSocket, pending.socket, requestId);
    for (const targetSocket of pending.targets) {
      this.removePendingRequestIndex(this.pendingRequestsByTargetSocket, targetSocket, requestId);
    }
    return pending;
  }

  /**
   * @param {string} requestId
   * @param {PendingEntry} pending
   * @param {ClientSocket} targetSocket
   * @returns {void}
   */
  removePendingTarget(requestId, pending, targetSocket) {
    if (!pending.targets.delete(targetSocket)) {
      return;
    }
    this.removePendingRequestIndex(this.pendingRequestsByTargetSocket, targetSocket, requestId);
  }

  /**
   * @returns {Array<{ extensionId: string, browserName: string | null, profileLabel: string | null, accessEnabled: boolean }>}
   */
  getConnectedExtensionsSnapshot() {
    if (this.connectedExtensionsCache) {
      return this.connectedExtensionsCache;
    }

    this.connectedExtensionsCache = Array.from(this.extensionSockets.entries()).map(
      ([extensionId, extSocket]) => ({
        extensionId,
        browserName: extSocket.__browserName ?? null,
        profileLabel: extSocket.__profileLabel ?? null,
        accessEnabled: extSocket.__accessEnabled ?? false,
      })
    );
    return this.connectedExtensionsCache;
  }

  /**
   * @param {ClientSocket} socket
   * @param {DaemonMessage} message
   * @returns {void}
   */
  registerSocket(socket, message) {
    if (socket.__role) {
      void writeJsonLine(socket, {
        type: 'registration_failed',
        error: {
          code: ERROR_CODES.INVALID_REQUEST,
          message: `Socket is already registered as ${socket.__role}.`,
        },
      });
      return;
    }

    if (this.isAuthRequired() && normalizeBridgeAuthToken(message.authToken) !== this.authToken) {
      this.logger.error('socket registration rejected', { role: message.role ?? null });
      void writeJsonLine(socket, {
        type: 'registration_failed',
        error: {
          code: ERROR_CODES.ACCESS_DENIED,
          message: 'Bridge daemon authentication failed.',
        },
      }).finally(() => socket.destroy());
      return;
    }

    if (message.role !== 'extension' && message.role !== 'agent') {
      void writeJsonLine(socket, {
        type: 'registration_failed',
        error: {
          code: ERROR_CODES.INVALID_REQUEST,
          message: 'Socket role must be "agent" or "extension".',
        },
      });
      return;
    }

    Object.defineProperty(socket, '__role', {
      value: message.role,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    if (message.role === 'extension') {
      const extensionId = randomUUID();
      socket.__extensionId = extensionId;
      socket.__browserName =
        typeof message.browserName === 'string' ? message.browserName : undefined;
      socket.__profileLabel =
        typeof message.profileLabel === 'string' ? message.profileLabel : undefined;
      socket.__lastActiveAt = Date.now();
      this.extensionSockets.set(extensionId, socket);
      this.invalidateConnectedExtensionsCache();
      this.logger.info('extension registered', {
        extensionId,
        browserName: socket.__browserName ?? null,
        profileLabel: socket.__profileLabel ?? null,
      });
      void writeJsonLine(socket, { type: 'registered', role: 'extension' });
      return;
    }

    if (message.role === 'agent') {
      const clientId = message.clientId || randomUUID();
      this.agentSockets.set(clientId, socket);
      socket.__clientId = clientId;
      this.logger.info('agent registered', { clientId });
      void writeJsonLine(socket, {
        type: 'registered',
        role: 'agent',
        clientId,
      });
      return;
    }
  }
  /**
   * @returns {Promise<BridgeDaemon>}
   */
  async start() {
    if (this.authToken === undefined) {
      this.authToken = this.transport.type === 'tcp' ? await ensureBridgeAuthToken() : null;
    }

    if (this.transport.type === 'socket' && !isWindowsNamedPipePath(this.socketPath)) {
      const socketDir = path.dirname(this.socketPath);
      await fs.promises.mkdir(socketDir, { recursive: true });
      if (process.platform !== 'win32') {
        await fs.promises.chmod(socketDir, 0o700);
      }
      try {
        await fs.promises.access(this.socketPath);
        if (await pingExistingDaemon(this.transport)) {
          throw new Error(
            `Another daemon is already running on ${this.socketPath}. Stop it before starting a new one.`
          );
        }
        this.logger.info('Removing stale socket from previous run', {
          socketPath: this.socketPath,
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Another daemon')) {
          throw error;
        }
        // Socket does not exist - normal startup.
      }
      await fs.promises.rm(this.socketPath, { force: true });
    }

    this.server = net.createServer((socket) => {
      const typedSocket = /** @type {ClientSocket} */ (socket);
      typedSocket.on('error', (err) => {
        this.logger.error('socket error', { message: err.message });
      });
      parseJsonLines(
        typedSocket,
        (raw) => {
          const message = /** @type {DaemonMessage} */ (raw);
          void this.handleClientMessage(typedSocket, message).catch((err) => {
            this.logger.error('handler error', {
              message: err instanceof Error ? err.message : String(err),
            });
          });
        },
        {
          onProtocolError: (error) => {
            this.logger.error('socket protocol error', { message: error.message });
          },
        }
      );
      typedSocket.on('close', () => this.handleSocketClose(typedSocket));
    });

    const server = this.server;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      const onListen = () => {
        server.off('error', reject);
        this.serverAddress = server.address();
        resolve(undefined);
      };
      server.listen(this.listenOptions, onListen);
    });

    if (this.transport.type === 'socket' && process.platform !== 'win32') {
      await fs.promises.chmod(this.socketPath, 0o600);
    }

    this.logger.info('Daemon listening', {
      transport: formatBridgeTransport(this.transport),
      socketPath: this.socketPath ?? null,
    });

    this.startedAt = Date.now();

    return this;
  }

  /**
   * @returns {Promise<void>}
   */
  async stop() {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = this.stopInternal();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async stopInternal() {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeoutId);
    }
    this.pendingRequests.clear();
    this.pendingRequestsByOwnerSocket.clear();
    this.pendingRequestsByTargetSocket.clear();

    for (const socket of this.agentSockets.values()) {
      socket.destroy();
    }
    this.agentSockets.clear();

    for (const socket of this.extensionSockets.values()) {
      socket.destroy();
    }
    this.extensionSockets.clear();
    this.invalidateConnectedExtensionsCache();

    if (this.server) {
      const server = this.server;
      this.server = null;
      try {
        await new Promise((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(undefined);
          });
        });
      } finally {
        if (this.transport.type === 'socket' && !isWindowsNamedPipePath(this.socketPath)) {
          await fs.promises.rm(this.socketPath, { force: true });
        }
      }
    }
  }

  /**
   * @param {ClientSocket} socket
   * @param {DaemonMessage} message
   * @returns {Promise<void>}
   */
  async handleClientMessage(socket, message) {
    if (message?.type === 'register') {
      return this.registerSocket(socket, message);
    }

    if (!socket.__role) {
      return this.rejectUnregisteredMessage(socket, message);
    }

    if (message?.type === 'log') {
      if (socket.__role !== 'extension') {
        return this.rejectMessageForRole(socket, message);
      }
      this.pushLog(message.entry ?? {});
      return;
    }

    if (message?.type === 'extension.response') {
      if (socket.__role !== 'extension') {
        return this.rejectMessageForRole(socket, message);
      }
      return this.handleExtensionResponse(socket, message);
    }

    if (message?.type === 'extension.identity') {
      if (socket.__role !== 'extension') {
        return this.rejectMessageForRole(socket, message);
      }
      return this.handleExtensionIdentity(socket, message);
    }

    if (message?.type === 'extension.access_update') {
      if (socket.__role !== 'extension') {
        return this.rejectMessageForRole(socket, message);
      }
      return this.handleExtensionAccessUpdate(socket, message);
    }

    if (message?.type === 'extension.activity') {
      if (socket.__role !== 'extension') {
        return this.rejectMessageForRole(socket, message);
      }
      return this.handleExtensionActivity(socket, message);
    }

    if (message?.type === 'extension.setup_status.request') {
      if (socket.__role !== 'extension') {
        return this.rejectMessageForRole(socket, message);
      }
      return this.handleExtensionSetupStatus(socket, message);
    }

    if (message?.type === 'agent.request') {
      const isExtensionSetupRequest =
        socket.__role === 'extension' && message.request?.method === 'setup.install';
      if (socket.__role !== 'agent' && !isExtensionSetupRequest) {
        return this.rejectMessageForRole(socket, message);
      }
      return this.handleAgentRequest(socket, message);
    }

    await writeJsonLine(socket, {
      type: 'error',
      error: {
        code: ERROR_CODES.INVALID_REQUEST,
        message: 'Unknown message type.',
      },
    });
  }

  /**
   * @param {ClientSocket} socket
   * @param {DaemonMessage} message
   * @returns {Promise<void>}
   */
  async rejectUnregisteredMessage(socket, message) {
    const authRequired = this.isAuthRequired();
    if (message?.type === 'agent.request') {
      const candidate =
        message.request && typeof message.request === 'object'
          ? /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (message.request))
          : {};
      const response = createFailure(
        typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id : 'unauthenticated',
        authRequired ? ERROR_CODES.ACCESS_DENIED : ERROR_CODES.INVALID_REQUEST,
        authRequired
          ? 'Register with the daemon auth token before sending bridge requests.'
          : 'Register the socket before sending bridge requests.',
        null,
        typeof candidate.method === 'string' ? { method: candidate.method } : {}
      );
      await writeJsonLine(socket, { type: 'agent.response', response });
      return;
    }

    await writeJsonLine(socket, {
      type: 'error',
      error: {
        code: authRequired ? ERROR_CODES.ACCESS_DENIED : ERROR_CODES.INVALID_REQUEST,
        message: authRequired
          ? 'Register with the daemon auth token before sending bridge messages.'
          : 'Register the socket before sending bridge messages.',
      },
    });
  }

  /**
   * @param {ClientSocket} socket
   * @param {DaemonMessage} message
   * @returns {Promise<void>}
   */
  async rejectMessageForRole(socket, message) {
    await writeJsonLine(socket, {
      type: 'error',
      error: {
        code: ERROR_CODES.INVALID_REQUEST,
        message: `Message type ${JSON.stringify(message.type ?? null)} is not allowed for ${socket.__role} sockets.`,
      },
    });
  }

  /**
   * @param {ClientSocket} socket
   * @param {DaemonMessage} message
   * @returns {Promise<void>}
   */
  async handleAgentRequest(socket, message) {
    /** @type {BridgeRequest} */
    let request;
    try {
      request = validateBridgeRequest(message.request);
    } catch (error) {
      const candidate =
        message.request && typeof message.request === 'object'
          ? /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (message.request))
          : {};
      const response = createFailure(
        typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id : 'invalid_request',
        ERROR_CODES.INVALID_REQUEST,
        error instanceof Error ? error.message : String(error),
        null,
        typeof candidate.method === 'string' ? { method: candidate.method } : {}
      );
      await writeJsonLine(socket, { type: 'agent.response', response });
      return;
    }

    if (this.pendingRequests.has(request.id)) {
      const response = createFailure(
        request.id,
        ERROR_CODES.INVALID_REQUEST,
        `Request id ${JSON.stringify(request.id)} is already in flight.`
      );
      await writeJsonLine(socket, { type: 'agent.response', response });
      return;
    }

    if (request.method === 'health.ping') {
      if (this.extensionSockets.size === 0) {
        const response = createSuccess(request.id, {
          daemon: 'ok',
          daemonVersion: DAEMON_VERSION,
          extensionConnected: false,
          socketPath: this.socketPath,
          transport: formatBridgeTransport(this.transport),
          proxy: this.getProxyStatusPayload(),
          connectedExtensions: [],
          daemon_supported_versions: getSupportedProtocolVersions(),
          ...getVersionNegotiationPayload(request.meta?.protocol_version),
        });
        await writeJsonLine(socket, { type: 'agent.response', response });
        return;
      }
    }

    if (request.method === 'log.tail') {
      const limit =
        typeof request.params.limit === 'number' ? request.params.limit : DEFAULT_LOG_TAIL_LIMIT;
      const response = createSuccess(request.id, {
        entries: this.recentLog.slice(-limit),
      });
      await writeJsonLine(socket, { type: 'agent.response', response });
      return;
    }

    if (request.method === 'daemon.metrics') {
      const now = Date.now();
      const uptimeMs = this.startedAt > 0 ? now - this.startedAt : 0;
      const avgResponseTimeMs =
        this.requestsProcessed > 0
          ? Math.round(this.totalResponseTimeMs / this.requestsProcessed)
          : 0;
      const response = createSuccess(request.id, {
        uptimeMs,
        activeAgents: this.agentSockets.size,
        activeExtensions: this.extensionSockets.size,
        pendingRequests: this.pendingRequests.size,
        requestsProcessed: this.requestsProcessed,
        requestsFailed: this.requestsFailed,
        avgResponseTimeMs,
      });
      await writeJsonLine(socket, { type: 'agent.response', response });
      return;
    }

    if (request.method === 'setup.get_status') {
      const response = createSuccess(request.id, await this.setupStatusLoader(), {
        method: request.method,
      });
      await writeJsonLine(socket, { type: 'agent.response', response });
      return;
    }

    if (request.method === 'setup.install') {
      if (socket.__role === 'agent' && !this.isLocalSocket(socket)) {
        const response = createFailure(
          request.id,
          ERROR_CODES.ACCESS_DENIED,
          'setup.install is restricted to local Browser Bridge clients.',
          null,
          { method: request.method }
        );
        await writeJsonLine(socket, { type: 'agent.response', response });
        return;
      }
      try {
        const response = createSuccess(
          request.id,
          await this.setupInstaller(request.params ?? {}),
          {
            method: request.method,
          }
        );
        await writeJsonLine(socket, { type: 'agent.response', response });
      } catch (error) {
        const response = createFailure(
          request.id,
          ERROR_CODES.INVALID_REQUEST,
          error instanceof Error ? error.message : String(error),
          null,
          { method: request.method }
        );
        await writeJsonLine(socket, { type: 'agent.response', response });
      }
      return;
    }

    const targetBrowser =
      typeof request.meta?.target_browser === 'string' ? request.meta.target_browser : null;
    const targetProfile =
      typeof request.meta?.target_profile === 'string' ? request.meta.target_profile : null;
    const hasExplicitTarget = Boolean(targetBrowser || targetProfile);

    const target = this.selectExtensionTarget(targetBrowser, targetProfile);

    if (!target) {
      const response = createFailure(
        request.id,
        ERROR_CODES.EXTENSION_DISCONNECTED,
        hasExplicitTarget
          ? `No connected extension matches target_browser="${targetBrowser ?? '*'}" target_profile="${targetProfile ?? '*'}".`
          : 'The Chrome extension is not connected to the local bridge daemon.'
      );
      await writeJsonLine(socket, { type: 'agent.response', response });
      return;
    }

    this.trackPendingRequest(request.id, {
      socket,
      method: request.method,
      protocolVersion: request.meta?.protocol_version,
      source: typeof request.meta?.source === 'string' ? request.meta.source : '',
      targets: new Set([target]),
      timeoutId: setTimeout(() => {
        const pending = this.pendingRequests.get(request.id);
        if (!pending) return;
        this.clearPendingRequest(request.id, pending);
        this.recordRequestCompletion(request.id, false);
        const response = createFailure(
          request.id,
          ERROR_CODES.TIMEOUT,
          'Extension did not respond in time.'
        );
        void writeJsonLine(pending.socket, {
          type: 'agent.response',
          response,
        }).catch((error) => {
          this.logger.error('timeout response write failed', {
            requestId: request.id,
            method: pending.method,
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }, this.getPendingTimeoutMs(request)),
    });
    this.logger.info('request routed', {
      requestId: request.id,
      method: request.method,
      clientId: socket.__clientId ?? null,
      targetCount: 1,
    });
    try {
      await writeJsonLine(target, { type: 'extension.request', request });
    } catch (error) {
      this.logger.error('request route failed', {
        requestId: request.id,
        method: request.method,
        message: error instanceof Error ? error.message : String(error),
      });
      const pending = this.pendingRequests.get(request.id);
      if (!pending) {
        return;
      }
      this.removePendingTarget(request.id, pending, target);
      if (target.__extensionId && this.extensionSockets.get(target.__extensionId) === target) {
        this.extensionSockets.delete(target.__extensionId);
        this.invalidateConnectedExtensionsCache();
      }
      target.destroy(error instanceof Error ? error : undefined);
      await this.finishPendingRequestIfExhausted(request.id, pending);
    }
  }

  /**
   * @param {ClientSocket} socket
   * @returns {boolean}
   */
  isLocalSocket(socket) {
    if (this.transport.type === 'socket') {
      return true;
    }
    const address = socket.remoteAddress ?? '';
    return (
      address === '127.0.0.1' ||
      address === '::1' ||
      address === 'localhost' ||
      address === '::ffff:127.0.0.1'
    );
  }

  /**
   * Select from a snapshot so routing neither mutates nor observes mutations to
   * the live extension map while candidates are ordered.
   *
   * @param {string | null} targetBrowser
   * @param {string | null} targetProfile
   * @returns {ClientSocket | null}
   */
  selectExtensionTarget(targetBrowser, targetProfile) {
    const candidates = Array.from(this.extensionSockets.entries()).filter(([, extSocket]) => {
      return (
        (!targetBrowser || extSocket.__browserName === targetBrowser) &&
        (!targetProfile || extSocket.__profileLabel === targetProfile)
      );
    });
    candidates.sort(([leftId, left], [rightId, right]) => {
      const accessDelta =
        Number(Boolean(right.__accessEnabled)) - Number(Boolean(left.__accessEnabled));
      if (accessDelta !== 0) {
        return accessDelta;
      }
      const activityDelta =
        (typeof right.__lastActiveAt === 'number' ? right.__lastActiveAt : 0) -
        (typeof left.__lastActiveAt === 'number' ? left.__lastActiveAt : 0);
      if (activityDelta !== 0) {
        return activityDelta;
      }
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
    return candidates[0]?.[1] ?? null;
  }

  /**
   * @param {BridgeRequest} request
   * @returns {number}
   */
  getPendingTimeoutMs(request) {
    const configuredBase = Math.min(
      MAX_DAEMON_PENDING_TIMEOUT_MS,
      Math.max(1, this.pendingTimeoutMs)
    );
    const operationTimeout = request.params.timeoutMs;
    if (typeof operationTimeout !== 'number' || !Number.isFinite(operationTimeout)) {
      return configuredBase;
    }
    return Math.min(
      MAX_DAEMON_PENDING_TIMEOUT_MS,
      Math.max(configuredBase, operationTimeout + DAEMON_PENDING_TIMEOUT_MARGIN_MS)
    );
  }

  /**
   * @param {ClientSocket} socket
   * @param {DaemonMessage} message
   * @returns {Promise<void>}
   */
  async handleExtensionSetupStatus(socket, message) {
    try {
      await writeJsonLine(socket, {
        type: 'extension.setup_status.response',
        requestId: message.requestId,
        status: await this.setupStatusLoader(),
      });
    } catch (error) {
      await writeJsonLine(socket, {
        type: 'extension.setup_status.error',
        requestId: message.requestId,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /**
   * @param {ClientSocket} socket
   * @param {DaemonMessage} message
   * @returns {void}
   */
  handleExtensionIdentity(socket, message) {
    let changed = false;
    if (typeof message.browserName === 'string') {
      changed = changed || socket.__browserName !== message.browserName;
      socket.__browserName = message.browserName;
    }
    if (typeof message.profileLabel === 'string') {
      changed = changed || socket.__profileLabel !== message.profileLabel;
      socket.__profileLabel = message.profileLabel;
    }
    if (changed) {
      this.invalidateConnectedExtensionsCache();
    }
  }

  /**
   * @param {ClientSocket} socket
   * @param {DaemonMessage} message
   * @returns {void}
   */
  handleExtensionAccessUpdate(socket, message) {
    const accessEnabled = Boolean(message.accessEnabled);
    if (socket.__accessEnabled !== accessEnabled) {
      socket.__accessEnabled = accessEnabled;
      this.invalidateConnectedExtensionsCache();
      return;
    }
    socket.__accessEnabled = accessEnabled;
  }

  /**
   * Structured remote-exposure status for health payloads. The proxy counts
   * as enabled only when the daemon listens on a TCP address other than
   * loopback, i.e. agents on other machines can reach it.
   *
   * @returns {{ enabled: boolean, endpoint: string | null }}
   */
  getProxyStatusPayload() {
    if (this.transport.type !== 'tcp') {
      return { enabled: false, endpoint: null };
    }
    const bindHost = this.transport.bindHost ?? this.transport.host;
    const isLoopback = bindHost === '127.0.0.1' || bindHost === '::1' || bindHost === 'localhost';
    return isLoopback
      ? { enabled: false, endpoint: null }
      : { enabled: true, endpoint: `${bindHost}:${this.transport.port}` };
  }

  /**
   * @param {ClientSocket} socket
   * @param {DaemonMessage} message
   * @returns {void}
   */
  handleExtensionActivity(socket, message) {
    socket.__lastActiveAt =
      typeof message.at === 'number' && Number.isFinite(message.at) ? message.at : Date.now();
  }

  /**
   * @param {ClientSocket} socket
   * @param {DaemonMessage} message
   * @returns {Promise<void>}
   */
  async handleExtensionResponse(socket, message) {
    const responseMessage = message.response;
    if (!responseMessage) {
      return;
    }

    const pending = this.pendingRequests.get(responseMessage.id);
    if (!pending || !pending.targets.has(socket)) {
      return;
    }

    this.removePendingTarget(responseMessage.id, pending, socket);

    if (responseMessage.ok) {
      this.clearPendingRequest(responseMessage.id, pending);
      this.recordRequestCompletion(responseMessage.id, true);
      this.pushLog({
        at: new Date().toISOString(),
        method: responseMessage.meta?.method ?? null,
        ok: true,
        id: responseMessage.id,
        source: pending.source || null,
      });
      const response =
        pending.method === 'health.ping'
          ? createSuccess(
              responseMessage.id,
              {
                daemon: 'ok',
                extensionConnected: true,
                socketPath: this.socketPath,
                transport: formatBridgeTransport(this.transport),
                connectedExtensions: this.getConnectedExtensionsSnapshot(),
                ...getVersionNegotiationPayload(pending.protocolVersion),
                .../** @type {Record<string, unknown>} */ (responseMessage.result),
                daemonVersion: DAEMON_VERSION,
                daemon_supported_versions: getSupportedProtocolVersions(),
                proxy: this.getProxyStatusPayload(),
              },
              {
                ...responseMessage.meta,
                method: responseMessage.meta?.method ?? pending.method,
              }
            )
          : responseMessage;

      await writeJsonLine(pending.socket, {
        type: 'agent.response',
        response,
      });
      return;
    }

    // A routed request has one target, so its error is final.
    pending.lastErrorResponse = responseMessage;

    await this.finishPendingRequestIfExhausted(responseMessage.id, pending);
  }

  /**
   * @param {ClientSocket} socket
   * @returns {void}
   */
  handleSocketClose(socket) {
    if (socket.__extensionId) {
      this.logger.info('extension disconnected', { extensionId: socket.__extensionId });
      if (this.extensionSockets.get(socket.__extensionId) === socket) {
        this.extensionSockets.delete(socket.__extensionId);
        this.invalidateConnectedExtensionsCache();
      }
    }

    if (socket.__clientId) {
      this.logger.info('agent disconnected', { clientId: socket.__clientId });
      if (this.agentSockets.get(socket.__clientId) === socket) {
        this.agentSockets.delete(socket.__clientId);
      }
    }

    const ownedRequestIds = this.pendingRequestsByOwnerSocket.get(socket);
    if (ownedRequestIds) {
      for (const id of ownedRequestIds) {
        const pending = this.pendingRequests.get(id);
        if (!pending) {
          continue;
        }
        this.clearPendingRequest(id, pending);
        this.recordRequestCompletion(id, false);
      }
    }

    const targetRequestIds = this.pendingRequestsByTargetSocket.get(socket);
    if (targetRequestIds) {
      for (const id of targetRequestIds) {
        const pending = this.pendingRequests.get(id);
        if (!pending) {
          continue;
        }
        this.removePendingTarget(id, pending, socket);
        void this.finishPendingRequestIfExhausted(id, pending).catch((error) => {
          this.logger.error('pending exhaustion response failed', {
            requestId: id,
            method: pending.method,
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
  }

  /**
   * Complete a pending request once every targeted extension has either
   * responded or disconnected.
   *
   * @param {string} requestId
   * @param {PendingEntry} pending
   * @returns {Promise<void>}
   */
  async finishPendingRequestIfExhausted(requestId, pending) {
    if (pending.targets.size > 0 || !this.pendingRequests.has(requestId)) {
      return;
    }

    this.clearPendingRequest(requestId, pending);
    this.recordRequestCompletion(requestId, false);

    const response =
      pending.lastErrorResponse ??
      createFailure(
        requestId,
        ERROR_CODES.EXTENSION_DISCONNECTED,
        'Target extension disconnected before responding.',
        null,
        { method: pending.method }
      );

    this.pushLog({
      at: new Date().toISOString(),
      method: response.meta?.method ?? pending.method ?? null,
      ok: false,
      id: requestId,
      source: pending.source || null,
    });

    await writeJsonLine(pending.socket, {
      type: 'agent.response',
      response,
    });
  }

  /**
   * @param {string} requestId
   * @param {boolean} ok
   * @returns {void}
   */
  recordRequestCompletion(requestId, ok) {
    const startedAt = this.requestStartTimes.get(requestId);
    this.requestStartTimes.delete(requestId);
    this.requestsProcessed += 1;
    if (!ok) {
      this.requestsFailed += 1;
    }
    if (typeof startedAt === 'number') {
      this.totalResponseTimeMs += Date.now() - startedAt;
    }
  }

  /**
   * @param {Record<string, unknown>} entry
   * @returns {void}
   */
  pushLog(entry) {
    this.recentLog.push(entry);
    if (this.recentLog.length > DAEMON_RECENT_LOG_LIMIT) {
      this.recentLog.shift();
    }
  }
}

/**
 * Check whether a daemon is already listening on the given transport.
 * Connects, sends a health.ping, and waits up to 500 ms for a response.
 *
 * @param {BridgeTransport | string} transport
 * @returns {Promise<boolean>}
 */
export async function pingExistingDaemon(transport) {
  const resolvedTransport =
    typeof transport === 'string' ? createSocketBridgeTransport(transport) : transport;
  const authToken = resolvedTransport.type === 'tcp' ? await readBridgeAuthToken() : null;
  return new Promise((resolve) => {
    let settled = false;
    /** @param {boolean} value */
    function finish(value) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(value);
    }

    const timeout = setTimeout(() => {
      finish(false);
    }, DAEMON_EXISTING_SOCKET_PING_TIMEOUT_MS);

    const socket =
      resolvedTransport.type === 'tcp'
        ? net.createConnection({ host: resolvedTransport.host, port: resolvedTransport.port })
        : net.createConnection(resolvedTransport.socketPath);
    socket.once('error', () => {
      finish(false);
    });

    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      while (buf.includes('\n')) {
        const index = buf.indexOf('\n');
        const line = buf.slice(0, index).trim();
        buf = buf.slice(index + 1);
        if (!line) {
          continue;
        }
        try {
          const msg = JSON.parse(line);
          if (msg?.type === 'agent.response') {
            finish(msg?.response?.result?.daemon === 'ok');
          }
        } catch {
          finish(false);
        }
      }
    });

    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({
          type: 'register',
          role: 'agent',
          clientId: 'ping_probe',
          ...(authToken ? { authToken } : {}),
        })}\n`
      );
      socket.write(
        `${JSON.stringify({
          type: 'agent.request',
          request: {
            id: 'ping_probe',
            method: 'health.ping',
            tab_id: null,
            params: {},
            meta: { protocol_version: getProtocolVersion(), token_budget: null },
          },
        })}\n`
      );
    });
  });
}

/**
 * @param {Record<string, unknown>} params
 * @returns {SetupInstallParams & { action: 'install' | 'uninstall', kind: 'mcp' | 'skill', target: string }}
 */
export function normalizeSetupInstallParams(params) {
  const action = params.action == null ? 'install' : params.action;
  if (action !== 'install' && action !== 'uninstall') {
    throw new Error('setup.install action must be "install" or "uninstall".');
  }
  const kind = params.kind === 'mcp' || params.kind === 'skill' ? params.kind : null;
  const target = typeof params.target === 'string' ? params.target.trim().toLowerCase() : '';
  if (!kind) {
    throw new Error('setup.install requires kind to be "mcp" or "skill".');
  }
  if (!target) {
    throw new Error('setup.install requires a target.');
  }
  return { action: /** @type {'install' | 'uninstall'} */ (action), kind, target };
}

/**
 * @param {Record<string, unknown>} params
 * @param {SetupInstallDeps} [deps]
 * @returns {Promise<SetupInstallResult>}
 */
export async function installSetupTarget(
  params,
  deps = {
    installAgentFiles,
    isSupportedTarget,
    removeAgentFiles,
    installMcpConfig,
    isMcpClientName,
    removeMcpConfig,
    cwd: process.cwd(),
  }
) {
  /** @type {SetupInstallDeps} */
  const resolvedDeps = deps;
  const normalized = normalizeSetupInstallParams(params);
  if (normalized.kind === 'mcp') {
    if (!resolvedDeps.isMcpClientName(normalized.target)) {
      throw new Error(`Unsupported MCP client "${normalized.target}".`);
    }
    const paths =
      normalized.action === 'uninstall'
        ? await resolvedDeps.removeMcpConfig(normalized.target, {
            global: true,
          })
        : [
            await resolvedDeps.installMcpConfig(normalized.target, {
              global: true,
            }),
          ];
    return {
      action: normalized.action,
      kind: 'mcp',
      target: normalized.target,
      paths,
    };
  }

  if (!resolvedDeps.isSupportedTarget(normalized.target)) {
    throw new Error(`Unsupported skill target "${normalized.target}".`);
  }

  const paths =
    normalized.action === 'uninstall'
      ? await resolvedDeps.removeAgentFiles({
          targets: [normalized.target],
          projectPath: resolvedDeps.cwd,
          global: true,
        })
      : await resolvedDeps.installAgentFiles({
          targets: [normalized.target],
          projectPath: resolvedDeps.cwd,
          global: true,
        });
  return {
    action: normalized.action,
    kind: 'skill',
    target: normalized.target,
    paths,
  };
}
