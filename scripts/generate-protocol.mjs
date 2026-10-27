// @ts-check
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse } from '@babel/parser';
import { BRIDGE_METHODS, ERROR_CODES } from '../protocol/src/index.ts';
import { generateCatalog } from './generate-catalog.mjs';
import { generateSkills } from './generate-skills.mjs';
import * as defaults from '../protocol/src/defaults.ts';
import { generateInstallTargets } from './generate-install-targets.mjs';

/** @typedef {{type: string, [key: string]: unknown}} Node */
/** @typedef {{ $ref?: string, type?: string, enum?: unknown[], properties?: Record<string, Schema>, required?: string[], additionalProperties?: boolean | Schema, items?: Schema, anyOf?: Schema[] }} Schema */
/** @typedef {Map<string, Schema>} Bindings */
const root = fileURLToPath(new URL('../', import.meta.url));
const source = await fs.readFile(path.join(root, 'protocol/types.ts'), 'utf8');
const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
/** @type {Map<string, Node>} */
const declarations = new Map();
/** @type {Record<string, Schema>} */
const definitions = {};
// These are browser-local objects containing DOM references, callbacks, or
// AbortControllers. They cannot cross JSON/native messaging in either runtime.
const browserLocal = new Set(['WebMcpDescriptor', 'WebMcpContext', 'WebMcpDocumentState']);

/** @param {unknown} value @returns {Node} */
function node(value) {
  if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string')
    throw new Error('Expected a TypeScript syntax node');
  return /** @type {Node} */ (value);
}
/** @param {unknown} value @returns {Node[]} */
function nodes(value) {
  if (!Array.isArray(value)) throw new Error('Expected syntax node array');
  return value.map(node);
}
/** @param {Node} value @returns {string} */
function name(value) {
  const result = value.name ?? value.value;
  if (typeof result !== 'string') throw new Error(`Expected identifier: ${value.type}`);
  return result;
}
for (const item of ast.program.body) {
  const statement = node(item);
  if (!statement.declaration) continue;
  const declaration = node(statement.declaration);
  declarations.set(name(node(declaration.id)), declaration);
}

