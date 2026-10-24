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

test('trimming entries older than the baseline keeps fresh evidence valid', async () => {
  const stale = Array.from({ length: 200 }, (_, sequence) => ({
    sequence,
    method: 'GET',
    url: '/poll',
    status: 200,
  }));
  for (const [evictedThrough, expected] of [
    [0, 'matched'],
    [200, 'interrupted'],
  ] as const) {
    let reads = 0;
    const monitor = await armPerformOutcomes(request(), 12, [condition], 1000, {
      dispatch: async (req) => createSuccess(req.id, {}),
      armNetwork: async () => {},
      readNetwork: async () =>
        reads++ === 0
          ? {
              cursor: { epoch: 'e', nextSequence: 200, generation: 0, evictedThrough: -1 },
              dropped: 50,
              entries: stale,
            }
          : {
              cursor: { epoch: 'e', nextSequence: 201, generation: 0, evictedThrough },
              dropped: 51,
              entries: [
                ...stale.slice(1),
                { sequence: 200, method: 'POST', url: '/api/save', status: 201 },
              ],
            },
    });
    try {
      assert.equal((await monitor.complete())[0].status, expected);
    } finally {
      monitor.stop();
    }
  }
});

test('a page read that never settles times out at the sequence deadline', async () => {
  let reads = 0;
  const monitor = await armPerformOutcomes(request(), 12, [condition], 50, {
    dispatch: async (req) => createSuccess(req.id, {}),
    armNetwork: async () => {},
    readNetwork: () =>
      reads++ === 0 ? Promise.resolve({ cursor, dropped: 0, entries: [] }) : new Promise(() => {}),
  });
  try {
    const [result] = await monitor.complete();
    assert.equal(result.status, 'timeout');
    assert.equal(result.evidence?.reason, 'deadline_elapsed');
  } finally {
    monitor.stop();
  }
});

test('cancellation abandons a hung page read during observation', async () => {
  let reads = 0;
  let reading!: () => void;
  const hung = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const monitor = await armPerformOutcomes(request(), 12, [condition], 120000, {
    dispatch: async (req) => createSuccess(req.id, {}),
    armNetwork: async () => {},
    readNetwork: () => {
      if (reads++ === 0) return Promise.resolve({ cursor, dropped: 0, entries: [] });
      reading();
      return new Promise(() => {});
    },
  });
  await hung;
  monitor.stop();
  assert.equal((await monitor.complete())[0].status, 'interrupted');
});

test('arming that never settles fails before any input runs', async () => {
  await assert.rejects(
    armPerformOutcomes(request(), 12, [condition], 50, {
      dispatch: async (req) => createSuccess(req.id, {}),
      armNetwork: () => new Promise(() => {}),
      readNetwork: async () => ({ cursor, dropped: 0, entries: [] }),
    }),
    /did not arm/
  );
});
