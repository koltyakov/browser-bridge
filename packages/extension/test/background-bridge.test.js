// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { ERROR_CODES, createRequest } from '../../protocol/src/index.js';
import { createNativePortMessageListener } from '../src/background-bridge.js';

test('background bridge returns INVALID_REQUEST when native-port message fails validation', () => {
  /** @type {import('../../protocol/src/types.js').BridgeRequest[]} */
  const forwarded = [];
  /** @type {import('../../protocol/src/types.js').BridgeResponse[]} */
  const replies = [];

  const listener = createNativePortMessageListener({
    handleHostStatusMessage() {
      return false;
    },
    async handleBridgeRequest(request) {
      forwarded.push(request);
    },
    reply(response) {
      replies.push(response);
    },
    reportAsyncError() {},
  });

  listener({
    id: 'req-invalid',
    method: 'unknown.method',
    params: {},
  });

  assert.deepEqual(forwarded, []);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, 'req-invalid');
  assert.equal(replies[0].ok, false);
  assert.equal(replies[0].error.code, ERROR_CODES.INVALID_REQUEST);
  assert.equal(replies[0].error.message, 'Unsupported method: unknown.method');
  assert.equal(replies[0].meta?.method, 'unknown.method');
});

test('background bridge forwards validated native-port requests to the background handler', () => {
  /** @type {import('../../protocol/src/types.js').BridgeRequest[]} */
  const forwarded = [];
  /** @type {import('../../protocol/src/types.js').BridgeResponse[]} */
  const replies = [];

  const listener = createNativePortMessageListener({
    handleHostStatusMessage() {
      return false;
    },
    async handleBridgeRequest(request) {
      forwarded.push(request);
    },
    reply(response) {
      replies.push(response);
    },
    reportAsyncError() {},
  });

  listener(
    createRequest({
      id: 'req-valid',
      method: 'health.ping',
    })
  );

  assert.equal(replies.length, 0);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].id, 'req-valid');
  assert.equal(forwarded[0].method, 'health.ping');
});
