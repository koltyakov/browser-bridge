// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import { createTcpBridgeTransport, getBridgeDir } from '../../native-host/src/config.js';
import { normalizeBridgeAuthToken } from '../../native-host/src/auth-token.js';
import { atomicWriteFile } from './atomic-write.js';
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
 * @param {{ configPath?: string }} [options={}]
 * @returns {Promise<void>}
 */
export async function writeRemoteConfig(config, options = {}) {
  const configPath = options.configPath ?? getRemoteConfigPath();
  const remotes = config.remotes.map(validateRemoteDestination);
  await atomicWriteFile(configPath, `${JSON.stringify({ remotes }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/**
 * @param {RemoteDestination} remote
 * @returns {Promise<RemoteDestination>}
 */
export async function addRemoteDestination(remote) {
  const validated = validateRemoteDestination(remote);
  const config = await readRemoteConfig();
  const existing = config.remotes.findIndex((entry) => entry.id === validated.id);
  if (existing === -1) {
    config.remotes.push(validated);
  } else {
    config.remotes[existing] = validated;
  }
  await writeRemoteConfig(config);
  return validated;
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
 * @typedef {{ port?: number, bindHost?: string, token?: string, rotateToken?: boolean, unsafePlaintext?: boolean }} ProxyEnableOptions
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
  const bindHost = options.bindHost ?? existing?.bindHost ?? '127.0.0.1';
  if (options.token) {
    return {
      port,
      bindHost,
      token: validateAuthToken(options.token),
      tokenSource: 'explicit',
    };
  }
  const existingToken = normalizeBridgeAuthToken(existing?.token);
  if (!options.rotateToken && existingToken) {
    return { port, bindHost, token: existingToken, tokenSource: 'existing' };
  }
  return {
    port,
    bindHost,
    token: validateAuthToken(generateToken()),
    tokenSource: 'generated',
  };
}

/**
 * Require an explicit acknowledgement before creating or changing a raw TCP
 * listener that is reachable beyond the local machine. A stored non-loopback
 * host may be reused without breaking an existing installation.
 *
 * @param {{ bindHost: string } | null} existing
 * @param {ProxyEnableOptions} options
 * @param {string} bindHost
 * @returns {void}
 */
export function assertProxyBindSafety(existing, options, bindHost) {
  if (
    isLoopbackHost(bindHost) ||
    options.unsafePlaintext === true ||
    (options.bindHost === undefined && existing?.bindHost === bindHost)
  ) {
    return;
  }
  throw new Error(
    'Refusing to bind Browser Bridge raw TCP to a non-loopback host without --unsafe-plaintext. This transport is unencrypted; keep the default 127.0.0.1 bind and use an SSH tunnel instead.'
  );
}

/**
 * @param {string} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, '');
  const ipv4Parts = normalized.split('.').map(Number);
  const isIpv4Loopback =
    ipv4Parts.length === 4 &&
    ipv4Parts[0] === 127 &&
    ipv4Parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    isIpv4Loopback
  );
}

/**
 * @param {RemoteDestination} remote
 * @returns {RemoteDestination}
 */
function validateRemoteDestination(remote) {
  const id = normalizeDestinationId(remote.id);
  const { host, port } = parseRemoteEndpoint(`${remote.host}:${remote.port}`);
  return { id, host, port, token: validateAuthToken(remote.token) };
}

/**
 * @param {unknown} token
 * @returns {string}
 */
function validateAuthToken(token) {
  const normalized = normalizeBridgeAuthToken(token);
  if (!normalized) {
    throw new Error('Bridge auth token must be a UUID or 32-256 URL-safe characters.');
  }
  return normalized;
}

/**
 * @param {string | null | undefined} destinationId
 * @param {{ defaultTimeoutMs?: number, checkProtocolOnConnect?: boolean }} [options={}]
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
