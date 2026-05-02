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
  DAEMON_RECENT_LOG_LIMIT,
  DEFAULT_DAEMON_PENDING_TIMEOUT_MS,
  DEFAULT_LOG_TAIL_LIMIT,
  ERROR_CODES,
  parseJsonLines,
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
  validateBridgeRequest,
} from '../../protocol/src/index.js';
import { getSocketPath } from './config.js';
import { writeJsonLine } from './framing.js';

/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../../protocol/src/types.js').SetupInstallParams} SetupInstallParams */
/** @typedef {import('../../protocol/src/types.js').SetupInstallResult} SetupInstallResult */
/** @typedef {import('../../protocol/src/types.js').SetupStatus} SetupStatus */
/** @typedef {import('node:net').Socket & { __clientId?: string, __extensionId?: string, __browserName?: string, __profileLabel?: string, __accessEnabled?: boolean, __lastActiveAt?: number }} ClientSocket */
/** @typedef {{ socket: ClientSocket, timeoutId: NodeJS.Timeout, source?: string, method?: string, targets: Set<ClientSocket>, lastErrorResponse?: import('../../protocol/src/types.js').BridgeResponse }} PendingEntry */
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
  const latestSupported = SUPPORTED_VERSIONS[0];
  if (!requestedVersion || !latestSupported || SUPPORTED_VERSIONS.includes(requestedVersion)) {
    return { supported_versions: SUPPORTED_VERSIONS };
  }

  const localIsNewer = compareProtocolVersions(latestSupported, requestedVersion) > 0;
  return {
    supported_versions: SUPPORTED_VERSIONS,
    ...(localIsNewer ? { deprecated_since: latestSupported } : {}),
    migration_hint: localIsNewer
      ? `Browser Bridge daemon is newer than the client protocol ${requestedVersion}. Restart or update the Browser Bridge CLI/npm package to ${latestSupported} or later.`
      : `Browser Bridge daemon is older than the client protocol ${requestedVersion}. Restart or update the Browser Bridge CLI so the daemon supports ${requestedVersion}.`,
  };
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
 *   at?: number
 * }} DaemonMessage
 */

export class BridgeDaemon {
  /**
   * @param {{
   *   socketPath?: string,
   *   listenOptions?: import('node:net').ListenOptions | null,
   *   setupStatusLoader?: () => Promise<SetupStatus>,
   *   setupInstaller?: (params: Record<string, unknown>) => Promise<SetupInstallResult>,
   *   logger?: Pick<Console, 'log' | 'error'>
   * }} [options={}]
   */
  constructor({
    socketPath = getSocketPath(),
    listenOptions = null,
    setupStatusLoader = collectSetupStatus,
    setupInstaller = installSetupTarget,
    logger = console,
  } = {}) {
    this.socketPath = socketPath;
    this.listenOptions = listenOptions;
    this.setupStatusLoader = setupStatusLoader;
    this.setupInstaller = setupInstaller;
    this.logger = logger;
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
    this.pendingTimeoutMs = DEFAULT_DAEMON_PENDING_TIMEOUT_MS;
    /** @type {Record<string, unknown>[]} */
    this.recentLog = [];
    /** @type {Promise<void> | null} */
    this.stopPromise = null;
  }

