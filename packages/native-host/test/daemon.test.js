// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { BridgeDaemon } from '../src/daemon.js';

/**
 * @returns {net.Socket & { writes: string[] }}
 */
function createFakeSocket() {
  const socket = {
    writes: [],
    /**
     * @param {string} chunk
     * @returns {boolean}
     */
    write(chunk) {
      socket.writes.push(chunk);
      return true;
    }
  };
  return /** @type {net.Socket & { writes: string[] }} */ (/** @type {unknown} */ (socket));
}

/** Ensure health checks succeed even before the extension connects. */
test('daemon responds to health checks without extension', async () => {
  const silentConsole = /** @type {Console} */ ({
    ...console,
    log() {},
    error() {}
  });
  const daemon = new BridgeDaemon({ logger: silentConsole });
  const socket = createFakeSocket();

  await daemon.handleAgentRequest(socket, {
    request: {
      id: 'req_health',
      method: 'health.ping',
      session_id: null,
      params: {},
      meta: {
        protocol_version: '1.0',
        token_budget: null
      }
    }
  });

  assert.equal(socket.writes.length, 1);
  const payload = JSON.parse(socket.writes[0].trim());
  assert.equal(payload.type, 'agent.response');
  assert.equal(payload.response.result.daemon, 'ok');
  assert.equal(payload.response.result.extensionConnected, false);
});

test('daemon responds to setup status requests without extension', async () => {
  const silentConsole = /** @type {Console} */ ({
    ...console,
    log() {},
    error() {}
  });
  /** @type {import('../../protocol/src/types.js').SetupStatus} */
  const expectedStatus = {
    scope: 'global',
    mcpClients: [{ key: 'codex', label: 'OpenAI Codex', detected: true, configPath: '/tmp/mcp.json', configExists: true, configured: true }],
    skillTargets: [{
      key: 'codex',
      label: 'OpenAI Codex',
      detected: true,
      basePath: '/tmp/skills',
      installed: true,
      managed: true,
      installedVersion: '0.1.0',
      currentVersion: '0.1.0',
      updateAvailable: false,
      skills: []
    }]
  };
  const daemon = new BridgeDaemon({
    logger: silentConsole,
    setupStatusLoader: async () => expectedStatus
  });
  const socket = createFakeSocket();

  await daemon.handleAgentRequest(socket, {
    request: {
      id: 'req_setup',
      method: 'setup.get_status',
      session_id: null,
      params: {},
      meta: {
        protocol_version: '1.0',
        token_budget: null
      }
    }
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
      paths: ['/tmp/mock-install']
    })
  });
  const socket = createFakeSocket();

  await daemon.handleAgentRequest(socket, {
    request: {
      id: 'req_setup_install',
      method: 'setup.install',
      session_id: null,
      params: {
        kind: 'mcp',
        target: 'codex'
      },
      meta: {
        protocol_version: '1.0',
        token_budget: null
      }
    }
  });

  assert.equal(socket.writes.length, 1);
  const payload = JSON.parse(socket.writes[0].trim());
  assert.equal(payload.type, 'agent.response');
  assert.equal(payload.response.ok, true);
  assert.deepEqual(payload.response.result, {
    action: 'install',
    kind: 'mcp',
    target: 'codex',
    paths: ['/tmp/mock-install']
  });
});

test('daemon handles extension setup status requests', async () => {
  /** @type {import('../../protocol/src/types.js').SetupStatus} */
  const expectedStatus = {
    scope: 'global',
    mcpClients: [],
    skillTargets: []
  };
  const daemon = new BridgeDaemon({
    logger: console,
    setupStatusLoader: async () => expectedStatus
  });
  const socket = createFakeSocket();

  await daemon.handleClientMessage(socket, {
    type: 'extension.setup_status.request',
    requestId: 'setup_1'
  });

  assert.equal(socket.writes.length, 1);
  const payload = JSON.parse(socket.writes[0].trim());
  assert.equal(payload.type, 'extension.setup_status.response');
  assert.equal(payload.requestId, 'setup_1');
  assert.deepEqual(payload.status, expectedStatus);
});

test('daemon log entries retain request source metadata', async () => {
  const daemon = new BridgeDaemon({
    logger: console
  });
  const agentSocket = createFakeSocket();
  const extensionSocket = createFakeSocket();
  daemon.extensionSocket = extensionSocket;

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_eval',
      method: 'page.evaluate',
      session_id: 'sess_test',
      params: { expression: '1+1' },
      meta: {
        protocol_version: '1.0',
        token_budget: null,
        source: 'mcp'
      }
    }
  });

  await daemon.handleExtensionResponse({
    response: {
      id: 'req_eval',
      ok: false,
      result: null,
      error: { code: 'CAPABILITY_MISSING', message: 'Missing capability', details: null },
      meta: { protocol_version: '1.0', method: 'page.evaluate' }
    }
  });

  assert.equal(daemon.recentLog.length, 1);
  assert.equal(daemon.recentLog[0].source, 'mcp');
});

/** Ensure repeated shutdown calls share one cleanup path safely. */
test('daemon stop is idempotent when called concurrently', async () => {
  const daemon = new BridgeDaemon({
    listenOptions: { host: '127.0.0.1', port: 0 },
    logger: console
  });

  await daemon.start();
  await Promise.all([daemon.stop(), daemon.stop(), daemon.stop()]);

  assert.equal(daemon.server, null);
});
