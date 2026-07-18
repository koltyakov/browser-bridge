// @ts-check

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { pingExistingDaemon } from './daemon.js';
import {
  applyWindowsTcpTransportDefaults,
  createSocketBridgeTransport,
  formatBridgeTransport,
  getBridgeTransport,
  getDaemonLogPath,
  getDaemonPidPath,
  getDaemonStartHistoryPath,
} from './config.js';

/** @typedef {import('./config.js').BridgeTransport} BridgeTransport */

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonEntryPath = path.resolve(__dirname, '../bin/bridge-daemon.js');
const DEFAULT_DAEMON_RESTART_TIMEOUT_MS = 5_000;
const DEFAULT_DAEMON_POLL_INTERVAL_MS = 100;
const DAEMON_LOG_MAX_BYTES = 1024 * 1024;
const DAEMON_START_HISTORY_MAX_ENTRIES = 20;

/**
 * A daemon that starts this many times within the window is considered to be
 * crash-looping rather than restarting normally.
 */
export const DAEMON_RESTART_LOOP_THRESHOLD = 3;
export const DAEMON_RESTART_LOOP_WINDOW_MS = 60_000;

/**
 * @typedef {{
 *   transport?: BridgeTransport,
 *   socketPath?: string,
 *   pidPath?: string,
 *   timeoutMs?: number,
 *   pollIntervalMs?: number,
 *   pingDaemonFn?: (transport: BridgeTransport) => Promise<boolean>,
 *   readPidFn?: (pidPath?: string) => Promise<number | null>,
 *   findPidByTransportFn?: (transport: BridgeTransport) => Promise<number | null>,
 *   killFn?: typeof process.kill,
 *   rmFn?: typeof fs.promises.rm,
 *   sleepFn?: (ms: number) => Promise<void>,
 * }} StopBridgeDaemonOptions
 */

/**
 * @typedef {{
 *   transport?: BridgeTransport,
 *   socketPath?: string,
 *   pidPath?: string,
 *   timeoutMs?: number,
 *   pollIntervalMs?: number,
 *   pingDaemonFn?: (transport: BridgeTransport) => Promise<boolean>,
 *   readPidFn?: (pidPath?: string) => Promise<number | null>,
 *   findPidByTransportFn?: (transport: BridgeTransport) => Promise<number | null>,
 *   killFn?: typeof process.kill,
 *   rmFn?: typeof fs.promises.rm,
 *   sleepFn?: (ms: number) => Promise<void>,
 *   spawnDaemonFn?: typeof spawnBridgeDaemonProcess,
 * }} RestartBridgeDaemonOptions
 */

/**
 * Open the persistent daemon log for appending, rotating it once when it grows
 * past the size cap. Returns null when the log cannot be opened (for example a
 * root-owned bridge dir after a sudo install) so callers can fall back to
 * discarding output instead of failing the spawn.
 *
 * @param {string} [logPath=getDaemonLogPath()]
 * @returns {number | null}
 */
export function openDaemonLogFd(logPath = getDaemonLogPath()) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    try {
      if (fs.statSync(logPath).size > DAEMON_LOG_MAX_BYTES) {
        fs.rmSync(`${logPath}.1`, { force: true });
        fs.renameSync(logPath, `${logPath}.1`);
      }
    } catch {
      // Rotation is best-effort: on Windows the rename fails while another
      // daemon holds the log open. Keep appending to the current file.
    }
    return fs.openSync(logPath, 'a');
  } catch {
    return null;
  }
}

/**
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnBridgeDaemonProcess() {
  const logFd = openDaemonLogFd();
  const child = spawn(process.execPath, [daemonEntryPath], {
    detached: true,
    stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
  });
  child.unref();
  if (logFd !== null) {
    fs.closeSync(logFd);
  }
  return child;
}

/**
 * Read the rolling daemon start history (epoch ms timestamps, oldest first).
 * Missing or malformed files read as an empty history.
 *
 * @param {string} [historyPath=getDaemonStartHistoryPath()]
 * @returns {Promise<number[]>}
 */
export async function readDaemonStartHistory(historyPath = getDaemonStartHistoryPath()) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(historyPath, 'utf8'));
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (value) => typeof value === 'number' && Number.isFinite(value) && value > 0
    );
  } catch {
    return [];
  }
}

/**
 * Append a daemon start timestamp to the rolling history. Best-effort: any
 * filesystem failure is swallowed so an unwritable bridge dir never prevents
 * the daemon from starting.
 *
 * @param {{ at?: number, historyPath?: string }} [options={}]
 * @returns {Promise<number[]>} the updated history (empty when persisting failed)
 */
export async function recordDaemonStart(options = {}) {
  const { at = Date.now(), historyPath = getDaemonStartHistoryPath() } = options;
  try {
    const history = [...(await readDaemonStartHistory(historyPath)), at].slice(
      -DAEMON_START_HISTORY_MAX_ENTRIES
    );
    await fs.promises.mkdir(path.dirname(historyPath), { recursive: true });
    await fs.promises.writeFile(historyPath, `${JSON.stringify(history)}\n`, 'utf8');
    return history;
  } catch {
    return [];
  }
}

