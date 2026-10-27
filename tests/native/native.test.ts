import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createRequest, getProtocolVersion } from '../../protocol/src/index.js';
import { setProtocolPackageVersion } from '../_helpers/protocolVersion.js';
import type { BridgeResponse } from '../../protocol/types.js';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as {
  version: string;
};
setProtocolPackageVersion(pkg.version);
const platform = process.platform === 'win32' ? 'windows' : process.platform;
const suffix = process.platform === 'win32' ? '.exe' : '';
const executable =
  process.env.BBX_NATIVE_EXECUTABLE ||
  path.join(root, 'dist/cli', `bbx-${platform}-${process.arch}${suffix}`);
const agentToken = 'agent_'.padEnd(43, 'a');
const extensionToken = 'extension_'.padEnd(43, 'b');
const goAvailable = await execFileAsync('go', ['version']).then(
  () => true,
  () => false
);
const enabled = goAvailable || Boolean(process.env.BBX_NATIVE_EXECUTABLE);

before(async () => {
  if (enabled && !process.env.BBX_NATIVE_EXECUTABLE) {
    await execFileAsync(process.execPath, ['scripts/build-native.mjs'], {
      cwd: root,
      timeout: 120_000,
    });
  }
});

type Message = Record<string, unknown>;
type Response = BridgeResponse;

