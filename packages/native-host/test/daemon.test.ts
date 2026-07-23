import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { DAEMON_RECENT_LOG_LIMIT, ERROR_CODES } from '../../protocol/src/index.js';
import type { BridgeRequest, BridgeResponse, SetupStatus } from '../../protocol/src/types.js';
import type { McpClientName } from '../../agent-client/src/mcp-config.js';
import type { SupportedTarget } from '../../agent-client/src/install.js';
import {
  startBridgeSocketServer,
  TEST_PROTOCOL_VERSION as PROTOCOL_VERSION,
  withTempSocketPath,
} from '../../../tests/_helpers/socketHarness.ts';
import { clockController } from '../../../tests/_helpers/faultInjection.ts';
import {
  BridgeDaemon,
  installSetupTarget,
  normalizeSetupInstallParams,
  pingExistingDaemon,
} from '../src/daemon.js';
import type { BridgeTransport } from '../src/config.js';
import { ArtifactStore } from '../src/artifact-store.js';

type FakeSocket = net.Socket & {
  writes: string[];
  readonly __role?: 'agent' | 'extension';
  __clientId?: string;
  __extensionId?: string;
  __browserName?: string;
  __profileLabel?: string;
  __browserExtensionId?: string;
  __accessEnabled?: boolean;
  __lastActiveAt?: number;
};
type ConnectedExtensionSnapshot = {
  extensionId: string;
  browserExtensionId: string | null;
  browserName: string | null;
  profileLabel: string | null;
  accessEnabled: boolean;
};
type HealthPingSnapshot = {
  connectedExtensions: ConnectedExtensionSnapshot[];
  snapshot: ConnectedExtensionSnapshot[] | null;
};
type TestBridgeResult = Record<string, unknown> & {
  daemon?: string;
  daemonVersion?: string;
  extensionConnected?: boolean;
  connectedExtensions?: ConnectedExtensionSnapshot[];
  access?: { routeTabId?: number };
  deprecated_since?: string;
  migration_hint?: string;
  url?: string;
};
type TestBridgeResponse = Omit<BridgeResponse, 'result' | 'error'> & {
  result: TestBridgeResult | null;
  error: { code?: string; message?: string; details?: unknown } | null;
};
type TestPayload = {
  type?: string;
  request?: { id?: string; method?: string; meta?: Record<string, unknown> };
  requestId?: string;
  status?: unknown;
  response?: TestBridgeResponse;
  error?: { code?: string; message?: string };
};
type Waiter = {
  resolve: (msg: unknown) => void;
  reject?: (error: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout> | null;
  nullable: boolean;
};
type NdjsonClient = {
  next: (timeoutMs?: number) => Promise<unknown>;
  nextWithin: (timeoutMs: number) => Promise<unknown | null>;
  send: (obj: unknown) => void;
};
type SetupInstallDeps = Parameters<typeof installSetupTarget>[1];
type InstallCall = { kind: string; target: string; options?: Record<string, unknown> };
type SkillCall = { kind: string; options: Record<string, unknown> };

function parsePayload(line: string): TestPayload {
  return JSON.parse(line) as TestPayload;
}

function expectPayload(value: unknown): TestPayload {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value as TestPayload;
}

function expectBridgeResponse(value: unknown): TestPayload & { response: TestBridgeResponse } {
  const payload = expectPayload(value);
  assert.ok(payload.response);
  return payload as TestPayload & { response: TestBridgeResponse };
}

// Start a daemon on a random TCP port. Caller must call `daemon.stop()`.
async function startTestDaemon(authToken: string | null = null): Promise<{
  daemon: BridgeDaemon;
  connect: () => Promise<net.Socket>;
}> {
  const daemon = new BridgeDaemon({
    transport: {
      type: 'tcp',
      host: '127.0.0.1',
      port: 0,
      label: '127.0.0.1:0',
    } satisfies BridgeTransport,
    listenOptions: { host: '127.0.0.1', port: 0 },
    logger: { log() {}, error() {} },
    authToken,
  });
  await daemon.start();
  const address = daemon.serverAddress as AddressInfo;
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

function createFakeSocket(): FakeSocket {
  const socket = {
    writes: [] as string[],
    write(chunk: string): boolean {
      socket.writes.push(chunk);
      return true;
    },
  };
  return socket as unknown as FakeSocket;
}

async function requestHealthPing(
  daemon: BridgeDaemon,
  agentSocket: FakeSocket,
  extensionSocket: FakeSocket,
  requestId: string
): Promise<HealthPingSnapshot> {
  const extensionWritesBefore = extensionSocket.writes.length;
  const agentWritesBefore = agentSocket.writes.length;

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: requestId,
      method: 'health.ping',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: '0.0',
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
        extensionVersion: '1.8.1',
        access: {
          enabled: Boolean(extensionSocket.__accessEnabled),
        },
      },
      error: null,
      meta: { protocol_version: PROTOCOL_VERSION, method: 'health.ping' },
    },
  });

  assert.equal(agentSocket.writes.length, agentWritesBefore + 1);
  const payload = expectBridgeResponse(
    parsePayload(agentSocket.writes[agentSocket.writes.length - 1].trim())
  );
  assert.ok(payload.response.result?.connectedExtensions);
  return {
    connectedExtensions: payload.response.result.connectedExtensions,
    snapshot: daemon.connectedExtensionsCache as ConnectedExtensionSnapshot[] | null,
  };
}

/** Ensure health checks succeed even before the extension connects. */
test('daemon responds to health checks without extension', async () => {
  const silentConsole = {
    ...console,
    log() {},
    error() {},
  } as Console;
  const daemon = new BridgeDaemon({ logger: silentConsole });
  const socket = createFakeSocket();

  await daemon.handleAgentRequest(socket, {
    request: {
      id: 'req_health',
      method: 'health.ping',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: '0.0',
        token_budget: null,
      },
    },
  });

  assert.equal(socket.writes.length, 1);
  const payload = JSON.parse(socket.writes[0].trim());
  assert.equal(payload.type, 'agent.response');
  assert.equal(payload.response.result.daemon, 'ok');
  assert.equal(typeof payload.response.result.daemonVersion, 'string');
  assert.equal(payload.response.result.extensionConnected, false);
});

test('daemon reports remote proxy exposure only for non-loopback TCP binds', () => {
  const logger = { log() {}, error() {} };

  const socketDaemon = new BridgeDaemon({
    logger,
    transport: {
      type: 'socket',
      socketPath: '/tmp/bbx-test.sock',
      label: '/tmp/bbx-test.sock',
    } satisfies BridgeTransport,
  });
  assert.deepEqual(socketDaemon.getProxyStatusPayload(), { enabled: false, endpoint: null });

  const loopbackDaemon = new BridgeDaemon({
    logger,
    transport: {
      type: 'tcp',
      host: '127.0.0.1',
      port: 9223,
      label: '127.0.0.1:9223',
    } satisfies BridgeTransport,
  });
  assert.deepEqual(loopbackDaemon.getProxyStatusPayload(), { enabled: false, endpoint: null });

  const proxyDaemon = new BridgeDaemon({
    logger,
    transport: {
      type: 'tcp',
      host: '127.0.0.1',
      port: 9223,
      bindHost: '0.0.0.0',
      label: '127.0.0.1:9223 (bind 0.0.0.0)',
    } satisfies BridgeTransport,
  });
  assert.deepEqual(proxyDaemon.getProxyStatusPayload(), {
    enabled: true,
    endpoint: '0.0.0.0:9223',
  });
});

test('daemon responds to invalid agent requests instead of timing out', async () => {
  const daemon = new BridgeDaemon({ logger: { log() {}, error() {} } });
  const socket = createFakeSocket();

  await daemon.handleAgentRequest(socket, {
    request: {
      id: 'req_invalid_method',
      method: 'missing.method',
      params: {},
    } as unknown as BridgeRequest,
  });

  assert.equal(socket.writes.length, 1);
  const payload = expectBridgeResponse(parsePayload(socket.writes[0].trim()));
  assert.equal(payload.type, 'agent.response');
  assert.equal(payload.response.id, 'req_invalid_method');
  assert.equal(payload.response.ok, false);
  assert.equal(payload.response.error?.code, ERROR_CODES.INVALID_REQUEST);
  assert.match(payload.response.error?.message ?? '', /Unsupported method/);
});

