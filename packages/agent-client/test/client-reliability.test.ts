import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { BridgeClient } from '../src/client.js';
import { withBridgeClient } from '../src/runtime.js';
import { createSuccess } from '../../protocol/src/index.js';
import { bridgeServerWith } from '../../../tests/_helpers/socketHarness.ts';

function listenerCounts(socket: net.Socket): number[] {
  return ['drain', 'error', 'close'].map((event) => socket.listenerCount(event));
}

for (const outcome of ['timeout', 'error', 'close'] as const) {
  test(
    `stalled request write rejects on ${outcome} and cleans listeners`,
    { timeout: 2000 },
    async (t) => {
      const server = await bridgeServerWith({});
      const client = new BridgeClient({
        socketPath: server.socketPath,
        checkProtocolOnConnect: false,
      });
      t.after(async () => {
        client.socket?.destroy();
        await server.close();
      });
      await client.connect();
      const socket = client.socket;
      assert.ok(socket);
      const baseline = listenerCounts(socket);
      t.mock.method(socket, 'write', () => false);

      const request = client.request({ method: 'health.ping', timeoutMs: 25 });
      const rejected = assert.rejects(
        request,
        outcome === 'timeout' ? { code: 'BRIDGE_TIMEOUT' } : /socket|injected/
      );
      if (outcome === 'error') socket.emit('error', new Error('injected write error'));
      if (outcome === 'close') socket.destroy();
      await rejected;
      assert.equal(client.waiting.size, 0);
      assert.deepEqual(listenerCounts(socket), baseline);
    }
  );
}

test('repeated successful drains restore listener baseline', async (t) => {
  const server = await bridgeServerWith({
    'health.ping': (request) => createSuccess(request.id, { daemon: 'ok' }),
  });
  const client = new BridgeClient({ socketPath: server.socketPath, checkProtocolOnConnect: false });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await client.connect();
  const socket = client.socket;
  assert.ok(socket);
  const baseline = listenerCounts(socket);
  const write = socket.write.bind(socket);
  t.mock.method(socket, 'write', (line: string) => {
    write(line);
    queueMicrotask(() => socket.emit('drain'));
    return false;
  });
  for (let index = 0; index < 30; index += 1) {
    assert.equal((await client.request({ method: 'health.ping' })).ok, true);
    assert.deepEqual(listenerCounts(socket), baseline);
  }
});

test('response completes a request even if drain never arrives', { timeout: 2000 }, async (t) => {
  const server = await bridgeServerWith({
    'health.ping': (request) => createSuccess(request.id, { daemon: 'ok' }),
  });
  const client = new BridgeClient({ socketPath: server.socketPath, checkProtocolOnConnect: false });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await client.connect();
  const socket = client.socket;
  assert.ok(socket);
  const baseline = listenerCounts(socket);
  const write = socket.write.bind(socket);
  t.mock.method(socket, 'write', (line: string) => {
    write(line);
    return false;
  });
  assert.equal((await client.request({ method: 'health.ping', timeoutMs: 100 })).ok, true);
  assert.deepEqual(listenerCounts(socket), baseline);
  assert.equal(client.waiting.size, 0);
});

for (const failure of [
  'rejected',
  'timeout',
  'response timeout',
  'write error',
  'write throw',
  'connect error',
] as const) {
  test(`failed registration can retry after ${failure}`, { timeout: 2000 }, async (t) => {
    const sockets: net.Socket[] = [];
    t.after(() => sockets.forEach((socket) => socket.destroy()));
    t.mock.method(net, 'createConnection', () => {
      const socket = new net.Socket();
      t.mock.method(socket, '_read', () => {});
      sockets.push(socket);
      const first = sockets.length === 1;
      t.mock.method(socket, 'write', () => {
        if (first && failure === 'write throw') throw new Error('write error');
        if (first && failure === 'write error') {
          queueMicrotask(() => socket.emit('error', new Error('injected write error')));
          return false;
        }
        if (first && failure === 'timeout') return false;
        if (first && failure === 'response timeout') return true;
        queueMicrotask(() =>
          socket.emit(
            'data',
            Buffer.from(
              `${JSON.stringify(
                first
                  ? { type: 'registration_failed', error: { message: 'registration rejected' } }
                  : { type: 'registered', role: 'agent', clientId: 'retry' }
              )}\n`
            )
          )
        );
        return true;
      });
      queueMicrotask(() => {
        if (first && failure === 'connect error') socket.emit('error', new Error('connect error'));
        else socket.emit('connect');
      });
      return socket;
    });
    const client = new BridgeClient({
      authToken: null,
      checkProtocolOnConnect: false,
      defaultTimeoutMs: 25,
    });
    await assert.rejects(client.connect(), /rejected|Timed out|write error|connect error/);
    assert.equal(client.socket, null);
    assert.equal(client.connected, false);
    assert.equal(client.waiting.size, 0);
    assert.equal(sockets[0].destroyed, true);
    assert.equal(sockets[0].listenerCount('drain'), 0);
    assert.equal(sockets[0].listenerCount('connect'), 0);
    await client.connect();
    sockets[0].emit('close');
    if (failure !== 'connect error') sockets[0].emit('error', new Error('late error'));
    assert.equal(client.socket, sockets[1]);
    assert.equal(client.connected, true);
    assert.deepEqual(listenerCounts(sockets[1]), [0, 1, 1]);
  });
}

