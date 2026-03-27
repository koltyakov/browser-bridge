// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateJsonPayloadCost,
  estimateSerializedPayloadCost,
  getUtf8ByteLength,
} from '../src/index.js';

test('getUtf8ByteLength measures unicode correctly', () => {
  const ascii = getUtf8ByteLength('hello');
  const unicode = getUtf8ByteLength('こんにちは');
  assert.equal(ascii, 5);
  assert.ok(unicode > 'こんにちは'.length);
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