/** @param {Schema} schema @returns {Schema} */
function resolve(schema) {
  return schema.$ref ? definition(schema.$ref.split('/').at(-1) ?? '') : schema;
}
/** @param {string} id @returns {Schema} */
function definition(id) {
  if (definitions[id]) return definitions[id];
  if (browserLocal.has(id)) throw new Error(`Browser-local type referenced by wire type: ${id}`);
  const declaration = declarations.get(id);
  if (!declaration) throw new Error(`Unknown protocol type: ${id}`);
  definitions[id] = {};
  try {
    definitions[id] = declarationSchema(declaration, new Map());
    return definitions[id];
  } catch (error) {
    throw new Error(`${id}: ${error instanceof Error ? error.message : error}`);
  }
}
/** @param {Node} declaration @param {Bindings} bindings @returns {Schema} */
function declarationSchema(declaration, bindings) {
  const context = new Map(bindings);
  if (declaration.typeParameters) {
    for (const parameter of nodes(node(declaration.typeParameters).params)) {
      const key = typeof parameter.name === 'string' ? parameter.name : name(node(parameter.name));
      if (!context.has(key))
        context.set(key, schema(node(parameter.default ?? parameter.constraint), context));
    }
  }
  if (declaration.type === 'TSTypeAliasDeclaration')
    return schema(node(declaration.typeAnnotation), context);
  if (declaration.type !== 'TSInterfaceDeclaration')
    throw new Error(`Unsupported declaration: ${declaration.type}`);
  const parts = declaration.extends
    ? nodes(declaration.extends).map((base) => reference(base, context))
    : [];
  parts.push(objectSchema(nodes(node(declaration.body).body), context));
  return intersection(parts);
}
/** @param {Schema[]} parts @returns {Schema} */
function intersection(parts) {
  const schemas = parts.map(resolve);
  if (schemas.some((part) => part.anyOf)) {
    let combinations = /** @type {Schema[][]} */ ([[]]);
    for (const part of schemas)
      combinations = combinations.flatMap((items) =>
        (part.anyOf ?? [part]).map((branch) => [...items, branch])
      );
    return { anyOf: combinations.map(intersection) };
  }
  /** @type {Schema} */
  const result = { type: 'object', properties: {}, required: [], additionalProperties: true };
  for (const part of schemas) {
    if (part.type !== 'object') throw new Error('Only object intersections can cross the wire');
    Object.assign(result.properties ?? {}, part.properties);
    result.required = [...new Set([...(result.required ?? []), ...(part.required ?? [])])];
  }
  return result;
}
/** @param {Node[]} members @param {Bindings} context @returns {Schema} */
function objectSchema(members, context) {
  /** @type {Record<string, Schema>} */
  const properties = {};
  const required = [];
  /** @type {boolean | Schema} */
  let additionalProperties = true;
  for (const member of members) {
    if (member.type === 'TSIndexSignature') {
      additionalProperties = schema(node(node(member.typeAnnotation).typeAnnotation), context);
      continue;
    }
    if (member.type !== 'TSPropertySignature')
      throw new Error(`Non-serializable member: ${member.type}`);
    const key = name(node(member.key));
    properties[key] = schema(node(node(member.typeAnnotation).typeAnnotation), context);
    if (!member.optional) required.push(key);
  }
  return { type: 'object', properties, required, additionalProperties };
}
/** @param {Node} value @param {Bindings} context @returns {Schema} */
function reference(value, context) {
  const id = name(node(value.typeName ?? value.expression));
  const argumentsNode = value.typeArguments ?? value.typeParameters;
  const args = argumentsNode ? nodes(node(argumentsNode).params) : [];
  if (context.has(id)) return /** @type {Schema} */ (context.get(id));
  if (id === 'Array') return { type: 'array', items: schema(args[0], context) };
  if (id === 'Record') {
    const keys = resolve(schema(args[0], context)).enum;
    const property = schema(args[1], context);
    if (keys && keys.every((key) => typeof key === 'string')) {
      return {
        type: 'object',
        properties: Object.fromEntries(keys.map((key) => [String(key), property])),
        required: keys.map(String),
        additionalProperties: true,
      };
    }
    return { type: 'object', additionalProperties: property };
  }
  if (id === 'Pick' || id === 'Required') {
    const original = structuredClone(resolve(schema(args[0], context)));
    if (!original.properties) throw new Error(`${id} requires object properties`);
    if (id === 'Pick') {
      const keys = resolve(schema(args[1], context)).enum;
      if (!keys) throw new Error('Pick requires literal keys');
      original.properties = Object.fromEntries(
        Object.entries(original.properties).filter(([key]) => keys.includes(key))
      );
      original.required = original.required?.filter((key) => keys.includes(key));
    } else original.required = Object.keys(original.properties);
    return original;
  }
  if (args.length) {
    const declaration = declarations.get(id);
    if (!declaration?.typeParameters) throw new Error(`Unknown generic type: ${id}`);
    const bindings = new Map(context);
    const parameters = nodes(node(declaration.typeParameters).params);
    args.forEach((argument, index) => {
      const parameterName = parameters[index].name;
      bindings.set(
        typeof parameterName === 'string' ? parameterName : name(node(parameterName)),
        schema(argument, context)
      );
    });
    return declarationSchema(declaration, bindings);
  }
  definition(id);
  return { $ref: `#/$defs/${id}` };
}
/** @param {Node} value @param {Bindings} context @returns {Schema} */
function schema(value, context) {
  switch (value.type) {
    case 'TSStringKeyword':
      return { type: 'string' };
    case 'TSNumberKeyword':
      return { type: 'number' };
    case 'TSBooleanKeyword':
      return { type: 'boolean' };
    case 'TSNullKeyword':
      return { type: 'null' };
    case 'TSUnknownKeyword':
      return {};
    case 'TSTypeReference':
      return reference(value, context);
    case 'TSArrayType':
      return { type: 'array', items: schema(node(value.elementType), context) };
    case 'TSTypeLiteral':
      return objectSchema(nodes(value.members), context);
    case 'TSIntersectionType':
      return intersection(nodes(value.types).map((part) => schema(part, context)));
    case 'TSParenthesizedType':
      return schema(node(value.typeAnnotation), context);
    case 'TSLiteralType': {
      const literal = node(value.literal).value;
      if (!['string', 'number', 'boolean'].includes(typeof literal))
        throw new Error('Unsupported literal');
      return { type: typeof literal, enum: [literal] };
    }
    case 'TSUnionType': {
      const options = nodes(value.types).map((part) => schema(part, context));
      if (options.every((part) => part.enum && part.type === options[0].type))
        return { type: options[0].type, enum: options.flatMap((part) => part.enum ?? []) };
      return { anyOf: options };
    }
    case 'TSIndexedAccessType': {
      const object = resolve(schema(node(value.objectType), context));
      const keys = resolve(schema(node(value.indexType), context)).enum;
      if (!keys || keys.length !== 1 || typeof keys[0] !== 'string')
        throw new Error('Unsupported indexed access');
      const key = keys[0];
      const properties = (object.anyOf ?? [object]).map((branch) => {
        const property = resolve(branch).properties?.[key];
        if (!property) throw new Error(`Unknown indexed property ${key}`);
        return property;
      });
      return properties.length === 1 ? properties[0] : { anyOf: properties };
    }
    case 'TSTemplateLiteralType': {
      const quasis = nodes(value.quasis).map((part) => {
        const content = /** @type {{ cooked: string }} */ (part.value);
        return content.cooked;
      });
      let strings = [quasis[0]];
      nodes(value.types).forEach((part, index) => {
        const choices = resolve(schema(part, context)).enum;
        if (!choices) throw new Error('Template literals must have finite wire values');
        strings = strings.flatMap((prefix) =>
          choices.map((choice) => `${prefix}${choice}${quasis[index + 1]}`)
        );
      });
      return { type: 'string', enum: strings };
    }
    default:
      throw new Error(`Unsupported protocol syntax: ${value.type}`);
  }
}
for (const id of declarations.keys()) if (!browserLocal.has(id)) definition(id);
for (const [id, values] of [
  ['BridgeMethod', BRIDGE_METHODS],
  ['ErrorCode', Object.values(ERROR_CODES)],
]) {
  const declared = definitions[String(id)].enum ?? [];
  if (JSON.stringify([...declared].sort()) !== JSON.stringify([...values].sort()))
    throw new Error(`${id} declarations disagree with the runtime registry`);
}

