import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { withTempSocketPath } from '../_helpers/socketHarness.ts';
import { isolatedBridgeEnv, nativeExecutable, runCli } from '../_helpers/runCli.ts';

async function stop(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  const force = setTimeout(() => child.kill('SIGKILL'), 3_000);
  try {
    await exited;
  } finally {
    clearTimeout(force);
  }
}

test(
  'Go daemon rebinds the local transport after a crash, including Windows named pipes',
  { timeout: 15_000 },
  async () => {
    await withTempSocketPath(async ({ bridgeHome, socketPath }) => {
      const env = isolatedBridgeEnv({ ...process.env, BROWSER_BRIDGE_HOME: bridgeHome });
      const children: ChildProcessWithoutNullStreams[] = [];
      let diagnostics = '';
      async function launch() {
        const child = spawn(nativeExecutable, ['--bridge-daemon'], { env, stdio: 'pipe' });
        children.push(child);
        let startupError: Error | undefined;
        child.on('error', (error) => {
          startupError = error;
        });
        child.stdout.resume();
        child.stderr.on('data', (chunk: Buffer) => {
          diagnostics += chunk.toString();
        });
        for (let attempt = 0; attempt < 100; attempt++) {
          if (startupError) throw startupError;
          assert.equal(child.exitCode, null, diagnostics);
          const result = await runCli({ args: ['call', 'health.ping'], env });
          if (result.status === 0) {
            assert.equal((result.json as { daemon: string }).daemon, 'ok');
            return child;
          }
          await delay(20);
        }
        throw new Error(`Go daemon did not bind ${socketPath}: ${diagnostics}`);
      }
      try {
        const first = await launch();
        if (process.platform !== 'win32')
          assert.equal((await fs.stat(socketPath)).isSocket(), true);
        await stop(first, 'SIGKILL');
        if (process.platform !== 'win32')
          assert.equal((await fs.stat(socketPath)).isSocket(), true);
        await launch();
      } finally {
        for (const child of children) await stop(child);
      }
    });
  }
);

test(
  'Go daemon preserves a regular file at its Unix socket path',
  { skip: process.platform === 'win32', timeout: 10_000 },
  async () => {
    await withTempSocketPath(async ({ bridgeHome, socketPath }) => {
      await fs.writeFile(socketPath, 'not a stale socket');
      const result = await runCli({
        args: ['--bridge-daemon'],
        env: isolatedBridgeEnv({ ...process.env, BROWSER_BRIDGE_HOME: bridgeHome }),
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /not a socket/);
      assert.equal(await fs.readFile(socketPath, 'utf8'), 'not a stale socket');
    });
  }
);
