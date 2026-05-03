// @ts-check

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSuccess } from '../../protocol/src/index.js';
import { runCli } from '../../../tests/_helpers/runCli.js';
import { createInstallFs } from '../../../tests/_helpers/installFs.js';
import { bridgeServerWith } from '../../../tests/_helpers/socketHarness.js';

function createBridgeHealthResult() {
  return {
    daemon: 'ok',
    supported_versions: ['1.0'],
    extensionConnected: false,
    connectedExtensions: [],
    access: {
      enabled: false,
      routeReady: false,
      routeTabId: null,
      windowId: null,
      reason: 'access_disabled',
    },
  };
}

async function createRefusedBridgeHome() {
  const bridgeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bbx-cli-error-refused-'));
  const socketPath = path.join(bridgeHome, 'bridge.sock');
  const child = spawn(
    process.execPath,
    [
      '-e',
      [
        "const net = require('node:net');",
        `const socketPath = ${JSON.stringify(socketPath)};`,
        'const server = net.createServer();',
        "server.listen(socketPath, () => process.send && process.send('ready'));",
        'setInterval(() => {}, 1000);',
      ].join(' '),
    ],
    {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    }
  );

  try {
    const [message] = await Promise.race([
      once(child, 'message'),
      once(child, 'error').then(([error]) => Promise.reject(error)),
      once(child, 'exit').then(([code, signal]) =>
        Promise.reject(
          new Error(`Socket server exited before becoming ready (code=${code}, signal=${signal})`)
        )
      ),
    ]);

    if (message !== 'ready') {
      throw new Error(`Unexpected readiness message: ${String(message)}`);
    }

    child.kill('SIGKILL');
    await once(child, 'exit');

    if (!fs.existsSync(socketPath)) {
      throw new Error('Expected a stale socket path after killing the socket listener.');
    }

    return {
      bridgeHome,
      cleanup() {
        fs.rmSync(bridgeHome, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (!child.killed) {
      child.kill('SIGKILL');
    }
    fs.rmSync(bridgeHome, { recursive: true, force: true });
    throw error;
  }
}

test('bbx status maps a missing daemon socket to DAEMON_OFFLINE', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-cli-error-enoent-' });

  try {
    const result = await runCli({
      args: ['status'],
      env: installFs.env,
    });
    const payload = result.json;

    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, false);
    assert.equal(payload.evidence, null);
    assert.match(payload.summary, /^DAEMON_OFFLINE: /);
  } finally {
    await installFs.cleanup();
  }
});

test('bbx status maps ECONNREFUSED to DAEMON_OFFLINE when a stale socket path is left behind', async () => {
  const refusedBridge = await createRefusedBridgeHome();

  try {
    const result = await runCli({
      args: ['status'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: refusedBridge.bridgeHome,
      },
    });
    const payload = result.json;

    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, false);
    assert.equal(payload.evidence, null);
    assert.match(payload.summary, /^DAEMON_OFFLINE: /);
    assert.match(payload.summary, /ECONNREFUSED|connect/);
  } finally {
    refusedBridge.cleanup();
  }
});

test('bbx tabs maps a mid-request socket close to CONNECTION_LOST', async () => {
  const bridgeServer = await bridgeServerWith({
    'health.ping': (request) => createSuccess(request.id, createBridgeHealthResult()),
    'tabs.list': (_request, context) => {
      context.socket.destroy();
    },
  });

  try {
    const result = await runCli({
      args: ['tabs'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = result.json;

    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, false);
    assert.equal(payload.evidence, null);
    assert.equal(payload.summary, 'CONNECTION_LOST: Bridge socket closed.');
    assert.equal(bridgeServer.requests.length, 2);
    assert.equal(bridgeServer.requests[0].method, 'health.ping');
    assert.equal(bridgeServer.requests[1].method, 'tabs.list');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx tabs maps request timeouts to BRIDGE_TIMEOUT when the bridge never replies', async () => {
  const bridgeServer = await bridgeServerWith({
    'health.ping': (request) => createSuccess(request.id, createBridgeHealthResult()),
    'tabs.list': () => undefined,
  });

  try {
    const result = await runCli({
      args: ['tabs'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
        BBX_CLIENT_REQUEST_TIMEOUT_MS: '50',
      },
    });
    const payload = result.json;

    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, false);
    assert.equal(payload.evidence, null);
    assert.equal(
      payload.summary,
      'BRIDGE_TIMEOUT: Timed out waiting for bridge response to tabs.list after 50ms.'
    );
    assert.equal(bridgeServer.requests.length, 2);
    assert.equal(bridgeServer.requests[0].method, 'health.ping');
    assert.equal(bridgeServer.requests[1].method, 'tabs.list');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx status passes through raw error codes that are not specially remapped', async () => {
  const bridgeServer = await bridgeServerWith({
    'health.ping': (_request, context) => {
      context.socket.destroy();
    },
  });

  try {
    const result = await runCli({
      args: ['status'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = result.json;

    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, false);
    assert.equal(payload.evidence, null);
    assert.equal(payload.summary, 'ENOTCONN: BridgeClient is not connected.');
    assert.equal(bridgeServer.requests.length, 1);
    assert.equal(bridgeServer.requests[0].method, 'health.ping');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx tab-close falls back to ERROR for plain validation errors without a code', async () => {
  const result = await runCli({
    args: ['tab-close', 'abc'],
    env: process.env,
  });
  const payload = result.json;

  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(payload.ok, false);
  assert.equal(payload.evidence, null);
  assert.equal(payload.summary, 'ERROR: tabId must be a number (got "abc").');
});
