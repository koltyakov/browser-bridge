import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRequest,
  getBridgeOperationTimeoutMs,
  MAX_PERFORM_STEPS,
  MAX_TOUCH_POINTS,
  normalizeInputAction,
  normalizeInputPerformParams,
  normalizeTouchParams,
  summarizeBridgeResponse,
} from '../src/index.js';
import { makeSuccess as ok } from '../../../tests/_helpers/protocolFactories.ts';

test('holdMs is normalized for input actions and honors an explicit zero', () => {
  assert.equal(normalizeInputAction({}).holdMs, 0);
  assert.equal(normalizeInputAction({ holdMs: 250.4 }).holdMs, 250);
  assert.equal(normalizeInputAction({ holdMs: 60_000 }).holdMs, 10_000);
  assert.equal(normalizeInputAction({ holdMs: -5 }).holdMs, 0);
});

test('normalizeTouchParams accepts targets, points, and end positions', () => {
  const normalized = normalizeTouchParams({
    points: [
      { target: { selector: '#c' } },
      { x: 10, y: 20, to: { x: 30, y: 20 } },
      { target: { elementRef: 'el_1' }, to: { target: { selector: '#g' } } },
    ],
    executionMode: 'cdp',
  });
  assert.deepEqual(normalized, {
    points: [
      { target: { elementRef: undefined, selector: '#c' }, x: null, y: null, to: null },
      { target: null, x: 10, y: 20, to: { target: null, x: 30, y: 20 } },
      {
        target: { elementRef: 'el_1', selector: undefined },
        x: null,
        y: null,
        to: { target: { elementRef: undefined, selector: '#g' }, x: null, y: null },
      },
    ],
    holdMs: 50,
    moveSteps: 10,
    executionMode: 'cdp',
    recoverStale: false,
  });
  assert.equal(normalizeTouchParams({ points: [{ x: 1, y: 1 }], holdMs: 0 }).holdMs, 0);
  assert.deepEqual(normalizeTouchParams(normalized), normalized, 'normalization is idempotent');
});

test('normalizeTouchParams rejects malformed touch points', () => {
  const invalid = (params: Record<string, unknown>) =>
    assert.throws(() => normalizeTouchParams(params), { code: 'INVALID_REQUEST' });
  invalid({});
  invalid({ points: [] });
  invalid({ points: Array.from({ length: MAX_TOUCH_POINTS + 1 }, () => ({ x: 1, y: 1 })) });
  invalid({ points: ['#c'] });
  invalid({ points: [{ x: 1 }] });
  invalid({ points: [{ x: 1, y: 1, target: { selector: '#c' } }] });
  invalid({ points: [{ x: 1, y: 1, to: { x: Number.NaN, y: 1 } }] });
});

test('normalizeInputPerformParams normalizes each step with its own method normalizer', () => {
  const normalized = normalizeInputPerformParams({
    executionMode: 'cdp',
    timeoutMs: 5_000,
    steps: [
      { method: 'input.click', params: { target: { selector: '#a' }, holdMs: 80 }, atMs: 0 },
      { method: 'input.press_key', params: { key: 'q', executionMode: 'dom' }, delayMs: 100 },
      { method: 'dom.wait_for', params: { selector: '.done' } },
      { method: 'input.touch', params: { points: [{ x: 1, y: 2 }] }, atMs: 400 },
    ],
  });
  assert.equal(normalized.timeoutMs, 5_000);
  assert.equal(normalized.continueOnError, false);
  assert.deepEqual(
    normalized.steps.map((step) => [step.method, step.delayMs, step.atMs]),
    [
      ['input.click', 0, 0],
      ['input.press_key', 100, null],
      ['dom.wait_for', 0, null],
      ['input.touch', 0, 400],
    ]
  );
  assert.equal(normalized.steps[0].params.executionMode, 'cdp');
  assert.equal(normalized.steps[0].params.holdMs, 80);
  assert.equal(normalized.steps[1].params.executionMode, 'dom', 'explicit step mode wins');
  assert.equal(normalized.steps[2].params.executionMode, undefined);
  assert.equal(normalized.steps[2].params.timeoutMs, 5_000);
  assert.deepEqual(normalizeInputPerformParams(normalized), normalized, 'idempotent');
});

