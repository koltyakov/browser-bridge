import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createCatalog,
  generateCatalog,
  validateMcpMetadata,
} from '../../scripts/generate-catalog.mjs';
import { BRIDGE_METHODS, normalizeRequestParams } from '../src/index.js';
import type { McpMetadata } from '../mcp-metadata.js';

const root = new URL('../../', import.meta.url);
const wire = JSON.parse(
  await fs.readFile(new URL('protocol/generated/bridge.schema.json', root), 'utf8')
) as { $defs: Record<string, unknown> };

async function metadata(): Promise<McpMetadata> {
  const value: unknown = JSON.parse(
    await fs.readFile(new URL('protocol/mcp-tools.json', root), 'utf8')
  );
  validateMcpMetadata(value);
  return value;
}

test('on-demand discovery schemas inline wire types and examples normalize successfully', async () => {
  const source = await metadata();
  const catalog = createCatalog('2.0.0', source, wire.$defs) as {
    methodInputs: Record<
      string,
      { inputSchema: { properties: Record<string, unknown> }; example: Record<string, unknown> }
    >;
  };
  assert.ok(Object.keys(catalog.methodInputs).length >= 20);
  for (const method of BRIDGE_METHODS) {
    const detail = catalog.methodInputs[method];
    if (!detail) continue;
    assert.doesNotThrow(() => normalizeRequestParams(method, detail.example), method);
    assert.ok(!JSON.stringify(detail.inputSchema).includes('"$ref"'), method);
    assert.ok(JSON.stringify(detail).length < 8000, `${method} details are too large`);
  }
  const properties = catalog.methodInputs['input.click'].inputSchema.properties;
  assert.ok(properties.timeoutMs);
  assert.ok(properties.observe);
  assert.ok(!properties.value, 'click schema includes unrelated fill fields');
  assert.throws(() => createCatalog('2.0.0', source, {}), /Missing input type/);
});

test('mutation scheduling excludes read-only methods and file transfer bookkeeping', async () => {
  const catalog = createCatalog('2.0.0', await metadata(), wire.$defs) as {
    mutationMethods: string[];
  };
  for (const method of [
    'input.click',
    'input.perform',
    'input.set_files',
    'navigation.navigate',
    'patch.apply_styles',
  ]) {
    assert.ok(catalog.mutationMethods.includes(method), method);
  }
  for (const method of [
    'page.get_state',
    'patch.list',
    'network.intercept.list',
    'files.stage',
    'files.release',
    'page.handle_dialog',
  ]) {
    assert.ok(!catalog.mutationMethods.includes(method), method);
  }
});

test('canonical MCP metadata reproduces every catalog field and its serialization', async () => {
  const source = await metadata();
  const generated = await fs.readFile(
    new URL('internal/bridge/generated/catalog.json', root),
    'utf8'
  );
  const catalog = JSON.parse(generated) as { version: string };
  // The authoritative version may change before regeneration; no other byte may drift.
  assert.equal(
    `${JSON.stringify(createCatalog(catalog.version, source, wire.$defs))}\n`,
    generated
  );
});

