// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import { createTcpBridgeTransport, getBridgeDir } from '../../native-host/src/config.js';
import { normalizeBridgeAuthToken } from '../../native-host/src/auth-token.js';
import { BridgeClient } from './client.js';

const REMOTES_FILENAME = 'remotes.json';
const LOCAL_DESTINATION_ID = 'local';
export const DEFAULT_REMOTE_PORT = 9223;

/**
 * @typedef {{ id: string, host: string, port: number, token: string }} RemoteDestination
 */

/**
 * @typedef {{ remotes: RemoteDestination[] }} RemoteConfig
 */

/**
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function getRemoteConfigPath(env = process.env) {
  return path.join(getBridgeDir(env), REMOTES_FILENAME);
}

/**
 * @param {string} id
 * @returns {string}
 */
export function normalizeDestinationId(id) {
  const normalized = id.trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(normalized) || normalized === LOCAL_DESTINATION_ID) {
    throw new Error('Remote name must be 1-64 letters, numbers, dots, dashes, or underscores.');
  }
  return normalized;
}

/**
 * @param {string} endpoint
 * @returns {{ host: string, port: number }}
 */
export function parseRemoteEndpoint(endpoint) {
  const trimmed = endpoint.trim();
  const match = /^(.+):(\d{1,5})$/u.exec(trimmed);
  const host = (match ? match[1] : trimmed).trim().replace(/^\[|\]$/gu, '');
  const port = match ? Number.parseInt(match[2], 10) : DEFAULT_REMOTE_PORT;
  if (!host || /[\s/]/u.test(host)) {
    throw new Error('Remote host must be a hostname or IP address.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Remote port must be an integer between 1 and 65535.');
  }
  return { host, port };
}

/**
 * @param {unknown} value
 * @returns {RemoteDestination | null}
 */
function normalizeRemote(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  if (
    typeof record.id !== 'string' ||
    typeof record.host !== 'string' ||
    typeof record.port !== 'number' ||
    typeof record.token !== 'string'
  ) {
    return null;
  }
  const token = normalizeBridgeAuthToken(record.token);
  if (!token) {
    return null;
  }
  try {
    const id = normalizeDestinationId(record.id);
    const { host, port } = parseRemoteEndpoint(`${record.host}:${record.port}`);
    return { id, host, port, token };
  } catch {
    return null;
  }
}

/**
 * @param {{ configPath?: string, readFile?: typeof fs.promises.readFile }} [options={}]
 * @returns {Promise<RemoteConfig>}
 */
export async function readRemoteConfig(options = {}) {
  const configPath = options.configPath ?? getRemoteConfigPath();
  const readFile = options.readFile ?? fs.promises.readFile.bind(fs.promises);
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    /** @type {RemoteDestination[]} */
    const remotes = [];
    if (Array.isArray(parsed?.remotes)) {
      for (const entry of parsed.remotes) {
        const remote = normalizeRemote(entry);
        if (remote) {
          remotes.push(remote);
        }
      }
    }
    return { remotes };
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      /** @type {{ code?: unknown }} */ (error).code === 'ENOENT'
    ) {
      return { remotes: [] };
    }
    throw error;
  }
}

/**
 * @param {RemoteConfig} config
 * @param {{ configPath?: string, writeFile?: typeof fs.promises.writeFile, mkdir?: typeof fs.promises.mkdir }} [options={}]
 * @returns {Promise<void>}
 */
export async function writeRemoteConfig(config, options = {}) {
  const configPath = options.configPath ?? getRemoteConfigPath();
  const writeFile = options.writeFile ?? fs.promises.writeFile.bind(fs.promises);
  const mkdir = options.mkdir ?? fs.promises.mkdir.bind(fs.promises);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({ remotes: config.remotes }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/**
 * @param {RemoteDestination} remote
 * @returns {Promise<RemoteDestination>}
 */
export async function addRemoteDestination(remote) {
  const config = await readRemoteConfig();
  const existing = config.remotes.findIndex((entry) => entry.id === remote.id);
  if (existing === -1) {
    config.remotes.push(remote);
  } else {
    config.remotes[existing] = remote;
  }
  await writeRemoteConfig(config);
  return remote;
}

/**
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function removeRemoteDestination(id) {
  const normalizedId = normalizeDestinationId(id);
  const config = await readRemoteConfig();
  const next = config.remotes.filter((remote) => remote.id !== normalizedId);
  await writeRemoteConfig({ remotes: next });
  return next.length !== config.remotes.length;
}

/**
 * @returns {Promise<Array<{ id: string, local: boolean, host: string | null, port: number | null }>>}
 */
export async function listBridgeDestinations() {
  const config = await readRemoteConfig();
  return [
    { id: LOCAL_DESTINATION_ID, local: true, host: null, port: null },
    ...config.remotes.map((remote) => ({
      id: remote.id,
      local: false,
      host: remote.host,
      port: remote.port,
    })),
  ];
}

/**
 * @typedef {{ port?: number, bindHost?: string, token?: string, rotateToken?: boolean }} ProxyEnableOptions
 */

/**
 * Merge `bbx proxy enable` options with an existing proxy config so re-running
 * the command is idempotent: the port, bind host, and shared secret are
 * preserved unless explicitly overridden. The token only changes when passed
 * via --token or regenerated via --rotate-token, so already-configured remote
 * clients keep working across repeated enables.
 *
 * @param {{ port: number, bindHost: string, token?: string } | null} existing
 * @param {ProxyEnableOptions} options
 * @param {() => string} generateToken
 * @returns {{ port: number, bindHost: string, token: string, tokenSource: 'explicit' | 'existing' | 'generated' }}
 */
export function resolveProxyEnableSettings(existing, options, generateToken) {
  const port = options.port ?? existing?.port ?? DEFAULT_REMOTE_PORT;
  const bindHost = options.bindHost ?? existing?.bindHost ?? '0.0.0.0';
  if (options.token) {
    return { port, bindHost, token: options.token, tokenSource: 'explicit' };
  }
  if (!options.rotateToken && existing?.token) {
    return { port, bindHost, token: existing.token, tokenSource: 'existing' };
  }
  return { port, bindHost, token: generateToken(), tokenSource: 'generated' };
}

/**
 * @param {string | null | undefined} destinationId
 * @param {{ defaultTimeoutMs?: number }} [options={}]
 * @returns {Promise<BridgeClient>}
 */
export async function createBridgeClientForDestination(destinationId, options = {}) {
  if (!destinationId || destinationId === LOCAL_DESTINATION_ID) {
    return new BridgeClient(options);
  }
  const config = await readRemoteConfig();
  const remote = config.remotes.find((entry) => entry.id === destinationId);
  if (!remote) {
    throw new Error(`Unknown Browser Bridge destination "${destinationId}".`);
  }
  return new BridgeClient({
    ...options,
    transport: createTcpBridgeTransport(remote.port, remote.host),
    authToken: remote.token,
    restartDaemonOnVersionMismatch: false,
  });
}
