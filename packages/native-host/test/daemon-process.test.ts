import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

import {
  clearDaemonPidFile,
  findDaemonPidByTransport,
  readDaemonPidFile,
  restartBridgeDaemon,
  restartBridgeDaemonIfRunning,
  stopBridgeDaemon,
  writeDaemonPidFile,
} from '../src/daemon-process.js';
import type { BridgeTransport } from '../src/config.js';

type KillCall = { pid: number; signal: string | number | undefined };

function childWithPid(pid: number): ChildProcess {
  return { pid } as unknown as ChildProcess;
}

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
  const kills: KillCall[] = [];

  try {
    await fs.promises.writeFile(socketPath, '', 'utf8');
    await fs.promises.writeFile(pidPath, '4242\n', 'utf8');

    const result = await stopBridgeDaemon({
      socketPath,
      pidPath,
      pingDaemonFn: async () => false,
      killFn: ((pid, signal) => {
        kills.push({ pid, signal });
        return true;
      }) as typeof process.kill,
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
  let pid: number | null = null;

  try {
    const result = await restartBridgeDaemon({
      socketPath,
      pidPath,
      pingDaemonFn: async () => reachable,
      readPidFn: async () => pid,
      findPidByTransportFn: async () => null,
      spawnDaemonFn: () => {
        spawnCount += 1;
        reachable = true;
        pid = 31337;
        return childWithPid(pid);
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

test('restartBridgeDaemon supports tcp transport without stale socket cleanup', async () => {
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-restart-daemon-tcp-'));
  const pidPath = path.join(bridgeHome, 'daemon.pid');
  const transport: BridgeTransport = {
    type: 'tcp',
    host: '127.0.0.1',
    port: 9223,
    label: '127.0.0.1:9223',
  };
  let spawnCount = 0;
  let reachable = false;
  let pid: number | null = null;

  try {
    const result = await restartBridgeDaemon({
      transport,
      pidPath,
      pingDaemonFn: async () => reachable,
      readPidFn: async () => pid,
      findPidByTransportFn: async () => null,
      spawnDaemonFn: () => {
        spawnCount += 1;
        reachable = true;
        pid = 31338;
        return childWithPid(pid);
      },
      sleepFn: async () => {},
    });

    assert.equal(spawnCount, 1);
    assert.equal(result.transport, '127.0.0.1:9223');
    assert.equal(result.socketPath, '');
    assert.equal(result.previouslyRunning, false);
    assert.equal(result.previousPid, null);
    assert.equal(result.pid, 31338);
    assert.equal(result.removedStaleSocket, false);
  } finally {
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
});

test('restartBridgeDaemonIfRunning skips startup when the daemon is offline', async () => {
  const bridgeHome = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'bbx-restart-daemon-if-running-')
  );
  const socketPath = path.join(bridgeHome, 'bridge.sock');
  const pidPath = path.join(bridgeHome, 'daemon.pid');
  let spawnCount = 0;

  try {
    const result = await restartBridgeDaemonIfRunning({
      socketPath,
      pidPath,
      pingDaemonFn: async () => false,
      readPidFn: async () => null,
      findPidByTransportFn: async () => null,
      spawnDaemonFn: () => {
        spawnCount += 1;
        return childWithPid(31339);
      },
      sleepFn: async () => {},
    });

    assert.equal(result, null);
    assert.equal(spawnCount, 0);
  } finally {
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
});

test('findDaemonPidByTransport returns null for tcp transport', async () => {
  assert.equal(
    await findDaemonPidByTransport({
      type: 'tcp',
      host: '127.0.0.1',
      port: 9223,
      label: '127.0.0.1:9223',
    }),
    null
  );
});
