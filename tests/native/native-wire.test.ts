import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net, { type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { NativeWireClient } from '../_helpers/nativeWire.ts';
import { setProtocolPackageVersion } from '../_helpers/protocolVersion.ts';

test('native wire bounds registration even when the peer accepts but never answers', async (t) => {
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.resume();
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  await assert.rejects(
    NativeWireClient.connect(address.port, 'token', 'test', 30),
    /registration|closed/
  );
});

test(
  'native wire supports isolated Unix sockets and per-request deadlines',
  {
    skip: process.platform === 'win32',
  },
  async (t) => {
    setProtocolPackageVersion('1.0.0');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'bbx-wire-'));
    const socketPath = path.join(directory, 'wire.sock');
    const sockets = new Set<Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      const lines = createInterface({ input: socket });
      lines.on('line', (line) => {
        const message = JSON.parse(line) as {
          type: string;
          request?: { id: string; method: string };
        };
        if (message.type === 'register') socket.write('{"type":"registered"}\n');
        else if (message.request?.method === 'health.ping')
          socket.write(
            `${JSON.stringify({
              type: 'agent.response',
              response: { id: message.request.id, ok: true, result: { ready: true } },
            })}\n`
          );
      });
    });
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    server.listen(socketPath);
    await once(server, 'listening');
    const client = await NativeWireClient.connect(socketPath, 'token');
    t.after(() => client.close());
    assert.deepEqual((await client.request({ method: 'health.ping' })).result, { ready: true });
    await assert.rejects(client.request({ method: 'page.get_state' }, 20), /Request timed out/);
    // An expired request must not poison subsequent calls on the same connection.
    assert.equal((await client.request({ method: 'health.ping' })).ok, true);
  }
);