class Wire {
  socket: net.Socket;
  messages: Message[] = [];
  waiters: { resolve: (message: Message) => void; reject: (error: Error) => void }[] = [];
  private error: Error | null = null;
  constructor(socket: net.Socket) {
    this.socket = socket;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const message = JSON.parse(buffer.slice(0, index)) as Message;
        buffer = buffer.slice(index + 1);
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(message);
        else this.messages.push(message);
      }
    });
    const fail = (error: Error) => {
      this.error = error;
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    };
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('socket closed')));
  }
  send(message: Message) {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }
  async read(): Promise<Message> {
    const message = this.messages.shift();
    if (message) return message;
    if (this.error) throw this.error;
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

async function openWire(
  address: number | string,
  role: 'agent' | 'extension',
  token = role === 'agent' ? agentToken : extensionToken
) {
  const socket =
    typeof address === 'number' ? net.connect(address, '127.0.0.1') : net.connect(address);
  const wire = new Wire(socket);
  await once(socket, 'connect');
  wire.send({ type: 'register', role, authToken: token, clientId: `test_${crypto.randomUUID()}` });
  const registered = await wire.read();
  assert.equal(registered.type, 'registered');
  return wire;
}

function request(id: string, method: string, params: Message = {}, meta: Message = {}) {
  return {
    type: 'agent.request',
    request: {
      id,
      method,
      params,
      tab_id: null,
      meta: { protocol_version: getProtocolVersion(), ...meta },
    },
  };
}

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-go-'));
  await fs.writeFile(path.join(home, 'daemon.auth'), `${agentToken}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(home, 'daemon.extension.auth'), `${extensionToken}\n`, {
    mode: 0o600,
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BROWSER_BRIDGE_HOME: home,
    BBX_AUTH_TOKEN: agentToken,
    BBX_AUTH_TOKEN_FILE: path.join(home, 'daemon.auth'),
    BBX_AUTO_UPDATE: 'off',
  };
  delete env.BBX_TCP_BIND_HOST;
  delete env.BBX_TCP_HOST;
  delete env.BBX_REMOTE;
  return { home, env, cleanup: () => fs.rm(home, { recursive: true, force: true, maxRetries: 5 }) };
}

async function nativeDaemon(transport: 'tcp' | 'unix' = 'tcp') {
  const f = await fixture();
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve()))
  );
  if (transport === 'tcp') f.env.BBX_TCP_PORT = String(port);
  else delete f.env.BBX_TCP_PORT;
  const process = spawn(executable, ['--bridge-daemon'], { env: f.env, stdio: 'pipe' });
  let stderr = '';
  process.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const probe = await openWire(
        transport === 'tcp' ? port : path.join(f.home, 'bridge.sock'),
        'agent'
      );
      probe.socket.destroy();
      break;
    } catch {
      if (process.exitCode !== null || attempt === 99)
        throw new Error(`Native daemon did not start: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  return {
    ...f,
    port,
    process,
    cleanup: async () => {
      if (process.exitCode === null && process.signalCode === null) {
        const exited = once(process, 'exit');
        process.kill();
        await exited;
      }
      await f.cleanup();
      assert.equal(stderr, '', 'native daemon must not panic or log credentials');
    },
  };
}

test(
  'native executable contains the protocol catalog and runs without a JavaScript runtime on PATH',
  { skip: !enabled, timeout: 120_000 },
  async () => {
    const { stdout } = await execFileAsync(executable, ['--self-test'], {
      env: { ...process.env, PATH: '' },
    });
    const result = JSON.parse(stdout) as { runtime: string; methodCount: number; version: string };
    assert.equal(result.runtime, 'go');
    assert.ok(result.methodCount > 100);
    assert.ok((await fs.stat(executable)).size < 10_000_000);
    const described = await execFileAsync(executable, [
      'protocol.describe',
      '{"method":"input.perform"}',
    ]);
    const detail = JSON.parse(described.stdout) as {
      method: string;
      inputSchema: { properties: Record<string, unknown>; required: string[] };
      example: { steps: unknown[]; returnLastResult: boolean };
    };
    assert.equal(detail.method, 'input.perform');
    assert.ok(detail.inputSchema.properties.steps);
    assert.deepEqual(detail.inputSchema.required, ['steps']);
    assert.equal(detail.example.returnLastResult, true);
    assert.equal(detail.example.steps.length, 2);
    const alias = await execFileAsync(executable, ['protocol', 'describe', 'input.perform']);
    assert.deepEqual(JSON.parse(alias.stdout), detail);
  }
);

test(
  'native CLI authenticates with the Go daemon and rejects mutations in batches',
  { skip: !enabled, timeout: 15_000 },
  async () => {
    const f = await nativeDaemon();
    try {
      const env = f.env;
      const { stdout } = await execFileAsync(executable, ['call', 'health.ping', '{}'], { env });
      const result = JSON.parse(stdout) as { daemon: string; extensionConnected: boolean };
      assert.equal(result.daemon, 'ok');
      assert.equal(result.extensionConnected, false);
      const rejected = await execFileAsync(
        executable,
        ['batch', '[{"method":"input.click","params":{}}]'],
        { env }
      ).then(
        () => null,
        (error: Error & { stdout: string; stderr: string }) => error
      );
      assert.ok(rejected);
      assert.equal(rejected.stderr, '');
      const batch = JSON.parse(rejected.stdout) as Array<{
        method: string;
        ok: boolean;
        error: { code: string; message: string };
        response?: unknown;
      }>;
      assert.equal(batch[0].method, 'input.click');
      assert.equal(batch[0].ok, false);
      assert.equal(batch[0].error.code, 'INVALID_REQUEST');
      assert.equal(
        batch[0].error.message,
        'input.click is not safe for batch execution. Call it sequentially.'
      );
      assert.equal('response' in batch[0], false);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'native daemon accepts wire requests and keeps protocol-major compatibility',
  { skip: !enabled, timeout: 15_000 },
  async () => {
    const f = await nativeDaemon();
    try {
      const wire = await openWire(f.port, 'agent');
      try {
        wire.send(request('current', 'health.ping'));
        const response = (await wire.read()).response as Response;
        assert.equal(response.ok, true, JSON.stringify(response));
        assert.equal((response.result as { daemon: string }).daemon, 'ok');
        const major = Number(getProtocolVersion().split('.')[0]);
        wire.send(request('minor', 'health.ping', {}, { protocol_version: `${major}.99` }));
        assert.equal(((await wire.read()).response as Response).ok, true);
        wire.send(request('major', 'health.ping', {}, { protocol_version: `${major + 1}.0` }));
        assert.equal(((await wire.read()).response as Response).ok, false);
      } finally {
        wire.socket.destroy();
      }
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'native CLI connects to the Go daemon over Unix sockets using stored credentials',
  { skip: !enabled || process.platform === 'win32', timeout: 15_000 },
  async () => {
    const f = await nativeDaemon('unix');
    delete f.env.BBX_AUTH_TOKEN;
    try {
      const { stdout } = await execFileAsync(executable, ['call', 'health.ping'], { env: f.env });
      assert.equal((JSON.parse(stdout) as { daemon: string }).daemon, 'ok');
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'native daemon enforces profile selection, response ownership, and same-ID isolation',
  { skip: !enabled, timeout: 15_000 },
  async () => {
    const f = await nativeDaemon();
    const connections: Wire[] = [];
    try {
      const a = await openWire(f.port, 'agent');
      const b = await openWire(f.port, 'agent');
      const left = await openWire(f.port, 'extension');
      const right = await openWire(f.port, 'extension');
      connections.push(a, b, left, right);
      left.send({ type: 'extension.identity', browserName: 'chrome', profileLabel: 'left' });
      right.send({ type: 'extension.identity', browserName: 'chrome', profileLabel: 'right' });
      // A local response acts as a barrier on each extension connection.
      for (const extension of [left, right]) {
        extension.send(request('ready', 'setup.install'));
        assert.equal(((await extension.read()).response as Response).ok, false);
      }
      a.send({
        ...request('ambiguous', 'page.get_state'),
        request: { ...request('ambiguous', 'page.get_state').request, tab_id: 42 },
      });
      const ambiguous = (await a.read()).response as Response;
      assert.equal(ambiguous.ok, false);
      assert.equal(ambiguous.error.code, 'TAB_MISMATCH');
      assert.equal(
        (ambiguous.error.details as { reason: string }).reason,
        'ambiguous_browser_target'
      );
      a.send(request('same', 'page.get_state', {}, { target_profile: 'left' }));
      b.send(request('same', 'page.get_state', {}, { target_profile: 'left' }));
      const first = (await left.read()).request as {
        id: string;
        meta: { transport_owner: string };
      };
      const second = (await left.read()).request as {
        id: string;
        meta: { transport_owner: string };
      };
      assert.notEqual(first.id, second.id);
      assert.notEqual(first.meta.transport_owner, second.meta.transport_owner);
      right.send({
        type: 'extension.response',
        response: { id: first.id, ok: true, result: { stolen: true } },
      });
      left.send({
        type: 'extension.response',
        response: { id: second.id, ok: true, result: { from: 'left' }, error: null, meta: {} },
      });
      left.send({
        type: 'extension.response',
        response: { id: first.id, ok: true, result: { from: 'left' }, error: null, meta: {} },
      });
      for (const agent of [a, b]) {
        const response = (await agent.read()).response as Response;
        assert.equal(response.id, 'same');
        assert.deepEqual(response.result, { from: 'left' });
      }
      a.send(request('pending', 'page.get_state', {}, { target_profile: 'left' }));
      await left.read();
      left.socket.destroy();
      assert.equal(((await a.read()).response as Response).error?.code, 'EXTENSION_DISCONNECTED');
    } finally {
      for (const wire of connections) wire.socket.destroy();
      await f.cleanup();
    }
  }
);

test(
  'native daemon rejects role spoofing and bounds unauthenticated frames',
  { skip: !enabled, timeout: 15_000 },
  async () => {
    const f = await nativeDaemon();
    try {
      const socket = net.connect(f.port, '127.0.0.1');
      const wire = new Wire(socket);
      wire.send({ type: 'register', role: 'extension', authToken: agentToken });
      assert.equal((await wire.read()).type, 'registration_failed');
      socket.destroy();
      const extension = await openWire(f.port, 'extension');
      extension.send(
        request('forbidden', 'input.fill', { target: { selector: 'input' }, value: 'no' })
      );
      assert.equal(((await extension.read()).response as Response).error?.code, 'ACCESS_DENIED');
      extension.socket.destroy();
      const hostile = net.connect(f.port, '127.0.0.1');
      hostile.on('error', () => {});
      await once(hostile, 'connect');
      const closed = new Promise<void>((resolve) => hostile.once('close', () => resolve()));
      hostile.write('x'.repeat(1_048_577));
      await closed;
      const probe = await openWire(f.port, 'agent');
      probe.send(request('still-running', 'daemon.metrics'));
      assert.equal(((await probe.read()).response as Response).ok, true);
      probe.socket.destroy();
    } finally {
      await f.cleanup();
    }
  }
);

function nativeFrame(message: Message) {
  const bytes = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length);
  return Buffer.concat([header, bytes]);
}

function nativeReader(process: ChildProcessWithoutNullStreams) {
  let buffer = Buffer.alloc(0);
  const messages: Message[] = [];
  const waiters: { resolve: (message: Message) => void; reject: (error: Error) => void }[] = [];
  let stderr = '';
  let closed: Error | null = null;
  process.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  process.once('close', () => {
    closed = new Error(`Native host closed: ${stderr}`);
    for (const waiter of waiters.splice(0)) waiter.reject(closed);
  });
  process.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const size = buffer.readUInt32LE(0);
      assert.ok(size <= 1_048_576);
      const message = JSON.parse(buffer.subarray(4, size + 4).toString()) as Message;
      buffer = buffer.subarray(size + 4);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else messages.push(message);
    }
  });
  return async () => {
    if (closed) throw closed;
    const queued = messages.shift();
    if (queued) return queued;
    return new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Native response timeout: ${stderr}`)), 3000);
      waiters.push({
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  };
}

test(
  'Go native host relays fragmented Chrome frames through the Go daemon',
  { skip: !enabled, timeout: 15_000 },
  async () => {
    const f = await nativeDaemon();
    let native: ChildProcessWithoutNullStreams | undefined;
    try {
      native = spawn(executable, ['--native-host'], {
        env: f.env,
        stdio: 'pipe',
      });
      const read = nativeReader(native);
      const frame = nativeFrame({ type: 'host.setup_status.request', requestId: 'fragmented' });
      native.stdin.write(frame.subarray(0, 2));
      native.stdin.write(frame.subarray(2, 7));
      native.stdin.write(frame.subarray(7));
      const status = await read();
      assert.equal(status.type, 'host.setup_status.response');
      assert.equal(status.requestId, 'fragmented');
      native.stdin.write(
        nativeFrame({
          type: 'host.bridge_request',
          request: createRequest({ id: 'setup', method: 'setup.get_status', params: {} }),
        })
      );
      const setup = await read();
      assert.equal(setup.type, 'host.bridge_response');
      assert.equal((setup.response as Response).ok, true);
      const exited = once(native, 'exit');
      f.process.kill();
      await exited;
    } finally {
      native?.kill();
      await f.cleanup();
    }
  }
);

function mcpPeer(env: NodeJS.ProcessEnv) {
  const child = spawn(executable, ['mcp', 'serve'], { env, stdio: 'pipe' });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<
    number,
    { resolve: (message: Message) => void; reject: (error: Error) => void }
  >();
  let next = 0;
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  lines.on('line', (line) => {
    const message = JSON.parse(line) as Message;
    const waiter = pending.get(Number(message.id));
    pending.delete(Number(message.id));
    waiter?.resolve(message);
  });
  child.on('close', () => {
    for (const waiter of pending.values()) waiter.reject(new Error(`MCP closed: ${stderr}`));
    pending.clear();
  });
  return {
    async request(method: string, params: Message = {}) {
      const id = ++next;
      const response = new Promise<Message>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP timeout: ${method}: ${stderr}`));
        }, 5000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return response;
    },
    async close() {
      if (child.exitCode === null) {
        const closed = once(child, 'close');
        child.stdin.end();
        await closed;
      }
      assert.equal(stderr, '');
    },
  };
}

