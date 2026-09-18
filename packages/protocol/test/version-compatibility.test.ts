import test from 'node:test';
import assert from 'node:assert/strict';
import { isProtocolVersionSupported } from '../src/index.js';

test('protocol compatibility allows independently released minors in both directions', () => {
  assert.equal(isProtocolVersionSupported('1.11', ['1.12']), true);
  assert.equal(isProtocolVersionSupported('1.12', ['1.11']), true);
  assert.equal(isProtocolVersionSupported('1.11', ['1.11']), true);
  assert.equal(isProtocolVersionSupported('1.11', ['2.0']), false);
  assert.equal(isProtocolVersionSupported('2.0', ['1.11']), false);
  assert.equal(isProtocolVersionSupported('1.11', ['2.0', '1.12']), true);
  assert.equal(isProtocolVersionSupported('1.11', []), false);
  assert.equal(isProtocolVersionSupported('invalid', ['invalid']), false);
  assert.equal(isProtocolVersionSupported('1.11', ['invalid']), false);
});
