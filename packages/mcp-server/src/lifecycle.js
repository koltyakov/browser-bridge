// @ts-check

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { getBridgeDir } from '../../native-host/src/config.js';

const MCP_CONTROL_PROTOCOL_VERSION = 1;
const MCP_CONTROL_TIMEOUT_MS = 1_000;
const MCP_REGISTRY_DIRNAME = 'mcp-processes';

/**
 * @typedef {{
 *   protocolVersion: number,
 *   instanceId: string,
 *   pid: number,
 *   port: number,
 *   token: string,
 * }} McpProcessRegistration
 */

/**
 * @typedef {{
 *   registryDir?: string,
 *   onRestart?: () => void,
 * }} StartMcpProcessControlOptions
 */

/**
 * @typedef {{
 *   registryDir?: string,
 *   timeoutMs?: number,
 * }} RestartMcpProcessesOptions
 */

/**
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function getMcpProcessRegistryDir(env = process.env) {
  return path.join(getBridgeDir(env), MCP_REGISTRY_DIRNAME);
}

/**
 * Register a private localhost control endpoint for this MCP process. The
 * endpoint lets `bbx restart` retire the loaded MCP code without relying on a
 * stale PID that may have been reused by an unrelated process.
 *
 * @param {StartMcpProcessControlOptions} [options={}]
 * @returns {Promise<{ registrationPath: string, dispose: () => Promise<void> }>}
 */
export async function startMcpProcessControl(options = {}) {
  const { registryDir = getMcpProcessRegistryDir(), onRestart = () => process.exit(0) } = options;
  const instanceId = randomUUID();
  const token = randomUUID();
  const registrationPath = path.join(registryDir, `${instanceId}.json`);
  let restartRequested = false;
  let disposed = false;

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.setTimeout(MCP_CONTROL_TIMEOUT_MS, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    let input = '';
    let handled = false;

    socket.on('data', (chunk) => {
      if (handled) {
        return;
      }
      input += chunk;
      if (input.length > 4_096) {
        socket.destroy();
        return;
      }

      const newlineIndex = input.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }
      handled = true;

      const request = parseControlRequest(input.slice(0, newlineIndex));
      if (!request || request.token !== token || request.action !== 'restart') {
        socket.end(`${JSON.stringify({ ok: false })}\n`);
        return;
      }
      if (restartRequested) {
        socket.end(`${JSON.stringify({ ok: true })}\n`);
        return;
      }

      restartRequested = true;
      removeRegistrationSync(registrationPath);
      server.close();
      socket.end(`${JSON.stringify({ ok: true })}\n`, onRestart);
    });
  });

  try {
    await listenOnLoopback(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('MCP process control endpoint did not expose a TCP port.');
    }

    const registration = {
      protocolVersion: MCP_CONTROL_PROTOCOL_VERSION,
      instanceId,
      pid: process.pid,
      port: address.port,
      token,
    };
    await writeRegistration(registrationPath, registration);
  } catch (error) {
    server.close();
    removeRegistrationSync(registrationPath);
    throw error;
  }

  const cleanupOnExit = () => removeRegistrationSync(registrationPath);
  const cleanupOnStdinEnd = () => {
    void dispose();
  };
  process.once('exit', cleanupOnExit);
  process.stdin.once('end', cleanupOnStdinEnd);

  async function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    process.removeListener('exit', cleanupOnExit);
    process.stdin.removeListener('end', cleanupOnStdinEnd);
    removeRegistrationSync(registrationPath);
    await closeServer(server);
  }

  return { registrationPath, dispose };
}

/**
 * Lifecycle coordination must never prevent the stdio MCP server from serving.
 * Sandboxed agents and read-only installations can legitimately reject the
 * loopback listener or registry write.
 *
 * @param {StartMcpProcessControlOptions} [options={}]
 * @returns {Promise<{ registrationPath: string, dispose: () => Promise<void> } | null>}
 */
export async function tryStartMcpProcessControl(options = {}) {
  try {
    return await startMcpProcessControl(options);
  } catch {
    return null;
  }
}

/**
 * Ask every registered MCP process to exit so its owning agent can launch the
 * current installed version. Registrations are removed only when the process is
 * gone; transient control failures remain visible for a later retry.
 *
 * @param {RestartMcpProcessesOptions} [options={}]
 * @returns {Promise<{ registered: number, restartRequested: number, restartFailed: number, staleRegistrationsRemoved: number }>}
 */
