// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cloneJsonValue,
  estimateResponseTokens,
  createCdpKeyPressEventPair,
  enforceTokenBudget,
  getErrorMessage,
  getResponseDiagnostics,
  inferCapability,
  matchesConsoleLevel,
  normalizeCropRect,
  normalizeRuntimeErrorMessage,
  safeOrigin,
  shouldLogAction,
  simplifyAXNode,
  summarizeActionResult,
  summarizeTabResult,
} from '../src/background-helpers.js';

test('background helpers infer capabilities and normalize runtime errors', () => {
  assert.equal(inferCapability('page.evaluate'), 'page.evaluate');
  assert.equal(inferCapability('tabs.create'), 'tabs.manage');
  assert.equal(inferCapability('tabs.list'), null);
  assert.equal(normalizeRuntimeErrorMessage('No tab with id: 7.'), 'TAB_MISMATCH');
  assert.equal(normalizeRuntimeErrorMessage('Error: No tab with id: 7.'), 'TAB_MISMATCH');
  assert.equal(normalizeRuntimeErrorMessage('Error: boom'), 'boom');
  assert.equal(normalizeRuntimeErrorMessage('boom'), 'boom');
});

test('background helpers build CDP keyDown/keyUp events for Escape', () => {
  assert.deepEqual(createCdpKeyPressEventPair({ key: 'Escape' }), [
    {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
      modifiers: 0,
    },
    {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
      modifiers: 0,
    },
  ]);
});

test('background helpers support CDP printable keys and modifiers', () => {
  assert.deepEqual(createCdpKeyPressEventPair({ key: 'a', code: 'KeyA', modifiers: ['Shift'] }), [
    {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 8,
      text: 'a',
      unmodifiedText: 'a',
    },
    {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 8,
    },
  ]);
});

test('background helpers reject invalid CDP key input', () => {
  assert.throws(() => createCdpKeyPressEventPair({ key: '' }), /key must be a non-empty string\./);
  assert.throws(
    () => createCdpKeyPressEventPair({ key: 'Escape', modifiers: ['Shift', 'Ctrl'] }),
    /modifiers must contain only Alt, Control, Meta, or Shift\./
  );
  assert.throws(
    () => createCdpKeyPressEventPair({ key: 'Escape', modifiers: 16 }),
    /modifiers must be an array of Alt, Control, Meta, Shift or a bitmask 0-15\./
  );
});

test('getErrorMessage returns string, Error message, and sentinel fallback', () => {
  assert.equal(getErrorMessage('explicit failure'), 'explicit failure');
  assert.equal(getErrorMessage(new Error('boom')), 'boom');
  assert.equal(getErrorMessage({ code: 'mystery' }), 'Unexpected extension error.');
});

test('background helpers summarize responses and tabs', () => {
  assert.deepEqual(
    summarizeTabResult(
      /** @type {any} */ ({
        id: 7,
        windowId: 3,
        url: 'https://example.com',
        title: 'Example',
        status: 'complete',
      }),
      'navigation.navigate'
    ),
    {
      method: 'navigation.navigate',
      tabId: 7,
      windowId: 3,
      url: 'https://example.com',
      title: 'Example',
      status: 'complete',
    }
  );

  assert.equal(
    summarizeActionResult({
      id: 'req_1',
      ok: true,
      result: { patchId: 'patch_1' },
      error: null,
      meta: { protocol_version: '1.0' },
    }),
    'Patch patch_1 applied.'
  );
  assert.equal(
    summarizeActionResult({
      id: 'req_2',
      ok: false,
      result: null,
      error: { code: 'ACCESS_DENIED', message: 'Denied', details: null },
      meta: { protocol_version: '1.0' },
    }),
    'Denied'
  );
});

test('background helpers normalize crop rects and accessibility nodes', () => {
  assert.deepEqual(normalizeCropRect({ x: 10.4, y: -5, width: 0, height: 0, scale: 2 }), {
    x: 21,
    y: 0,
    width: 2,
    height: 2,
  });

  assert.deepEqual(
    simplifyAXNode({
      nodeId: 5,
      role: { value: 'button' },
      name: { value: 'Save' },
      focused: { value: true },
      required: { value: false },
      checked: { value: 'mixed' },
      disabled: { value: false },
      focusable: { value: true },
      childIds: [1, 2],
    }),
    {
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
      childIds: ['1', '2'],
    }
  );
});

