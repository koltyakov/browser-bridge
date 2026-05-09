import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';

import { parseJsonLines } from '../protocol/src/index.js';
import { withTempSocketPath } from '../../tests/_helpers/socketHarness.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const bridgeDaemonPath = path.resolve(__dirname, '../native-host/bin/bridge-daemon.js');

type ProcessExit = { code: number | null; signal: NodeJS.Signals | null };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForProcessExit(
  child: ChildProcess,
  label: string,
  getOutput: () => string
): Promise<ProcessExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }

  return new Promise<ProcessExit>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label} to exit\n${getOutput()}`));
    }, 5_000);

    function cleanup(): void {
      clearTimeout(timeoutId);
      child.off('error', handleError);
      child.off('exit', handleExit);
    }

    function handleError(error: Error): void {
      cleanup();
      reject(error);
    }

    function handleExit(code: number | null, signal: NodeJS.Signals | null): void {
      cleanup();
      resolve({ code, signal });
    }

    child.once('error', handleError);
    child.once('exit', handleExit);
  });
}

function sendHealthPingWithVersion(
  socketPath: string,
  protocolVersion: string,
  timeoutMs = 3_000
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
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

    const messages: Record<string, unknown>[] = [];

    parseJsonLines(socket, (message) => {
      const record = message as Record<string, unknown>;
      messages.push(record);

      if (
        record.type === 'agent.response' &&
        record.response &&
        typeof record.response === 'object'
      ) {
        clearTimeout(timeoutId);
        const response = record.response as Record<string, unknown>;
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
              ? (response.result as Record<string, unknown>)
              : null;
          assert.ok(result, 'expected response.result to be an object');

          assert.ok(Array.isArray(result.supported_versions), 'expected supported_versions array');
          assert.equal(
            typeof result.migration_hint,
            'string',
            'expected migration_hint string for future client version'
          );
          assert.match(
            result.migration_hint as string,
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
              ? (response.result as Record<string, unknown>)
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
            result.migration_hint as string,
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
              ? (response.result as Record<string, unknown>)
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
