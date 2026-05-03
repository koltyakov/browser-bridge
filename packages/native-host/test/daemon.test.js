// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { DAEMON_RECENT_LOG_LIMIT } from '../../protocol/src/index.js';
import {
  startBridgeSocketServer,
  withTempSocketPath,
} from '../../../tests/_helpers/socketHarness.js';
import { clockController } from '../../../tests/_helpers/faultInjection.js';
import {
  BridgeDaemon,
  installSetupTarget,
  normalizeSetupInstallParams,
  pingExistingDaemon,
} from '../src/daemon.js';

/** @typedef {import('node:net').Socket & { writes: string[], __clientId?: string, __extensionId?: string, __browserName?: string, __profileLabel?: string, __accessEnabled?: boolean, __lastActiveAt?: number }} FakeSocket */

/**
 * Start a daemon on a random TCP port and return it alongside a helper to open
 * a raw socket to it. Caller must call `daemon.stop()` after the test.
 *
 * @returns {Promise<{ daemon: BridgeDaemon, connect: () => Promise<net.Socket> }>}
 */
async function startTestDaemon() {
  const daemon = new BridgeDaemon({
    transport: /** @type {import('../src/config.js').BridgeTransport} */ ({
      type: 'tcp',
      host: '127.0.0.1',
      port: 0,
      label: '127.0.0.1:0',
    }),
    listenOptions: { host: '127.0.0.1', port: 0 },
    logger: { log() {}, error() {} },
  });
  await daemon.start();
  const address = /** @type {import('node:net').AddressInfo} */ (daemon.serverAddress);
  return {
    daemon,
    connect: () =>
      new Promise((resolve, reject) => {
        const socket = net.createConnection({
          host: '127.0.0.1',
          port: address.port,
        });
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
      }),
  };
}

/**
 * @returns {FakeSocket}
 */
function createFakeSocket() {
  const socket = {
    /** @type {string[]} */
    writes: [],
    /**
     * @param {string} chunk
     * @returns {boolean}
     */
    write(chunk) {
      socket.writes.push(chunk);
      return true;
    },
  };
  return /** @type {FakeSocket} */ (/** @type {unknown} */ (socket));
}

/**
 * Route a `health.ping` through an extension response and return the merged
 * connected-extension snapshot the agent receives.
 *
 * @param {BridgeDaemon} daemon
 * @param {FakeSocket} agentSocket
 * @param {FakeSocket} extensionSocket
 * @param {string} requestId
 * @returns {Promise<{
 *   connectedExtensions: Array<{
 *     extensionId: string,
 *     browserName: string | null,
 *     profileLabel: string | null,
 *     accessEnabled: boolean,
 *   }>,
 *   snapshot: Array<{
 *     extensionId: string,
 *     browserName: string | null,
 *     profileLabel: string | null,
 *     accessEnabled: boolean,
 *   }> | null,
 * }>}
 */
async function requestHealthPing(daemon, agentSocket, extensionSocket, requestId) {
  const extensionWritesBefore = extensionSocket.writes.length;
  const agentWritesBefore = agentSocket.writes.length;

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: requestId,
      method: 'health.ping',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: '1.0',
        token_budget: null,
      },
    },
  });

  assert.equal(extensionSocket.writes.length, extensionWritesBefore + 1);

  await daemon.handleExtensionResponse(extensionSocket, {
    response: {
      id: requestId,
      ok: true,
      result: {
        extension: 'ok',
        access: {
          enabled: Boolean(extensionSocket.__accessEnabled),
        },
      },
      error: null,
      meta: { protocol_version: '1.0', method: 'health.ping' },
    },
  });

  assert.equal(agentSocket.writes.length, agentWritesBefore + 1);
  const payload = JSON.parse(agentSocket.writes[agentSocket.writes.length - 1].trim());
  return {
    connectedExtensions: payload.response.result.connectedExtensions,
    snapshot: daemon.connectedExtensionsCache,
  };
}

/** Ensure health checks succeed even before the extension connects. */
test('daemon responds to health checks without extension', async () => {
  const silentConsole = /** @type {Console} */ ({
    ...console,
    log() {},
    error() {},
  });
  const daemon = new BridgeDaemon({ logger: silentConsole });
  const socket = createFakeSocket();

  await daemon.handleAgentRequest(socket, {
    request: {
      id: 'req_health',
      method: 'health.ping',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: '1.0',
        token_budget: null,
      },
    },
  });

  assert.equal(socket.writes.length, 1);
  const payload = JSON.parse(socket.writes[0].trim());
  assert.equal(payload.type, 'agent.response');
  assert.equal(payload.response.result.daemon, 'ok');
  assert.equal(payload.response.result.extensionConnected, false);
});

test('pushLog evicts oldest entries past the recent-log limit', () => {
  const daemon = new BridgeDaemon({ logger: { log() {}, error() {} } });

  for (let index = 0; index < DAEMON_RECENT_LOG_LIMIT + 5; index += 1) {
    daemon.pushLog({ index });
  }

  assert.equal(daemon.recentLog.length, DAEMON_RECENT_LOG_LIMIT);
  assert.equal(daemon.recentLog[0].index, 5);
  assert.equal(daemon.recentLog[daemon.recentLog.length - 1].index, DAEMON_RECENT_LOG_LIMIT + 4);
});

test('pingExistingDaemon resolves false on connect error', async () => {
  await withTempSocketPath(
    async ({ socketPath }) => {
      await assert.doesNotReject(async () => {
        const result = await pingExistingDaemon(socketPath);
        assert.equal(result, false);
      });
    },
    { prefix: 'bbx-missing-socket-' }
  );
});

test('pingExistingDaemon resolves true for tcp transport when daemon responds', async () => {
  const daemon = new BridgeDaemon({
    transport: /** @type {import('../src/config.js').BridgeTransport} */ ({
      type: 'tcp',
      host: '127.0.0.1',
      port: 0,
      label: '127.0.0.1:0',
    }),
    listenOptions: { host: '127.0.0.1', port: 0 },
    logger: { log() {}, error() {} },
  });

  try {
    await daemon.start();
    const address = /** @type {import('node:net').AddressInfo} */ (daemon.serverAddress);
    const result = await pingExistingDaemon({
      type: 'tcp',
      host: '127.0.0.1',
      port: address.port,
      label: `127.0.0.1:${address.port}`,
    });
    assert.equal(result, true);
  } finally {
    await daemon.stop();
  }
});

test(
  'pingExistingDaemon resolves false when peer returns non-JSON',
  {
    skip: process.platform === 'win32' ? 'Unix socket probing is not applicable on Windows' : false,
  },
  async () => {
    const bridgeServer = await startBridgeSocketServer(
      async (message, context) => {
        const record =
          message && typeof message === 'object'
            ? /** @type {Record<string, unknown>} */ (message)
            : null;
        if (record?.type !== 'agent.request') {
          return;
        }
        context.socket.end('garbage\n');
      },
      { prefix: 'bbx-invalid-ping-' }
    );

    try {
      const result = await pingExistingDaemon(bridgeServer.socketPath);
      assert.equal(result, false);
    } finally {
      await bridgeServer.close();
    }
  }
);

