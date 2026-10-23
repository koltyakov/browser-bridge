import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  NativeWireClient,
  createNativeMessageReader,
  createNativeMessageWriter,
  writeJsonLine,
} from '../_helpers/nativeWire.js';
import {
  ARTIFACT_CHUNK_BYTES,
  createSuccess,
  getProtocolVersion,
  parseJsonLines,
  setProtocolPackageVersion,
} from '../../protocol/src/index.js';
import type { ArtifactDescriptor, BridgeRequest, BridgeResponse } from '../../protocol/types.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as {
  version: string;
};
setProtocolPackageVersion(pkg.version);
const goAvailable = await exec('go', ['version']).then(
  () => true,
  () => false
);
const enabled = goAvailable || Boolean(process.env.BBX_NATIVE_EXECUTABLE);
let buildDirectory: string | undefined;
let executable = process.env.BBX_NATIVE_EXECUTABLE ?? '';
let buildPromise: Promise<void> | undefined;

async function buildExecutable() {
  if (process.env.BBX_NATIVE_EXECUTABLE) return;
  buildDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-services-build-'));
  executable = path.join(buildDirectory, process.platform === 'win32' ? 'bbx.exe' : 'bbx');
  // Never build into dist: other native suites may be compiling there concurrently.
  await exec(
    'go',
    [
      'build',
      '-buildvcs=false',
      '-ldflags',
      `-X github.com/koltyakov/browser-bridge/internal/bridge.version=${pkg.version}`,
      '-o',
      executable,
      './cmd/bbx',
    ],
    { cwd: root, timeout: 120_000 }
  );
}
after(async () => {
  if (buildDirectory) await fs.rm(buildDirectory, { recursive: true, force: true, maxRetries: 5 });
});

type Message = Record<string, unknown>;
function record(value: unknown): Message {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Message;
}

class Inbox {
  messages: Message[] = [];
  private failure: Error | undefined;
  private waiters: {
    predicate: (message: Message) => boolean;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }[] = [];
  push(value: unknown) {
    const message = record(value);
    const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
    if (index < 0) {
      this.messages.push(message);
      return;
    }
    const [waiter] = this.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }
  fail(error: Error) {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
  async next(predicate: (message: Message) => boolean = () => true): Promise<Message> {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return this.messages.splice(index, 1)[0];
    if (this.failure) throw this.failure;
    return new Promise((resolve, reject) => {
      const entry = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(entry), 1);
          reject(new Error('Timed out waiting for daemon/native-host message.'));
        }, 5000),
      };
      this.waiters.push(entry);
    });
  }
}

