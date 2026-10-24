import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { nativeExecutable, repoRoot, runCli } from '../_helpers/runCli.ts';
import type { BridgeMethod } from '../../protocol/src/types.js';

type FuzzCase = { method: BridgeMethod; params: Record<string, unknown> };

function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

// Fixed seed makes failures reproducible. Only read methods are generated, and
// every request stays pinned to the selected tab and profile.
function cases(): FuzzCase[] {
  let seed = 0xbbf022;
  function pick<T>(values: readonly T[]): T {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return values[seed % values.length];
  }
  const selectors = [
    'body',
    'a',
    'input',
    'button',
    '[role]',
    ':is(a, button)',
    '[data-bbx-fuzz-missing]',
  ];
  return Array.from({ length: 80 }, (_, index) => {
    const budget = pick([1, 2, 31, 32, 33, 99, 100, 127, 255, 799]);
    const selector = pick(selectors);
    switch (index % 4) {
      case 0:
        return {
          method: 'dom.query',
          params: {
            selector,
            maxNodes: pick([1, 2, 3, 7, 20]),
            maxDepth: pick([1, 2, 4]),
            textBudget: budget,
            includeBbox: pick([false, true]),
            attributeAllowlist: pick([[], ['id'], ['id', 'role', 'type']]),
          },
        };
      case 1:
        return { method: 'page.get_text', params: { textBudget: budget } };
      case 2:
        return {
          method: 'dom.find_by_role',
          params: {
            role: pick(['link', 'button', 'textbox', 'heading']),
            selector,
            maxResults: pick([1, 2, 5]),
            includeHidden: pick([false, true]),
          },
        };
      default:
        return {
          method: 'dom.get_text',
          params: { target: { selector: 'body' }, textBudget: budget },
        };
    }
  });
}

function verify(spec: FuzzCase, value: unknown): void {
  const result = record(value);
  if (spec.method === 'page.get_text' || spec.method === 'dom.get_text') {
    assert.equal(typeof result.value, 'string');
    const text = String(result.value);
    const budget = Number(spec.params.textBudget);
    assert(text.length <= (spec.method === 'page.get_text' ? Math.max(100, budget) : budget));
    assert.equal(typeof result.truncated, 'boolean');
    assert(Number.isSafeInteger(result.omitted) && Number(result.omitted) >= 0);
    return;
  }
  assert(Array.isArray(result.nodes));
  if (spec.method === 'dom.query') {
    assert(result.nodes.length <= Number(spec.params.maxNodes));
    let length = 0;
    for (const value of result.nodes) {
      const node = record(value);
      length += String(node.textExcerpt).length;
      assert.equal('bbox' in node, spec.params.includeBbox);
      const allowlist = spec.params.attributeAllowlist as string[];
      assert(Object.keys(record(node.attrs)).every((key) => allowlist.includes(key)));
    }
    assert(length <= Math.max(32, Number(spec.params.textBudget)));
  } else {
    assert(result.nodes.length <= Number(spec.params.maxResults));
    assert.equal(result.count, result.nodes.length);
    assert.equal(result.found, result.nodes.length > 0);
  }
}

function verifyEvidence(spec: FuzzCase, value: unknown, mcp = false): void {
  if (spec.method === 'dom.query' && Array.isArray(value)) {
    assert(value.length <= Number(spec.params.maxNodes));
    for (const node of value) assert.equal(typeof record(node).ref, 'string');
    return;
  }
  const evidence = record(value);
  if (spec.method === 'page.get_text' || spec.method === 'dom.get_text') {
    assert.equal(typeof evidence.text, 'string');
    const budget = Number(spec.params.textBudget);
    assert(
      String(evidence.text).length <=
        (!mcp && spec.method === 'page.get_text' ? Math.max(100, budget) : budget)
    );
    assert.equal(typeof evidence.truncated, 'boolean');
    return;
  }
  assert(Array.isArray(evidence.nodes));
  assert(
    evidence.nodes.length <=
      Number(spec.params[spec.method === 'dom.query' ? 'maxNodes' : 'maxResults'])
  );
}