test('daemon keeps newer duplicate agent socket when stale socket closes', () => {
  const daemon = new BridgeDaemon({ logger: { log() {}, error() {} } });
  const staleSocket = createFakeSocket();
  const activeSocket = createFakeSocket();

  daemon.registerSocket(staleSocket, { type: 'register', role: 'agent', clientId: 'agent-1' });
  daemon.registerSocket(activeSocket, { type: 'register', role: 'agent', clientId: 'agent-1' });

  assert.equal(daemon.agentSockets.get('agent-1'), activeSocket);
  daemon.handleSocketClose(staleSocket);
  assert.equal(daemon.agentSockets.get('agent-1'), activeSocket);
  daemon.handleSocketClose(activeSocket);
  assert.equal(daemon.agentSockets.has('agent-1'), false);
});

test('daemon registration is one-shot and keeps the socket role immutable', () => {
  const daemon = new BridgeDaemon({ logger: { log() {}, error() {} } });
  const socket = createFakeSocket();

  daemon.registerSocket(socket, { type: 'register', role: 'agent', clientId: 'agent-1' });
  daemon.registerSocket(socket, { type: 'register', role: 'extension' });

  assert.equal(socket.__role, 'agent');
  assert.equal(Object.getOwnPropertyDescriptor(socket, '__role')?.writable, false);
  assert.equal(daemon.extensionSockets.size, 0);
  assert.equal(daemon.agentSockets.get('agent-1'), socket);
  const failure = parsePayload(socket.writes[1].trim());
  assert.equal(failure.type, 'registration_failed');
  assert.equal(failure.error?.code, ERROR_CODES.INVALID_REQUEST);
  assert.match(failure.error?.message ?? '', /already registered as agent/);
});

test('daemon rejects extension messages from agent-role sockets', async () => {
  const daemon = new BridgeDaemon({ logger: { log() {}, error() {} } });
  const socket = createFakeSocket();
  daemon.registerSocket(socket, { type: 'register', role: 'agent', clientId: 'agent-1' });
  socket.writes.length = 0;

  await daemon.handleClientMessage(socket, {
    type: 'extension.access_update',
    accessEnabled: true,
  });

  assert.equal(socket.__accessEnabled, undefined);
  const failure = parsePayload(socket.writes[0].trim());
  assert.equal(failure.type, 'error');
  assert.equal(failure.error?.code, ERROR_CODES.INVALID_REQUEST);
  assert.match(failure.error?.message ?? '', /not allowed for agent sockets/);
});

test('daemon limits extension-role agent requests to health and setup methods', async () => {
  const installs: Record<string, unknown>[] = [];
  const expectedStatus: SetupStatus = {
    scope: 'global',
    mcpClients: [],
    skillTargets: [],
  };
  const daemon = new BridgeDaemon({
    logger: { log() {}, error() {} },
    setupStatusLoader: async () => expectedStatus,
    setupInstaller: async (params) => {
      installs.push(params);
      return {
        action: 'install',
        kind: 'mcp',
        target: 'codex',
        paths: ['/tmp/mcp.json'],
      };
    },
  });
  const socket = createFakeSocket();
  daemon.registerSocket(socket, { type: 'register', role: 'extension' });
  socket.writes.length = 0;

  await daemon.handleClientMessage(socket, {
    type: 'agent.request',
    request: {
      id: 'req_extension_page',
      method: 'page.get_state',
      tab_id: null,
      params: {},
      meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
    },
  });
  await daemon.handleClientMessage(socket, {
    type: 'agent.request',
    request: {
      id: 'req_extension_health',
      method: 'health.ping',
      tab_id: null,
      params: {},
      meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
    },
  });
  const routedHealth = parsePayload(socket.writes[1].trim());
  assert.equal(routedHealth.type, 'extension.request');
  assert.equal(routedHealth.request?.id, 'req_extension_health');
  await daemon.handleExtensionResponse(socket, {
    response: {
      id: 'req_extension_health',
      ok: true,
      result: {
        extension: 'ok',
        supported_versions: [PROTOCOL_VERSION],
      },
      error: null,
      meta: { protocol_version: PROTOCOL_VERSION, method: 'health.ping' },
    },
  });
  await daemon.handleClientMessage(socket, {
    type: 'agent.request',
    request: {
      id: 'req_extension_setup',
      method: 'setup.install',
      tab_id: null,
      params: { kind: 'mcp', target: 'codex' },
      meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
    },
  });
  await daemon.handleClientMessage(socket, {
    type: 'agent.request',
    request: {
      id: 'req_extension_setup_status',
      method: 'setup.get_status',
      tab_id: null,
      params: {},
      meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
    },
  });

  const rejected = parsePayload(socket.writes[0].trim());
  const health = expectBridgeResponse(parsePayload(socket.writes[2].trim()));
  const installed = expectBridgeResponse(parsePayload(socket.writes[3].trim()));
  const status = expectBridgeResponse(parsePayload(socket.writes[4].trim()));
  assert.equal(rejected.type, 'error');
  assert.match(rejected.error?.message ?? '', /not allowed for extension sockets/);
  assert.equal(health.response.ok, true);
  assert.equal(typeof health.response.result?.daemonVersion, 'string');
  assert.equal(installed.response.ok, true);
  assert.equal(status.response.ok, true);
  assert.deepEqual(status.response.result, expectedStatus);
  assert.deepEqual(installs, [{ kind: 'mcp', target: 'codex' }]);
});

test('daemon rejects setup.install from non-local TCP agents', async () => {
  const daemon = new BridgeDaemon({
    transport: {
      type: 'tcp',
      host: '127.0.0.1',
      port: 9223,
      label: '127.0.0.1:9223',
    },
    logger: { log() {}, error() {} },
  });
  const socket = createFakeSocket();
  Reflect.set(socket, 'remoteAddress', '192.0.2.10');
  daemon.registerSocket(socket, { type: 'register', role: 'agent', clientId: 'remote-agent' });
  socket.writes.length = 0;

  await daemon.handleAgentRequest(socket, {
    request: {
      id: 'req_remote_setup',
      method: 'setup.install',
      tab_id: null,
      params: { kind: 'mcp', target: 'codex' },
      meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
    },
  });

  const response = expectBridgeResponse(parsePayload(socket.writes[0].trim()));
  assert.equal(response.response.ok, false);
  assert.equal(response.response.error?.code, ERROR_CODES.ACCESS_DENIED);
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

test('log.tail honors the requested limit', async () => {
  const daemon = new BridgeDaemon({ logger: { log() {}, error() {} } });
  const socket = createFakeSocket();

  for (let index = 0; index < 10; index += 1) {
    daemon.pushLog({ index });
  }

  await daemon.handleAgentRequest(socket, {
    request: {
      id: 'req_logs',
      method: 'log.tail',
      tab_id: null,
      params: { limit: 3 },
      meta: {
        protocol_version: PROTOCOL_VERSION,
        token_budget: null,
      },
    },
  });

  const payload = expectBridgeResponse(JSON.parse(socket.writes[0].trim()));
  assert.deepEqual(payload.response.result?.entries, [{ index: 7 }, { index: 8 }, { index: 9 }]);
});

test('log.tail returns sanitized extension log entries', async () => {
  const daemon = new BridgeDaemon({ logger: { log() {}, error() {} } });
  const socket = createFakeSocket();
  daemon.pushLog({
    url: 'https://user:pass@example.test/api?token=secret#fragment',
    authorization: 'Bearer secret',
    nested: { password: 'secret', tokenCount: 4 },
  });

  await daemon.handleAgentRequest(socket, {
    request: {
      id: 'req_sanitized_logs',
      method: 'log.tail',
      tab_id: null,
      params: { limit: 1 },
      meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
    },
  });

  const payload = expectBridgeResponse(JSON.parse(socket.writes[0].trim()));
  assert.deepEqual(payload.response.result?.entries, [
    {
      url: 'https://example.test/api?token=%5Bredacted%5D',
      authorization: '[redacted]',
      nested: { password: '[redacted]', tokenCount: 4 },
    },
  ]);
});

test('daemon metrics include completed request response time', async () => {
  const daemon = new BridgeDaemon({ logger: { log() {}, error() {} } });
  const agentSocket = createFakeSocket();
  const extensionSocket = createFakeSocket();
  daemon.extensionSockets.set('test-ext', extensionSocket);

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_metric',
      method: 'page.get_text',
      tab_id: 1,
      params: {},
      meta: {
        protocol_version: PROTOCOL_VERSION,
        token_budget: null,
      },
    },
  });

  daemon.requestStartTimes.set('req_metric', Date.now() - 50);

  await daemon.handleExtensionResponse(extensionSocket, {
    response: {
      id: 'req_metric',
      ok: true,
      result: { text: 'Ready' },
      error: null,
      meta: { protocol_version: PROTOCOL_VERSION, method: 'page.get_text' },
    },
  });

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_metrics',
      method: 'daemon.metrics',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: PROTOCOL_VERSION,
        token_budget: null,
      },
    },
  });

  const payload = expectBridgeResponse(JSON.parse(agentSocket.writes[1].trim()));
  assert.equal(payload.response.result?.requestsProcessed, 1);
  assert.ok(Number(payload.response.result?.avgResponseTimeMs) > 0);
});

