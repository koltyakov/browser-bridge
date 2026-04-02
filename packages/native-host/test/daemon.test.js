// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { BridgeDaemon, installSetupTarget, normalizeSetupInstallParams } from '../src/daemon.js';

/**
 * Start a daemon on a random TCP port and return it alongside a helper to open
 * a raw socket to it. Caller must call `daemon.stop()` after the test.
 *
 * @returns {Promise<{ daemon: BridgeDaemon, connect: () => Promise<net.Socket> }>}
 */
async function startTestDaemon() {
  const daemon = new BridgeDaemon({
    listenOptions: { host: '127.0.0.1', port: 0 },
    logger: { log() {}, error() {} }
  });
  await daemon.start();
  const address = /** @type {import('node:net').AddressInfo} */ (daemon.serverAddress);
  return {
    daemon,
    connect: () => new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: address.port });
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    })
  };
}

/**
 * @returns {import('node:net').Socket & { writes: string[] }}
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
    }
  };
  return /** @type {import('node:net').Socket & { writes: string[] }} */ (/** @type {unknown} */ (socket));
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
      tab_id: null,
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
        token_budget: null
      }
    }
  });

  const payload = JSON.parse(socket.writes[0].trim());
  assert.equal(payload.response.result.deprecated_since, '1.0');
  assert.match(payload.response.result.migration_hint, /daemon is newer than the client protocol 0.0/);
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
        token_budget: null
      }
    }
  });

  const payload = JSON.parse(socket.writes[0].trim());
  assert.equal(payload.response.result.deprecated_since, undefined);
  assert.match(payload.response.result.migration_hint, /daemon is older than the client protocol 9.9/);
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
      tab_id: null,
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
      tab_id: null,
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

test('daemon returns setup status errors to the extension caller', async () => {
  const daemon = new BridgeDaemon({
    logger: console,
    setupStatusLoader: async () => {
      throw new Error('status unavailable');
    }
  });
  const socket = createFakeSocket();

  await daemon.handleClientMessage(socket, {
    type: 'extension.setup_status.request',
    requestId: 'setup_fail'
  });

  const payload = JSON.parse(socket.writes[0].trim());
  assert.equal(payload.type, 'extension.setup_status.error');
  assert.equal(payload.requestId, 'setup_fail');
  assert.equal(payload.error.message, 'status unavailable');
});

test('daemon log entries retain request source metadata', async () => {
  const daemon = new BridgeDaemon({
    logger: console
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
        source: 'mcp'
      }
    }
  });

  await daemon.handleExtensionResponse(extensionSocket, {
    response: {
      id: 'req_eval',
      ok: false,
      result: null,
      error: { code: 'ACCESS_DENIED', message: 'Access denied', details: null },
      meta: { protocol_version: '1.0', method: 'page.evaluate' }
    }
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
        token_budget: null
      }
    }
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
          reason: 'enabled'
        }
      },
      error: null,
      meta: { protocol_version: '1.0', method: 'health.ping' }
    }
  });

  assert.equal(agentSocket.writes.length, 1);
  const payload = JSON.parse(agentSocket.writes[0].trim());
  assert.equal(payload.response.result.daemon, 'ok');
  assert.equal(payload.response.result.extensionConnected, true);
  assert.equal(payload.response.result.access.routeTabId, 42);
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

// --- Security: socket and directory permissions (1.1 / 1.2) ---

