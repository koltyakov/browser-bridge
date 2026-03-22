// @ts-check

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createFailure, createSuccess, ERROR_CODES, validateBridgeRequest } from '../../protocol/src/index.js';
import { getBridgeDir, getSocketPath } from './config.js';
import { writeJsonLine } from './framing.js';

/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('node:net').Socket & { __clientId?: string }} ClientSocket */
/** @typedef {{ socket: ClientSocket, timeoutId: NodeJS.Timeout }} PendingEntry */

/**
 * @typedef {{
 *   type?: string,
 *   role?: string,
 *   clientId?: string,
 *   entry?: Record<string, unknown>,
 *   request?: BridgeRequest,
 *   response?: import('../../protocol/src/types.js').BridgeResponse
 * }} DaemonMessage
 */

/**
 * @param {ClientSocket} socket
 * @param {(message: DaemonMessage) => void} onMessage
 * @returns {void}
 */
function parseJsonLines(socket, onMessage) {
  let buffer = '';
  socket.setEncoding('utf8');
  /** @param {string} chunk */
  socket.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) {
        continue;
      }
      onMessage(JSON.parse(line));
    }
  });
}

export class BridgeDaemon {
  /**
   * @param {{
   *   socketPath?: string,
   *   listenOptions?: import('node:net').ListenOptions | null,
   *   logger?: Pick<Console, 'log' | 'error'>
   * }} [options={}]
   */
  constructor({ socketPath = getSocketPath(), listenOptions = null, logger = console } = {}) {
    this.socketPath = socketPath;
    this.listenOptions = listenOptions;
    this.logger = logger;
    this.server = null;
    this.serverAddress = null;
    this.extensionSocket = null;
    this.agentSockets = new Map();
    /** @type {Map<string, PendingEntry>} */
    this.pendingRequests = new Map();
    this.pendingTimeoutMs = 30_000;
    this.recentLog = [];
    this.stopPromise = null;
  }

  /**
   * @returns {Promise<BridgeDaemon>}
   */
  async start() {
    if (!this.listenOptions) {
      await fs.promises.mkdir(path.dirname(this.socketPath), { recursive: true });
      try {
        await fs.promises.access(this.socketPath);
        this.logger.log('[daemon] Removing stale socket from previous run:', this.socketPath);
      } catch {
        // Socket does not exist - normal startup.
      }
      await fs.promises.rm(this.socketPath, { force: true });
    }

    this.server = net.createServer((socket) => {
      const typedSocket = /** @type {ClientSocket} */ (socket);
      parseJsonLines(typedSocket, (message) => {
        void this.handleClientMessage(typedSocket, message);
      });
      typedSocket.on('close', () => this.handleSocketClose(typedSocket));
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      const onListen = () => {
        this.server.off('error', reject);
        this.serverAddress = this.server.address();
        resolve();
      };
      if (this.listenOptions) {
        this.server.listen(this.listenOptions, onListen);
      } else {
        this.server.listen(this.socketPath, onListen);
      }
    });

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

    if (this.extensionSocket) {
      this.extensionSocket.destroy();
      this.extensionSocket = null;
    }

    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    if (!this.listenOptions) {
      await fs.promises.rm(this.socketPath, { force: true });
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
      this.pushLog(message.entry);
      return;
    }

    if (message?.type === 'extension.response') {
      return this.handleExtensionResponse(message);
    }

    if (message?.type === 'agent.request') {
      return this.handleAgentRequest(socket, message);
    }

    await writeJsonLine(socket, {
      type: 'error',
      error: { code: ERROR_CODES.INVALID_REQUEST, message: 'Unknown message type.' }
    });
  }

  /**
   * @param {ClientSocket} socket
   * @param {DaemonMessage} message
   * @returns {void}
   */
  registerSocket(socket, message) {
    if (message.role === 'extension') {
      this.extensionSocket = socket;
      void writeJsonLine(socket, { type: 'registered', role: 'extension' });
      return;
    }

    if (message.role === 'agent') {
      const clientId = message.clientId || randomUUID();
      this.agentSockets.set(clientId, socket);
      socket.__clientId = clientId;
      void writeJsonLine(socket, { type: 'registered', role: 'agent', clientId });
      return;
    }
  }

  /**
   * @param {ClientSocket} socket
   * @param {DaemonMessage} message
   * @returns {Promise<void>}
   */
  async handleAgentRequest(socket, message) {
    const request = validateBridgeRequest(message.request);
    if (request.method === 'health.ping') {
      const response = createSuccess(request.id, {
        daemon: 'ok',
        extensionConnected: Boolean(this.extensionSocket),
        socketPath: this.socketPath
      });
      await writeJsonLine(socket, { type: 'agent.response', response });
      return;
    }

    if (request.method === 'log.tail') {
      const response = createSuccess(request.id, {
        entries: this.recentLog.slice(-20)
      });
      await writeJsonLine(socket, { type: 'agent.response', response });
      return;
    }

    if (!this.extensionSocket) {
      const response = createFailure(
        request.id,
        ERROR_CODES.NATIVE_HOST_UNAVAILABLE,
        'The Chrome extension is not connected to the local bridge daemon.'
      );
      await writeJsonLine(socket, { type: 'agent.response', response });
      return;
    }

    this.pendingRequests.set(request.id, {
      socket,
      timeoutId: setTimeout(() => {
        const pending = this.pendingRequests.get(request.id);
        if (!pending) return;
        this.pendingRequests.delete(request.id);
        const response = createFailure(request.id, ERROR_CODES.TIMEOUT, 'Extension did not respond in time.');
        void writeJsonLine(pending.socket, { type: 'agent.response', response });
      }, this.pendingTimeoutMs)
    });
    await writeJsonLine(this.extensionSocket, {
      type: 'extension.request',
      request
    });
  }

  /**
   * @param {DaemonMessage} message
   * @returns {Promise<void>}
   */
  async handleExtensionResponse(message) {
    const pending = this.pendingRequests.get(message.response?.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(message.response.id);
    this.pushLog({
      at: new Date().toISOString(),
      method: message.response.meta?.method ?? null,
      ok: message.response.ok,
      id: message.response.id
    });
    await writeJsonLine(pending.socket, {
      type: 'agent.response',
      response: message.response
    });
  }

  /**
   * @param {ClientSocket} socket
   * @returns {void}
   */
  handleSocketClose(socket) {
    if (socket === this.extensionSocket) {
      this.extensionSocket = null;
    }

    if (socket.__clientId) {
      this.agentSockets.delete(socket.__clientId);
    }

    for (const [id, pending] of this.pendingRequests.entries()) {
      if (pending.socket === socket) {
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(id);
      }
    }
  }

  /**
   * @param {Record<string, unknown>} entry
   * @returns {void}
   */
  pushLog(entry) {
    this.recentLog.push(entry);
    if (this.recentLog.length > 200) {
      this.recentLog.shift();
    }
  }
}
