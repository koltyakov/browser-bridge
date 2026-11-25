// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVersion } from './version.mjs';
import { generateGzip } from './generated-gzip.mjs';
import { OPERATION_TIMEOUT_POLICIES } from '../protocol/src/operation-timeouts.ts';
import {
  BRIDGE_METHODS,
  BRIDGE_METHOD_REGISTRY,
  createRuntimeContext,
  deriveProtocolVersion,
  describeBridgeMethods,
  isBatchSafeBridgeCall,
  applyMethodBudgetPreset,
  ERROR_RECOVERY,
  BUDGET_PRESETS,
} from '../protocol/src/index.ts';

/** @typedef {import('../protocol/mcp-metadata.js').McpMetadata} McpMetadata */
/** @typedef {{ inputSchema: {type: string, properties: Record<string, unknown>, required: readonly unknown[], additionalProperties: boolean}, example?: Record<string, unknown>, signature: string, invocation: {tool: string, method: string} }} MethodInput */

/** Inline only the wire types needed for one method, with no dangling references.
 * @param {unknown} value
 * @param {Record<string, unknown>} definitions
 * @param {string[]} [parents]
 * @returns {unknown}
 */
function inlineSchema(value, definitions, parents = []) {
  if (Array.isArray(value)) return value.map((item) => inlineSchema(item, definitions, parents));
  if (value === null || typeof value !== 'object') return value;
  const schema = record(value, 'wire schema');
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/$defs/', '');
    assert(Object.hasOwn(definitions, name), `Missing wire schema: ${name}`);
    assert(!parents.includes(name), `Recursive discovery schema: ${name}`);
    return inlineSchema(definitions[name], definitions, [...parents, name]);
  }
  return Object.fromEntries(
    Object.entries(schema).map(([key, child]) => [key, inlineSchema(child, definitions, parents)])
  );
}

/** Generate on-demand details separately so group indexes stay compact.
 * @param {Record<string, unknown>} definitions
 * @returns {Record<string, MethodInput>}
 */
export function createMethodInputs(definitions) {
  const bindings = record(
    record(definitions.BridgeMethodParams, 'BridgeMethodParams').properties,
    'BridgeMethodParams.properties'
  );
  assert.deepEqual(
    Object.keys(bindings).sort(),
    [...BRIDGE_METHODS].sort(),
    'RPC type bindings must cover exactly the registry'
  );
  return Object.fromEntries(
    BRIDGE_METHODS.map((method) => {
      const entry = BRIDGE_METHOD_REGISTRY[method];
      const detail = entry.discovery;
      const { schema, branches } = mergeUnionBinding(
        record(inlineSchema(bindings[method], definitions), method),
        method
      );
      const properties = record(schema.properties, `${method}.properties`);
      if (detail) {
        assert(
          Object.hasOwn(definitions, detail.paramsType),
          `Missing input type: ${detail.paramsType}`
        );
        const declared = record(
          inlineSchema(definitions[detail.paramsType], definitions),
          detail.paramsType
        );
        const declaredProperties = record(declared.properties, `${detail.paramsType}.properties`);
        for (const key of entry.params)
          assert.deepEqual(
            properties[key],
            declaredProperties[key],
            `${method}: canonical binding differs from ${detail.paramsType}.${key}`
          );
      }
      const selected = Object.fromEntries(
        entry.params.map((key) => {
          assert(
            Object.hasOwn(properties, key),
            `${method}: ${key} missing from canonical RPC input binding`
          );
          return [key, properties[key]];
        })
      );
      const inputSchema = {
        type: 'object',
        properties: selected,
        required:
          detail?.required ??
          (Array.isArray(schema.required)
            ? schema.required.filter((key) => entry.params.includes(String(key)))
            : []),
        additionalProperties: false,
        // A discriminated union keeps each variant's exact locator fields.
        ...(branches
          ? {
              anyOf: branches.map((branch) => {
                const branchProperties = record(branch.properties, `${method}.anyOf.properties`);
                return {
                  type: 'object',
                  properties: Object.fromEntries(
                    entry.params
                      .filter((key) => Object.hasOwn(branchProperties, key))
                      .map((key) => [key, branchProperties[key]])
                  ),
                  required: (Array.isArray(branch.required) ? branch.required : []).filter((key) =>
                    entry.params.includes(String(key))
                  ),
                  additionalProperties: false,
                };
              }),
            }
          : {}),
      };
      validateSchema(inputSchema, method);
      return [
        method,
        {
          inputSchema,
          ...(detail ? { example: detail.example } : {}),
          signature: `call(method: ${JSON.stringify(method)}, params: ${schemaSignature(inputSchema)}): Promise<BridgeResponse>`,
          invocation: { tool: 'browser_call', method },
        },
      ];
    })
  );
}

