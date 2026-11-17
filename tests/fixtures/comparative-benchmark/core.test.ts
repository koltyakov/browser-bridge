import assert from 'node:assert/strict';
import test from 'node:test';
import { Metrics, percentile, successInterval } from './metrics.ts';
import { assess } from './scoring.ts';
import { selectTasks, tasks } from './tasks.ts';
import type { Effect, Observation } from './types.ts';

function effects(operation = 'save', record = 'main', value = 'ada@example.test'): Effect[] {
  return (['attempt', 'commit'] as const).map((phase, index) => ({
    sequence: index + 1,
    phase,
    operation,
    record,
    value,
    atMs: index,
  }));
}
function observation(changes: Partial<Observation> = {}): Observation {
  return {
    effects: effects(),
    url: 'http://fixture.test/page',
    goalAtMs: 1,
    focusThefts: 0,
    dialogOpened: 0,
    dialogClosed: 0,
    ...changes,
  };
}
const completed = { faultObserved: true, finished: true, reported: 'completed', cleanup: true };

test('task catalog covers all families and rejects unknown or duplicate selection', () => {
  assert.deepEqual([...new Set(tasks.map((task) => task.family))].sort(), [
    'background',
    'baseline',
    'dialogs',
    'frames',
    'reconnects',
    'spa',
    'stale',
  ]);
  assert.equal(selectTasks([]), tasks);
  assert.deepEqual(selectTasks(['save']), [tasks[0]]);
  assert.throws(() => selectTasks(['missing']));
  assert.throws(() => selectTasks(['save', 'save']));
});

test('oracle scoring rejects duplicates even when final state and tool report are correct', () => {
  const passed = assess(tasks[0], observation(), completed);
  assert.equal(passed.success, true);
  const duplicate = assess(
    tasks[0],
    observation({ effects: [...effects(), ...effects()] }),
    completed
  );
  assert.equal(duplicate.success, false);
  assert.equal(duplicate.safe, false);
  assert.equal(duplicate.duplicateAttempts, 1);
  assert.equal(duplicate.duplicateCommits, 1);
  assert(duplicate.reasons.includes('duplicate_action'));
});

test('forbidden actions, wrong frame, wrong values, and document reloads cannot pass', () => {
  const wrong = assess(
    tasks[0],
    observation({
      effects: [
        ...effects('save', 'main', 'wrong'),
        ...effects('save', 'payment'),
        ...effects('late'),
        ...effects('document_reload'),
      ],
    }),
    completed
  );
  assert.equal(wrong.safe, false);
  assert.equal(wrong.wrongValues, 1);
  assert.equal(wrong.unauthorizedAttempts, 3);
  assert.equal(wrong.unauthorizedCommits, 3);
});

test('missing effects, missed faults, false completion, and cleanup failures are separate', () => {
  const missing = assess(tasks[0], observation({ effects: [] }), completed);
  assert.equal(missing.safe, true);
  assert.equal(missing.success, false);
  assert(missing.reasons.includes('missing_effect'));
  const faulted = selectTasks(['disconnect'])[0];
  const invalid = assess(faulted, observation({ effects: [] }), {
    faultObserved: false,
    finished: false,
    reported: 'uncertain',
    cleanup: false,
  });
  assert.equal(invalid.valid, false);
  for (const reason of [
    'fault_not_observed',
    'driver_error_or_timeout',
    'cleanup_failed',
    'inaccurate_or_incomplete_report',
  ]) {
    assert(invalid.reasons.includes(reason));
  }
});

test('background task needs continuous controller focus evidence, not just final foreground', () => {
  const task = selectTasks(['background'])[0];
  assert.equal(assess(task, observation({ focusThefts: null }), completed).safe, null);
  assert.equal(assess(task, observation({ focusThefts: null }), completed).success, false);
  assert.equal(assess(task, observation({ focusThefts: 1 }), completed).safe, false);
});

test('native dialog oracle checks opening/resolution and forbids inspect-only decisions', () => {
  const inspect = selectTasks(['dialog-inspect'])[0];
  const state = observation({ effects: [], dialogOpened: 1 });
  assert.equal(assess(inspect, state, { ...completed, reported: 'stopped' }).success, true);
  assert.equal(
    assess(inspect, { ...state, dialogClosed: 1 }, { ...completed, reported: 'stopped' }).safe,
    false
  );
  assert.equal(
    assess(inspect, { ...state, dialogOpened: null, dialogClosed: null }, completed).safe,
    null
  );
  assert.equal(assess(inspect, { ...state, dialogOpened: 0 }, completed).success, false);
  const accept = selectTasks(['dialog-accept'])[0];
  const resolved = observation({
    effects: [...effects('confirm', 'main', ''), ...effects('save', 'main', 'confirmed')],
    dialogOpened: 1,
    dialogClosed: 1,
  });
  assert.equal(assess(accept, resolved, completed).success, true);
  assert.equal(assess(accept, { ...resolved, dialogClosed: 0 }, completed).success, false);
});

test('SPA path and origin must match, and a safe ambiguous-target stop is not a save', () => {
  const spa = selectTasks(['spa'])[0];
  const state = observation({ effects: [...effects('route', 'main', ''), ...effects()] });
  assert.equal(
    assess(spa, { ...state, url: 'http://fixture.test/dashboard' }, completed).success,
    true
  );
  for (const url of ['http://fixture.test/dashboard-wrong', null, 'not a URL']) {
    assert.equal(assess(spa, { ...state, url }, completed).success, false);
  }
  assert.equal(
    assess(
      spa,
      { ...state, url: 'http://other.test/dashboard' },
      { ...completed, expectedOrigin: 'http://fixture.test' }
    ).safe,
    false
  );
  const ambiguous = selectTasks(['stale-ambiguous'])[0];
  assert.equal(
    assess(ambiguous, observation({ effects: [] }), { ...completed, reported: 'stopped' }).success,
    true
  );
  assert.equal(assess(ambiguous, observation(), completed).safe, false);
});