test('daemon stores screenshot artifacts for the requesting client only', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bbx-daemon-artifact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactStore = new ArtifactStore(path.join(root, 'store'));
  artifactStore.reset();
  const daemon = new BridgeDaemon({
    logger: { log() {}, error() {} },
    artifactStore,
  });
  const agentSocket = createFakeSocket();
  agentSocket.__clientId = 'artifact-client';
  const otherAgent = createFakeSocket();
  otherAgent.__clientId = 'other-client';
  const extensionSocket = createFakeSocket();
  extensionSocket.__extensionId = 'artifact-extension';
  extensionSocket.__accessEnabled = true;
  daemon.extensionSockets.set('artifact-extension', extensionSocket);
  const bytes = Buffer.from('daemon artifact bytes');
  const artifactId = `art_${'d'.repeat(43)}`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_artifact_capture',
      method: 'screenshot.capture_element',
      tab_id: 1,
      params: {
        elementRef: 'el_artifact',
        format: 'png',
        quality: null,
        delivery: 'artifact',
        scale: 1,
      },
      meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
    },
  });
  daemon.handleExtensionArtifact(extensionSocket, {
    type: 'extension.artifact.begin',
    artifact: {
      requestId: 'req_artifact_capture',
      artifactId,
      mimeType: 'image/png',
      byteLength: bytes.length,
      sha256,
      chunkCount: 1,
      createdAt,
      expiresAt,
    },
  });
  daemon.handleExtensionArtifact(extensionSocket, {
    type: 'extension.artifact.chunk',
    artifact: { requestId: 'req_artifact_capture' },
    artifactId,
    chunkIndex: 0,
    data: bytes.toString('base64'),
  });
  daemon.handleExtensionArtifact(extensionSocket, {
    type: 'extension.artifact.commit',
    artifact: { requestId: 'req_artifact_capture' },
    artifactId,
  });
  await daemon.handleExtensionResponse(extensionSocket, {
    response: {
      id: 'req_artifact_capture',
      ok: true,
      result: {
        delivery: 'artifact',
        artifact: { artifactId },
        format: 'png',
        mimeType: 'image/png',
        byteLength: bytes.length,
        dimensions: { width: 10, height: 10 },
        rect: { x: 0, y: 0, width: 10, height: 10, scale: 1 },
        complete: true,
        clipped: false,
      },
      error: null,
      meta: { protocol_version: PROTOCOL_VERSION, method: 'screenshot.capture_element' },
    },
  });
  assert.equal(expectBridgeResponse(parsePayload(agentSocket.writes[0])).response.ok, true);

  const readRequest = {
    id: 'req_artifact_read',
    method: 'artifact.read' as const,
    tab_id: null,
    params: { artifactId, offset: 0, maxBytes: 196_608 },
    meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
  };
  await daemon.handleAgentRequest(otherAgent, { request: readRequest });
  assert.equal(
    expectBridgeResponse(parsePayload(otherAgent.writes[0])).response.error?.code,
    ERROR_CODES.ARTIFACT_NOT_FOUND
  );
  await daemon.handleAgentRequest(agentSocket, { request: readRequest });
  const readResponse = expectBridgeResponse(parsePayload(agentSocket.writes[1])).response;
  assert.equal(readResponse.ok, true);
  assert.equal(readResponse.result?.data, bytes.toString('base64'));

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      ...readRequest,
      id: 'req_artifact_delete',
      method: 'artifact.delete',
      params: { artifactId },
    },
  });
  assert.equal(expectBridgeResponse(parsePayload(agentSocket.writes[2])).response.ok, true);
});

test('daemon routes DOM baseline operations to the creating extension only', async () => {
  const daemon = new BridgeDaemon({ logger: { log() {}, error() {} } });
  const agentSocket = createFakeSocket();
  const creatingExtension = createFakeSocket();
  creatingExtension.__extensionId = 'baseline-owner';
  creatingExtension.__accessEnabled = true;
  creatingExtension.__lastActiveAt = 20;
  const otherExtension = createFakeSocket();
  otherExtension.__extensionId = 'baseline-other';
  otherExtension.__accessEnabled = true;
  otherExtension.__lastActiveAt = 10;
  daemon.extensionSockets.set('baseline-owner', creatingExtension);
  daemon.extensionSockets.set('baseline-other', otherExtension);
  const baselineId = `baseline_${'a'.repeat(43)}`;

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_baseline_create',
      method: 'dom.baseline.create',
      tab_id: 1,
      params: {
        selector: 'main',
        maxNodes: 100,
        maxDepth: 8,
        textBudget: 160,
        attributeAllowlist: [],
      },
      meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
    },
  });
  assert.equal(creatingExtension.writes.length, 1);
  assert.equal(otherExtension.writes.length, 0);
  await daemon.handleExtensionResponse(creatingExtension, {
    response: {
      id: 'req_baseline_create',
      ok: true,
      result: {
        baselineId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      error: null,
      meta: { protocol_version: PROTOCOL_VERSION, method: 'dom.baseline.create' },
    },
  });
  assert.equal(expectBridgeResponse(parsePayload(agentSocket.writes[0])).response.ok, true);

  otherExtension.__lastActiveAt = 100;
  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_baseline_compare',
      method: 'dom.baseline.compare',
      tab_id: null,
      params: { baselineId, maxChanges: 50 },
      meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
    },
  });
  assert.equal(creatingExtension.writes.length, 2);
  assert.equal(otherExtension.writes.length, 0);
  assert.equal(parsePayload(creatingExtension.writes[1]).request?.method, 'dom.baseline.compare');
  await daemon.handleExtensionResponse(creatingExtension, {
    response: {
      id: 'req_baseline_compare',
      ok: true,
      result: { baselineId, equal: true },
      error: null,
      meta: { protocol_version: PROTOCOL_VERSION, method: 'dom.baseline.compare' },
    },
  });

  daemon.handleExtensionAccessUpdate(creatingExtension, { accessEnabled: false });
  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_baseline_describe_missing',
      method: 'dom.baseline.describe',
      tab_id: null,
      params: { baselineId },
      meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
    },
  });
  assert.equal(
    expectBridgeResponse(parsePayload(agentSocket.writes[2])).response.error?.code,
    ERROR_CODES.DOM_BASELINE_NOT_FOUND
  );
  assert.equal(otherExtension.writes.length, 0);
});

test('daemon releases a completed baseline when its requesting agent disconnected', async () => {
  const daemon = new BridgeDaemon({ logger: { log() {}, error() {} } });
  const agentSocket = createFakeSocket();
  agentSocket.__clientId = 'baseline-agent';
  const extensionSocket = createFakeSocket();
  extensionSocket.__extensionId = 'baseline-extension';
  extensionSocket.__accessEnabled = true;
  daemon.extensionSockets.set('baseline-extension', extensionSocket);
  const baselineId = `baseline_${'z'.repeat(43)}`;

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_abandoned_baseline',
      method: 'dom.baseline.create',
      tab_id: 17,
      params: { selector: 'main' },
      meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
    },
  });
  daemon.handleSocketClose(agentSocket);
  await daemon.handleExtensionResponse(extensionSocket, {
    response: {
      id: 'req_abandoned_baseline',
      ok: true,
      result: {
        baselineId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        scope: { tabId: 17 },
      },
      error: null,
      meta: { protocol_version: PROTOCOL_VERSION, method: 'dom.baseline.create' },
    },
  });

  assert.equal(extensionSocket.writes.length, 2);
  const release = parsePayload(extensionSocket.writes[1]);
  const releaseRequest = release.request as
    | { method?: string; tab_id?: number | null; params?: Record<string, unknown> }
    | undefined;
  assert.equal(releaseRequest?.method, 'dom.baseline.release');
  assert.equal(releaseRequest?.tab_id, 17);
  assert.deepEqual(releaseRequest?.params, { baselineId });
  assert.equal(daemon.abandonedDomBaselineCreates.size, 0);
});

