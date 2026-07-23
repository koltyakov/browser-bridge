import test from 'node:test';
import assert from 'node:assert/strict';

import { TabDebuggerCoordinator } from '../src/debugger-coordinator.js';

function nextTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

test('acquire and release manage debugger hold lifecycle', async () => {
  const events: string[] = [];
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

  // Releasing without unknown acquire should be safe
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

test('markDetached clears burst reuse so the next run reattaches', async () => {
  let attachCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      attachCount += 1;
    },
    detach: async () => {},
    burstIdleMs: 500,
  });

  await coordinator.run(10, async () => 'first');
  coordinator.markDetached(10);
  await coordinator.run(10, async () => 'second');

  assert.equal(attachCount, 2);
});

test('run retries opted-in read work once after a debugger not-attached failure', async () => {
  let attachCount = 0;
  let taskCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      attachCount += 1;
    },
    detach: async () => {},
    burstIdleMs: 0,
  });

  const result = await coordinator.run(
    10,
    async () => {
      taskCount += 1;
      if (taskCount === 1) {
        throw new Error('Debugger is not attached to the tab');
      }
      return 'recovered';
    },
    { retryDetached: true }
  );

  assert.equal(result, 'recovered');
  assert.equal(taskCount, 2);
  assert.equal(attachCount, 2);
});

test('burst timer does not detach while a new run is active', async () => {
  let detachCount = 0;
  let releaseSecondTask: (value?: void | PromiseLike<void>) => void = () => {};
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {
      detachCount += 1;
    },
    burstIdleMs: 10,
  });

  await coordinator.run(10, async () => 'first');
  const second = coordinator.run(10, async () => {
    await new Promise<void>((resolve) => {
      releaseSecondTask = resolve;
    });
    return 'second';
  });

  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(detachCount, 0, 'stale burst timer must not detach during active work');

  releaseSecondTask();
  assert.equal(await second, 'second');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(detachCount, 1);
});

test('acquire consumes a burst session instead of reattaching', async () => {
  let attachCount = 0;
  let detachCount = 0;
  let initializeCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      attachCount += 1;
    },
    detach: async () => {
      detachCount += 1;
    },
    burstIdleMs: 20,
  });

  await coordinator.run(10, async () => 'task');
  await coordinator.acquire(10, async () => {
    initializeCount += 1;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(attachCount, 1);
  assert.equal(initializeCount, 1);
  assert.equal(detachCount, 0);

  await coordinator.release(10);
  assert.equal(detachCount, 1);
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
  const events: string[] = [];
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

test('coordinator initializes Page observation once per physical attachment', async () => {
  const events: string[] = [];
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      events.push('attach');
    },
    initialize: async () => {
      events.push('Page.enable');
    },
    detach: async () => {
      events.push('detach');
    },
    burstIdleMs: 500,
  });

  await coordinator.run(10, async () => events.push('first'));
  await coordinator.run(10, async () => events.push('second'));

  assert.deepEqual(events, ['attach', 'Page.enable', 'first', 'second']);
  await coordinator.discard(10);
  assert.deepEqual(events, ['attach', 'Page.enable', 'first', 'second', 'detach']);
});

test('coordinator tracks bounded dialog state and clears it on close and detach', async () => {
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {},
    burstIdleMs: 500,
  });
  await coordinator.run(10, async () => {});

  const secret = 's'.repeat(5_000);
  coordinator.handleEvent(10, 'Page.javascriptDialogOpening', {
    type: 'prompt',
    message: secret,
    defaultPrompt: secret,
  });
  const dialog = coordinator.getDialog(10);
  assert.match(dialog?.dialogId ?? '', /^[0-9a-f-]+:1$/);
  assert.equal(dialog?.type, 'prompt');
  assert.equal(dialog?.message.length, 4_096);
  assert.equal(dialog?.messageTruncated, true);
  assert.deepEqual(coordinator.getDialogStatus(10), {
    status: 'open',
    observable: true,
    type: 'prompt',
    openedAt: dialog?.openedAt,
  });

  coordinator.handleEvent(10, 'Page.javascriptDialogClosed', {});
  assert.deepEqual(coordinator.getDialogStatus(10), { status: 'none', observable: true });

  coordinator.handleEvent(10, 'Page.javascriptDialogOpening', {
    type: 'beforeunload',
    message: 'leave?',
  });
  coordinator.markDetached(10);
  assert.equal(coordinator.getDialog(10), null);
  assert.deepEqual(coordinator.getDialogStatus(10), { status: 'unknown', observable: false });
});

