import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import type { BridgeClient } from '../../agent-client/src/client.js';
import type { BridgeResponse } from '../../protocol/src/types.js';
import { PROTOCOL_VERSION } from '../../protocol/src/index.js';
import {
  isConnectionLossError,
  requestBridgeWithRetry,
  waitForClientReconnect,
} from '../src/handlers-utils.js';

test('MCP automatic retry marks only the bounded second attempt', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const responses: BridgeResponse[] = [
    {
      id: 'first',
      ok: false,
      result: null,
      error: {
        code: 'TIMEOUT',
        message: 'temporary',
        details: null,
        recovery: { retry: true, retryAfterMs: 0, hint: 'retry' },
      },
      meta: { protocol_version: PROTOCOL_VERSION },
    },
    {
      id: 'second',
      ok: true,
      result: {},
      error: null,
      meta: { protocol_version: PROTOCOL_VERSION },
    },
  ];
  const client = {
    connected: true,
    defaultTimeoutMs: 1_000,
    async connect() {},
    async request(request: Record<string, unknown>) {
      calls.push(request);
      return responses.shift() as BridgeResponse;
    },
  } as unknown as BridgeClient;

  const response = await requestBridgeWithRetry(
    client,
    'page.get_state',
    {},
    {
      source: 'mcp',
    }
  );

  assert.equal(response.ok, true);
  assert.equal((calls[0].meta as Record<string, unknown>).automatic_retry, undefined);
  assert.deepEqual((calls[1].meta as Record<string, unknown>).automatic_retry, {
    attempt: 2,
    reason: 'retryable_error',
  });
  assert.equal(calls.length, 2);
});

test('isConnectionLossError detects only transport-level failures', () => {
  const enotconn = Object.assign(new Error('BridgeClient is not connected.'), {
    code: 'ENOTCONN',
  });
  assert.equal(isConnectionLossError(enotconn), true);
  assert.equal(
    isConnectionLossError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })),
    true
  );
  assert.equal(isConnectionLossError(new Error('Bridge socket closed.')), true);
  assert.equal(
    isConnectionLossError(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })),
    false
  );
  assert.equal(isConnectionLossError(new Error('Access denied')), false);
  assert.equal(isConnectionLossError('ENOTCONN'), false);
  assert.equal(isConnectionLossError(null), false);
});

test('MCP retry waits for reconnect and retries once after daemon connection loss', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    autoReconnect: false,
    connected: true,
    defaultTimeoutMs: 1_000,
    async connect() {
      client.connected = true;
    },
    async request(request: Record<string, unknown>) {
      calls.push(request);
      if (calls.length === 1) {
        client.connected = false;
        throw Object.assign(new Error('BridgeClient is not connected.'), { code: 'ENOTCONN' });
      }
      return {
        id: 'second',
        ok: true,
        result: {},
        error: null,
        meta: { protocol_version: PROTOCOL_VERSION },
      } as BridgeResponse;
    },
  } as unknown as BridgeClient;

  const response = await requestBridgeWithRetry(client, 'page.get_state', {}, { source: 'mcp' });

  assert.equal(response.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual((calls[1].meta as Record<string, unknown>).automatic_retry, {
    attempt: 2,
    reason: 'retryable_error',
  });
});

test('MCP retry does not retry non-idempotent methods after connection loss', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    autoReconnect: false,
    connected: true,
    defaultTimeoutMs: 1_000,
    async connect() {
      client.connected = true;
    },
    async request(request: Record<string, unknown>) {
      calls.push(request);
      client.connected = false;
      throw Object.assign(new Error('BridgeClient is not connected.'), { code: 'ENOTCONN' });
    },
  } as unknown as BridgeClient;

  await assert.rejects(
    requestBridgeWithRetry(
      client,
      'input.click',
      { target: { elementRef: 'el_1' } },
      { source: 'mcp' }
    ),
    /not connected/
  );
  assert.equal(calls.length, 1);
});

test('MCP retry rethrows application-level thrown errors without reconnecting', async () => {
  const calls: Array<Record<string, unknown>> = [];
  let connectCalls = 0;
  const client = {
    autoReconnect: false,
    connected: true,
    defaultTimeoutMs: 1_000,
    async connect() {
      connectCalls += 1;
    },
    async request(request: Record<string, unknown>) {
      calls.push(request);
      throw Object.assign(new Error('Bridge transport timed out'), { code: 'TIMEOUT' });
    },
  } as unknown as BridgeClient;

  await assert.rejects(
    requestBridgeWithRetry(client, 'page.get_state', {}, { source: 'mcp' }),
    /timed out/
  );
  assert.equal(calls.length, 1);
  assert.equal(connectCalls, 0);
});

test('waitForClientReconnect resolves immediately when already connected', async () => {
  const client = { connected: true } as unknown as BridgeClient;
  assert.equal(await waitForClientReconnect(client, 10), true);
});

test('waitForClientReconnect manually reconnects when autoReconnect is off', async () => {
  let attempts = 0;
  const client = {
    autoReconnect: false,
    connected: false,
    async connect() {
      attempts += 1;
      if (attempts === 2) {
        client.connected = true;
        return;
      }
      throw new Error('connect ECONNREFUSED');
    },
  } as unknown as BridgeClient;

  assert.equal(await waitForClientReconnect(client, 2_000), true);
  assert.equal(attempts, 2);
});

test('waitForClientReconnect follows the autoReconnect reconnected event', async () => {
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    autoReconnect: true,
    connected: false,
    async connect() {
      throw new Error('manual connect must not run while autoReconnect owns reconnecting');
    },
  }) as unknown as BridgeClient;

  setTimeout(() => {
    client.connected = true;
    client.emit('reconnected');
  }, 20);

  assert.equal(await waitForClientReconnect(client, 2_000), true);
});

test('waitForClientReconnect gives up inside the bounded window', async () => {
  const client = {
    autoReconnect: false,
    connected: false,
    async connect() {
      throw new Error('connect ECONNREFUSED');
    },
  } as unknown as BridgeClient;

  const started = Date.now();
  assert.equal(await waitForClientReconnect(client, 100), false);
  assert.ok(Date.now() - started < 2_000);
});
