import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

import {
  clearDaemonPidFile,
  DAEMON_RESTART_LOOP_THRESHOLD,
  DAEMON_RESTART_LOOP_WINDOW_MS,
  findDaemonPidByTransport,
  openDaemonLogFd,
  readDaemonPidFile,
  readDaemonStartHistory,
  recordDaemonStart,
  restartBridgeDaemon,
  restartBridgeDaemonIfRunning,
  stopBridgeDaemon,
  summarizeDaemonRestarts,
  writeDaemonPidFile,
} from '../src/daemon-process.js';
import { BRIDGE_HOME_ENV, BRIDGE_TCP_PORT_ENV, DEFAULT_WINDOWS_TCP_PORT } from '../src/config.js';
import type { BridgeTransport } from '../src/config.js';

type KillCall = { pid: number; signal: string | number | undefined };

function childWithPid(pid: number): ChildProcess {
  return { pid } as unknown as ChildProcess;
}

async function withDefaultWindowsDaemonEnv(callback: () => Promise<void>): Promise<void> {
  const previousTcpPort = process.env[BRIDGE_TCP_PORT_ENV];
  const previousBridgeHome = process.env[BRIDGE_HOME_ENV];
  delete process.env[BRIDGE_TCP_PORT_ENV];
  delete process.env[BRIDGE_HOME_ENV];

  try {
    await callback();
  } finally {
    if (previousTcpPort === undefined) {
      delete process.env[BRIDGE_TCP_PORT_ENV];
    } else {
      process.env[BRIDGE_TCP_PORT_ENV] = previousTcpPort;
    }
    if (previousBridgeHome === undefined) {
      delete process.env[BRIDGE_HOME_ENV];
    } else {
      process.env[BRIDGE_HOME_ENV] = previousBridgeHome;
    }
  }
}

