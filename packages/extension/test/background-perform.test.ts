import test from 'node:test';
import assert from 'node:assert/strict';

import { executeInputPerform } from '../src/background-perform.js';
import { createFailure, createRequest, createSuccess } from '../../protocol/src/index.js';
import type { BridgeRequest, BridgeResponse } from '../../protocol/src/types.js';

type StepHandler = (request: BridgeRequest, at: number) => BridgeResponse;

/**
 * Drive executeInputPerform with a virtual clock: sleeping advances time, and
 * each dispatched step costs `stepCostMs`.
 */
function createHarness(handler?: StepHandler, stepCostMs = 5) {
  let clock = 1_000;
  const dispatched: Array<{ request: BridgeRequest; at: number }> = [];
  const dependencies = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    resolveRequestTarget: async () => ({ tabId: 42 }),
    dispatch: async (request: BridgeRequest) => {
      const at = clock - 1_000;
      dispatched.push({ request, at });
      clock += stepCostMs;
      return handler
        ? handler(request, at)
        : createSuccess(request.id, { clicked: true }, { method: request.method });
    },
  };
  return { dependencies, dispatched };
}

function performRequest(params: Record<string, unknown>): BridgeRequest {
  return createRequest({ id: 'seq', method: 'input.perform', params });
}

const click = (selector: string) => ({
  method: 'input.click',
  params: { target: { selector } },
});

test('input.perform schedules atMs steps from the sequence start without drift', async () => {
  const { dependencies, dispatched } = createHarness();
  const response = await executeInputPerform(
    performRequest({
      steps: [
        { ...click('[data-midi="60"]'), atMs: 0 },
        { ...click('[data-midi="62"]'), atMs: 400 },
        { ...click('[data-midi="64"]'), atMs: 800 },
      ],
    }),
    dependencies
  );

  assert.equal(response.ok, true);
  assert.deepEqual(
    dispatched.map((entry) => entry.at),
    [0, 400, 800]
  );
  assert.deepEqual(response.result, {
    performed: true,
    completed: 3,
    total: 3,
    elapsedMs: 805,
    startedAtMs: [0, 400, 800],
    failures: [],
  });
  assert.deepEqual(
    dispatched.map((entry) => [entry.request.id, entry.request.tab_id]),
    [
      ['seq#0', 42],
      ['seq#1', 42],
      ['seq#2', 42],
    ]
  );
});

test('input.perform delayMs waits after the previous step and applies the sequence executionMode', async () => {
  const { dependencies, dispatched } = createHarness();
  const response = await executeInputPerform(
    performRequest({
      executionMode: 'cdp',
      steps: [
        click('#a'),
        { ...click('#b'), delayMs: 100 },
        { method: 'input.focus', params: { target: { selector: '#c' } }, delayMs: 10 },
      ],
    }),
    dependencies
  );

  assert.equal(response.ok, true);
  assert.deepEqual(
    dispatched.map((entry) => entry.at),
    [0, 105, 120]
  );
  assert.equal(dispatched[0].request.params.executionMode, 'cdp');
  assert.equal(dispatched[2].request.params.executionMode, 'dom', 'focus has no CDP path');
});

test('input.perform stops at the first failed step and reports progress', async () => {
  const { dependencies, dispatched } = createHarness((request) =>
    request.id === 'seq#1'
      ? createFailure(request.id, 'ELEMENT_NOT_FOUND', 'Input target was not found.', {
          selector: '#missing',
        })
      : createSuccess(request.id, { clicked: true })
  );
  const response = await executeInputPerform(
    performRequest({ steps: [click('#a'), click('#missing'), click('#c')] }),
    dependencies
  );

  assert.equal(response.ok, false);
  assert.equal(dispatched.length, 2);
  assert.equal(response.error?.code, 'ELEMENT_NOT_FOUND');
  assert.match(response.error?.message ?? '', /^Step 1 \(input\.click\) failed:/);
  assert.deepEqual(response.error?.details, {
    completed: 1,
    total: 3,
    elapsedMs: 10,
    startedAtMs: [0, 5],
    failedStep: {
      index: 1,
      method: 'input.click',
      code: 'ELEMENT_NOT_FOUND',
      message: 'Input target was not found.',
      details: { selector: '#missing' },
    },
  });
});

test('input.perform continueOnError records failures, including unmet dom.wait_for conditions', async () => {
  const { dependencies, dispatched } = createHarness((request) =>
    request.method === 'dom.wait_for'
      ? createSuccess(request.id, { found: false, duration: 250 })
      : createSuccess(request.id, { clicked: true })
  );
  const response = await executeInputPerform(
    performRequest({
      continueOnError: true,
      timeoutMs: 1_000,
      steps: [
        { method: 'dom.wait_for', params: { selector: '.ready', timeoutMs: 5_000 } },
        click('#after'),
      ],
    }),
    dependencies
  );

  assert.equal(response.ok, true);
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[0].request.params.timeoutMs, 1_000, 'waits are capped by the budget');
  const result = response.result as { failures: Array<Record<string, unknown>> };
  assert.deepEqual(result.failures, [
    {
      index: 0,
      method: 'dom.wait_for',
      code: 'TIMEOUT',
      message: 'Condition not met within 250ms.',
    },
  ]);
});

test('input.perform fails with TIMEOUT when a step is scheduled past the budget', async () => {
  const { dependencies, dispatched } = createHarness();
  const response = await executeInputPerform(
    performRequest({
      timeoutMs: 500,
      steps: [
        { ...click('#a'), atMs: 0 },
        { ...click('#b'), atMs: 500 },
      ],
    }),
    dependencies
  );

  assert.equal(response.ok, false);
  assert.equal(response.error?.code, 'TIMEOUT');
  assert.equal(dispatched.length, 1);
  assert.deepEqual(response.error?.details, {
    completed: 1,
    total: 2,
    elapsedMs: 5,
    startedAtMs: [0],
  });
});

test('input.perform uses real timers by default', async () => {
  const { dependencies } = createHarness();
  const started = performance.now();
  const response = await executeInputPerform(
    performRequest({ steps: [click('#a'), { ...click('#b'), delayMs: 20 }] }),
    {
      resolveRequestTarget: dependencies.resolveRequestTarget,
      dispatch: async (request: BridgeRequest) => createSuccess(request.id, { clicked: true }),
    }
  );
  assert.equal(response.ok, true);
  assert.ok(performance.now() - started >= 15);
});