  /**
   * @param {ClientSocket} socket
   * @param {DaemonMessage} message
   * @returns {void}
   */
  registerSocket(socket, message) {
    if (message.role === 'extension') {
      const extensionId = randomUUID();
      socket.__extensionId = extensionId;
      socket.__browserName =
        typeof message.browserName === 'string' ? message.browserName : undefined;
      socket.__profileLabel =
        typeof message.profileLabel === 'string' ? message.profileLabel : undefined;
      socket.__lastActiveAt = Date.now();
      this.extensionSockets.set(extensionId, socket);
      void writeJsonLine(socket, { type: 'registered', role: 'extension' });
      return;
    }

    if (message.role === 'agent') {
      const clientId = message.clientId || randomUUID();
      this.agentSockets.set(clientId, socket);
      socket.__clientId = clientId;
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
    const isNamedPipe =
      typeof this.socketPath === 'string' && this.socketPath.startsWith('\\\\.\\pipe\\');
    if (!this.listenOptions && !isNamedPipe) {
      const socketDir = path.dirname(this.socketPath);
      await fs.promises.mkdir(socketDir, { recursive: true });
      if (process.platform !== 'win32') {
        await fs.promises.chmod(socketDir, 0o700);
      }
      try {
        await fs.promises.access(this.socketPath);
        if (await pingExistingDaemon(this.socketPath)) {
          throw new Error(
            `Another daemon is already running on ${this.socketPath}. Stop it before starting a new one.`
          );
        }
        this.logger.log('[daemon] Removing stale socket from previous run:', this.socketPath);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Another daemon')) {
          throw error;
        }
        // Socket does not exist - normal startup.
      }
      await fs.promises.rm(this.socketPath, { force: true });
    } else if (!this.listenOptions && isNamedPipe) {
      // Named Pipe paths (\\.\pipe\name) are not filesystem entries, so
      // mkdir / access / rm are not applicable. Probe for an existing
      // daemon by trying to connect; listen() will also surface
      // EADDRINUSE if a server is already bound.
      if (await pingExistingDaemon(this.socketPath)) {
        throw new Error(
          `Another daemon is already running on ${this.socketPath}. Stop it before starting a new one.`
        );
      }
    }

    this.server = net.createServer((socket) => {
      const typedSocket = /** @type {ClientSocket} */ (socket);
      typedSocket.on('error', (err) => {
        this.logger.error?.('[daemon] socket error:', err.message);
      });
      parseJsonLines(typedSocket, (raw) => {
        const message = /** @type {DaemonMessage} */ (raw);
        void this.handleClientMessage(typedSocket, message).catch((err) => {
          this.logger.error?.(
            '[daemon] handler error:',
            err instanceof Error ? err.message : String(err)
          );
        });
      });
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
      if (this.listenOptions) {
        server.listen(this.listenOptions, onListen);
      } else {
        server.listen(this.socketPath, onListen);
      }
    });

    if (!this.listenOptions && process.platform !== 'win32') {
      await fs.promises.chmod(this.socketPath, 0o600);
    }

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

    for (const socket of this.agentSockets.values()) {
      socket.destroy();
    }
    this.agentSockets.clear();

    for (const socket of this.extensionSockets.values()) {
      socket.destroy();
    }
    this.extensionSockets.clear();

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
        if (!this.listenOptions) {
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

    if (message?.type === 'log') {
      this.pushLog(message.entry ?? {});
      return;
    }

    if (message?.type === 'extension.response') {
      return this.handleExtensionResponse(socket, message);
    }

    if (message?.type === 'extension.identity') {
      return this.handleExtensionIdentity(socket, message);
    }

    if (message?.type === 'extension.access_update') {
      return this.handleExtensionAccessUpdate(socket, message);
    }

    if (message?.type === 'extension.activity') {
      return this.handleExtensionActivity(socket, message);
    }

    if (message?.type === 'extension.setup_status.request') {
      return this.handleExtensionSetupStatus(socket, message);
    }

    if (message?.type === 'agent.request') {
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
  async handleAgentRequest(socket, message) {
    const request = validateBridgeRequest(message.request);
    if (request.method === 'health.ping') {
      if (this.extensionSockets.size === 0) {
        const response = createSuccess(request.id, {
          daemon: 'ok',
          extensionConnected: false,
          socketPath: this.socketPath,
          connectedExtensions: [],
          ...getVersionNegotiationPayload(request.meta?.protocol_version),
        });
        await writeJsonLine(socket, { type: 'agent.response', response });
        return;
      }
    }

    if (request.method === 'log.tail') {
      const response = createSuccess(request.id, {
        entries: this.recentLog.slice(-DEFAULT_LOG_TAIL_LIMIT),
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

    let targets = Array.from(this.extensionSockets.values());
    if (targetBrowser || targetProfile) {
      targets = targets.filter((extSocket) => {
        if (targetBrowser && extSocket.__browserName !== targetBrowser) return false;
        if (targetProfile && extSocket.__profileLabel !== targetProfile) return false;
        return true;
      });
    } else {
      const enabled = targets.filter((extSocket) => extSocket.__accessEnabled);
      if (enabled.length > 0) {
        targets = enabled;
      } else {
        const mostRecent = selectMostRecentlyActiveExtension(targets);
        if (mostRecent) {
          targets = [mostRecent];
        }
      }
    }

    if (targets.length === 0) {
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

    this.pendingRequests.set(request.id, {
      socket,
      method: request.method,
      source: typeof request.meta?.source === 'string' ? request.meta.source : '',
      targets: new Set(targets),
      timeoutId: setTimeout(() => {
        const pending = this.pendingRequests.get(request.id);
        if (!pending) return;
        this.pendingRequests.delete(request.id);
        const response = createFailure(
          request.id,
          ERROR_CODES.TIMEOUT,
          'Extension did not respond in time.'
        );
        void writeJsonLine(pending.socket, {
          type: 'agent.response',
          response,
        });
      }, this.pendingTimeoutMs),
    });
    const broadcastPayload = { type: 'extension.request', request };
    await Promise.all(targets.map((extSocket) => writeJsonLine(extSocket, broadcastPayload)));
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
    if (typeof message.browserName === 'string') {
      socket.__browserName = message.browserName;
    }
    if (typeof message.profileLabel === 'string') {
      socket.__profileLabel = message.profileLabel;
    }
  }

  /**
   * @param {ClientSocket} socket
   * @param {DaemonMessage} message
   * @returns {void}
   */
  handleExtensionAccessUpdate(socket, message) {
    socket.__accessEnabled = Boolean(message.accessEnabled);
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
    if (!pending) {
      return;
    }

    pending.targets.delete(socket);

    if (responseMessage.ok) {
      clearTimeout(pending.timeoutId);
      this.pendingRequests.delete(responseMessage.id);
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
                connectedExtensions: Array.from(this.extensionSockets.entries()).map(
                  ([_id, extSocket]) => ({
                    extensionId: _id,
                    browserName: extSocket.__browserName ?? null,
                    profileLabel: extSocket.__profileLabel ?? null,
                    accessEnabled: extSocket.__accessEnabled ?? false,
                  })
                ),
                .../** @type {Record<string, unknown>} */ (responseMessage.result),
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

    // Error response — wait for other extensions before forwarding.
    pending.lastErrorResponse = responseMessage;

    await this.finishPendingRequestIfExhausted(responseMessage.id, pending);
  }

  /**
   * @param {ClientSocket} socket
   * @returns {void}
   */
  handleSocketClose(socket) {
    if (socket.__extensionId) {
      this.extensionSockets.delete(socket.__extensionId);
    }

    if (socket.__clientId) {
      this.agentSockets.delete(socket.__clientId);
    }

    for (const [id, pending] of this.pendingRequests.entries()) {
      if (pending.socket === socket) {
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(id);
        continue;
      }
      if (pending.targets.has(socket)) {
        pending.targets.delete(socket);
        void this.finishPendingRequestIfExhausted(id, pending);
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

    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(requestId);

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
 * @param {ClientSocket[]} sockets
 * @returns {ClientSocket | null}
 */
function selectMostRecentlyActiveExtension(sockets) {
  if (sockets.length === 0) {
    return null;
  }

  return sockets.reduce((best, current) => {
    const bestAt = typeof best.__lastActiveAt === 'number' ? best.__lastActiveAt : 0;
    const currentAt = typeof current.__lastActiveAt === 'number' ? current.__lastActiveAt : 0;
    return currentAt > bestAt ? current : best;
  });
}

/**
 * Check whether a daemon is already listening on the given socket path.
 * Connects, sends a health.ping, and waits up to 500 ms for a response.
 *
 * @param {string} socketPath
 * @returns {Promise<boolean>}
 */
async function pingExistingDaemon(socketPath) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, DAEMON_EXISTING_SOCKET_PING_TIMEOUT_MS);

    const socket = net.createConnection(socketPath);
    socket.once('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });

    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      if (buf.includes('\n')) {
        clearTimeout(timeout);
        socket.destroy();
        try {
          const msg = JSON.parse(buf.slice(0, buf.indexOf('\n')).trim());
          resolve(msg?.response?.result?.daemon === 'ok');
        } catch {
          resolve(false);
        }
      }
    });

    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({
          type: 'agent.request',
          request: {
            id: 'ping_probe',
            method: 'health.ping',
            tab_id: null,
            params: {},
            meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
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
  const action = params.action === 'uninstall' ? 'uninstall' : 'install';
  const kind = params.kind === 'mcp' || params.kind === 'skill' ? params.kind : null;
  const target = typeof params.target === 'string' ? params.target.trim().toLowerCase() : '';
  if (!kind) {
    throw new Error('setup.install requires kind to be "mcp" or "skill".');
  }
  if (!target) {
    throw new Error('setup.install requires a target.');
  }
  return { action, kind, target };
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
