import { build } from 'esbuild';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { Effect, Task } from './types.ts';

let compiled: Promise<string> | undefined;
function app(): Promise<string> {
  compiled ??= build({
    entryPoints: [fileURLToPath(new URL('./app.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
  }).then((result) => result.outputFiles[0].text);
  return compiled;
}

/** No HTTP oracle or reset endpoint exists. Effects remain controller-owned.
 * Attempts and commits are recorded independently of MCP/agent response flags. */
export class Fixture {
  readonly effects: Effect[] = [];
  private readonly events = new EventEmitter();
  private servers: Server[] = [];
  private origins: string[] = [];
  private started = 0;
  private active = false;
  private sequence = 0;
  private closed = false;
  private releaseHeld?: () => void;
  private held: Promise<void> | undefined;
  constructor(
    readonly task: Task,
    readonly seed: number
  ) {}

  get url(): string {
    return `${this.origins[0]}/page`;
  }
  begin(): void {
    this.effects.length = 0;
    this.sequence = 0;
    this.started = performance.now();
    this.active = true;
    if (this.task.id === 'disconnect-after-commit') {
      this.held = new Promise<void>((resolve) => {
        this.releaseHeld = resolve;
      });
    }
  }
  private record(phase: Effect['phase'], operation: string, record: string, value: string): void {
    if (!this.active) return;
    this.effects.push({
      sequence: ++this.sequence,
      phase,
      operation,
      record,
      value,
      atMs: performance.now() - this.started,
    });
    this.events.emit('effect');
  }
  async start(): Promise<void> {
    const script = await app();
    try {
      for (let index = 0; index < 2; index++) {
        const server = createServer(async (request, response) => {
          try {
            const url = new URL(request.url ?? '/', 'http://fixture.invalid');
            response.setHeader('Cache-Control', 'no-store');
            response.setHeader('X-Content-Type-Options', 'nosniff');
            if (request.method === 'POST' && url.pathname === '/effect') {
              let text = '';
              for await (const chunk of request) {
                text += String(chunk);
                if (Buffer.byteLength(text) > 4096) {
                  response.writeHead(413).end();
                  return;
                }
              }
              const entry: unknown = JSON.parse(text);
              if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                response.writeHead(400).end();
                return;
              }
              const data = entry as Record<string, unknown>;
              if (
                typeof data.operation !== 'string' ||
                typeof data.record !== 'string' ||
                typeof data.value !== 'string'
              ) {
                response.writeHead(400).end();
                return;
              }
              this.record('attempt', data.operation, data.record, data.value);
              // Deliberately no idempotency key or duplicate suppression.
              this.record('commit', data.operation, data.record, data.value);
              if (data.operation === 'save' && data.record === 'main') await this.held;
              response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"saved":true}');
              return;
            }
            if (request.method !== 'GET') {
              response.writeHead(405).end();
              return;
            }
            if (url.pathname === '/app.js') {
              response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(script);
              return;
            }
            if (!['/page', '/dashboard', '/frame', '/nested', '/user'].includes(url.pathname)) {
              response.writeHead(404).end();
              return;
            }
            if (['/page', '/dashboard'].includes(url.pathname) && this.active) {
              this.record('attempt', 'document_reload', 'main', '');
              this.record('commit', 'document_reload', 'main', '');
            }
            response.setHeader(
              'Content-Security-Policy',
              `default-src 'self'; frame-src ${this.origins.join(' ')}; style-src 'unsafe-inline'`
            );
            const record =
              url.pathname === '/user' ? 'user' : url.pathname === '/frame' ? 'payment' : 'main';
            const isMain = url.pathname === '/page' || url.pathname === '/dashboard';
            const frameOrigin = this.task.id === 'frame-same' ? this.origins[0] : this.origins[1];
            const frames =
              isMain && this.task.family === 'frames'
                ? `<iframe title="Payment" src="${frameOrigin}/${this.task.id === 'frame-nested' ? 'nested' : 'frame'}"></iframe>`
                : url.pathname === '/nested'
                  ? `<iframe title="Payment" src="${this.origins[0]}/frame"></iframe>`
                  : '';
            const label =
              record === 'payment'
                ? 'Payment profile'
                : record === 'user'
                  ? 'User profile'
                  : 'Main profile';
            const distractor = this.seed % 2 ? '<button type="button" hidden>Save</button>' : '';
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
              .end(`<!doctype html>
<html lang="en"><meta charset="utf-8"><title>${label}</title>
<body data-record="${record}" data-task="${this.task.id}">
<h1>${label}</h1>${distractor}<form id="${record}-profile" aria-label="${label}">
<label for="email">Email</label><input id="email" type="email">
<button id="save" type="submit">Save</button></form>
<a id="dashboard" href="/dashboard">Dashboard</a>
<button id="confirm">Confirm save</button><button id="first">First</button>
<button id="late">Late</button><button id="probe">Recovery probe</button>
<output id="${record}-status" role="status"></output>${frames}<script src="/app.js"></script></body></html>`);
          } catch {
            if (!response.headersSent) response.writeHead(400);
            response.end();
          }
        });
        this.servers.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture address');
        this.origins.push(`http://127.0.0.1:${address.port}`);
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  waitForCommit(operation: string, record: string, signal: AbortSignal): Promise<void> {
    const matched = () =>
      this.effects.some(
        (effect) =>
          effect.phase === 'commit' && effect.operation === operation && effect.record === record
      );
    if (signal.aborted || this.closed) return Promise.reject(new Error('Fixture wait canceled'));
    if (matched()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        this.events.off('effect', check);
        this.events.off('close', cancel);
        signal.removeEventListener('abort', cancel);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (matched()) finish();
      };
      const cancel = () => finish(new Error('Fixture wait canceled'));
      this.events.on('effect', check);
      this.events.once('close', cancel);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  goalAtMs(): number | null {
    if (!this.task.expected.length) return null;
    let at = 0;
    for (const expected of this.task.expected) {
      const commits = this.effects.filter(
        (effect) =>
          effect.phase === 'commit' &&
          effect.operation === expected.operation &&
          effect.record === expected.record &&
          (expected.value === undefined || effect.value === expected.value)
      );
      if (commits.length < expected.count) return null;
      at = Math.max(at, commits[expected.count - 1]?.atMs ?? 0);
    }
    return at;
  }
  releaseReply(): void {
    this.releaseHeld?.();
  }
  end(): void {
    this.active = false;
  }
  async close(): Promise<void> {
    this.end();
    this.closed = true;
    this.releaseReply();
    this.events.emit('close');
    await Promise.all(
      this.servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          })
      )
    );
  }
}
