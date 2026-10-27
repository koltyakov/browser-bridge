import test from 'node:test';
import assert from 'node:assert/strict';

import { RECOVERY_LOOP_THRESHOLD, RecoveryTelemetryCollector } from '../src/recovery-telemetry.js';

test('collector uses fixed buckets, detects three grouped failures, and decays predictably', () => {
  let now = 10_000;
  const collector = new RecoveryTelemetryCollector({ now: () => now });
  collector.record('debugger_reattach', 'failure', 'tab-a');
  now += 20_000;
  collector.record('debugger_reattach', 'failure', 'tab-a');
  now += 20_000;
  collector.record('debugger_reattach', 'failure', 'tab-a');
  collector.record('debugger_reattach', 'success', 'tab-a');

  const active = collector.snapshot('routedExtension');
  assert.equal(active.activeLoop, true);
  assert.deepEqual(active.events.debugger_reattach, {
    attempts: 4,
    successes: 1,
    failures: 3,
    pending: 0,
    saturated: false,
    successRate: 0.25,
    failureRate: 0.75,
    activeLoop: true,
    lastEventAt: now,
  });

  now += 60_001;
  assert.equal(collector.snapshot('routedExtension').activeLoop, false);
  now += 5 * 60 * 1000;
  assert.equal(collector.snapshot('routedExtension').events.debugger_reattach.attempts, 0);
});

test('collector bounds internal groups with fixed failure rings', () => {
  const collector = new RecoveryTelemetryCollector({ now: () => 50_000 });
  for (let index = 0; index < 70; index += 1) {
    collector.record('request_outcome', 'failure', `group-${index}`);
  }
  for (let index = 0; index < 100; index += 1) {
    collector.record('request_outcome', 'failure', 'bounded-group');
  }
  assert.equal(collector.groups.size, 64);
  const boundedGroup = collector.groups.get('request_outcome\u0000bounded-group');
  assert.equal(boundedGroup?.failures.length, 3);
  assert.equal(boundedGroup?.count, 3);
});

test('collector keeps saturated mixed outcomes internally coherent', () => {
  const collector = new RecoveryTelemetryCollector({ now: () => 50_000 });
  for (let index = 0; index < 8_000; index += 1) {
    collector.record('request_outcome', 'success');
  }
  for (let index = 0; index < 4_000; index += 1) {
    collector.record('request_outcome', 'failure');
  }
  const summary = collector.snapshot('daemon');
  assert.deepEqual(summary.events.request_outcome, {
    attempts: 10_000,
    successes: 6_667,
    failures: 3_333,
    pending: 0,
    saturated: true,
    successRate: null,
    failureRate: null,
    activeLoop: true,
    lastEventAt: 50_000,
  });
  assert.equal(
    summary.events.request_outcome.attempts,
    summary.events.request_outcome.successes +
      summary.events.request_outcome.failures +
      summary.events.request_outcome.pending
  );
});

test('collector retains boundary-bucket events for the full advertised window', () => {
  let now = 4_999;
  const collector = new RecoveryTelemetryCollector({ now: () => now });
  collector.record('stale_ref_recovery', 'success');
  now = 304_998;
  assert.equal(collector.snapshot('routedExtension').events.stale_ref_recovery.attempts, 1);
  now = 305_000;
  assert.equal(collector.snapshot('routedExtension').events.stale_ref_recovery.attempts, 0);
});

test('saturation preserves an active three-failure loop', () => {
  const collector = new RecoveryTelemetryCollector({ now: () => 1 });
  for (let index = 0; index < 99_997; index += 1) {
    collector.record('request_outcome', 'success');
  }
  for (let index = 0; index < 3; index += 1) {
    collector.record('request_outcome', 'failure', 'same-group');
  }
  const snapshot = collector.snapshot('daemon');
  const event = snapshot.events.request_outcome;
  assert.equal(event.saturated, true);
  assert.equal(event.failures, RECOVERY_LOOP_THRESHOLD);
  assert.equal(event.activeLoop, true);
});
