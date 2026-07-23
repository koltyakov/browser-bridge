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

test('TabDebuggerCoordinator handles observed dialogs outside a blocked debugger turn', async () => {
  for (const action of ['accept', 'dismiss']) {
    let resolveInput: (value?: void | PromiseLike<void>) => void = () => {};
    let signalInputStarted: (value?: void | PromiseLike<void>) => void = () => {};
    const inputStarted = new Promise<void>((resolve) => {
      signalInputStarted = resolve;
    });
    let inputResolved = false;
    let dialogCommandCount = 0;
    const coordinator = new TabDebuggerCoordinator({
      attach: async () => {},
      detach: async () => {},
      burstIdleMs: 10_000,
    });
    const sendCommand = async (method: string, params: Record<string, unknown>) => {
      if (method === 'Input.dispatchMouseEvent') {
        signalInputStarted();
        await new Promise<void>((resolve) => {
          resolveInput = resolve;
        });
        inputResolved = true;
        return;
      }
      assert.equal(method, 'Page.handleJavaScriptDialog');
      assert.deepEqual(params, { accept: action === 'accept' });
      dialogCommandCount += 1;
      coordinator.handleEvent(7, 'Page.javascriptDialogClosed', {});
      resolveInput();
    };

    const pendingInput = coordinator.run(7, async () =>
      sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased' })
    );
    await inputStarted;
    coordinator.handleEvent(7, 'Page.javascriptDialogOpening', {
      type: action === 'accept' ? 'confirm' : 'alert',
      message: 'blocked input',
    });

    const inspected = await coordinator.runForDialog(7, async () => coordinator.getDialog(7));
    assert.equal(inspected?.message, 'blocked input');
    assert.equal(inputResolved, false);

    await coordinator.runForDialog(7, async () =>
      sendCommand('Page.handleJavaScriptDialog', { accept: action === 'accept' })
    );

    await pendingInput;
    assert.equal(inputResolved, true);
    assert.equal(dialogCommandCount, 1, `${action} should dispatch once`);
    await coordinator.discard(7);
  }
});

test('TabDebuggerCoordinator observes a dialog that opens after lane selection', async () => {
  let releaseFirstTask: (value?: void | PromiseLike<void>) => void = () => {};
  let signalDialogWaitStarted: (value?: void | PromiseLike<void>) => void = () => {};
  const dialogWaitStarted = new Promise<void>((resolve) => {
    signalDialogWaitStarted = resolve;
  });
  let initializeCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    initialize: async () => {
      initializeCount += 1;
    },
    detach: async () => {},
    burstIdleMs: 10_000,
  });

  const first = coordinator.run(7, async () => {
    await new Promise<void>((resolve) => {
      releaseFirstTask = resolve;
    });
  });
  await nextTick();

  const dialogTask = coordinator.runForDialog(7, async () => {
    signalDialogWaitStarted();
    return coordinator.waitForDialog(7, 1_000);
  });
  await dialogWaitStarted;
  coordinator.handleEvent(7, 'Page.javascriptDialogOpening', {
    type: 'alert',
    message: 'opened after decision',
  });
  assert.equal((await dialogTask)?.message, 'opened after decision');

  releaseFirstTask();
  await first;
  assert.equal(initializeCount, 1);
  await coordinator.discard(7);

  const freshEvents: string[] = [];
  const fresh = new TabDebuggerCoordinator({
    attach: async () => {
      freshEvents.push('attach');
    },
    initialize: async () => {
      freshEvents.push('Page.enable');
    },
    detach: async () => {},
    burstIdleMs: 10_000,
  });
  await fresh.runForDialog(8, async () => {
    freshEvents.push('dialog-task');
  });
  assert.deepEqual(freshEvents, ['attach', 'Page.enable', 'dialog-task']);
  await fresh.discard(8);
});