test('withBridgeClient closes after connect rejects without running callback', async (t) => {
  const failure = new Error('connect failed');
  const connect = t.mock.method(BridgeClient.prototype, 'connect', async () => {
    throw failure;
  });
  const close = t.mock.method(BridgeClient.prototype, 'close', async () => {});
  const callback = t.mock.fn(async () => {});
  await assert.rejects(
    withBridgeClient(callback, { updateNpmOnCompatibleVersion: false }),
    failure
  );
  assert.equal(connect.mock.callCount(), 1);
  assert.equal(close.mock.callCount(), 1);
  assert.equal(callback.mock.callCount(), 0);
});

test('close destroys a backpressured socket instead of waiting for buffered writes', async (t) => {
  const client = new BridgeClient();
  const socket = new net.Socket();
  client.socket = socket;
  Object.defineProperty(socket, 'writableNeedDrain', { value: true });
  const end = t.mock.method(socket, 'end', () => {
    throw new Error('must not wait for stalled writes');
  });
  await client.close();
  assert.equal(socket.destroyed, true);
  assert.equal(client.autoReconnect, false);
  assert.equal(end.mock.callCount(), 0);
});

for (const connectEventDelivered of [false, true]) {
  test(
    `close cancels a real connecting socket with connect event delivered=${connectEventDelivered}`,
    { timeout: 2000 },
    async (t) => {
      const server = await bridgeServerWith({});
      const client = new BridgeClient({
        socketPath: server.socketPath,
        checkProtocolOnConnect: false,
      });
      // Hold DNS resolution so the real socket stays connecting without relying on network timing.
      const socket = new net.Socket().connect({
        host: 'pending.invalid',
        port: 9,
        lookup: () => {},
      });
      t.after(async () => {
        socket.destroy();
        await client.close();
        await server.close();
      });
      assert.equal(socket.connecting, true);
      assert.equal(socket.writableNeedDrain, false);
      const baseline = listenerCounts(socket);
      const createConnection = t.mock.method(net, 'createConnection', () => socket);
      const connecting = client.connect();
      const rejected = assert.rejects(connecting, /closed while connecting/);
      if (connectEventDelivered) socket.emit('connect');

      const closing = client.close();
      assert.equal(socket.destroyed, true);
      assert.equal(client.socket, null);
      assert.equal(client.connected, false);
      assert.equal(client.waiting.size, 0);

      createConnection.mock.restore();
      const retry = client.connect();
      const retrySocket = client.socket;
      await closing;
      await rejected;
      assert.equal(client.socket, retrySocket);
      assert.deepEqual(listenerCounts(socket), baseline);
      await retry;
      socket.emit('connect');
      socket.emit('data', '{"type":"registered"}\n');
      socket.emit('close');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(client.socket, retrySocket);
      assert.equal(client.connected, true);
      assert.equal(client.waiting.size, 0);
    }
  );
}

test('close cancels registration and permits immediate retry', { timeout: 2000 }, async (t) => {
  const sockets: net.Socket[] = [];
  let registrationWritten: () => void = () => {};
  const written = new Promise<void>((resolve) => {
    registrationWritten = resolve;
  });
  t.after(() => sockets.forEach((socket) => socket.destroy()));
  t.mock.method(net, 'createConnection', () => {
    const socket = new net.Socket();
    t.mock.method(socket, '_read', () => {});
    sockets.push(socket);
    const first = sockets.length === 1;
    t.mock.method(socket, 'write', () => {
      if (first) registrationWritten();
      else queueMicrotask(() => socket.emit('data', '{"type":"registered"}\n'));
      return true;
    });
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  });
  const client = new BridgeClient({ authToken: null, checkProtocolOnConnect: false });
  const rejected = assert.rejects(client.connect(), /Bridge socket closed/);
  await written;
  assert.equal(client.waiting.has('registered'), true);
  const closing = client.close();
  assert.equal(client.waiting.size, 0);
  assert.equal(client.socket, null);
  assert.equal(sockets[0].destroyed, true);
  const retry = client.connect();
  await closing;
  await rejected;
  await retry;
  sockets[0].emit('data', '{"type":"registered"}\n');
  sockets[0].emit('close');
  assert.equal(client.connected, true);
  assert.equal(client.socket, sockets[1]);
  assert.equal(client.waiting.size, 0);
});