test(
  'pingExistingDaemon resolves false when timeout fires',
  {
    skip: process.platform === 'win32' ? 'Unix socket probing is not applicable on Windows' : false,
  },
  async (t) => {
    const clock = clockController();
    t.mock.method(globalThis, 'setTimeout', clock.setTimeout);
    t.mock.method(globalThis, 'clearTimeout', clock.clearTimeout);

    const bridgeServer = await startBridgeSocketServer(async () => {}, {
      prefix: 'bbx-timeout-ping-',
    });

    try {
      const resultPromise = pingExistingDaemon(bridgeServer.socketPath);
      await clock.runNext();
      const result = await resultPromise;

      assert.deepEqual(clock.delays, [500]);
      assert.equal(result, false);
    } finally {
      await bridgeServer.close();
    }
  }
);

test('daemon health check reports upgrade guidance when the daemon is newer than the client', async () => {
  const daemon = new BridgeDaemon({ logger: { log() {}, error() {} } });
  const socket = createFakeSocket();

  await daemon.handleAgentRequest(socket, {
    request: {
      id: 'req_health_old_client',
      method: 'health.ping',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: '0.0',
        token_budget: null,
      },
    },
  });

  const payload = JSON.parse(socket.writes[0].trim());
  assert.equal(payload.response.result.deprecated_since, '1.0');
  assert.match(
    payload.response.result.migration_hint,
    /daemon is newer than the client protocol 0.0/
  );
});

test('daemon health check reports upgrade guidance when the daemon is older than the client', async () => {
  const daemon = new BridgeDaemon({ logger: { log() {}, error() {} } });
  const socket = createFakeSocket();

  await daemon.handleAgentRequest(socket, {
    request: {
      id: 'req_health_new_client',
      method: 'health.ping',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: '9.9',
        token_budget: null,
      },
    },
  });

  const payload = JSON.parse(socket.writes[0].trim());
  assert.equal(payload.response.result.deprecated_since, undefined);
  assert.match(
    payload.response.result.migration_hint,
    /daemon is older than the client protocol 9.9/
  );
});

test('daemon responds to setup status requests without extension', async () => {
  const silentConsole = /** @type {Console} */ ({
    ...console,
    log() {},
    error() {},
  });
  /** @type {import('../../protocol/src/types.js').SetupStatus} */
  const expectedStatus = {
    scope: 'global',
    mcpClients: [
      {
        key: 'codex',
        label: 'OpenAI Codex',
        detected: true,
        configPath: '/tmp/mcp.json',
        configExists: true,
        configured: true,
      },
    ],
    skillTargets: [
      {
        key: 'codex',
        label: 'OpenAI Codex',
        detected: true,
        basePath: '/tmp/skills',
        installed: true,
        managed: true,
        installedVersion: '1.0.0',
        currentVersion: '1.0.0',
        updateAvailable: false,
        skills: [],
      },
    ],
  };
  const daemon = new BridgeDaemon({
    logger: silentConsole,
    setupStatusLoader: async () => expectedStatus,
  });
  const socket = createFakeSocket();

  await daemon.handleAgentRequest(socket, {
    request: {
      id: 'req_setup',
      method: 'setup.get_status',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: '1.0',
        token_budget: null,
      },
    },
  });

  assert.equal(socket.writes.length, 1);
  const payload = JSON.parse(socket.writes[0].trim());
  assert.equal(payload.type, 'agent.response');
  assert.deepEqual(payload.response.result, expectedStatus);
});

test('daemon installs setup targets without extension', async () => {
  const daemon = new BridgeDaemon({
    logger: console,
    setupInstaller: async (params) => ({
      action: params.action === 'uninstall' ? 'uninstall' : 'install',
      kind: params.kind === 'skill' ? 'skill' : 'mcp',
      target: typeof params.target === 'string' ? params.target : 'codex',
      paths: ['/tmp/mock-install'],
    }),
  });
  const socket = createFakeSocket();

  await daemon.handleAgentRequest(socket, {
    request: {
      id: 'req_setup_install',
      method: 'setup.install',
      tab_id: null,
      params: {
        kind: 'mcp',
        target: 'codex',
      },
      meta: {
        protocol_version: '1.0',
        token_budget: null,
      },
    },
  });

  assert.equal(socket.writes.length, 1);
  const payload = JSON.parse(socket.writes[0].trim());
  assert.equal(payload.type, 'agent.response');
  assert.equal(payload.response.ok, true);
  assert.deepEqual(payload.response.result, {
    action: 'install',
    kind: 'mcp',
    target: 'codex',
    paths: ['/tmp/mock-install'],
  });
});

test('daemon handles extension setup status requests', async () => {
  /** @type {import('../../protocol/src/types.js').SetupStatus} */
  const expectedStatus = {
    scope: 'global',
    mcpClients: [],
    skillTargets: [],
  };
  const daemon = new BridgeDaemon({
    logger: console,
    setupStatusLoader: async () => expectedStatus,
  });
  const socket = createFakeSocket();

  await daemon.handleClientMessage(socket, {
    type: 'extension.setup_status.request',
    requestId: 'setup_1',
  });

  assert.equal(socket.writes.length, 1);
  const payload = JSON.parse(socket.writes[0].trim());
  assert.equal(payload.type, 'extension.setup_status.response');
  assert.equal(payload.requestId, 'setup_1');
  assert.deepEqual(payload.status, expectedStatus);
});

test('daemon returns setup status errors to the extension caller', async () => {
  const daemon = new BridgeDaemon({
    logger: console,
    setupStatusLoader: async () => {
      throw new Error('status unavailable');
    },
  });
  const socket = createFakeSocket();

  await daemon.handleClientMessage(socket, {
    type: 'extension.setup_status.request',
    requestId: 'setup_fail',
  });

  const payload = JSON.parse(socket.writes[0].trim());
  assert.equal(payload.type, 'extension.setup_status.error');
  assert.equal(payload.requestId, 'setup_fail');
  assert.equal(payload.error.message, 'status unavailable');
});

test('daemon log entries retain request source metadata', async () => {
  const daemon = new BridgeDaemon({
    logger: console,
  });
  const agentSocket = createFakeSocket();
  const extensionSocket = createFakeSocket();
  daemon.extensionSockets.set('test-ext', extensionSocket);

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_eval',
      method: 'page.evaluate',
      tab_id: 42,
      params: { expression: '1+1' },
      meta: {
        protocol_version: '1.0',
        token_budget: null,
        source: 'mcp',
      },
    },
  });

  await daemon.handleExtensionResponse(extensionSocket, {
    response: {
      id: 'req_eval',
      ok: false,
      result: null,
      error: { code: 'ACCESS_DENIED', message: 'Access denied', details: null },
      meta: { protocol_version: '1.0', method: 'page.evaluate' },
    },
  });

  assert.equal(daemon.recentLog.length, 1);
  assert.equal(daemon.recentLog[0].source, 'mcp');
});

test('daemon forwards health checks to the extension and merges access state', async () => {
  const daemon = new BridgeDaemon({ logger: console });
  const agentSocket = createFakeSocket();
  const extensionSocket = createFakeSocket();
  daemon.extensionSockets.set('test-ext', extensionSocket);

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_health_ext',
      method: 'health.ping',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: '1.0',
        token_budget: null,
      },
    },
  });

  assert.equal(extensionSocket.writes.length, 1);

  await daemon.handleExtensionResponse(extensionSocket, {
    response: {
      id: 'req_health_ext',
      ok: true,
      result: {
        extension: 'ok',
        access: {
          enabled: true,
          windowId: 9,
          routeTabId: 42,
          routeReady: true,
          reason: 'enabled',
        },
      },
      error: null,
      meta: { protocol_version: '1.0', method: 'health.ping' },
    },
  });

  assert.equal(agentSocket.writes.length, 1);
  const payload = JSON.parse(agentSocket.writes[0].trim());
  assert.equal(payload.response.result.daemon, 'ok');
  assert.equal(payload.response.result.extensionConnected, true);
  assert.equal(payload.response.result.access.routeTabId, 42);
});

