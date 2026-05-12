// @ts-check

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getBridgeDir } from './config.js';

const TOKEN_FILENAME = 'daemon.auth';
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u;

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
  return TOKEN_PATTERN.test(token) ? token : null;
}

/**
 * @param {{ tokenPath?: string, readFile?: typeof fs.promises.readFile }} [options={}]
 * @returns {Promise<string | null>}
 */
export async function readBridgeAuthToken(options = {}) {
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
