import test from 'node:test';
import assert from 'node:assert/strict';

import { executeInputPerform } from '../src/background-perform.js';
import {
  createFailure,
  createRequest,
  createSuccess,
  getUtf8ByteLength,
  MAX_PERFORM_RESULT_BYTES,
} from '../../../protocol/src/index.js';
import type { BridgeRequest, BridgeResponse, PerformResult } from '../../../protocol/src/types.js';
import { captureWindowGrant } from '../src/background-access.js';
import type { EnabledWindowContainer } from '../src/background-access.js';

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

test('input.perform stops on a native dialog even with continueOnError', async () => {
  const { dependencies, dispatched } = createHarness((request) =>
    createFailure(request.id, 'DIALOG_BLOCKED', 'A JavaScript dialog blocked the operation.', {
      dialogId: 'observed-dialog',
      outcomeUncertain: true,
    })
  );
  const response = await executeInputPerform(
    performRequest({ continueOnError: true, steps: [click('#edit'), click('#save')] }),
    dependencies
  );
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, 'DIALOG_BLOCKED');
  assert.equal(response.error?.recovery?.retry, false);
  assert.equal(dispatched.length, 1);
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

test('input.perform does not dispatch an overdue atMs step after a slow action', async () => {
  const { dependencies, dispatched } = createHarness(undefined, 200);
  const response = await executeInputPerform(
    performRequest({
      timeoutMs: 100,
      steps: [
        { ...click('#first'), atMs: 0 },
        { ...click('#second'), atMs: 1 },
      ],
    }),
    dependencies
  );
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, 'TIMEOUT');
  assert.equal(dispatched.length, 1);
  const details = response.error?.details as { completed?: number } | undefined;
  assert.equal(details?.completed, 1);
});

test('input.perform rechecks the deadline after a delayed timer wakes up', async () => {
  let clock = 0;
  let dispatches = 0;
  const response = await executeInputPerform(
    performRequest({ timeoutMs: 100, steps: [{ ...click('#late'), atMs: 50 }] }),
    {
      now: () => clock,
      sleep: async () => {
        clock = 200;
      },
      resolveRequestTarget: async () => ({ tabId: 42 }),
      dispatch: async (request) => {
        dispatches += 1;
        return createSuccess(request.id, {});
      },
    }
  );
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, 'TIMEOUT');
  assert.equal(dispatches, 0);
});

test('input.perform does not continue under a replacement grant after a delay', async () => {
  const { dependencies, dispatched } = createHarness();
  const state: EnabledWindowContainer = {
    enabledWindow: { windowId: 5, enabledAt: 1, title: 'First grant' },
  };
  const response = await executeInputPerform(
    performRequest({ steps: [click('#first'), { ...click('#second'), delayMs: 10 }] }),
    {
      ...dependencies,
      captureAccess: () => captureWindowGrant(state),
      sleep: async (ms) => {
        await dependencies.sleep(ms);
        state.enabledWindow = { windowId: 5, enabledAt: 2, title: 'Replacement grant' };
      },
    }
  );
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, 'ACCESS_DENIED');
  assert.equal(dispatched.length, 1);
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

test('input.perform returns only the final read and preserves routing and request metadata', async () => {
  const finalResult = { text: 'Saved', truncated: false };
  const { dependencies, dispatched } = createHarness((request) =>
    createSuccess(request.id, request.method === 'dom.get_text' ? finalResult : { clicked: true })
  );
  const request = performRequest({
    returnLastResult: true,
    steps: [
      click('#save'),
      { method: 'dom.wait_for', params: { text: 'Saved' } },
      { method: 'dom.get_text', params: { target: { selector: '#status' }, textBudget: 200 } },
    ],
  });
  const response = await executeInputPerform(request, dependencies);
  assert.equal(response.ok, true);
  assert.deepEqual((response.result as PerformResult).lastResult, {
    index: 2,
    method: 'dom.get_text',
    byteLength: getUtf8ByteLength(JSON.stringify(finalResult)),
    truncated: false,
    result: finalResult,
  });
  for (const entry of dispatched) {
    assert.equal(entry.request.tab_id, 42);
    assert.deepEqual(entry.request.meta, request.meta);
  }
});

test('input.perform can return final action effects without an extra read', async () => {
  const finalResult = {
    clicked: true,
    effects: { messages: [{ role: 'status', text: 'Saved' }] },
  };
  const { dependencies, dispatched } = createHarness((request) =>
    createSuccess(request.id, finalResult)
  );
  const response = await executeInputPerform(
    performRequest({
      returnLastResult: true,
      steps: [{ method: 'input.click', params: { target: { label: 'Save' }, observe: true } }],
    }),
    dependencies
  );
  const lastResult = (response.result as PerformResult).lastResult;
  assert.equal(lastResult?.truncated, false);
  if (lastResult && !lastResult.truncated) assert.deepEqual(lastResult.result, finalResult);
  assert.deepEqual(dispatched[0].request.params.observe, { settleMs: 500 });
});

test('input.perform bounds final evidence by UTF-8 JSON bytes without replaying steps', async () => {
  // Multibyte text fits in the character limit, but exceeds the byte limit.
  const finalResult = { text: '界'.repeat(Math.floor(MAX_PERFORM_RESULT_BYTES / 2)) };
  const { dependencies, dispatched } = createHarness((request) =>
    createSuccess(request.id, finalResult)
  );
  const response = await executeInputPerform(
    performRequest({
      returnLastResult: true,
      steps: [click('#save'), { method: 'page.get_text', params: { textBudget: 20_000 } }],
    }),
    dependencies
  );
  assert.equal(response.ok, true);
  assert.equal(dispatched.length, 2);
  assert.deepEqual((response.result as PerformResult).lastResult, {
    index: 1,
    method: 'page.get_text',
    byteLength: getUtf8ByteLength(JSON.stringify(finalResult)),
    truncated: true,
    maxBytes: MAX_PERFORM_RESULT_BYTES,
  });
});

test('input.perform retains final evidence exactly at the byte limit', async () => {
  const finalResult = { text: 'x'.repeat(MAX_PERFORM_RESULT_BYTES - '{"text":""}'.length) };
  const { dependencies } = createHarness((request) => createSuccess(request.id, finalResult));
  const response = await executeInputPerform(
    performRequest({ returnLastResult: true, steps: [{ method: 'page.get_text' }] }),
    dependencies
  );
  const lastResult = (response.result as PerformResult).lastResult;
  assert.equal(lastResult?.truncated, false);
  assert.equal(lastResult?.byteLength, MAX_PERFORM_RESULT_BYTES);
});

test('input.perform never substitutes an earlier success for a failed final step', async () => {
  for (const continueOnError of [false, true]) {
    const { dependencies } = createHarness((request) =>
      request.id === 'seq#1'
        ? createFailure(request.id, 'ACCESS_DENIED', 'Read capability denied.')
        : createSuccess(request.id, { clicked: true })
    );
    const response = await executeInputPerform(
      performRequest({
        returnLastResult: true,
        continueOnError,
        steps: [click('#save'), { method: 'page.get_text' }],
      }),
      dependencies
    );
    assert.equal(response.ok, continueOnError);
    if (response.ok) {
      assert.equal((response.result as PerformResult).lastResult, undefined);
      assert.equal((response.result as PerformResult).failures[0].code, 'ACCESS_DENIED');
    } else {
      assert.equal(response.error.code, 'ACCESS_DENIED');
    }
  }
});