test('daemon prefers enabled extensions and otherwise falls back to the most recent one', async () => {
  const daemon = new BridgeDaemon({ logger: console });
  const agentSocket = createFakeSocket();
  const enabledExtension = createFakeSocket();
  enabledExtension.__accessEnabled = true;
  enabledExtension.__lastActiveAt = 10;
  const recentExtension = createFakeSocket();
  recentExtension.__accessEnabled = false;
  recentExtension.__lastActiveAt = 20;
  daemon.extensionSockets.set('enabled-ext', enabledExtension);
  daemon.extensionSockets.set('recent-ext', recentExtension);

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_enabled_target',
      method: 'page.get_state',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: '1.0',
        token_budget: null,
      },
    },
  });

  assert.equal(enabledExtension.writes.length, 1);
  assert.equal(recentExtension.writes.length, 0);

  enabledExtension.__accessEnabled = false;
  enabledExtension.writes.length = 0;
  recentExtension.writes.length = 0;

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_recent_target',
      method: 'page.get_state',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: '1.0',
        token_budget: null,
      },
    },
  });

  assert.equal(enabledExtension.writes.length, 0);
  assert.equal(recentExtension.writes.length, 1);
});

test('daemon routes untargeted requests to the most recently active extension when none are enabled', async () => {
  const daemon = new BridgeDaemon({ logger: console });
  const agentSocket = createFakeSocket();
  const olderExtension = createFakeSocket();
  olderExtension.__lastActiveAt = 10;
  const mostRecentExtension = createFakeSocket();
  mostRecentExtension.__lastActiveAt = 30;
  const middleExtension = createFakeSocket();
  middleExtension.__lastActiveAt = 20;
  daemon.extensionSockets.set('older-ext', olderExtension);
  daemon.extensionSockets.set('recent-ext', mostRecentExtension);
  daemon.extensionSockets.set('middle-ext', middleExtension);

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_most_recent_unit',
      method: 'page.get_state',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: '1.0',
        token_budget: null,
      },
    },
  });

  assert.equal(olderExtension.writes.length, 0);
  assert.equal(mostRecentExtension.writes.length, 1);
  assert.equal(middleExtension.writes.length, 0);
});

test('daemon health.ping refreshes connectedExtensions after connect, metadata changes, and disconnect', async () => {
  const daemon = new BridgeDaemon({ logger: console });
  const agentSocket = createFakeSocket();
  const extensionOne = createFakeSocket();
  const extensionTwo = createFakeSocket();

  daemon.registerSocket(extensionOne, { type: 'register', role: 'extension' });
  extensionOne.__lastActiveAt = 10;

  const firstPing = await requestHealthPing(
    daemon,
    agentSocket,
    extensionOne,
    'req_health_cache_1'
  );
  const firstSnapshot = firstPing.snapshot;
  assert.deepEqual(firstPing.connectedExtensions, [
    {
      extensionId: extensionOne.__extensionId,
      browserName: null,
      profileLabel: null,
      accessEnabled: false,
    },
  ]);

  daemon.registerSocket(extensionTwo, { type: 'register', role: 'extension' });
  extensionTwo.__lastActiveAt = 20;

  const secondPing = await requestHealthPing(
    daemon,
    agentSocket,
    extensionTwo,
    'req_health_cache_2'
  );
  const secondSnapshot = secondPing.snapshot;
  assert.notEqual(secondSnapshot, firstSnapshot);
  assert.deepEqual(secondPing.connectedExtensions, [
    {
      extensionId: extensionOne.__extensionId,
      browserName: null,
      profileLabel: null,
      accessEnabled: false,
    },
    {
      extensionId: extensionTwo.__extensionId,
      browserName: null,
      profileLabel: null,
      accessEnabled: false,
    },
  ]);

  daemon.handleExtensionIdentity(extensionOne, {
    browserName: 'Chrome',
    profileLabel: 'Work',
  });
  daemon.handleExtensionAccessUpdate(extensionOne, { accessEnabled: true });

  const thirdPing = await requestHealthPing(
    daemon,
    agentSocket,
    extensionOne,
    'req_health_cache_3'
  );
  const thirdSnapshot = thirdPing.snapshot;
  assert.notEqual(thirdSnapshot, secondSnapshot);
  assert.deepEqual(thirdPing.connectedExtensions, [
    {
      extensionId: extensionOne.__extensionId,
      browserName: 'Chrome',
      profileLabel: 'Work',
      accessEnabled: true,
    },
    {
      extensionId: extensionTwo.__extensionId,
      browserName: null,
      profileLabel: null,
      accessEnabled: false,
    },
  ]);

  daemon.handleSocketClose(extensionTwo);

  const fourthPing = await requestHealthPing(
    daemon,
    agentSocket,
    extensionOne,
    'req_health_cache_4'
  );
  assert.notEqual(fourthPing.snapshot, thirdSnapshot);
  assert.deepEqual(fourthPing.connectedExtensions, [
    {
      extensionId: extensionOne.__extensionId,
      browserName: 'Chrome',
      profileLabel: 'Work',
      accessEnabled: true,
    },
  ]);
});

test('daemon reuses the same connectedExtensions snapshot across unchanged health.ping requests', async () => {
  const daemon = new BridgeDaemon({ logger: console });
  const agentSocket = createFakeSocket();
  const extensionSocket = createFakeSocket();

  daemon.registerSocket(extensionSocket, {
    type: 'register',
    role: 'extension',
    browserName: 'Chrome',
    profileLabel: 'Personal',
  });

  const firstPing = await requestHealthPing(
    daemon,
    agentSocket,
    extensionSocket,
    'req_health_stable_1'
  );
  const firstSnapshot = firstPing.snapshot;
  assert.ok(firstSnapshot);

  const secondPing = await requestHealthPing(
    daemon,
    agentSocket,
    extensionSocket,
    'req_health_stable_2'
  );

  assert.equal(secondPing.snapshot, firstSnapshot);
  assert.deepEqual(secondPing.connectedExtensions, firstPing.connectedExtensions);
});

test('daemon times out pending requests and removes them once the deadline expires', async () => {
  const daemon = new BridgeDaemon({ logger: console });
  const agentSocket = createFakeSocket();
  const extensionSocket = createFakeSocket();
  daemon.extensionSockets.set('timeout-ext', extensionSocket);
  daemon.pendingTimeoutMs = 1;

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_timeout_unit',
      method: 'page.get_state',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: '1.0',
        token_budget: null,
      },
    },
  });

  assert.equal(extensionSocket.writes.length, 1);
  assert.equal(agentSocket.writes.length, 0);
  assert.ok(daemon.pendingRequests.has('req_timeout_unit'));

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(daemon.pendingRequests.has('req_timeout_unit'), false);
  assert.equal(agentSocket.writes.length, 1);
  const payload = JSON.parse(agentSocket.writes[0].trim());
  assert.equal(payload.type, 'agent.response');
  assert.equal(payload.response.id, 'req_timeout_unit');
  assert.equal(payload.response.ok, false);
  assert.equal(payload.response.error.code, 'TIMEOUT');
  assert.match(payload.response.error.message, /did not respond in time/i);

  await daemon.handleExtensionResponse(extensionSocket, {
    response: {
      id: 'req_timeout_unit',
      ok: true,
      result: { url: 'https://example.test' },
      error: null,
      meta: { protocol_version: '1.0', method: 'page.get_state' },
    },
  });

  assert.equal(agentSocket.writes.length, 1);
});

