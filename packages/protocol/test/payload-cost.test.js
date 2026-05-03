// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateJsonPayloadCost,
  estimateSerializedPayloadCost,
  getUtf8ByteLength,
  serializeJsonPayload,
} from '../src/index.js';

test('getUtf8ByteLength measures unicode correctly', () => {
  const ascii = getUtf8ByteLength('hello');
  const unicode = getUtf8ByteLength('こんにちは');
  assert.equal(ascii, 5);
  assert.ok(unicode > 'こんにちは'.length);
});

test('getUtf8ByteLength matches Buffer.byteLength and TextEncoder for edge cases', () => {
  const cases = ['', '😀', '𐍈', '😃🍣'];

  for (const value of cases) {
    const actual = getUtf8ByteLength(value);
    const bufferBytes = Buffer.byteLength(value, 'utf8');
    const textEncoderBytes = new TextEncoder().encode(value).length;

    assert.equal(
      actual,
      bufferBytes,
      `expected Buffer.byteLength parity for ${JSON.stringify(value)}`
    );
    assert.equal(
      actual,
      textEncoderBytes,
      `expected TextEncoder parity for ${JSON.stringify(value)}`
    );
  }
});

test('estimateSerializedPayloadCost uses utf8 bytes', () => {
  const cost = estimateSerializedPayloadCost('{"value":"こんにちは"}');
  assert.equal(cost.bytes, new TextEncoder().encode('{"value":"こんにちは"}').length);
  assert.equal(cost.approxTokens, Math.ceil(cost.bytes / 4));
});

test('estimateJsonPayloadCost handles undefined payloads', () => {
  const cost = estimateJsonPayloadCost(undefined);
  assert.equal(cost.bytes, 0);
  assert.equal(cost.approxTokens, 0);
  assert.equal(cost.costClass, 'cheap');
});

test('serializeJsonPayload and estimateJsonPayloadCost accept pre-serialized input', () => {
  const payload = { value: 'こんにちは' };
  const serialized = serializeJsonPayload(payload);

  assert.equal(serialized, '{"value":"こんにちは"}');

  const cost = estimateJsonPayloadCost(payload, serialized);
  assert.equal(cost.bytes, new TextEncoder().encode(serialized).length);
  assert.equal(cost.approxTokens, Math.ceil(cost.bytes / 4));
});

test('estimateSerializedPayloadCost applies cost classes at token boundaries', () => {
  const cases = [
    { tokens: 250, costClass: 'cheap' },
    { tokens: 251, costClass: 'moderate' },
    { tokens: 1000, costClass: 'moderate' },
    { tokens: 1001, costClass: 'heavy' },
    { tokens: 3000, costClass: 'heavy' },
    { tokens: 3001, costClass: 'extreme' },
  ];

  for (const testCase of cases) {
    const cost = estimateSerializedPayloadCost('x'.repeat(testCase.tokens * 4));
    assert.equal(cost.approxTokens, testCase.tokens);
    assert.equal(cost.costClass, testCase.costClass);
  }
});