test(
  'seeded read-only current-tab fuzz checks through CLI and MCP',
  { timeout: 120_000 },
  async (t) => {
    const extensionId = process.env.BBX_LIVE_EXTENSION_ID;
    const tabId = Number(process.env.BBX_LIVE_TAB_ID);
    assert(extensionId, 'Set BBX_LIVE_EXTENSION_ID to the selected connection ID.');
    assert(Number.isSafeInteger(tabId) && tabId > 0, 'Set BBX_LIVE_TAB_ID to the selected tab.');
    const target = { extensionId, tabId };
    const env = { ...process.env, BBX_REMOTE: '', BBX_AUTO_UPDATE: 'off' };
    const ready = await runCli({
      args: ['call', '--extension', extensionId, '--tab', String(tabId), 'page.get_state', '{}'],
      env,
    });
    assert.equal(
      ready.status,
      0,
      `Live target unavailable. Rediscover the connection before fuzzing: ${ready.stdout}`
    );
    const specs = cases();
    const rows: Array<{ mode: string; method: string; ms: number; bytes: number }> = [];
    async function runCase(name: string, run: () => Promise<void>): Promise<void> {
      let failed = false;
      await t.test(name, async () => {
        try {
          await run();
        } catch (error) {
          failed = true;
          throw error;
        }
      });
      assert.equal(
        failed,
        false,
        'Stopping fuzz checks after the first failure. Inspect before retrying.'
      );
    }
    for (const [index, spec] of specs.entries()) {
      await runCase(`CLI fuzz ${index} ${spec.method}`, async () => {
        const start = performance.now();
        const result = await runCli({
          args: [
            'call',
            '--extension',
            extensionId,
            '--tab',
            String(tabId),
            spec.method,
            JSON.stringify(spec.params),
          ],
          env,
        });
        assert.equal(result.status, 0, result.stdout);
        verify(spec, result.json);
        rows.push({
          mode: 'cli',
          method: spec.method,
          ms: performance.now() - start,
          bytes: Buffer.byteLength(result.stdout),
        });
      });
    }
    for (let offset = 0; offset < specs.length; offset += 20) {
      const chunk = specs.slice(offset, offset + 20);
      for (const evidenceOnly of [false, true]) {
        await runCase(`CLI fuzz batch ${offset} evidenceOnly=${evidenceOnly}`, async () => {
          const start = performance.now();
          const result = await runCli({
            args: [
              'batch',
              ...(evidenceOnly ? ['--evidence-only'] : []),
              JSON.stringify(chunk.map((spec) => ({ ...spec, ...target }))),
            ],
            env,
          });
          assert.equal(result.status, 0, result.stdout);
          assert(Array.isArray(result.json));
          assert.equal(result.json.length, chunk.length);
          for (const [index, value] of result.json.entries()) {
            const item = record(value);
            assert.equal(item.ok, true);
            if (item.response !== undefined) verify(chunk[index], item.response);
            else verifyEvidence(chunk[index], item.evidence);
            if (evidenceOnly) assert.equal('response' in item, false);
          }
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
        { name: 'live-read-only-fuzz', version: '1.0.0' },
        modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}
      );
      try {
        await client.connect(transport);
        for (const [index, spec] of specs.entries()) {
          await runCase(`MCP modern=${modern} fuzz ${index} ${spec.method}`, async () => {
            const start = performance.now();
            const result = await client.callTool(
              { name: 'browser_call', arguments: { ...spec, ...target } },
              { timeout: 20_000 }
            );
            assert.notEqual(result.isError, true, JSON.stringify(result.content));
            const structured = record(result.structuredContent);
            assert.equal(structured.ok, true);
            verifyEvidence(spec, structured.evidence, true);
            rows.push({
              mode: modern ? 'mcp-modern' : 'mcp-legacy',
              method: spec.method,
              ms: performance.now() - start,
              bytes: Buffer.byteLength(JSON.stringify(result)),
            });
          });
        }
      } finally {
        await client.close();
      }
    }
    const output = path.join(repoRoot, 'dist', 'inspection-live');
    await mkdir(output, { recursive: true });
    await writeFile(
      path.join(output, 'fuzz-metrics.json'),
      JSON.stringify({ seed: '0xbbf022', rows }, null, 2) + '\n'
    );
  }
);
