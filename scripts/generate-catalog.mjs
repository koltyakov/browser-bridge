// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVersion } from './version.mjs';
import { OPERATION_TIMEOUT_POLICIES } from '../protocol/src/operation-timeouts.js';
import {
  BRIDGE_METHODS,
  createRuntimeContext,
  deriveProtocolVersion,
  describeBridgeMethods,
  isBatchSafeBridgeCall,
  applyMethodBudgetPreset,
  ERROR_RECOVERY,
  BUDGET_PRESETS,
} from '../protocol/src/index.js';

/** @typedef {import('../protocol/mcp-metadata.js').McpMetadata} McpMetadata */

/** @param {unknown} value @param {string} location @returns {Record<string, unknown>} */
function record(value, location) {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${location}: expected an object`
  );
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} location @returns {string[]} */
function stringList(value, location) {
  assert(
    Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0),
    `${location}: expected a string array`
  );
  assert.equal(new Set(value).size, value.length, `${location}: duplicate entries`);
  return value;
}

/** Reject schema keywords the native validator would silently ignore.
 * @param {unknown} value
 * @param {string} location
 * @returns {void}
 */
function validateSchema(value, location) {
  const schema = record(value, location);
  const bounds = [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
  ];
  const allowed = new Set([
    '$schema',
    'type',
    'description',
    'properties',
    'required',
    'additionalProperties',
    'propertyNames',
    'items',
    'anyOf',
    'oneOf',
    'allOf',
    'enum',
    'const',
    'pattern',
    ...bounds,
  ]);
  for (const key of Object.keys(schema))
    assert(allowed.has(key), `${location}: unsupported schema keyword ${key}`);
  for (const key of ['$schema', 'description', 'pattern']) {
    if (key in schema)
      assert.equal(typeof schema[key], 'string', `${location}.${key}: expected a string`);
  }
  if ('type' in schema)
    assert(
      ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(
        String(schema.type)
      ),
      `${location}: invalid schema type`
    );
  for (const key of bounds) {
    if (key in schema)
      assert(
        typeof schema[key] === 'number' && Number.isFinite(schema[key]),
        `${location}.${key}: expected a finite bound`
      );
  }
  if ('enum' in schema)
    assert(
      Array.isArray(schema.enum) && schema.enum.length > 0,
      `${location}: empty or invalid enum`
    );
  if ('properties' in schema) {
    assert.equal(schema.type, 'object', `${location}: properties require object type`);
    for (const [key, child] of Object.entries(record(schema.properties, `${location}.properties`)))
      validateSchema(child, `${location}.${key}`);
  }
  if ('required' in schema) {
    const properties = record(schema.properties, `${location}.properties`);
    for (const key of stringList(schema.required, `${location}.required`))
      assert(Object.hasOwn(properties, key), `${location}: required property ${key} has no schema`);
  }
  if (schema.type === 'array')
    assert('items' in schema, `${location}: array items schema is missing`);
  for (const key of ['items', 'propertyNames', 'additionalProperties']) {
    if (key in schema && !(key === 'additionalProperties' && typeof schema[key] === 'boolean'))
      validateSchema(schema[key], `${location}.${key}`);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (!(key in schema)) continue;
    const branches = schema[key];
    assert(
      Array.isArray(branches) && branches.length > 0,
      `${location}.${key}: expected schema branches`
    );
    branches.forEach((branch, index) => validateSchema(branch, `${location}.${key}[${index}]`));
  }
}

/** Validate the editable source before producing runtime metadata.
 * @param {unknown} value
 * @returns {asserts value is McpMetadata}
 */
export function validateMcpMetadata(value) {
  const metadata = record(value, 'MCP metadata');
  assert.deepEqual(
    Object.keys(metadata).sort(),
    [
      '$comment',
      'allTools',
      'modernTools',
      'legacyTools',
      'loadableTools',
      'toolBindings',
      'instructions',
      'legacyInstructions',
    ].sort(),
    'MCP metadata: unexpected or missing source fields'
  );
  for (const key of ['$comment', 'instructions', 'legacyInstructions'])
    assert(
      typeof metadata[key] === 'string' && metadata[key].trim().length > 0,
      `MCP metadata: ${key} is missing`
    );
  assert(
    Array.isArray(metadata.allTools) && metadata.allTools.length > 0,
    'MCP metadata: no tools'
  );
  const tools = metadata.allTools.map((entry) => {
    const tool = record(entry, 'MCP tool');
    for (const key of Object.keys(tool))
      assert(
        ['name', 'title', 'description', 'annotations', '_meta', 'inputSchema'].includes(key),
        `MCP tool: unexpected field ${key}`
      );
    for (const key of ['name', 'title', 'description'])
      assert(
        typeof tool[key] === 'string' && tool[key].trim().length > 0,
        `MCP tool: ${key} is missing`
      );
    for (const key of ['annotations', '_meta'])
      if (key in tool) record(tool[key], `${tool.name}.${key}`);
    const schema = record(tool.inputSchema, `${tool.name}.inputSchema`);
    assert.equal(
      schema.$schema,
      'https://json-schema.org/draft/2020-12/schema',
      `${tool.name}: schema dialect is missing`
    );
    assert.equal(schema.type, 'object', `${tool.name}: input schema must be an object`);
    record(schema.properties, `${tool.name}.properties`);
    assert.equal(
      schema.additionalProperties,
      false,
      `${tool.name}: input schema must reject unknown arguments`
    );
    validateSchema(schema, String(tool.name));
    return tool;
  });
  const names = stringList(
    tools.map((tool) => tool.name),
    'MCP tool names'
  );
  for (const key of ['modernTools', 'legacyTools', 'loadableTools']) {
    const list = stringList(metadata[key], key);
    assert(list.length > 0, `${key}: empty toolset`);
    for (const name of list) assert(names.includes(name), `${key}: unknown tool ${name}`);
  }
  const legacy = stringList(metadata.legacyTools, 'legacyTools');
  const loadable = stringList(metadata.loadableTools, 'loadableTools');
  assert.deepEqual(
    [...legacy, ...loadable].sort(),
    [...names].sort(),
    'Legacy and loadable toolsets must partition all tools'
  );
  const toolset = record(
    tools.find((tool) => tool.name === 'browser_toolset')?.inputSchema,
    'browser_toolset'
  );
  const properties = record(toolset.properties, 'browser_toolset.properties');
  assert.deepEqual(
    record(properties.tool, 'browser_toolset.tool').enum,
    loadable,
    'browser_toolset choices must match loadableTools'
  );
  for (const [name, method] of Object.entries(record(metadata.toolBindings, 'toolBindings'))) {
    assert(names.includes(name), `toolBindings: unknown tool ${name}`);
    assert(
      typeof method === 'string' && BRIDGE_METHODS.some((known) => known === method),
      `toolBindings: unknown method ${String(method)}`
    );
  }
}

/** Build the catalog without loading runtime implementations or generated output.
 * @param {string} version
 * @param {unknown} metadata
 * @returns {Record<string, unknown>}
 */
export function createCatalog(version, metadata) {
  validateMcpMetadata(metadata);
  const methods = Object.fromEntries(
    BRIDGE_METHODS.map((method) => [method, describeBridgeMethods({ method })])
  );
  const presets = Object.fromEntries(
    Object.keys(BUDGET_PRESETS).map((preset) => [
      preset,
      Object.fromEntries(
        BRIDGE_METHODS.map((method) => [
          method,
          applyMethodBudgetPreset(method, {}, /** @type {'quick' | 'normal' | 'deep'} */ (preset)),
        ])
      ),
    ])
  );
  return {
    version,
    methods,
    operationTimeouts: OPERATION_TIMEOUT_POLICIES,
    runtime: { ...createRuntimeContext(), v: deriveProtocolVersion(version) },
    presets,
    errorRecovery: ERROR_RECOVERY,
    batchSafe: BRIDGE_METHODS.filter((method) => isBatchSafeBridgeCall(method)),
    tools: metadata.allTools.filter((tool) => metadata.modernTools.includes(tool.name)),
    allTools: metadata.allTools,
    legacyTools: metadata.legacyTools,
    loadableTools: metadata.loadableTools,
    toolBindings: metadata.toolBindings,
    toolGroups: {},
    instructions: metadata.instructions,
    legacyInstructions: metadata.legacyInstructions,
  };
}

/** Generate runtime metadata from canonical protocol and MCP metadata sources.
 * @param {boolean} check
 * @param {string} [root] Source/output root, overridable for isolated generator tests.
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<void>}
 */
export async function generateCatalog(
  check,
  root = fileURLToPath(new URL('../', import.meta.url)),
  env = process.env
) {
  const { version } = resolveVersion({ root, env });
  const metadata = /** @type {unknown} */ (
    JSON.parse(await fs.readFile(path.join(root, 'protocol/mcp-tools.json'), 'utf8'))
  );
  const catalog = createCatalog(version, metadata);
  const filename = path.join(root, 'internal/bridge/generated/catalog.json');
  const content = `${JSON.stringify(catalog)}\n`;
  if (check) {
    if ((await fs.readFile(filename, 'utf8').catch(() => '')) !== content)
      throw new Error('Generated native catalog is stale. Run make generate-protocol.');
  } else {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, content);
  }
}
