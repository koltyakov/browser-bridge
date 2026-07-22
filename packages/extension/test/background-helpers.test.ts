import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION } from '../../protocol/src/index.js';
import type { BridgeResponse } from '../../protocol/src/types.js';

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

type CloneFixture = {
  count: number;
  nested: { values: [number, { count: number }, null] };
};
type NodesResult = { nodes: Array<{ elementRef?: string; text?: string; tag?: string }> };
type ScreenshotResult = { rect: { width: number; height: number; scale: number }; image: string };
type BudgetedNodesResult = {
  nodes: unknown[];
  truncated?: boolean;
  count?: number;
  total?: number;
};
type BudgetedSectionResult = {
  section: { entries: unknown[]; count?: number; total?: number; truncated?: boolean };
  truncated?: boolean;
};
type OversizedResult = { value: string; extra: string };

function tab(fields: Record<string, unknown>): chrome.tabs.Tab {
  return fields as unknown as chrome.tabs.Tab;
}

function successResponse(id: string, result: unknown): BridgeResponse {
  return {
    id,
    ok: true,
    result,
    error: null,
    meta: { protocol_version: PROTOCOL_VERSION },
  };
}

function failureResponse(id: string, code: string, message: string): BridgeResponse {
  return {
    id,
    ok: false,
    result: null,
    error: { code, message, details: null } as BridgeResponse extends infer Response
      ? Response extends { ok: false; error: infer Failure }
        ? Failure
        : never
      : never,
    meta: { protocol_version: PROTOCOL_VERSION },
  };
}

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
      tab({
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
    summarizeActionResult(successResponse('req_1', { patchId: 'patch_1' })),
    'Patch patch_1 applied.'
  );
  assert.equal(
    summarizeActionResult(failureResponse('req_2', 'ACCESS_DENIED', 'Denied')),
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
      semanticInteractive: true,
      focusable: true,
      focusableAndEnabled: true,
      ignored: false,
      childIds: ['1', '2'],
    }
  );
});

test('cloneJsonValue preserves shape, severs aliasing, and passes through nullish values', () => {
  const original: CloneFixture = {
    count: 3,
    nested: {
      values: [1, { count: 2 }, null],
    },
  };

  const cloned = cloneJsonValue(original) as CloneFixture;
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
  assert.equal(matchesConsoleLevel('all', 'debug'), true);
  assert.equal(matchesConsoleLevel('warn', 'warn'), true);
  assert.equal(matchesConsoleLevel('warn', 'error'), true);
  assert.equal(matchesConsoleLevel('warn', 'exception'), true);
  assert.equal(matchesConsoleLevel('warn', 'rejection'), true);
  assert.equal(matchesConsoleLevel('warn', 'info'), false);
  assert.equal(matchesConsoleLevel('error', 'exception'), true);
  assert.equal(matchesConsoleLevel('error', 'rejection'), true);
  assert.equal(matchesConsoleLevel('exception', 'error'), false);
  assert.equal(matchesConsoleLevel('exception', 'exception'), true);
  assert.equal(matchesConsoleLevel('rejection', 'exception'), false);
  assert.equal(matchesConsoleLevel('bogus', 'error'), false);
  assert.equal(safeOrigin('https://example.com/path?q=1'), 'https://example.com');
  assert.equal(safeOrigin('not-a-url'), '');
});

