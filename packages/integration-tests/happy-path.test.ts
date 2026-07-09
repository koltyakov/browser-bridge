import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ChildProcess, ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { BridgeClient } from '../agent-client/src/client.js';
import { pingExistingDaemon } from '../native-host/src/daemon.js';
import { createNativeMessageReader } from '../native-host/src/framing.js';
import {
  createSuccess,
  MAX_NATIVE_MESSAGE_BYTES,
  PROTOCOL_VERSION,
} from '../protocol/src/index.js';
import { frameNativeMessage } from '../../tests/_helpers/nativeMessaging.ts';
import { withTempSocketPath } from '../../tests/_helpers/socketHarness.ts';
import type { BridgeRequest } from '../../packages/protocol/src/types.js';

type ProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type DaemonHarness = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  getStdout: () => string;
  getStderr: () => string;
};

type ProcessExit = { code: number | null; signal: NodeJS.Signals | null };

type NativeHostHarness = {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  requests: BridgeRequest[];
  messages: unknown[];
  protocolErrors: Error[];
  getStderr: () => string;
  send: (message: unknown) => Promise<void>;
};

type NativeHostHarnessOptions = {
  healthResult?: Record<string, unknown>;
  skipAutoResponses?: string[];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const bridgeDaemonPath = path.resolve(__dirname, '../native-host/bin/bridge-daemon.js');
const nativeHostPath = path.resolve(__dirname, '../native-host/bin/native-host.js');
const cliPath = path.resolve(__dirname, '../agent-client/src/cli.js');

/**
 * Assert that the daemon's stderr contains only structured log lines (or is
 * empty). The daemon writes NDJSON log entries to stderr; each line must be
 * valid JSON with a recognized `level` field.
 *
 */
function assertDaemonStderrClean(stderr: string): void {
  if (stderr === '') {
    return;
  }
  for (const line of stderr.split('\n').filter(Boolean)) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      assert.fail(`non-JSON line in daemon stderr: ${line}`);
    }
    const record = entry as Record<string, unknown>;
    assert.ok(
      record.level === 'info' ||
        record.level === 'warn' ||
        record.level === 'error' ||
        record.level === 'debug',
      `unexpected log level in daemon stderr: ${line}`
    );
  }
}

