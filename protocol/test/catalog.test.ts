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
import { BRIDGE_METHODS } from '../src/index.js';
import type { McpMetadata } from '../mcp-metadata.js';

const root = new URL('../../', import.meta.url);

async function metadata(): Promise<McpMetadata> {
  const value: unknown = JSON.parse(
    await fs.readFile(new URL('protocol/mcp-tools.json', root), 'utf8')
  );
  validateMcpMetadata(value);
  return value;
}

test('canonical MCP metadata reproduces every catalog field and its serialization', async () => {
  const source = await metadata();
  const generated = await fs.readFile(
    new URL('internal/bridge/generated/catalog.json', root),
    'utf8'
  );
  const catalog = JSON.parse(generated) as { version: string };
  // The authoritative version may change before regeneration; no other byte may drift.
  assert.equal(`${JSON.stringify(createCatalog(catalog.version, source))}\n`, generated);
});

test('generation is independent of existing output and checks every stale field', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-catalog-'));
  try {
    const source = await metadata();
    await fs.mkdir(path.join(directory, 'protocol'));
    await fs.writeFile(path.join(directory, 'protocol/mcp-tools.json'), JSON.stringify(source));
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version: '2.0.0' }));
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    await generateCatalog(false, directory, {});
    await generateCatalog(true, directory, {});
    const filename = path.join(directory, 'internal/bridge/generated/catalog.json');
    const catalog = createCatalog('2.0.0', source);
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
      `${JSON.stringify(createCatalog('3.4.5', source))}\n`
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
