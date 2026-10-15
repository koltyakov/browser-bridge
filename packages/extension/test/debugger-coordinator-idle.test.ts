import test from 'node:test';
import assert from 'node:assert/strict';

import { TabDebuggerCoordinator } from '../src/debugger-coordinator.js';

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('standalone stateless reads release immediately once idle, including failures', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attachCount = 0;
  let detachCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      attachCount += 1;
    },
    detach: async () => {
      detachCount += 1;
    },
  });

  assert.equal(await coordinator.run(7, async () => 'read', { releaseAfterRun: true }), 'read');
  t.mock.timers.tick(0);
  await flush();
  assert.equal(detachCount, 1);
  assert.equal(coordinator.burstRetainedTabs.size, 0);

  await assert.rejects(
    coordinator.run(
      7,
      async () => {
        throw new Error('read failed');
      },
      { releaseAfterRun: true }
    ),
    /read failed/
  );
  t.mock.timers.tick(0);
  await flush();
  assert.equal(attachCount, 2);
  assert.equal(detachCount, 2);
  assert.equal(coordinator.attachedTabs.size, 0);
});

test('queued stateless reads reuse the same short-lived attachment', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attachCount = 0;
  let detachCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      attachCount += 1;
    },
    detach: async () => {
      detachCount += 1;
    },
  });

  const results = await Promise.all([
    coordinator.run(7, async () => 'first', { releaseAfterRun: true }),
    coordinator.run(7, async () => 'second', { releaseAfterRun: true }),
  ]);
  assert.deepEqual(results, ['first', 'second']);
  assert.equal(attachCount, 1);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(detachCount, 1);
});

test('stateless reads preserve and refresh an existing stateful burst session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let detachCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {
      detachCount += 1;
    },
  });

  await coordinator.run(7, async () => 'CDP node ids');
  t.mock.timers.tick(4_000);
  await coordinator.run(7, async () => 'screenshot', { releaseAfterRun: true });
  t.mock.timers.tick(4_999);
  await flush();
  assert.equal(detachCount, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(detachCount, 1);
  assert.equal(coordinator.burstRetainedTabs.size, 0);
});

test('stateful work promotes a transient attachment to normal burst retention', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attachCount = 0;
  let detachCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      attachCount += 1;
    },
    detach: async () => {
      detachCount += 1;
    },
  });

  await coordinator.run(7, async () => 'read', { releaseAfterRun: true });
  await coordinator.run(7, async () => 'native input');
  await coordinator.run(7, async () => 'another read', { releaseAfterRun: true });
  t.mock.timers.tick(0);
  await flush();
  assert.equal(attachCount, 1);
  assert.equal(detachCount, 0);
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(detachCount, 1);
});

test('stateless reads never detach an explicit capture or interception hold', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let detachCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {
      detachCount += 1;
    },
  });

  await coordinator.acquire(7);
  await coordinator.acquire(7);
  await coordinator.run(7, async () => 'read', { releaseAfterRun: true });
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(detachCount, 0);
  await coordinator.release(7);
  assert.equal(detachCount, 0);
  await coordinator.release(7);
  assert.equal(detachCount, 1);
});

test('transient idle release does not interrupt work or a subsequent hold', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finishRead: () => void = () => {};
  let detachCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {
      detachCount += 1;
    },
  });
  const pending = coordinator.run(
    7,
    async () => {
      await new Promise<void>((resolve) => {
        finishRead = resolve;
      });
    },
    { releaseAfterRun: true }
  );
  await flush();
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(detachCount, 0);
  finishRead();
  await pending;
  await coordinator.acquire(7);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(detachCount, 0);
  await coordinator.release(7);
  assert.equal(detachCount, 1);
});

test('observed dialogs remain inspectable past idle expiry until they close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let detachCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {
      detachCount += 1;
    },
  });
  for (const timing of ['during', 'after']) {
    const openDialog = () =>
      coordinator.handleEvent(7, 'Page.javascriptDialogOpening', {
        type: 'confirm',
        message: 'Keep this dialog observable',
      });
    await coordinator.run(
      7,
      async () => {
        if (timing === 'during') openDialog();
      },
      { releaseAfterRun: true }
    );
    if (timing === 'after') openDialog();
    t.mock.timers.tick(0);
    await flush();
    assert.equal(coordinator.attachedTabs.has(7), true);
    assert.equal(coordinator.getDialog(7)?.type, 'confirm');
    t.mock.timers.tick(5_000);
    await flush();
    assert.equal(coordinator.attachedTabs.has(7), true);
    coordinator.handleEvent(7, 'Page.javascriptDialogClosed', {});
    t.mock.timers.tick(5_000);
    await flush();
    assert.equal(coordinator.attachedTabs.has(7), false);
  }
  assert.equal(detachCount, 2);
});

test('cleanup and external detach clear retained policy before fresh reads', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {},
  });
  for (const cleanup of [() => coordinator.discard(7), () => coordinator.markDetached(7)]) {
    await coordinator.run(7, async () => {});
    assert.equal(coordinator.burstRetainedTabs.has(7), true);
    await cleanup();
    assert.equal(coordinator.burstRetainedTabs.has(7), false);
    await coordinator.run(7, async () => {}, { releaseAfterRun: true });
    t.mock.timers.tick(0);
    await flush();
    assert.equal(coordinator.attachedTabs.has(7), false);
  }
});

test('detached stateless reads retain read-only retry and release the recovered session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attachCount = 0;
  let readCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      attachCount += 1;
    },
    detach: async () => {},
  });
  const value = await coordinator.run(
    7,
    async () => {
      readCount += 1;
      if (readCount === 1) throw new Error('Debugger is not attached');
      return 'recovered';
    },
    { retryDetached: true, releaseAfterRun: true }
  );
  assert.equal(value, 'recovered');
  assert.equal(attachCount, 2);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(coordinator.attachedTabs.size, 0);
});