function getForwardedRequest(message: unknown): BridgeRequest | null {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const record = message as Record<string, unknown>;
  if (
    record.type === 'host.bridge_request' &&
    record.request &&
    typeof record.request === 'object'
  ) {
    return record.request as BridgeRequest;
  }

  if (typeof record.id === 'string' && typeof record.method === 'string') {
    return record as unknown as BridgeRequest;
  }

  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function spawnBridgeDaemon(env: NodeJS.ProcessEnv): DaemonHarness {
  const child = spawn(process.execPath, [bridgeDaemonPath], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  return {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

function spawnNativeHost(
  env: NodeJS.ProcessEnv,
  options: NativeHostHarnessOptions = {}
): NativeHostHarness {
  const child = spawn(process.execPath, [nativeHostPath], {
    cwd: repoRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const skippedAutoResponses = new Set(options.skipAutoResponses ?? []);
  const requests: BridgeRequest[] = [];
  const messages: unknown[] = [];
  const protocolErrors: Error[] = [];
  let stderr = '';

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  createNativeMessageReader(
    child.stdout,
    (message) => {
      messages.push(message);
      void (async () => {
        const request = getForwardedRequest(message);
        if (!request) {
          return;
        }

        requests.push(request);

        if (request.method === 'health.ping') {
          if (skippedAutoResponses.has(request.method)) {
            return;
          }
          await send(
            createSuccess(
              request.id,
              {
                extension: 'ok',
                access: {
                  enabled: true,
                  routeReady: true,
                  routeTabId: 42,
                  windowId: 7,
                },
                ...options.healthResult,
              },
              { method: request.method }
            )
          );
          return;
        }

        if (request.method === 'tabs.list') {
          if (skippedAutoResponses.has(request.method)) {
            return;
          }
          await send(
            createSuccess(
              request.id,
              {
                tabs: [
                  {
                    tabId: 42,
                    active: true,
                    origin: 'https://example.com',
                    title: 'Example Domain',
                  },
                ],
              },
              { method: request.method }
            )
          );
        }
      })().catch((error) => {
        protocolErrors.push(error instanceof Error ? error : new Error(String(error)));
      });
    },
    (error) => {
      protocolErrors.push(error);
    }
  );

  async function send(message: unknown): Promise<void> {
    const frame = frameNativeMessage(message);
    if (!child.stdin.write(frame)) {
      await once(child.stdin, 'drain');
    }
  }

  return {
    child,
    requests,
    messages,
    protocolErrors,
    getStderr: () => stderr,
    send,
  };
}

async function waitForDaemonReady(daemon: DaemonHarness, socketPath: string): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) {
      throw new Error(
        `bridge-daemon exited before becoming ready (code=${daemon.child.exitCode}, signal=${daemon.child.signalCode})\nstdout:\n${daemon.getStdout()}\nstderr:\n${daemon.getStderr()}`
      );
    }
    if (await pingExistingDaemon(socketPath)) {
      return;
    }
    await delay(50);
  }

  throw new Error(
    `Timed out waiting for bridge-daemon to listen on ${socketPath}\nstdout:\n${daemon.getStdout()}\nstderr:\n${daemon.getStderr()}`
  );
}

async function waitForExtensionConnected(
  socketPath: string,
  nativeHost: NativeHostHarness
): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    if (nativeHost.child.exitCode !== null || nativeHost.child.signalCode !== null) {
      throw new Error(
        `native-host exited before the extension registered (code=${nativeHost.child.exitCode}, signal=${nativeHost.child.signalCode})\nstderr:\n${nativeHost.getStderr()}`
      );
    }

    const client = new BridgeClient({ socketPath, defaultTimeoutMs: 1_000 });
    try {
      await client.connect();
      const response = await client.request({ method: 'health.ping' });
      const result =
        response.ok && response.result && typeof response.result === 'object'
          ? (response.result as Record<string, unknown>)
          : null;
      await client.close();
      if (result?.extensionConnected === true) {
        return;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await client.close().catch(() => {});
    }

    await delay(50);
  }

  throw new Error(
    `Timed out waiting for the native-host extension bridge to register\nstderr:\n${nativeHost.getStderr()}${lastError ? `\nlastError:\n${lastError.message}` : ''}`
  );
}

async function waitForForwardedRequest(
  nativeHost: NativeHostHarness,
  method: string
): Promise<BridgeRequest> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const request = nativeHost.requests.find((entry) => entry.method === method);
    if (request) {
      return request;
    }

    if (nativeHost.child.exitCode !== null || nativeHost.child.signalCode !== null) {
      throw new Error(
        `native-host exited before forwarding ${method}\nstderr:\n${nativeHost.getStderr()}`
      );
    }

    await delay(20);
  }

  throw new Error(
    `Timed out waiting for native-host to forward ${method}\nstderr:\n${nativeHost.getStderr()}`
  );
}

async function waitForProcessExit(
  child: ChildProcess,
  label: string,
  getOutput: () => string
): Promise<ProcessExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  return await new Promise<ProcessExit>((resolve, reject) => {
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

async function writeNativeFrame(stdin: Writable, frame: Buffer): Promise<void> {
  if (!stdin.write(frame)) {
    await once(stdin, 'drain');
  }
}

test(
  'bbx call tabs.list round-trips through bridge-daemon and native-host',
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
        const daemon = spawnBridgeDaemon(env);
        const nativeHost = spawnNativeHost(env);

        try {
          await waitForDaemonReady(daemon, socketPath);
          await waitForExtensionConnected(socketPath, nativeHost);

          const cliResult = await runCli(['call', 'tabs.list'], env);
          const payload = JSON.parse(cliResult.stdout.trim());
          const cliRequest = nativeHost.requests.find(
            (request) => request.method === 'tabs.list' && request.meta?.source === 'cli'
          );

          assert.equal(cliResult.code, 0);
          assert.equal(cliResult.signal, null);
          assert.equal(cliResult.stderr, '');
          assert.deepEqual(payload, {
            tabs: [
              {
                tabId: 42,
                active: true,
                origin: 'https://example.com',
                title: 'Example Domain',
              },
            ],
          });
          assert.ok(cliRequest, 'expected native-host to forward a tabs.list request from the CLI');
          assert.equal(cliRequest.meta?.protocol_version, PROTOCOL_VERSION);
          assert.equal(cliRequest.meta?.source, 'cli');
          assert.equal(cliRequest.tab_id, null);
          assert.equal(
            nativeHost.requests.some((request) => request.method === 'health.ping'),
            true,
            'expected the agent handshake to issue a health.ping before the CLI call'
          );
          assert.deepEqual(nativeHost.protocolErrors, []);
          assert.equal(nativeHost.getStderr(), '');
          assertDaemonStderrClean(daemon.getStderr());
        } finally {
          nativeHost.child.stdin.end();
          const nativeHostExit = await waitForProcessExit(
            nativeHost.child,
            'native-host',
            () => `stderr:\n${nativeHost.getStderr()}`
          );
          assert.equal(nativeHostExit.signal, null);
          assert.equal(nativeHostExit.code, 0);

          daemon.child.kill('SIGTERM');
          const daemonExit = await waitForProcessExit(
            daemon.child,
            'bridge-daemon',
            () => `stdout:\n${daemon.getStdout()}\nstderr:\n${daemon.getStderr()}`
          );
          assert.equal(daemonExit.signal, null);
          assert.equal(daemonExit.code, 0);
        }
      },
      { prefix: 'bbx-it-happy-path-' }
    );
  }
);