test('estimateResponseTokens computes metrics for success responses', () => {
  const nodesResponse = successResponse('req_nodes', { nodes: [{ tag: 'div' }, { tag: 'span' }] });
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
  const screenshotResult: ScreenshotResult = {
    rect: { width: 10, height: 10, scale: 2 },
    image: 'data:image/png;base64,AAAA',
  };
  const screenshotResponse = successResponse('req_screenshot', screenshotResult);
  const estimate = estimateResponseTokens(screenshotResponse);
  assert.equal(estimate.hasScreenshot, true);
  assert.equal(estimate.nodeCount, null);
  const expectedBytes = new TextEncoder().encode(JSON.stringify(screenshotResponse.result)).length;
  const expectedTextBytes = new TextEncoder().encode(
    JSON.stringify({ rect: screenshotResult.rect })
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
  const failResponse = failureResponse('req_fail', 'ACCESS_DENIED', 'Denied');
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
  const response = successResponse('req_unicode', { value: 'こんにちは' });
  const estimate = estimateResponseTokens(response);
  const expectedBytes = new TextEncoder().encode(JSON.stringify(response.result)).length;
  assert.equal(estimate.responseBytes, expectedBytes);
  assert.ok(expectedBytes > JSON.stringify(response.result).length);
});

test('getResponseDiagnostics marks debugger-backed heavy responses', () => {
  const diagnostics = getResponseDiagnostics(
    'page.evaluate',
    successResponse('req_diagnostics', { value: 'x'.repeat(5000) })
  );
  assert.equal(diagnostics.debuggerBacked, true);
  assert.equal(diagnostics.costClass, 'heavy');
});

test('enforceTokenBudget truncates oversized responses deterministically', () => {
  const result: NodesResult = {
    nodes: Array.from({ length: 12 }, (_, index) => ({
      elementRef: `el_${index}`,
      text: `Node ${index} ${'x'.repeat(120)}`,
    })),
  };
  const response = successResponse('req_budget_nodes', result);

  const originalBytes = new TextEncoder().encode(JSON.stringify(response.result)).length;
  const budgeted = enforceTokenBudget('dom.query', response, 120);
  const budgetedResult = budgeted.result as BudgetedNodesResult;
  const budgetedBytes = new TextEncoder().encode(JSON.stringify(budgeted.result)).length;

  assert.equal(budgeted.ok, true);
  assert.equal(budgeted.meta.budget_applied, true);
  assert.equal(budgeted.meta.budget_truncated, true);
  assert.match(String(budgeted.meta.continuation_hint), /larger token budget|tighter params/);
  assert.ok(Array.isArray(budgetedResult.nodes));
  assert.ok(budgetedResult.nodes.length < result.nodes.length);
  assert.equal(budgetedResult.count, result.nodes.length);
  assert.equal(budgetedResult.total, result.nodes.length);
  assert.equal(budgetedResult.truncated, true);
  assert.ok(budgetedBytes < originalBytes);
  assert.ok(budgetedBytes <= 480);
});

test('enforceTokenBudget shrinks nested arrays through recursive object traversal', () => {
  const result = {
    section: {
      entries: Array.from({ length: 40 }, (_, index) => ({
        elementRef: `el_${index}`,
        role: 'button',
        name: `Action ${index}`,
      })),
      summary: 'Primary actions',
    },
  };
  const response = successResponse('req_budget_nested', result);

  const originalLength = result.section.entries.length;
  const budgeted = enforceTokenBudget('dom.query', response, 90);
  const budgetedResult = budgeted.result as BudgetedSectionResult;

  assert.equal(budgeted.ok, true);
  assert.equal(budgeted.meta.budget_applied, true);
  assert.equal(budgeted.meta.budget_truncated, true);
  assert.ok(Array.isArray(budgetedResult.section.entries));
  assert.ok(budgetedResult.section.entries.length < originalLength);
  assert.equal(budgetedResult.section.count, originalLength);
  assert.equal(budgetedResult.section.total, originalLength);
  assert.equal(budgetedResult.section.truncated, true);
  assert.equal(budgetedResult.truncated, true);
  assert.equal(result.section.entries.length, originalLength);
});

test('enforceTokenBudget leaves already-shrunk results stable on a second pass', () => {
  const response = successResponse('req_budget_stable', {
    nodes: Array.from({ length: 12 }, (_, index) => ({
      elementRef: `el_${index}`,
      text: `Node ${index} ${'x'.repeat(120)}`,
    })),
  });

  const firstPass = enforceTokenBudget('dom.query', response, 120);
  const secondPass = enforceTokenBudget('dom.query', firstPass, 120);

  assert.deepEqual(secondPass.result, firstPass.result);
  assert.equal(secondPass.meta.budget_applied, false);
  assert.equal(secondPass.meta.budget_truncated, false);
  assert.equal(secondPass.meta.continuation_hint, null);
});

test('enforceTokenBudget falls back to a compact continuation payload when fields remain oversized', () => {
  const result: OversizedResult = {
    value: 'x'.repeat(5000),
    extra: 'y'.repeat(5000),
  };
  const response = successResponse('req_budget_compact', result);

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
  assert.equal(result.extra.length, 5000);
  assert.equal(result.value.length, 5000);
});

test('enforceTokenBudget returns RESULT_TRUNCATED when even the compact fallback exceeds budget', () => {
  const method = `page.evaluate.${'x'.repeat(160)}`;
  const result: OversizedResult = {
    value: 'x'.repeat(5000),
    extra: 'y'.repeat(5000),
  };
  const response = successResponse('req_tiny_budget', result);

  const budgeted = enforceTokenBudget(method, response, 0.25);

  assert.equal(budgeted.ok, false);
  assert.equal(budgeted.result, null);
  assert.equal(budgeted.error.code, 'RESULT_TRUNCATED');
  assert.equal(budgeted.error.message, 'Result was truncated to fit the response budget.');
  assert.deepEqual(budgeted.error.details, {
    method,
    tokenBudget: 0.25,
  });
  assert.equal(budgeted.meta.protocol_version, PROTOCOL_VERSION);
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
  assert.equal(result.extra.length, 5000);
  assert.equal(result.value.length, 5000);
});
