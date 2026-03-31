// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyBudget,
  truncateText,
  summarizeFields,
} from '../src/index.js';

// --- applyBudget ---

test('applyBudget returns defaults when called with no options', () => {
  const budget = applyBudget();
  assert.equal(budget.maxNodes, 25);
  assert.equal(budget.maxDepth, 4);
  assert.equal(budget.textBudget, 600);
  assert.equal(budget.includeBbox, true);
  assert.deepEqual(budget.attributeAllowlist, []);
});

test('applyBudget clamps maxNodes below minimum to 1', () => {
  const budget = applyBudget({ maxNodes: 0 });
  assert.equal(budget.maxNodes, 1);
});

test('applyBudget clamps maxNodes above maximum to 250', () => {
  const budget = applyBudget({ maxNodes: 500 });
  assert.equal(budget.maxNodes, 250);
});

test('applyBudget clamps maxDepth below minimum to 1', () => {
  const budget = applyBudget({ maxDepth: 0 });
  assert.equal(budget.maxDepth, 1);
});

test('applyBudget clamps maxDepth above maximum to 20', () => {
  const budget = applyBudget({ maxDepth: 100 });
  assert.equal(budget.maxDepth, 20);
});

test('applyBudget clamps textBudget below minimum to 32', () => {
  const budget = applyBudget({ textBudget: 5 });
  assert.equal(budget.textBudget, 32);
});

test('applyBudget clamps textBudget above maximum to 10000', () => {
  const budget = applyBudget({ textBudget: 99999 });
  assert.equal(budget.textBudget, 10000);
});

test('applyBudget handles string values via Number coercion', () => {
  // @ts-expect-error - testing runtime coercion
  const budget = applyBudget({ maxNodes: '10' });
  assert.equal(budget.maxNodes, 10);
});

test('applyBudget handles NaN values by using defaults', () => {
  // @ts-expect-error - testing runtime coercion
  const budget = applyBudget({ maxNodes: 'abc' });
  assert.equal(budget.maxNodes, 1); // NaN || 1 => 1, clamped min 1
});

test('applyBudget handles null values by using defaults', () => {
  const budget = applyBudget(/** @type {any} */ ({ maxNodes: null }));
  assert.equal(budget.maxNodes, 25);
});

test('applyBudget sets includeBbox to false when explicitly false', () => {
  const budget = applyBudget({ includeBbox: false });
  assert.equal(budget.includeBbox, false);
});

test('applyBudget normalizeList filters non-string and empty items', () => {
  // @ts-expect-error - testing runtime behavior
  const budget = applyBudget({ attributeAllowlist: ['class', 42, '', null, 'id'] });
  assert.deepEqual(budget.attributeAllowlist, ['class', 'id']);
});

test('applyBudget normalizeList deduplicates items', () => {
  const budget = applyBudget({ attributeAllowlist: ['id', 'class', 'id', 'class'] });
  assert.deepEqual(budget.attributeAllowlist, ['id', 'class']);
});

test('applyBudget normalizeList returns empty array for non-array', () => {
  // @ts-expect-error - testing runtime behavior
  const budget = applyBudget({ attributeAllowlist: 'not-an-array' });
  assert.deepEqual(budget.attributeAllowlist, []);
});

// --- truncateText ---

test('truncateText returns empty string for falsy input', () => {
  assert.deepEqual(truncateText('', 100), { value: '', truncated: false, omitted: 0 });
  // @ts-expect-error - testing runtime behavior
  assert.deepEqual(truncateText(null, 100), { value: '', truncated: false, omitted: 0 });
  // @ts-expect-error - testing runtime behavior
  assert.deepEqual(truncateText(undefined, 100), { value: '', truncated: false, omitted: 0 });
});

test('truncateText returns original when within budget', () => {
  assert.deepEqual(truncateText('hello', 10), { value: 'hello', truncated: false, omitted: 0 });
});

test('truncateText returns original when exactly at budget', () => {
  assert.deepEqual(truncateText('abcd', 4), { value: 'abcd', truncated: false, omitted: 0 });
});

test('truncateText truncates and appends ellipsis when over budget', () => {
  const result = truncateText('abcdefgh', 5);
  assert.equal(result.truncated, true);
  assert.equal(result.omitted, 3);
  assert.ok(result.value.endsWith('\u2026'));
  assert.equal(result.value.length, 5);
});

test('truncateText handles budget of 1', () => {
  const result = truncateText('abcdefgh', 1);
  assert.equal(result.truncated, true);
  assert.equal(result.value, '\u2026');
});

// --- summarizeFields ---

test('summarizeFields picks specified fields from source', () => {
  const result = summarizeFields({ a: 1, b: 2, c: 3 }, ['a', 'c']);
  assert.deepEqual(result, { a: 1, c: 3 });
});

test('summarizeFields skips null and undefined fields', () => {
  const result = summarizeFields({ a: 1, b: null, c: undefined }, ['a', 'b', 'c']);
  assert.deepEqual(result, { a: 1 });
});

test('summarizeFields returns empty object for null source', () => {
  assert.deepEqual(summarizeFields(null), {});
  assert.deepEqual(summarizeFields(undefined), {});
});

test('summarizeFields returns empty object for non-object source', () => {
  // @ts-expect-error - testing runtime behavior
  assert.deepEqual(summarizeFields('string', ['a']), {});
  // @ts-expect-error - testing runtime behavior
  assert.deepEqual(summarizeFields(42, ['a']), {});
});

test('summarizeFields skips fields not present in source', () => {
  const result = summarizeFields({ a: 1 }, ['a', 'b', 'c']);
  assert.deepEqual(result, { a: 1 });
});

test('summarizeFields defaults to empty fields', () => {
  const result = summarizeFields({ a: 1 });
  assert.deepEqual(result, {});
});