test('daemon socket close clears only the disconnected agent socket pending requests', async (t) => {
  const daemon = new BridgeDaemon({ logger: console });
  const agentOne = createFakeSocket();
  const agentTwo = createFakeSocket();
  const extensionOne = createFakeSocket();
  const extensionTwo = createFakeSocket();
  extensionOne.__accessEnabled = true;
  extensionTwo.__accessEnabled = true;
  daemon.extensionSockets.set('ext-one', extensionOne);
  daemon.extensionSockets.set('ext-two', extensionTwo);

  const originalClearTimeout = clearTimeout;
  /** @type {unknown[]} */
  const clearedTimeouts = [];
  /** @param {Parameters<typeof clearTimeout>[0]} timeoutId */
  const clearTimeoutMock = (timeoutId) => {
    clearedTimeouts.push(timeoutId);
    return originalClearTimeout(timeoutId);
  };
  t.mock.method(globalThis, 'clearTimeout', clearTimeoutMock);

  await daemon.handleAgentRequest(agentOne, {
    request: {
      id: 'req_owner_closed',
      method: 'page.get_state',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: '1.0',
        token_budget: null,
      },
    },
  });
  await daemon.handleAgentRequest(agentTwo, {
    request: {
      id: 'req_owner_survives',
      method: 'page.get_state',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: '1.0',
        token_budget: null,
      },
    },
  });

  const removedPending = daemon.pendingRequests.get('req_owner_closed');
  const survivingPending = daemon.pendingRequests.get('req_owner_survives');
  assert.ok(removedPending);
  assert.ok(survivingPending);
  assert.equal(removedPending.targets.size, 2);
  assert.equal(survivingPending.targets.size, 2);
  assert.deepEqual(
    daemon.pendingRequestsByOwnerSocket.get(agentOne),
    new Set(['req_owner_closed'])
  );
  assert.deepEqual(
    daemon.pendingRequestsByOwnerSocket.get(agentTwo),
    new Set(['req_owner_survives'])
  );
  assert.deepEqual(
    daemon.pendingRequestsByTargetSocket.get(extensionOne),
    new Set(['req_owner_closed', 'req_owner_survives'])
  );
  assert.deepEqual(
    daemon.pendingRequestsByTargetSocket.get(extensionTwo),
    new Set(['req_owner_closed', 'req_owner_survives'])
  );

  daemon.handleSocketClose(agentOne);

  assert.equal(daemon.pendingRequests.has('req_owner_closed'), false);
  assert.equal(daemon.pendingRequests.has('req_owner_survives'), true);
  assert.equal(daemon.pendingRequestsByOwnerSocket.has(agentOne), false);
  assert.deepEqual(
    daemon.pendingRequestsByOwnerSocket.get(agentTwo),
    new Set(['req_owner_survives'])
  );
  assert.deepEqual(
    daemon.pendingRequestsByTargetSocket.get(extensionOne),
    new Set(['req_owner_survives'])
  );
  assert.deepEqual(
    daemon.pendingRequestsByTargetSocket.get(extensionTwo),
    new Set(['req_owner_survives'])
  );
  assert.deepEqual(clearedTimeouts, [removedPending.timeoutId]);

  await daemon.handleExtensionResponse(extensionOne, {
    response: {
      id: 'req_owner_closed',
      ok: true,
      result: { url: 'https://ignored.example/closed' },
      error: null,
      meta: { protocol_version: '1.0', method: 'page.get_state' },
    },
  });
  await daemon.handleExtensionResponse(extensionOne, {
    response: {
      id: 'req_owner_survives',
      ok: true,
      result: { url: 'https://still-alive.example/' },
      error: null,
      meta: { protocol_version: '1.0', method: 'page.get_state' },
    },
  });

  assert.equal(agentOne.writes.length, 0);
  assert.equal(agentTwo.writes.length, 1);
  const payload = JSON.parse(agentTwo.writes[0].trim());
  assert.equal(payload.type, 'agent.response');
  assert.equal(payload.response.id, 'req_owner_survives');
  assert.equal(payload.response.ok, true);
  assert.equal(payload.response.result.url, 'https://still-alive.example/');
});

test('daemon socket close removes only the disconnected extension from pending target sets', async () => {
  const daemon = new BridgeDaemon({ logger: console });
  const agentOne = createFakeSocket();
  const agentTwo = createFakeSocket();
  const extensionOne = createFakeSocket();
  const extensionTwo = createFakeSocket();
  extensionOne.__accessEnabled = true;
  extensionTwo.__accessEnabled = true;
  daemon.extensionSockets.set('ext-one', extensionOne);
  daemon.extensionSockets.set('ext-two', extensionTwo);

  await daemon.handleAgentRequest(agentOne, {
    request: {
      id: 'req_extension_close_one',
      method: 'page.get_state',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: '1.0',
        token_budget: null,
      },
    },
  });
  await daemon.handleAgentRequest(agentTwo, {
    request: {
      id: 'req_extension_close_two',
      method: 'page.get_state',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: '1.0',
        token_budget: null,
      },
    },
  });

  const firstPending = daemon.pendingRequests.get('req_extension_close_one');
  const secondPending = daemon.pendingRequests.get('req_extension_close_two');
  assert.ok(firstPending);
  assert.ok(secondPending);
  assert.deepEqual(new Set(firstPending.targets), new Set([extensionOne, extensionTwo]));
  assert.deepEqual(new Set(secondPending.targets), new Set([extensionOne, extensionTwo]));

  extensionOne.__extensionId = 'ext-one';
  daemon.handleSocketClose(extensionOne);

  assert.equal(daemon.extensionSockets.has('ext-one'), false);
  assert.equal(daemon.pendingRequests.has('req_extension_close_one'), true);
  assert.equal(daemon.pendingRequests.has('req_extension_close_two'), true);
  assert.deepEqual(new Set(firstPending.targets), new Set([extensionTwo]));
  assert.deepEqual(new Set(secondPending.targets), new Set([extensionTwo]));
  assert.equal(daemon.pendingRequestsByTargetSocket.has(extensionOne), false);
  assert.deepEqual(
    daemon.pendingRequestsByTargetSocket.get(extensionTwo),
    new Set(['req_extension_close_one', 'req_extension_close_two'])
  );
  assert.equal(agentOne.writes.length, 0);
  assert.equal(agentTwo.writes.length, 0);

  await daemon.handleExtensionResponse(extensionTwo, {
    response: {
      id: 'req_extension_close_one',
      ok: true,
      result: { url: 'https://survivor-one.example/' },
      error: null,
      meta: { protocol_version: '1.0', method: 'page.get_state' },
    },
  });
  await daemon.handleExtensionResponse(extensionTwo, {
    response: {
      id: 'req_extension_close_two',
      ok: true,
      result: { url: 'https://survivor-two.example/' },
      error: null,
      meta: { protocol_version: '1.0', method: 'page.get_state' },
    },
  });

  assert.equal(agentOne.writes.length, 1);
  assert.equal(agentTwo.writes.length, 1);
  const payloadOne = JSON.parse(agentOne.writes[0].trim());
  const payloadTwo = JSON.parse(agentTwo.writes[0].trim());
  assert.equal(payloadOne.response.id, 'req_extension_close_one');
  assert.equal(payloadOne.response.result.url, 'https://survivor-one.example/');
  assert.equal(payloadTwo.response.id, 'req_extension_close_two');
  assert.equal(payloadTwo.response.result.url, 'https://survivor-two.example/');
});

