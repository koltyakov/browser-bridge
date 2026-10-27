import test from 'node:test';
import assert from 'node:assert/strict';

import { applyBudget } from '../src/index.js';

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
  const budget = applyBudget({ maxNodes: null } as unknown as Parameters<typeof applyBudget>[0]);
  assert.equal(budget.maxNodes, 25);
});

test('applyBudget sets includeBbox to false when explicitly false', () => {
  const budget = applyBudget({ includeBbox: false });
  assert.equal(budget.includeBbox, false);
});

test('applyBudget normalizeList filters non-string and empty items', () => {
  const budget = applyBudget({
    attributeAllowlist: ['class', 42, '', null, 'id'],
  } as unknown as Parameters<typeof applyBudget>[0]);
  assert.deepEqual(budget.attributeAllowlist, ['class', 'id']);
});

test('applyBudget normalizeList deduplicates items', () => {
  const budget = applyBudget({
    attributeAllowlist: ['id', 'class', 'id', 'class'],
  });
  assert.deepEqual(budget.attributeAllowlist, ['id', 'class']);
});

test('applyBudget normalizeList returns empty array for non-array', () => {
  const budget = applyBudget({
    attributeAllowlist: 'not-an-array',
  } as unknown as Parameters<typeof applyBudget>[0]);
  assert.deepEqual(budget.attributeAllowlist, []);
});
