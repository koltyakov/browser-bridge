// @ts-check

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { pingExistingDaemon } from './daemon.js';
import { getBridgeDir, getDaemonPidPath, getSocketPath } from './config.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonEntryPath = path.resolve(__dirname, '../bin/bridge-daemon.js');
const DEFAULT_DAEMON_RESTART_TIMEOUT_MS = 5_000;
const DEFAULT_DAEMON_POLL_INTERVAL_MS = 100;

/**
 * @typedef {{
 *   socketPath?: string,
 *   pidPath?: string,
 *   timeoutMs?: number,
 *   pollIntervalMs?: number,
 *   pingDaemonFn?: (socketPath: string) => Promise<boolean>,
 *   readPidFn?: (pidPath?: string) => Promise<number | null>,
 *   findPidBySocketFn?: (socketPath: string) => Promise<number | null>,
 *   killFn?: typeof process.kill,
 *   rmFn?: typeof fs.promises.rm,
 *   sleepFn?: (ms: number) => Promise<void>,
 * }} StopBridgeDaemonOptions
 */

/**
 * @typedef {{
 *   socketPath?: string,
 *   pidPath?: string,
 *   timeoutMs?: number,
 *   pollIntervalMs?: number,
 *   pingDaemonFn?: (socketPath: string) => Promise<boolean>,
 *   readPidFn?: (pidPath?: string) => Promise<number | null>,
 *   findPidBySocketFn?: (socketPath: string) => Promise<number | null>,
 *   killFn?: typeof process.kill,
 *   rmFn?: typeof fs.promises.rm,
 *   sleepFn?: (ms: number) => Promise<void>,
 *   spawnDaemonFn?: typeof spawnBridgeDaemonProcess,
 * }} RestartBridgeDaemonOptions
 */

/**
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnBridgeDaemonProcess() {
  const child = spawn(process.execPath, [daemonEntryPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

/**
 * @param {number} [pid=process.pid]
 * @param {string} [pidPath=getDaemonPidPath()]
 * @returns {Promise<void>}
 */
export async function writeDaemonPidFile(pid = process.pid, pidPath = getDaemonPidPath()) {
  await fs.promises.mkdir(getBridgeDir(), { recursive: true });
  await fs.promises.writeFile(pidPath, `${pid}\n`, 'utf8');
}

/**
 * @param {string} [pidPath=getDaemonPidPath()]
 * @returns {Promise<number | null>}
 */
