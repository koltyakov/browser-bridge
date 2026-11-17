import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdapterValidationError,
  observation,
  runResult,
  sessionClose,
  validateDriver,
  validateSession,
} from './validation.ts';
import { Metrics } from './metrics.ts';
import { tasks } from './tasks.ts';
import type { Driver, EpisodeContext } from './types.ts';

function descriptor(): Driver {
  return {
    identity: { name: 'validation-fixture', version: 'test', track: 'scripted' },
    supportedTasks: ['save'],
    browserRequestsObservable: false,
    async open() {
      throw new Error('Descriptor validation must not open a browser');
    },
  };
}
const observed = {
  url: 'http://fixture.test/page',
  focusThefts: 0,
  dialogOpened: 0,
  dialogClosed: 0,
};

test('dynamic driver descriptors reject coercible, missing, inherited, and malformed fields', () => {
  const good = descriptor();
  const malformed: unknown[] = [
    null,
    undefined,
    false,
    'driver',
    [],
    () => {},
    {},
    { ...good, identity: null },
    { ...good, identity: [] },
    ...[undefined, null, 123, {}, '', ' ', ' upper', 'UPPER', '../escape', 'x'.repeat(65)].map(
      (name) => ({ ...good, identity: { ...good.identity, name } })
    ),
    ...[undefined, null, 123, {}, '', ' ', 'test '].map((version) => ({
      ...good,
      identity: { ...good.identity, version },
    })),
    { ...good, identity: { ...good.identity, track: 'unknown' } },
    { ...good, identity: { ...good.identity, extra: 'typo' } },
    { ...good, identity: Object.create(good.identity) },
    ...[null, 0, 'false', undefined].map((browserRequestsObservable) => ({
      ...good,
      browserRequestsObservable,
    })),
    ...[null, 'save', [undefined], ['missing'], ['save', 'save'], new Array(1)].map(
      (supportedTasks) => ({ ...good, supportedTasks })
    ),
    ...[undefined, null, 1, 'open', {}].map((open) => ({ ...good, open })),
  ];
  for (const value of malformed) assert.throws(() => validateDriver(value), AdapterValidationError);
  assert.deepEqual(validateDriver({ ...good, supportedTasks: [] }).supportedTasks, []);
});

test('agent identities need real string fields and a syntactically valid SHA-256 digest', () => {
  const good = descriptor();
  const agent = {
    ...good.identity,
    track: 'agent',
    model: 'test-model-revision',
    instructionsHash: 'a'.repeat(64),
  };
  for (const model of [undefined, null, 1, {}, '', ' ', ' model']) {
    assert.throws(
      () => validateDriver({ ...good, identity: { ...agent, model } }),
      AdapterValidationError
    );
  }
  for (const instructionsHash of [
    undefined,
    null,
    1,
    {},
    '',
    'test',
    'g'.repeat(64),
    'a'.repeat(63),
  ]) {
    assert.throws(
      () => validateDriver({ ...good, identity: { ...agent, instructionsHash } }),
      AdapterValidationError
    );
  }
  assert.equal(
    validateDriver({ ...good, identity: agent }).identity.instructionsHash,
    agent.instructionsHash
  );
  assert.equal(
    validateDriver({ ...good, identity: { ...agent, instructionsHash: 'A'.repeat(64) } }).identity
      .track,
    'agent'
  );
});

test('validation snapshots declarations and preserves legitimate class method receivers', async () => {
  class Session {
    calls = 0;
    provenance = { fixture: { source: 'controller-self-test' }, array: [1, null, true] };
    async run() {
      this.calls++;
      return { reported: 'completed' };
    }
    async observe() {
      this.calls++;
      return observed;
    }
    async close() {
      this.calls++;
    }
  }
  class ClassDriver {
    identity = descriptor().identity;
    supportedTasks = ['save'];
    browserRequestsObservable = false;
    session = new Session();
    async open() {
      return this.session;
    }
  }
  const original = new ClassDriver();
  const driver = validateDriver(original);
  original.identity.version = 'changed';
  original.supportedTasks.push('spa');
  assert.equal(driver.identity.version, 'test');
  assert.deepEqual(driver.supportedTasks, ['save']);
  const context: EpisodeContext = {
    task: tasks[0],
    url: 'http://fixture.test/page',
    seed: 1,
    output: '/unused',
    signal: new AbortController().signal,
    measure() {},
    async waitForCommit() {},
    markFault() {},
    markRecovery() {},
    releaseReply() {},
  };
  const raw = await driver.open(context);
  const session = validateSession(raw);
  original.session.provenance.fixture.source = 'changed';
  assert.deepEqual(session.provenance.fixture, { source: 'controller-self-test' });
  assert.deepEqual(runResult(await session.run(), false), { reported: 'completed' });
  assert.deepEqual(observation(await session.observe()), observed);
  await sessionClose(raw)!();
  assert.equal(original.session.calls, 3);
});