test('TabDebuggerCoordinator dialog ownership orders release without leaking holds', async () => {
  let releaseDialog: (value?: void | PromiseLike<void>) => void = () => {};
  let signalDialogStarted: (value?: void | PromiseLike<void>) => void = () => {};
  const dialogStarted = new Promise<void>((resolve) => {
    signalDialogStarted = resolve;
  });
  let attachCount = 0;
  let detachCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      attachCount += 1;
    },
    detach: async () => {
      detachCount += 1;
    },
    burstIdleMs: 10_000,
  });

  await coordinator.acquire(7);
  coordinator.handleEvent(7, 'Page.javascriptDialogOpening', {
    type: 'alert',
    message: 'held dialog',
  });
  const dialog = coordinator.runForDialog(7, async () => {
    signalDialogStarted();
    await new Promise<void>((resolve) => {
      releaseDialog = resolve;
    });
  });
  await dialogStarted;

  const release = coordinator.release(7);
  await nextTick();
  assert.equal(detachCount, 0);
  assert.equal(coordinator.holdsByTab.get(7), 1);
  assert.equal(coordinator.dialogOwnersByTab.has(7), true);

  releaseDialog();
  await Promise.all([dialog, release]);
  assert.equal(attachCount, 1);
  assert.equal(detachCount, 1);
  assert.equal(coordinator.holdsByTab.has(7), false);
  assert.equal(coordinator.dialogOwnersByTab.has(7), false);
  assert.equal(coordinator.inFlightTasksByTab.has(7), false);
});

test('TabDebuggerCoordinator dialog ownership blocks new work and burst detach', async () => {
  let releaseDialog: (value?: void | PromiseLike<void>) => void = () => {};
  let signalDialogStarted: (value?: void | PromiseLike<void>) => void = () => {};
  const dialogStarted = new Promise<void>((resolve) => {
    signalDialogStarted = resolve;
  });
  let attachCount = 0;
  let detachCount = 0;
  let normalTaskRan = false;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      attachCount += 1;
    },
    detach: async () => {
      detachCount += 1;
    },
    burstIdleMs: 10,
  });

  await coordinator.run(7, async () => {});
  coordinator.handleEvent(7, 'Page.javascriptDialogOpening', {
    type: 'alert',
    message: 'burst dialog',
  });
  const dialog = coordinator.runForDialog(7, async () => {
    signalDialogStarted();
    await new Promise<void>((resolve) => {
      releaseDialog = resolve;
    });
  });
  await dialogStarted;
  const normal = coordinator.run(7, async () => {
    normalTaskRan = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(normalTaskRan, false);
  assert.equal(detachCount, 0);

  releaseDialog();
  await Promise.all([dialog, normal]);
  assert.equal(normalTaskRan, true);
  assert.equal(attachCount, 1);
  assert.equal(coordinator.dialogOwnersByTab.has(7), false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(detachCount, 1);
});

test('TabDebuggerCoordinator keeps stale multi-command work out of a fresh session', async () => {
  let releaseFirstCommand: (value?: void | PromiseLike<void>) => void = () => {};
  let signalClickStarted: (value?: void | PromiseLike<void>) => void = () => {};
  const clickStarted = new Promise<void>((resolve) => {
    signalClickStarted = resolve;
  });
  const events: string[] = [];
  let detachCount = 0;
  let attachCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      attachCount += 1;
    },
    detach: async () => {
      detachCount += 1;
      events.push('detach');
    },
    burstIdleMs: 10_000,
  });
  const click = coordinator.run(7, async () => {
    events.push('old:first');
    signalClickStarted();
    await new Promise<void>((resolve) => {
      releaseFirstCommand = resolve;
    });
    events.push('old:second');
  });
  await clickStarted;
  coordinator.handleEvent(7, 'Page.javascriptDialogOpening', {
    type: 'alert',
    message: 'blocked cleanup',
  });

  await coordinator.discard(7);
  events.push('attempted:fresh');
  await assert.rejects(
    coordinator.run(7, async () => events.push('fresh')),
    /access was cleared/
  );
  assert.equal(attachCount, 1);

  releaseFirstCommand();
  await assert.rejects(click, /access was cleared/);
  await coordinator.run(7, async () => events.push('fresh'));
  assert.deepEqual(events, ['old:first', 'detach', 'attempted:fresh', 'old:second', 'fresh']);
  assert.equal(attachCount, 2);
  assert.equal(detachCount, 1);
  assert.equal(coordinator.getDialog(7), null);
  assert.equal(coordinator.holdsByTab.has(7), false);
  assert.equal(coordinator.dialogOwnersByTab.has(7), false);
  assert.equal(coordinator.inFlightTasksByTab.has(7), false);
  await coordinator.discard(7);
});