test('generation is independent of existing output and checks every stale field', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-catalog-'));
  try {
    const source = await metadata();
    await fs.mkdir(path.join(directory, 'protocol'));
    await fs.mkdir(path.join(directory, 'protocol/generated'));
    await fs.writeFile(
      path.join(directory, 'protocol/generated/bridge.schema.json'),
      JSON.stringify(wire)
    );
    await fs.writeFile(path.join(directory, 'protocol/mcp-tools.json'), JSON.stringify(source));
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version: '2.0.0' }));
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    await generateCatalog(false, directory, {});
    await generateCatalog(true, directory, {});
    const filename = path.join(directory, 'internal/bridge/generated/catalog.json');
    const catalog = createCatalog('2.0.0', source, wire.$defs);
    assert.equal(await fs.readFile(filename, 'utf8'), `${JSON.stringify(catalog)}\n`);
    for (const key of Object.keys(catalog)) {
      await fs.writeFile(filename, `${JSON.stringify({ ...catalog, [key]: null })}\n`);
      await assert.rejects(generateCatalog(true, directory, {}), /catalog is stale/);
    }
    await fs.rm(filename);
    await assert.rejects(generateCatalog(true, directory, {}), /catalog is stale/);
    await generateCatalog(false, directory, { GITHUB_REF: 'refs/tags/v3.4.5' });
    assert.equal(
      await fs.readFile(filename, 'utf8'),
      `${JSON.stringify(createCatalog('3.4.5', source, wire.$defs))}\n`
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('metadata rejects incomplete schemas, unsupported constraints, and dangling toolsets', async () => {
  const source = await metadata();
  const mutations: Array<(value: McpMetadata) => void> = [
    (value) => {
      value.allTools.push(value.allTools[0]);
    },
    (value) => {
      value.modernTools.push('browser_missing');
    },
    (value) => {
      value.loadableTools.pop();
    },
    (value) => {
      value.instructions = '';
    },
    (value) => {
      value.toolBindings.browser_health = 'missing.method';
    },
    (value) => {
      value.allTools[0].inputSchema.required = ['missing'];
    },
    (value) => {
      value.allTools[0].inputSchema.additionalProperties = true;
    },
    (value) => {
      Object.assign(value.allTools[0].inputSchema, { unevaluatedProperties: false });
    },
    (value) => {
      Object.assign(value, { runtime: {} });
    },
    (value) => {
      value.allTools[0].inputSchema.properties = { incomplete: { type: 'array' } };
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(source);
    mutate(changed);
    assert.throws(() => validateMcpMetadata(changed));
  }
});

test('tool action schemas and forwarded fields match the Go handler dispatch', async () => {
  const source = await metadata();
  const handlers = await fs.readFile(new URL('internal/bridge/mcp_handlers.go', root), 'utf8');
  const server = await fs.readFile(new URL('internal/bridge/mcp.go', root), 'utf8');
  const table = handlers.match(
    /var mcpActions = map\[string\]map\[string\]string\{([\s\S]*?)\n\}/
  )?.[1];
  assert(table, 'Go MCP action dispatch table is missing');
  const dispatched = new Set<string>();
  for (const [, name, body] of table.matchAll(/"(browser_\w+)":\s*\{([^}]+)\}/g)) {
    dispatched.add(name);
    const tool = source.allTools.find((entry) => entry.name === name);
    assert(tool, `${name} has a Go handler but no schema`);
    const actions = [...body.matchAll(/"(\w+)":\s*"([^"|]+)\|([^"']*)"/g)];
    assert(actions.length > 0, `${name} has no action mappings`);
    assert.deepEqual(
      [...(tool.inputSchema.properties?.action.enum ?? [])].sort(),
      actions.map(([, action]) => action).sort(),
      `${name} action schema differs from Go dispatch`
    );
    for (const [, action, method, fields] of actions) {
      assert(
        BRIDGE_METHODS.some((entry) => entry === method.replace(/!$/, '')),
        `${name}.${action} dispatches an unknown method`
      );
      for (const field of fields.split(/\s+/).filter(Boolean)) {
        assert(
          Object.hasOwn(tool.inputSchema.properties ?? {}, field.split(':')[0]),
          `${name}.${action} forwards ${field} without an input schema`
        );
      }
    }
  }
  const dispatch = handlers.slice(
    handlers.indexOf('func (s *mcpSession) handleTool('),
    handlers.indexOf('func mcpValidateAction(')
  );
  for (const [, names] of dispatch.matchAll(/case ((?:"browser_\w+"(?:, )?)+):/g)) {
    for (const [name] of names.matchAll(/browser_\w+/g)) dispatched.add(name);
  }
  for (const [, name] of `${dispatch}\n${server}`.matchAll(/if name == "(browser_\w+)"/g))
    dispatched.add(name);
  assert.deepEqual(
    [...dispatched].sort(),
    source.allTools.map((tool) => tool.name).sort(),
    'Go tool dispatch and canonical metadata differ'
  );
  for (const [name, method] of Object.entries(source.toolBindings)) {
    const cases = [...dispatch.matchAll(/case ([^:]+):\s*method, params = "([^"]+)"/g)];
    assert(
      cases.some(([, names, target]) => names.includes(`"${name}"`) && target === method),
      `${name} binding differs from Go dispatch`
    );
  }
});