/** @param {string} text @returns {string} */
function goName(text) {
  const initials = new Map([
    ['Id', 'ID'],
    ['Url', 'URL'],
    ['Html', 'HTML'],
    ['Json', 'JSON'],
    ['Mcp', 'MCP'],
    ['Cdp', 'CDP'],
    ['Sha256', 'SHA256'],
  ]);
  return text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => {
      const capitalized = part[0].toUpperCase() + part.slice(1);
      return initials.get(capitalized) ?? capitalized;
    })
    .join('');
}
/** @type {Map<string, Schema>} */
const goDefinitions = new Map(Object.entries(definitions));
/** @param {Schema} shape @param {string} hint @returns {string} */
function goType(shape, hint) {
  if (shape.$ref) return shape.$ref.split('/').at(-1) ?? '';
  if (shape.anyOf) {
    const nonNull = shape.anyOf.filter((part) => part.type !== 'null');
    if (nonNull.length === 1 && nonNull.length !== shape.anyOf.length)
      return `Nullable[${goType(nonNull[0], hint)}]`;
    return 'json.RawMessage';
  }
  if (shape.type === 'string') return 'string';
  if (shape.type === 'number') return 'float64';
  if (shape.type === 'boolean') return 'bool';
  if (shape.type === 'array') return `[]${goType(shape.items ?? {}, `${hint}Item`)}`;
  if (shape.type === 'object') {
    if (!Object.keys(shape.properties ?? {}).length)
      return `map[string]${goType(typeof shape.additionalProperties === 'object' ? shape.additionalProperties : {}, `${hint}Value`)}`;
    if (!goDefinitions.has(hint)) goDefinitions.set(hint, shape);
    return hint;
  }
  return 'json.RawMessage';
}
const output = [
  '// Code generated by scripts/generate-protocol.mjs from protocol/types.ts. DO NOT EDIT.',
  'package protocol',
  'import "encoding/json"',
];
for (const [id, shape] of goDefinitions) {
  if (shape.type !== 'object' || !Object.keys(shape.properties ?? {}).length) {
    const type = goType(shape, `${id}Value`);
    output.push(
      `type ${id} ${shape.$ref || type === 'json.RawMessage' || type.startsWith('Nullable[') ? '= ' : ''}${type}`
    );
    if (shape.type === 'string' && shape.enum) {
      const names = new Set();
      output.push('const (');
      for (const item of shape.enum) {
        const constant = `${id}${goName(String(item))}`;
        if (names.has(constant)) throw new Error(`Go constant collision: ${constant}`);
        names.add(constant);
        output.push(`${constant} ${id} = ${JSON.stringify(item)}`);
      }
      output.push(
        ')',
        `func (v ${id}) Valid() bool { switch v { case ${[...names].join(', ')}: return true }; return false }`
      );
    }
    continue;
  }
  output.push(`type ${id} struct {`);
  const properties = Object.entries(shape.properties ?? {});
  const names = new Set(['Extra']);
  for (const [key, property] of properties) {
    const field = goName(key);
    if (names.has(field)) throw new Error(`Go field collision: ${id}.${field}`);
    names.add(field);
    const required = shape.required?.includes(key);
    const type = goType(property, `${id}${field}`);
    output.push(
      `${field} ${required ? type : `Optional[${type}]`} \`json:"${key}${required ? '' : ',omitzero'}"\``
    );
  }
  output.push('Extra map[string]json.RawMessage `json:"-"`', '}');
  output.push(
    `func (v ${id}) MarshalJSON() ([]byte, error) { type alias ${id}; return marshalOpen(alias(v), v.Extra, []string{${properties.map(([key]) => JSON.stringify(key)).join(', ')}}) }`
  );
  output.push(
    `func (v *${id}) UnmarshalJSON(data []byte) error { type alias ${id}; var decoded alias; extra, err := unmarshalOpen(data, &decoded, []string{${properties.map(([key]) => JSON.stringify(key)).join(', ')}}); if err != nil { return err }; decoded.Extra = extra; *v = ${id}(decoded); return nil }`
  );
}
const goSource = execFileSync('gofmt', [], { input: `${output.join('\n\n')}\n`, encoding: 'utf8' });
const document = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://browserbridge.dev/protocol/bridge.schema.json',
  $defs: definitions,
};
/** @param {Schema} shape @param {number} [depth] @returns {unknown} */
function example(shape, depth = 0) {
  if (depth > 25) throw new Error('Unbounded recursive wire schema needs an explicit fixture');
  if (shape.$ref) return example(resolve(shape), depth + 1);
  if (shape.enum) return shape.enum[0];
  if (shape.anyOf) return example(shape.anyOf[0], depth + 1);
  if (shape.type === 'string') return 'wire-✓';
  if (shape.type === 'number') return 1.25;
  if (shape.type === 'boolean') return false;
  if (shape.type === 'null') return null;
  if (shape.type === 'array') return [example(shape.items ?? {}, depth + 1)];
  if (shape.type === 'object') {
    const entries = Object.entries(shape.properties ?? {}).map(([key, property]) => [
      key,
      example(property, depth + 1),
    ]);
    if (shape.additionalProperties !== false)
      entries.push([
        'future_extension',
        example(
          typeof shape.additionalProperties === 'object' ? shape.additionalProperties : {},
          depth + 1
        ),
      ]);
    return Object.fromEntries(entries);
  }
  return { arbitrary: [null, false, 0, 'JSON'] };
}
const fixtures = Object.entries(definitions).map(([type, shape]) => ({
  type,
  valid: true,
  input: example(shape),
}));
const testFactories = `// Code generated by scripts/generate-protocol.mjs. DO NOT EDIT.\npackage protocol\nvar wireRoundTrips = map[string]func([]byte) ([]byte, error){\n${Object.keys(
  definitions
)
  .map((id) => `${JSON.stringify(id)}: roundTrip[${id}],`)
  .join('\n')}\n}\n`;
