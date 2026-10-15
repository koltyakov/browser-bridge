import test from 'node:test';
import assert from 'node:assert/strict';

import { BridgeError, getErrorRecovery } from '../../protocol/src/index.js';
import { TabDebuggerCoordinator } from '../src/debugger-coordinator.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createCoordinator() {
  return new TabDebuggerCoordinator({ attach: async () => {}, detach: async () => {} });
}

function openDialog(coordinator: TabDebuggerCoordinator, tabId = 7) {
  coordinator.handleEvent(tabId, 'Page.javascriptDialogOpening', {
    type: 'alert',
    message: 'Private validation error',
    defaultPrompt: 'Private prompt',
  });
}

test('a blocked action returns immediately while preserving the pending task and dialog lane', async () => {
  const coordinator = createCoordinator();
  const started = deferred<void>();
  const command = deferred<void>();
  const finished = deferred<void>();
  let runs = 0;
  const action = coordinator.runGuarded(7, async (target) => {
    runs += 1;
    started.resolve();
    try {
      await command.promise;
      coordinator.assertTaskActive(target);
      assert.fail('remaining commands must not run after the dialog closes');
    } finally {
      finished.resolve();
    }
  });
  await started.promise;
  openDialog(coordinator);
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, 'DIALOG_BLOCKED');
    assert.deepEqual(error.details, {
      tabId: 7,
      dialogId: coordinator.getDialog(7)?.dialogId,
      type: 'alert',
      actionStarted: true,
      outcomeUncertain: true,
    });
    assert.doesNotMatch(JSON.stringify(error), /Private/);
    return true;
  });
  assert.equal(coordinator.pendingByTab.has(7), true);
  assert.equal(coordinator.dialogGuardsByTab.size, 0);
  await assert.rejects(
    coordinator.runGuarded(7, async () => assert.fail('must not edit')),
    {
      code: 'DIALOG_BLOCKED',
    }
  );
  await coordinator.runForDialog(7, async () => {
    assert.equal(coordinator.getDialog(7)?.message, 'Private validation error');
    coordinator.handleEvent(7, 'Page.javascriptDialogClosed', {});
    command.resolve();
  });
  await finished.promise;
  assert.equal(
    await coordinator.runGuarded(7, async () => 'next deliberate action'),
    'next deliberate action'
  );
  assert.equal(runs, 1);
  await coordinator.discard(7);
});

test('queued guarded actions are canceled by a dialog and never start after dismissal', async () => {
  const coordinator = createCoordinator();
  const started = deferred<void>();
  const command = deferred<void>();
  const first = coordinator.runGuarded(7, async () => {
    started.resolve();
    return command.promise;
  });
  await started.promise;
  const second = coordinator.runGuarded(7, async () => assert.fail('queued edit must not run'));
  openDialog(coordinator);
  await assert.rejects(first, { code: 'DIALOG_BLOCKED' });
  await assert.rejects(second, (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, 'DIALOG_BLOCKED');
    assert.equal((error.details as { actionStarted: boolean }).actionStarted, false);
    return true;
  });
  coordinator.handleEvent(7, 'Page.javascriptDialogClosed', {});
  command.resolve();
  await coordinator.run(7, async () => {});
  await coordinator.discard(7);
});

test('guards clean up after success and failures and ignore dialogs on other tabs', async () => {
  const coordinator = createCoordinator();
  assert.equal(await coordinator.runGuarded(7, async () => 42), 42);
  await assert.rejects(
    coordinator.runGuarded(7, async () => {
      throw new Error('failed');
    }),
    /failed/
  );
  assert.equal(coordinator.dialogGuardsByTab.size, 0);
  assert.equal(
    await coordinator.runGuarded(7, async () => {
      openDialog(coordinator, 8);
      return 99;
    }),
    99
  );
  assert.equal(coordinator.dialogGuardsByTab.size, 0);
  await coordinator.discard(7);
  coordinator.markDetached(8);
});

test('a dialog observed during initialization prevents action dispatch', async () => {
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {},
    initialize: async () => {
      openDialog(coordinator);
    },
  });
  await assert.rejects(
    coordinator.runGuarded(7, async () => assert.fail('must not dispatch')),
    {
      code: 'DIALOG_BLOCKED',
    }
  );
  await coordinator.runForDialog(7, async () => {
    coordinator.handleEvent(7, 'Page.javascriptDialogClosed', {});
  });
  await coordinator.discard(7);
});

test('late command failures remain handled after a dialog returned control', async () => {
  const coordinator = createCoordinator();
  const command = deferred<void>();
  const started = deferred<void>();
  const action = coordinator.runGuarded(7, async () => {
    started.resolve();
    return command.promise;
  });
  await started.promise;
  openDialog(coordinator);
  await assert.rejects(action, { code: 'DIALOG_BLOCKED' });
  command.reject(new Error('late CDP failure'));
  coordinator.handleEvent(7, 'Page.javascriptDialogClosed', {});
  await coordinator.run(7, async () => {});
  await coordinator.discard(7);
  assert.equal(getErrorRecovery('DIALOG_BLOCKED')?.retry, false);
  assert.equal(getErrorRecovery('DIALOG_BLOCKED')?.alternativeMethod, 'page.handle_dialog');
});