test('daemon hides baseline owner metadata until extension access is confirmed', () => {
  const daemon = new BridgeDaemon({ logger: { log() {}, error() {} } });
  const extensionSocket = createFakeSocket();
  extensionSocket.__extensionId = 'disabled-baseline-extension';
  extensionSocket.__accessEnabled = false;
  daemon.extensionSockets.set('disabled-baseline-extension', extensionSocket);
  const baselineId = `baseline_${'y'.repeat(43)}`;
  assert.equal(
    daemon.registerDomBaselineOwner(
      baselineId,
      extensionSocket,
      new Date(Date.now() + 60_000).toISOString()
    ),
    true
  );
  assert.equal(daemon.getDomBaselineOwner(baselineId), null);
  extensionSocket.__accessEnabled = true;
  assert.equal(daemon.getDomBaselineOwner(baselineId), extensionSocket);
});

test('daemon completes a request immediately when every target write fails', async () => {
  const daemon = new BridgeDaemon({ logger: { log() {}, error() {} } });
  const agentSocket = createFakeSocket();
  const extensionSocket = createFakeSocket();
  let destroyed = false;
  extensionSocket.__extensionId = 'failed-ext';
  extensionSocket.write = () => {
    throw new Error('socket closed');
  };
  extensionSocket.destroy = (() => {
    destroyed = true;
    return extensionSocket;
  }) as typeof extensionSocket.destroy;
  daemon.extensionSockets.set('failed-ext', extensionSocket);

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_write_fail',
      method: 'dom.query',
      tab_id: 1,
      params: {},
      meta: {
        protocol_version: PROTOCOL_VERSION,
        token_budget: null,
      },
    },
  });

  const payload = expectBridgeResponse(JSON.parse(agentSocket.writes[0].trim()));
  assert.equal(destroyed, true);
  assert.equal(daemon.pendingRequests.has('req_write_fail'), false);
  assert.equal(daemon.extensionSockets.has('failed-ext'), false);
  assert.equal(payload.response.ok, false);
  assert.equal(payload.response.error?.code, 'EXTENSION_DISCONNECTED');
});

test('daemon route failure does not delete a socket that replaced the selected target', async () => {
  const daemon = new BridgeDaemon({ logger: { log() {}, error() {} } });
  const agentSocket = createFakeSocket();
  const selectedSocket = createFakeSocket();
  const replacementSocket = createFakeSocket();
  selectedSocket.__extensionId = 'replaced-ext';
  selectedSocket.write = () => {
    daemon.extensionSockets.set('replaced-ext', replacementSocket);
    throw new Error('selected socket closed');
  };
  selectedSocket.destroy = (() => selectedSocket) as typeof selectedSocket.destroy;
  daemon.extensionSockets.set('replaced-ext', selectedSocket);

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_route_mutation',
      method: 'dom.query',
      tab_id: 1,
      params: {},
      meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
    },
  });

  assert.equal(daemon.extensionSockets.get('replaced-ext'), replacementSocket);
  assert.equal(daemon.pendingRequests.has('req_route_mutation'), false);
  const payload = expectBridgeResponse(parsePayload(agentSocket.writes[0].trim()));
  assert.equal(payload.response.error?.code, ERROR_CODES.EXTENSION_DISCONNECTED);
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
    transport: {
      type: 'tcp',
      host: '127.0.0.1',
      port: 0,
      label: '127.0.0.1:0',
    } satisfies BridgeTransport,
    listenOptions: { host: '127.0.0.1', port: 0 },
    logger: { log() {}, error() {} },
    authToken: null,
  });

  try {
    await daemon.start();
    const address = daemon.serverAddress as AddressInfo;
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
          message && typeof message === 'object' ? (message as Record<string, unknown>) : null;
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
  assert.equal(payload.response.result.deprecated_since, PROTOCOL_VERSION);
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
  const silentConsole = {
    ...console,
    log() {},
    error() {},
  } as Console;
  const expectedStatus: SetupStatus = {
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
        protocol_version: PROTOCOL_VERSION,
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
        protocol_version: PROTOCOL_VERSION,
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
  const expectedStatus: SetupStatus = {
    scope: 'global',
    mcpClients: [],
    skillTargets: [],
  };
  const daemon = new BridgeDaemon({
    logger: console,
    setupStatusLoader: async () => expectedStatus,
  });
  const socket = createFakeSocket();
  daemon.registerSocket(socket, { type: 'register', role: 'extension' });
  socket.writes.length = 0;

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
  daemon.registerSocket(socket, { type: 'register', role: 'extension' });
  socket.writes.length = 0;

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
        protocol_version: PROTOCOL_VERSION,
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
      meta: { protocol_version: PROTOCOL_VERSION, method: 'page.evaluate' },
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
        protocol_version: '0.0',
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
        extensionVersion: '1.8.1',
        access: {
          enabled: true,
          windowId: 9,
          routeTabId: 42,
          routeReady: true,
          reason: 'enabled',
        },
      },
      error: null,
      meta: { protocol_version: PROTOCOL_VERSION, method: 'health.ping' },
    },
  });

  assert.equal(agentSocket.writes.length, 1);
  const payload = JSON.parse(agentSocket.writes[0].trim());
  assert.equal(payload.response.result.daemon, 'ok');
  assert.equal(typeof payload.response.result.daemonVersion, 'string');
  assert.equal(payload.response.result.extensionConnected, true);
  assert.equal(payload.response.result.extensionVersion, '1.8.1');
  assert.equal(payload.response.result.access.routeTabId, 42);
  assert.equal(payload.response.result.deprecated_since, PROTOCOL_VERSION);
  assert.match(payload.response.result.migration_hint, /client protocol 0.0/);
});

