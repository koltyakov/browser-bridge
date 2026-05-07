// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseJsonLines } from '../protocol/src/index.js';
import { withTempSocketPath } from '../../tests/_helpers/socketHarness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const bridgeDaemonPath = path.resolve(__dirname, '../native-host/bin/bridge-daemon.js');

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} label
 * @param {() => string} getOutput
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null }>}
 */
function waitForProcessExit(child, label, getOutput) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label} to exit\n${getOutput()}`));
    }, 5_000);

    function cleanup() {
      clearTimeout(timeoutId);
      child.off('error', handleError);
      child.off('exit', handleExit);
    }

    /** @param {Error} error */
    function handleError(error) {
      cleanup();
      reject(error);
    }

    /** @param {number | null} code @param {NodeJS.Signals | null} signal */
    function handleExit(code, signal) {
      cleanup();
      resolve({ code, signal });
    }

    child.once('error', handleError);
    child.once('exit', handleExit);
  });
}

/**
 * Send a raw JSON-line agent.request with a custom protocol_version and
 * return the parsed agent.response.
 *
 * @param {string} socketPath
 * @param {string} protocolVersion
 * @param {number} timeoutMs
 * @returns {Promise<Record<string, unknown>>}
 */
function sendHealthPingWithVersion(socketPath, protocolVersion, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for health.ping response`));
    }, timeoutMs);

    const socket = net.createConnection(socketPath, () => {
      socket.write(
        `${JSON.stringify({ type: 'register', role: 'agent', clientId: 'test_version_probe' })}\n`
      );
      socket.write(
        `${JSON.stringify({
          type: 'agent.request',
          request: {
            id: 'req_version_test',
            method: 'health.ping',
            params: {},
            meta: { protocol_version: protocolVersion },
          },
        })}\n`
      );
    });

    const messages = /** @type {Record<string, unknown>[]} */ ([]);

    parseJsonLines(socket, (message) => {
      const record = /** @type {Record<string, unknown>} */ (message);
      messages.push(record);

      if (
        record.type === 'agent.response' &&
        record.response &&
        typeof record.response === 'object'
      ) {
        clearTimeout(timeoutId);
        const response = /** @type {Record<string, unknown>} */ (record.response);
        socket.destroy();
        resolve(response);
      }
    });

    socket.on('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}

test(
  'daemon returns migration_hint when client sends a future protocol version',
  {
    skip:
      process.platform === 'win32' ? 'Unix socket daemon test is not applicable on Windows' : false,
  },
  async () => {
    await withTempSocketPath(
      async ({ bridgeHome, socketPath }) => {
        const env = {
          ...process.env,
          BROWSER_BRIDGE_HOME: bridgeHome,
        };

        const daemon = spawn(process.execPath, [bridgeDaemonPath], {
          cwd: repoRoot,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let daemonStdout = '';
        let daemonStderr = '';
        daemon.stdout.setEncoding('utf8');
        daemon.stderr.setEncoding('utf8');
        daemon.stdout.on('data', (chunk) => {
          daemonStdout += chunk;
        });
        daemon.stderr.on('data', (chunk) => {
          daemonStderr += chunk;
        });

        try {
          await delay(300);

          const response = await sendHealthPingWithVersion(socketPath, '99.0');

          assert.equal(response.ok, true);
          const result =
            response.result && typeof response.result === 'object'
              ? /** @type {Record<string, unknown>} */ (response.result)
              : null;
          assert.ok(result, 'expected response.result to be an object');

          assert.ok(Array.isArray(result.supported_versions), 'expected supported_versions array');
          assert.equal(
            typeof result.migration_hint,
            'string',
            'expected migration_hint string for future client version'
          );
          assert.match(
            /** @type {string} */ (result.migration_hint),
            /older than the client protocol 99\.0|daemon is older/i,
            'migration_hint should indicate daemon is older and suggest updating'
          );
        } finally {
          daemon.kill('SIGTERM');
          const exit = await waitForProcessExit(
            daemon,
            'bridge-daemon',
            () => `stdout:\n${daemonStdout}\nstderr:\n${daemonStderr}`
          );
          assert.equal(exit.signal, null);
          assert.equal(exit.code, 0);
        }
      },
      { prefix: 'bbx-it-version-mismatch-' }
    );
  }
);

test(
  'daemon returns migration_hint with deprecation notice when client sends an older protocol version',
  {
    skip:
      process.platform === 'win32' ? 'Unix socket daemon test is not applicable on Windows' : false,
  },
  async () => {
    await withTempSocketPath(
      async ({ bridgeHome, socketPath }) => {
        const env = {
          ...process.env,
          BROWSER_BRIDGE_HOME: bridgeHome,
        };

        const daemon = spawn(process.execPath, [bridgeDaemonPath], {
          cwd: repoRoot,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let daemonStdout = '';
        let daemonStderr = '';
        daemon.stdout.setEncoding('utf8');
        daemon.stderr.setEncoding('utf8');
        daemon.stdout.on('data', (chunk) => {
          daemonStdout += chunk;
        });
        daemon.stderr.on('data', (chunk) => {
          daemonStderr += chunk;
        });

        try {
          await delay(300);

          const response = await sendHealthPingWithVersion(socketPath, '0.5');

          assert.equal(response.ok, true);
          const result =
            response.result && typeof response.result === 'object'
              ? /** @type {Record<string, unknown>} */ (response.result)
              : null;
          assert.ok(result, 'expected response.result to be an object');

          assert.ok(Array.isArray(result.supported_versions), 'expected supported_versions array');
          assert.equal(
            typeof result.deprecated_since,
            'string',
            'expected deprecated_since string for deprecated client version'
          );
          assert.equal(
            typeof result.migration_hint,
            'string',
            'expected migration_hint string for deprecated client version'
          );
          assert.match(
            /** @type {string} */ (result.migration_hint),
            /newer than the client protocol 0\.5|update/i,
            'migration_hint should indicate client is outdated and suggest updating'
          );
        } finally {
          daemon.kill('SIGTERM');
          const exit = await waitForProcessExit(
            daemon,
            'bridge-daemon',
            () => `stdout:\n${daemonStdout}\nstderr:\n${daemonStderr}`
          );
          assert.equal(exit.signal, null);
          assert.equal(exit.code, 0);
        }
      },
      { prefix: 'bbx-it-version-deprecated-' }
    );
  }
);

test(
  'daemon returns no migration_hint when client sends the current protocol version',
  {
    skip:
      process.platform === 'win32' ? 'Unix socket daemon test is not applicable on Windows' : false,
  },
  async () => {
    await withTempSocketPath(
      async ({ bridgeHome, socketPath }) => {
        const env = {
          ...process.env,
          BROWSER_BRIDGE_HOME: bridgeHome,
        };

        const daemon = spawn(process.execPath, [bridgeDaemonPath], {
          cwd: repoRoot,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let daemonStdout = '';
        let daemonStderr = '';
        daemon.stdout.setEncoding('utf8');
        daemon.stderr.setEncoding('utf8');
        daemon.stdout.on('data', (chunk) => {
          daemonStdout += chunk;
        });
        daemon.stderr.on('data', (chunk) => {
          daemonStderr += chunk;
        });

        try {
          await delay(300);

          const response = await sendHealthPingWithVersion(socketPath, '1.0');

          assert.equal(response.ok, true);
          const result =
            response.result && typeof response.result === 'object'
              ? /** @type {Record<string, unknown>} */ (response.result)
              : null;
          assert.ok(result, 'expected response.result to be an object');

          assert.ok(Array.isArray(result.supported_versions), 'expected supported_versions array');
          assert.equal(
            result.migration_hint,
            undefined,
            'expected no migration_hint for current protocol version'
          );
          assert.equal(
            result.deprecated_since,
            undefined,
            'expected no deprecated_since for current protocol version'
          );
        } finally {
          daemon.kill('SIGTERM');
          const exit = await waitForProcessExit(
            daemon,
            'bridge-daemon',
            () => `stdout:\n${daemonStdout}\nstderr:\n${daemonStderr}`
          );
          assert.equal(exit.signal, null);
          assert.equal(exit.code, 0);
        }
      },
      { prefix: 'bbx-it-version-current-' }
    );
  }
);