test('daemon pid helpers read, write, and clear the pid file', async () => {
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-daemon-pid-'));
  const pidPath = path.join(bridgeHome, 'daemon.pid');

  try {
    assert.equal(await readDaemonPidFile(pidPath), null);

    await writeDaemonPidFile(12345, pidPath);
    assert.equal(await readDaemonPidFile(pidPath), 12345);

    const nestedPidPath = path.join(bridgeHome, 'nested', 'state', 'daemon.pid');
    await writeDaemonPidFile(54321, nestedPidPath);
    assert.equal(await readDaemonPidFile(nestedPidPath), 54321);

    await clearDaemonPidFile({ pid: 99999, pidPath });
    assert.equal(await readDaemonPidFile(pidPath), 12345);

    await clearDaemonPidFile({ pid: 12345, pidPath });
    assert.equal(await readDaemonPidFile(pidPath), null);
  } finally {
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
});

test('daemon pid helpers ignore invalid pid files and missing cleanup targets', async () => {
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-daemon-pid-invalid-'));
  const pidPath = path.join(bridgeHome, 'daemon.pid');

  try {
    await fs.promises.writeFile(pidPath, 'not-a-pid\n', 'utf8');
    assert.equal(await readDaemonPidFile(pidPath), null);

    await clearDaemonPidFile({
      pidPath,
      rmFn: (async () => {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }) as typeof fs.promises.rm,
    });
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

test('restartBridgeDaemonIfRunning uses Windows tcp defaults when no transport override is provided', async () => {
  if (process.platform !== 'win32') {
    return;
  }

  await withDefaultWindowsDaemonEnv(async () => {
    const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-restart-daemon-win-'));
    const pidPath = path.join(bridgeHome, 'daemon.pid');
    const pingedTransports: BridgeTransport[] = [];
    let spawnCount = 0;
    let pid: number | null = null;

    try {
      const result = await restartBridgeDaemonIfRunning({
        pidPath,
        pingDaemonFn: async (transport) => {
          pingedTransports.push(transport);
          return pingedTransports.length === 1 ? true : pid !== null;
        },
        readPidFn: async () => pid,
        findPidByTransportFn: async () => 4247,
        killFn: (() => true) as typeof process.kill,
        spawnDaemonFn: () => {
          spawnCount += 1;
          pid = 4248;
          return childWithPid(pid);
        },
        sleepFn: async () => {},
      });

      assert.equal(spawnCount, 1);
      assert.equal(result?.transport, `127.0.0.1:${DEFAULT_WINDOWS_TCP_PORT}`);
      assert.equal(result?.socketPath, '');
      assert.equal(result?.previousPid, 4247);
      assert.equal(result?.pid, 4248);
      assert.equal(pingedTransports.length >= 2, true);
      assert.deepEqual(pingedTransports[0], {
        type: 'tcp',
        host: '127.0.0.1',
        port: DEFAULT_WINDOWS_TCP_PORT,
        label: `127.0.0.1:${DEFAULT_WINDOWS_TCP_PORT}`,
      });
    } finally {
      await fs.promises.rm(bridgeHome, { recursive: true, force: true });
    }
  });
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

test('restartBridgeDaemonIfRunning restarts when the daemon is reachable without a pid file', async () => {
  const bridgeHome = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'bbx-restart-daemon-running-')
  );
  const socketPath = path.join(bridgeHome, 'bridge.sock');
  const pidPath = path.join(bridgeHome, 'daemon.pid');
  let spawnCount = 0;
  let pingCount = 0;
  let pid: number | null = null;

  try {
    const result = await restartBridgeDaemonIfRunning({
      socketPath,
      pidPath,
      pingDaemonFn: async () => {
        pingCount += 1;
        return pingCount === 1 ? true : pid !== null;
      },
      readPidFn: async () => pid,
      findPidByTransportFn: async () => 4243,
      killFn: (() => true) as typeof process.kill,
      spawnDaemonFn: () => {
        spawnCount += 1;
        pid = 4244;
        return childWithPid(pid);
      },
      sleepFn: async () => {},
    });

    assert.equal(spawnCount, 1);
    assert.equal(result?.previouslyRunning, true);
    assert.equal(result?.previousPid, 4243);
    assert.equal(result?.pid, 4244);
  } finally {
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
});

test('stopBridgeDaemon ignores missing process errors and times out when daemon stays reachable', async () => {
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-stop-daemon-timeout-'));
  const socketPath = path.join(bridgeHome, 'bridge.sock');
  const pidPath = path.join(bridgeHome, 'daemon.pid');

  try {
    await assert.rejects(
      stopBridgeDaemon({
        socketPath,
        pidPath,
        timeoutMs: 0,
        pollIntervalMs: 0,
        pingDaemonFn: async () => true,
        readPidFn: async () => 4245,
        killFn: (() => {
          const error = new Error('missing process') as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        }) as typeof process.kill,
        sleepFn: async () => {},
      }),
      /Timed out waiting for Browser Bridge daemon/
    );
  } finally {
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
});

test('restartBridgeDaemon rejects when the daemon never becomes reachable', async () => {
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-restart-timeout-'));
  const socketPath = path.join(bridgeHome, 'bridge.sock');
  const pidPath = path.join(bridgeHome, 'daemon.pid');

  try {
    await assert.rejects(
      restartBridgeDaemon({
        socketPath,
        pidPath,
        timeoutMs: 0,
        pollIntervalMs: 0,
        pingDaemonFn: async () => false,
        readPidFn: async () => null,
        findPidByTransportFn: async () => null,
        spawnDaemonFn: () => childWithPid(4246),
        sleepFn: async () => {},
      }),
      /Timed out waiting for Browser Bridge daemon to start/
    );
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

test('daemon start history records, prunes, and reads timestamps', async () => {
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-daemon-starts-'));
  const historyPath = path.join(bridgeHome, 'daemon-starts.json');

  try {
    assert.deepEqual(await readDaemonStartHistory(historyPath), []);

    await recordDaemonStart({ at: 1_000, historyPath });
    const history = await recordDaemonStart({ at: 2_000, historyPath });
    assert.deepEqual(history, [1_000, 2_000]);
    assert.deepEqual(await readDaemonStartHistory(historyPath), [1_000, 2_000]);

    for (let index = 0; index < 25; index += 1) {
      await recordDaemonStart({ at: 10_000 + index, historyPath });
    }
    const pruned = await readDaemonStartHistory(historyPath);
    assert.equal(pruned.length, 20);
    assert.equal(pruned.at(-1), 10_024);

    await fs.promises.writeFile(historyPath, 'not-json', 'utf8');
    assert.deepEqual(await readDaemonStartHistory(historyPath), []);

    await fs.promises.writeFile(historyPath, '{"nope":true}', 'utf8');
    assert.deepEqual(await readDaemonStartHistory(historyPath), []);
  } finally {
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
});

test('recordDaemonStart swallows filesystem failures', async () => {
  const history = await recordDaemonStart({
    at: 1_000,
    historyPath: path.join(os.tmpdir(), `bbx-missing-${Date.now()}`, 'x', '\0invalid'),
  });
  assert.deepEqual(history, []);
});

test('summarizeDaemonRestarts detects a crash loop inside the window', () => {
  const now = 100_000_000;
  const calm = summarizeDaemonRestarts([now - DAEMON_RESTART_LOOP_WINDOW_MS - 1, now - 1_000], {
    now,
  });
  assert.equal(calm.restartLoop, false);
  assert.equal(calm.startsInWindow, 1);

  const looping = summarizeDaemonRestarts([now - 40_000, now - 20_000, now - 1_000], { now });
  assert.equal(looping.restartLoop, true);
  assert.equal(looping.startsInWindow, DAEMON_RESTART_LOOP_THRESHOLD);
  assert.equal(looping.windowMs, DAEMON_RESTART_LOOP_WINDOW_MS);

  const future = summarizeDaemonRestarts([now + 5_000, now - 1_000], { now });
  assert.equal(future.startsInWindow, 1);
});

test('openDaemonLogFd appends and rotates oversized logs', async () => {
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-daemon-log-'));
  const logPath = path.join(bridgeHome, 'nested', 'daemon.log');

  try {
    const fd = openDaemonLogFd(logPath);
    assert.notEqual(fd, null);
    fs.writeSync(fd as number, 'first\n');
    fs.closeSync(fd as number);
    assert.equal(await fs.promises.readFile(logPath, 'utf8'), 'first\n');

    await fs.promises.writeFile(logPath, 'x'.repeat(1024 * 1024 + 1), 'utf8');
    const rotatedFd = openDaemonLogFd(logPath);
    assert.notEqual(rotatedFd, null);
    fs.closeSync(rotatedFd as number);
    assert.equal((await fs.promises.stat(logPath)).size, 0);
    assert.equal((await fs.promises.stat(`${logPath}.1`)).size, 1024 * 1024 + 1);
  } finally {
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
});

test('stopBridgeDaemon falls back to the socket owner when the pid file is stale', async () => {
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-stop-daemon-stale-'));
  const socketPath = path.join(bridgeHome, 'bridge.sock');
  const pidPath = path.join(bridgeHome, 'daemon.pid');
  const kills: KillCall[] = [];
  let reachable = true;

  try {
    await fs.promises.writeFile(pidPath, '99999\n', 'utf8');

    const result = await stopBridgeDaemon({
      socketPath,
      pidPath,
      timeoutMs: 0,
      pollIntervalMs: 0,
      pingDaemonFn: async () => reachable,
      findPidByTransportFn: async () => 4321,
      killFn: ((pid, signal) => {
        kills.push({ pid, signal });
        if (pid === 99999) {
          const error = new Error('missing process') as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        }
        reachable = false;
        return true;
      }) as typeof process.kill,
      sleepFn: async () => {},
    });

    assert.deepEqual(kills, [
      { pid: 99999, signal: 'SIGTERM' },
      { pid: 4321, signal: 'SIGTERM' },
    ]);
    assert.equal(result.previouslyRunning, true);
    assert.equal(result.previousPid, 4321);
    await assert.rejects(fs.promises.access(pidPath));
  } finally {
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
});