test('daemon socket has 0o600 mode and config dir has 0o700 mode (Unix only)', {
  skip: process.platform === 'win32' ? 'chmod is a no-op on Windows' : false
}, async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-perms-'));
  const socketPath = path.join(tempDir, 'test.sock');
  const daemon = new BridgeDaemon({ socketPath, logger: { log() {}, error() {} } });
  try {
    await daemon.start();
    const sockStats = await fs.promises.stat(socketPath);
    assert.equal(
      sockStats.mode & 0o777, 0o600,
      `socket mode should be 0o600, got 0o${(sockStats.mode & 0o777).toString(8)}`
    );
    const dirStats = await fs.promises.stat(tempDir);
    assert.equal(
      dirStats.mode & 0o777, 0o700,
      `config dir mode should be 0o700, got 0o${(dirStats.mode & 0o777).toString(8)}`
    );
  } finally {
    await daemon.stop();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('daemon start fails when another daemon is already listening on the same socket', {
  skip: process.platform === 'win32' ? 'Unix socket single-instance check is not applicable on Windows' : false
}, async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-single-instance-'));
  const socketPath = path.join(tempDir, 'bridge.sock');
  const logger = { log() {}, error() {} };
  const first = new BridgeDaemon({ socketPath, logger });
  const second = new BridgeDaemon({ socketPath, logger });

  try {
    await first.start();
    await assert.rejects(
      () => second.start(),
      /Another daemon is already running on/
    );
  } finally {
    await second.stop().catch(() => {});
    await first.stop();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('daemon start removes a stale socket when the probe returns invalid JSON', {
  skip: process.platform === 'win32' ? 'Unix socket probing is not applicable on Windows' : false
}, async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-stale-socket-'));
  const socketPath = path.join(tempDir, 'bridge.sock');
  /** @type {string[][]} */
  const logs = [];
  const staleServer = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write('not-json\n');
      socket.end();
      staleServer.close();
    });
  });
  await new Promise((resolve, reject) => {
    staleServer.once('error', reject);
    staleServer.listen(socketPath, () => resolve(undefined));
  });

  const daemon = new BridgeDaemon({
    socketPath,
    logger: {
      log(...args) {
        logs.push(args.map((value) => String(value)));
      },
      error() {}
    }
  });

  try {
    await daemon.start();
    assert.ok(logs.some((entry) => entry.join(' ').includes('Removing stale socket from previous run')));
  } finally {
    await daemon.stop().catch(() => {});
    if (staleServer.listening) {
      await new Promise((resolve) => staleServer.close(() => resolve(undefined)));
    }
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('normalizeSetupInstallParams trims targets and defaults to install', () => {
  assert.deepEqual(normalizeSetupInstallParams({
    kind: 'mcp',
    target: '  Codex  '
  }), {
    action: 'install',
    kind: 'mcp',
    target: 'codex'
  });
});

test('normalizeSetupInstallParams rejects invalid input', () => {
  assert.throws(
    () => normalizeSetupInstallParams({ target: 'codex' }),
    /requires kind/
  );
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
    cwd: '/tmp/project'
  });

  assert.deepEqual(await installSetupTarget({
    kind: 'mcp',
    target: 'codex'
  }, deps), {
    action: 'install',
    kind: 'mcp',
    target: 'codex',
    paths: ['/tmp/install-mcp']
  });

  assert.deepEqual(await installSetupTarget({
    action: 'uninstall',
    kind: 'mcp',
    target: 'codex'
  }, deps), {
    action: 'uninstall',
    kind: 'mcp',
    target: 'codex',
    paths: ['/tmp/remove-mcp']
  });

  await assert.rejects(
    () => installSetupTarget({ kind: 'mcp', target: 'cursor' }, {
      ...deps,
      isMcpClientName: () => false
    }),
    /Unsupported MCP client/
  );

  assert.deepEqual(calls, [
    { kind: 'installMcpConfig', target: 'codex', options: { global: true } },
    { kind: 'removeMcpConfig', target: 'codex', options: { global: true } }
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
    cwd: '/tmp/project'
  });

  assert.deepEqual(await installSetupTarget({
    kind: 'skill',
    target: 'codex'
  }, deps), {
    action: 'install',
    kind: 'skill',
    target: 'codex',
    paths: ['/tmp/install-skill']
  });

  assert.deepEqual(await installSetupTarget({
    action: 'uninstall',
    kind: 'skill',
    target: 'codex'
  }, deps), {
    action: 'uninstall',
    kind: 'skill',
    target: 'codex',
    paths: ['/tmp/remove-skill']
  });

  await assert.rejects(
    () => installSetupTarget({ kind: 'skill', target: 'cursor' }, {
      ...deps,
      isSupportedTarget: () => false
    }),
    /Unsupported skill target/
  );

  assert.deepEqual(calls, [
    {
      kind: 'installAgentFiles',
      options: { targets: ['codex'], projectPath: '/tmp/project', global: true }
    },
    {
      kind: 'removeAgentFiles',
      options: { targets: ['codex'], projectPath: '/tmp/project', global: true }
    }
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
        meta: { protocol_version: '1.0', token_budget: null }
      }
    });

    let responseBuffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      responseBuffer += chunk;
      const newlineIndex = responseBuffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const line = responseBuffer.slice(0, newlineIndex).trim();
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error(`Could not parse response: ${line}`));
        }
      }
    });
    socket.on('error', reject);

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
 * @returns {{ next: () => Promise<unknown>, send: (obj: unknown) => void }}
 */