export async function readDaemonPidFile(pidPath = getDaemonPidPath()) {
  try {
    const raw = await fs.promises.readFile(pidPath, 'utf8');
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * @param {{ pid?: number | null, pidPath?: string, rmFn?: typeof fs.promises.rm }} [options={}]
 * @returns {Promise<void>}
 */
export async function clearDaemonPidFile(options = {}) {
  const { pid = null, pidPath = getDaemonPidPath(), rmFn = fs.promises.rm } = options;

  if (pid !== null) {
    const currentPid = await readDaemonPidFile(pidPath);
    if (currentPid !== pid) {
      return;
    }
  }

  try {
    await rmFn(pidPath, { force: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }
    throw error;
  }
}

/**
 * @param {StopBridgeDaemonOptions} [options={}]
 * @returns {Promise<{ previouslyRunning: boolean, previousPid: number | null, removedStaleSocket: boolean }>}
 */
export async function stopBridgeDaemon(options = {}) {
  const {
    socketPath = getSocketPath(),
    pidPath = getDaemonPidPath(),
    timeoutMs = DEFAULT_DAEMON_RESTART_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_DAEMON_POLL_INTERVAL_MS,
    pingDaemonFn = pingExistingDaemon,
    readPidFn = readDaemonPidFile,
    findPidBySocketFn = findDaemonPidBySocket,
    killFn = process.kill.bind(process),
    rmFn = fs.promises.rm,
    sleepFn = sleep,
  } = options;

  let previousPid = await readPidFn(pidPath);
  let previouslyRunning = previousPid !== null;

  if (previousPid === null && (await safePingDaemon(socketPath, pingDaemonFn))) {
    previousPid = await findPidBySocketFn(socketPath);
    previouslyRunning = true;
  }

  if (previousPid !== null) {
    try {
      killFn(previousPid, 'SIGTERM');
    } catch (error) {
      if (!isMissingProcessError(error)) {
        throw error;
      }
    }

    const stopped = await waitForDaemonReachability({
      socketPath,
      reachable: false,
      timeoutMs,
      pollIntervalMs,
      pingDaemonFn,
      sleepFn,
    });
    if (!stopped) {
      throw new Error(`Timed out waiting for Browser Bridge daemon (pid ${previousPid}) to stop.`);
    }
  }

  await clearDaemonPidFile({ pid: previousPid, pidPath, rmFn });

  const removedStaleSocket = await removeStaleSocket(socketPath, rmFn, pingDaemonFn);
  return {
    previouslyRunning,
    previousPid,
    removedStaleSocket,
  };
}

/**
 * @param {RestartBridgeDaemonOptions} [options={}]
 * @returns {Promise<{
 *   socketPath: string,
 *   pidPath: string,
 *   pid: number | null,
 *   previouslyRunning: boolean,
 *   previousPid: number | null,
 *   removedStaleSocket: boolean,
 * }>}
 */
export async function restartBridgeDaemon(options = {}) {
  const {
    socketPath = getSocketPath(),
    pidPath = getDaemonPidPath(),
    timeoutMs = DEFAULT_DAEMON_RESTART_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_DAEMON_POLL_INTERVAL_MS,
    pingDaemonFn = pingExistingDaemon,
    readPidFn = readDaemonPidFile,
    findPidBySocketFn = findDaemonPidBySocket,
    killFn = process.kill.bind(process),
    rmFn = fs.promises.rm,
    sleepFn = sleep,
    spawnDaemonFn = spawnBridgeDaemonProcess,
  } = options;

  const stopResult = await stopBridgeDaemon({
    socketPath,
    pidPath,
    timeoutMs,
    pollIntervalMs,
    pingDaemonFn,
    readPidFn,
    findPidBySocketFn,
    killFn,
    rmFn,
    sleepFn,
  });

  spawnDaemonFn();

  const started = await waitForDaemonReachability({
    socketPath,
    reachable: true,
    timeoutMs,
    pollIntervalMs,
    pingDaemonFn,
    sleepFn,
  });
  if (!started) {
    throw new Error('Timed out waiting for Browser Bridge daemon to start.');
  }

  return {
    socketPath,
    pidPath,
    pid: await readPidFn(pidPath),
    ...stopResult,
  };
}

/**
 * @param {string} socketPath
 * @returns {Promise<number | null>}
 */
export async function findDaemonPidBySocket(socketPath) {
  if (process.platform === 'win32') {
    return null;
  }

  try {
    const { stdout } = await execFileAsync('lsof', ['-t', '--', socketPath]);
    const pid = Number.parseInt(
      stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find(Boolean) ?? '',
      10
    );
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (isCommandNotFoundError(error) || isLsofNoResultsError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * @param {{
 *   socketPath: string,
 *   reachable: boolean,
 *   timeoutMs: number,
 *   pollIntervalMs: number,
 *   pingDaemonFn: (socketPath: string) => Promise<boolean>,
 *   sleepFn: (ms: number) => Promise<void>,
 * }} options
 * @returns {Promise<boolean>}
 */
async function waitForDaemonReachability(options) {
  const { socketPath, reachable, timeoutMs, pollIntervalMs, pingDaemonFn, sleepFn } = options;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if ((await safePingDaemon(socketPath, pingDaemonFn)) === reachable) {
      return true;
    }
    await sleepFn(pollIntervalMs);
  }
  return false;
}

/**
 * @param {string} socketPath
 * @param {typeof fs.promises.rm} rmFn
 * @param {(socketPath: string) => Promise<boolean>} pingDaemonFn
 * @returns {Promise<boolean>}
 */
async function removeStaleSocket(socketPath, rmFn, pingDaemonFn) {
  if (await safePingDaemon(socketPath, pingDaemonFn)) {
    return false;
  }

  try {
    await fs.promises.access(socketPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }

  try {
    await rmFn(socketPath, { force: true });
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * @param {string} socketPath
 * @param {(socketPath: string) => Promise<boolean>} pingDaemonFn
 * @returns {Promise<boolean>}
 */
async function safePingDaemon(socketPath, pingDaemonFn) {
  try {
    return await pingDaemonFn(socketPath);
  } catch {
    return false;
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingFileError(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingProcessError(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH');
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isCommandNotFoundError(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isLsofNoResultsError(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 1);
}