test(
  'native MCP serves legacy initialization and rejects invalid routing before dispatch',
  { skip: !enabled, timeout: 15_000 },
  async () => {
    const f = await nativeDaemon();
    const mcp = mcpPeer(f.env);
    try {
      const initialized = await mcp.request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'interop', version: '1' },
      });
      assert.equal((initialized.result as Message).protocolVersion, '2025-11-25');
      const listed = await mcp.request('tools/list');
      const tools = (listed.result as { tools: { name: string }[] }).tools;
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [
        'browser_access',
        'browser_batch',
        'browser_call',
        'browser_health',
        'browser_status',
        'browser_toolset',
      ]);
      const status = await mcp.request('tools/call', { name: 'browser_status', arguments: {} });
      assert.equal(
        (status.result as { structuredContent: { evidence: { daemonReachable: boolean } } })
          .structuredContent.evidence.daemonReachable,
        true
      );
      const invalid = await mcp.request('tools/call', {
        name: 'browser_call',
        arguments: { method: 'input.click', tabId: 0, params: {} },
      });
      assert.equal((invalid.error as { code: number }).code, -32602);
      const batch = await mcp.request('tools/call', {
        name: 'browser_batch',
        arguments: { calls: [{ method: 'page.get_console', params: { clear: true } }] },
      });
      assert.equal((batch.result as { isError: boolean }).isError, true);
    } finally {
      await mcp.close();
      await f.cleanup();
    }
  }
);

test(
  'native MCP supports the modern per-request envelope without a legacy handshake',
  { skip: !enabled, timeout: 15_000 },
  async () => {
    const f = await fixture();
    const mcp = mcpPeer(f.env);
    const envelope = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    try {
      const listed = await mcp.request('tools/list', { _meta: envelope });
      assert.deepEqual(
        (listed.result as { tools: { name: string }[] }).tools.map((tool) => tool.name).sort(),
        [
          'browser_access',
          'browser_batch',
          'browser_call',
          'browser_health',
          'browser_skill',
          'browser_status',
        ]
      );
      const skill = await mcp.request('tools/call', {
        _meta: envelope,
        name: 'browser_skill',
        arguments: {},
      });
      assert.equal((skill.result as { isError?: boolean }).isError, undefined);
      assert.equal(
        (skill.result as { structuredContent: { ok: boolean } }).structuredContent.ok,
        true
      );
      const missing = await mcp.request('tools/list', {
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      });
      assert.equal((missing.error as { code: number }).code, -32602);
      const switched = await mcp.request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
      });
      assert.equal((switched.error as { code: number }).code, -32602);
    } finally {
      await mcp.close();
      await f.cleanup();
    }
  }
);
