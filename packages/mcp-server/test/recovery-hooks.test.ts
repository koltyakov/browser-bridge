import test from 'node:test';
import assert from 'node:assert/strict';

import type { BridgeClient } from '../../agent-client/src/client.js';
import type { BridgeResponse } from '../../protocol/src/types.js';
import { PROTOCOL_VERSION } from '../../protocol/src/index.js';
import { requestBridgeWithRetry } from '../src/handlers-utils.js';

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
