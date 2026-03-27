// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateResponseTokens,
  enforceTokenBudget,
  getResponseDiagnostics,
  inferCapability,
  matchesConsoleLevel,
  normalizeCropRect,
  normalizeRuntimeErrorMessage,
  safeOrigin,
  shouldLogAction,
  simplifyAXNode,
  summarizeActionResult,
  summarizeTabResult
} from '../src/background-helpers.js';

test('background helpers infer capabilities and normalize runtime errors', () => {
  assert.equal(inferCapability('page.evaluate'), 'page.evaluate');
  assert.equal(inferCapability('tabs.create'), 'tabs.manage');
  assert.equal(inferCapability('tabs.list'), null);
  assert.equal(normalizeRuntimeErrorMessage('No tab with id: 7.'), 'TAB_MISMATCH');
  assert.equal(normalizeRuntimeErrorMessage('boom'), 'boom');
});

test('background helpers summarize responses and tabs', () => {
  assert.deepEqual(summarizeTabResult(/** @type {any} */ ({
    id: 7,
    windowId: 3,
    url: 'https://example.com',
    title: 'Example',
    status: 'complete'
  }), 'navigation.navigate'), {
    method: 'navigation.navigate',
    tabId: 7,
    windowId: 3,
    url: 'https://example.com',
    title: 'Example',
    status: 'complete'
  });

  assert.equal(summarizeActionResult({
    id: 'req_1',
    ok: true,
    result: { patchId: 'patch_1' },
    error: null,
    meta: { protocol_version: '1.0' }
  }), 'Patch patch_1 applied.');
  assert.equal(summarizeActionResult({
    id: 'req_2',
    ok: false,
    result: null,
    error: { code: 'ACCESS_DENIED', message: 'Denied', details: null },
    meta: { protocol_version: '1.0' }
  }), 'Denied');
});

test('background helpers normalize crop rects and accessibility nodes', () => {
  assert.deepEqual(normalizeCropRect({ x: 10.4, y: -5, width: 0, height: 0, scale: 2 }), {
    x: 21,
    y: 0,
    width: 2,
    height: 2
  });

  assert.deepEqual(simplifyAXNode({
    nodeId: 5,
    role: { value: 'button' },
    name: { value: 'Save' },
    focused: { value: true },
    required: { value: false },
    checked: { value: 'mixed' },
    disabled: { value: false },
    focusable: { value: true },
    childIds: [1, 2]
  }), {
    nodeId: '5',
    role: 'button',
    name: 'Save',
    description: '',
    value: '',
    focused: true,
    required: false,
    checked: 'mixed',
    disabled: false,
    interactive: true,
    childIds: ['1', '2']
  });
});

test('background helpers expose log and origin helpers', () => {
  assert.equal(shouldLogAction('dom.query'), true);
  assert.equal(shouldLogAction('health.ping'), false);
  assert.equal(matchesConsoleLevel('error', 'exception'), true);
  assert.equal(matchesConsoleLevel('error', 'rejection'), true);
  assert.equal(matchesConsoleLevel('warn', 'exception'), false);
  assert.equal(safeOrigin('https://example.com/path?q=1'), 'https://example.com');
  assert.equal(safeOrigin('not-a-url'), '');
});

test('estimateResponseTokens computes metrics for success responses', () => {
  const nodesResponse = /** @type {any} */ ({
    ok: true,
    result: { nodes: [{ tag: 'div' }, { tag: 'span' }] }
  });
  const estimate = estimateResponseTokens(nodesResponse);
  const expectedBytes = new TextEncoder().encode(JSON.stringify(nodesResponse.result)).length;
  assert.equal(estimate.responseBytes, expectedBytes);
  assert.equal(estimate.approxTokens, Math.ceil(expectedBytes / 4));
  assert.equal(estimate.hasScreenshot, false);
  assert.equal(estimate.nodeCount, 2);
});

test('estimateResponseTokens counts screenshot payloads conservatively', () => {
  const screenshotResponse = /** @type {any} */ ({
    ok: true,
    result: { image: 'data:image/png;base64,AAAA' }
  });
  const estimate = estimateResponseTokens(screenshotResponse);
  assert.equal(estimate.hasScreenshot, true);
  assert.equal(estimate.nodeCount, null);
  const expectedBytes = new TextEncoder().encode(JSON.stringify(screenshotResponse.result)).length;
  assert.equal(estimate.responseBytes, expectedBytes);
  assert.equal(estimate.approxTokens, Math.ceil(expectedBytes / 4));
});

test('estimateResponseTokens counts failure payloads', () => {
  const failResponse = /** @type {any} */ ({
    ok: false,
    result: null,
    error: { code: 'ACCESS_DENIED', message: 'Denied', details: null }
  });
  const estimate = estimateResponseTokens(failResponse);
  const expectedBytes = new TextEncoder().encode(JSON.stringify({ error: failResponse.error })).length;
  assert.equal(estimate.responseBytes, expectedBytes);
  assert.equal(estimate.approxTokens, Math.ceil(expectedBytes / 4));
  assert.equal(estimate.hasScreenshot, false);
  assert.equal(estimate.nodeCount, null);
});

test('estimateResponseTokens uses UTF-8 byte length for unicode payloads', () => {
  const response = /** @type {any} */ ({
    ok: true,
    result: { value: 'こんにちは' }
  });
  const estimate = estimateResponseTokens(response);
  const expectedBytes = new TextEncoder().encode(JSON.stringify(response.result)).length;
  assert.equal(estimate.responseBytes, expectedBytes);
  assert.ok(expectedBytes > JSON.stringify(response.result).length);
});

test('getResponseDiagnostics marks debugger-backed heavy responses', () => {
  const diagnostics = getResponseDiagnostics('page.evaluate', /** @type {any} */ ({
    ok: true,
    result: { value: 'x'.repeat(5000) }
  }));
  assert.equal(diagnostics.debuggerBacked, true);
  assert.equal(diagnostics.costClass, 'heavy');
});

test('enforceTokenBudget truncates oversized responses deterministically', () => {
  const response = /** @type {any} */ ({
    ok: true,
    result: {
      nodes: Array.from({ length: 12 }, (_, index) => ({
        elementRef: `el_${index}`,
        text: `Node ${index} ${'x'.repeat(120)}`
      }))
    },
    error: null,
    meta: { protocol_version: '1.0' }
  });

  const budgeted = enforceTokenBudget('dom.query', response, 120);
  const budgetedResult = /** @type {{ nodes: unknown[], truncated?: boolean }} */ (budgeted.result);
  assert.equal(budgeted.ok, true);
  assert.equal(budgeted.meta.budget_applied, true);
  assert.equal(budgeted.meta.budget_truncated, true);
  assert.match(String(budgeted.meta.continuation_hint), /larger token budget|tighter params/);
  assert.ok(Array.isArray(budgetedResult.nodes));
  assert.ok(budgetedResult.nodes.length < response.result.nodes.length);
  assert.equal(budgetedResult.truncated, true);
});
