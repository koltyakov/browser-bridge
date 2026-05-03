// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { BridgeClient } from '../agent-client/src/client.js';
import { pingExistingDaemon } from '../native-host/src/daemon.js';
import { createNativeMessageReader } from '../native-host/src/framing.js';
import { createSuccess, MAX_NATIVE_MESSAGE_BYTES } from '../protocol/src/index.js';
import { frameNativeMessage } from '../../tests/_helpers/nativeMessaging.js';
import { withTempSocketPath } from '../../tests/_helpers/socketHarness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const bridgeDaemonPath = path.resolve(__dirname, '../native-host/bin/bridge-daemon.js');
const nativeHostPath = path.resolve(__dirname, '../native-host/bin/native-host.js');
const cliPath = path.resolve(__dirname, '../agent-client/src/cli.js');

/** @typedef {import('../../packages/protocol/src/types.js').BridgeRequest} BridgeRequest */

/**
 * @param {unknown} message
 * @returns {BridgeRequest | null}
 */
function getForwardedRequest(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const record = /** @type {Record<string, unknown>} */ (message);
  if (
    record.type === 'host.bridge_request' &&
    record.request &&
    typeof record.request === 'object'
  ) {
    return /** @type {BridgeRequest} */ (record.request);
  }

  if (typeof record.id === 'string' && typeof record.method === 'string') {
    return /** @type {BridgeRequest} */ (record);
  }

  return null;
}

/**
 * @typedef {{
 *   code: number | null,
 *   signal: NodeJS.Signals | null,
 *   stdout: string,
 *   stderr: string,
 * }} ProcessResult
 */

/**
 * @typedef {{
 *   child: import('node:child_process').ChildProcessByStdio<import('node:stream').Writable, import('node:stream').Readable, import('node:stream').Readable>,
 *   requests: BridgeRequest[],
 *   messages: unknown[],
 *   protocolErrors: Error[],
 *   getStderr: () => string,
 *   send: (message: unknown) => Promise<void>,
 * }} NativeHostHarness
 */

/**
 * @typedef {{
 *   healthResult?: Record<string, unknown>,
 *   skipAutoResponses?: string[],
 * }} NativeHostHarnessOptions
 */

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<ProcessResult>}
 */
function runCli(args, env) {
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

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{
 *   child: import('node:child_process').ChildProcessByStdio<null, import('node:stream').Readable, import('node:stream').Readable>,
 *   getStdout: () => string,
 *   getStderr: () => string,
 * }}
 */
function spawnBridgeDaemon(env) {
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

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {NativeHostHarnessOptions} [options={}]
 * @returns {NativeHostHarness}
 */
function spawnNativeHost(env, options = {}) {
  const child = spawn(process.execPath, [nativeHostPath], {
    cwd: repoRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const skippedAutoResponses = new Set(options.skipAutoResponses ?? []);
  const requests = /** @type {BridgeRequest[]} */ ([]);
  const messages = /** @type {unknown[]} */ ([]);
  const protocolErrors = /** @type {Error[]} */ ([]);
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

  /**
   * @param {unknown} message
   * @returns {Promise<void>}
   */
  async function send(message) {
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

/**
 * @param {{
 *   child: import('node:child_process').ChildProcessByStdio<null, import('node:stream').Readable, import('node:stream').Readable>,
 *   getStdout: () => string,
 *   getStderr: () => string,
 * }} daemon
 * @param {string} socketPath
 * @returns {Promise<void>}
 */
async function waitForDaemonReady(daemon, socketPath) {
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

/**
 * @param {string} socketPath
 * @param {NativeHostHarness} nativeHost
 * @returns {Promise<void>}
 */
async function waitForExtensionConnected(socketPath, nativeHost) {
  const deadline = Date.now() + 10_000;
  /** @type {Error | null} */
  let lastError = null;

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
          ? /** @type {Record<string, unknown>} */ (response.result)
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

/**
 * @param {NativeHostHarness} nativeHost
 * @param {string} method
 * @returns {Promise<BridgeRequest>}
 */
async function waitForForwardedRequest(nativeHost, method) {
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

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} label
 * @param {() => string} getOutput
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null }>}
 */
async function waitForProcessExit(child, label, getOutput) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  return await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label} to exit\n${getOutput()}`));
    }, 5_000);

    /** @returns {void} */
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
 * @param {import('node:stream').Writable} stdin
 * @param {Buffer} frame
 * @returns {Promise<void>}
 */
async function writeNativeFrame(stdin, frame) {
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
          assert.equal(cliRequest.meta?.protocol_version, '1.0');
          assert.equal(cliRequest.meta?.source, 'cli');
          assert.equal(cliRequest.tab_id, null);
          assert.equal(
            nativeHost.requests.some((request) => request.method === 'health.ping'),
            true,
            'expected the agent handshake to issue a health.ping before the CLI call'
          );
          assert.deepEqual(nativeHost.protocolErrors, []);
          assert.equal(nativeHost.getStderr(), '');
          assert.equal(daemon.getStderr(), '');
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
              /Protocol mismatch: client speaks 1\.0 but remote supports \[0\.9\]/
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
          assert.equal(daemon.getStderr(), '');
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
          assert.equal(daemon.getStderr(), '');
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
        /** @type {NativeHostHarness | null} */
        let recoveredNativeHost = null;
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
          assert.equal(daemon.getStderr(), '');
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
