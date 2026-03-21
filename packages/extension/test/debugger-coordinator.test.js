// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { TabDebuggerCoordinator } from '../src/debugger-coordinator.js';

/**
 * @returns {Promise<void>}
 */
function nextTick() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

test('TabDebuggerCoordinator serializes debugger work for the same tab', async () => {
  /** @type {string[]} */
  const events = [];
  /** @type {(value?: void | PromiseLike<void>) => void} */
  let releaseFirstTask = () => {};
  const coordinator = new TabDebuggerCoordinator({
    attach: async (target) => {
      events.push(`attach:${target.tabId}`);
    },
    detach: async (target) => {
      events.push(`detach:${target.tabId}`);
    }
  });

  const first = coordinator.run(7, async () => {
    events.push('task:first:start');
    await new Promise((resolve) => {
      releaseFirstTask = resolve;
    });
    events.push('task:first:end');
    return 'first';
  });

  await nextTick();

  const second = coordinator.run(7, async () => {
    events.push('task:second');
    return 'second';
  });

  await nextTick();
  assert.deepEqual(events, ['attach:7', 'task:first:start']);

  releaseFirstTask();

  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  assert.deepEqual(events, [
    'attach:7',
    'task:first:start',
    'task:first:end',
    'detach:7',
    'attach:7',
    'task:second',
    'detach:7'
  ]);
});

test('TabDebuggerCoordinator allows different tabs to proceed independently', async () => {
  let firstRunning = false;
  let secondRunning = false;
  /** @type {(value?: void | PromiseLike<void>) => void} */
  let releaseFirstTask = () => {};
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {}
  });

  const first = coordinator.run(7, async () => {
    firstRunning = true;
    await new Promise((resolve) => {
      releaseFirstTask = resolve;
    });
  });

  const second = coordinator.run(8, async () => {
    secondRunning = true;
    return 'second';
  });

  await nextTick();
  assert.equal(firstRunning, true);
  assert.equal(secondRunning, true);

  releaseFirstTask();
  await first;
  assert.equal(await second, 'second');
});

test('TabDebuggerCoordinator releases the queue after task failures', async () => {
  let attachCount = 0;
  let detachCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      attachCount += 1;
    },
    detach: async () => {
      detachCount += 1;
    }
  });

  await assert.rejects(
    coordinator.run(7, async () => {
      throw new Error('boom');
    }),
    /boom/
  );

  const result = await coordinator.run(7, async () => 'recovered');
  assert.equal(result, 'recovered');
  assert.equal(attachCount, 2);
  assert.equal(detachCount, 2);
});