/** Ensure repeated shutdown calls share one cleanup path safely. */
test('daemon stop is idempotent when called concurrently', async () => {
  const daemon = new BridgeDaemon({
    transport: /** @type {import('../src/config.js').BridgeTransport} */ ({
      type: 'tcp',
      host: '127.0.0.1',
      port: 0,
      label: '127.0.0.1:0',
    }),
    listenOptions: { host: '127.0.0.1', port: 0 },
    logger: console,
  });

  await daemon.start();
  await Promise.all([daemon.stop(), daemon.stop(), daemon.stop()]);

  assert.equal(daemon.server, null);
});

// --- Security: socket and directory permissions (1.1 / 1.2) ---

test(
  'daemon socket has 0o600 mode and config dir has 0o700 mode (Unix only)',
  {
    skip: process.platform === 'win32' ? 'chmod is a no-op on Windows' : false,
  },
  async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-perms-'));
    const socketPath = path.join(tempDir, 'test.sock');
    const daemon = new BridgeDaemon({
      socketPath,
      logger: { log() {}, error() {} },
    });
    try {
      await daemon.start();
      const sockStats = await fs.promises.stat(socketPath);
      assert.equal(
        sockStats.mode & 0o777,
        0o600,
        `socket mode should be 0o600, got 0o${(sockStats.mode & 0o777).toString(8)}`
      );
      const dirStats = await fs.promises.stat(tempDir);
      assert.equal(
        dirStats.mode & 0o777,
        0o700,
        `config dir mode should be 0o700, got 0o${(dirStats.mode & 0o777).toString(8)}`
      );
    } finally {
      await daemon.stop();
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }
);

test(
  'daemon start fails when another daemon is already listening on the same socket',
  {
    skip:
      process.platform === 'win32'
        ? 'Unix socket single-instance check is not applicable on Windows'
        : false,
  },
  async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-single-instance-'));
    const socketPath = path.join(tempDir, 'bridge.sock');
    const logger = { log() {}, error() {} };
    const first = new BridgeDaemon({ socketPath, logger });
    const second = new BridgeDaemon({ socketPath, logger });

    try {
      await first.start();
      await assert.rejects(() => second.start(), /Another daemon is already running on/);
    } finally {
      await second.stop().catch(() => {});
      await first.stop();
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }
);

test(
  'daemon start removes a stale socket when the probe returns invalid JSON',
  {
    skip: process.platform === 'win32' ? 'Unix socket probing is not applicable on Windows' : false,
  },
  async () => {
    /** @type {string[][]} */
    const logs = [];
    const staleServer = await startBridgeSocketServer(
      async (message, context) => {
        const record =
          message && typeof message === 'object'
            ? /** @type {Record<string, unknown>} */ (message)
            : null;
        if (record?.type !== 'agent.request') {
          return;
        }
        context.socket.end('not-json\n');
        context.server.close();
      },
      { prefix: 'bbx-stale-socket-' }
    );

    const daemon = new BridgeDaemon({
      socketPath: staleServer.socketPath,
      logger: {
        log(...args) {
          logs.push(args.map((value) => String(value)));
        },
        error() {},
      },
    });

    try {
      await daemon.start();
      assert.ok(
        logs.some((entry) => entry.join(' ').includes('Removing stale socket from previous run'))
      );
    } finally {
      await daemon.stop().catch(() => {});
      await staleServer.close();
    }
  }
);

test('normalizeSetupInstallParams trims targets and defaults to install', () => {
  assert.deepEqual(
    normalizeSetupInstallParams({
      kind: 'mcp',
      target: '  Codex  ',
    }),
    {
      action: 'install',
      kind: 'mcp',
      target: 'codex',
    }
  );
});

test('normalizeSetupInstallParams rejects invalid input', () => {
  assert.throws(() => normalizeSetupInstallParams({ target: 'codex' }), /requires kind/);
  assert.throws(
    () => normalizeSetupInstallParams({ kind: 'skill', target: '   ' }),
    /requires a target/
  );
});

test('installSetupTarget dispatches mcp installs and uninstalls', async () => {
  /** @type {Array<{ kind: string, target: string, options?: Record<string, unknown> }>} */
  const calls = [];
  const deps = /** @type {any} */ ({
    installAgentFiles: async () => {
      throw new Error('unexpected skill install');
    },
    isSupportedTarget: () => false,
    removeAgentFiles: async () => {
      throw new Error('unexpected skill uninstall');
    },
    installMcpConfig: async (
      /** @type {string} */ target,
      /** @type {Record<string, unknown>} */ options
    ) => {
      calls.push({ kind: 'installMcpConfig', target, options });
      return '/tmp/install-mcp';
    },
    isMcpClientName: (/** @type {string} */ target) => target === 'codex',
    removeMcpConfig: async (
      /** @type {string} */ target,
      /** @type {Record<string, unknown>} */ options
    ) => {
      calls.push({ kind: 'removeMcpConfig', target, options });
      return ['/tmp/remove-mcp'];
    },
    cwd: '/tmp/project',
  });

  assert.deepEqual(
    await installSetupTarget(
      {
        kind: 'mcp',
        target: 'codex',
      },
      deps
    ),
    {
      action: 'install',
      kind: 'mcp',
      target: 'codex',
      paths: ['/tmp/install-mcp'],
    }
  );

  assert.deepEqual(
    await installSetupTarget(
      {
        action: 'uninstall',
        kind: 'mcp',
        target: 'codex',
      },
      deps
    ),
    {
      action: 'uninstall',
      kind: 'mcp',
      target: 'codex',
      paths: ['/tmp/remove-mcp'],
    }
  );

  await assert.rejects(
    () =>
      installSetupTarget(
        { kind: 'mcp', target: 'cursor' },
        {
          ...deps,
          isMcpClientName: () => false,
        }
      ),
    /Unsupported MCP client/
  );

  assert.deepEqual(calls, [
    { kind: 'installMcpConfig', target: 'codex', options: { global: true } },
    { kind: 'removeMcpConfig', target: 'codex', options: { global: true } },
  ]);
});

