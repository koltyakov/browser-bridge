import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  createBrowserBridge,
  type BrowserCallArguments,
  type BrowserCallOptions,
} from '../../internal/bridge/generated/code-mode/browser-bridge.mjs';
import { createCodeModeSources, generateCodeMode } from '../../scripts/generate-code-mode.mjs';
import { createMethodInputs, validateMcpMetadata } from '../../scripts/generate-catalog.mjs';
import { BRIDGE_METHODS, BRIDGE_METHOD_REGISTRY } from '../src/index.js';

const root = new URL('../../', import.meta.url);
const metadata: unknown = JSON.parse(
  await fs.readFile(new URL('protocol/mcp-tools.json', root), 'utf8')
);
validateMcpMetadata(metadata);
const wire = JSON.parse(
  await fs.readFile(new URL('protocol/generated/bridge.schema.json', root), 'utf8')
) as { $defs: Record<string, unknown> };
const inputs = createMethodInputs(wire.$defs);

type Binding = (params: Record<string, unknown>, options?: BrowserCallOptions) => Promise<unknown>;

function leaves(value: unknown, prefix = ''): Array<[string, Binding]> {
  assert(value && typeof value === 'object');
  assert(Object.isFrozen(value), `${prefix} bindings must be immutable`);
  return Object.entries(value).flatMap(([key, child]) => {
    const method = prefix ? `${prefix}.${key}` : key;
    return typeof child === 'function'
      ? [[method, child as Binding] as [string, Binding]]
      : leaves(child, method);
  });
}

test('every canonical method has one callable binding using the selected discovery inputs', async () => {
  const calls: BrowserCallArguments[] = [];
  const response = { isError: false, structuredContent: { ok: true, evidence: { count: 3 } } };
  const bridge = createBrowserBridge(
    async (args) => {
      calls.push(args);
      return response;
    },
    { extensionId: 'owned-profile', tabId: 23, budgetPreset: 'quick' }
  );
  const bindings = leaves(bridge);
  assert.deepEqual(bindings.map(([method]) => method).sort(), [...BRIDGE_METHODS].sort());
  assert.deepEqual(Object.keys(inputs).sort(), [...BRIDGE_METHODS].sort());
  for (const [method, binding] of bindings) {
    const params = { marker: method };
    assert.strictEqual(await binding(params), response);
    assert.deepEqual(calls.at(-1), {
      method,
      params,
      extensionId: 'owned-profile',
      tabId: 23,
      budgetPreset: 'quick',
    });
    assert.deepEqual(Object.keys(inputs[method].inputSchema.properties), [
      ...BRIDGE_METHOD_REGISTRY[method as keyof typeof BRIDGE_METHOD_REGISTRY].params,
    ]);
  }
  assert.equal(calls.length, BRIDGE_METHODS.length, 'No probes, retries, or implicit actions');
});

test('routing is snapshotted, overrides are explicit, and signal stays outside tool arguments', async () => {
  const defaults = { extensionId: 'profile-a', destinationId: 'local', tabId: 23 };
  const calls: Array<{ args: BrowserCallArguments; signal?: AbortSignal }> = [];
  const bridge = createBrowserBridge(async (args, options) => {
    calls.push({ args, signal: options?.signal });
    return args;
  }, defaults);
  defaults.extensionId = 'mutated';
  const abort = new AbortController();
  await bridge.dom.query(
    { selector: '#app', maxNodes: 5 },
    {
      extensionId: 'profile-b',
      destinationId: 'remote',
      tabId: 42,
      signal: abort.signal,
    }
  );
  assert.deepEqual(calls[0], {
    args: {
      method: 'dom.query',
      params: { selector: '#app', maxNodes: 5 },
      extensionId: 'profile-b',
      destinationId: 'remote',
      tabId: 42,
    },
    signal: abort.signal,
  });
  await bridge.page.get_state();
  assert.equal(calls[1].args.extensionId, 'profile-a');
  assert.equal(calls[1].args.tabId, 23);
  assert.deepEqual(calls[1].args.params, {});
  await bridge.page.get_state({}, { extensionId: undefined, tabId: undefined });
  assert.equal(
    calls[2].args.extensionId,
    'profile-a',
    'Undefined options must not unpin the default target'
  );
  assert.equal(calls[2].args.tabId, 23);
  const count = calls.length;
  abort.abort(new Error('Stopped before dispatch'));
  await assert.rejects(
    bridge.page.get_state({}, { signal: abort.signal }),
    /Stopped before dispatch/
  );
  await assert.rejects(
    bridge.page.get_state({}, { method: 'tabs.activate' } as BrowserCallOptions),
    /Unknown browser_call option/
  );
  assert.throws(
    () => createBrowserBridge(async () => null, { meta: { grant: true } } as BrowserCallOptions),
    /Unknown browser_call option/
  );
  assert.equal(calls.length, count, 'Aborted/invalid options never reach the host');
});

