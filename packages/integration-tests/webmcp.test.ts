import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestDaemon,
  connectFakeExtension,
  connectTestClient,
} from '../../tests/_helpers/daemonHarness.ts';

test('WebMCP discovery, schema, and approved execution preserve JSON through client/daemon transport', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);
  const client = await connectTestClient(ctx);
  try {
    const toolRef = 'wm_12345678-1234-1234-1234-123456789012';
    const discovery = client.request({
      method: 'webmcp.list_tools',
      tabId: 10,
      params: { query: 'search', limit: 5 },
      meta: { agent_session: 'webmcp-test' },
    });
    const listed = await extension.nextRequest();
    assert.equal(listed.method, 'webmcp.list_tools');
    assert.equal(listed.tab_id, 10);
    assert.equal(listed.params.query, 'search');
    extension.respondOk(listed, {
      supported: true,
      tools: [{ toolRef, name: 'search' }],
      total: 1,
    });
    assert.ok((await discovery).ok);

    const inputSchema = {
      type: 'object',
      properties: {
        query: { type: 'string', enum: Array.from({ length: 1000 }, (_, i) => `item-${i}`) },
      },
    };
    const schema = client.request({ method: 'webmcp.get_tool', tabId: 10, params: { toolRef } });
    const inspected = await extension.nextRequest();
    extension.respondOk(inspected, { tool: { toolRef, inputSchema } });
    const complete = await schema;
    assert.ok(complete.ok);
    assert.deepEqual(
      (complete.result as { tool: { inputSchema: unknown } }).tool.inputSchema,
      inputSchema
    );

    const execution = client.request({
      method: 'webmcp.execute_tool',
      tabId: 10,
      params: { toolRef, arguments: { query: 'item-123' } },
    });
    const dispatched = await extension.nextRequest();
    assert.equal(dispatched.method, 'webmcp.execute_tool');
    assert.deepEqual(dispatched.params.arguments, { query: 'item-123' });
    extension.respondError(dispatched, 'WEBMCP_APPROVAL_DENIED', 'User declined.');
    const denied = await execution;
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.error.code, 'WEBMCP_APPROVAL_DENIED');
      assert.notEqual(denied.error.recovery?.retry, true);
    }

    const approved = client.request({
      method: 'webmcp.execute_tool',
      tabId: 10,
      params: { toolRef, arguments: { query: 'item-123' } },
    });
    const approvedRequest = await extension.nextRequest();
    const output = {
      status: 'completed',
      dispatched: true,
      outcome: 'completed',
      value: 'x'.repeat(5000),
    };
    extension.respondOk(approvedRequest, output);
    assert.deepEqual((await approved).result, output);
  } finally {
    await client.close();
    extension.destroy();
    await ctx.stop();
  }
});
