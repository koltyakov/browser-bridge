// @ts-check

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getBridgeDir } from './config.js';

export const BRIDGE_AUTH_TOKEN_ENV = 'BBX_AUTH_TOKEN';
export const BRIDGE_AUTH_TOKEN_FILE_ENV = 'BBX_AUTH_TOKEN_FILE';
const TOKEN_FILENAME = 'daemon.auth';
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u;
const UUID_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function getBridgeAuthTokenPath(env = process.env) {
  return path.join(getBridgeDir(env), TOKEN_FILENAME);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeBridgeAuthToken(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const token = value.trim();
  return TOKEN_PATTERN.test(token) || UUID_TOKEN_PATTERN.test(token) ? token : null;
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, readFile?: typeof fs.promises.readFile }} [options={}]
 * @returns {Promise<string | null>}
 */
export async function readBridgeAuthTokenOverride(options = {}) {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? fs.promises.readFile.bind(fs.promises);
  const explicitToken = normalizeBridgeAuthToken(env[BRIDGE_AUTH_TOKEN_ENV]);
  if (explicitToken) {
    return explicitToken;
  }
  const tokenFile = env[BRIDGE_AUTH_TOKEN_FILE_ENV];
  if (!tokenFile) {
    return null;
  }
  try {
    return normalizeBridgeAuthToken(await readFile(tokenFile, 'utf8'));
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * @param {{ tokenPath?: string, readFile?: typeof fs.promises.readFile }} [options={}]
 * @returns {Promise<string | null>}
 */
export async function readBridgeAuthToken(options = {}) {
  const override = await readBridgeAuthTokenOverride(options);
  if (override) {
    return override;
  }
  const tokenPath = options.tokenPath ?? getBridgeAuthTokenPath();
  const readFile = options.readFile ?? fs.promises.readFile.bind(fs.promises);
  try {
    return normalizeBridgeAuthToken(await readFile(tokenPath, 'utf8'));
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * @param {string} token
 * @param {{ tokenPath?: string, writeFile?: typeof fs.promises.writeFile, mkdir?: typeof fs.promises.mkdir, chmod?: typeof fs.promises.chmod }} [options={}]
 * @returns {Promise<string>}
 */
export async function writeBridgeAuthToken(token, options = {}) {
  const normalized = normalizeBridgeAuthToken(token);
  if (!normalized) {
    throw new Error('Bridge auth token must be a UUID or 32-256 URL-safe characters.');
  }
  const tokenPath = options.tokenPath ?? getBridgeAuthTokenPath();
  const writeFile = options.writeFile ?? fs.promises.writeFile.bind(fs.promises);
  const mkdir = options.mkdir ?? fs.promises.mkdir.bind(fs.promises);
  const chmod = options.chmod ?? fs.promises.chmod.bind(fs.promises);
  await mkdir(path.dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, `${normalized}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    await chmod(tokenPath, 0o600).catch(() => {});
  }
  return normalized;
}

/**
 * @param {{
 *   tokenPath?: string,
 *   readFile?: typeof fs.promises.readFile,
 *   writeFile?: typeof fs.promises.writeFile,
 *   mkdir?: typeof fs.promises.mkdir,
 *   chmod?: typeof fs.promises.chmod,
 *   randomBytesFn?: typeof randomBytes
 * }} [options={}]
 * @returns {Promise<string>}
 */
export async function ensureBridgeAuthToken(options = {}) {
  const tokenPath = options.tokenPath ?? getBridgeAuthTokenPath();
  const readFile = options.readFile ?? fs.promises.readFile.bind(fs.promises);
  const writeFile = options.writeFile ?? fs.promises.writeFile.bind(fs.promises);
  const mkdir = options.mkdir ?? fs.promises.mkdir.bind(fs.promises);
  const chmod = options.chmod ?? fs.promises.chmod.bind(fs.promises);
  const randomBytesFn = options.randomBytesFn ?? randomBytes;
  const existing = await readBridgeAuthToken({ tokenPath, readFile });
  if (existing) {
    return existing;
  }

  const token = randomBytesFn(TOKEN_BYTES).toString('base64url');
  await mkdir(path.dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    await chmod(tokenPath, 0o600).catch(() => {});
  }
  return token;
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