test('daemon health ignores malicious extension overrides and preserves bounded diagnostics', async () => {
  const daemon = new BridgeDaemon({ logger: console });
  const agentSocket = createFakeSocket();
  const extensionSocket = createFakeSocket();
  daemon.extensionSockets.set('trusted-connection-id', extensionSocket);

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_health_hostile',
      method: 'health.ping',
      tab_id: null,
      params: {},
      meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
    },
  });
  await daemon.handleExtensionResponse(extensionSocket, {
    response: {
      id: 'req_health_hostile',
      ok: true,
      result: {
        daemon: 'compromised',
        daemonVersion: '999.0.0',
        extensionConnected: false,
        extensionVersion: 'private-version',
        connectedExtensions: [{ profileLabel: 'private' }],
        socketPath: '/private/socket',
        transport: 'attacker.example:9999',
        proxy: { enabled: true, endpoint: 'attacker.example:9999', token: 'secret' },
        daemon_supported_versions: ['999.0'],
        deprecated_since: 'private-version',
        migration_hint: 'private migration payload',
        supported_versions: ['0.9', 'private-version'],
        access: {
          enabled: true,
          windowId: 9,
          routeTabId: 42,
          routeReady: true,
          reason: 'enabled',
          routeUrl: 'https://private.example/account?token=secret',
          privateValue: 'secret',
        },
        debugger: {
          status: 'active',
          attachedTabCount: 1_000_000,
          heldTabCount: 2,
          pendingTabCount: -1,
          recentReason: 'debugger_conflict',
          rawError: 'private debugger error',
        },
        capture: {
          state: 'armed',
          activeTabCount: 3,
          ownershipCount: 2,
          inflightCount: 1_000_000,
          interceptionActiveTabCount: 1,
          interceptionRuleCount: 4,
          requestBody: 'private body',
        },
        domBaselines: {
          baselineCount: 2,
          bytes: 500,
          tabCount: 1,
          pageText: 'private baseline text',
          operations: {
            compare: { calls: 3, totalLatencyMs: 12.8, maxLatencyMs: 7.2, selector: 'private' },
            privateOperation: { calls: 99 },
          },
        },
      },
      error: null,
      meta: {
        protocol_version: '999.0',
        method: 'page.evaluate',
        protocol_warning: 'private warning',
      },
    },
  });

  const payload = JSON.parse(agentSocket.writes[0].trim());
  const result = payload.response.result;
  assert.equal(result.daemon, 'ok');
  assert.notEqual(result.daemonVersion, '999.0.0');
  assert.equal(result.extensionConnected, true);
  assert.equal(result.extensionVersion, undefined);
  assert.deepEqual(result.connectedExtensions, [
    {
      extensionId: 'trusted-connection-id',
      browserExtensionId: null,
      browserName: null,
      profileLabel: null,
      accessEnabled: false,
    },
  ]);
  assert.equal(result.socketPath, daemon.socketPath);
  assert.equal(result.transport, daemon.transport.label);
  assert.deepEqual(result.proxy, { enabled: false, endpoint: null });
  assert.deepEqual(result.supported_versions, [PROTOCOL_VERSION]);
  assert.deepEqual(result.daemon_supported_versions, [PROTOCOL_VERSION]);
  assert.deepEqual(result.extension_supported_versions, ['0.9']);
  assert.deepEqual(result.access, {
    enabled: true,
    windowId: 9,
    routeTabId: 42,
    routeReady: true,
    reason: 'enabled',
  });
  assert.deepEqual(result.debugger, {
    status: 'active',
    attachedTabCount: 10_000,
    heldTabCount: 2,
    recentReason: 'debugger_conflict',
  });
  assert.deepEqual(result.capture, {
    state: 'armed',
    activeTabCount: 3,
    ownershipCount: 2,
    inflightCount: 10_000,
    interceptionActiveTabCount: 1,
    interceptionRuleCount: 4,
  });
  assert.deepEqual(result.domBaselines, {
    baselineCount: 2,
    bytes: 500,
    tabCount: 1,
    operations: { compare: { calls: 3, totalLatencyMs: 12, maxLatencyMs: 7 } },
  });
  assert.deepEqual(payload.response.meta, {
    protocol_version: PROTOCOL_VERSION,
    method: 'health.ping',
  });
  assert.doesNotMatch(JSON.stringify(payload.response), /private|attacker|secret|compromised/u);
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
        protocol_version: PROTOCOL_VERSION,
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
        protocol_version: PROTOCOL_VERSION,
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
        protocol_version: PROTOCOL_VERSION,
        token_budget: null,
      },
    },
  });

  assert.equal(olderExtension.writes.length, 0);
  assert.equal(mostRecentExtension.writes.length, 1);
  assert.equal(middleExtension.writes.length, 0);
});

test('daemon deterministically selects one extension without mutating socket order', async () => {
  const daemon = new BridgeDaemon({ logger: console });
  const agentSocket = createFakeSocket();
  const extensionB = createFakeSocket();
  const extensionA = createFakeSocket();
  extensionB.__accessEnabled = true;
  extensionA.__accessEnabled = true;
  extensionB.__lastActiveAt = 20;
  extensionA.__lastActiveAt = 20;
  daemon.extensionSockets.set('extension-b', extensionB);
  daemon.extensionSockets.set('extension-a', extensionA);
  const orderBeforeRouting = [...daemon.extensionSockets.keys()];

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_deterministic_unit',
      method: 'page.get_state',
      tab_id: null,
      params: {},
      meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
    },
  });

  assert.deepEqual([...daemon.extensionSockets.keys()], orderBeforeRouting);
  assert.equal(extensionA.writes.length, 1);
  assert.equal(extensionB.writes.length, 0);
  assert.deepEqual(
    daemon.pendingRequests.get('req_deterministic_unit')?.targets,
    new Set([extensionA])
  );
});

test('daemon ignores responses forged by a non-target extension socket', async () => {
  const daemon = new BridgeDaemon({ logger: console });
  const agentSocket = createFakeSocket();
  const targetExtension = createFakeSocket();
  const otherExtension = createFakeSocket();
  targetExtension.__lastActiveAt = 20;
  otherExtension.__lastActiveAt = 10;
  daemon.extensionSockets.set('target', targetExtension);
  daemon.extensionSockets.set('other', otherExtension);

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_forged_response',
      method: 'page.get_state',
      tab_id: null,
      params: {},
      meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
    },
  });

  const forgedResponse = {
    id: 'req_forged_response',
    ok: true as const,
    result: { url: 'https://forged.example/' },
    error: null,
    meta: { protocol_version: PROTOCOL_VERSION, method: 'page.get_state' },
  };
  await daemon.handleExtensionResponse(otherExtension, { response: forgedResponse });
  assert.equal(agentSocket.writes.length, 0);
  assert.deepEqual(
    daemon.pendingRequests.get('req_forged_response')?.targets,
    new Set([targetExtension])
  );

  await daemon.handleExtensionResponse(targetExtension, {
    response: {
      ...forgedResponse,
      result: { url: 'https://target.example/' },
    },
  });
  const payload = expectBridgeResponse(parsePayload(agentSocket.writes[0].trim()));
  assert.equal(payload.response.result?.url, 'https://target.example/');
});

test('daemon routes explicit browser and profile targets only to matching extensions', async () => {
  const daemon = new BridgeDaemon({ logger: console });
  const agentSocket = createFakeSocket();
  const chromeWork = createFakeSocket();
  chromeWork.__browserName = 'Chrome';
  chromeWork.__profileLabel = 'Work';
  chromeWork.__accessEnabled = true;
  chromeWork.__lastActiveAt = 10;
  const chromeWorkRecent = createFakeSocket();
  chromeWorkRecent.__browserName = 'Chrome';
  chromeWorkRecent.__profileLabel = 'Work';
  chromeWorkRecent.__accessEnabled = true;
  chromeWorkRecent.__lastActiveAt = 20;
  const chromePersonal = createFakeSocket();
  chromePersonal.__browserName = 'Chrome';
  chromePersonal.__profileLabel = 'Personal';
  const edgeWork = createFakeSocket();
  edgeWork.__browserName = 'Edge';
  edgeWork.__profileLabel = 'Work';
  daemon.extensionSockets.set('chrome-work', chromeWork);
  daemon.extensionSockets.set('chrome-work-recent', chromeWorkRecent);
  daemon.extensionSockets.set('chrome-personal', chromePersonal);
  daemon.extensionSockets.set('edge-work', edgeWork);

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_targeted_profile',
      method: 'page.get_state',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: PROTOCOL_VERSION,
        token_budget: null,
        target_browser: 'Chrome',
        target_profile: 'Work',
      },
    },
  });

  assert.equal(chromeWork.writes.length, 0);
  assert.equal(chromeWorkRecent.writes.length, 1);
  assert.equal(chromePersonal.writes.length, 0);
  assert.equal(edgeWork.writes.length, 0);
  const routedPayload = parsePayload(chromeWorkRecent.writes[0].trim());
  assert.equal(routedPayload.request?.id, 'req_targeted_profile');
  assert.equal(routedPayload.request?.method, 'page.get_state');
  assert.equal(routedPayload.request?.meta?.target_browser, 'Chrome');
  assert.equal(routedPayload.request?.meta?.target_profile, 'Work');

  await daemon.handleExtensionResponse(chromeWorkRecent, {
    response: {
      id: 'req_targeted_profile',
      ok: true,
      result: { url: 'https://work.example/' },
      error: null,
      meta: { protocol_version: PROTOCOL_VERSION, method: 'page.get_state' },
    },
  });

  assert.equal(agentSocket.writes.length, 1);
  const responsePayload = expectBridgeResponse(parsePayload(agentSocket.writes[0].trim()));
  assert.equal(responsePayload.response.result?.url, 'https://work.example/');

  await daemon.handleAgentRequest(agentSocket, {
    request: {
      id: 'req_missing_profile',
      method: 'page.get_state',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: PROTOCOL_VERSION,
        token_budget: null,
        target_browser: 'Chrome',
        target_profile: 'Missing',
      },
    },
  });

  assert.equal(chromeWork.writes.length, 0);
  assert.equal(chromeWorkRecent.writes.length, 1);
  assert.equal(chromePersonal.writes.length, 0);
  assert.equal(edgeWork.writes.length, 0);
  assert.equal(agentSocket.writes.length, 2);
  const failurePayload = expectBridgeResponse(parsePayload(agentSocket.writes[1].trim()));
  assert.equal(failurePayload.response.ok, false);
  assert.equal(failurePayload.response.error?.code, 'EXTENSION_DISCONNECTED');
  assert.match(
    failurePayload.response.error?.message ?? '',
    /target_browser="Chrome" target_profile="Missing"/
  );
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
      browserExtensionId: null,
      browserName: null,
      profileLabel: null,
      accessEnabled: false,
    },
  ]);

  daemon.registerSocket(extensionTwo, {
    type: 'register',
    role: 'extension',
    browserExtensionId: 'private-extension-id',
  });
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
      browserExtensionId: null,
      browserName: null,
      profileLabel: null,
      accessEnabled: false,
    },
    {
      extensionId: extensionTwo.__extensionId,
      browserExtensionId: null,
      browserName: null,
      profileLabel: null,
      accessEnabled: false,
    },
  ]);

  daemon.handleExtensionIdentity(extensionOne, {
    browserName: 'Chrome',
    profileLabel: 'Work',
    browserExtensionId: 'jjjkmmcdkpcgamlopogicbnnhdgebhie',
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
      browserExtensionId: 'jjjkmmcdkpcgamlopogicbnnhdgebhie',
      browserName: 'Chrome',
      profileLabel: 'Work',
      accessEnabled: true,
    },
    {
      extensionId: extensionTwo.__extensionId,
      browserExtensionId: null,
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
      browserExtensionId: 'jjjkmmcdkpcgamlopogicbnnhdgebhie',
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
        protocol_version: PROTOCOL_VERSION,
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
      meta: { protocol_version: PROTOCOL_VERSION, method: 'page.get_state' },
    },
  });

  assert.equal(agentSocket.writes.length, 1);
});