/**
 * Summarize the daemon start history over the recent window so callers can
 * tell a crash-looping daemon apart from a normal restart.
 *
 * @param {number[]} history
 * @param {{ now?: number, windowMs?: number, threshold?: number }} [options={}]
 * @returns {{ startsInWindow: number, windowMs: number, restartLoop: boolean }}
 */
export function summarizeDaemonRestarts(history, options = {}) {
  const {
    now = Date.now(),
    windowMs = DAEMON_RESTART_LOOP_WINDOW_MS,
    threshold = DAEMON_RESTART_LOOP_THRESHOLD,
  } = options;
  const startsInWindow = history.filter((at) => at <= now && now - at <= windowMs).length;
  return {
    startsInWindow,
    windowMs,
    restartLoop: startsInWindow >= threshold,
  };
}

/**
 * @param {number} [pid=process.pid]
 * @param {string} [pidPath=getDaemonPidPath()]
 * @returns {Promise<void>}
 */
export async function writeDaemonPidFile(pid = process.pid, pidPath = getDaemonPidPath()) {
  await fs.promises.mkdir(path.dirname(pidPath), { recursive: true });
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
 * @returns {Promise<{ transport: string, socketPath: string, previouslyRunning: boolean, previousPid: number | null, removedStaleSocket: boolean }>}
 */
export async function stopBridgeDaemon(options = {}) {
  const {
    transport = undefined,
    socketPath = undefined,
    pidPath = getDaemonPidPath(),
    timeoutMs = DEFAULT_DAEMON_RESTART_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_DAEMON_POLL_INTERVAL_MS,
    pingDaemonFn = pingExistingDaemon,
    readPidFn = readDaemonPidFile,
    findPidByTransportFn = findDaemonPidByTransport,
    killFn = process.kill.bind(process),
    rmFn = fs.promises.rm,
    sleepFn = sleep,
  } = options;
  const resolvedTransport = resolveDaemonTransport({ transport, socketPath });
  const resolvedSocketPath =
    resolvedTransport.type === 'socket' ? resolvedTransport.socketPath : '';

  const pidFromFile = await readPidFn(pidPath);
  const reachable = await safePingDaemon(resolvedTransport, pingDaemonFn);
  const endpointOwnerPid =
    pidFromFile !== null || reachable ? await findPidByTransportFn(resolvedTransport) : null;
  /** @type {number | null} */
  let previousPid = null;
  let previouslyRunning = false;

  if (endpointOwnerPid !== null) {
    previousPid = endpointOwnerPid;
    previouslyRunning = true;
  } else if (reachable) {
    // TCP endpoints do not expose an owner pid. In that case daemon
    // reachability is the evidence supporting the recorded pid.
    previousPid = pidFromFile;
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

    let stopped = await waitForDaemonReachability({
      transport: resolvedTransport,
      reachable: false,
      timeoutMs,
      pollIntervalMs,
      pingDaemonFn,
      sleepFn,
    });
    if (!stopped) {
      // Endpoint ownership may become discoverable after a recorded daemon pid
      // fails to stop. Only target the verified owner before giving up.
      const socketOwnerPid = await findPidByTransportFn(resolvedTransport);
      if (socketOwnerPid !== null && socketOwnerPid !== previousPid) {
        try {
          killFn(socketOwnerPid, 'SIGTERM');
        } catch (error) {
          if (!isMissingProcessError(error)) {
            throw error;
          }
        }
        stopped = await waitForDaemonReachability({
          transport: resolvedTransport,
          reachable: false,
          timeoutMs,
          pollIntervalMs,
          pingDaemonFn,
          sleepFn,
        });
        if (stopped) {
          previousPid = socketOwnerPid;
        }
      }
    }
    if (!stopped) {
      throw new Error(`Timed out waiting for Browser Bridge daemon (pid ${previousPid}) to stop.`);
    }
  }

  await clearDaemonPidFile({ pid: pidFromFile ?? previousPid, pidPath, rmFn });

  const removedStaleSocket = await removeStaleSocket(resolvedTransport, rmFn, pingDaemonFn);
  return {
    transport: formatBridgeTransport(resolvedTransport),
    socketPath: resolvedSocketPath,
    previouslyRunning,
    previousPid,
    removedStaleSocket,
  };
}

/**
 * @param {RestartBridgeDaemonOptions} [options={}]
 * @returns {Promise<{
 *   transport: string,
 *   socketPath: string,
 *   pidPath: string,
 *   pid: number | null,
 *   previouslyRunning: boolean,
 *   previousPid: number | null,
 *   removedStaleSocket: boolean,
 * }>}
 */
export async function restartBridgeDaemon(options = {}) {
  const stopResult = await stopBridgeDaemon(options);
  return restartBridgeDaemonAfterStop(stopResult, options);
}

/**
 * Restart the daemon only when one is already running. This is useful during
 * package upgrades where the launcher changed and the in-memory daemon should
 * pick up the new install, without eagerly starting a fresh background process.
 *
 * @param {RestartBridgeDaemonOptions} [options={}]
 * @returns {Promise<{
 *   transport: string,
 *   socketPath: string,
 *   pidPath: string,
 *   pid: number | null,
 *   previouslyRunning: boolean,
 *   previousPid: number | null,
 *   removedStaleSocket: boolean,
 * } | null>}
 */
export async function restartBridgeDaemonIfRunning(options = {}) {
  const stopResult = await stopBridgeDaemon(options);
  if (!stopResult.previouslyRunning) {
    return null;
  }
  return restartBridgeDaemonAfterStop(stopResult, options);
}

/**
 * @param {Awaited<ReturnType<typeof stopBridgeDaemon>>} stopResult
 * @param {RestartBridgeDaemonOptions} [options={}]
 * @returns {Promise<{
 *   transport: string,
 *   socketPath: string,
 *   pidPath: string,
 *   pid: number | null,
 *   previouslyRunning: boolean,
 *   previousPid: number | null,
 *   removedStaleSocket: boolean,
 * }>}
 */
async function restartBridgeDaemonAfterStop(stopResult, options = {}) {
  const {
    transport = undefined,
    socketPath = undefined,
    pidPath = getDaemonPidPath(),
    timeoutMs = DEFAULT_DAEMON_RESTART_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_DAEMON_POLL_INTERVAL_MS,
    pingDaemonFn = pingExistingDaemon,
    readPidFn = readDaemonPidFile,
    sleepFn = sleep,
    spawnDaemonFn = spawnBridgeDaemonProcess,
  } = options;
  const resolvedTransport = resolveDaemonTransport({ transport, socketPath });

  spawnDaemonFn();

  const started = await waitForDaemonReachability({
    transport: resolvedTransport,
    reachable: true,
    timeoutMs,
    pollIntervalMs,
    pingDaemonFn,
    sleepFn,
  });
  if (!started) {
    throw new Error('Timed out waiting for Browser Bridge daemon to start.');
  }

  let pid = await readPidFn(pidPath);
  if (pid === null) {
    // The daemon starts listening immediately before it persists its PID.
    await sleepFn(pollIntervalMs);
    pid = await readPidFn(pidPath);
  }

  return {
    ...stopResult,
    pidPath,
    pid,
  };
}

/**
 * Mirror the daemon entrypoint transport defaults so restart polling targets the
 * same endpoint the spawned process listens on.
 *
 * @param {{ transport?: BridgeTransport, socketPath?: string }} options
 * @returns {BridgeTransport}
 */
function resolveDaemonTransport(options) {
  const { transport, socketPath } = options;
  if (socketPath) {
    return createSocketBridgeTransport(socketPath);
  }
  if (transport) {
    return transport;
  }

  const env = { ...process.env };
  applyWindowsTcpTransportDefaults(env);
  return getBridgeTransport(env);
}

/**
 * @param {BridgeTransport} transport
 * @returns {Promise<number | null>}
 */
export async function findDaemonPidByTransport(transport) {
  if (transport.type !== 'socket') {
    return null;
  }
  return findDaemonPidBySocket(transport.socketPath);
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
 *   transport: BridgeTransport,
 *   reachable: boolean,
 *   timeoutMs: number,
 *   pollIntervalMs: number,
 *   pingDaemonFn: (transport: BridgeTransport) => Promise<boolean>,
 *   sleepFn: (ms: number) => Promise<void>,
 * }} options
 * @returns {Promise<boolean>}
 */
async function waitForDaemonReachability(options) {
  const { transport, reachable, timeoutMs, pollIntervalMs, pingDaemonFn, sleepFn } = options;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if ((await safePingDaemon(transport, pingDaemonFn)) === reachable) {
      return true;
    }
    await sleepFn(pollIntervalMs);
  }
  return false;
}

/**
 * @param {BridgeTransport} transport
 * @param {typeof fs.promises.rm} rmFn
 * @param {(transport: BridgeTransport) => Promise<boolean>} pingDaemonFn
 * @returns {Promise<boolean>}
 */
async function removeStaleSocket(transport, rmFn, pingDaemonFn) {
  if (transport.type !== 'socket') {
    return false;
  }

  if (await safePingDaemon(transport, pingDaemonFn)) {
    return false;
  }

  try {
    await fs.promises.access(transport.socketPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }

  try {
    await rmFn(transport.socketPath, { force: true });
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * @param {BridgeTransport} transport
 * @param {(transport: BridgeTransport) => Promise<boolean>} pingDaemonFn
 * @returns {Promise<boolean>}
 */
async function safePingDaemon(transport, pingDaemonFn) {
  try {
    return await pingDaemonFn(transport);
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