test(
  'BridgeClient attaches a protocol warning when the extension advertises only older supported versions',
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
        const daemon = spawnBridgeDaemon(env);
        const nativeHost = spawnNativeHost(env, {
          healthResult: {
            supported_versions: ['0.9'],
          },
        });

        try {
          await waitForDaemonReady(daemon, socketPath);
          await waitForExtensionConnected(socketPath, nativeHost);

          const client = new BridgeClient({ socketPath, defaultTimeoutMs: 500 });
          try {
            await client.connect();
            const response = await client.request({
              method: 'tabs.list',
              meta: { source: 'cli' },
            });

            assert.equal(response.ok, true);
            assert.deepEqual(response.result, {
              tabs: [
                {
                  tabId: 42,
                  active: true,
                  origin: 'https://example.com',
                  title: 'Example Domain',
                },
              ],
            });
            assert.match(
              String(response.meta?.protocol_warning ?? ''),
              new RegExp(
                `Protocol mismatch: client speaks ${PROTOCOL_VERSION.replace('.', '\\.')} but remote supports \\[0\\.9\\]`
              )
            );
          } finally {
            await client.close().catch(() => {});
          }

          const forwardedRequest = nativeHost.requests.find(
            (request) => request.method === 'tabs.list' && request.meta?.source === 'cli'
          );

          assert.ok(
            forwardedRequest,
            'expected BridgeClient to forward a tabs.list request after protocol negotiation'
          );
          assert.deepEqual(nativeHost.protocolErrors, []);
          assert.equal(nativeHost.getStderr(), '');
          assertDaemonStderrClean(daemon.getStderr());
        } finally {
          nativeHost.child.stdin.end();
          const nativeHostExit = await waitForProcessExit(
            nativeHost.child,
            'native-host',
            () => `stderr:\n${nativeHost.getStderr()}`
          );
          assert.equal(nativeHostExit.signal, null);
          assert.equal(nativeHostExit.code, 0);

          daemon.child.kill('SIGTERM');
          const daemonExit = await waitForProcessExit(
            daemon.child,
            'bridge-daemon',
            () => `stdout:\n${daemon.getStdout()}\nstderr:\n${daemon.getStderr()}`
          );
          assert.equal(daemonExit.signal, null);
          assert.equal(daemonExit.code, 0);
        }
      },
      { prefix: 'bbx-it-protocol-warning-' }
    );
  }
);

