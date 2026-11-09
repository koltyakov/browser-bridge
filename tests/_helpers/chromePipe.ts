import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

export function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Each probe must respect its remaining budget, including connection setup. */
export async function eventually<T>(
  label: string,
  timeoutMs: number,
  probe: (remainingMs: number) => Promise<T>
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let last: unknown;
  while (performance.now() < deadline) {
    try {
      const result = await probe(Math.max(1, Math.floor(deadline - performance.now())));
      assert(performance.now() <= deadline, `${label} exceeded its deadline`);
      return result;
    } catch (error) {
      last = error;
    }
    await delay(Math.min(100, Math.max(0, deadline - performance.now())));
  }
  throw new Error(`${label} did not recover within ${timeoutMs}ms`, { cause: last });
}

/** Chrome --remote-debugging-pipe uses NUL-delimited CDP on inherited fds 3/4.
 * No listening port, WebSocket dependency, or attachment to a personal browser. */
export class ChromePipe extends EventEmitter {
  private nextId = 0;
  private buffer = '';
  private readonly pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private closed = false;

  constructor(
    private readonly input: Writable,
    output: Readable
  ) {
    super();
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      this.buffer += chunk;
      try {
        let end: number;
        while ((end = this.buffer.indexOf('\0')) >= 0) {
          const message = object(JSON.parse(this.buffer.slice(0, end)));
          this.buffer = this.buffer.slice(end + 1);
          if (typeof message.id === 'number') {
            const pending = this.pending.get(message.id);
            if (message.error) pending?.reject(new Error(JSON.stringify(message.error)));
            else pending?.resolve(object(message.result));
          } else if (typeof message.method === 'string') {
            this.emit(message.method, message.params, message.sessionId);
          }
        }
      } catch (error) {
        this.close(error instanceof Error ? error : new Error(String(error)));
      }
    });
    output.on('end', () => this.close());
    output.on('error', (error) => this.close(error));
    input.on('error', (error) => this.close(error));
  }

  command(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 3000
  ) {
    if (this.closed) return Promise.reject(new Error('Chrome debugging pipe closed'));
    const id = ++this.nextId;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`CDP timed out: ${method}`)), timeoutMs);
      const finish = (error: Error | null, result?: Record<string, unknown>) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve(result ?? {});
      };
      this.pending.set(id, {
        resolve: (result) => finish(null, result),
        reject: (error) => finish(error),
      });
      this.input.write(`${JSON.stringify({ id, method, params, sessionId })}\0`, (error) => {
        if (error) finish(error);
      });
    });
  }

  close(error = new Error('Chrome debugging pipe closed')) {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