test('consecutive dialog openings replace prior tracked text', () => {
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {},
  });
  coordinator.handleEvent(10, 'Page.javascriptDialogOpening', {
    type: 'alert',
    message: 'first',
  });
  const firstId = coordinator.getDialog(10)?.dialogId;
  const firstObservation = coordinator.getDialogObservation(10);
  coordinator.handleEvent(10, 'Page.javascriptDialogOpening', {
    type: 'confirm',
    message: 'second',
  });

  assert.equal(coordinator.getDialog(10)?.type, 'confirm');
  assert.equal(coordinator.getDialog(10)?.message, 'second');
  assert.notEqual(coordinator.getDialog(10)?.dialogId, firstId);
  assert.equal(
    coordinator.getDialogObservation(10).eventSequence,
    firstObservation.eventSequence + 1
  );
  assert.equal(
    coordinator.getDialogObservation(10).lastOpenedDialogId,
    coordinator.getDialog(10)?.dialogId
  );
  assert.equal(coordinator.clearDialog(10, firstId ?? ''), false);
  assert.equal(coordinator.getDialog(10)?.message, 'second');

  const replacementId = coordinator.getDialog(10)?.dialogId;
  coordinator.handleEvent(10, 'Page.javascriptDialogClosed', {});
  assert.equal(coordinator.getDialogObservation(10).lastOpenedDialogId, replacementId);
  assert.equal(
    coordinator.getDialogObservation(10).eventSequence,
    firstObservation.eventSequence + 2
  );

  coordinator.clearDialogState(10);
  assert.deepEqual(coordinator.getDialogObservation(10), {
    dialog: null,
    eventSequence: 0,
    lastOpenedDialogId: null,
  });
});

test('waitForDialog closes the Page.enable event race and is bounded', async () => {
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {},
  });
  const observed = coordinator.waitForDialog(10, 100);
  setTimeout(() => {
    coordinator.handleEvent(10, 'Page.javascriptDialogOpening', {
      type: 'alert',
      message: 'attachment dialog',
    });
  }, 0);

  assert.equal((await observed)?.message, 'attachment dialog');
  assert.equal(await coordinator.waitForDialog(11, 1), null);
  assert.equal(coordinator.dialogWaitersByTab.size, 0);
});

test('Page initialization coexists with Fetch holds and detach recovery', async () => {
  const events: string[] = [];
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      events.push('attach');
    },
    initialize: async () => {
      events.push('Page.enable');
    },
    detach: async () => {
      events.push('detach');
    },
    burstIdleMs: 500,
  });

  await coordinator.acquire(10, async () => {
    events.push('Fetch.enable');
  });
  await coordinator.run(10, async () => {
    events.push('dialog.inspect');
  });
  assert.deepEqual(events, ['attach', 'Page.enable', 'Fetch.enable', 'dialog.inspect']);

  coordinator.markDetached(10);
  await coordinator.acquire(10, async () => {
    events.push('Fetch.reenable');
  });
  assert.deepEqual(events, [
    'attach',
    'Page.enable',
    'Fetch.enable',
    'dialog.inspect',
    'attach',
    'Page.enable',
    'Fetch.reenable',
  ]);
  await coordinator.release(10);
  assert.equal(events.at(-1), 'detach');
});

test('detach cancels attachment-time dialog observers', async () => {
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {},
  });
  const pending = coordinator.waitForDialog(10, 1_000);
  coordinator.markDetached(10);
  assert.equal(await pending, null);
  assert.equal(coordinator.dialogWaitersByTab.size, 0);
});