test('daemon pending deadlines include normalized long operation timeouts without sleeping', async (t) => {
  const daemon = new BridgeDaemon({ logger: console });
  const agentSocket = createFakeSocket();
  const extensionSocket = createFakeSocket();
  daemon.extensionSockets.set('timeout-ext', extensionSocket);
  const clock = clockController();
  t.mock.method(globalThis, 'setTimeout', clock.setTimeout);
  t.mock.method(globalThis, 'clearTimeout', clock.clearTimeout);

  const requests: BridgeRequest[] = [
    {
      id: 'req_long_navigation',
      method: 'navigation.navigate',
      tab_id: null,
      params: { url: 'https://example.test/', timeoutMs: 60_000 },
      meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
    },
    {
      id: 'req_long_wait',
      method: 'page.wait_for_load_state',
      tab_id: null,
      params: { timeoutMs: 45_000 },
      meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
    },
    {
      id: 'req_bounded_timeout',
      method: 'page.get_state',
      tab_id: null,
      params: { timeoutMs: 999_999 },
      meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
    },
  ];

  for (const request of requests) {
    await daemon.handleAgentRequest(agentSocket, { request });
  }

  assert.deepEqual(clock.delays, [62_000, 47_000, 122_000]);
  for (const request of requests) {
    const pending = daemon.pendingRequests.get(request.id);
    assert.ok(pending);
    daemon.clearPendingRequest(request.id, pending);
  }
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
  const clearedTimeouts: Parameters<typeof clearTimeout>[0][] = [];
  const clearTimeoutMock = (timeoutId: Parameters<typeof clearTimeout>[0]): void => {
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
        protocol_version: PROTOCOL_VERSION,
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
        protocol_version: PROTOCOL_VERSION,
        token_budget: null,
      },
    },
  });

  const removedPending = daemon.pendingRequests.get('req_owner_closed');
  const survivingPending = daemon.pendingRequests.get('req_owner_survives');
  assert.ok(removedPending);
  assert.ok(survivingPending);
  assert.deepEqual(removedPending.targets, new Set([extensionOne]));
  assert.deepEqual(survivingPending.targets, new Set([extensionOne]));
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
  assert.equal(daemon.pendingRequestsByTargetSocket.has(extensionTwo), false);

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
  assert.equal(daemon.pendingRequestsByTargetSocket.has(extensionTwo), false);
  assert.deepEqual(clearedTimeouts, [removedPending.timeoutId]);

  await daemon.handleExtensionResponse(extensionOne, {
    response: {
      id: 'req_owner_closed',
      ok: true,
      result: { url: 'https://ignored.example/closed' },
      error: null,
      meta: { protocol_version: PROTOCOL_VERSION, method: 'page.get_state' },
    },
  });
  await daemon.handleExtensionResponse(extensionOne, {
    response: {
      id: 'req_owner_survives',
      ok: true,
      result: { url: 'https://still-alive.example/' },
      error: null,
      meta: { protocol_version: PROTOCOL_VERSION, method: 'page.get_state' },
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

test('daemon socket close fails only requests routed to the disconnected extension', async () => {
  const daemon = new BridgeDaemon({ logger: console });
  const agentOne = createFakeSocket();
  const agentTwo = createFakeSocket();
  const extensionOne = createFakeSocket();
  const extensionTwo = createFakeSocket();
  extensionOne.__accessEnabled = true;
  extensionTwo.__accessEnabled = false;
  daemon.extensionSockets.set('ext-one', extensionOne);
  daemon.extensionSockets.set('ext-two', extensionTwo);

  await daemon.handleAgentRequest(agentOne, {
    request: {
      id: 'req_extension_close_one',
      method: 'page.get_state',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: PROTOCOL_VERSION,
        token_budget: null,
      },
    },
  });
  extensionOne.__accessEnabled = false;
  extensionTwo.__accessEnabled = true;
  await daemon.handleAgentRequest(agentTwo, {
    request: {
      id: 'req_extension_close_two',
      method: 'page.get_state',
      tab_id: null,
      params: {},
      meta: {
        protocol_version: PROTOCOL_VERSION,
        token_budget: null,
      },
    },
  });

  const firstPending = daemon.pendingRequests.get('req_extension_close_one');
  const secondPending = daemon.pendingRequests.get('req_extension_close_two');
  assert.ok(firstPending);
  assert.ok(secondPending);
  assert.deepEqual(firstPending.targets, new Set([extensionOne]));
  assert.deepEqual(secondPending.targets, new Set([extensionTwo]));

  extensionOne.__extensionId = 'ext-one';
  daemon.handleSocketClose(extensionOne);

  assert.equal(daemon.extensionSockets.has('ext-one'), false);
  assert.equal(daemon.pendingRequests.has('req_extension_close_one'), false);
  assert.equal(daemon.pendingRequests.has('req_extension_close_two'), true);
  assert.deepEqual(firstPending.targets, new Set());
  assert.deepEqual(secondPending.targets, new Set([extensionTwo]));
  assert.equal(daemon.pendingRequestsByTargetSocket.has(extensionOne), false);
  assert.deepEqual(
    daemon.pendingRequestsByTargetSocket.get(extensionTwo),
    new Set(['req_extension_close_two'])
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(agentOne.writes.length, 1);
  assert.equal(agentTwo.writes.length, 0);

  await daemon.handleExtensionResponse(extensionTwo, {
    response: {
      id: 'req_extension_close_two',
      ok: true,
      result: { url: 'https://survivor-two.example/' },
      error: null,
      meta: { protocol_version: PROTOCOL_VERSION, method: 'page.get_state' },
    },
  });

  assert.equal(agentTwo.writes.length, 1);
  const payloadOne = JSON.parse(agentOne.writes[0].trim());
  const payloadTwo = JSON.parse(agentTwo.writes[0].trim());
  assert.equal(payloadOne.response.id, 'req_extension_close_one');
  assert.equal(payloadOne.response.error.code, ERROR_CODES.EXTENSION_DISCONNECTED);
  assert.equal(payloadTwo.response.id, 'req_extension_close_two');
  assert.equal(payloadTwo.response.result.url, 'https://survivor-two.example/');
});

/** Ensure repeated shutdown calls share one cleanup path safely. */
test('daemon stop is idempotent when called concurrently', async () => {
  const daemon = new BridgeDaemon({
    transport: {
      type: 'tcp',
      host: '127.0.0.1',
      port: 0,
      label: '127.0.0.1:0',
    } satisfies BridgeTransport,
    listenOptions: { host: '127.0.0.1', port: 0 },
    logger: console,
    authToken: null,
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
    const storePath = path.join(tempDir, 'artifacts');
    const firstStore = new ArtifactStore(storePath);
    const secondStore = new ArtifactStore(storePath);
    const first = new BridgeDaemon({ socketPath, logger, artifactStore: firstStore });
    const second = new BridgeDaemon({ socketPath, logger, artifactStore: secondStore });

    try {
      await first.start();
      const bytes = Buffer.from('preserved artifact');
      const artifactId = `art_${'f'.repeat(43)}`;
      firstStore.begin({
        artifactId,
        requestId: 'capture-preserved',
        ownerId: 'client-preserved',
        extensionId: 'extension-preserved',
        kind: 'screenshot',
        mimeType: 'image/png',
        totalBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        chunkCount: 1,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      firstStore.writeChunk(artifactId, 0, bytes.toString('base64'));
      firstStore.commit(artifactId);
      await assert.rejects(() => second.start(), /Another daemon is already running on/);
      assert.equal(
        firstStore.read(artifactId, 'client-preserved', 0, bytes.length).data,
        bytes.toString('base64')
      );
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
    const logs: string[][] = [];
    const staleServer = await startBridgeSocketServer(
      async (message, context) => {
        const record =
          message && typeof message === 'object' ? (message as Record<string, unknown>) : null;
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
    () => normalizeSetupInstallParams({ action: 'unistall', kind: 'skill', target: 'codex' }),
    /action must be "install" or "uninstall"/
  );
  assert.throws(
    () => normalizeSetupInstallParams({ kind: 'skill', target: '   ' }),
    /requires a target/
  );
});

test('installSetupTarget dispatches mcp installs and uninstalls', async () => {
  const calls: InstallCall[] = [];
  const deps: SetupInstallDeps = {
    installAgentFiles: async () => {
      throw new Error('unexpected skill install');
    },
    isSupportedTarget: (_value: string): _value is SupportedTarget => false,
    removeAgentFiles: async () => {
      throw new Error('unexpected skill uninstall');
    },
    installMcpConfig: async (target: McpClientName, options: Record<string, unknown>) => {
      calls.push({ kind: 'installMcpConfig', target, options });
      return '/tmp/install-mcp';
    },
    isMcpClientName: (target: string): target is McpClientName => target === 'codex',
    removeMcpConfig: async (target: McpClientName, options: Record<string, unknown>) => {
      calls.push({ kind: 'removeMcpConfig', target, options });
      return ['/tmp/remove-mcp'];
    },
    cwd: '/tmp/project',
  };

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
          isMcpClientName: (_value: string): _value is McpClientName => false,
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
  const calls: SkillCall[] = [];
  const deps: SetupInstallDeps = {
    installAgentFiles: async (options: Record<string, unknown>) => {
      calls.push({ kind: 'installAgentFiles', options });
      return ['/tmp/install-skill'];
    },
    isSupportedTarget: (target: string): target is SupportedTarget => target === 'codex',
    removeAgentFiles: async (options: Record<string, unknown>) => {
      calls.push({ kind: 'removeAgentFiles', options });
      return ['/tmp/remove-skill'];
    },
    installMcpConfig: async () => {
      throw new Error('unexpected mcp install');
    },
    isMcpClientName: (_value: string): _value is McpClientName => false,
    removeMcpConfig: async () => {
      throw new Error('unexpected mcp uninstall');
    },
    cwd: '/tmp/project',
  };

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
          isSupportedTarget: (_value: string): _value is SupportedTarget => false,
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

// Send raw bytes over a socket, then send a valid health.ping and parse one response line.
function sendGarbageThenPing(socket: net.Socket, garbage: Buffer | string): Promise<TestPayload> {
  return new Promise<TestPayload>((resolve, reject) => {
    const validRequest = JSON.stringify({
      type: 'agent.request',
      request: {
        id: 'req_probe',
        method: 'health.ping',
        tab_id: null,
        params: {},
        meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
      },
    });

    let responseBuffer = '';
    socket.setEncoding('utf8');
    let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for daemon response.'));
    }, 2_000);

    function cleanup(): void {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      socket.off('data', handleData);
      socket.off('error', handleError);
      socket.off('close', handleClose);
      socket.off('end', handleEnd);
    }

    function handleData(chunk: string): void {
      responseBuffer += chunk;
      while (responseBuffer.includes('\n')) {
        const newlineIndex = responseBuffer.indexOf('\n');
        const line = responseBuffer.slice(0, newlineIndex).trim();
        responseBuffer = responseBuffer.slice(newlineIndex + 1);
        try {
          const payload = parsePayload(line);
          if (payload.type === 'agent.response') {
            cleanup();
            resolve(payload);
          }
        } catch {
          // Ignore malformed daemon output and keep waiting for the response.
        }
      }
    }

    function handleError(error: Error): void {
      cleanup();
      reject(error);
    }

    function handleClose(): void {
      cleanup();
      reject(new Error('Socket closed before daemon responded.'));
    }

    function handleEnd(): void {
      cleanup();
      reject(new Error('Socket ended before daemon responded.'));
    }

    socket.on('data', handleData);
    socket.on('error', handleError);
    socket.on('close', handleClose);
    socket.on('end', handleEnd);

    socket.write(`${JSON.stringify({ type: 'register', role: 'agent' })}\n`);
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
    assert.equal(response.type, 'agent.response');
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
    assert.equal(response.type, 'agent.response');
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
    assert.equal(response.type, 'agent.response');
  } finally {
    socket.destroy();
    await daemon.stop();
  }
});

// --- Concurrency: multiple agents (5.3) ---

// Wrap a TCP socket with NDJSON send/receive helpers.
function makeNdjsonClient(socket: net.Socket): NdjsonClient {
  const pending: unknown[] = [];
  const waiters: Waiter[] = [];
  let buf = '';
  let terminalError: Error | null = null;

  function clearWaiterTimeout(waiter: Waiter): void {
    if (waiter.timeoutId) {
      clearTimeout(waiter.timeoutId);
      waiter.timeoutId = null;
    }
  }

  function settleAllWaiters(error: Error): void {
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
  socket.on('data', (chunk: string) => {
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
    next(timeoutMs = 2_000): Promise<unknown> {
      if (pending.length > 0) return Promise.resolve(pending.shift());
      if (terminalError) return Promise.reject(terminalError);
      return new Promise<unknown>((resolve, reject) => {
        const waiter: Waiter = {
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
    nextWithin(timeoutMs: number): Promise<unknown | null> {
      if (pending.length > 0) {
        return Promise.resolve(pending.shift() ?? null);
      }
      if (terminalError) {
        return Promise.resolve(null);
      }
      return new Promise<unknown | null>((resolve) => {
        const waiter: Waiter = {
          nullable: true,
          resolve(msg: unknown): void {
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
    send(obj: unknown): void {
      socket.write(`${JSON.stringify(obj)}\n`);
    },
  };
}

async function expectNoMessage(
  client: Pick<NdjsonClient, 'nextWithin'>,
  timeoutMs = 50
): Promise<void> {
  assert.equal(await client.nextWithin(timeoutMs), null);
}

async function waitForCondition(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting ${timeoutMs}ms for test condition.`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('daemon requires auth token before handling TCP bridge requests when configured', async () => {
  const authToken = 'a'.repeat(32);
  const { daemon, connect } = await startTestDaemon(authToken);
  const unauthenticatedSocket = await connect();
  const authenticatedSocket = await connect();
  const unauthenticated = makeNdjsonClient(unauthenticatedSocket);
  const authenticated = makeNdjsonClient(authenticatedSocket);

  try {
    unauthenticated.send({
      type: 'agent.request',
      request: {
        id: 'req_unauth',
        method: 'page.get_state',
        tab_id: null,
        params: {},
        meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
      },
    });
    const denied = expectBridgeResponse(await unauthenticated.next());
    assert.equal(denied.response.id, 'req_unauth');
    assert.equal(denied.response.error?.code, ERROR_CODES.ACCESS_DENIED);

    authenticated.send({
      type: 'register',
      role: 'agent',
      clientId: 'agent_auth',
      authToken,
    });
    assert.equal(expectPayload(await authenticated.next()).type, 'registered');
    authenticated.send({
      type: 'agent.request',
      request: {
        id: 'req_auth_health',
        method: 'health.ping',
        tab_id: null,
        params: {},
        meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
      },
    });
    const health = expectBridgeResponse(await authenticated.next());
    assert.equal(health.response.ok, true);
    assert.equal(health.response.result?.daemon, 'ok');
  } finally {
    unauthenticatedSocket.destroy();
    authenticatedSocket.destroy();
    await daemon.stop();
  }
});

test('daemon rejects duplicate in-flight request ids', async () => {
  const { daemon, connect } = await startTestDaemon();
  const agentSocket = await connect();
  const extensionSocket = await connect();
  const agent = makeNdjsonClient(agentSocket);
  const extension = makeNdjsonClient(extensionSocket);

  try {
    agent.send({ type: 'register', role: 'agent', clientId: 'agent_duplicate' });
    extension.send({ type: 'register', role: 'extension' });
    await agent.next();
    await extension.next();

    const request = {
      id: 'req_duplicate',
      method: 'page.get_state',
      tab_id: null,
      params: {},
      meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
    };
    agent.send({ type: 'agent.request', request });
    assert.equal(expectPayload(await extension.next()).request?.id, 'req_duplicate');

    agent.send({ type: 'agent.request', request });
    const duplicate = expectBridgeResponse(await agent.next());
    assert.equal(duplicate.response.id, 'req_duplicate');
    assert.equal(duplicate.response.error?.code, ERROR_CODES.INVALID_REQUEST);
    assert.match(duplicate.response.error?.message || '', /already in flight/);
  } finally {
    agentSocket.destroy();
    extensionSocket.destroy();
    await daemon.stop();
  }
});

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
    assert.equal(expectPayload(await a1.next()).type, 'registered');
    assert.equal(expectPayload(await a2.next()).type, 'registered');
    assert.equal(expectPayload(await ext.next()).type, 'registered');

    // Both agents send requests concurrently.
    a1.send({
      type: 'agent.request',
      request: {
        id: 'req_a1',
        method: 'page.get_state',
        tab_id: null,
        params: {},
        meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
      },
    });
    a2.send({
      type: 'agent.request',
      request: {
        id: 'req_a2',
        method: 'page.get_state',
        tab_id: null,
        params: {},
        meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
      },
    });

    // Extension receives both forwarded requests (order not guaranteed).
    const fwd1 = expectPayload(await ext.next());
    const fwd2 = expectPayload(await ext.next());
    assert.equal(fwd1.type, 'extension.request');
    assert.equal(fwd2.type, 'extension.request');
    assert.ok(fwd1.request?.id);
    assert.ok(fwd2.request?.id);
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
        meta: { protocol_version: PROTOCOL_VERSION, method: 'page.get_state' },
      },
    });
    ext.send({
      type: 'extension.response',
      response: {
        id: 'req_a1',
        ok: true,
        result: { url: 'https://b.test' },
        error: null,
        meta: { protocol_version: PROTOCOL_VERSION, method: 'page.get_state' },
      },
    });

    // Each agent gets its own response.
    const resp1 = expectBridgeResponse(await a1.next());
    const resp2 = expectBridgeResponse(await a2.next());
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
        meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
      },
    });
    a2.send({
      type: 'agent.request',
      request: {
        id: 'req_c2',
        method: 'page.get_state',
        tab_id: null,
        params: {},
        meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
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
        meta: { protocol_version: PROTOCOL_VERSION, method: 'page.get_state' },
      },
    });
    ext.send({
      type: 'extension.response',
      response: {
        id: 'req_c2',
        ok: true,
        result: { url: 'https://c.test' },
        error: null,
        meta: { protocol_version: PROTOCOL_VERSION, method: 'page.get_state' },
      },
    });

    const resp2 = expectBridgeResponse(await a2.next());
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
        meta: { protocol_version: PROTOCOL_VERSION, token_budget: null, source: 'mcp' },
      },
    });

    const forwarded = expectPayload(await ext.next());
    assert.equal(forwarded.type, 'extension.request');
    assert.ok(forwarded.request);
    assert.equal(forwarded.request.id, 'req_disconnect');

    se.destroy();

    const resp = expectBridgeResponse(await agent.next());
    assert.equal(resp.type, 'agent.response');
    assert.equal(resp.response.id, 'req_disconnect');
    assert.equal(resp.response.ok, false);
    assert.ok(resp.response.error);
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

test('daemon routes to only the most recently active enabled extension and returns its error', async () => {
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

    ext1.send({ type: 'extension.access_update', accessEnabled: true });
    ext2.send({ type: 'extension.access_update', accessEnabled: true });
    ext1.send({ type: 'extension.activity', at: 20 });
    ext2.send({ type: 'extension.activity', at: 10 });
    await waitForCondition(() => {
      const sockets = [...daemon.extensionSockets.values()];
      return (
        sockets.every((socket) => socket.__accessEnabled === true) &&
        sockets.some((socket) => socket.__lastActiveAt === 20) &&
        sockets.some((socket) => socket.__lastActiveAt === 10)
      );
    });

    agent.send({
      type: 'agent.request',
      request: {
        id: 'req_mixed_disconnect',
        method: 'page.get_state',
        tab_id: null,
        params: {},
        meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
      },
    });

    await ext1.next();
    await expectNoMessage(ext2);

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
        meta: { protocol_version: PROTOCOL_VERSION, method: 'page.get_state' },
      },
    });

    const resp = expectBridgeResponse(await agent.next());
    assert.equal(resp.type, 'agent.response');
    assert.equal(resp.response.id, 'req_mixed_disconnect');
    assert.equal(resp.response.ok, false);
    assert.ok(resp.response.error);
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
    assert.equal(expectPayload(await ext1.next()).type, 'registered');
    assert.equal(expectPayload(await ext2.next()).type, 'registered');
    assert.equal(expectPayload(await agent.next()).type, 'registered');
    assert.equal(daemon.extensionSockets.size, 2);

    ext1.send({ type: 'extension.access_update', accessEnabled: false });
    ext2.send({ type: 'extension.access_update', accessEnabled: true });
    await waitForCondition(() => {
      const sockets = [...daemon.extensionSockets.values()];
      return (
        sockets.some((socket) => socket.__accessEnabled === false) &&
        sockets.some((socket) => socket.__accessEnabled === true)
      );
    });

    agent.send({
      type: 'agent.request',
      request: {
        id: 'req_multi',
        method: 'page.get_state',
        tab_id: null,
        params: {},
        meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
      },
    });

    await expectNoMessage(ext1);
    const forwarded = expectPayload(await ext2.next());
    assert.equal(forwarded.type, 'extension.request');
    assert.ok(forwarded.request);
    assert.equal(forwarded.request.id, 'req_multi');

    ext2.send({
      type: 'extension.response',
      response: {
        id: 'req_multi',
        ok: true,
        result: { url: 'https://example.com' },
        error: null,
        meta: { protocol_version: PROTOCOL_VERSION, method: 'page.get_state' },
      },
    });

    // Agent should receive the success response, not the error.
    const resp = expectBridgeResponse(await agent.next());
    assert.equal(resp.type, 'agent.response');
    assert.equal(resp.response.ok, true);
    assert.ok(resp.response.result);
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
    await waitForCondition(() => {
      const sockets = [...daemon.extensionSockets.values()];
      return (
        sockets.some((socket) => socket.__lastActiveAt === 10) &&
        sockets.some((socket) => socket.__lastActiveAt === 20)
      );
    });

    agent.send({
      type: 'agent.request',
      request: {
        id: 'req_deny',
        method: 'page.get_state',
        tab_id: null,
        params: {},
        meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
      },
    });

    await expectNoMessage(ext1);
    const forwarded = expectPayload(await ext2.next());
    assert.equal(forwarded.type, 'extension.request');
    assert.ok(forwarded.request);
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
        meta: { protocol_version: PROTOCOL_VERSION, method: 'page.get_state' },
      },
    });

    const resp = expectBridgeResponse(await agent.next());
    assert.equal(resp.type, 'agent.response');
    assert.equal(resp.response.ok, false);
    assert.ok(resp.response.error);
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
  const client = makeNdjsonClient(socket);
  try {
    client.send({ type: 'register', role: 'agent' });
    assert.equal(expectPayload(await client.next()).type, 'registered');
    client.send({});
    const response = await client.next();
    const payload = expectPayload(response);
    assert.equal(payload.type, 'error');
    assert.equal(payload.error?.code, 'INVALID_REQUEST');
  } finally {
    socket.destroy();
    await daemon.stop();
  }
});