function makeNdjsonClient(socket) {
  /** @type {unknown[]} */
  const pending = [];
  /** @type {((msg: unknown) => void)[]} */
  const waiters = [];
  let buf = '';
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
          if (waiter) {
            waiter(msg);
          }
        } else {
          pending.push(msg);
        }
      } catch { /* skip malformed */ }
    }
  });
  return {
    next() {
      if (pending.length > 0) return Promise.resolve(pending.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
    send(obj) {
      socket.write(`${JSON.stringify(obj)}\n`);
    }
  };
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
    a1.send({ type: 'agent.request', request: { id: 'req_a1', method: 'page.get_state', tab_id: null, params: {}, meta: { protocol_version: '1.0', token_budget: null } } });
    a2.send({ type: 'agent.request', request: { id: 'req_a2', method: 'page.get_state', tab_id: null, params: {}, meta: { protocol_version: '1.0', token_budget: null } } });

    // Extension receives both forwarded requests (order not guaranteed).
    const fwd1 = /** @type {any} */ (await ext.next());
    const fwd2 = /** @type {any} */ (await ext.next());
    assert.equal(fwd1.type, 'extension.request');
    assert.equal(fwd2.type, 'extension.request');
    const forwardedIds = new Set([fwd1.request.id, fwd2.request.id]);
    assert.ok(forwardedIds.has('req_a1'));
    assert.ok(forwardedIds.has('req_a2'));

    // Extension responds out of order: req_a2 first, then req_a1.
    ext.send({ type: 'extension.response', response: { id: 'req_a2', ok: true, result: { url: 'https://a.test' }, error: null, meta: { protocol_version: '1.0', method: 'page.get_state' } } });
    ext.send({ type: 'extension.response', response: { id: 'req_a1', ok: true, result: { url: 'https://b.test' }, error: null, meta: { protocol_version: '1.0', method: 'page.get_state' } } });

    // Each agent gets its own response.
    const resp1 = /** @type {any} */ (await a1.next());
    const resp2 = /** @type {any} */ (await a2.next());
    assert.equal(resp1.type, 'agent.response');
    assert.equal(resp1.response.id, 'req_a1');
    assert.equal(resp2.type, 'agent.response');
    assert.equal(resp2.response.id, 'req_a2');
  } finally {
    s1.destroy(); s2.destroy(); se.destroy();
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
    a1.send({ type: 'agent.request', request: { id: 'req_c1', method: 'page.get_state', tab_id: null, params: {}, meta: { protocol_version: '1.0', token_budget: null } } });
    a2.send({ type: 'agent.request', request: { id: 'req_c2', method: 'page.get_state', tab_id: null, params: {}, meta: { protocol_version: '1.0', token_budget: null } } });

    // Extension receives both requests.
    await ext.next();
    await ext.next();

    // Agent1 disconnects before responses are sent. Allow the daemon to
    // process the close event so req_c1 is removed from pendingRequests.
    s1.destroy();
    await new Promise((r) => setTimeout(r, 20));

    // Extension responds to both. The req_c1 response is silently discarded
    // (no pending entry). The req_c2 response should still reach agent2.
    ext.send({ type: 'extension.response', response: { id: 'req_c1', ok: true, result: {}, error: null, meta: { protocol_version: '1.0', method: 'page.get_state' } } });
    ext.send({ type: 'extension.response', response: { id: 'req_c2', ok: true, result: { url: 'https://c.test' }, error: null, meta: { protocol_version: '1.0', method: 'page.get_state' } } });

    const resp2 = /** @type {any} */ (await a2.next());
    assert.equal(resp2.type, 'agent.response');
    assert.equal(resp2.response.id, 'req_c2');
    assert.equal(resp2.response.ok, true);
  } finally {
    s1.destroy(); s2.destroy(); se.destroy();
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
    agent.send({ type: 'register', role: 'agent', clientId: 'agent_disconnect' });
    await ext.next();
    await agent.next();

    agent.send({
      type: 'agent.request',
      request: {
        id: 'req_disconnect',
        method: 'page.get_state',
        tab_id: null,
        params: {},
        meta: { protocol_version: '1.0', token_budget: null }
      }
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
  } finally {
    se.destroy(); sa.destroy();
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
    agent.send({ type: 'register', role: 'agent', clientId: 'agent_mixed_disconnect' });
    await ext1.next();
    await ext2.next();
    await agent.next();

    agent.send({
      type: 'agent.request',
      request: {
        id: 'req_mixed_disconnect',
        method: 'page.get_state',
        tab_id: null,
        params: {},
        meta: { protocol_version: '1.0', token_budget: null }
      }
    });

    await ext1.next();
    await ext2.next();

    ext1.send({
      type: 'extension.response',
      response: {
        id: 'req_mixed_disconnect',
        ok: false,
        result: null,
        error: { code: 'ACCESS_DENIED', message: 'No window enabled', details: null },
        meta: { protocol_version: '1.0', method: 'page.get_state' }
      }
    });
    s2.destroy();

    const resp = /** @type {any} */ (await agent.next());
    assert.equal(resp.type, 'agent.response');
    assert.equal(resp.response.id, 'req_mixed_disconnect');
    assert.equal(resp.response.ok, false);
    assert.equal(resp.response.error.code, 'ACCESS_DENIED');
  } finally {
    s1.destroy(); s2.destroy(); sa.destroy();
    await daemon.stop();
  }
});

// --- Multi-extension: two Chrome profiles coexist (no kick-off) ---

test('daemon allows two extensions to coexist and routes to the one with access', async () => {
  const { daemon, connect } = await startTestDaemon();
  const s1 = await connect();
  const s2 = await connect();
  const sa = await connect();
  const ext1 = makeNdjsonClient(s1);
  const ext2 = makeNdjsonClient(s2);
  const agent = makeNdjsonClient(sa);

  try {
    // Both extensions register — neither should be destroyed.
    ext1.send({ type: 'register', role: 'extension' });
    ext2.send({ type: 'register', role: 'extension' });
    agent.send({ type: 'register', role: 'agent', clientId: 'agent_multi' });
    assert.equal(/** @type {any} */ (await ext1.next()).type, 'registered');
    assert.equal(/** @type {any} */ (await ext2.next()).type, 'registered');
    assert.equal(/** @type {any} */ (await agent.next()).type, 'registered');
    assert.equal(daemon.extensionSockets.size, 2, 'both extensions should coexist');

    // Agent sends a request — it should be broadcast to both extensions.
    agent.send({
      type: 'agent.request',
      request: {
        id: 'req_multi',
        method: 'page.get_state',
        tab_id: null,
        params: {},
        meta: { protocol_version: '1.0', token_budget: null }
      }
    });

    const fwd1 = /** @type {any} */ (await ext1.next());
    const fwd2 = /** @type {any} */ (await ext2.next());
    assert.equal(fwd1.type, 'extension.request');
    assert.equal(fwd2.type, 'extension.request');

    // Extension 1 responds with ACCESS_DENIED (no window enabled).
    ext1.send({
      type: 'extension.response',
      response: {
        id: 'req_multi',
        ok: false,
        result: null,
        error: { code: 'ACCESS_DENIED', message: 'No window enabled', details: null },
        meta: { protocol_version: '1.0', method: 'page.get_state' }
      }
    });

    // Extension 2 responds with success (window enabled).
    ext2.send({
      type: 'extension.response',
      response: {
        id: 'req_multi',
        ok: true,
        result: { url: 'https://example.com' },
        error: null,
        meta: { protocol_version: '1.0', method: 'page.get_state' }
      }
    });

    // Agent should receive the success response, not the error.
    const resp = /** @type {any} */ (await agent.next());
    assert.equal(resp.type, 'agent.response');
    assert.equal(resp.response.ok, true);
    assert.equal(resp.response.result.url, 'https://example.com');
  } finally {
    s1.destroy(); s2.destroy(); sa.destroy();
    await daemon.stop();
  }
});

test('daemon forwards error when all extensions deny access', async () => {
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

    agent.send({
      type: 'agent.request',
      request: {
        id: 'req_deny',
        method: 'page.get_state',
        tab_id: null,
        params: {},
        meta: { protocol_version: '1.0', token_budget: null }
      }
    });

    await ext1.next();
    await ext2.next();

    // Both extensions respond with errors.
    ext1.send({
      type: 'extension.response',
      response: {
        id: 'req_deny',
        ok: false,
        result: null,
        error: { code: 'ACCESS_DENIED', message: 'No window enabled', details: null },
        meta: { protocol_version: '1.0', method: 'page.get_state' }
      }
    });
    ext2.send({
      type: 'extension.response',
      response: {
        id: 'req_deny',
        ok: false,
        result: null,
        error: { code: 'ACCESS_DENIED', message: 'No window enabled', details: null },
        meta: { protocol_version: '1.0', method: 'page.get_state' }
      }
    });

    const resp = /** @type {any} */ (await agent.next());
    assert.equal(resp.type, 'agent.response');
    assert.equal(resp.response.ok, false);
    assert.equal(resp.response.error.code, 'ACCESS_DENIED');
  } finally {
    s1.destroy(); s2.destroy(); sa.destroy();
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
          try { resolve(JSON.parse(buf.slice(0, idx).trim())); } catch { reject(new Error('bad json')); }
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