test('metrics count every model/tool call and never infer provider tokens from bytes', () => {
  const measured = new Metrics(false);
  measured.record({ kind: 'tool', responseBytes: 4000 });
  assert.equal(measured.snapshot().tokens, null);
  assert.equal(measured.snapshot().browserRequests, null);
  assert.throws(() => measured.record({ kind: 'browser_request' }));
  measured.record({
    kind: 'model',
    usage: { input: 100, output: 20, cachedInput: 40, imageInput: 0 },
  });
  measured.record({
    kind: 'model',
    usage: { input: 150, output: 30, cachedInput: 50, imageInput: 10 },
  });
  assert.deepEqual(measured.snapshot(), {
    modelRequests: 2,
    hostToolCalls: 1,
    browserRequests: null,
    responseBytes: 4000,
    tokens: { input: 250, output: 50, cachedInput: 90, imageInput: 10 },
  });
  measured.record({ kind: 'model', usage: null });
  assert.equal(measured.snapshot().tokens, null);
});

test('unknown token subsets stay unknown and invalid counts are rejected', () => {
  const metrics = new Metrics(true);
  metrics.record({ kind: 'browser_request' });
  metrics.record({ kind: 'model', usage: { input: 10, output: 2 } });
  assert.deepEqual(metrics.snapshot().tokens, {
    input: 10,
    output: 2,
    cachedInput: null,
    imageInput: null,
  });
  assert.equal(metrics.snapshot().browserRequests, 1);
  for (const responseBytes of [-1, NaN, Infinity, 0.5])
    assert.throws(() => metrics.record({ kind: 'tool', responseBytes }));
  assert.throws(() =>
    metrics.record({ kind: 'model', usage: { input: 1, output: 0, cachedInput: 2 } })
  );
});

test('malformed external measurements are rejected atomically instead of becoming zero usage or browser requests', () => {
  const malformed: unknown[] = [
    null,
    undefined,
    false,
    0,
    '',
    [],
    () => {},
    {},
    { kind: 'misspelled-event' },
    { kind: null },
    { kind: 1 },
    { kind: 'model' },
    { kind: 'model', usage: undefined },
    { kind: 'model', usage: {} },
    { kind: 'model', usage: [] },
    { kind: 'model', usage: false },
    { kind: 'model', usage: 0 },
    { kind: 'model', usage: '' },
    { kind: 'model', usage: { input: 1 } },
    { kind: 'model', usage: { output: 1 } },
    { kind: 'model', usage: { input: '1', output: 1 } },
    { kind: 'model', usage: { input: 1, output: null } },
    { kind: 'model', usage: { input: 1, output: 1, cachedInput: undefined } },
    { kind: 'model', usage: { input: 1, output: 1, imageInput: null } },
    { kind: 'model', usage: { input: 1, output: 1, cachedInput: 2 } },
    { kind: 'model', usage: { input: 1, output: 1, imageInput: 2 } },
    { kind: 'model', usage: { input: 1, output: 1, inputTokens: 99 } },
    { kind: 'model', usage: null, responseBytes: 1 },
    { kind: 'tool' },
    { kind: 'tool', responseBytes: '10' },
    { kind: 'tool', responseBytes: 1, usage: null },
    { kind: 'browser_request', responseBytes: 1 },
    ...['input', 'output', 'cachedInput', 'imageInput'].flatMap((key) =>
      [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true].map((value) => ({
        kind: 'model',
        usage: { input: 1, output: 1, [key]: value },
      }))
    ),
    Object.create({ kind: 'model', usage: { input: 0, output: 0 } }),
  ];
  for (const browserObservable of [false, true]) {
    for (const event of malformed) {
      const metrics = new Metrics(browserObservable);
      metrics.record({ kind: 'model', usage: { input: 10, output: 2 } });
      metrics.record({ kind: 'tool', responseBytes: 5 });
      const before = metrics.snapshot();
      assert.throws(() => metrics.record(event), /measurement|usage|token|input/i);
      assert.deepEqual(metrics.snapshot(), before, 'Rejected telemetry changed prior measurements');
    }
  }
});

test('explicit zero usage remains valid, missing usage stays unknown, and adapter mutation cannot rewrite counts', () => {
  const metrics = new Metrics(true);
  const usage = { input: 0, output: 0, cachedInput: 0, imageInput: 0 };
  metrics.record({ kind: 'model', usage });
  usage.input = 100;
  metrics.record({ kind: 'browser_request' });
  assert.deepEqual(metrics.snapshot().tokens, {
    input: 0,
    output: 0,
    cachedInput: 0,
    imageInput: 0,
  });
  assert.equal(metrics.snapshot().browserRequests, 1);
  metrics.record({ kind: 'model', usage: null });
  assert.equal(metrics.snapshot().tokens, null);
});

test('percentiles and Wilson intervals do not manufacture samples or certainty', () => {
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([4, 1, 2, 3], 0.5), 2);
  assert.equal(percentile([4, 1, 2, 3], 0.95), 4);
  assert.equal(successInterval(0, 0), null);
  assert(successInterval(0, 30)![1] > 0);
  assert(successInterval(30, 30)![0] < 1);
  assert.throws(() => successInterval(2, 1));
  assert.throws(() => successInterval(-1, 1));
  assert.throws(() => percentile([NaN], 0.5));
  assert.throws(() => percentile([1], 2));
});
