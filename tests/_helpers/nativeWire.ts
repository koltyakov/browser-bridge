import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { getProtocolVersion } from '../../protocol/src/index.js';
import type { BridgeRequest, BridgeResponse } from '../../protocol/types.js';

export function writeJsonLine(stream: Writable, message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

export function createNativeMessageWriter(stream: Writable) {
  return (message: unknown): Promise<void> => {
    const bytes = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(bytes.length);
    return new Promise((resolve, reject) => {
      stream.write(Buffer.concat([header, bytes]), (error) => (error ? reject(error) : resolve()));
    });
  };
}

export function createNativeMessageReader(
  stream: Readable,
  receive: (message: unknown) => void,
  fail: (error: Error) => void
) {
  let buffer = Buffer.alloc(0);
  stream.on('error', fail);
  stream.on('data', (chunk: Buffer) => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        assert.ok(length > 0 && length <= 1_048_576, 'invalid native message length');
        if (buffer.length < length + 4) break;
        const message: unknown = JSON.parse(buffer.subarray(4, length + 4).toString());
        buffer = buffer.subarray(length + 4);
        receive(message);
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// Test peer only: registration and correlated JSON-lines requests, without retries,
// method normalization, daemon startup, or other production-client behavior.
export class NativeWireClient {
  private readonly socket: net.Socket;
  private readonly pending = new Map<
    string,
    { resolve: (response: BridgeResponse) => void; reject: (error: Error) => void }
  >();

  private constructor(socket: net.Socket) {
    this.socket = socket;
  }

  static async connect(port: number, authToken: string, clientId: string = randomUUID()) {
    const socket = net.connect(port, '127.0.0.1');
    const client = new NativeWireClient(socket);
    const lines = createInterface({ input: socket });
    lines.on('error', (error) => client.fail(error));
    socket.on('error', (error) => client.fail(error));
    socket.on('close', () => client.fail(new Error('Agent socket closed')));
    try {
      await once(socket, 'connect');
      const registered = once(lines, 'line');
      await writeJsonLine(socket, { type: 'register', role: 'agent', authToken, clientId });
      const [line] = await registered;
      assert.equal((JSON.parse(String(line)) as { type: string }).type, 'registered');
      lines.on('line', (text) => {
        try {
          const message = JSON.parse(text) as { type: string; response: BridgeResponse };
          assert.equal(message.type, 'agent.response');
          client.pending.get(message.response.id)?.resolve(message.response);
        } catch (error) {
          client.fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      return client;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  private fail(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async request(
    input: Pick<BridgeRequest, 'method'> &
      Partial<Pick<BridgeRequest, 'id' | 'params' | 'tab_id'>> & {
        meta?: Partial<BridgeRequest['meta']>;
      }
  ): Promise<BridgeResponse> {
    assert.ok(!this.socket.destroyed, 'Agent socket is closed');
    const request: BridgeRequest = {
      id: randomUUID(),
      params: {},
      tab_id: null,
      ...input,
      meta: { protocol_version: getProtocolVersion(), token_budget: null, ...input.meta },
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error(`Request timed out: ${request.method}`)),
        5000
      );
      const finish = (error: Error | null, response?: BridgeResponse) => {
        clearTimeout(timer);
        this.pending.delete(request.id);
        if (error) reject(error);
        else if (response) resolve(response);
      };
      this.pending.set(request.id, {
        resolve: (response) => finish(null, response),
        reject: (error) => finish(error),
      });
      void writeJsonLine(this.socket, { type: 'agent.request', request }).catch((error: Error) =>
        finish(error)
      );
    });
  }

  async close() {
    if (this.socket.destroyed) return;
    const closed = once(this.socket, 'close');
    this.socket.destroy();
    await closed;
  }
}