test('cloneJsonValue preserves shape, severs aliasing, and passes through nullish values', () => {
  /** @type {{ count: number, nested: { values: [number, { count: number }, null] } }} */
  const original = {
    count: 3,
    nested: {
      values: [1, { count: 2 }, null],
    },
  };

  const cloned = /** @type {typeof original} */ (cloneJsonValue(original));
  assert.deepEqual(cloned, original);
  assert.notStrictEqual(cloned, original);
  assert.notStrictEqual(cloned.nested, original.nested);
  assert.notStrictEqual(cloned.nested.values, original.nested.values);

  cloned.count = 9;
  cloned.nested.values[1].count = 7;
  cloned.nested.values.push(4);

  assert.deepEqual(original, {
    count: 3,
    nested: {
      values: [1, { count: 2 }, null],
    },
  });
  assert.equal(cloneJsonValue(null), null);
  assert.equal(cloneJsonValue(undefined), undefined);
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
    result: { nodes: [{ tag: 'div' }, { tag: 'span' }] },
  });
  const estimate = estimateResponseTokens(nodesResponse);
  const expectedBytes = new TextEncoder().encode(JSON.stringify(nodesResponse.result)).length;
  assert.equal(estimate.responseBytes, expectedBytes);
  assert.equal(estimate.approxTokens, Math.ceil(expectedBytes / 4));
  assert.equal(estimate.textBytes, expectedBytes);
  assert.equal(estimate.textApproxTokens, Math.ceil(expectedBytes / 4));
  assert.equal(estimate.imageApproxTokens, 0);
  assert.equal(estimate.imageBytes, 0);
  assert.equal(estimate.hasScreenshot, false);
  assert.equal(estimate.nodeCount, 2);
});

test('estimateResponseTokens separates screenshot image bytes from text tokens', () => {
  const screenshotResponse = /** @type {any} */ ({
    ok: true,
    result: {
      rect: { width: 10, height: 10, scale: 2 },
      image: 'data:image/png;base64,AAAA',
    },
  });
  const estimate = estimateResponseTokens(screenshotResponse);
  assert.equal(estimate.hasScreenshot, true);
  assert.equal(estimate.nodeCount, null);
  const expectedBytes = new TextEncoder().encode(JSON.stringify(screenshotResponse.result)).length;
  const expectedTextBytes = new TextEncoder().encode(
    JSON.stringify({ rect: screenshotResponse.result.rect })
  ).length;
  const expectedImageTransportBytes = expectedBytes - expectedTextBytes;
  assert.equal(estimate.responseBytes, expectedBytes);
  assert.equal(estimate.approxTokens, Math.ceil(expectedBytes / 4));
  assert.equal(estimate.textBytes, expectedTextBytes);
  assert.equal(estimate.textApproxTokens, Math.ceil(expectedTextBytes / 4));
  assert.equal(estimate.imageApproxTokens, Math.ceil(expectedImageTransportBytes / 4));
  assert.equal(estimate.imageBytes, 3);
});

test('estimateResponseTokens counts failure payloads', () => {
  const failResponse = /** @type {any} */ ({
    ok: false,
    result: null,
    error: { code: 'ACCESS_DENIED', message: 'Denied', details: null },
  });
  const estimate = estimateResponseTokens(failResponse);
  const expectedBytes = new TextEncoder().encode(
    JSON.stringify({ error: failResponse.error })
  ).length;
  assert.equal(estimate.responseBytes, expectedBytes);
  assert.equal(estimate.approxTokens, Math.ceil(expectedBytes / 4));
  assert.equal(estimate.textBytes, expectedBytes);
  assert.equal(estimate.textApproxTokens, Math.ceil(expectedBytes / 4));
  assert.equal(estimate.imageApproxTokens, 0);
  assert.equal(estimate.imageBytes, 0);
  assert.equal(estimate.hasScreenshot, false);
  assert.equal(estimate.nodeCount, null);
});

test('estimateResponseTokens uses UTF-8 byte length for unicode payloads', () => {
  const response = /** @type {any} */ ({
    ok: true,
    result: { value: 'こんにちは' },
  });
  const estimate = estimateResponseTokens(response);
  const expectedBytes = new TextEncoder().encode(JSON.stringify(response.result)).length;
  assert.equal(estimate.responseBytes, expectedBytes);
  assert.ok(expectedBytes > JSON.stringify(response.result).length);
});

test('getResponseDiagnostics marks debugger-backed heavy responses', () => {
  const diagnostics = getResponseDiagnostics(
    'page.evaluate',
    /** @type {any} */ ({
      ok: true,
      result: { value: 'x'.repeat(5000) },
    })
  );
  assert.equal(diagnostics.debuggerBacked, true);
  assert.equal(diagnostics.costClass, 'heavy');
});

test('enforceTokenBudget truncates oversized responses deterministically', () => {
  const response = /** @type {any} */ ({
    ok: true,
    result: {
      nodes: Array.from({ length: 12 }, (_, index) => ({
        elementRef: `el_${index}`,
        text: `Node ${index} ${'x'.repeat(120)}`,
      })),
    },
    error: null,
    meta: { protocol_version: '1.0' },
  });

  const originalBytes = new TextEncoder().encode(JSON.stringify(response.result)).length;
  const budgeted = enforceTokenBudget('dom.query', response, 120);
  const budgetedResult =
    /** @type {{ nodes: unknown[], truncated?: boolean, count?: number, total?: number }} */ (
      budgeted.result
    );
  const budgetedBytes = new TextEncoder().encode(JSON.stringify(budgeted.result)).length;

  assert.equal(budgeted.ok, true);
  assert.equal(budgeted.meta.budget_applied, true);
  assert.equal(budgeted.meta.budget_truncated, true);
  assert.match(String(budgeted.meta.continuation_hint), /larger token budget|tighter params/);
  assert.ok(Array.isArray(budgetedResult.nodes));
  assert.ok(budgetedResult.nodes.length < response.result.nodes.length);
  assert.equal(budgetedResult.count, response.result.nodes.length);
  assert.equal(budgetedResult.total, response.result.nodes.length);
  assert.equal(budgetedResult.truncated, true);
  assert.ok(budgetedBytes < originalBytes);
  assert.ok(budgetedBytes <= 480);
});