test('installSetupTarget dispatches skill installs and uninstalls', async () => {
  /** @type {Array<{ kind: string, options: Record<string, unknown> }>} */
  const calls = [];
  const deps = /** @type {any} */ ({
    installAgentFiles: async (/** @type {Record<string, unknown>} */ options) => {
      calls.push({ kind: 'installAgentFiles', options });
      return ['/tmp/install-skill'];
    },
    isSupportedTarget: (/** @type {string} */ target) => target === 'codex',
    removeAgentFiles: async (/** @type {Record<string, unknown>} */ options) => {
      calls.push({ kind: 'removeAgentFiles', options });
      return ['/tmp/remove-skill'];
    },
    installMcpConfig: async () => {
      throw new Error('unexpected mcp install');
    },
    isMcpClientName: () => false,
    removeMcpConfig: async () => {
      throw new Error('unexpected mcp uninstall');
    },
    cwd: '/tmp/project',
  });

  assert.deepEqual(
    await installSetupTarget(
      {
        kind: 'skill',
        target: 'codex',
      },
      deps
    ),
    {
      action: 'install',
      kind: 'skill',
      target: 'codex',
      paths: ['/tmp/install-skill'],
    }
  );

  assert.deepEqual(
    await installSetupTarget(
      {
        action: 'uninstall',
        kind: 'skill',
        target: 'codex',
      },
      deps
    ),
    {
      action: 'uninstall',
      kind: 'skill',
      target: 'codex',
      paths: ['/tmp/remove-skill'],
    }
  );

  await assert.rejects(
    () =>
      installSetupTarget(
        { kind: 'skill', target: 'cursor' },
        {
          ...deps,
          isSupportedTarget: () => false,
        }
      ),
    /Unsupported skill target/
  );

  assert.deepEqual(calls, [
    {
      kind: 'installAgentFiles',
      options: {
        targets: ['codex'],
        projectPath: '/tmp/project',
        global: true,
      },
    },
    {
      kind: 'removeAgentFiles',
      options: {
        targets: ['codex'],
        projectPath: '/tmp/project',
        global: true,
      },
    },
  ]);
});

// --- Resilience: malformed native messages (5.1) ---

/**
 * Helper: send raw bytes over a socket, then send a valid health.ping and
 * collect the first response line. Returns the parsed response payload.
 *
 * @param {net.Socket} socket
 * @param {Buffer | string} garbage  Data to emit before the valid request
 * @returns {Promise<unknown>}
 */
function sendGarbageThenPing(socket, garbage) {
  return new Promise((resolve, reject) => {
    const validRequest = JSON.stringify({
      type: 'agent.request',
      request: {
        id: 'req_probe',
        method: 'health.ping',
        tab_id: null,
        params: {},
        meta: { protocol_version: '1.0', token_budget: null },
      },
    });

    let responseBuffer = '';
    socket.setEncoding('utf8');
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for daemon response.'));
    }, 2_000);

    /**
     * @returns {void}
     */
    function cleanup() {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      socket.off('data', handleData);
      socket.off('error', handleError);
      socket.off('close', handleClose);
      socket.off('end', handleEnd);
    }

    /**
     * @param {string} chunk
     * @returns {void}
     */
    function handleData(chunk) {
      responseBuffer += chunk;
      const newlineIndex = responseBuffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const line = responseBuffer.slice(0, newlineIndex).trim();
        cleanup();
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error(`Could not parse response: ${line}`));
        }
      }
    }

    /**
     * @param {Error} error
     * @returns {void}
     */
    function handleError(error) {
      cleanup();
      reject(error);
    }

    /**
     * @returns {void}
     */
    function handleClose() {
      cleanup();
      reject(new Error('Socket closed before daemon responded.'));
    }

    /**
     * @returns {void}
     */
    function handleEnd() {
      cleanup();
      reject(new Error('Socket ended before daemon responded.'));
    }

    socket.on('data', handleData);
    socket.on('error', handleError);
    socket.on('close', handleClose);
    socket.on('end', handleEnd);

    // Send garbage, then a newline-terminated valid request.
    socket.write(garbage);
    socket.write(`${validRequest}\n`);
  });
}

test('daemon survives truncated JSON and still processes subsequent requests', async () => {
  const { daemon, connect } = await startTestDaemon();
  const socket = await connect();
  try {
    // Truncated JSON terminated with \n is its own (malformed) line.
    // parseJsonLines extracts it, JSON.parse fails, the line is skipped, and
    // the daemon continues processing the next (valid) request.
    const response = await sendGarbageThenPing(socket, '{"method": "he\n');
    assert.equal(/** @type {any} */ (response).type, 'agent.response');
  } finally {
    socket.destroy();
    await daemon.stop();
  }
});

test('daemon survives binary garbage and still processes subsequent requests', async () => {
  const { daemon, connect } = await startTestDaemon();
  const socket = await connect();
  try {
    // Binary garbage followed by a newline: parseJsonLines will try to parse
    // the garbage line, fail silently, and continue.
    const response = await sendGarbageThenPing(socket, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x0a]));
    assert.equal(/** @type {any} */ (response).type, 'agent.response');
  } finally {
    socket.destroy();
    await daemon.stop();
  }
});

test('daemon survives oversized message and still processes subsequent requests', async () => {
  const { daemon, connect } = await startTestDaemon();
  const socket = await connect();
  try {
    // A very long line (well above the 1 MB native-messaging cap) followed by
    // a newline: the JSON-lines socket layer has no size cap, so the daemon will
    // try to JSON.parse it, fail, skip it, and continue processing normally.
    const oversized = `${'x'.repeat(8_192)}\n`;
    const response = await sendGarbageThenPing(socket, oversized);
    assert.equal(/** @type {any} */ (response).type, 'agent.response');
  } finally {
    socket.destroy();
    await daemon.stop();
  }
});

// --- Concurrency: multiple agents (5.3) ---

/**
 * Wrap a TCP socket with NDJSON send/receive helpers.
 * `next()` returns a Promise resolving with the next complete JSON message.
 *
 * @param {net.Socket} socket
 * @returns {{ next: (timeoutMs?: number) => Promise<unknown>, nextWithin: (timeoutMs: number) => Promise<unknown | null>, send: (obj: unknown) => void }}
 */
