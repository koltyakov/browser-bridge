import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveProtocolVersion,
  deriveSupportedProtocolVersions,
  getProtocolVersion,
  getSupportedProtocolVersions,
  isProtocolVersionSupported,
  setProtocolPackageVersion,
} from '../src/index.js';

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

test('Node 1.15 emits protocol 2.0 and accepts both transition generations', () => {
  assert.equal(deriveProtocolVersion('1.14.2'), '1.14');
  assert.equal(deriveProtocolVersion('1.15.0'), '2.0');
  assert.equal(deriveProtocolVersion('1.15.9'), deriveProtocolVersion('2.0.0'));
  assert.deepEqual(deriveSupportedProtocolVersions('1.15.0'), ['2.0', '1.15']);
  assert.deepEqual(deriveSupportedProtocolVersions('2.0.0'), ['2.0']);
  setProtocolPackageVersion('1.15.0');
  try {
    assert.equal(getProtocolVersion(), '2.0');
    assert.deepEqual(getSupportedProtocolVersions(), ['2.0', '1.15']);
    for (const version of ['1.14', '1.15', '2.0']) {
      assert.equal(isProtocolVersionSupported(version, getSupportedProtocolVersions()), true);
    }
    assert.equal(isProtocolVersionSupported('3.0', getSupportedProtocolVersions()), false);
  } finally {
    setProtocolPackageVersion(null);
  }
});