/** Flatten a union of object bindings into one object whose properties are the
 * union of every variant's properties and whose required keys are common to all
 * variants. The variants are returned so the input schema can keep them.
 * @param {Record<string, unknown>} schema
 * @param {string} method
 * @returns {{schema: Record<string, unknown>, branches: Record<string, unknown>[] | null}}
 */
function mergeUnionBinding(schema, method) {
  if (!Array.isArray(schema.anyOf)) return { schema, branches: null };
  const branches = schema.anyOf.map((branch, index) => record(branch, `${method}.anyOf[${index}]`));
  /** @type {Record<string, Record<string, unknown>>} */
  const properties = {};
  for (const branch of branches) {
    assert.equal(branch.type, 'object', `${method}: union bindings must be objects`);
    for (const [key, child] of Object.entries(record(branch.properties, `${method}.properties`))) {
      const next = record(child, `${method}.${key}`);
      const existing = properties[key];
      if (!existing) {
        properties[key] = next;
      } else if (JSON.stringify(existing) !== JSON.stringify(next)) {
        if (
          Array.isArray(existing.enum) &&
          Array.isArray(next.enum) &&
          existing.type === next.type
        ) {
          properties[key] = { ...existing, enum: [...new Set([...existing.enum, ...next.enum])] };
        } else {
          // Variants type the same locator differently (a storage key is a
          // string, an IndexedDB key is any IndexedDbKey): accept either.
          const variants = Array.isArray(existing.anyOf) ? existing.anyOf : [existing];
          const nextVariants = Array.isArray(next.anyOf) ? next.anyOf : [next];
          const merged = [...variants];
          for (const variant of nextVariants)
            if (!merged.some((known) => JSON.stringify(known) === JSON.stringify(variant)))
              merged.push(variant);
          properties[key] = { anyOf: merged };
        }
      }
    }
  }
  const required = Object.keys(properties).filter((key) =>
    branches.every((branch) => Array.isArray(branch.required) && branch.required.includes(key))
  );
  return {
    schema: { type: 'object', properties, required, additionalProperties: true },
    branches,
  };
}

/** Render a JSON-compatible TypeScript RPC signature, not a host tool path.
 * @param {unknown} value
 * @returns {string}
 */
export function schemaSignature(value) {
  const schema = record(value, 'signature');
  if (Array.isArray(schema.enum))
    return schema.enum.map((item) => JSON.stringify(item)).join(' | ');
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map(schemaSignature).join(' | ');
  if (schema.type === 'array') return `Array<${schemaSignature(schema.items)}>`;
  if (schema.type === 'object') {
    const required = Array.isArray(schema.required) ? schema.required : [];
    const properties = schema.properties ? record(schema.properties, 'signature.properties') : {};
    const fields = Object.entries(properties).map(
      ([key, child]) =>
        `${JSON.stringify(key)}${required.includes(key) ? '' : '?'}: ${schemaSignature(child)}`
    );
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
      fields.push(`[key: string]: ${schemaSignature(schema.additionalProperties)}`);
    else if (schema.additionalProperties === true) fields.push('[key: string]: unknown');
    return `{ ${fields.join('; ')} }`;
  }
  return typeof schema.type === 'string'
    ? schema.type === 'integer'
      ? 'number'
      : schema.type
    : 'unknown';
}

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
 * @param {Record<string, unknown>} definitions Generated from canonical protocol/types.ts.
 * @returns {Record<string, unknown>}
 */
export function createCatalog(version, metadata, definitions) {
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
    mutationMethods: BRIDGE_METHODS.filter(
      (method) => BRIDGE_METHOD_REGISTRY[method].exclusive && !isBatchSafeBridgeCall(method)
    ),
    methodInputs: createMethodInputs(definitions),
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
  const wire = record(
    JSON.parse(await fs.readFile(path.join(root, 'protocol/generated/bridge.schema.json'), 'utf8')),
    'wire schema'
  );
  const catalog = createCatalog(version, metadata, record(wire.$defs, 'wire definitions'));
  const filename = path.join(root, 'internal/bridge/generated/catalog.json');
  const content = `${JSON.stringify(catalog)}\n`;
  if (check) {
    if ((await fs.readFile(filename, 'utf8').catch(() => '')) !== content)
      throw new Error('Generated native catalog is stale. Run make generate-protocol.');
  } else {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, content);
  }
  await generateGzip(`${filename}.gz`, Buffer.from(content), check);
}