test('enforceTokenBudget shrinks nested arrays through recursive object traversal', () => {
  const response = /** @type {any} */ ({
    ok: true,
    result: {
      section: {
        entries: Array.from({ length: 40 }, (_, index) => ({
          elementRef: `el_${index}`,
          role: 'button',
          name: `Action ${index}`,
        })),
        summary: 'Primary actions',
      },
    },
    error: null,
    meta: { protocol_version: '1.0' },
  });

  const originalLength = response.result.section.entries.length;
  const budgeted = enforceTokenBudget('dom.query', response, 90);
  const budgetedResult =
    /** @type {{ section: { entries: unknown[], count?: number, total?: number, truncated?: boolean }, truncated?: boolean }} */ (
      budgeted.result
    );

  assert.equal(budgeted.ok, true);
  assert.equal(budgeted.meta.budget_applied, true);
  assert.equal(budgeted.meta.budget_truncated, true);
  assert.ok(Array.isArray(budgetedResult.section.entries));
  assert.ok(budgetedResult.section.entries.length < originalLength);
  assert.equal(budgetedResult.section.count, originalLength);
  assert.equal(budgetedResult.section.total, originalLength);
  assert.equal(budgetedResult.section.truncated, true);
  assert.equal(budgetedResult.truncated, true);
  assert.equal(response.result.section.entries.length, originalLength);
});

test('enforceTokenBudget leaves already-shrunk results stable on a second pass', () => {
  const response = /** @type {any} */ ({
    ok: true,
    result: {
      nodes: Array.from({ length: 12 }, (_, index) => ({
        elementRef: `el_${index}`,
        text: `Node ${index} ${'x'.repeat(120)}`,
      })),
    },
    error: null,
    meta: { protocol_version: '1.0' },
  });

  const firstPass = enforceTokenBudget('dom.query', response, 120);
  const secondPass = enforceTokenBudget('dom.query', firstPass, 120);

  assert.deepEqual(secondPass.result, firstPass.result);
  assert.equal(secondPass.meta.budget_applied, false);
  assert.equal(secondPass.meta.budget_truncated, false);
  assert.equal(secondPass.meta.continuation_hint, null);
});

test('enforceTokenBudget falls back to a compact continuation payload when fields remain oversized', () => {
  const response = /** @type {any} */ ({
    ok: true,
    result: {
      value: 'x'.repeat(5000),
      extra: 'y'.repeat(5000),
    },
    error: null,
    meta: { protocol_version: '1.0' },
  });

  const budgeted = enforceTokenBudget('page.evaluate', response, 1);
  const budgetedBytes = new TextEncoder().encode(JSON.stringify(budgeted.result)).length;

  assert.deepEqual(budgeted.result, {
    truncated: true,
    continuationHint: 'Retry page.evaluate with a larger token budget or tighter params.',
  });
  assert.equal(budgeted.meta.budget_applied, true);
  assert.equal(budgeted.meta.budget_truncated, true);
  assert.equal(
    budgeted.meta.continuation_hint,
    'Retry page.evaluate with a larger token budget or tighter params.'
  );
  assert.ok(budgetedBytes <= 128);
  assert.equal(response.result.extra.length, 5000);
  assert.equal(response.result.value.length, 5000);
});

test('enforceTokenBudget returns RESULT_TRUNCATED when even the compact fallback exceeds budget', () => {
  const method = `page.evaluate.${'x'.repeat(160)}`;
  const response = /** @type {any} */ ({
    id: 'req_tiny_budget',
    ok: true,
    result: {
      value: 'x'.repeat(5000),
      extra: 'y'.repeat(5000),
    },
    error: null,
    meta: { protocol_version: '1.0' },
  });

  const budgeted = enforceTokenBudget(method, response, 0.25);

  assert.equal(budgeted.ok, false);
  assert.equal(budgeted.result, null);
  assert.equal(budgeted.error.code, 'RESULT_TRUNCATED');
  assert.equal(budgeted.error.message, 'Result was truncated to fit the response budget.');
  assert.deepEqual(budgeted.error.details, {
    method,
    tokenBudget: 0.25,
  });
  assert.equal(budgeted.meta.protocol_version, '1.0');
  assert.equal(budgeted.meta.budget_applied, true);
  assert.equal(budgeted.meta.budget_truncated, true);
  assert.equal(
    budgeted.meta.continuation_hint,
    `Retry ${method} with a larger token budget or tighter params.`
  );
  assert.match(
    String(budgeted.error.recovery?.hint),
    /Narrow the query or raise the relevant budget/
  );
  assert.equal(response.result.extra.length, 5000);
  assert.equal(response.result.value.length, 5000);
});
