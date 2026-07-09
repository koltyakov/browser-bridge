import test from 'node:test';
import assert from 'node:assert/strict';

import { ERROR_CODES, createRequest, PROTOCOL_VERSION } from '../../protocol/src/index.js';
import type { BridgeRequest, BridgeResponse } from '../../protocol/src/types.js';
import { createNativePortMessageListener } from '../src/background-bridge.js';

test('background bridge returns INVALID_REQUEST when native-port message fails validation', () => {
  const forwarded: BridgeRequest[] = [];
  const replies: BridgeResponse[] = [];

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

test('background bridge handles malformed native-port messages without method metadata', () => {
  const forwarded: BridgeRequest[] = [];
  const replies: BridgeResponse[] = [];

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

  listener(null);

  assert.deepEqual(forwarded, []);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, 'invalid_request');
  assert.equal(replies[0].ok, false);
  assert.equal(replies[0].error.code, ERROR_CODES.INVALID_REQUEST);
  assert.deepEqual(replies[0].meta, { protocol_version: PROTOCOL_VERSION });
});

test('background bridge lets host status messages bypass request validation', () => {
  const replies: BridgeResponse[] = [];
  let handledHostStatus = false;

  const listener = createNativePortMessageListener({
    handleHostStatusMessage(message) {
      handledHostStatus = message === 'host-status';
      return handledHostStatus;
    },
    async handleBridgeRequest() {
      assert.fail('host status messages should not be forwarded as bridge requests');
    },
    reply(response) {
      replies.push(response);
    },
    reportAsyncError() {},
  });

  listener('host-status');

  assert.equal(handledHostStatus, true);
  assert.deepEqual(replies, []);
});

test('background bridge reports asynchronous request handler failures', async () => {
  const reports: unknown[] = [];
  const listener = createNativePortMessageListener({
    handleHostStatusMessage() {
      return false;
    },
    async handleBridgeRequest() {
      throw new Error('handler failed');
    },
    reply() {},
    reportAsyncError(error) {
      reports.push(error);
    },
  });

  listener(
    createRequest({
      id: 'req-valid-error',
      method: 'health.ping',
    })
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reports.length, 1);
  assert.match(
    reports[0] instanceof Error ? reports[0].message : String(reports[0]),
    /handler failed/
  );
});

test('background bridge forwards validated native-port requests to the background handler', () => {
  const forwarded: BridgeRequest[] = [];
  const replies: BridgeResponse[] = [];

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
