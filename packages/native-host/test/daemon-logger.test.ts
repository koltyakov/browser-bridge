import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DaemonLogger,
  normalizeDaemonLogger,
  silentLogger,
  wrapLegacyLogger,
} from '../src/daemon-logger.js';

type CaptureStream = { write(chunk: string): boolean };

function createCaptureStream(): { entries: string[]; stream: CaptureStream } {
  const entries: string[] = [];
  const stream = {
    write(chunk: string): boolean {
      entries.push(String(chunk).trim());
      return true;
    },
  };
  return { entries, stream };
}

test('DaemonLogger writes JSON lines to the stream', () => {
  const { entries, stream } = createCaptureStream();
  const logger = new DaemonLogger({ stream });

  logger.info('test message');
  logger.error('something failed', { code: 'ERR_X' });

  assert.equal(entries.length, 2);

  const info = JSON.parse(entries[0]);
  assert.equal(info.level, 'info');
  assert.equal(info.message, 'test message');
  assert.ok(typeof info.timestamp === 'string');

  const error = JSON.parse(entries[1]);
  assert.equal(error.level, 'error');
  assert.equal(error.message, 'something failed');
  assert.equal(error.code, 'ERR_X');
});

test('DaemonLogger respects minLevel', () => {
  const { entries, stream } = createCaptureStream();
  const logger = new DaemonLogger({ stream, minLevel: 'warn' });

  logger.debug('debug msg');
  logger.info('info msg');
  logger.warn('warn msg');
  logger.error('error msg');

  assert.equal(entries.length, 2);
  assert.equal(JSON.parse(entries[0]).level, 'warn');
  assert.equal(JSON.parse(entries[1]).level, 'error');
});

test('DaemonLogger merges defaults into every entry', () => {
  const { entries, stream } = createCaptureStream();
  const logger = new DaemonLogger({ stream, defaults: { pid: 1234 } });

  logger.info('with defaults');

  const entry = JSON.parse(entries[0]);
  assert.equal(entry.pid, 1234);
  assert.equal(entry.message, 'with defaults');
});

test('DaemonLogger extra fields override defaults', () => {
  const { entries, stream } = createCaptureStream();
  const logger = new DaemonLogger({ stream, defaults: { requestId: 'default' } });

  logger.info('override', { requestId: 'override' });

  const entry = JSON.parse(entries[0]);
  assert.equal(entry.requestId, 'override');
});

test('silentLogger does not throw', () => {
  assert.doesNotThrow(() => {
    silentLogger.debug('a');
    silentLogger.info('b');
    silentLogger.warn('c');
    silentLogger.error('d');
  });
});

test('wrapLegacyLogger bridges info to legacy log', () => {
  const logs: string[] = [];
  const legacy = {
    log(...args: unknown[]): void {
      logs.push(args.map((v) => String(v)).join(' '));
    },
    error(..._args: unknown[]): void {},
  };
  const wrapped = wrapLegacyLogger(legacy);

  wrapped.info('hello', { key: 'val' });
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('[info] hello'));
});

test('wrapLegacyLogger bridges error to legacy error', () => {
  const errors: string[] = [];
  const legacy = {
    log(..._args: unknown[]): void {},
    error(...args: unknown[]): void {
      errors.push(args.map((v) => String(v)).join(' '));
    },
  };
  const wrapped = wrapLegacyLogger(legacy);

  wrapped.error('fail');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('[error] fail'));
});

test('normalizeDaemonLogger returns DaemonLogger when undefined', () => {
  const result = normalizeDaemonLogger(undefined);
  assert.ok(result instanceof DaemonLogger);
});

test('normalizeDaemonLogger returns DaemonLoggerLike as-is', () => {
  const custom = { ...silentLogger };
  const result = normalizeDaemonLogger(custom);
  assert.equal(result, custom);
});

test('normalizeDaemonLogger wraps legacy logger', () => {
  const logs: string[] = [];
  const legacy = {
    log(...args: unknown[]): void {
      logs.push(args.map((v) => String(v)).join(' '));
    },
    error(..._args: unknown[]): void {},
  };
  const result = normalizeDaemonLogger(legacy);

  result.info('test');
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('[info] test'));
});