function makeNdjsonClient(socket) {
  /** @type {unknown[]} */
  const pending = [];
  /** @type {{ resolve: (msg: unknown) => void, reject?: (error: Error) => void, timeoutId?: ReturnType<typeof setTimeout> | null, nullable: boolean }[]} */
  const waiters = [];
  let buf = '';
  /** @type {Error | null} */
  let terminalError = null;

  /**
   * @param {{ resolve: (msg: unknown) => void, reject?: (error: Error) => void, timeoutId?: ReturnType<typeof setTimeout> | null }} waiter
   * @returns {void}
   */
  function clearWaiterTimeout(waiter) {
    if (waiter.timeoutId) {
      clearTimeout(waiter.timeoutId);
      waiter.timeoutId = null;
    }
  }

  /**
   * @param {Error} error
   * @returns {void}
   */
  function settleAllWaiters(error) {
    terminalError = error;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (!waiter) {
        continue;
      }
      clearWaiterTimeout(waiter);
      if (waiter.nullable) {
        waiter.resolve(null);
        continue;
      }
      waiter.reject?.(error);
    }
  }

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    while (buf.includes('\n')) {
      const idx = buf.indexOf('\n');
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (waiters.length > 0) {
          const waiter = waiters.shift();
          if (waiter?.resolve) {
            clearWaiterTimeout(waiter);
            waiter.resolve(msg);
          }
        } else {
          pending.push(msg);
        }
      } catch {
        /* skip malformed */
      }
    }
  });
  socket.on('close', () => {
    settleAllWaiters(new Error('Socket closed before the expected NDJSON message arrived.'));
  });
  socket.on('end', () => {
    settleAllWaiters(new Error('Socket ended before the expected NDJSON message arrived.'));
  });
  socket.on('error', (error) => {
    settleAllWaiters(error instanceof Error ? error : new Error(String(error)));
  });
  return {
    next(timeoutMs = 2_000) {
      if (pending.length > 0) return Promise.resolve(pending.shift());
      if (terminalError) return Promise.reject(terminalError);
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          nullable: false,
          timeoutId: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) {
              waiters.splice(index, 1);
            }
            reject(new Error(`Timed out waiting ${timeoutMs}ms for an NDJSON message.`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    nextWithin(timeoutMs) {
      if (pending.length > 0) {
        return Promise.resolve(pending.shift() ?? null);
      }
      if (terminalError) {
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        /** @type {{ resolve: (msg: unknown) => void, timeoutId: ReturnType<typeof setTimeout> | null, nullable: boolean }} */
        const waiter = {
          nullable: true,
          /**
           * @param {unknown} msg
           * @returns {void}
           */
          resolve(msg) {
            clearWaiterTimeout(waiter);
            resolve(msg);
          },
          timeoutId: null,
        };
        waiter.timeoutId = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) {
            waiters.splice(index, 1);
          }
          resolve(null);
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    send(obj) {
      socket.write(`${JSON.stringify(obj)}\n`);
    },
  };
}

/**
 * Assert that no NDJSON message arrives within a short timeout.
 *
 * @param {{ nextWithin: (timeoutMs: number) => Promise<unknown | null> }} client
 * @param {number} [timeoutMs=50]
 * @returns {Promise<void>}
 */
async function expectNoMessage(client, timeoutMs = 50) {
  assert.equal(await client.nextWithin(timeoutMs), null);
}

test('daemon routes interleaved requests from two agents to correct sockets', async () => {
  const { daemon, connect } = await startTestDaemon();
  const s1 = await connect();
  const s2 = await connect();
  const se = await connect();
  const a1 = makeNdjsonClient(s1);
  const a2 = makeNdjsonClient(s2);
  const ext = makeNdjsonClient(se);

  try {
    a1.send({ type: 'register', role: 'agent', clientId: 'agent_a1' });
    a2.send({ type: 'register', role: 'agent', clientId: 'agent_a2' });
    ext.send({ type: 'register', role: 'extension' });
    assert.equal(/** @type {any} */ (await a1.next()).type, 'registered');
    assert.equal(/** @type {any} */ (await a2.next()).type, 'registered');
    assert.equal(/** @type {any} */ (await ext.next()).type, 'registered');

    // Both agents send requests concurrently.
    a1.send({
      type: 'agent.request',
      request: {
        id: 'req_a1',
        method: 'page.get_state',
        tab_id: null,
        params: {},
        meta: { protocol_version: '1.0', token_budget: null },
      },
    });
    a2.send({
      type: 'agent.request',
      request: {
        id: 'req_a2',
        method: 'page.get_state',
        tab_id: null,
        params: {},
        meta: { protocol_version: '1.0', token_budget: null },
      },
    });

    // Extension receives both forwarded requests (order not guaranteed).
    const fwd1 = /** @type {any} */ (await ext.next());
    const fwd2 = /** @type {any} */ (await ext.next());
    assert.equal(fwd1.type, 'extension.request');
    assert.equal(fwd2.type, 'extension.request');
    const forwardedIds = new Set([fwd1.request.id, fwd2.request.id]);
    assert.ok(forwardedIds.has('req_a1'));
    assert.ok(forwardedIds.has('req_a2'));

    // Extension responds out of order: req_a2 first, then req_a1.
    ext.send({
      type: 'extension.response',
      response: {
        id: 'req_a2',
        ok: true,
        result: { url: 'https://a.test' },
        error: null,
        meta: { protocol_version: '1.0', method: 'page.get_state' },
      },
    });
    ext.send({
      type: 'extension.response',
      response: {
        id: 'req_a1',
        ok: true,
        result: { url: 'https://b.test' },
        error: null,
        meta: { protocol_version: '1.0', method: 'page.get_state' },
      },
    });

    // Each agent gets its own response.
    const resp1 = /** @type {any} */ (await a1.next());
    const resp2 = /** @type {any} */ (await a2.next());
    assert.equal(resp1.type, 'agent.response');
    assert.equal(resp1.response.id, 'req_a1');
    assert.equal(resp2.type, 'agent.response');
    assert.equal(resp2.response.id, 'req_a2');
  } finally {
    s1.destroy();
    s2.destroy();
    se.destroy();
    await daemon.stop();
  }
});

test('daemon does not drop agent2 response when agent1 disconnects mid-flight', async () => {
  const { daemon, connect } = await startTestDaemon();
  const s1 = await connect();
  const s2 = await connect();
  const se = await connect();
  const a1 = makeNdjsonClient(s1);
  const a2 = makeNdjsonClient(s2);
  const ext = makeNdjsonClient(se);

  try {
    a1.send({ type: 'register', role: 'agent', clientId: 'agent_c1' });
    a2.send({ type: 'register', role: 'agent', clientId: 'agent_c2' });
    ext.send({ type: 'register', role: 'extension' });
    await a1.next();
    await a2.next();
    await ext.next();

    // Both agents send requests concurrently.
    a1.send({
      type: 'agent.request',
      request: {
        id: 'req_c1',
        method: 'page.get_state',
        tab_id: null,
        params: {},
        meta: { protocol_version: '1.0', token_budget: null },
      },
    });
    a2.send({
      type: 'agent.request',
      request: {
        id: 'req_c2',
        method: 'page.get_state',
        tab_id: null,
        params: {},
        meta: { protocol_version: '1.0', token_budget: null },
      },
    });

    // Extension receives both requests.
    await ext.next();
    await ext.next();

    // Agent1 disconnects before responses are sent. Allow the daemon to
    // process the close event so req_c1 is removed from pendingRequests.
    s1.destroy();
    await new Promise((r) => setTimeout(r, 20));

    // Extension responds to both. The req_c1 response is silently discarded
    // (no pending entry). The req_c2 response should still reach agent2.
    ext.send({
      type: 'extension.response',
      response: {
        id: 'req_c1',
        ok: true,
        result: {},
        error: null,
        meta: { protocol_version: '1.0', method: 'page.get_state' },
      },
    });
    ext.send({
      type: 'extension.response',
      response: {
        id: 'req_c2',
        ok: true,
        result: { url: 'https://c.test' },
        error: null,
        meta: { protocol_version: '1.0', method: 'page.get_state' },
      },
    });

    const resp2 = /** @type {any} */ (await a2.next());
    assert.equal(resp2.type, 'agent.response');
    assert.equal(resp2.response.id, 'req_c2');
    assert.equal(resp2.response.ok, true);
  } finally {
    s1.destroy();
    s2.destroy();
    se.destroy();
    await daemon.stop();
  }
});

test('daemon fails pending requests immediately when the only target extension disconnects', async () => {
  const { daemon, connect } = await startTestDaemon();
  const se = await connect();
  const sa = await connect();
  const ext = makeNdjsonClient(se);
  const agent = makeNdjsonClient(sa);

  try {
    ext.send({ type: 'register', role: 'extension' });
    agent.send({
      type: 'register',
      role: 'agent',
      clientId: 'agent_disconnect',
    });
    await ext.next();
    await agent.next();

    agent.send({
      type: 'agent.request',
      request: {
        id: 'req_disconnect',
        method: 'page.get_state',
        tab_id: null,
        params: {},
        meta: { protocol_version: '1.0', token_budget: null, source: 'mcp' },
      },
    });

    const forwarded = /** @type {any} */ (await ext.next());
    assert.equal(forwarded.type, 'extension.request');
    assert.equal(forwarded.request.id, 'req_disconnect');

    se.destroy();

    const resp = /** @type {any} */ (await agent.next());
    assert.equal(resp.type, 'agent.response');
    assert.equal(resp.response.id, 'req_disconnect');
    assert.equal(resp.response.ok, false);
    assert.equal(resp.response.error.code, 'EXTENSION_DISCONNECTED');
    assert.equal(daemon.recentLog.length, 1);
    assert.deepEqual(daemon.recentLog[0], {
      at: daemon.recentLog[0].at,
      method: 'page.get_state',
      ok: false,
      id: 'req_disconnect',
      source: 'mcp',
    });
  } finally {
    se.destroy();
    sa.destroy();
    await daemon.stop();
  }
});

test('daemon returns the last extension error once all other targets disconnect', async () => {
  const { daemon, connect } = await startTestDaemon();
  const s1 = await connect();
  const s2 = await connect();
  const sa = await connect();
  const ext1 = makeNdjsonClient(s1);
  const ext2 = makeNdjsonClient(s2);
  const agent = makeNdjsonClient(sa);

  try {
    ext1.send({ type: 'register', role: 'extension' });
    ext2.send({ type: 'register', role: 'extension' });
    agent.send({
      type: 'register',
      role: 'agent',
      clientId: 'agent_mixed_disconnect',
    });
    await ext1.next();
    await ext2.next();
    await agent.next();

    // Mark both extensions as access-enabled so untargeted requests are sent to
    // both and the daemon must reconcile mixed error/disconnect outcomes.
    ext1.send({ type: 'extension.access_update', accessEnabled: true });
    ext2.send({ type: 'extension.access_update', accessEnabled: true });

    agent.send({
      type: 'agent.request',
      request: {
        id: 'req_mixed_disconnect',
        method: 'page.get_state',
        tab_id: null,
        params: {},
        meta: { protocol_version: '1.0', token_budget: null },
      },
    });

    await ext1.next();
    await ext2.next();

    ext1.send({
      type: 'extension.response',
      response: {
        id: 'req_mixed_disconnect',
        ok: false,
        result: null,
        error: {
          code: 'ACCESS_DENIED',
          message: 'No window enabled',
          details: null,
        },
        meta: { protocol_version: '1.0', method: 'page.get_state' },
      },
    });
    s2.destroy();

    const resp = /** @type {any} */ (await agent.next());
    assert.equal(resp.type, 'agent.response');
    assert.equal(resp.response.id, 'req_mixed_disconnect');
    assert.equal(resp.response.ok, false);
    assert.equal(resp.response.error.code, 'ACCESS_DENIED');
  } finally {
    s1.destroy();
    s2.destroy();
    sa.destroy();
    await daemon.stop();
  }
});

// --- Multi-extension: two Chrome profiles coexist (no kick-off) ---

test('daemon routes untargeted requests to the extension with access enabled', async () => {
  const { daemon, connect } = await startTestDaemon();
  const s1 = await connect();
  const s2 = await connect();
  const sa = await connect();
  const ext1 = makeNdjsonClient(s1);
  const ext2 = makeNdjsonClient(s2);
  const agent = makeNdjsonClient(sa);

  try {
    ext1.send({ type: 'register', role: 'extension' });
    ext2.send({ type: 'register', role: 'extension' });
    agent.send({ type: 'register', role: 'agent', clientId: 'agent_multi' });
    assert.equal(/** @type {any} */ (await ext1.next()).type, 'registered');
    assert.equal(/** @type {any} */ (await ext2.next()).type, 'registered');
    assert.equal(/** @type {any} */ (await agent.next()).type, 'registered');
    assert.equal(daemon.extensionSockets.size, 2);

    ext1.send({ type: 'extension.access_update', accessEnabled: false });
    ext2.send({ type: 'extension.access_update', accessEnabled: true });

    agent.send({
      type: 'agent.request',
      request: {
        id: 'req_multi',
        method: 'page.get_state',
        tab_id: null,
        params: {},
        meta: { protocol_version: '1.0', token_budget: null },
      },
    });

    await expectNoMessage(ext1);
    const forwarded = /** @type {any} */ (await ext2.next());
    assert.equal(forwarded.type, 'extension.request');
    assert.equal(forwarded.request.id, 'req_multi');

    ext2.send({
      type: 'extension.response',
      response: {
        id: 'req_multi',
        ok: true,
        result: { url: 'https://example.com' },
        error: null,
        meta: { protocol_version: '1.0', method: 'page.get_state' },
      },
    });

    // Agent should receive the success response, not the error.
    const resp = /** @type {any} */ (await agent.next());
    assert.equal(resp.type, 'agent.response');
    assert.equal(resp.response.ok, true);
    assert.equal(resp.response.result.url, 'https://example.com');
  } finally {
    s1.destroy();
    s2.destroy();
    sa.destroy();
    await daemon.stop();
  }
});

test('daemon routes untargeted requests to the most recently active extension when no window is enabled', async () => {
  const { daemon, connect } = await startTestDaemon();
  const s1 = await connect();
  const s2 = await connect();
  const sa = await connect();
  const ext1 = makeNdjsonClient(s1);
  const ext2 = makeNdjsonClient(s2);
  const agent = makeNdjsonClient(sa);

  try {
    ext1.send({ type: 'register', role: 'extension' });
    ext2.send({ type: 'register', role: 'extension' });
    agent.send({ type: 'register', role: 'agent', clientId: 'agent_deny' });
    await ext1.next();
    await ext2.next();
    await agent.next();

    ext1.send({ type: 'extension.activity', at: 10 });
    ext2.send({ type: 'extension.activity', at: 20 });

    agent.send({
      type: 'agent.request',
      request: {
        id: 'req_deny',
        method: 'page.get_state',
        tab_id: null,
        params: {},
        meta: { protocol_version: '1.0', token_budget: null },
      },
    });

    await expectNoMessage(ext1);
    const forwarded = /** @type {any} */ (await ext2.next());
    assert.equal(forwarded.type, 'extension.request');
    assert.equal(forwarded.request.id, 'req_deny');

    ext2.send({
      type: 'extension.response',
      response: {
        id: 'req_deny',
        ok: false,
        result: null,
        error: {
          code: 'ACCESS_DENIED',
          message: 'No window enabled',
          details: null,
        },
        meta: { protocol_version: '1.0', method: 'page.get_state' },
      },
    });

    const resp = /** @type {any} */ (await agent.next());
    assert.equal(resp.type, 'agent.response');
    assert.equal(resp.response.ok, false);
    assert.equal(resp.response.error.code, 'ACCESS_DENIED');
  } finally {
    s1.destroy();
    s2.destroy();
    sa.destroy();
    await daemon.stop();
  }
});

test('daemon sends error response for valid JSON with missing type field', async () => {
  const { daemon, connect } = await startTestDaemon();
  const socket = await connect();
  try {
    const response = await new Promise((resolve, reject) => {
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buf += chunk;
        const idx = buf.indexOf('\n');
        if (idx !== -1) {
          try {
            resolve(JSON.parse(buf.slice(0, idx).trim()));
          } catch {
            reject(new Error('bad json'));
          }
        }
      });
      socket.on('error', reject);
      // Valid JSON but no `type` field - should fall through to the unknown
      // message type handler and get an error response.
      socket.write('{}\n');
    });
    assert.equal(/** @type {any} */ (response).type, 'error');
    assert.equal(/** @type {any} */ (response).error.code, 'INVALID_REQUEST');
  } finally {
    socket.destroy();
    await daemon.stop();
  }
});
