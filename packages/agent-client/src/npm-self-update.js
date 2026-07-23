// @ts-check

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@browserbridge/bbx';
const PACKAGE_ROOT = path.dirname(fileURLToPath(new URL('../../../package.json', import.meta.url)));
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_LOCK_TIMEOUT_MS = 120_000;
const UPDATE_LOCK_PORT_START = 49_152;
const UPDATE_LOCK_PORT_COUNT = 16_384;
const UPDATE_LOCK_PORT_ATTEMPTS = 32;

/** @typedef {import('./types.js').NpmUpdateResult} NpmUpdateResult */

export class NpmPackageUpdatedError extends Error {
  /**
   * @param {string} version
   */
  constructor(version) {
    super(`Browser Bridge updated to ${version}; restarting to load the new version.`);
    this.name = 'NpmPackageUpdatedError';
    this.code = 'BBX_NPM_UPDATED';
    this.version = version;
  }
}

/**
 * @param {string} value
 * @returns {[number, number, number] | null}
 */
export function parseStableVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function comparePackageVersions(left, right) {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  if (!leftParts || !rightParts) {
    throw new Error(`Cannot compare invalid stable versions "${left}" and "${right}".`);
  }
  for (let index = 0; index < leftParts.length; index += 1) {
    const delta = leftParts[index] - rightParts[index];
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * @param {string} version
 * @returns {string | null}
 */
export function derivePackageProtocolVersion(version) {
  const parsed = parseStableVersion(version);
  return parsed ? `${parsed[0]}.${parsed[1]}` : null;
}

/**
 * @param {unknown[]} versions
 * @param {readonly string[]} supportedProtocols
 * @param {string} currentVersion
 * @returns {string | null}
 */
export function selectCompatibleNpmVersion(versions, supportedProtocols, currentVersion) {
  if (!parseStableVersion(currentVersion)) return null;
  const supported = new Set(supportedProtocols.filter((version) => /^\d+\.\d+$/u.test(version)));
  let selected = null;
  for (const value of versions) {
    if (typeof value !== 'string' || !parseStableVersion(value)) continue;
    const protocolVersion = derivePackageProtocolVersion(value);
    if (!protocolVersion || !supported.has(protocolVersion)) continue;
    if (comparePackageVersions(value, currentVersion) <= 0) continue;
    if (selected === null || comparePackageVersions(value, selected) > 0) selected = value;
  }
  return selected;
}

/**
 * @param {string} packageRoot
 * @returns {Promise<string | null>}
 */
async function readPackageVersion(packageRoot) {
  try {
    const parsed = JSON.parse(
      await fs.promises.readFile(path.join(packageRoot, 'package.json'), 'utf8')
    );
    return parsed && typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options={}]
 * @returns {Promise<string>}
 */
export async function runNpmCommand(args, options = {}) {
  const env = options.env ?? process.env;
  const npmExecPath = env.npm_execpath;
  const useNode = Boolean(npmExecPath && /\.(?:c?js|mjs)$/u.test(npmExecPath));
  const command = useNode
    ? process.execPath
    : npmExecPath || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const commandArgs = useNode && npmExecPath ? [npmExecPath, ...args] : args;

  return new Promise((resolve, reject) => {
    execFile(
      command,
      commandArgs,
      {
        env,
        encoding: 'utf8',
        timeout: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const detail = stderr.trim();
        reject(
          new Error(
            `npm ${args.join(' ')} failed${detail ? `: ${detail.slice(0, 1000)}` : `: ${error.message}`}`
          )
        );
      }
    );
  });
}

/**
 * Bind an exclusive loopback port derived from the global npm package path.
 * The OS releases the lock if the updater crashes, avoiding persistent stale
 * lock files while preserving cross-process serialization.
 *
 * @param {string} lockKey
 * @param {number} [offset=0]
 * @returns {number}
 */
export function getNpmUpdateLockPort(lockKey, offset = 0) {
  const digest = createHash('sha256').update(lockKey).digest();
  return (
    UPDATE_LOCK_PORT_START +
    ((digest.readUInt32BE(0) + Math.max(0, Math.trunc(offset))) % UPDATE_LOCK_PORT_COUNT)
  );
}

/**
 * @param {number} port
 * @returns {Promise<string | null>}
 */
async function readNpmUpdateLockIdentity(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    let value = '';
    /** @param {string | null} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(250, () => finish(null));
    socket.on('data', (chunk) => {
      value += chunk;
      if (value.length > 256 || value.includes('\n')) finish(value.trim());
    });
    socket.on('end', () => finish(value.trim() || null));
    socket.on('error', () => finish(null));
  });
}

/**
 * @param {string} lockKey
 * @param {number} [timeoutMs=DEFAULT_LOCK_TIMEOUT_MS]
 * @returns {Promise<() => Promise<void>>}
 */
export async function acquireNpmUpdateLock(lockKey, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
  const startedAt = Date.now();
  const identity = `bbx-npm-update:${createHash('sha256').update(lockKey).digest('hex')}`;
  while (true) {
    let activeUpdaterFound = false;
    for (let offset = 0; offset < UPDATE_LOCK_PORT_ATTEMPTS; offset += 1) {
      const port = getNpmUpdateLockPort(lockKey, offset);
      const server = net.createServer((socket) => socket.end(`${identity}\n`));
      const acquired = await new Promise((resolve, reject) => {
        server.once('error', (error) => {
          if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EADDRINUSE') {
            resolve(false);
            return;
          }
          reject(error);
        });
        server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(true));
      });
      if (acquired) {
        return async () => {
          await new Promise((resolve) => server.close(resolve));
        };
      }
      if ((await readNpmUpdateLockIdentity(port)) === identity) {
        activeUpdaterFound = true;
        break;
      }
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        activeUpdaterFound
          ? 'Timed out waiting for another Browser Bridge npm update to finish.'
          : 'Could not reserve a local Browser Bridge npm update lock.'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * @param {{
 *   extensionVersion: string,
 *   supportedVersions: readonly string[],
 *   env?: NodeJS.ProcessEnv,
 *   packageRoot?: string,
 *   lockPath?: string,
 *   runNpmFn?: typeof runNpmCommand,
 * }} options
 * @returns {Promise<NpmUpdateResult>}
 */
export async function updateCompatibleNpmPackage(options) {
  const env = options.env ?? process.env;
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const runNpmFn = options.runNpmFn ?? runNpmCommand;
  const extensionProtocol = derivePackageProtocolVersion(options.extensionVersion);
  if (!extensionProtocol || !options.supportedVersions.includes(extensionProtocol)) {
    return { updated: false, reason: 'invalid_extension_version' };
  }

  const globalRoot = (await runNpmFn(['root', '--global'], { env })).trim();
  const expectedRoot = path.join(globalRoot, '@browserbridge', 'bbx');
  const [realPackageRoot, realExpectedRoot, expectedStat] = await Promise.all([
    fs.promises.realpath(packageRoot).catch(() => ''),
    fs.promises.realpath(expectedRoot).catch(() => ''),
    fs.promises.lstat(expectedRoot).catch(() => null),
  ]);
  if (!realPackageRoot || realPackageRoot !== realExpectedRoot || expectedStat?.isSymbolicLink()) {
    return { updated: false, reason: 'not_global_install' };
  }

  const lockKey = options.lockPath ?? realExpectedRoot;
  const releaseLock = await acquireNpmUpdateLock(lockKey);
  try {
    const currentVersion = await readPackageVersion(packageRoot);
    if (!currentVersion || !parseStableVersion(currentVersion)) {
      return { updated: false, reason: 'invalid_installed_version' };
    }
    if (comparePackageVersions(options.extensionVersion, currentVersion) <= 0) {
      return { updated: false, reason: 'extension_not_newer', previousVersion: currentVersion };
    }

    const versionsRaw = await runNpmFn(['view', PACKAGE_NAME, 'versions', '--json'], { env });
    const parsedVersions = JSON.parse(versionsRaw);
    const versions = Array.isArray(parsedVersions) ? parsedVersions : [parsedVersions];
    const targetVersion = selectCompatibleNpmVersion(
      versions,
      options.supportedVersions,
      currentVersion
    );
    if (!targetVersion) {
      return { updated: false, reason: 'no_compatible_update', previousVersion: currentVersion };
    }

    await runNpmFn(
      ['install', '--global', '--no-audit', '--no-fund', '--', `${PACKAGE_NAME}@${targetVersion}`],
      { env }
    );
    const installedVersion = await readPackageVersion(packageRoot);
    if (installedVersion !== targetVersion) {
      throw new Error(
        `npm reported success, but Browser Bridge ${targetVersion} was not installed at ${packageRoot}.`
      );
    }
    return {
      updated: true,
      reason: 'updated',
      previousVersion: currentVersion,
      version: targetVersion,
    };
  } finally {
    await releaseLock();
  }
}
