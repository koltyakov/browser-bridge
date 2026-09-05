import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  BridgeDaemon,
  MAX_DAEMON_ACTIVE_HANDLERS_PER_CLIENT,
  hasLiveListener,
} from '../src/daemon.js';
import type { ClientSocket } from '../src/daemon.js';
import { ArtifactStore } from '../src/artifact-store.js';
import { ensureBridgeAuthToken } from '../src/auth-token.js';
import {
  createNativeMessageWriter,
  writeJsonLine,
  MAX_OUTPUT_QUEUE_MESSAGES,
  OUTPUT_DRAIN_TIMEOUT_MS,
} from '../src/framing.js';
import {
  createRequest,
  createSuccess,
  MAX_NATIVE_MESSAGE_BYTES,
} from '../../protocol/src/index.js';
import { startTestDaemon } from '../../../tests/_helpers/daemonHarness.ts';

const logger = { log() {}, error() {} };

function fakeSocket(stalled = false) {
  const writes: Array<string | Uint8Array> = [];
  const emitter = new EventEmitter();
  const socket = Object.assign(emitter, {
    destroyed: false,
    write(value: string | Uint8Array) {
      writes.push(value);
      return !stalled;
    },
    destroy() {
      this.destroyed = true;
      emitter.emit('close');
      return this;
    },
  }) as unknown as ClientSocket;
  return { socket, writes };
}

test('JSON output closes on message quota without accumulating drain listeners', async () => {
  const { socket, writes } = fakeSocket(true);
  const requests = Array.from({ length: MAX_OUTPUT_QUEUE_MESSAGES + 1 }, () =>
    writeJsonLine(socket, { ok: true })
  );
  const outcomes = await Promise.allSettled(requests);
  assert.equal(
    outcomes.every((result) => result.status === 'rejected'),
    true
  );
  assert.equal(writes.length, 1);
  assert.equal(socket.destroyed, true);
  assert.equal(socket.listenerCount('drain'), 0);
  assert.equal(socket.listenerCount('error'), 0);
});

test('native output enforces byte quota on queued frames', async () => {
  const { socket, writes } = fakeSocket(true);
  const writer = createNativeMessageWriter(socket);
  const outcomes = await Promise.allSettled(
    Array.from({ length: 5 }, () => writer({ data: 'x'.repeat(MAX_NATIVE_MESSAGE_BYTES - 30) }))
  );
  assert.equal(
    outcomes.every((result) => result.status === 'rejected'),
    true
  );
  assert.equal(writes.length, 1);
  assert.equal(socket.destroyed, true);
});

test('close rejects active and queued output and removes listeners', async () => {
  const { socket } = fakeSocket(true);
  const results = Promise.allSettled([writeJsonLine(socket, 1), writeJsonLine(socket, 2)]);
  socket.destroy();
  assert.equal(
    (await results).every((result) => result.status === 'rejected'),
    true
  );
  assert.equal(socket.listenerCount('drain'), 0);
  assert.equal(socket.listenerCount('close'), 0);
});

test('drain timeout bounds a stalled consumer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { socket } = fakeSocket(true);
  const rejected = assert.rejects(writeJsonLine(socket, 1), /drain timed out/);
  t.mock.timers.tick(OUTPUT_DRAIN_TIMEOUT_MS);
  await rejected;
  assert.equal(socket.destroyed, true);
});

test('successful backpressured response cannot time out or complete twice', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const daemon = new BridgeDaemon({ logger });
  daemon.pendingTimeoutMs = 10;
  const agent = fakeSocket(true);
  const extension = fakeSocket();
  extension.socket.__extensionId = 'extension';
  daemon.extensionSockets.set('extension', extension.socket);
  await daemon.handleAgentRequest(agent.socket, {
    request: createRequest({ id: 'response', method: 'page.get_state' }),
  });
  const delivery = daemon.handleExtensionResponse(extension.socket, {
    response: createSuccess('response', {}),
  });
  t.mock.timers.tick(20);
  assert.equal(agent.writes.length, 1);
  agent.socket.emit('drain');
  await delivery;
  assert.equal(daemon.requestsProcessed, 1);
  assert.equal(daemon.requestsFailed, 0);
  assert.equal(daemon.pendingRequests.size, 0);
});

test('disconnect during response delivery completes once', async () => {
  const daemon = new BridgeDaemon({ logger });
  const agent = fakeSocket(true);
  const extension = fakeSocket();
  extension.socket.__extensionId = 'extension';
  daemon.extensionSockets.set('extension', extension.socket);
  await daemon.handleAgentRequest(agent.socket, {
    request: createRequest({ id: 'response', method: 'page.get_state' }),
  });
  const rejected = assert.rejects(
    daemon.handleExtensionResponse(extension.socket, { response: createSuccess('response', {}) }),
    /closed/
  );
  daemon.handleSocketClose(agent.socket);
  agent.socket.destroy();
  await rejected;
  assert.equal(daemon.requestsProcessed, 1);
});

