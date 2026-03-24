// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

await import('../src/content-script-helpers.js');

const helpers = /** @type {typeof globalThis & { __BBX_CONTENT_HELPERS__?: any }} */ (globalThis).__BBX_CONTENT_HELPERS__;

test('content script helpers clamp, truncate, and normalize budgets', () => {
  assert.ok(helpers, 'content-script helpers should be registered on globalThis');
  assert.equal(helpers.clamp(999, 1, 10), 10);
  assert.equal(helpers.clamp(-1, 1, 10), 1);
  assert.deepEqual(helpers.truncateText('abcdef', 4), {
    value: 'abc…',
    truncated: true,
    omitted: 2
  });
  assert.deepEqual(helpers.applyBudget({
    maxNodes: 999,
    maxDepth: 0,
    textBudget: 4,
    attributeAllowlist: ['id', '', 'id']
  }), {
    maxNodes: 250,
    maxDepth: 1,
    textBudget: 32,
    includeHtml: false,
    includeScreenshot: false,
    includeBbox: true,
    attributeAllowlist: ['id'],
    styleAllowlist: []
  });
});

test('content script helpers escape Tailwind selectors and expose shared constants', () => {
  assert.equal(
    helpers.escapeTailwindSelector('.top-[30px] .bg-[#f00]'),
    '.top-\\[30px\\] .bg-\\[#f00\\]'
  );
  assert.equal(helpers.NON_TEXT_INPUT_TYPES.has('checkbox'), true);
  assert.equal(helpers.NON_TEXT_INPUT_TYPES.has('text'), false);
});
