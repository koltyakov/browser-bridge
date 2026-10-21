#!/usr/bin/env node
// @ts-check
import { BridgeDaemon } from '../src/daemon.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  bundled,
  forwardToCompanion,
  getStandaloneLauncher,
} from '../../standalone/src/runtime.js';

if (!bundled) await forwardToCompanion(['--bridge-daemon']);
import {
  applyWindowsTcpTransportDefaults,
  formatBridgeTransport,
  getBridgeTransport,
} from '../src/config.js';
import { DaemonLogger } from '../src/daemon-logger.js';
import {
  clearDaemonPidFile,
  recordDaemonStart,
  writeDaemonPidFile,
  openDaemonLogFd,
} from '../src/daemon-process.js';

applyWindowsTcpTransportDefaults();
const transport = getBridgeTransport();
const daemon = new BridgeDaemon({ transport, logger: new DaemonLogger() });

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isExistingDaemonError(error) {
  return (
    error instanceof Error && error.message.startsWith('Another daemon is already running on ')
  );
}

try {
  await daemon.start();
} catch (error) {
  if (isExistingDaemonError(error)) {
    process.stdout.write(`${error.message}\n`);
    process.exit(0);
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

await recordDaemonStart();

try {
  await writeDaemonPidFile(process.pid);
} catch (error) {
  // A stale root-owned pid file (e.g. after a sudo install) must not take down
  // a daemon that is already listening; `bbx` falls back to endpoint-owner
  // discovery (lsof/ss on the socket, verified TCP listener lookup) for the pid.
  process.stderr.write(
    `Could not write daemon pid file: ${error instanceof Error ? error.message : String(error)}\n`
  );
}

process.stdout.write(`Browser Bridge daemon listening on ${formatBridgeTransport(transport)}\n`);

if (bundled) {
  let checking = false;
  /** @returns {void} */
  const check = () => {
    if (
      checking ||
      daemon.agentSockets.size ||
      daemon.pendingRequests.size ||
      daemon.activeHandlerCount
    )
      return;
    checking = true;
    const log = openDaemonLogFd();
    const child = spawn(getStandaloneLauncher(), ['--auto-update'], {
      detached: true,
      stdio: log === null ? 'ignore' : ['ignore', log, log],
      windowsHide: true,
    });
    child.once('exit', () => {
      checking = false;
    });
    child.once('error', () => {
      checking = false;
    });
    child.unref();
    if (log !== null) fs.closeSync(log);
  };
  setTimeout(check, 60_000 + Math.random() * 60_000).unref();
  setInterval(check, 60 * 60 * 1000).unref();
}

let shuttingDown = false;

/**
 * @returns {Promise<void>}
 */
async function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  try {
    await daemon.stop();
    await clearDaemonPidFile({ pid: process.pid });
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => {
    void shutdown();
  });
}

process.on('unhandledRejection', (reason) => {
  process.stderr.write(
    `Unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}\n`
  );
});

process.on('uncaughtException', (error) => {
  process.stderr.write(
    `Uncaught exception: ${error instanceof Error ? error.stack : String(error)}\n`
  );
  void shutdown();
});
