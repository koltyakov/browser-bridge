// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { pingExistingDaemon } from '../native-host/src/daemon.js';
import { withTempSocketPath } from '../../tests/_helpers/socketHarness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const bridgeDaemonPath = path.resolve(__dirname, '../native-host/bin/bridge-daemon.js');

/**
 * @param {import('node:child_process').ChildProcessByStdio<null, import('node:stream').Readable, import('node:stream').Readable>} child
 * @param {string} expectedSocketPath
 * @returns {Promise<void>}
 */
async function waitForDaemonReady(child, expectedSocketPath) {
  await new Promise((resolve, reject) => {
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

    /** @returns {void} */
    function cleanup() {
      clearTimeout(timeoutId);
      child.stdout.off('data', handleStdout);
      child.stderr.off('data', handleStderr);
      child.off('error', handleError);
      child.off('exit', handleExit);
    }

    /** @param {Buffer | string} chunk */
    function handleStdout(chunk) {
      stdout += chunk.toString();
      if (stdout.includes(`Browser Bridge daemon listening on ${expectedSocketPath}`)) {
        cleanup();
        resolve(undefined);
      }
    }

    /** @param {Buffer | string} chunk */
    function handleStderr(chunk) {
      stderr += chunk.toString();
    }

    /** @param {Error} error */
    function handleError(error) {
      cleanup();
      reject(error);
    }

    /** @param {number | null} code @param {NodeJS.Signals | null} signal */
    function handleExit(code, signal) {
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

/**
 * @param {import('node:child_process').ChildProcessByStdio<null, import('node:stream').Readable, import('node:stream').Readable>} child
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null }>}
 */
async function stopDaemon(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  const exitPromise = new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });

  child.kill('SIGTERM');
  return /** @type {Promise<{ code: number | null, signal: NodeJS.Signals | null }>} */ (
    exitPromise
  );
}

test(
  'bridge-daemon rebinds when the socket path exists without a live listener',
  {
    skip:
      process.platform === 'win32' ? 'Unix socket daemon test is not applicable on Windows' : false,
  },
  async () => {
    await withTempSocketPath(
      async ({ bridgeHome, socketPath }) => {
        await fs.promises.writeFile(socketPath, 'stale socket placeholder');

        const child = spawn(process.execPath, [bridgeDaemonPath], {
          cwd: repoRoot,
          env: {
            ...process.env,
            BROWSER_BRIDGE_HOME: bridgeHome,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        try {
          await waitForDaemonReady(child, socketPath);
          assert.equal(await pingExistingDaemon(socketPath), true);

          const socketStats = await fs.promises.stat(socketPath);
          assert.equal(socketStats.isSocket(), true);
        } finally {
          const { code, signal } = await stopDaemon(child);
          assert.equal(signal, null);
          assert.equal(code, 0);
        }
      },
      { prefix: 'bbx-it-stale-socket-' }
    );
  }
);