test('normalizeInputPerformParams rejects unsafe or malformed sequences', () => {
  const invalid = (params: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(
      () => normalizeInputPerformParams(params),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'INVALID_REQUEST');
        assert.match((error as Error).message, pattern);
        return true;
      }
    );
  invalid({}, /steps must be an array/);
  invalid({ steps: [] }, /steps must be an array/);
  invalid(
    { steps: Array.from({ length: MAX_PERFORM_STEPS + 1 }, () => ({ method: 'input.click' })) },
    /steps must be an array/
  );
  invalid({ steps: [null] }, /steps\[0\] must be an object/);
  invalid({ steps: [{ method: 'page.evaluate' }] }, /steps\[0\]\.method must be one of/);
  invalid({ steps: [{ method: 'input.perform' }] }, /steps\[0\]\.method must be one of/);
  invalid({ steps: [{ method: 'input.click', params: [] }] }, /steps\[0\]\.params/);
  invalid({ steps: [{ method: 'input.click', delayMs: -1 }] }, /delayMs must be a number/);
  invalid(
    { timeoutMs: 1_000, steps: [{ method: 'input.click', atMs: 2_000 }] },
    /atMs must be a number between 0 and the sequence timeoutMs \(1000\)/
  );
  invalid({ steps: [{ method: 'input.click', delayMs: 10, atMs: 10 }] }, /either delayMs or atMs/);
  invalid({ executionMode: 'native', steps: [{ method: 'input.click' }] }, /executionMode/);
  invalid(
    { steps: [{ method: 'input.touch', params: { points: [] } }] },
    /points must be an array/
  );
});

test('createRequest validates input.perform at the protocol boundary', () => {
  assert.throws(
    () => createRequest({ id: 'bad', method: 'input.perform', params: { steps: [] } }),
    { code: 'INVALID_REQUEST' }
  );
});

test('operation timeouts cover sequences and held input', () => {
  assert.equal(
    getBridgeOperationTimeoutMs('input.perform', { steps: [{ method: 'input.click' }] }),
    30_000
  );
  assert.equal(
    getBridgeOperationTimeoutMs('input.perform', {
      timeoutMs: 90_000,
      steps: [{ method: 'input.click' }],
    }),
    90_000
  );
  assert.equal(getBridgeOperationTimeoutMs('input.click', {}), null);
  assert.equal(getBridgeOperationTimeoutMs('input.click', { holdMs: 2_000 }), 7_000);
  assert.equal(getBridgeOperationTimeoutMs('input.press_key', { holdMs: 1_000 }), 6_000);
  assert.equal(getBridgeOperationTimeoutMs('input.touch', { points: [{ x: 1, y: 1 }] }), 5_050);
});

test('summaries describe sequences, touch gestures, waits, and large evaluate values compactly', () => {
  const performed = summarizeBridgeResponse(
    ok({
      performed: true,
      completed: 7,
      total: 7,
      elapsedMs: 2_430,
      startedAtMs: [0, 404, 807, 1211, 1615, 2019, 2422],
      failures: [],
    }),
    'input.perform'
  );
  assert.equal(performed.summary, 'Performed 7/7 step(s) in 2430ms.');

  const partial = summarizeBridgeResponse(
    ok({ performed: true, completed: 3, total: 3, elapsedMs: 10, startedAtMs: [], failures: [{}] }),
    'input.perform'
  );
  assert.match(partial.summary, /with 1 failed step\(s\)/);

  const touched = summarizeBridgeResponse(
    ok({ touched: true, pointCount: 3, execution: { actualMode: 'cdp' } }),
    'input.touch'
  );
  assert.equal(touched.summary, 'Touched 3 point(s) via cdp.');

  const waited = summarizeBridgeResponse(
    ok({
      method: 'page.wait_for_load_state',
      tabId: 7,
      url: 'https://example.test/',
      status: 'complete',
    })
  );
  assert.equal(waited.summary, 'Tab 7 complete (https://example.test/).');
  for (const [method, text] of [
    ['navigation.reload', 'Reloaded tab 7'],
    ['navigation.go_back', 'Navigated back in tab 7'],
    ['navigation.go_forward', 'Navigated forward in tab 7'],
    ['tabs.activate', 'Tab 7 activated'],
  ]) {
    const summary = summarizeBridgeResponse(ok({ method, tabId: 7, url: 'https://x.test/' }));
    assert.match(summary.summary, new RegExp(`^${text}`));
  }

  const large = {
    rows: Array.from({ length: 40 }, (_, index) => ({ index, label: `row ${index}` })),
  };
  const evaluated = summarizeBridgeResponse(ok({ value: large, type: 'object' }));
  assert.match(evaluated.summary, /^Evaluated to object: 1 key\(s\), \d+ chars as JSON/);
  assert.ok(evaluated.summary.length < 120);
  const list = summarizeBridgeResponse(ok({ value: large.rows, type: 'object' }));
  assert.match(list.summary, /40 item\(s\)/);
  const longText = summarizeBridgeResponse(ok({ value: 'x'.repeat(500), type: 'string' }));
  assert.match(longText.summary, /^Evaluated to string: 500 chars, starts "x{80}"…$/);
  const small = summarizeBridgeResponse(ok({ value: { a: 1 }, type: 'object' }));
  assert.equal(small.summary, 'Evaluated to object: {"a":1}');
});