/** @param {string} filename @param {string} content @returns {Promise<void>} */
async function write(filename, content) {
  const destination = path.join(root, filename);
  if (process.argv.includes('--check')) {
    if ((await fs.readFile(destination, 'utf8').catch(() => '')) !== content)
      throw new Error(`Generated protocol file is stale: ${filename}. Run make generate-protocol.`);
  } else {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content);
  }
}
await write('internal/protocol/types.gen.go', goSource);
await write(
  'internal/protocol/limits.gen.go',
  execFileSync('gofmt', [], {
    input: `// Code generated from protocol/src/defaults.ts. DO NOT EDIT.\npackage protocol\n${Object.entries(
      defaults
    )
      .filter(([, value]) => typeof value === 'number')
      .map(
        ([key, value]) =>
          `const ${key
            .split('_')
            .map((part) =>
              ['JSON', 'MS', 'TTL', 'HTML', 'HAR', 'DOM', 'CDP', 'URL', 'UTF8', 'A11Y'].includes(
                part
              )
                ? part
                : part[0] + part.slice(1).toLowerCase()
            )
            .join('')} = ${value}`
      )
      .join('\n')}\n`,
    encoding: 'utf8',
  })
);
await write(
  'internal/protocol/types.gen_test.go',
  execFileSync('gofmt', [], { input: testFactories, encoding: 'utf8' })
);
await write('protocol/generated/bridge.schema.json', `${JSON.stringify(document, null, 2)}\n`);
await write('protocol/generated/roundtrip-fixtures.json', `${JSON.stringify(fixtures, null, 2)}\n`);
await generateCatalog(process.argv.includes('--check'));
await generateSkills(process.argv.includes('--check'));
await generateInstallTargets(process.argv.includes('--check'));
console.log(
  `Protocol: ${Object.keys(definitions).length} shared types; ${BRIDGE_METHODS.length} methods; Go bindings and JSON Schema ${process.argv.includes('--check') ? 'verified' : 'generated'}.`
);
