import test from 'node:test';
import assert from 'node:assert/strict';
import { armPerformOutcomes } from '../src/background-outcomes.js';
import { createFailure, createRequest, createSuccess } from '../../../protocol/src/index.js';
import type { NormalizedPerformOutcome } from '../../../protocol/src/types.js';

const condition: NormalizedPerformOutcome = {
  kind: 'network',
  urlPattern: '/api/save',
  method: 'POST',
  statusMin: 200,
  statusMax: 299,
};
const cursor = { epoch: 'first', nextSequence: 0, generation: 0 };
const request = () =>
  createRequest({
    id: crypto.randomUUID(),
    method: 'input.perform',
    params: { steps: [{ method: 'input.click' }] },
  });

test('fresh response evidence is latched and remains explicitly untrusted', async () => {
  let reads = 0;
  const monitor = await armPerformOutcomes(request(), 12, [condition], 1000, {
    dispatch: async (req) => createSuccess(req.id, {}),
    armNetwork: async () => {},
    readNetwork: async () => ({
      cursor: { ...cursor, nextSequence: reads++ ? 1 : 0 },
      dropped: 0,
      entries: reads > 1 ? [{ sequence: 0, method: 'POST', url: '/api/save', status: 201 }] : [],
    }),
  });
  try {
    const results = await monitor.complete();
    assert.equal(results[0].status, 'matched');
    assert.equal(results[0].evidence?.integrity, 'untrusted');
    assert.equal(results[0].evidence?.status, 201);
  } finally {
    monitor.stop();
  }
});

test('network observation reports buffer clears and dropped events as incomplete evidence', async () => {
  for (const reset of ['clear', 'drop', 'error']) {
    let reads = 0;
    const monitor = await armPerformOutcomes(request(), 12, [condition], 1000, {
      dispatch: async (req) => createSuccess(req.id, {}),
      armNetwork: async () => {},
      readNetwork: async () => {
        const later = reads++ > 0;
        if (later && reset === 'error') throw new Error('read failed');
        return {
          cursor: { ...cursor, generation: later && reset === 'clear' ? 1 : 0 },
          dropped: later && reset === 'drop' ? 1 : 0,
          entries: [],
        };
      },
    });
    try {
      assert.equal((await monitor.complete())[0].status, 'interrupted');
    } finally {
      monitor.stop();
    }
  }
});

test('stopping observation cancels its wait without waiting for the deadline', async () => {
  const monitor = await armPerformOutcomes(request(), 12, [condition], 120000, {
    dispatch: async (req) => createSuccess(req.id, {}),
    armNetwork: async () => {},
    readNetwork: async () => ({ cursor, dropped: 0, entries: [] }),
  });
  monitor.stop();
  assert.equal((await monitor.complete())[0].status, 'interrupted');
});

test('DOM and URL failures are reported separately without fabricating evidence', async () => {
  const conditions: NormalizedPerformOutcome[] = [
    { kind: 'dom', selector: '#done', text: 'Saved', state: 'visible', timeoutMs: 1000 },
    { kind: 'url', url: '/done', urlMatch: 'contains', waitForLoad: false, timeoutMs: 1000 },
  ];
  const monitor = await armPerformOutcomes(request(), 12, conditions, 1000, {
    dispatch: async (req) =>
      req.method === 'dom.wait_for'
        ? createSuccess(req.id, { found: false })
        : createFailure(req.id, 'ACCESS_DENIED', 'revoked'),
  });
  try {
    assert.deepEqual(
      (await monitor.complete()).map((result) => result.status),
      ['timeout', 'interrupted']
    );
  } finally {
    monitor.stop();
  }
});

test('invalid network cursors fail before dispatching any input', async () => {
  await assert.rejects(
    armPerformOutcomes(request(), 12, [condition], 1000, {
      dispatch: async (req) => createSuccess(req.id, {}),
      armNetwork: async () => {},
      readNetwork: async () => ({ dropped: 0, entries: [] }),
    }),
    /could not be armed/
  );
});
