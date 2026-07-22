import test from 'node:test';
import assert from 'node:assert/strict';

import { TabDebuggerCoordinator } from '../src/debugger-coordinator.js';

function nextTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

test('TabDebuggerCoordinator serializes debugger work for the same tab', async () => {
  const events: string[] = [];
  let releaseFirstTask: (value?: void | PromiseLike<void>) => void = () => {};
  const coordinator = new TabDebuggerCoordinator({
    attach: async (target) => {
      events.push(`attach:${target.tabId}`);
    },
    detach: async (target) => {
      events.push(`detach:${target.tabId}`);
    },
    burstIdleMs: 0,
  });

  const first = coordinator.run(7, async () => {
    events.push('task:first:start');
    await new Promise<void>((resolve) => {
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
  await nextTick();
  assert.deepEqual(events, [
    'attach:7',
    'task:first:start',
    'task:first:end',
    'task:second',
    'detach:7',
  ]);
});

test('TabDebuggerCoordinator allows different tabs to proceed independently', async () => {
  let firstRunning = false;
  let secondRunning = false;
  let releaseFirstTask: (value?: void | PromiseLike<void>) => void = () => {};
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {},
  });

  const first = coordinator.run(7, async () => {
    firstRunning = true;
    await new Promise<void>((resolve) => {
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
    },
    burstIdleMs: 0,
  });

  await assert.rejects(
    coordinator.run(7, async () => {
      throw new Error('boom');
    }),
    /boom/
  );
  await nextTick();

  const result = await coordinator.run(7, async () => 'recovered');
  assert.equal(result, 'recovered');
  await nextTick();
  assert.equal(attachCount, 2);
  assert.equal(detachCount, 2);
});

test('TabDebuggerCoordinator can fail detached mutations without replaying them', async () => {
  let attachCount = 0;
  let taskCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      attachCount += 1;
    },
    detach: async () => {},
    burstIdleMs: 0,
  });

  await assert.rejects(
    coordinator.run(
      7,
      async () => {
        taskCount += 1;
        throw new Error('Debugger is not attached');
      },
      { retryDetached: false }
    ),
    /not attached/
  );
  assert.equal(attachCount, 1);
  assert.equal(taskCount, 1);

  assert.equal(await coordinator.run(7, async () => 'next'), 'next');
  assert.equal(attachCount, 2);
});

test('TabDebuggerCoordinator exposes bounded conflict and detach categories without raw errors', async () => {
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      throw new Error('Another debugger is already attached at https://private.example/secret');
    },
    detach: async () => {},
  });

  await assert.rejects(
    coordinator.run(7, async () => 'unreachable'),
    /Another debugger/u
  );
  assert.deepEqual(coordinator.getDiagnostics(), {
    status: 'idle',
    attachedTabCount: 0,
    heldTabCount: 0,
    pendingTabCount: 0,
    recentReason: 'debugger_conflict',
  });
  coordinator.handleDetach(7, 'replaced_with_devtools');
  assert.equal(coordinator.getDiagnostics().recentReason, 'debugger_replaced');
  assert.doesNotMatch(JSON.stringify(coordinator.getDiagnostics()), /private\.example|secret/u);
});
