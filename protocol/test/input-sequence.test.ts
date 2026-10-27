import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRequest,
  MAX_PERFORM_STEPS,
  MAX_TOUCH_POINTS,
  normalizeInputAction,
  normalizeInputPerformParams,
  normalizeTouchParams,
  sanitizeIncidentalUrl,
  summarizeBridgeResponse,
} from '../src/index.js';
import { makeSuccess as ok } from '../../tests/_helpers/protocolFactories.ts';

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
  assert.equal(normalized.returnLastResult, false);
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

test('input.perform normalizes bounded read steps and opt-in final evidence', () => {
  const normalized = normalizeInputPerformParams({
    returnLastResult: true,
    executionMode: 'cdp',
    steps: [
      { method: 'page.get_state' },
      { method: 'page.get_text', params: { textBudget: 400 } },
      { method: 'dom.query', params: { selector: '.result', maxNodes: 3, textBudget: 200 } },
      { method: 'dom.get_text', params: { target: { selector: '.result' }, textBudget: 300 } },
    ],
  });
  assert.equal(normalized.returnLastResult, true);
  assert.equal(normalized.steps[1].params.textBudget, 400);
  assert.equal((normalized.steps[2].params.budget as { maxNodes: number }).maxNodes, 3);
  assert.equal(normalized.steps[3].params.textBudget, 300);
  for (const step of normalized.steps) assert.equal(step.params.executionMode, undefined);
  assert.deepEqual(normalizeInputPerformParams(normalized), normalized);
});

test('input.perform keeps observation explicit and preserves the final action auto-wait', () => {
  const normalized = normalizeInputPerformParams({
    returnLastResult: true,
    steps: [
      { method: 'input.click', params: { target: { label: 'First' } } },
      { method: 'input.click', params: { target: { label: 'Last' }, observe: true } },
    ],
  });
  assert.equal(normalized.steps[0].params.observe, null);
  assert.deepEqual(normalized.steps[1].params.observe, { settleMs: 500 });
  assert.equal(normalized.steps[1].params.timeoutMs, 2_500);
});

test('input.perform normalizes bounded outcome conditions idempotently', () => {
  const normalized = normalizeInputPerformParams({
    steps: [{ method: 'input.click', params: { target: { role: 'button', name: 'Save' } } }],
    outcomes: [
      { kind: 'dom', selector: '[role="status"]', text: 'Saved' },
      { kind: 'url', url: '/done', urlMatch: 'contains' },
      { kind: 'network', urlPattern: '/api/save', method: 'post' },
    ],
  });
  assert.deepEqual(normalizeInputPerformParams(normalized), normalized);
  assert.deepEqual(normalized.outcomes?.[2], {
    kind: 'network',
    urlPattern: '/api/save',
    method: 'POST',
    statusMin: 200,
    statusMax: 299,
  });
});

test('network outcome patterns are written in the form captured URLs are sanitized to', () => {
  const pattern = (urlPattern: string) =>
    normalizeInputPerformParams({
      steps: [{ method: 'input.click' }],
      outcomes: [{ kind: 'network', urlPattern }],
    }).outcomes?.[0];
  for (const [raw, captured] of [
    ['/api/café', 'https://app.test/api/caf%C3%A9'],
    ['/a b?x y=', 'https://app.test/a%20b?x+y=%5Bredacted%5D&z=%5Bredacted%5D'],
    ['?k[0]=', 'https://app.test/list?k%5B0%5D=%5Bredacted%5D'],
    ['HTTPS://App.Test/API?id', 'https://app.test/API?id=%5Bredacted%5D'],
    ['&page=', 'https://app.test/list?a=1&page=2'],
    ['%5D&page', 'https://app.test/list?a=1&page=2'],
  ] as const) {
    const normalized = pattern(raw);
    assert.equal(normalized?.kind, 'network');
    if (normalized?.kind !== 'network') continue;
    assert.ok(
      sanitizeIncidentalUrl(captured).includes(normalized.urlPattern),
      `${raw} -> ${normalized.urlPattern}`
    );
    assert.deepEqual(pattern(normalized.urlPattern), normalized);
  }
  for (const [raw, message] of [
    ['/items?id=42', /query values are redacted/],
    ['/items?id=&page=', /query values are redacted/],
    ['/items?id&page', /query values are redacted/],
    ['&page=2', /query values are redacted/],
    ['id=1&page=', /query values are redacted/],
    ['/page#done', /fragment/],
    ['/bad\ud800', /well-formed/],
  ] as const)
    assert.throws(() => pattern(raw), { code: 'INVALID_REQUEST', message });
});

test('input.perform rejects malformed outcomes and ambiguous continue-on-error verification', () => {
  const steps = [{ method: 'input.click' }];
  for (const outcomes of [
    [],
    Array(9).fill({ kind: 'dom', selector: 'main' }),
    [null],
    [{ kind: 'other' }],
    [{ kind: 'dom' }],
    [{ kind: 'url', url: '' }],
    [{ kind: 'network', urlPattern: '' }],
    [{ kind: 'network', urlPattern: 'x'.repeat(501) }],
    [{ kind: 'network', urlPattern: '/api', method: 'bad method' }],
    [{ kind: 'network', urlPattern: '/api', statusMin: 300, statusMax: 200 }],
    [{ kind: 'network', urlPattern: '/api', statusMax: 600 }],
  ])
    assert.throws(() => normalizeInputPerformParams({ steps, outcomes } as never), {
      code: 'INVALID_REQUEST',
    });
  assert.throws(
    () =>
      normalizeInputPerformParams({
        steps,
        continueOnError: true,
        outcomes: [{ kind: 'dom', selector: 'main' }],
      }),
    { code: 'INVALID_REQUEST' }
  );
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
  for (const method of [
    'sensitive.read',
    'webmcp.execute_tool',
    'page.handle_dialog',
    'tabs.create',
  ]) {
    invalid({ steps: [{ method }] }, /steps\[0\]\.method must be one of/);
  }
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

  const withEffects = summarizeBridgeResponse(
    ok({
      performed: true,
      completed: 2,
      total: 2,
      elapsedMs: 200,
      lastResult: {
        method: 'input.click',
        result: { effects: { messages: [{ role: 'status', text: 'Saved' }] } },
        truncated: false,
      },
    }),
    'input.perform'
  );
  assert.match(withEffects.summary, /Effects: status: "Saved"/);
  assert.deepEqual((withEffects.evidence as Record<string, unknown>).lastResult, {
    method: 'input.click',
    result: { effects: { messages: [{ role: 'status', text: 'Saved' }] } },
    truncated: false,
  });
  const omitted = summarizeBridgeResponse(
    ok({ performed: true, lastResult: { method: 'page.get_text', truncated: true } }),
    'input.perform'
  );
  assert.match(omitted.summary, /Final result omitted: size limit exceeded/);
  assert.match(omitted.summary, /do not replay actions/);

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
