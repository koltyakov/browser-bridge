// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { TabDebuggerCoordinator } from '../src/debugger-coordinator.js';

/** @returns {Promise<void>} */
function nextTick() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

test('acquire and release manage debugger hold lifecycle', async () => {
  /** @type {string[]} */
  const events = [];
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      events.push('attach');
    },
    detach: async () => {
      events.push('detach');
    },
    burstIdleMs: 0,
  });

  await coordinator.acquire(10, async () => {
    events.push('initialize');
  });
  assert.deepEqual(events, ['attach', 'initialize']);

  // While held, run should not re-attach
  const result = await coordinator.run(10, async () => {
    events.push('run-during-hold');
    return 42;
  });
  assert.equal(result, 42);
  assert.ok(!events.slice(2).includes('attach'), 'should not re-attach during hold');

  await coordinator.release(10);
  await nextTick();
  assert.ok(events.includes('detach'), 'should detach after release');
});

test('nested acquire/release is reference-counted', async () => {
  let detachCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {
      detachCount += 1;
    },
    burstIdleMs: 0,
  });

  await coordinator.acquire(10);
  await coordinator.acquire(10); // nested
  await coordinator.release(10); // decrement to 1
  await nextTick();
  assert.equal(detachCount, 0, 'should not detach while still held');

  await coordinator.release(10); // decrement to 0, detach
  await nextTick();
  assert.equal(detachCount, 1, 'should detach when all holds released');
});

test('release with holdCount 0 is a no-op', async () => {
  let detachCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {
      detachCount += 1;
    },
    burstIdleMs: 0,
  });

  // Releasing without any acquire should be safe
  await coordinator.release(99);
  await nextTick();
  assert.equal(detachCount, 0);
});

test('acquire rolls back attach on initialize failure', async () => {
  let detachCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {
      detachCount += 1;
    },
    burstIdleMs: 0,
  });

  await assert.rejects(
    coordinator.acquire(10, async () => {
      throw new Error('init failed');
    }),
    /init failed/
  );
  await nextTick();
  assert.equal(detachCount, 1, 'should detach if initialize throws');
});

test('burst timer reuses session for rapid consecutive runs', async () => {
  let attachCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      attachCount += 1;
    },
    detach: async () => {},
    burstIdleMs: 500,
  });

  await coordinator.run(10, async () => 'first');
  // Immediate second run should reuse the burst session
  await coordinator.run(10, async () => 'second');

  // Only one attach, because burst timer kept the session alive
  assert.equal(attachCount, 1);
});

test('_resetBurstTimer detach fires after burst idle expires', async () => {
  let detachCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {
      detachCount += 1;
    },
    burstIdleMs: 10,
  });

  await coordinator.run(10, async () => 'task');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(detachCount, 1);
});

test('release runs cleanup callback before detach', async () => {
  /** @type {string[]} */
  const events = [];
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      events.push('attach');
    },
    detach: async () => {
      events.push('detach');
    },
    burstIdleMs: 0,
  });

  await coordinator.acquire(10);
  await coordinator.release(10, async () => {
    events.push('cleanup');
  });
  assert.deepEqual(events, ['attach', 'cleanup', 'detach']);
});

test('release propagates cleanup error after detaching', async () => {
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {},
    burstIdleMs: 0,
  });

  await coordinator.acquire(10);
  await assert.rejects(
    coordinator.release(10, async () => {
      throw new Error('cleanup boom');
    }),
    /cleanup boom/
  );
});

test('run re-throws task errors after scheduling burst detach', async () => {
  let detached = false;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {
      detached = true;
    },
    burstIdleMs: 0,
  });

  await assert.rejects(
    coordinator.run(10, async () => {
      throw new Error('task boom');
    }),
    /task boom/
  );
  await nextTick();
  assert.equal(detached, true);
});
