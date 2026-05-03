// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { scheduleReconnectAttempt } from '../src/background-reconnect.js';

test('scheduleReconnectAttempt clears the prior timer and doubles the backoff delay', () => {
  /** @type {Array<{ id: string }>} */
  const cleared = [];
  const priorTimer = /** @type {{ id: string }} */ ({ id: 'prior' });
  const nextTimer = /** @type {{ id: string }} */ ({ id: 'next' });
  /** @type {Array<{ callback: () => void, delay: number }>} */
  const scheduled = [];
  let reconnectCalls = 0;

  const result = scheduleReconnectAttempt({
    currentTimer: priorTimer,
    currentDelay: 2_000,
    maxDelay: 30_000,
    onReconnect: () => {
      reconnectCalls += 1;
    },
    clearTimeoutFn: (timer) => {
      cleared.push(timer);
    },
    setTimeoutFn: (callback, delay) => {
      scheduled.push({ callback, delay });
      return nextTimer;
    },
  });

  assert.deepEqual(cleared, [priorTimer]);
  assert.equal(result.timer, nextTimer);
  assert.equal(result.nextDelay, 4_000);
  assert.deepEqual(
    scheduled.map(({ delay }) => delay),
    [2_000]
  );

  scheduled[0].callback();
  assert.equal(reconnectCalls, 1);
});

test('scheduleReconnectAttempt caps the reconnect delay at the configured maximum', () => {
  /** @type {Array<unknown>} */
  const cleared = [];

  const result = scheduleReconnectAttempt({
    currentTimer: null,
    currentDelay: 30_000,
    maxDelay: 30_000,
    onReconnect: () => {},
    clearTimeoutFn: (timer) => {
      cleared.push(timer);
    },
    setTimeoutFn: () => /** @type {{ id: string }} */ ({ id: 'capped' }),
  });

  assert.deepEqual(cleared, []);
  assert.equal(result.nextDelay, 30_000);
});
