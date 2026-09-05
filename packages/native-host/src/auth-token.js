// @ts-check

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getBridgeDir } from './config.js';

export const BRIDGE_AUTH_TOKEN_ENV = 'BBX_AUTH_TOKEN';
export const BRIDGE_AUTH_TOKEN_FILE_ENV = 'BBX_AUTH_TOKEN_FILE';
const TOKEN_FILENAME = 'daemon.auth';
const EXTENSION_TOKEN_FILENAME = 'daemon.extension.auth';
const TOKEN_BYTES = 32;
/**
 * @typedef {{ tokenPath?: string, readFile?: typeof fs.promises.readFile,
 * writeFile?: typeof fs.promises.writeFile, mkdir?: typeof fs.promises.mkdir,
 * chmod?: typeof fs.promises.chmod, link?: typeof fs.promises.link,
 * unlink?: typeof fs.promises.unlink, randomBytesFn?: typeof randomBytes }} TokenInitOptions
 */
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
 * Private credential used only by the Chrome native host when registering the
 * extension role. Remote agent configurations never receive this token.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function getBridgeExtensionAuthTokenPath(env = process.env) {
  return path.join(getBridgeDir(env), EXTENSION_TOKEN_FILENAME);
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
 * Compare a candidate auth token against the expected token in constant time.
 * Both sides are hashed before comparison so neither token length nor a
 * matching prefix is observable through timing, which matters when the daemon
 * listens on TCP (proxy mode exposes it beyond localhost).
 *
 * @param {unknown} candidate
 * @param {string | null | undefined} expected
 * @returns {boolean}
 */
export function bridgeAuthTokensEqual(candidate, expected) {
  const normalizedCandidate = normalizeBridgeAuthToken(candidate);
  if (!normalizedCandidate || typeof expected !== 'string' || !expected) {
    return false;
  }
  return timingSafeEqual(
    createHash('sha256').update(normalizedCandidate).digest(),
    createHash('sha256').update(expected).digest()
  );
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
 * @param {{ env?: NodeJS.ProcessEnv, tokenPath?: string, readFile?: typeof fs.promises.readFile }} [options={}]
 * @returns {Promise<string | null>}
 */
export async function readBridgeAuthToken(options = {}) {
  const override = await readBridgeAuthTokenOverride(options);
  if (override) {
    return override;
  }
  const tokenPath = options.tokenPath ?? getBridgeAuthTokenPath();
  const readFile = options.readFile ?? fs.promises.readFile.bind(fs.promises);
  return readStoredBridgeAuthToken(tokenPath, readFile);
}

/**
 * @param {{ tokenPath?: string, readFile?: typeof fs.promises.readFile }} [options={}]
 * @returns {Promise<string | null>}
 */
export async function readBridgeExtensionAuthToken(options = {}) {
  const tokenPath = options.tokenPath ?? getBridgeExtensionAuthTokenPath();
  const readFile = options.readFile ?? fs.promises.readFile.bind(fs.promises);
  return readStoredBridgeAuthToken(tokenPath, readFile);
}

/**
 * @param {string} tokenPath
 * @param {typeof fs.promises.readFile} readFile
 * @returns {Promise<string | null>}
 */
async function readStoredBridgeAuthToken(tokenPath, readFile) {
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
 * @param {TokenInitOptions} [options={}]
 * @returns {Promise<string>}
 */
export async function ensureBridgeAuthToken(options = {}) {
  const tokenPath = options.tokenPath ?? getBridgeAuthTokenPath();
  return ensureStoredBridgeAuthToken(tokenPath, options);
}

/**
 * @param {TokenInitOptions} [options={}]
 * @returns {Promise<string>}
 */
export async function ensureBridgeExtensionAuthToken(options = {}) {
  const tokenPath = options.tokenPath ?? getBridgeExtensionAuthTokenPath();
  return ensureStoredBridgeAuthToken(tokenPath, options);
}

/**
 * @param {string} tokenPath
 * @param {TokenInitOptions} options
 * @returns {Promise<string>}
 */
async function ensureStoredBridgeAuthToken(tokenPath, options) {
  const readFile = options.readFile ?? fs.promises.readFile.bind(fs.promises);
  const writeFile = options.writeFile ?? fs.promises.writeFile.bind(fs.promises);
  const mkdir = options.mkdir ?? fs.promises.mkdir.bind(fs.promises);
  const chmod = options.chmod ?? fs.promises.chmod.bind(fs.promises);
  const link = options.link ?? fs.promises.link.bind(fs.promises);
  const unlink = options.unlink ?? fs.promises.unlink.bind(fs.promises);
  const randomBytesFn = options.randomBytesFn ?? randomBytes;
  const existing = await readStoredBridgeAuthToken(tokenPath, readFile);
  if (existing) {
    return existing;
  }

  const token = randomBytesFn(TOKEN_BYTES).toString('base64url');
  await mkdir(path.dirname(tokenPath), { recursive: true });
  const nonce = randomUUID();
  const temporaryPath = `${tokenPath}.${nonce}.tmp`;
  const ownerPath = `${temporaryPath}.owner`;
  let lockPath = `${tokenPath}.init.lock`;
  let locked = false;
  /** @param {string} filePath */
  const remove = async (filePath) => {
    try {
      await unlink(filePath);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  };
  try {
    // Neither the credential nor lock name is visible until its complete contents
    // have been written and closed. Hard links publish without replacing a winner.
    await writeFile(temporaryPath, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await writeFile(ownerPath, `${process.pid}:${nonce}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    if (process.platform !== 'win32') await chmod(temporaryPath, 0o600).catch(() => {});
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await link(ownerPath, lockPath);
        locked = true;
        break;
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST')
          throw error;
      }
      let owner;
      try {
        owner = await readFile(lockPath, 'utf8');
      } catch (error) {
        if (isMissingFileError(error)) continue;
        throw error;
      }
      const match = /^(\d+):([0-9a-f-]{36})\n$/u.exec(owner);
      if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0) {
        throw new Error('Bridge auth initialization lock has invalid ownership metadata.');
      }
      try {
        process.kill(Number(match[1]), 0);
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
          // Never unlink a dead owner's lock: two stale-lock cleaners could delete
          // a new winner's lock. All contenders instead follow the same successor.
          lockPath = `${tokenPath}.init-${match[2]}.lock`;
          continue;
        }
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EPERM')
          throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!locked) throw new Error('Timed out waiting for bridge auth initialization.');
    const winner = await readStoredBridgeAuthToken(tokenPath, readFile);
    if (winner) return winner;
    await remove(tokenPath);
    try {
      await link(temporaryPath, tokenPath);
      return token;
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST')
        throw error;
      const published = await readStoredBridgeAuthToken(tokenPath, readFile);
      if (published) return published;
      throw error;
    }
  } finally {
    // Release the lock even if temporary-file cleanup fails.
    try {
      if (locked) await remove(lockPath);
    } finally {
      await Promise.all([remove(temporaryPath), remove(ownerPath)]);
    }
  }
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