test('shutdown destroys duplicate-ID and unregistered connections', async () => {
  const ctx = await startTestDaemon();
  try {
    const sockets = await Promise.all([ctx.connect(), ctx.connect(), ctx.connect()]);
    for (const socket of sockets.slice(0, 2))
      socket.write('{"type":"register","role":"agent","clientId":"same"}\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const closed = sockets.map((socket) => {
      socket.resume();
      return once(socket, 'close');
    });
    await ctx.stop();
    await Promise.all(closed);
    assert.equal(ctx.daemon.clientSockets.size, 0);
  } finally {
    await ctx.stop();
  }
});

test('daemon limits concurrent local handlers even when setup never responds', async () => {
  const ctx = await startTestDaemon();
  let calls = 0;
  let release: (() => void) | undefined;
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  ctx.daemon.setupStatusLoader = async () => {
    calls += 1;
    await stalled;
    throw new Error('Stopped test loader.');
  };
  try {
    const socket = await ctx.connect();
    const closed = once(socket, 'close');
    socket.resume();
    socket.write(
      '{"type":"register","role":"agent"}\n' +
        Array.from(
          { length: MAX_DAEMON_ACTIVE_HANDLERS_PER_CLIENT + 1 },
          (_, id) =>
            JSON.stringify({
              type: 'agent.request',
              request: createRequest({ id: String(id), method: 'setup.get_status' }),
            }) + '\n'
        ).join('')
    );
    await closed;
    assert.equal(calls, MAX_DAEMON_ACTIVE_HANDLERS_PER_CLIENT);
  } finally {
    release?.();
    await ctx.stop();
  }
});

test('listener probe does not depend on extension health', async () => {
  const ctx = await startTestDaemon();
  try {
    const socket = await ctx.connect();
    socket.write('{"type":"register","role":"extension"}\n');
    assert.equal(
      await hasLiveListener({
        type: 'tcp',
        host: '127.0.0.1',
        port: ctx.address.port,
        label: 'test',
      }),
      true
    );
    socket.destroy();
  } finally {
    await ctx.stop();
  }
});

test(
  'a concurrent startup loser cannot remove the winning Unix listener',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bbx-start-race-'));
    const socketPath = path.join(root, 'bridge.sock');
    const daemons = Array.from(
      { length: 2 },
      () =>
        new BridgeDaemon({
          socketPath,
          logger,
          artifactStore: new ArtifactStore(path.join(root, 'artifacts')),
        })
    );
    t.after(async () => {
      await Promise.allSettled(daemons.map((daemon) => daemon.stop()));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const results = await Promise.allSettled(daemons.map((daemon) => daemon.start()));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const loser = daemons[results.findIndex((result) => result.status === 'rejected')];
    await loser.stop().catch(() => {});
    assert.equal(await hasLiveListener({ type: 'socket', socketPath, label: socketPath }), true);
  }
);

test('concurrent token initialization returns the one persisted credential', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bbx-auth-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tokenPath = path.join(root, 'token');
  const tokens = await Promise.all(
    Array.from({ length: 16 }, () => ensureBridgeAuthToken({ tokenPath }))
  );
  assert.equal(new Set(tokens).size, 1);
  assert.equal(fs.readFileSync(tokenPath, 'utf8').trim(), tokens[0]);
});

test('token initializer rechecks the concurrent winner under the publication lock', async () => {
  let reads = 0;
  const token = 'x'.repeat(43);
  const result = await ensureBridgeAuthToken({
    readFile: (async () => (++reads < 2 ? '' : token)) as unknown as typeof fs.promises.readFile,
    writeFile: async () => {},
    link: async () => {},
    unlink: async () => {},
    chmod: async () => {},
    mkdir: async () => undefined,
  });
  assert.equal(result, token);
  assert.equal(reads, 2);
});

test('cross-request artifact chunks and commits cannot mutate a foreign transfer', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bbx-artifact-owner-'));
  const store = new ArtifactStore(path.join(root, 'store'));
  store.reset();
  t.after(() => {
    store.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const daemon = new BridgeDaemon({ logger, artifactStore: store });
  const extension = fakeSocket().socket;
  extension.__extensionId = 'extension';
  const agent = fakeSocket().socket;
  agent.__clientId = 'agent';
  daemon.extensionSockets.set('extension', extension);
  await daemon.handleAgentRequest(agent, {
    request: createRequest({ id: 'A', method: 'page.get_state' }),
  });
  t.after(() => daemon.stop());
  const artifactId = `art_${'a'.repeat(32)}`;
  store.begin({
    artifactId,
    requestId: 'B',
    ownerId: 'agent',
    extensionId: 'extension',
    kind: 'screenshot',
    mimeType: 'image/png',
    totalBytes: 1,
    chunkCount: 1,
    sha256: createHash('sha256').update('x').digest('hex'),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  for (const type of ['extension.artifact.chunk', 'extension.artifact.commit']) {
    daemon.handleExtensionArtifact(extension, {
      type,
      artifact: { requestId: 'A' },
      artifactId,
      chunkIndex: 0,
      data: 'eA==',
    });
    assert.equal(store.transfers.get(artifactId)?.written, 0);
    assert.equal(daemon.pendingRequests.get('A')?.lastErrorResponse?.ok, false);
  }
});
