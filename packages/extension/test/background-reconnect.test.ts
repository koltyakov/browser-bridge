import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isNativeConnectionUnstable,
  recordNativeDisconnect,
  scheduleReconnectAttempt,
} from '../src/background-reconnect.js';

type TimerStub = { id: string };
type ScheduledReconnect = { callback: () => void; delay: number };

test('scheduleReconnectAttempt clears the prior timer and doubles the backoff delay', () => {
  const cleared: TimerStub[] = [];
  const priorTimer: TimerStub = { id: 'prior' };
  const nextTimer: TimerStub = { id: 'next' };
  const scheduled: ScheduledReconnect[] = [];
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
  const cleared: TimerStub[] = [];

  const result = scheduleReconnectAttempt({
    currentTimer: null,
    currentDelay: 30_000,
    maxDelay: 30_000,
    onReconnect: () => {},
    clearTimeoutFn: (timer) => {
      cleared.push(timer);
    },
    setTimeoutFn: () => ({ id: 'capped' }),
  });

  assert.deepEqual(cleared, []);
  assert.equal(result.nextDelay, 30_000);
});

test('recordNativeDisconnect appends the disconnect and prunes entries outside the window', () => {
  const now = 100_000;
  const windowMs = 60_000;

  assert.deepEqual(recordNativeDisconnect([], now, windowMs), [now]);
  assert.deepEqual(
    recordNativeDisconnect([now - 70_000, now - 50_000, now + 5_000], now, windowMs),
    [now - 50_000, now]
  );
});

test('isNativeConnectionUnstable requires the threshold inside the window', () => {
  const now = 100_000;
  const windowMs = 60_000;

  assert.equal(isNativeConnectionUnstable([], now, windowMs, 3), false);
  assert.equal(isNativeConnectionUnstable([now - 40_000, now - 20_000], now, windowMs, 3), false);
  assert.equal(
    isNativeConnectionUnstable([now - 40_000, now - 20_000, now - 1_000], now, windowMs, 3),
    true
  );
  assert.equal(
    isNativeConnectionUnstable([now - 90_000, now - 80_000, now - 70_000], now, windowMs, 3),
    false
  );
});