test('TabDebuggerCoordinator cancels queued work after cleanup without reattaching', async () => {
  let releaseFirst: (value?: void | PromiseLike<void>) => void = () => {};
  let signalFirstStarted: (value?: void | PromiseLike<void>) => void = () => {};
  const firstStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve;
  });
  let attachCount = 0;
  let queuedTaskCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      attachCount += 1;
    },
    detach: async () => {},
    burstIdleMs: 10_000,
  });
  const first = coordinator.run(7, async () => {
    signalFirstStarted();
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
  });
  await firstStarted;
  const queued = coordinator.run(7, async () => {
    queuedTaskCount += 1;
  });

  await coordinator.discard(7);
  releaseFirst();
  const settled = await Promise.allSettled([first, queued]);
  assert.deepEqual(
    settled.map((result) => result.status),
    ['rejected', 'rejected']
  );
  for (const result of settled) {
    if (result.status === 'rejected') assert.match(String(result.reason), /access was cleared/);
  }
  assert.equal(attachCount, 1);
  assert.equal(queuedTaskCount, 0);
  assert.equal(coordinator.holdsByTab.has(7), false);
  assert.equal(coordinator.dialogOwnersByTab.has(7), false);
});

test('TabDebuggerCoordinator does not replay an out-of-band dialog action after detach', async () => {
  let releaseFirstTask: (value?: void | PromiseLike<void>) => void = () => {};
  let actionCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {},
    burstIdleMs: 10_000,
  });

  const first = coordinator.run(7, async () => {
    await new Promise<void>((resolve) => {
      releaseFirstTask = resolve;
    });
  });
  await nextTick();
  coordinator.handleEvent(7, 'Page.javascriptDialogOpening', {
    type: 'alert',
    message: 'detach race',
  });

  await assert.rejects(
    coordinator.runForDialog(
      7,
      async () => {
        actionCount += 1;
        throw new Error('Debugger is not attached');
      },
      { retryDetached: false }
    ),
    /not attached/
  );
  assert.equal(actionCount, 1);
  assert.equal(coordinator.getDialog(7), null);
  assert.deepEqual(coordinator.getDialogStatus(7), { status: 'unknown', observable: false });

  releaseFirstTask();
  await first;
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

test('TabDebuggerCoordinator records reattach before and separately from request replay', async () => {
  const outcomes: Array<'success' | 'failure'> = [];
  let taskCalls = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {},
    recordReattach: (outcome) => outcomes.push(outcome),
  });

  await coordinator
    .run(
      7,
      async () => {
        taskCalls += 1;
        if (taskCalls === 1) throw new Error('Debugger is not attached');
        throw new Error('Replay request failed');
      },
      { retryDetached: true }
    )
    .catch(() => {});

  assert.deepEqual(outcomes, ['success']);
  assert.equal(taskCalls, 2);
});

test('TabDebuggerCoordinator records a failed reattach without replaying', async () => {
  const outcomes: Array<'success' | 'failure'> = [];
  let attachCalls = 0;
  let taskCalls = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      attachCalls += 1;
      if (attachCalls === 2) throw new Error('Another debugger is attached');
    },
    detach: async () => {},
    recordReattach: (outcome) => outcomes.push(outcome),
  });

  await assert.rejects(
    coordinator.run(
      7,
      async () => {
        taskCalls += 1;
        throw new Error('Debugger is not attached');
      },
      { retryDetached: true }
    ),
    /Another debugger/u
  );
  assert.deepEqual(outcomes, ['failure']);
  assert.equal(taskCalls, 1);
});

test('TabDebuggerCoordinator does not replay detached work unless explicitly opted in', async () => {
  let taskCalls = 0;
  let attachCalls = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      attachCalls += 1;
    },
    detach: async () => {},
  });

  await assert.rejects(
    coordinator.run(7, async () => {
      taskCalls += 1;
      throw new Error('Debugger is not attached');
    }),
    /not attached/u
  );
  assert.equal(taskCalls, 1);
  assert.equal(attachCalls, 1);
});
