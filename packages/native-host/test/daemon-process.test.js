// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  clearDaemonPidFile,
  readDaemonPidFile,
  restartBridgeDaemon,
  stopBridgeDaemon,
  writeDaemonPidFile,
} from '../src/daemon-process.js';

test('daemon pid helpers read, write, and clear the pid file', async () => {
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-daemon-pid-'));
  const pidPath = path.join(bridgeHome, 'daemon.pid');

  try {
    assert.equal(await readDaemonPidFile(pidPath), null);

    await writeDaemonPidFile(12345, pidPath);
    assert.equal(await readDaemonPidFile(pidPath), 12345);

    await clearDaemonPidFile({ pid: 99999, pidPath });
    assert.equal(await readDaemonPidFile(pidPath), 12345);

    await clearDaemonPidFile({ pid: 12345, pidPath });
    assert.equal(await readDaemonPidFile(pidPath), null);
  } finally {
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
});

test('stopBridgeDaemon stops the recorded daemon pid and removes stale socket files', async () => {
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-stop-daemon-'));
  const socketPath = path.join(bridgeHome, 'bridge.sock');
  const pidPath = path.join(bridgeHome, 'daemon.pid');
  /** @type {Array<{ pid: number, signal: string | number | undefined }>} */
  const kills = [];

  try {
    await fs.promises.writeFile(socketPath, '', 'utf8');
    await fs.promises.writeFile(pidPath, '4242\n', 'utf8');

    const result = await stopBridgeDaemon({
      socketPath,
      pidPath,
      pingDaemonFn: async () => false,
      killFn: /** @type {typeof process.kill} */ (
        (pid, signal) => {
          kills.push({ pid, signal });
          return true;
        }
      ),
      sleepFn: async () => {},
    });

    assert.deepEqual(kills, [{ pid: 4242, signal: 'SIGTERM' }]);
    assert.equal(result.previouslyRunning, true);
    assert.equal(result.previousPid, 4242);
    assert.equal(result.removedStaleSocket, true);
    await assert.rejects(fs.promises.access(socketPath));
    await assert.rejects(fs.promises.access(pidPath));
  } finally {
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
});

test('restartBridgeDaemon starts a fresh daemon when none was running', async () => {
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-restart-daemon-'));
  const socketPath = path.join(bridgeHome, 'bridge.sock');
  const pidPath = path.join(bridgeHome, 'daemon.pid');
  let spawnCount = 0;
  let reachable = false;
  /** @type {number | null} */
  let pid = null;

  try {
    const result = await restartBridgeDaemon({
      socketPath,
      pidPath,
      pingDaemonFn: async () => reachable,
      readPidFn: async () => pid,
      findPidBySocketFn: async () => null,
      spawnDaemonFn: () => {
        spawnCount += 1;
        reachable = true;
        pid = 31337;
        return /** @type {import('node:child_process').ChildProcess} */ ({ pid });
      },
      sleepFn: async () => {},
    });

    assert.equal(spawnCount, 1);
    assert.equal(result.previouslyRunning, false);
    assert.equal(result.previousPid, null);
    assert.equal(result.pid, 31337);
    assert.equal(result.removedStaleSocket, false);
  } finally {
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
});