test('host denials, partial progress, and transport failures are never rewritten or replayed', async () => {
  const denial = {
    isError: true,
    structuredContent: {
      ok: false,
      error: { code: 'ACCESS_DENIED', details: { dispatched: false } },
      recovery: { retry: true, retryAfterMs: 0 },
    },
  };
  let calls = 0;
  const bridge = createBrowserBridge(async () => {
    calls++;
    return denial;
  });
  assert.strictEqual(await bridge.input.click({ target: { selector: '#save' } }), denial);
  const partial = { isError: true, structuredContent: { error: { details: { completed: 1 } } } };
  const sequence = createBrowserBridge(async () => {
    calls++;
    return partial;
  });
  assert.strictEqual(await sequence.input.perform({ steps: [] }), partial);
  const failure = new Error('Connection lost after dispatch');
  const disconnected = createBrowserBridge(async () => {
    calls++;
    throw failure;
  });
  await assert.rejects(
    disconnected.input.click({ target: { selector: '#save' } }),
    (err) => err === failure
  );
  assert.equal(calls, 3);
});

test('generated artifacts are standalone, deterministic, and checked for drift or deletion', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-code-mode-'));
  try {
    await fs.mkdir(path.join(directory, 'protocol/generated'), { recursive: true });
    await fs.writeFile(
      path.join(directory, 'protocol/generated/bridge.schema.json'),
      JSON.stringify(wire)
    );
    await fs.writeFile(path.join(directory, 'protocol/mcp-tools.json'), JSON.stringify(metadata));
    await generateCodeMode(false, directory);
    await generateCodeMode(true, directory);
    const sources = createCodeModeSources(inputs, metadata);
    for (const extension of ['ts', 'mjs', 'd.mts']) {
      const relative = `internal/bridge/generated/code-mode/browser-bridge.${extension}`;
      const filename = path.join(directory, relative);
      const original = await fs.readFile(filename, 'utf8');
      const compressedName = `${filename}.gz`;
      const compressed = await fs.readFile(compressedName);
      assert.equal(gunzipSync(compressed).toString(), original);
      assert(compressed.length < Buffer.byteLength(original));
      // Valid pre-existing compression bytes are retained across zlib versions.
      const alternate = gzipSync(original, { level: 1 });
      await fs.writeFile(compressedName, alternate);
      await generateCodeMode(false, directory);
      assert.deepEqual(await fs.readFile(compressedName), alternate);
      for (const broken of [Buffer.from('not gzip'), gzipSync('stale adapter')]) {
        await fs.writeFile(compressedName, broken);
        await assert.rejects(generateCodeMode(true, directory), /Compressed asset is stale/);
        await generateCodeMode(false, directory);
        assert.equal(gunzipSync(await fs.readFile(compressedName)).toString(), original);
      }
      await fs.rm(compressedName);
      await assert.rejects(generateCodeMode(true, directory), /Compressed asset is stale/);
      await generateCodeMode(false, directory);
      assert.equal(original, await fs.readFile(new URL(relative, root), 'utf8'));
      if (extension === 'ts') assert.equal(original, sources.typescript);
      if (extension === 'd.mts') assert.equal(original, sources.declarations);
      if (extension === 'mjs') {
        assert.doesNotMatch(
          original,
          /\bimport\s|\brequire\(|\beval\(|new Function|\bfetch\(|chrome\./
        );
      }
      await fs.writeFile(filename, original + '// drift\n');
      await assert.rejects(generateCodeMode(true, directory), /adapter is stale/);
      await fs.rm(filename);
      await assert.rejects(generateCodeMode(true, directory), /adapter is stale/);
      await generateCodeMode(false, directory);
    }
    const incomplete = structuredClone(metadata);
    incomplete.allTools = incomplete.allTools.filter((tool) => tool.name !== 'browser_call');
    assert.throws(() => createCodeModeSources(inputs, incomplete), /canonical browser_call/);
    assert.throws(
      () =>
        createCodeModeSources(
          { page: inputs['page.get_state'], 'page.get_state': inputs['page.get_state'] },
          metadata
        ),
      /collision/
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
