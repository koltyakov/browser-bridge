import test from 'node:test';
import assert from 'node:assert/strict';

import { BridgeError } from '../../../protocol/src/index.js';
import {
  createInputAftermath,
  inputAftermathError,
  splitInputObservation,
} from '../src/input-aftermath.js';

test('aftermath starts without dispatch or application verification', () => {
  assert.deepEqual(createInputAftermath(false), {
    dispatch: 'not_started',
    observation: { status: 'not_requested' },
    verification: 'not_requested',
  });
  assert.deepEqual(createInputAftermath({ settleMs: 50 }), {
    dispatch: 'not_started',
    observation: { status: 'unavailable', reason: 'not_started' },
    verification: 'not_requested',
  });
});

test('input error annotation preserves typed details and snapshots uncertain evidence', () => {
  const aftermath = createInputAftermath(true);
  aftermath.dispatch = 'uncertain';
  aftermath.observation = { status: 'interrupted', reason: 'action_interrupted' };
  const error = inputAftermathError(
    new BridgeError('TIMEOUT', 'Stopped.', { target: 'el_1' }),
    aftermath
  );
  assert.equal(error.code, 'TIMEOUT');
  assert.equal(error.message, 'Stopped.');
  assert.deepEqual(error.details, {
    target: 'el_1',
    aftermath,
    outcomeUncertain: true,
  });
  const snapshot = JSON.stringify(error.details);
  // A guarded debugger task can settle after the caller has received failure.
  aftermath.dispatch = 'completed';
  aftermath.observation.status = 'completed';
  assert.equal(JSON.stringify(error.details), snapshot);
});

test('input error annotation normalizes runtime errors without inventing dispatch', () => {
  for (const [source, code] of [
    [new Error('Error: No tab with id: 12'), 'TAB_MISMATCH'],
    [new Error('Element reference is stale.'), 'ELEMENT_STALE'],
    [{ code: 'unknown', message: 'DIALOG_BLOCKED', details: [] }, 'DIALOG_BLOCKED'],
    ['disconnected', 'INTERNAL_ERROR'],
    [null, 'INTERNAL_ERROR'],
  ] as const) {
    const error = inputAftermathError(source, createInputAftermath(false));
    assert.equal(error.code, code);
    assert.deepEqual(error.details, { aftermath: createInputAftermath(false) });
  }
});

test('observation splitting preserves new effects but rejects unsupported legacy conclusions', () => {
  const effects = { changed: true, navigation: 'unloading', dom: { added: 1, removed: 0 } };
  const observation = { status: 'interrupted', reason: 'navigation' };
  assert.deepEqual(splitInputObservation({ ...effects, observation }), { effects, observation });
  assert.deepEqual(splitInputObservation({ expired: true, changed: false }), {
    effects: { expired: true },
    observation: { status: 'unavailable', reason: 'expired' },
  });
  for (const status of [undefined, 'invalid', null, {}]) {
    assert.deepEqual(splitInputObservation({ ...effects, observation: status }), {
      effects: { dom: effects.dom },
      observation: { status: 'unavailable', reason: 'unsupported' },
    });
  }
});
