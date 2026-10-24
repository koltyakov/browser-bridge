import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { nativeExecutable, repoRoot, runCli } from '../_helpers/runCli.ts';
import type { BridgeMethod } from '../../protocol/src/types.js';

type Spec = {
  method: BridgeMethod;
  params: Record<string, unknown>;
  batch?: boolean;
  error?: boolean;
  mcpError?: boolean;
};

function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

// Explicit targets prevent a test run from drifting to a different profile or
// the user's next active tab. No navigation, input, patches, or debugger attach.
test(
  'live current-tab read-only CLI and MCP inspection matrix',
  { timeout: 300_000 },
  async (t) => {
    const extensionId = process.env.BBX_LIVE_EXTENSION_ID;
    const tabId = Number(process.env.BBX_LIVE_TAB_ID);
    assert(extensionId, 'Set BBX_LIVE_EXTENSION_ID to the selected connection ID.');
    assert(Number.isSafeInteger(tabId) && tabId > 0, 'Set BBX_LIVE_TAB_ID to the selected tab.');
    const target = { extensionId, tabId };
    const env = { ...process.env, BBX_REMOTE: '', BBX_AUTO_UPDATE: 'off' };
    const flags = ['--extension', extensionId, '--tab', String(tabId)];
    const rows: Array<{ mode: string; method: string; ms: number; bytes: number }> = [];
    const missing = `[data-bbx-missing-${crypto.randomUUID()}]`;
    const specs: Spec[] = [
      { method: 'health.ping', params: {} },
      { method: 'health.ping', params: { diagnostics: true } },
      { method: 'page.get_state', params: {} },
      ...[1, 10].map((limit): Spec => ({ method: 'tabs.list', params: { limit } })),
      { method: 'tabs.list', params: { limit: 1, offset: 100000 } },
      ...[100, 800, 2000].map((textBudget): Spec => ({
        method: 'page.get_text',
        params: { textBudget },
      })),
      ...['body', 'a', 'input', missing].flatMap((selector): Spec[] =>
        [1, 10, 20].map((maxNodes) => ({
          method: 'dom.query',
          params: {
            selector,
            maxNodes,
            maxDepth: 3,
            textBudget: 400,
            includeBbox: maxNodes === 10,
            attributeAllowlist: ['id', 'class', 'href', 'type', 'aria-label'],
          },
        }))
      ),
      ...[1, 5].flatMap((maxResults): Spec[] =>
        [false, true].map((includeHidden) => ({
          method: 'dom.find_by_role',
          params: { role: 'link', maxResults, includeHidden },
        }))
      ),
      { method: 'dom.find_by_role', params: { role: 'textbox', maxResults: 3 } },
      { method: 'dom.find_by_role', params: { role: 'button', name: missing, maxResults: 1 } },
      { method: 'dom.find_by_text', params: { text: missing, selector: 'a', maxResults: 1 } },
      ...['attached', 'visible'].map((state): Spec => ({
        method: 'dom.wait_for',
        params: { selector: 'body', state, timeoutMs: 100 },
        batch: false,
      })),
      ...['detached', 'hidden', 'attached'].map((state): Spec => ({
        method: 'dom.wait_for',
        params: { selector: missing, state, timeoutMs: 100 },
        batch: false,
        mcpError: state === 'attached',
      })),
      ...['outline', 'tree'].flatMap((format): Spec[] =>
        [false, true].map((interactiveOnly) => ({
          method: 'dom.get_accessibility_tree',
          params: { source: 'dom', format, interactiveOnly, maxNodes: 20, maxDepth: 4 },
        }))
      ),
      ...['local', 'session'].map((type): Spec => ({
        method: 'page.get_storage',
        params: { type, keys: [] },
      })),
      ...['all', 'error'].map((level): Spec => ({
        method: 'page.get_console',
        params: { level, limit: 5 },
      })),
      { method: 'page.get_network', params: { limit: 5 } },
      { method: 'page.get_network', params: { limit: 1, urlPattern: missing } },
      { method: 'patch.list', params: {} },
      { method: 'layout.hit_test', params: { x: 1, y: 1 } },
      { method: 'protocol.describe', params: { method: 'dom.query' } },
      { method: 'protocol.describe', params: { group: 'inspect' } },
      { method: 'dom.query', params: { selector: '[' }, error: true, batch: false },
      {
        method: 'dom.describe',
        params: { elementRef: 'el_0000_missing' },
        error: true,
        batch: false,
      },
    ];
    const initial = await runCli({
      args: [
        'call',
        ...flags,
        'dom.query',
        JSON.stringify({
          selector: 'body',
          maxNodes: 1,
          textBudget: 100,
          attributeAllowlist: ['id'],
        }),
      ],
      env,
    });
    assert.equal(initial.status, 0, initial.stdout);
    const nodes = record(initial.json).nodes;
    assert(Array.isArray(nodes) && nodes.length > 0);
    const elementRef = record(nodes[0]).elementRef;
    assert(typeof elementRef === 'string');
    specs.push(
      { method: 'dom.describe', params: { elementRef } },
      { method: 'dom.get_text', params: { elementRef, textBudget: 100 } },
      { method: 'dom.get_attributes', params: { elementRef, attributes: ['id', 'class'] } },
      { method: 'dom.get_html', params: { elementRef, outer: false, maxLength: 300 } },
      { method: 'dom.get_html', params: { elementRef, outer: true, maxLength: 300 } },
      { method: 'styles.get_computed', params: { elementRef, properties: ['display', 'color'] } },
      { method: 'styles.get_matched_rules', params: { elementRef } },
      { method: 'layout.get_box_model', params: { elementRef } },
      { method: 'dom.query', params: { withinRef: elementRef, maxNodes: 2, textBudget: 100 } }
    );
    for (const spec of specs) {
      await t.test(`CLI raw ${spec.method} ${JSON.stringify(spec.params)}`, async () => {
        const start = performance.now();
        const result = await runCli({
          args: ['call', ...flags, spec.method, JSON.stringify(spec.params)],
          env,
        });
        assert.equal(result.status === 0, !spec.error, result.stdout);
        assert(result.json !== null && typeof result.json === 'object');
        if (spec.error) assert.equal(record(result.json).ok, false);
        if (spec.mcpError) assert.equal(record(result.json).found, false);
        rows.push({
          mode: 'cli-raw',
          method: spec.method,
          ms: performance.now() - start,
          bytes: Buffer.byteLength(result.stdout),
        });
      });
    }
    const shortcuts = [
      ['status'],
      ['dom-query', 'a'],
      ['describe', elementRef],
      ['text', elementRef, '100'],
      ['html', elementRef, '300'],
      ['attrs', elementRef, 'id,class'],
      ['styles', elementRef, 'display,color'],
      ['matched-rules', elementRef],
      ['box', elementRef],
      ['find-role', 'link'],
      ['page-text', '100'],
      ['storage', 'local'],
      ['storage', 'session'],
      ['console', 'error'],
      ['network', '5'],
      ['patches'],
      ['wait', 'body', '100'],
      ['page.get_state', '{}'],
    ];
    for (const args of shortcuts) {
      await t.test(`CLI shortcut ${args[0]}`, async () => {
        const start = performance.now();
        const result = await runCli({ args: [...args, ...flags], env });
        assert.equal(result.status, 0, result.stdout);
        assert.notEqual(record(result.json).ok, false);
        rows.push({
          mode: 'cli-shortcut',
          method: args[0],
          ms: performance.now() - start,
          bytes: Buffer.byteLength(result.stdout),
        });
      });
    }
    const batchSpecs = specs.filter((spec) => spec.batch !== false && !spec.error);
    const chunks: Spec[][] = [];
    for (let offset = 0; offset < batchSpecs.length; offset += 20)
      chunks.push(batchSpecs.slice(offset, offset + 20));
    for (const evidenceOnly of [false, true]) {
      for (const [index, chunk] of chunks.entries()) {
        await t.test(`CLI batch ${index} evidenceOnly=${evidenceOnly}`, async () => {
          const start = performance.now();
          const result = await runCli({
            args: [
              'batch',
              ...(evidenceOnly ? ['--evidence-only'] : []),
              JSON.stringify(chunk.map(({ method, params }) => ({ method, params, ...target }))),
            ],
            env,
          });
          assert.equal(result.status, 0, result.stdout);
          assert(Array.isArray(result.json));
          assert.equal(result.json.length, chunk.length);
          for (const item of result.json) assert.equal(record(item).ok, true);
          rows.push({
            mode: evidenceOnly ? 'cli-batch-evidence' : 'cli-batch',
            method: String(chunk.length),
            ms: performance.now() - start,
            bytes: Buffer.byteLength(result.stdout),
          });
        });
      }
    }
    for (const modern of [false, true]) {
      const transport = new StdioClientTransport({
        command: nativeExecutable,
        args: ['mcp', 'serve'],
        cwd: repoRoot,
        stderr: 'pipe',
        env: Object.fromEntries(
          Object.entries(env).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        ),
      });
      const client = new Client(
        { name: 'live-read-only-inspection', version: '1.0.0' },
        modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}
      );
      try {
        await client.connect(transport);
        for (const spec of specs) {
          await t.test(
            `MCP modern=${modern} ${spec.method} ${JSON.stringify(spec.params)}`,
            async () => {
              const start = performance.now();
              const result = await client.callTool(
                {
                  name: 'browser_call',
                  arguments: { method: spec.method, params: spec.params, ...target },
                },
                { timeout: 20_000 }
              );
              assert.equal(
                result.isError === true,
                (spec.mcpError || spec.error) === true,
                JSON.stringify(result.content)
              );
              const structured = record(result.structuredContent);
              if (spec.method !== 'protocol.describe')
                assert.equal(structured.ok, !(spec.mcpError || spec.error));
              rows.push({
                mode: modern ? 'mcp-modern' : 'mcp-legacy',
                method: spec.method,
                ms: performance.now() - start,
                bytes: Buffer.byteLength(JSON.stringify(result)),
              });
            }
          );
        }
        for (const [index, chunk] of chunks.entries()) {
          await t.test(`MCP batch modern=${modern} chunk=${index}`, async () => {
            const start = performance.now();
            const result = await client.callTool(
              {
                name: 'browser_batch',
                arguments: {
                  calls: chunk.map(({ method, params }) => ({ method, params, ...target })),
                },
              },
              { timeout: 20_000 }
            );
            const structured = record(result.structuredContent);
            assert.equal(structured.ok, true, JSON.stringify(result.content));
            assert.equal(structured.successCount, chunk.length);
            rows.push({
              mode: modern ? 'mcp-modern-batch' : 'mcp-legacy-batch',
              method: String(chunk.length),
              ms: performance.now() - start,
              bytes: Buffer.byteLength(JSON.stringify(result)),
            });
          });
        }
        if (!modern) {
          for (const tool of [
            'browser_dom',
            'browser_page',
            'browser_styles_layout',
            'browser_tabs',
          ]) {
            await t.test(`MCP legacy load ${tool}`, async () => {
              const result = await client.callTool({
                name: 'browser_toolset',
                arguments: { tool },
              });
              assert.notEqual(result.isError, true);
            });
          }
          const typed = [
            {
              name: 'browser_dom',
              args: { action: 'query', selector: 'a', maxNodes: 2, textBudget: 100 },
            },
            { name: 'browser_dom', args: { action: 'describe', elementRef } },
            { name: 'browser_dom', args: { action: 'text', elementRef, textBudget: 100 } },
            { name: 'browser_dom', args: { action: 'attributes', elementRef, attributes: ['id'] } },
            { name: 'browser_dom', args: { action: 'html', elementRef, maxLength: 300 } },
            {
              name: 'browser_dom',
              args: {
                action: 'accessibility_tree',
                source: 'dom',
                interactiveOnly: true,
                maxNodes: 20,
              },
            },
            { name: 'browser_page', args: { action: 'state' } },
            { name: 'browser_page', args: { action: 'text', textBudget: 100 } },
            { name: 'browser_page', args: { action: 'network', limit: 5 } },
            { name: 'browser_page', args: { action: 'console', level: 'error', limit: 5 } },
            {
              name: 'browser_styles_layout',
              args: { action: 'computed', elementRef, properties: ['display'] },
            },
            { name: 'browser_styles_layout', args: { action: 'box_model', elementRef } },
            { name: 'browser_tabs', args: { action: 'list', limit: 1 } },
          ];
          for (const spec of typed) {
            await t.test(`MCP legacy typed ${spec.name} ${spec.args.action}`, async () => {
              const start = performance.now();
              const result = await client.callTool({
                name: spec.name,
                arguments: { ...spec.args, ...target },
              });
              assert.notEqual(result.isError, true, JSON.stringify(result.content));
              assert.equal(record(result.structuredContent).ok, true);
              rows.push({
                mode: 'mcp-legacy-typed',
                method: `${spec.name}.${spec.args.action}`,
                ms: performance.now() - start,
                bytes: Buffer.byteLength(JSON.stringify(result)),
              });
            });
          }
        }
      } finally {
        await client.close();
      }
    }
    const output = path.join(repoRoot, 'dist', 'inspection-live');
    await mkdir(output, { recursive: true });
    await writeFile(
      path.join(output, 'metrics.json'),
      JSON.stringify({ at: new Date().toISOString(), rows }, null, 2) + '\n'
    );
  }
);
