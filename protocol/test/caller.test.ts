import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBridgeCaller, validateBridgeRequest } from '../src/index.js';

test('caller attribution retains only bounded display fields', () => {
  assert.deepEqual(
    normalizeBridgeCaller({
      name: ' OpenCode ',
      version: ' 2.0.0-beta.1 ',
      source: 'environment',
      signal: 'OPENCODE',
      secret: 'not-retained',
    }),
    { name: 'OpenCode', version: '2.0.0-beta.1', source: 'environment', signal: 'OPENCODE' }
  );
  assert.deepEqual(
    normalizeBridgeCaller({
      name: 'Agent',
      source: 'mcp',
      version: 'bad version',
      signal: 'SECRET',
    }),
    { name: 'Agent', source: 'mcp' }
  );
  assert.deepEqual(
    normalizeBridgeCaller({ name: 'Agent', source: 'environment', signal: 'private-value' }),
    { name: 'Agent', source: 'environment' }
  );
  for (const value of [
    null,
    [],
    'OpenCode',
    {},
    { name: 'OpenCode', source: 'verified' },
    { name: 'bad\nname', source: 'mcp' },
    { name: '/private/path', source: 'mcp' },
    { name: '<script>bad</script>', source: 'mcp' },
    { name: 'x'.repeat(129), source: 'mcp' },
  ]) {
    assert.equal(normalizeBridgeCaller(value), undefined);
  }
});

test('request validation normalizes caller attribution without changing unknown callers', () => {
  const base = { id: 'caller-test', method: 'health.ping' };
  const caller = { name: 'Claude Code', source: 'mcp' };
  assert.deepEqual(
    validateBridgeRequest({ ...base, meta: { source: 'mcp', caller } }).meta.caller,
    caller
  );
  assert.equal(validateBridgeRequest({ ...base, meta: { caller } }).meta.caller, undefined);
  assert.equal(validateBridgeRequest({ ...base, meta: { source: 'cli' } }).meta.caller, undefined);
});
