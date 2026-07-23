// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import { getBridgeDir, getBridgeTransport } from '../../native-host/src/config.js';
import { atomicWriteFile } from './atomic-write.js';

/** @typedef {import('./types.js').AutoUpdatePolicy} AutoUpdatePolicy */
/** @typedef {import('./types.js').BridgeClientOptions} BridgeClientOptions */
/** @typedef {import('./types.js').BrowserBridgeConfig} BrowserBridgeConfig */

export const AUTO_UPDATE_ENV = 'BBX_AUTO_UPDATE';
export const CONFIG_FILENAME = 'config.json';
const AUTO_UPDATE_POLICIES = new Set(['off', 'compatible']);

/**
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function getBridgeConfigPath(env = process.env) {
  return path.join(getBridgeDir(env), CONFIG_FILENAME);
}

/**
 * @param {unknown} value
 * @returns {AutoUpdatePolicy}
 */
export function parseAutoUpdatePolicy(value) {
  if (typeof value !== 'string' || !AUTO_UPDATE_POLICIES.has(value)) {
    throw new Error('Auto-update policy must be "off" or "compatible".');
  }
  return /** @type {AutoUpdatePolicy} */ (value);
}

/**
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {Promise<BrowserBridgeConfig>}
 */
export async function readBridgeConfig(env = process.env) {
  const configPath = getBridgeConfigPath(env);
  let raw;
  try {
    raw = await fs.promises.readFile(configPath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return { autoUpdate: 'off' };
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Cannot read ${configPath}: expected a JSON object.`);
  }

  const config = /** @type {Record<string, unknown>} */ (parsed);
  return {
    ...config,
    autoUpdate: config.autoUpdate === undefined ? 'off' : parseAutoUpdatePolicy(config.autoUpdate),
  };
}

/**
 * @param {AutoUpdatePolicy} policy
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {Promise<string>}
 */
export async function setAutoUpdatePolicy(policy, env = process.env) {
  const normalized = parseAutoUpdatePolicy(policy);
  const configPath = getBridgeConfigPath(env);
  const config = await readBridgeConfig(env);
  await atomicWriteFile(
    configPath,
    `${JSON.stringify({ ...config, autoUpdate: normalized }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  return configPath;
}

/**
 * Environment configuration overrides the persisted preference for unattended
 * and containerized clients.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {Promise<AutoUpdatePolicy>}
 */
export async function getAutoUpdatePolicy(env = process.env) {
  if (env[AUTO_UPDATE_ENV] !== undefined) {
    return parseAutoUpdatePolicy(env[AUTO_UPDATE_ENV]);
  }
  return (await readBridgeConfig(env)).autoUpdate;
}

/**
 * @param {BridgeClientOptions} [options={}]
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @param {string[]} [argv=process.argv]
 * @returns {Promise<BridgeClientOptions>}
 */
export async function applyConfiguredAutoUpdate(
  options = {},
  env = process.env,
  argv = process.argv
) {
  if (options.updateNpmOnCompatibleVersion !== undefined) {
    return options;
  }
  if (env[AUTO_UPDATE_ENV] === undefined && !isBrowserBridgeProcess(argv)) {
    return options;
  }
  if (env.npm_command === 'exec' || (await getAutoUpdatePolicy(env)) !== 'compatible') {
    return options;
  }
  const transport = options.socketPath ? null : (options.transport ?? getBridgeTransport(env));
  if (transport?.type === 'tcp' && !isLoopbackHost(transport.host)) {
    return options;
  }
  return {
    ...options,
    checkProtocolOnConnect: true,
    updateNpmOnCompatibleVersion: true,
    exitProcessOnNpmUpdate: isMcpProcess(argv),
  };
}

/**
 * @param {string} host
 * @returns {boolean}
 */
function isLoopbackHost(host) {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, '');
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(normalized);
  return Boolean(
    match && match.slice(1).every((part) => Number(part) <= 255) && match[1] === '127'
  );
}

/**
 * @param {string[]} [argv=process.argv]
 * @returns {boolean}
 */
export function isMcpProcess(argv = process.argv) {
  const entry = (argv[1] || '').replaceAll('\\', '/');
  const entryName = entry.slice(entry.lastIndexOf('/') + 1).toLowerCase();
  return (
    (argv[2] === 'mcp' && argv[3] === 'serve') ||
    (entry.includes('/mcp-server/') && entry.endsWith('/bin.js')) ||
    entryName === 'bbx-mcp' ||
    entryName === 'bbx-mcp.cmd'
  );
}

/**
 * Persisted CLI preferences apply to the shipped executables, not arbitrary
 * programmatic BridgeClient consumers that happen to share the same user home.
 *
 * @param {string[]} [argv=process.argv]
 * @returns {boolean}
 */
export function isBrowserBridgeProcess(argv = process.argv) {
  if (isMcpProcess(argv)) return true;
  const entry = (argv[1] || '').replaceAll('\\', '/');
  const entryName = entry.slice(entry.lastIndexOf('/') + 1).toLowerCase();
  return (
    (entry.includes('/agent-client/') && entry.endsWith('/cli.js')) ||
    entryName === 'bbx' ||
    entryName === 'bbx.cmd'
  );
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingFileError(error) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    /** @type {{ code?: unknown }} */ (error).code === 'ENOENT'
  );
}