test(
  'BridgeClient receives EXTENSION_DISCONNECTED when the native-host drops mid-flight',
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
        const daemon = spawnBridgeDaemon(env);
        const nativeHost = spawnNativeHost(env, {
          skipAutoResponses: ['tabs.list'],
        });

        try {
          await waitForDaemonReady(daemon, socketPath);
          await waitForExtensionConnected(socketPath, nativeHost);

          const client = new BridgeClient({ socketPath, defaultTimeoutMs: 1_000 });
          try {
            await client.connect();
            const responsePromise = client.request({
              method: 'tabs.list',
              meta: { source: 'cli' },
            });

            const forwardedRequest = await waitForForwardedRequest(nativeHost, 'tabs.list');
            assert.equal(forwardedRequest.meta?.source, 'cli');

            nativeHost.child.stdin.end();

            const response = await responsePromise;
            assert.equal(response.ok, false);
            assert.equal(response.error?.code, 'EXTENSION_DISCONNECTED');
            assert.match(String(response.error?.message ?? ''), /disconnected/i);
            assert.equal(response.meta?.method, 'tabs.list');
          } finally {
            await client.close().catch(() => {});
          }

          assert.deepEqual(nativeHost.protocolErrors, []);
          assert.equal(nativeHost.getStderr(), '');
          assertDaemonStderrClean(daemon.getStderr());
        } finally {
          nativeHost.child.stdin.end();
          const nativeHostExit = await waitForProcessExit(
            nativeHost.child,
            'native-host',
            () => `stderr:\n${nativeHost.getStderr()}`
          );
          assert.equal(nativeHostExit.signal, null);
          assert.equal(nativeHostExit.code, 0);

          daemon.child.kill('SIGTERM');
          const daemonExit = await waitForProcessExit(
            daemon.child,
            'bridge-daemon',
            () => `stdout:\n${daemon.getStdout()}\nstderr:\n${daemon.getStderr()}`
          );
          assert.equal(daemonExit.signal, null);
          assert.equal(daemonExit.code, 0);
        }
      },
      { prefix: 'bbx-it-extension-disconnect-' }
    );
  }
);

test(
  'bridge-daemon recovers after an extension sends an oversized native-messaging frame',
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
        const daemon = spawnBridgeDaemon(env);
        const nativeHost = spawnNativeHost(env);
        let recoveredNativeHost: NativeHostHarness | null = null;
        let initialNativeHostExited = false;

        try {
          await waitForDaemonReady(daemon, socketPath);
          await waitForExtensionConnected(socketPath, nativeHost);

          const oversizeHeader = Buffer.alloc(4);
          oversizeHeader.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1, 0);
          await writeNativeFrame(nativeHost.child.stdin, oversizeHeader);

          const nativeHostExit = await waitForProcessExit(
            nativeHost.child,
            'native-host after oversized frame',
            () => `stderr:\n${nativeHost.getStderr()}`
          );
          initialNativeHostExited = true;
          assert.equal(nativeHostExit.signal, null);
          assert.equal(nativeHostExit.code, 0);

          const daemonStillHealthy = await pingExistingDaemon(socketPath);
          assert.equal(daemonStillHealthy, true);

          recoveredNativeHost = spawnNativeHost(env);
          await waitForExtensionConnected(socketPath, recoveredNativeHost);

          const cliResult = await runCli(['call', 'tabs.list'], env);
          const payload = JSON.parse(cliResult.stdout.trim());

          assert.equal(cliResult.code, 0);
          assert.equal(cliResult.signal, null);
          assert.equal(cliResult.stderr, '');
          assert.deepEqual(payload, {
            tabs: [
              {
                tabId: 42,
                active: true,
                origin: 'https://example.com',
                title: 'Example Domain',
              },
            ],
          });
          assert.deepEqual(recoveredNativeHost.protocolErrors, []);
          assert.equal(recoveredNativeHost.getStderr(), '');
          assertDaemonStderrClean(daemon.getStderr());
        } finally {
          if (!initialNativeHostExited) {
            nativeHost.child.stdin.end();
            const nativeHostExit = await waitForProcessExit(
              nativeHost.child,
              'native-host',
              () => `stderr:\n${nativeHost.getStderr()}`
            );
            assert.equal(nativeHostExit.signal, null);
            assert.equal(nativeHostExit.code, 0);
          }

          if (recoveredNativeHost) {
            recoveredNativeHost.child.stdin.end();
            const recoveredNativeHostExit = await waitForProcessExit(
              recoveredNativeHost.child,
              'recovered native-host',
              () => `stderr:\n${recoveredNativeHost?.getStderr() ?? ''}`
            );
            assert.equal(recoveredNativeHostExit.signal, null);
            assert.equal(recoveredNativeHostExit.code, 0);
          }

          daemon.child.kill('SIGTERM');
          const daemonExit = await waitForProcessExit(
            daemon.child,
            'bridge-daemon',
            () => `stdout:\n${daemon.getStdout()}\nstderr:\n${daemon.getStderr()}`
          );
          assert.equal(daemonExit.signal, null);
          assert.equal(daemonExit.code, 0);
        }
      },
      { prefix: 'bbx-it-oversized-frame-' }
    );
  }
);
