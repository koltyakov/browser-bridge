import test from 'node:test';
import assert from 'node:assert/strict';
import { withDocument } from '../../../tests/_helpers/dom.ts';
import { runWebMcpInDocument } from '../src/webmcp-document.js';
import { normalizeWebMcpParams } from '../../protocol/src/index.js';
import type { WebMcpContext, WebMcpDescriptor, WebMcpTool } from '../../protocol/src/types.js';

const NativeEvent = globalThis.Event;

function errorCode(value: Record<string, unknown>): unknown {
  return (value.error as { code?: unknown } | undefined)?.code;
}

async function fixture(
  t: import('node:test').TestContext,
  body: (context: {
    tools: WebMcpDescriptor[];
    api: WebMcpContext;
    run: (
      method: string,
      params?: Record<string, unknown>,
      owner?: string
    ) => Promise<Record<string, unknown>>;
    setExecute: (execute: WebMcpContext['executeTool']) => void;
  }) => Promise<void>
) {
  await withDocument('<main id="result">idle</main>', async ({ document, window }) => {
    Reflect.deleteProperty(globalThis, '__bbxWebMcp');
    t.after(() => Reflect.deleteProperty(globalThis, '__bbxWebMcp'));
    const tools: WebMcpDescriptor[] = [
      {
        name: 'set_status',
        origin: 'https://example.test',
        description: 'Set visible status',
        window,
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
    ];
    let execute: WebMcpContext['executeTool'] = async (_tool, args) => {
      document.getElementById('result')!.textContent = String(args.value);
      return JSON.stringify({ value: args.value });
    };
    const events = new EventTarget();
    const api: WebMcpContext = Object.assign(events, {
      getTools: async () => tools.map((tool) => ({ ...tool })),
      executeTool: (...args: Parameters<WebMcpContext['executeTool']>) => execute(...args),
    });
    Reflect.set(document, 'modelContext', api);
    await body({
      tools,
      api,
      run: (method, params = {}, owner = 'owner') =>
        runWebMcpInDocument(method, normalizeWebMcpParams(params), owner),
      setExecute: (callback) => {
        execute = callback;
      },
    });
  });
}

async function discover(
  run: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
) {
  const catalog = await run('webmcp.list_tools');
  const tools = catalog.tools as WebMcpTool[];
  assert.ok(tools.length);
  return tools[0].toolRef;
}

test('WebMCP absence differs from a supported empty catalog', async (t) => {
  await withDocument('<main/>', async () => {
    const result = await runWebMcpInDocument('webmcp.list_tools', normalizeWebMcpParams(), 'owner');
    assert.equal(result.supported, false);
    assert.equal(
      errorCode(await runWebMcpInDocument('webmcp.get_tool', normalizeWebMcpParams(), 'owner')),
      'WEBMCP_UNAVAILABLE'
    );
  });
  await fixture(t, async ({ tools, run }) => {
    tools.splice(0);
    const catalog = await run('webmcp.list_tools');
    assert.equal(catalog.supported, true);
    assert.equal(catalog.total, 0);
  });
});

test('WebMCP discovery filters frames/debugging, paginates and returns complete schemas separately', async (t) => {
  await fixture(t, async ({ tools, run }) => {
    tools[0].description = 'x'.repeat(1000);
    tools.push({ ...tools[0], name: 'child', window: {} as Window });
    tools.push({ ...tools[0], name: 'debug', annotations: { debugging: true } });
    tools.push({ ...tools[0], name: 'second' });
    const catalog = await run('webmcp.list_tools', { limit: 1 });
    assert.equal(catalog.total, 2);
    assert.equal(catalog.nextOffset, 1);
    const summary = (catalog.tools as WebMcpTool[])[0];
    assert.equal(summary.inputSchema, undefined);
    assert.equal(summary.description.length, 400);
    const full = await run('webmcp.get_tool', { toolRef: summary.toolRef });
    assert.equal((full.tool as WebMcpTool).description.length, 1000);
    assert.deepEqual((full.tool as WebMcpTool).inputSchema, tools[0].inputSchema);
    const more = await run('webmcp.list_tools', { offset: 1 });
    assert.equal((more.tools as WebMcpTool[])[0].name, 'second');
    assert.equal((await run('webmcp.list_tools', { includeDebugging: true })).total, 3);
    assert.equal((await run('webmcp.list_tools', { query: 'second' })).total, 1);
    assert.equal((await run('webmcp.list_tools', { limit: 100, maxBytes: 1024 })).truncated, true);
  });
});

test('WebMCP refs bind to owner, metadata, catalog revision, document and access teardown', async (t) => {
  await fixture(t, async ({ tools, api, run }) => {
    let ref = await discover(run);
    assert.equal(
      errorCode(await run('webmcp.get_tool', { toolRef: ref }, 'other')),
      'WEBMCP_TOOL_STALE'
    );
    ref = await discover(run);
    tools[0].description = 'replacement';
    assert.equal(
      errorCode(await run('webmcp.execute_tool', { toolRef: ref })),
      'WEBMCP_TOOL_STALE'
    );
    ref = await discover(run);
    api.dispatchEvent(new NativeEvent('toolchange'));
    assert.equal(errorCode(await run('webmcp.get_tool', { toolRef: ref })), 'WEBMCP_TOOL_STALE');
    ref = await discover(run);
    await run('clear');
    assert.equal(errorCode(await run('webmcp.get_tool', { toolRef: ref })), 'WEBMCP_TOOL_STALE');
    ref = await discover(run);
    tools.push({ ...tools[0] });
    assert.equal(
      errorCode(await run('webmcp.execute_tool', { toolRef: ref })),
      'WEBMCP_TOOL_STALE'
    );
  });
});

test('WebMCP executes once, preserves output and verifies visible postcondition', async (t) => {
  await fixture(t, async ({ run }) => {
    const toolRef = await discover(run);
    const result = await run('webmcp.execute_tool', { toolRef, arguments: { value: 'done' } });
    assert.equal(result.status, 'completed');
    assert.equal(result.value, '{"value":"done"}');
    assert.equal(document.getElementById('result')!.textContent, 'done');
  });
});

test('WebMCP timeout requests abort but retains busy lock until callback settles', async (t) => {
  await fixture(t, async ({ run, setExecute }) => {
    let complete: (value: unknown) => void = () => {};
    let signal: AbortSignal | undefined;
    setExecute((_tool, _args, options) => {
      signal = options.signal;
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    const toolRef = await discover(run);
    const result = await run('webmcp.execute_tool', { toolRef, timeoutMs: 100 });
    assert.equal(result.status, 'timeout');
    assert.equal(result.outcome, 'uncertain');
    assert.equal(signal?.aborted, true);
    assert.equal(errorCode(await run('webmcp.execute_tool', { toolRef })), 'WEBMCP_BUSY');
    complete('late result');
    await Promise.resolve();
  });
});

test('WebMCP navigation, rejection, oversized output and explicit cancellation never replay', async (t) => {
  await fixture(t, async ({ run, setExecute }) => {
    const toolRef = await discover(run);
    let calls = 0;
    setExecute(async () => {
      calls++;
      return null;
    });
    assert.equal((await run('webmcp.execute_tool', { toolRef })).status, 'navigation');
    setExecute(async () => {
      calls++;
      throw new Error('Failed to parse input: private-secret');
    });
    const failed = await run('webmcp.execute_tool', { toolRef });
    assert.equal(errorCode(failed), 'WEBMCP_EXECUTION_UNCERTAIN');
    assert.equal(JSON.stringify(failed).includes('private-secret'), false);
    setExecute(async () => {
      calls++;
      return 'x'.repeat(2000);
    });
    const large = await run('webmcp.execute_tool', { toolRef, maxBytes: 1024 });
    assert.equal(errorCode(large), 'RESULT_TOO_LARGE');
    assert.equal(calls, 3);
    setExecute(
      (_tool, _args, { signal }) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve(null)))
    );
    const pending = run('webmcp.execute_tool', { toolRef });
    await new Promise((resolve) => setImmediate(resolve));
    await run('clear');
    assert.equal((await pending).outcome, 'uncertain');
  });
});