test('session validation rejects malformed lifecycle members and non-JSON provenance', () => {
  const good = { async run() {}, async observe() {}, async close() {}, provenance: {} };
  for (const value of [null, undefined, [], 'session', false, () => {}]) {
    assert.throws(() => validateSession(value), AdapterValidationError);
  }
  for (const key of ['run', 'observe', 'close']) {
    for (const value of [undefined, null, false, {}, 'function']) {
      assert.throws(() => validateSession({ ...good, [key]: value }), AdapterValidationError);
    }
  }
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const provenance of [
    null,
    [],
    undefined,
    new Date(),
    cycle,
    { missing: undefined },
    { number: NaN },
    { number: Infinity },
    { bigint: 1n },
    { callable: () => {} },
    { symbol: Symbol('bad') },
    { array: new Array(1) },
    { array: Object.assign([1], { extra: 2 }) },
    { [Symbol('bad')]: 'hidden' },
  ])
    assert.throws(() => validateSession({ ...good, provenance }), AdapterValidationError);
  const shared = { name: 'same value, not a cycle' };
  assert.deepEqual(
    validateSession({ ...good, provenance: { left: shared, right: shared } }).provenance,
    { left: shared, right: shared }
  );
});

test('cleanup can still release a malformed session and must not return a success-like value', async () => {
  let calls = 0;
  const malformed = {
    run: null,
    observe: null,
    async close() {
      calls++;
    },
  };
  assert.throws(() => validateSession(malformed), AdapterValidationError);
  await sessionClose(malformed)!();
  assert.equal(calls, 1);
  for (const value of [undefined, null, false, [], {}, { close: 'not a function' }]) {
    assert.equal(sessionClose(value), null);
  }
  for (const value of [null, false, true, 'ok', {}]) {
    await assert.rejects(
      sessionClose({
        async close() {
          return value;
        },
      })!(),
      AdapterValidationError
    );
  }
});

test('run results reject malformed statuses and final text without coercion', () => {
  for (const value of [
    null,
    undefined,
    [],
    false,
    'completed',
    {},
    { reported: 1 },
    { reported: ['completed'] },
    { reported: 'success' },
    { reported: 'completed ' },
    { reported: 'completed', extra: true },
    Object.create({ reported: 'completed' }),
  ])
    assert.throws(() => runResult(value, false), AdapterValidationError);
  for (const finalText of [undefined, null, false, 1, {}, [], '', ' \n']) {
    assert.throws(
      () => runResult({ reported: 'completed', finalText }, true),
      AdapterValidationError
    );
  }
  for (const reported of ['completed', 'stopped', 'uncertain']) {
    assert.equal(runResult({ reported }, false).reported, reported);
  }
  const finalText = '\nThe profile was saved.\n';
  assert.equal(runResult({ reported: 'completed', finalText }, true).finalText, finalText);
});

test('observations reject malformed evidence and extra oracle fields, preserving explicit unknowns', () => {
  for (const value of [null, undefined, [], false, 'observation', {}, Object.create(observed)]) {
    assert.throws(() => observation(value), AdapterValidationError);
  }
  for (const key of ['focusThefts', 'dialogOpened', 'dialogClosed']) {
    for (const value of [undefined, false, '0', -1, 0.1, NaN, Infinity]) {
      assert.throws(() => observation({ ...observed, [key]: value }), AdapterValidationError);
    }
  }
  for (const url of [undefined, false, 0, {}, '', ' ', '/relative', 'not a URL']) {
    assert.throws(() => observation({ ...observed, url }), AdapterValidationError);
  }
  assert.throws(() => observation({ ...observed, effects: [] }), AdapterValidationError);
  const unknown = { url: null, focusThefts: null, dialogOpened: null, dialogClosed: null };
  assert.deepEqual(observation(unknown), unknown);
  assert.deepEqual(observation(observed), observed);
});

test('unsafe accumulated counts are rejected before changing any measurement', () => {
  const model = new Metrics(true);
  model.record({ kind: 'model', usage: { input: Number.MAX_SAFE_INTEGER, output: 0 } });
  const beforeModel = model.snapshot();
  assert.throws(
    () => model.record({ kind: 'model', usage: { input: 1, output: 0 } }),
    AdapterValidationError
  );
  assert.deepEqual(model.snapshot(), beforeModel);
  const tool = new Metrics(true);
  tool.record({ kind: 'tool', responseBytes: Number.MAX_SAFE_INTEGER });
  const beforeTool = tool.snapshot();
  assert.throws(() => tool.record({ kind: 'tool', responseBytes: 1 }), AdapterValidationError);
  assert.deepEqual(tool.snapshot(), beforeTool);
});

test('data getters are rejected without executing them', () => {
  let invoked = false;
  const getter = () => {
    invoked = true;
    return 1;
  };
  const event = Object.defineProperty({}, 'kind', { enumerable: true, get: getter });
  assert.throws(() => new Metrics(true).record(event), AdapterValidationError);
  const usage = Object.defineProperty({ output: 0 }, 'input', { enumerable: true, get: getter });
  assert.throws(() => new Metrics(true).record({ kind: 'model', usage }), AdapterValidationError);
  const array = Object.defineProperty([0], '0', { enumerable: true, get: getter });
  assert.throws(
    () =>
      validateSession({
        async run() {},
        async observe() {},
        async close() {},
        provenance: { array },
      }),
    AdapterValidationError
  );
  assert.equal(invoked, false);
});
