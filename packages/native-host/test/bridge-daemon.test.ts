import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { pingExistingDaemon } from '../src/daemon.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const bridgeDaemonPath = path.join(repoRoot, 'packages', 'native-host', 'bin', 'bridge-daemon.js');

type DaemonChild = ChildProcessByStdio<null, Readable, Readable>;
type ExitResult = { code: number | null; signal: NodeJS.Signals | null };
type ExitWithOutput = ExitResult & { stdout: string; stderr: string };

async function waitForDaemonReady(child: DaemonChild, expectedSocketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for bridge-daemon to listen on ${expectedSocketPath}\nstdout:\n${stdout}\nstderr:\n${stderr}`
        )
      );
    }, 5_000);

    function cleanup(): void {
      clearTimeout(timeoutId);
      child.stdout.off('data', handleStdout);
      child.stderr.off('data', handleStderr);
      child.off('error', handleError);
      child.off('exit', handleExit);
    }

    function handleStdout(chunk: Buffer | string): void {
      stdout += chunk.toString();
      if (stdout.includes(`Browser Bridge daemon listening on ${expectedSocketPath}`)) {
        cleanup();
        resolve(undefined);
      }
    }

    function handleStderr(chunk: Buffer | string): void {
      stderr += chunk.toString();
    }

    function handleError(error: Error): void {
      cleanup();
      reject(error);
    }

    function handleExit(code: number | null, signal: NodeJS.Signals | null): void {
      cleanup();
      reject(
        new Error(
          `bridge-daemon exited before becoming ready (code=${code}, signal=${signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`
        )
      );
    }

    child.stdout.on('data', handleStdout);
    child.stderr.on('data', handleStderr);
    child.on('error', handleError);
    child.on('exit', handleExit);
  });
}

async function stopDaemon(child: DaemonChild): Promise<ExitResult> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  const exitPromise = new Promise<ExitResult>((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });

  child.kill('SIGTERM');
  return exitPromise;
}

async function waitForExitWithOutput(child: DaemonChild): Promise<ExitWithOutput> {
  return await new Promise<ExitWithOutput>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for bridge-daemon to exit\nstdout:\n${stdout}\nstderr:\n${stderr}`
        )
      );
    }, 5_000);

    function cleanup(): void {
      clearTimeout(timeoutId);
      child.stdout.off('data', handleStdout);
      child.stderr.off('data', handleStderr);
      child.off('error', handleError);
      child.off('exit', handleExit);
    }

    function handleStdout(chunk: Buffer | string): void {
      stdout += chunk.toString();
    }

    function handleStderr(chunk: Buffer | string): void {
      stderr += chunk.toString();
    }

    function handleError(error: Error): void {
      cleanup();
      reject(error);
    }

    function handleExit(code: number | null, signal: NodeJS.Signals | null): void {
      cleanup();
      resolve({ code, signal, stdout, stderr });
    }

    child.stdout.on('data', handleStdout);
    child.stderr.on('data', handleStderr);
    child.on('error', handleError);
    child.on('exit', handleExit);
  });
}

test(
  'bridge-daemon honors BROWSER_BRIDGE_HOME',
  {
    skip:
      process.platform === 'win32' ? 'Unix socket daemon test is not applicable on Windows' : false,
  },
  async () => {
    const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-daemon-home-'));
    const expectedSocketPath = path.join(bridgeHome, 'bridge.sock');
    const expectedPidPath = path.join(bridgeHome, 'daemon.pid');
    const child = spawn(process.execPath, [bridgeDaemonPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeHome,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForDaemonReady(child, expectedSocketPath);
      assert.equal(await pingExistingDaemon(expectedSocketPath), true);
      await assert.doesNotReject(() => fs.promises.access(expectedSocketPath));
      const pid = Number.parseInt((await fs.promises.readFile(expectedPidPath, 'utf8')).trim(), 10);
      assert.equal(Number.isInteger(pid) && pid > 0, true);
    } finally {
      const { code, signal } = await stopDaemon(child);
      assert.equal(signal, null);
      assert.equal(code, 0);
      await assert.rejects(fs.promises.access(expectedPidPath));
      await fs.promises.rm(bridgeHome, { recursive: true, force: true });
    }
  }
);

test(
  'bridge-daemon exits cleanly when another daemon already owns the socket',
  {
    skip:
      process.platform === 'win32' ? 'Unix socket daemon test is not applicable on Windows' : false,
  },
  async () => {
    const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-daemon-single-'));
    const expectedSocketPath = path.join(bridgeHome, 'bridge.sock');
    const env = {
      ...process.env,
      BROWSER_BRIDGE_HOME: bridgeHome,
    };
    const first = spawn(process.execPath, [bridgeDaemonPath], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForDaemonReady(first, expectedSocketPath);

      const second = spawn(process.execPath, [bridgeDaemonPath], {
        cwd: repoRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const result = await waitForExitWithOutput(second);
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.match(result.stdout, /Another daemon is already running on/);
      assert.equal(result.stderr, '');
      assert.equal(await pingExistingDaemon(expectedSocketPath), true);
    } finally {
      const { code, signal } = await stopDaemon(first);
      assert.equal(signal, null);
      assert.equal(code, 0);
      await fs.promises.rm(bridgeHome, { recursive: true, force: true });
    }
  }
);

test(
  'bridge-daemon keeps running when the pid file is not writable and records start history',
  {
    skip:
      process.platform === 'win32'
        ? 'Unix socket daemon test is not applicable on Windows'
        : typeof process.getuid === 'function' && process.getuid() === 0
          ? 'File permissions are not enforced for root'
          : false,
  },
  async () => {
    const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-daemon-ropid-'));
    const expectedSocketPath = path.join(bridgeHome, 'bridge.sock');
    const pidPath = path.join(bridgeHome, 'daemon.pid');
    const startHistoryPath = path.join(bridgeHome, 'daemon-starts.json');
    // Simulate the sudo-install leftover: a pid file the daemon cannot overwrite.
    await fs.promises.writeFile(pidPath, '99999\n', { encoding: 'utf8', mode: 0o444 });
    const child = spawn(process.execPath, [bridgeDaemonPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeHome,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    try {
      await waitForDaemonReady(child, expectedSocketPath);
      assert.equal(await pingExistingDaemon(expectedSocketPath), true);
      assert.match(stderr, /Could not write daemon pid file/);
      assert.equal((await fs.promises.readFile(pidPath, 'utf8')).trim(), '99999');

      const history = JSON.parse(await fs.promises.readFile(startHistoryPath, 'utf8')) as number[];
      assert.equal(history.length, 1);
      assert.equal(typeof history[0], 'number');
    } finally {
      const { code, signal } = await stopDaemon(child);
      assert.equal(signal, null);
      assert.equal(code, 0);
      await fs.promises.chmod(pidPath, 0o644).catch(() => {});
      await fs.promises.rm(bridgeHome, { recursive: true, force: true });
    }
  }
);
