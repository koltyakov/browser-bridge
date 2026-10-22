import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyHtmlBudgetPreset,
  applyLimitBudgetPreset,
  applyMethodBudgetPreset,
  applyPageTextBudgetPreset,
  applyTextBudgetPreset,
  applyTreeBudgetPreset,
  BUDGET_PRESETS,
  getBudgetPresetName,
} from '../src/index.js';

test('getBudgetPresetName accepts only valid preset names', () => {
  assert.equal(getBudgetPresetName('quick'), 'quick');
  assert.equal(getBudgetPresetName('normal'), 'normal');
  assert.equal(getBudgetPresetName('deep'), 'deep');
  assert.equal(getBudgetPresetName('bogus'), null);
  assert.equal(getBudgetPresetName(null), null);
  assert.equal(getBudgetPresetName(undefined), null);
  assert.equal(getBudgetPresetName(42), null);
});

test('applyTreeBudgetPreset fills gaps and keeps explicit values', () => {
  assert.deepEqual(applyTreeBudgetPreset({ budgetPreset: 'quick' }), {
    budgetPreset: 'quick',
    maxNodes: BUDGET_PRESETS.quick.maxNodes,
    maxDepth: BUDGET_PRESETS.quick.maxDepth,
    textBudget: BUDGET_PRESETS.quick.textBudget,
  });
  assert.deepEqual(applyTreeBudgetPreset({ budgetPreset: 'deep', maxNodes: 7 }), {
    budgetPreset: 'deep',
    maxNodes: 7,
    maxDepth: BUDGET_PRESETS.deep.maxDepth,
    textBudget: BUDGET_PRESETS.deep.textBudget,
  });
  assert.deepEqual(applyTreeBudgetPreset({ maxNodes: 3 }), { maxNodes: 3 });
});

test('applyTextBudgetPreset and applyPageTextBudgetPreset honor preset and explicit values', () => {
  assert.deepEqual(applyTextBudgetPreset({ budgetPreset: 'quick' }), {
    budgetPreset: 'quick',
    textBudget: BUDGET_PRESETS.quick.textBudget,
  });
  assert.deepEqual(applyTextBudgetPreset({ textBudget: 123 }), { textBudget: 123 });
  assert.deepEqual(applyPageTextBudgetPreset({ budgetPreset: 'quick' }), {
    budgetPreset: 'quick',
    textBudget: 2000,
  });
  assert.deepEqual(applyPageTextBudgetPreset({ budgetPreset: 'deep', textBudget: 50 }), {
    budgetPreset: 'deep',
    textBudget: 50,
  });
});

test('applyLimitBudgetPreset and applyHtmlBudgetPreset use per-method defaults', () => {
  assert.deepEqual(
    applyLimitBudgetPreset({ budgetPreset: 'normal' }, { quick: 10, normal: 50, deep: 100 }),
    { budgetPreset: 'normal', limit: 50 }
  );
  assert.deepEqual(
    applyLimitBudgetPreset(
      { budgetPreset: 'quick', limit: 2 },
      { quick: 10, normal: 50, deep: 100 }
    ),
    { budgetPreset: 'quick', limit: 2 }
  );
  assert.deepEqual(applyHtmlBudgetPreset({ budgetPreset: 'deep' }), {
    budgetPreset: 'deep',
    maxLength: 6000,
  });
  assert.deepEqual(applyHtmlBudgetPreset({ maxLength: 100 }), { maxLength: 100 });
});

test('applyMethodBudgetPreset maps presets onto method-specific params', () => {
  assert.deepEqual(applyMethodBudgetPreset('dom.query', { selector: 'main' }, 'quick'), {
    selector: 'main',
    maxNodes: BUDGET_PRESETS.quick.maxNodes,
    maxDepth: BUDGET_PRESETS.quick.maxDepth,
    textBudget: BUDGET_PRESETS.quick.textBudget,
  });
  assert.deepEqual(applyMethodBudgetPreset('dom.get_accessibility_tree', {}, 'deep'), {
    maxNodes: BUDGET_PRESETS.deep.maxNodes,
    maxDepth: BUDGET_PRESETS.deep.maxDepth,
    textBudget: BUDGET_PRESETS.deep.textBudget,
  });
  assert.deepEqual(applyMethodBudgetPreset('dom.baseline.compare', {}, 'normal'), {
    maxChanges: 50,
  });
  assert.deepEqual(applyMethodBudgetPreset('dom.get_text', {}, 'quick'), {
    textBudget: BUDGET_PRESETS.quick.textBudget,
  });
  assert.deepEqual(applyMethodBudgetPreset('dom.get_html', {}, 'quick'), { maxLength: 600 });
  assert.deepEqual(applyMethodBudgetPreset('page.get_text', {}, 'deep'), { textBudget: 16000 });
  assert.deepEqual(applyMethodBudgetPreset('page.extract_content', {}, 'quick'), {
    textBudget: 2000,
  });
  assert.deepEqual(applyMethodBudgetPreset('page.get_console', {}, 'quick'), { limit: 10 });
  assert.deepEqual(applyMethodBudgetPreset('page.get_network', {}, 'deep'), { limit: 100 });
  assert.deepEqual(applyMethodBudgetPreset('network.export_har', {}, 'quick'), { limit: 20 });
  assert.deepEqual(applyMethodBudgetPreset('log.tail', {}, 'deep'), { limit: 100 });
});

test('applyMethodBudgetPreset explicit params always win over preset defaults', () => {
  assert.deepEqual(
    applyMethodBudgetPreset('dom.query', { selector: 'main', maxNodes: 7, textBudget: 50 }, 'deep'),
    {
      selector: 'main',
      maxNodes: 7,
      maxDepth: BUDGET_PRESETS.deep.maxDepth,
      textBudget: 50,
    }
  );
  assert.deepEqual(applyMethodBudgetPreset('page.get_console', { limit: 3 }, 'quick'), {
    limit: 3,
  });
});

test('applyMethodBudgetPreset without a preset returns params unchanged', () => {
  assert.deepEqual(applyMethodBudgetPreset('dom.query', { selector: 'main' }, null), {
    selector: 'main',
  });
  assert.deepEqual(applyMethodBudgetPreset('page.get_state', {}, undefined), {});
});

test('applyMethodBudgetPreset strips budgetPreset from the outgoing params', () => {
  const merged = applyMethodBudgetPreset('dom.query', { selector: 'main' }, 'quick');
  assert.equal('budgetPreset' in merged, false);
});