async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function stopChild(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals = 'SIGTERM'
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(t: TestContext) {
  await (buildPromise ??= buildExecutable());
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-services-go-'));
  const userHome = path.join(home, 'user');
  await fs.mkdir(userHome);
  const agentToken = randomBytes(32).toString('base64url');
  const extensionToken = randomBytes(32).toString('base64url');
  await fs.writeFile(path.join(home, 'daemon.auth'), `${agentToken}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(home, 'daemon.extension.auth'), `${extensionToken}\n`, {
    mode: 0o600,
  });
  const env: NodeJS.ProcessEnv = { ...process.env };
  const agentOverrides = new Set([
    'CODEX_HOME',
    'GEMINI_CLI_HOME',
    'CLINE_DIR',
    'CLINE_DATA_DIR',
    'CLINE_MCP_SETTINGS_PATH',
    'AMP_HOME',
    'FLATPAK_XDG_CONFIG_HOME',
    'PI_CODING_AGENT_DIR',
    'QWEN_HOME',
    'GOOSE_PATH_ROOT',
    'GOOSE_BIN_DIR',
    'OPENHANDS_PERSISTENCE_DIR',
    'MUSE_INSTALL_DIR',
    'GROK_HOME',
    'GROK_BIN_DIR',
  ]);
  for (const key of Object.keys(env))
    if (key.startsWith('BBX_') || agentOverrides.has(key)) delete env[key];
  Object.assign(env, {
    BROWSER_BRIDGE_HOME: home,
    BBX_AUTH_TOKEN: agentToken,
    BBX_AUTH_TOKEN_FILE: path.join(home, 'daemon.auth'),
    BBX_AUTO_UPDATE: 'off',
    HOME: userHome,
    USERPROFILE: userHome,
    APPDATA: path.join(userHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(userHome, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(userHome, '.config'),
    XDG_DATA_HOME: path.join(userHome, '.local', 'share'),
  });
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve()))
  );
  env.BBX_TCP_PORT = String(port);
  const children: ChildProcessWithoutNullStreams[] = [];
  const clients: NativeWireClient[] = [];
  const sockets: net.Socket[] = [];
  let daemon: ChildProcessWithoutNullStreams;
  let stderr = '';
  const client = async (clientId = `services_${randomUUID()}`) => {
    const cl = await NativeWireClient.connect(port, agentToken, clientId);
    clients.push(cl);
    return cl;
  };
  const start = async () => {
    daemon = spawn(executable, ['--bridge-daemon'], { env, cwd: userHome, stdio: 'pipe' });
    children.push(daemon);
    daemon.stdout.resume();
    daemon.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16000);
    });
    await waitFor(async () => {
      if (daemon.exitCode !== null || daemon.signalCode !== null)
        throw new Error(`Daemon exited: ${stderr}`);
      try {
        const probe = await client();
        await probe.close();
        return true;
      } catch {
        return false;
      }
    }, 'Go daemon startup');
  };
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const cl of clients) await cl.close().catch(() => {});
    for (const child of [...children].reverse()) await stopChild(child);
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5 });
    assert.doesNotMatch(stderr, /panic:|fatal error:/u);
  });
  await start();
  const native = async (profile: string) => {
    const child = spawn(executable, ['--native-host'], { env, cwd: userHome, stdio: 'pipe' });
    children.push(child);
    const inbox = new Inbox();
    let diagnostics = '';
    child.stderr.on('data', (chunk: Buffer) => {
      diagnostics += chunk.toString();
    });
    child.once('close', () => inbox.fail(new Error(`Native host closed: ${diagnostics}`)));
    createNativeMessageReader(
      child.stdout,
      (message) => inbox.push(message),
      (error) => inbox.fail(error)
    );
    const send = createNativeMessageWriter(child.stdin);
    const barrier = async () => {
      const requestId = randomUUID();
      await send({ type: 'host.setup_status.request', requestId });
      const message = await inbox.next((m) => m.requestId === requestId);
      assert.equal(message.type, 'host.setup_status.response');
      return record(message.status);
    };
    await send({
      type: 'host.identity',
      browserName: 'chrome',
      profileLabel: profile,
      browserExtensionId: 'a'.repeat(32),
    });
    await send({ type: 'host.access_update', accessEnabled: true });
    await barrier();
    return {
      send,
      inbox,
      barrier,
      child,
      request: async (method: string) =>
        (await inbox.next((m) => m.method === method)) as unknown as BridgeRequest,
      reply: (request: BridgeRequest, result: unknown, meta: Message = {}) =>
        send(createSuccess(request.id, result, { method: request.method, ...meta })),
      close: () => stopChild(child),
    };
  };
  const rawPeer = async (role: 'agent' | 'extension') => {
    const socket = net.connect(port, '127.0.0.1');
    sockets.push(socket);
    const inbox = new Inbox();
    socket.setEncoding('utf8');
    socket.on('error', (error) => inbox.fail(error));
    socket.on('close', () => inbox.fail(new Error('Agent socket closed')));
    parseJsonLines(socket, (message) => inbox.push(message));
    await once(socket, 'connect');
    await writeJsonLine(socket, {
      type: 'register',
      role,
      authToken: role === 'agent' ? agentToken : extensionToken,
      clientId: randomUUID(),
    });
    assert.equal((await inbox.next()).type, 'registered');
    return {
      socket,
      sendMessage: (message: Message) => writeJsonLine(socket, message),
      send: (request: Message) => writeJsonLine(socket, { type: 'agent.request', request }),
      response: async () => record((await inbox.next()).response),
    };
  };
  return {
    home,
    userHome,
    client,
    native,
    rawAgent: () => rawPeer('agent'),
    rawExtension: () => rawPeer('extension'),
    restart: async () => {
      await stopChild(daemon, 'SIGKILL');
      await start();
    },
  };
}

type NativePeer = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['native']>>;
function descriptor(
  bytes: Buffer,
  overrides: Partial<ArtifactDescriptor> = {}
): ArtifactDescriptor {
  return {
    artifactId: `art_${randomBytes(32).toString('base64url')}`,
    kind: 'screenshot',
    mimeType: 'image/png',
    byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    chunkSize: ARTIFACT_CHUNK_BYTES,
    chunkCount: Math.ceil(bytes.length / ARTIFACT_CHUNK_BYTES),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    ...overrides,
  };
}
async function beginArtifact(
  host: NativePeer,
  request: BridgeRequest,
  artifact: ArtifactDescriptor
) {
  await host.send({
    type: 'host.artifact.begin',
    artifact: { ...artifact, requestId: request.id },
  });
}
async function transfer(
  host: NativePeer,
  request: BridgeRequest,
  artifact: ArtifactDescriptor,
  bytes: Buffer
) {
  await beginArtifact(host, request, artifact);
  for (
    let offset = 0, chunkIndex = 0;
    offset < bytes.length;
    offset += ARTIFACT_CHUNK_BYTES, chunkIndex++
  ) {
    await host.send({
      type: 'host.artifact.chunk',
      artifact: { requestId: request.id },
      artifactId: artifact.artifactId,
      chunkIndex,
      data: bytes.subarray(offset, offset + ARTIFACT_CHUNK_BYTES).toString('base64'),
    });
  }
  await host.send({
    type: 'host.artifact.commit',
    artifact: { requestId: request.id },
    artifactId: artifact.artifactId,
  });
}
function screenshot(client: NativeWireClient, profile = 'primary') {
  return client.request({
    method: 'screenshot.capture_region',
    params: { x: 0, y: 0, width: 8, height: 8, format: 'png', delivery: 'artifact' },
    meta: { target_profile: profile },
  });
}
function assertError(response: BridgeResponse, code: string, method?: string) {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal(response.error?.code, code);
  if (method) assert.equal(response.meta.method, method);
}
async function artifactsOnDisk(home: string) {
  return fs.readdir(path.join(home, 'artifacts'));
}

const options = { skip: !enabled, timeout: 60000 };

test(
  'Go daemon services: a held setup lock cannot block native-host health routing',
  options,
  async (t) => {
    const f = await fixture(t);
    const host = await f.native('setup-lock');
    const lockPath = path.join(f.userHome, '.claude.json.bbx.lock');
    await fs.writeFile(lockPath, 'fixture');
    const setupId = randomUUID();
    const healthId = randomUUID();
    await host.send({
      type: 'host.bridge_request',
      request: { id: setupId, method: 'setup.install', params: { kind: 'mcp', target: 'claude' } },
    });
    await host.send({
      type: 'host.bridge_request',
      request: { id: healthId, method: 'health.ping', params: {} },
    });
    const routed = await host.request('health.ping');
    await host.reply(routed, { extension: 'ok' });
    const health = record(
      (
        await host.inbox.next(
          (message) =>
            message.type === 'host.bridge_response' && record(message.response).id === healthId
        )
      ).response
    );
    assert.equal(health.ok, true);
    // Release only after health has passed through the same native-host stream.
    // A synchronous setup handler would have already timed out on this lock.
    await fs.unlink(lockPath);
    const setup = record(
      (
        await host.inbox.next(
          (message) =>
            message.type === 'host.bridge_response' && record(message.response).id === setupId
        )
      ).response
    );
    assert.equal(setup.ok, true, JSON.stringify(setup));
    const config = JSON.parse(
      await fs.readFile(path.join(f.userHome, '.claude.json'), 'utf8')
    ) as Message;
    assert.ok(record(config.mcpServers)['browser-bridge']);
  }
);

test(
  'Go daemon services: malformed URL credentials never survive the log transport',
  options,
  async (t) => {
    const f = await fixture(t);
    const extension = await f.rawExtension();
    const url = 'https://demo:fixture-secret@example.test/%ZZ?token=private-query#private-fragment';
    await extension.sendMessage({ type: 'log', entry: { message: `failed ${url}`, url } });
    // A reply on this stream proves the preceding log was processed.
    await extension.send({ id: randomUUID(), method: 'setup.get_status', params: {} });
    assert.equal((await extension.response()).ok, true);
    const client = await f.client();
    const logs = await client.request({ method: 'log.tail' });
    assert.equal(logs.ok, true);
    const entries = record(logs.result).entries;
    assert.ok(Array.isArray(entries) && entries.length > 0);
    const output = JSON.stringify(entries);
    assert.match(output, /example\.test/u);
    assert.doesNotMatch(output, /demo:|fixture-secret|private-query|private-fragment/u);
  }
);
test(
  'Go daemon services: wire client and native relay transfer artifacts with connection ownership',
  options,
  async (t) => {
    const f = await fixture(t);
    const host = await f.native('primary');
    const owner = await f.client('shared-client-id');
    const stranger = await f.client('shared-client-id');
    const bytes = randomBytes(ARTIFACT_CHUNK_BYTES + 4097);
    const artifact = descriptor(bytes);
    const responsePromise = screenshot(owner);
    const request = await host.request('screenshot.capture_region');
    await transfer(host, request, artifact, bytes);
    const cost = {
      response_bytes: 1234,
      approx_tokens: 309,
      cost_class: 'medium',
      transport_approx_tokens: 400,
      text_approx_tokens: 100,
      image_approx_tokens: 200,
      custom: { retained: true },
    };
    await host.reply(request, { delivery: 'artifact', artifact }, cost);
    const response = await responsePromise;
    assert.equal(response.ok, true);
    assert.deepEqual(record(response.result).artifact, artifact);
    for (const [key, expected] of Object.entries(cost))
      assert.deepEqual(
        response.meta[key],
        expected,
        `ordinary response metadata ${key} must survive forwarding`
      );
    for (const method of ['artifact.read', 'artifact.delete'] as const)
      assertError(
        await stranger.request({ method, params: { artifactId: artifact.artifactId } }),
        'ARTIFACT_NOT_FOUND',
        method
      );
    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const read = await owner.request({
        method: 'artifact.read',
        params: { artifactId: artifact.artifactId, offset, maxBytes: 50000 },
      });
      assert.equal(read.ok, true);
      const result = record(read.result);
      const chunk = Buffer.from(String(result.data), 'base64');
      assert.equal(chunk.length, result.byteLength);
      assert.ok(chunk.length <= 50000);
      assert.equal(result.offset, offset);
      assert.equal(result.sha256, artifact.sha256);
      assert.equal(result.totalBytes, bytes.length);
      parts.push(chunk);
      if (result.nextOffset === null) break;
      assert.equal(typeof result.nextOffset, 'number');
      offset = Number(result.nextOffset);
    }
    assert.deepEqual(Buffer.concat(parts), bytes);
    const deleted = await owner.request({
      method: 'artifact.delete',
      params: { artifactId: artifact.artifactId },
    });
    assert.deepEqual(deleted.result, { artifactId: artifact.artifactId, deleted: true });
    assert.deepEqual(await artifactsOnDisk(f.home), []);
    assertError(
      await owner.request({
        method: 'artifact.read',
        params: { artifactId: artifact.artifactId },
      }),
      'ARTIFACT_NOT_FOUND'
    );
    const ephemeral = descriptor(bytes);
    const next = screenshot(owner);
    const nextRequest = await host.request('screenshot.capture_region');
    await transfer(host, nextRequest, ephemeral, bytes);
    await host.reply(nextRequest, { delivery: 'artifact', artifact: ephemeral });
    assert.equal((await next).ok, true);
    await owner.close();
    await waitFor(
      async () => (await artifactsOnDisk(f.home)).length === 0,
      'owner-disconnect artifact cleanup'
    );
    const replacement = await f.client('shared-client-id');
    assertError(
      await replacement.request({
        method: 'artifact.read',
        params: { artifactId: ephemeral.artifactId },
      }),
      'ARTIFACT_NOT_FOUND'
    );
  }
);

test(
  'Go daemon services: malformed artifact transfers, forged descriptors, quotas, and expiry fail closed',
  options,
  async (t) => {
    const f = await fixture(t);
    const host = await f.native('primary');
    const foreign = await f.native('foreign');
    const owner = await f.client();
    const bytes = Buffer.from('artifact digest evidence');
    for (const mode of [
      'uncommitted',
      'descriptor',
      'checksum',
      'order',
      'foreign',
      'kind',
      'quota',
      'count-quota',
    ] as const) {
      const artifact = descriptor(bytes);
      const pending = screenshot(owner);
      const request = await host.request('screenshot.capture_region');
      if (mode === 'descriptor') {
        await transfer(host, request, artifact, bytes);
        artifact.sha256 = '0'.repeat(64);
      }
      if (mode === 'checksum')
        await transfer(host, request, artifact, Buffer.alloc(bytes.length, 0));
      if (mode === 'order') {
        await beginArtifact(host, request, artifact);
        await host.send({
          type: 'host.artifact.chunk',
          artifact: { requestId: request.id },
          artifactId: artifact.artifactId,
          chunkIndex: 1,
          data: bytes.toString('base64'),
        });
      }
      if (mode === 'foreign') {
        await transfer(foreign, request, artifact, bytes);
        await foreign.barrier();
      }
      if (mode === 'kind') await beginArtifact(host, request, { ...artifact, kind: 'resource' });
      if (mode === 'quota')
        for (let index = 0; index < 3; index++)
          await beginArtifact(
            host,
            request,
            descriptor(bytes, {
              byteLength: 33554432,
              chunkCount: Math.ceil(33554432 / ARTIFACT_CHUNK_BYTES),
            })
          );
      if (mode === 'count-quota')
        for (let index = 0; index < 17; index++)
          await beginArtifact(host, request, descriptor(bytes));
      await host.reply(request, { delivery: 'artifact', artifact });
      assertError(
        await pending,
        mode === 'quota' || mode === 'count-quota'
          ? 'ARTIFACT_QUOTA_EXCEEDED'
          : 'ARTIFACT_TRANSFER_INVALID',
        'screenshot.capture_region'
      );
      await waitFor(
        async () => (await artifactsOnDisk(f.home)).length === 0,
        `${mode} transfer cleanup`
      );
    }
    const artifact = descriptor(bytes, { expiresAt: new Date(Date.now() + 2000).toISOString() });
    const pending = screenshot(owner);
    const request = await host.request('screenshot.capture_region');
    await transfer(host, request, artifact, bytes);
    await host.reply(request, { delivery: 'artifact', artifact });
    assert.equal((await pending).ok, true);
    await waitFor(
      async () => (await artifactsOnDisk(f.home)).length === 0,
      'artifact TTL disk cleanup'
    );
    assertError(
      await owner.request({
        method: 'artifact.read',
        params: { artifactId: artifact.artifactId },
      }),
      'ARTIFACT_NOT_FOUND'
    );
  }
);

test(
  'Go daemon services: artifact reservations obey global limits and cannot cross request ownership',
  options,
  async (t) => {
    const f = await fixture(t);
    const host = await f.native('primary');
    const holders: { response: Promise<BridgeResponse>; request: BridgeRequest }[] = [];
    for (let owner = 0; owner < 4; owner++) {
      const client = await f.client();
      const response = screenshot(client);
      const request = await host.request('screenshot.capture_region');
      holders.push({ response, request });
      for (let index = 0; index < 2; index++)
        await beginArtifact(
          host,
          request,
          descriptor(Buffer.from('x'), {
            byteLength: 33554432,
            chunkCount: Math.ceil(33554432 / ARTIFACT_CHUNK_BYTES),
          })
        );
    }
    await host.barrier();
    const client = await f.client();
    const rejected = screenshot(client);
    const request = await host.request('screenshot.capture_region');
    const overLimit = descriptor(Buffer.from('x'));
    await beginArtifact(host, request, overLimit);
    await host.reply(request, { delivery: 'artifact', artifact: overLimit });
    assertError(await rejected, 'ARTIFACT_QUOTA_EXCEEDED');
    for (const holder of holders) {
      await host.reply(holder.request, { delivery: 'inline' });
      assert.equal((await holder.response).ok, true);
    }
    await waitFor(
      async () => (await artifactsOnDisk(f.home)).length === 0,
      'completed reservation cleanup'
    );

    const first = screenshot(client);
    const firstRequest = await host.request('screenshot.capture_region');
    const second = screenshot(client);
    const secondRequest = await host.request('screenshot.capture_region');
    const bytes = Buffer.from('original bytes');
    const artifact = descriptor(bytes);
    await beginArtifact(host, firstRequest, artifact);
    await host.send({
      type: 'host.artifact.chunk',
      artifact: { requestId: secondRequest.id },
      artifactId: artifact.artifactId,
      chunkIndex: 0,
      data: bytes.toString('base64'),
    });
    await host.reply(secondRequest, { delivery: 'artifact', artifact });
    assertError(await second, 'ARTIFACT_TRANSFER_INVALID');
    await host.send({
      type: 'host.artifact.chunk',
      artifact: { requestId: firstRequest.id },
      artifactId: artifact.artifactId,
      chunkIndex: 0,
      data: bytes.toString('base64'),
    });
    await host.send({
      type: 'host.artifact.commit',
      artifact: { requestId: firstRequest.id },
      artifactId: artifact.artifactId,
    });
    await host.reply(firstRequest, { delivery: 'artifact', artifact });
    assert.equal((await first).ok, true);
    const read = await client.request({
      method: 'artifact.read',
      params: { artifactId: artifact.artifactId },
    });
    assert.equal(record(read.result).data, bytes.toString('base64'));
  }
);

test(
  'Go daemon services: acknowledged journals survive a killed daemon and revoke old writer authority',
  options,
  async (t) => {
    const f = await fixture(t);
    const host = await f.native('primary');
    const foreign = await f.native('foreign');
    const client = await f.client();
    await host.send({
      type: 'host.journal.begin',
      requestId: 'unsolicited',
      messageId: 'unsolicited',
    });
    assert.match(
      String((await host.inbox.next((m) => m.messageId === 'unsolicited')).error),
      /pending session.start/u
    );
    const starting = client.request({
      method: 'session.start',
      params: { durable: true },
      meta: { target_profile: 'primary' },
    });
    const request = await host.request('session.start');
    await foreign.send({
      type: 'host.journal.begin',
      requestId: request.id,
      messageId: 'foreign',
    });
    assert.ok((await foreign.inbox.next((m) => m.messageId === 'foreign')).error);
    await host.send({ type: 'host.journal.begin', requestId: request.id, messageId: 'begin' });
    const journalId = String(
      record((await host.inbox.next((m) => m.messageId === 'begin')).result).journalId
    );
    assert.match(journalId, /^journal_[a-f0-9]{64}$/u);
    const text = '{"kind":"event","event":{"type":"click","at":1}}\n{"kind":';
    const append = {
      type: 'host.journal.append',
      journalId,
      offset: 0,
      data: Buffer.from(text).toString('base64'),
    };
    await foreign.send({ ...append, messageId: 'foreign-write' });
    assert.match(
      String((await foreign.inbox.next((m) => m.messageId === 'foreign-write')).error),
      /connection/u
    );
    await host.send({ ...append, messageId: 'write' });
    assert.equal(
      record((await host.inbox.next((m) => m.messageId === 'write')).result).nextOffset,
      Buffer.byteLength(text)
    );
    await host.send({ ...append, messageId: 'duplicate' });
    assert.match(
      String((await host.inbox.next((m) => m.messageId === 'duplicate')).error),
      /offset/u
    );
    await host.reply(request, { sessionId: 'recording', journalId });
    assert.equal((await starting).ok, true);
    assert.equal(
      await fs.readFile(path.join(f.home, 'recordings', `${journalId}.jsonl`), 'utf8'),
      text
    );
    await f.restart();
    const recovered = await f.client();
    const reader = await f.client();
    const first = await recovered.request({
      method: 'session.journal_read',
      params: { journalId, maxBytes: 8 },
    });
    const second = await reader.request({
      method: 'session.journal_read',
      params: { journalId, offset: 8 },
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(
      Buffer.concat([
        Buffer.from(String(record(first.result).data), 'base64'),
        Buffer.from(String(record(second.result).data), 'base64'),
      ]).toString(),
      text
    );
    const replacement = await f.native('primary');
    await replacement.send({
      ...append,
      offset: Buffer.byteLength(text),
      messageId: 'old-writer',
    });
    assert.match(
      String((await replacement.inbox.next((m) => m.messageId === 'old-writer')).error),
      /connection/u
    );
    // A persisted JSON-lines fixture is readable without an in-memory writer.
    const importedId = `journal_${randomBytes(32).toString('hex')}`;
    const expiredPath = path.join(f.home, 'recordings', `${importedId}.jsonl`);
    await fs.writeFile(expiredPath, text, { mode: 0o600, flag: 'wx' });
    const imported = await recovered.request({
      method: 'session.journal_read',
      params: { journalId: importedId },
    });
    assert.equal(record(imported.result).data, Buffer.from(text).toString('base64'));
    await fs.utimes(expiredPath, 0, 0);
    assertError(
      await recovered.request({
        method: 'session.journal_read',
        params: { journalId: importedId },
      }),
      'ARTIFACT_NOT_FOUND'
    );
    await assert.rejects(fs.stat(expiredPath), { code: 'ENOENT' });
    const deleted = await recovered.request({
      method: 'session.journal_delete',
      params: { journalId },
    });
    assert.deepEqual(deleted.result, { deleted: true });
    assertError(
      await reader.request({ method: 'session.journal_read', params: { journalId } }),
      'ARTIFACT_NOT_FOUND',
      'session.journal_read'
    );
    if (process.platform !== 'win32') {
      const secret = path.join(f.home, 'private-evidence');
      await fs.writeFile(secret, 'must remain private');
      await fs.symlink(secret, path.join(f.home, 'recordings', `${journalId}.jsonl`));
      assertError(
        await recovered.request({ method: 'session.journal_read', params: { journalId } }),
        'ARTIFACT_NOT_FOUND'
      );
      assert.equal(
        (await recovered.request({ method: 'session.journal_delete', params: { journalId } })).ok,
        true
      );
      assert.equal(await fs.readFile(secret, 'utf8'), 'must remain private');
    }
  }
);

test(
  'Go daemon services: baseline capabilities retain their extension owner across clients',
  options,
  async (t) => {
    const f = await fixture(t);
    const host = await f.native('primary');
    const foreign = await f.native('foreign');
    const creator = await f.client();
    const reader = await f.client();
    const baselineId = `baseline_${randomBytes(32).toString('base64url')}`;
    const result = {
      baselineId,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      scope: { tabId: 42 },
      evicted: [],
    };
    const creating = creator.request({
      method: 'dom.baseline.create',
      params: { selector: 'main' },
      meta: { target_profile: 'primary' },
    });
    const request = await host.request('dom.baseline.create');
    await host.reply(request, result);
    assert.equal((await creating).ok, true);
    await creator.close();
    const compare = reader.request({ method: 'dom.baseline.compare', params: { baselineId } });
    const compared = await host.request('dom.baseline.compare');
    await foreign.reply(compared, { stolen: true });
    await foreign.barrier();
    await host.reply(compared, { baselineId, matches: true });
    assert.deepEqual((await compare).result, { baselineId, matches: true });
    assertError(
      await reader.request({
        method: 'dom.baseline.describe',
        params: { baselineId },
        meta: { target_profile: 'foreign' },
      }),
      'DOM_BASELINE_NOT_FOUND'
    );
    const collision = reader.request({
      method: 'dom.baseline.create',
      params: { selector: 'main' },
      meta: { target_profile: 'foreign' },
    });
    const colliding = await foreign.request('dom.baseline.create');
    await foreign.reply(colliding, { ...result, evicted: [{ baselineId }] });
    assertError(await collision, 'DOM_BASELINE_INVALIDATED');
    assert.equal((await foreign.request('dom.baseline.release')).params.baselineId, baselineId);
    const describe = reader.request({ method: 'dom.baseline.describe', params: { baselineId } });
    const described = await host.request('dom.baseline.describe');
    await host.reply(described, { baselineId });
    assert.equal((await describe).ok, true);
    const release = reader.request({ method: 'dom.baseline.release', params: { baselineId } });
    const released = await host.request('dom.baseline.release');
    await host.reply(released, { baselineId, released: true });
    assert.equal((await release).ok, true);
    assert.deepEqual(
      (await reader.request({ method: 'dom.baseline.release', params: { baselineId } })).result,
      { baselineId, released: false }
    );
    const abandonedClient = await f.client();
    const abandoned = abandonedClient
      .request({
        method: 'dom.baseline.create',
        params: { selector: 'main' },
        meta: { target_profile: 'primary' },
      })
      .catch(() => null);
    const orphan = await host.request('dom.baseline.create');
    await abandonedClient.close();
    await abandoned;
    await waitFor(
      async () =>
        record((await reader.request({ method: 'daemon.metrics' })).result).pendingRequests === 0,
      'abandoned baseline cleanup'
    );
    await host.reply(orphan, result);
    assert.equal((await host.request('dom.baseline.release')).params.baselineId, baselineId);
    const again = reader.request({
      method: 'dom.baseline.create',
      params: { selector: 'main' },
      meta: { target_profile: 'primary' },
    });
    const againRequest = await host.request('dom.baseline.create');
    await host.reply(againRequest, result);
    assert.equal((await again).ok, true);
    await host.send({ type: 'host.access_update', accessEnabled: false });
    await host.barrier();
    assertError(
      await reader.request({ method: 'dom.baseline.compare', params: { baselineId } }),
      'DOM_BASELINE_NOT_FOUND'
    );
    await host.send({ type: 'host.access_update', accessEnabled: true });
    await host.barrier();
    const finalCreate = reader.request({
      method: 'dom.baseline.create',
      params: { selector: 'main' },
      meta: { target_profile: 'primary' },
    });
    const finalRequest = await host.request('dom.baseline.create');
    await host.reply(finalRequest, result);
    assert.equal((await finalCreate).ok, true);
    await host.close();
    await waitFor(
      async () =>
        record((await reader.request({ method: 'daemon.metrics' })).result).domBaselineOwners === 0,
      'extension-disconnect baseline cleanup'
    );
    await f.native('primary');
    assertError(
      await reader.request({
        method: 'dom.baseline.compare',
        params: { baselineId },
        meta: { target_profile: 'primary' },
      }),
      'DOM_BASELINE_NOT_FOUND'
    );
  }
);

test(
  'Go daemon services: setup discovery and health metadata remain daemon-authoritative',
  options,
  async (t) => {
    const f = await fixture(t);
    const configPath = path.join(f.userHome, '.cursor', 'mcp.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const configText = JSON.stringify({
      mcpServers: { 'browser-bridge': { command: 'bbx', args: ['mcp', 'serve'] } },
    });
    await fs.writeFile(configPath, configText);
    const client = await f.client();
    const discovered = await client.request({ method: 'setup.get_status' });
    assert.equal(discovered.ok, true);
    const status = record(discovered.result);
    assert.equal(status.scope, 'global');
    assert.ok(Array.isArray(status.mcpClients));
    const cursor = status.mcpClients.map(record).find((entry) => entry.key === 'cursor');
    assert.equal(cursor?.configPath, configPath);
    assert.equal(cursor?.configured, true);
    assert.deepEqual(
      status.mcpClients.map((entry) => record(entry).key),
      [
        'codex',
        'claude',
        'opencode',
        'copilot',
        'cursor',
        'windsurf',
        'antigravity',
        'gemini',
        'cline',
        'zed',
        'amp',
        'droid',
        'pi',
        'kilo',
        'qwen',
        'goose',
        'openhands',
        'muse',
        'grok',
        'agents',
      ]
    );
    const host = await f.native('primary');
    assert.deepEqual(await host.barrier(), status);
    assertError(
      await client.request({
        method: 'setup.install',
        params: { kind: 'mcp', target: 'cursor' },
      }),
      'ACCESS_DENIED',
      'setup.install'
    );
    assert.equal(await fs.readFile(configPath, 'utf8'), configText);
    await host.send({
      type: 'host.identity',
      browserName: 'x'.repeat(129),
      browserExtensionId: 'invalid-extension-id',
    });
    await host.barrier();
    const pending = client.request({
      method: 'health.ping',
      meta: { target_profile: 'primary' },
    });
    const request = await host.request('health.ping');
    await host.reply(
      request,
      {
        extension: 'ok',
        daemon: 'forged',
        daemonVersion: 'forged',
        socketPath: 'forged',
        connectedExtensions: ['forged'],
        unknown: 'forged',
        extensionVersion: '1.2.3',
        supported_versions: ['1.2', 'bad version'],
        access: { enabled: true, windowId: -5, routeTabId: 42, reason: 'private' },
        debugger: { status: 'active', attachedTabCount: 20000, heldTabCount: -1 },
        recovery: { scope: 'daemon', events: {} },
      },
      { method: 'forged', approx_tokens: 987654, transport_cost_class: 'high', private: 'forged' }
    );
    const health = await pending;
    assert.equal(health.ok, true);
    const { timing, ...healthMeta } = health.meta;
    assert.equal(record(timing).scheduled, false);
    assert.equal(typeof record(timing).totalMs, 'number');
    assert.deepEqual(
      healthMeta,
      { protocol_version: getProtocolVersion(), method: 'health.ping' },
      'health reconstruction must discard extension-owned cost/meta fields'
    );
    const result = record(health.result);
    assert.equal(result.daemonVersion, pkg.version);
    assert.equal(result.unknown, undefined);
    assert.equal(record(result.access).windowId, undefined);
    assert.equal(record(result.debugger).attachedTabCount, 10000);
    assert.deepEqual(result.extension_supported_versions, ['1.2']);
    assert.ok(Array.isArray(result.connectedExtensions));
    assert.equal(record(result.connectedExtensions[0]).browserName, 'chrome');
    assert.equal(record(result.connectedExtensions[0]).browserExtensionId, null);
    assert.equal(record(result.recovery).routedExtension, undefined);
  }
);

test(
  'Go daemon services: window controls require the advertised target and current access generation',
  options,
  async (t) => {
    const f = await fixture(t);
    const source = await f.native('source');
    const target = await f.native('target');
    const foreign = await f.native('foreign');
    await source.send({ type: 'host.identity', windowActions: true, windowAccessUpdates: true });
    await target.send({ type: 'host.identity', windowActions: true, windowAccessUpdates: true });
    await target.send({
      type: 'host.access_update',
      accessEnabled: true,
      enabledWindow: {
        windowId: 42,
        enabledAt: 123.5,
        title: 'https://example.com/?token=private-window-value',
      },
    });
    await target.barrier();
    const windows = await source.inbox.next(
      (m) =>
        m.type === 'host.window_access' &&
        Array.isArray(m.otherEnabledWindows) &&
        m.otherEnabledWindows.some(
          (entry) =>
            record(entry).profileLabel === 'target' &&
            record(entry).canControl === true &&
            record(entry).window !== null &&
            record(record(entry).window).windowId === 42
        )
    );
    assert.ok(Array.isArray(windows.otherEnabledWindows));
    const entry = record(
      windows.otherEnabledWindows.find((item) => record(item).profileLabel === 'target')
    );
    assert.doesNotMatch(String(record(entry.window).title), /private-window-value/u);
    const action = {
      type: 'host.window_action.request',
      requestId: 'window-action',
      extensionId: entry.extensionId,
      action: 'focus',
      windowId: 42,
      enabledAt: 123.5,
    };
    await source.send(action);
    const command = await target.inbox.next((m) => m.type === 'host.window_action.command');
    assert.notEqual(command.requestId, action.requestId);
    await foreign.send({
      type: 'host.window_action.result',
      requestId: command.requestId,
      ok: true,
    });
    await foreign.barrier();
    await target.send({
      type: 'host.window_action.result',
      requestId: command.requestId,
      ok: false,
      error: 'Authorization: Bearer private-action-value',
    });
    const response = await source.inbox.next(
      (m) => m.type === 'host.window_action.response' && m.requestId === action.requestId
    );
    assert.equal(response.ok, false);
    assert.doesNotMatch(String(response.error), /private-action-value/u);
    await source.send({ ...action, requestId: 'stale-window', enabledAt: 122 });
    const stale = await source.inbox.next((m) => m.requestId === 'stale-window');
    assert.equal(stale.ok, false);
    assert.match(String(stale.error), /access changed/u);
  }
);

test(
  'Go daemon services: raw metadata normalization and invalid local capabilities match the protocol boundary',
  options,
  async (t) => {
    const f = await fixture(t);
    const host = await f.native('primary');
    const raw = await f.rawAgent();
    const request = {
      id: 'raw-meta',
      method: 'page.get_state',
      params: {},
      tab_id: null,
      session_id: null,
      meta: {
        protocol_version: 17,
        token_budget: 'invalid',
        source: 'untrusted',
        mcp_era: 'modern',
        automatic_retry: { attempt: 2, reason: 'retryable_error' },
        agent_session: 'bad session',
        transport_owner: 'forged',
        target_profile: 'primary',
      },
    };
    await raw.send(request);
    const forwarded = await host.request('page.get_state');
    assert.equal(forwarded.meta.protocol_version, getProtocolVersion());
    assert.equal(forwarded.meta.token_budget, null);
    for (const key of ['source', 'mcp_era', 'automatic_retry', 'agent_session'])
      assert.equal(forwarded.meta[key], undefined, key);
    assert.notEqual(forwarded.meta.transport_owner, 'forged');
    await host.reply(forwarded, { ready: true });
    assert.equal((await raw.response()).ok, true);
    for (const [method, params] of [
      ['artifact.read', { artifactId: '../private' }],
      ['session.journal_read', { journalId: '../private' }],
      ['dom.baseline.release', { baselineId: '../private' }],
      ['session.journal_read', { journalId: `journal_${'a'.repeat(64)}`, maxBytes: 196609 }],
      ['session.journal_read', { journalId: `journal_${'a'.repeat(64)}`, extra: true }],
    ] as const) {
      await raw.send({
        id: randomUUID(),
        method,
        params,
        meta: { protocol_version: getProtocolVersion() },
      });
      const response = await raw.response();
      assert.equal(response.ok, false);
      assert.equal(record(response.error).code, 'INVALID_REQUEST', method);
    }
    await raw.send({
      id: randomUUID(),
      method: 'page.get_state',
      params: {},
      tab_id: 1.5,
      meta: { protocol_version: getProtocolVersion() },
    });
    assert.equal(record((await raw.response()).error).code, 'INVALID_REQUEST');
  }
);
