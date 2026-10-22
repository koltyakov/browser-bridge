import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  BRIDGE_METHODS,
  ERROR_CODES,
  createRequest,
  createSuccess,
  createFailure,
} from '../../protocol/src/index.js';

const schema = JSON.parse(
  await fs.readFile(new URL('../../protocol/generated/bridge.schema.json', import.meta.url), 'utf8')
) as { $id: string; $defs: Record<string, { enum?: string[] }> };
const ajv = new Ajv2020({ strict: false });
ajv.addSchema(schema);

test('canonical protocol schema validates cross-language fixtures', async () => {
  const fixtures = JSON.parse(
    await fs.readFile(new URL('../../protocol/fixtures/wire.json', import.meta.url), 'utf8')
  ) as { type: string; valid: boolean; input: unknown }[];
  for (const fixture of fixtures) {
    const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${fixture.type}` });
    assert.equal(
      validate(fixture.input),
      fixture.valid,
      `${fixture.type}: ${JSON.stringify(validate.errors)}`
    );
  }
});

test('every generated Go wire type has a schema-valid round-trip fixture', async () => {
  const fixtures = JSON.parse(
    await fs.readFile(
      new URL('../../protocol/generated/roundtrip-fixtures.json', import.meta.url),
      'utf8'
    )
  ) as { type: string; input: unknown }[];
  assert.deepEqual(
    fixtures.map((fixture) => fixture.type).sort(),
    Object.keys(schema.$defs).sort()
  );
  for (const fixture of fixtures) {
    const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${fixture.type}` });
    assert.equal(
      validate(fixture.input),
      true,
      `${fixture.type}: ${JSON.stringify(validate.errors)}`
    );
  }
});

test('Node wire factories and registries match generated protocol definitions', () => {
  assert.deepEqual([...(schema.$defs.BridgeMethod.enum ?? [])].sort(), [...BRIDGE_METHODS].sort());
  assert.deepEqual(
    [...(schema.$defs.ErrorCode.enum ?? [])].sort(),
    Object.values(ERROR_CODES).sort()
  );
  const examples = [
    ['BridgeRequest', createRequest({ id: 'fixture', method: 'health.ping' })],
    ['BridgeSuccessResponse', createSuccess('fixture', { nested: [false, null, 0] })],
    ['BridgeFailureResponse', createFailure('fixture', 'ELEMENT_STALE', 'Read again')],
  ] as const;
  for (const [type, value] of examples) {
    const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${type}` });
    assert.equal(validate(value), true, `${type}: ${JSON.stringify(validate.errors)}`);
  }
});