export async function restartRegisteredMcpProcesses(options = {}) {
  const { registryDir = getMcpProcessRegistryDir(), timeoutMs = MCP_CONTROL_TIMEOUT_MS } = options;
  let entries;
  try {
    entries = (await fs.promises.readdir(registryDir, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.json')
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        registered: 0,
        restartRequested: 0,
        restartFailed: 0,
        staleRegistrationsRemoved: 0,
      };
    }
    throw error;
  }

  let restartRequested = 0;
  let restartFailed = 0;
  let staleRegistrationsRemoved = 0;
  await Promise.all(
    entries.map(async (entry) => {
      const registrationPath = path.join(registryDir, entry.name);
      const registration = await readRegistration(registrationPath);
      if (!registration) {
        await fs.promises.rm(registrationPath, { force: true });
        staleRegistrationsRemoved += 1;
        return;
      }

      const accepted = await requestProcessRestart(registration, timeoutMs).catch(() => false);
      if (!accepted) {
        if (isProcessRunning(registration.pid)) {
          restartFailed += 1;
          return;
        }
        await fs.promises.rm(registrationPath, { force: true });
        staleRegistrationsRemoved += 1;
        return;
      }

      restartRequested += 1;
      await fs.promises.rm(registrationPath, { force: true });
    })
  );

  return {
    registered: entries.length,
    restartRequested,
    restartFailed,
    staleRegistrationsRemoved,
  };
}

/**
 * @param {net.Server} server
 * @returns {Promise<void>}
 */
function listenOnLoopback(server) {
  return new Promise((resolve, reject) => {
    /** @param {Error} error */
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

/**
 * @param {net.Server} server
 * @returns {Promise<void>}
 */
function closeServer(server) {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/**
 * @param {string} registrationPath
 * @param {McpProcessRegistration} registration
 * @returns {Promise<void>}
 */
async function writeRegistration(registrationPath, registration) {
  await fs.promises.mkdir(path.dirname(registrationPath), { recursive: true });
  const temporaryPath = `${registrationPath}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporaryPath, `${JSON.stringify(registration)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.promises.rename(temporaryPath, registrationPath);
}

/**
 * @param {string} registrationPath
 * @returns {Promise<McpProcessRegistration | null>}
 */
async function readRegistration(registrationPath) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(registrationPath, 'utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.protocolVersion !== MCP_CONTROL_PROTOCOL_VERSION ||
      typeof parsed.instanceId !== 'string' ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      !Number.isInteger(parsed.port) ||
      parsed.port <= 0 ||
      parsed.port > 65_535 ||
      typeof parsed.token !== 'string' ||
      parsed.token.length === 0
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {McpProcessRegistration} registration
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function requestProcessRestart(registration, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: registration.port });
    let response = '';
    let settled = false;

    /**
     * @param {Error | null} error
     * @param {boolean} [accepted]
     */
    const finish = (error, accepted = false) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error) {
        reject(error);
        return;
      }
      resolve(accepted);
    };

    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(new Error('MCP process control request timed out.')));
    socket.once('error', (error) => finish(error));
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ action: 'restart', token: registration.token })}\n`);
    });
    socket.on('data', (chunk) => {
      response += chunk;
      const newlineIndex = response.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }
      try {
        const result = JSON.parse(response.slice(0, newlineIndex));
        finish(null, Boolean(result && typeof result === 'object' && result.ok === true));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once('close', () => finish(new Error('MCP process control connection closed.')));
  });
}

/**
 * @param {string} input
 * @returns {{ action: string, token: string } | null}
 */
function parseControlRequest(input) {
  try {
    const parsed = JSON.parse(input);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.action !== 'string' ||
      typeof parsed.token !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {string} registrationPath
 */
function removeRegistrationSync(registrationPath) {
  try {
    fs.rmSync(registrationPath, { force: true });
  } catch {
    // Cleanup is best-effort during process shutdown.
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingFileError(error) {
  return Boolean(
    error && typeof error === 'object' && 'code' in error && String(error.code) === 'ENOENT'
  );
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(
      error && typeof error === 'object' && 'code' in error && String(error.code) === 'EPERM'
    );
  }
}
