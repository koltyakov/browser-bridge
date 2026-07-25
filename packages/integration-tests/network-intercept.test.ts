import test from 'node:test';
import assert from 'node:assert/strict';

import {
  connectFakeExtension,
  connectTestClient,
  startTestDaemon,
} from '../../tests/_helpers/daemonHarness.ts';

test('network intercept: add, list, remove, and clear round-trip through the daemon', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);

  try {
    const client = await connectTestClient(ctx);
    try {
      const addPromise = client.request({
        method: 'network.intercept.add',
        params: { urlPattern: '*://example.com/*', action: 'block' },
        meta: { source: 'cli' },
      });
      const addForwarded = await extension.nextRequest();
      assert.equal(addForwarded.method, 'network.intercept.add');
      assert.deepEqual(addForwarded.params, {
        urlPattern: '*://example.com/*',
        action: 'block',
      });
      extension.respondOk(addForwarded, {
        ruleId: 'rule-1',
        urlPattern: '*://example.com/*',
        action: 'block',
      });
      const addResponse = await addPromise;
      assert.equal(addResponse.ok, true);
      assert.deepEqual(addResponse.result, {
        ruleId: 'rule-1',
        urlPattern: '*://example.com/*',
        action: 'block',
      });

      const fulfillPromise = client.request({
        method: 'network.intercept.add',
        params: {
          urlPattern: '*://example.com/mock',
          action: 'fulfill',
          statusCode: 200,
          body: '{"ok":true}',
        },
        meta: { source: 'cli' },
      });
      const fulfillForwarded = await extension.nextRequest();
      assert.deepEqual(fulfillForwarded.params, {
        urlPattern: '*://example.com/mock',
        action: 'fulfill',
        statusCode: 200,
        body: '{"ok":true}',
      });
      extension.respondOk(fulfillForwarded, { ruleId: 'rule-2' });
      const fulfillResponse = await fulfillPromise;
      assert.equal(fulfillResponse.ok, true);

      const listPromise = client.request({
        method: 'network.intercept.list',
        params: {},
        meta: { source: 'cli' },
      });
      const listForwarded = await extension.nextRequest();
      assert.equal(listForwarded.method, 'network.intercept.list');
      extension.respondOk(listForwarded, {
        rules: [
          { ruleId: 'rule-1', urlPattern: '*://example.com/*', action: 'block' },
          { ruleId: 'rule-2', urlPattern: '*://example.com/mock', action: 'fulfill' },
        ],
      });
      const listResponse = await listPromise;
      assert.equal(listResponse.ok, true);
      const listResult = listResponse.result as Record<string, unknown>;
      assert.equal(Array.isArray(listResult.rules), true);
      assert.equal((listResult.rules as unknown[]).length, 2);

      const removePromise = client.request({
        method: 'network.intercept.remove',
        params: { ruleId: 'rule-1' },
        meta: { source: 'cli' },
      });
      const removeForwarded = await extension.nextRequest();
      assert.equal(removeForwarded.method, 'network.intercept.remove');
      assert.deepEqual(removeForwarded.params, { ruleId: 'rule-1' });
      extension.respondOk(removeForwarded, { removed: true, ruleId: 'rule-1' });
      const removeResponse = await removePromise;
      assert.equal(removeResponse.ok, true);

      const clearPromise = client.request({
        method: 'network.intercept.clear',
        params: {},
        meta: { source: 'cli' },
      });
      const clearForwarded = await extension.nextRequest();
      assert.equal(clearForwarded.method, 'network.intercept.clear');
      extension.respondOk(clearForwarded, { cleared: true });
      const clearResponse = await clearPromise;
      assert.equal(clearResponse.ok, true);
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    extension.destroy();
    await ctx.stop();
  }
});

test('network intercept: extension error for an unknown rule id propagates to the client', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);

  try {
    const client = await connectTestClient(ctx);
    try {
      const responsePromise = client.request({
        method: 'network.intercept.remove',
        params: { ruleId: 'rule-missing' },
        meta: { source: 'cli' },
      });

      const forwarded = await extension.nextRequest();
      assert.equal(forwarded.method, 'network.intercept.remove');
      extension.respondError(
        forwarded,
        'INTERCEPT_NOT_FOUND',
        'No intercept rule with id "rule-missing".'
      );

      const response = await responsePromise;
      assert.equal(response.ok, false);
      assert.equal(response.error?.code, 'INTERCEPT_NOT_FOUND');
      assert.match(String(response.error?.message ?? ''), /rule-missing/);
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    extension.destroy();
    await ctx.stop();
  }
});

test('network intercept: requests fail immediately when no extension is connected', async () => {
  const ctx = await startTestDaemon();

  try {
    const client = await connectTestClient(ctx);
    try {
      const response = await client.request({
        method: 'network.intercept.list',
        params: {},
        meta: { source: 'cli' },
      });
      assert.equal(response.ok, false);
      assert.equal(response.error?.code, 'EXTENSION_DISCONNECTED');
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    await ctx.stop();
  }
});
