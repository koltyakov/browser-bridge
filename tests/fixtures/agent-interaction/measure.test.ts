import assert from 'node:assert/strict';
import test from 'node:test';
import { latencyPercentiles, measureScenario, outlineText } from './measure.mjs';
import type { BridgeResponse, Scenario } from './measure.mjs';

test('outline verification accepts compact MCP evidence and raw bridge results', () => {
  const text = '- button "Save" [el_test_1]';
  assert.equal(outlineText(text), text);
  assert.equal(outlineText({ outline: text }), text);
  assert.equal(outlineText({ outline: 1 }), '');
  assert.equal(outlineText(null), '');
});

test('interaction measurements exclude ground-truth verification from action costs', async () => {
  let now = 0;
  const scenario: Scenario = {
    name: 'save',
    run: (call) => call('input.click', { target: { role: 'button', name: 'Save' } }),
    verify: (state, last) => state.saved === true && last?.ok === true,
  };
  const result = await measureScenario(
    scenario,
    async (method) => {
      if (method === 'input.click') {
        now += 20;
        return { ok: true, result: { clicked: true }, tokens: 40 };
      }
      now += 90;
      return { ok: true, result: { 'data-state': '{"saved":true}' }, tokens: 80 };
    },
    () => now
  );
  assert.deepEqual(result, {
    scenario: 'save',
    ok: true,
    calls: 1,
    tokens: 40,
    ms: 20,
    verification: { calls: 1, tokens: 80, ms: 90 },
  });
});

test('failed input cannot pass from stale fixture state, and verification failures stay separate', async () => {
  const scenario: Scenario = {
    name: 'failure',
    run: (call) => call('input.click'),
    verify: () => true,
  };
  const failed: BridgeResponse = {
    ok: false,
    result: null,
    tokens: 5,
    error: { code: 'TIMEOUT', message: 'late' },
  };
  const result = await measureScenario(
    scenario,
    async (method) =>
      method === 'input.click' ? failed : { ok: true, result: { 'data-state': '{}' }, tokens: 10 },
    () => 0
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'TIMEOUT');
  assert.equal(result.tokens, 5);
  const verification = await measureScenario(
    scenario,
    async (method) => (method === 'input.click' ? { ok: true, result: {}, tokens: 3 } : failed),
    () => 0
  );
  assert.equal(verification.ok, false);
  assert.equal(verification.tokens, 3);
  assert.equal(verification.verification.tokens, 5);
  assert.match(verification.error ?? '', /Verification failed/);
});

test('measurement reports thrown action and verification errors without mixing costs', async () => {
  const scenario: Scenario = {
    name: 'throw',
    run: (call) => call('input.click'),
    verify: () => true,
  };
  const action = await measureScenario(
    scenario,
    async () => {
      throw new Error('action failed');
    },
    () => 0
  );
  assert.equal(action.error, 'action failed');
  assert.equal(action.calls, 1);
  assert.equal(action.verification.calls, 0);
  const verification = await measureScenario(
    scenario,
    async (method) => {
      if (method === 'dom.get_attributes') throw new Error('verification failed');
      return { ok: true, result: {}, tokens: 10 };
    },
    () => 0
  );
  assert.equal(verification.error, 'verification failed');
  assert.equal(verification.tokens, 10);
  assert.equal(verification.verification.calls, 1);
});

test('latency percentiles use nearest ranks without mutating samples', () => {
  const samples = [100, 1, 10, 2];
  assert.deepEqual(latencyPercentiles(samples), { p50: 2, p95: 100 });
  assert.deepEqual(samples, [100, 1, 10, 2]);
  assert.deepEqual(latencyPercentiles([]), { p50: 0, p95: 0 });
});
