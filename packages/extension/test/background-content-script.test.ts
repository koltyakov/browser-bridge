import test from 'node:test';
import assert from 'node:assert/strict';

import { createRequest, ERROR_CODES } from '../../../protocol/src/index.js';
import { createContentScriptBridge } from '../src/background-content-script.js';
import { requestLifetimes } from '../src/background-request-lifetime.js';
import { createChromeFake } from '../../../tests/_helpers/chromeFake.ts';

for (const frameId of [0, 7]) {
  for (const succeeds of [false, true]) {
    test(`frame ${frameId} retains a timed-out mutation until its command ${succeeds ? 'resolves' : 'rejects'}`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const request = createRequest({
        id: `timeout-${frameId}-${succeeds}`,
        method: 'input.click',
        meta: { deadline_ms: Date.now() + 30_000 },
      });
      const finish = requestLifetimes.begin(request);
      let resolveCommand!: (value: unknown) => void;
      let rejectCommand!: (error: Error) => void;
      const command = new Promise((resolve, reject) => {
        resolveCommand = resolve;
        rejectCommand = reject;
      });
      const messages: Array<{ message: Record<string, unknown>; frameId: number }> = [];
      const chromeFake = createChromeFake({
        tabs: {
          sendMessage: async (
            _tabId: number,
            message: Record<string, unknown>,
            options: { frameId: number }
          ) => {
            messages.push({ message, frameId: options.frameId });
            return message.type === 'bridge.execute' ? command : {};
          },
        },
      });
      const bridge = createContentScriptBridge(chromeFake as unknown as typeof chrome, {
        contentScriptTimeoutMs: 100,
        isRestrictedAutomationUrl: () => false,
      });
      try {
        let settled = false;
        const response = bridge
          .sendFrameMessage(
            8,
            frameId,
            {
              type: 'bridge.execute',
              requestId: request.id,
              deadlineMs: request.meta.deadline_ms,
              method: request.method,
            },
            100
          )
          .finally(() => {
            settled = true;
          });
        const rejected = assert.rejects(response, { code: ERROR_CODES.TIMEOUT });
        await Promise.resolve();
        assert(Number(messages[0].message.deadlineMs) < Number(request.meta.deadline_ms));
        t.mock.timers.tick(100);
        await Promise.resolve();
        assert.equal(settled, false, 'timeout must not release the mutation turn');
        assert.deepEqual(messages[1], {
          message: { type: 'bridge.cancel', requestId: request.id },
          frameId,
        });
        requestLifetimes.cancel(request.id);
        assert.equal(messages.length, 2, 'cancellation is idempotent');
        if (succeeds) resolveCommand({ clicked: true });
        else rejectCommand(new Error('The frame was removed.'));
        await rejected;
        assert.equal(settled, true);
      } finally {
        resolveCommand({});
        finish();
      }
    });
  }
}

test('a timed-out mutation releases its turn after the grace period when the page never settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = createRequest({
    id: 'timeout-unsettled',
    method: 'input.click',
    meta: { deadline_ms: Date.now() + 30_000 },
  });
  const finish = requestLifetimes.begin(request);
  const chromeFake = createChromeFake({
    tabs: {
      sendMessage: async (_tabId: number, message: Record<string, unknown>) =>
        message.type === 'bridge.execute' ? new Promise(() => {}) : {},
    },
  });
  const bridge = createContentScriptBridge(chromeFake as unknown as typeof chrome, {
    contentScriptTimeoutMs: 100,
    unsettledCommandGraceMs: 1_000,
    isRestrictedAutomationUrl: () => false,
  });
  try {
    let settled = false;
    const response = bridge
      .sendTabMessage(
        8,
        { type: 'bridge.execute', requestId: request.id, method: request.method },
        100
      )
      .finally(() => {
        settled = true;
      });
    const rejected = assert.rejects(response, { code: ERROR_CODES.TIMEOUT });
    const flush = async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    };
    await flush();
    t.mock.timers.tick(100);
    await flush();
    t.mock.timers.tick(999);
    await flush();
    assert.equal(settled, false, 'the turn is held during the grace period');
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(settled, true);
  } finally {
    finish();
  }
});

test('read-only content timeouts cancel without waiting for renderer settlement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveCommand!: (value: unknown) => void;
  const command = new Promise((resolve) => {
    resolveCommand = resolve;
  });
  const messages: Array<Record<string, unknown>> = [];
  const chromeFake = createChromeFake({
    tabs: {
      sendMessage: async (_tabId: number, message: Record<string, unknown>) => {
        messages.push(message);
        return message.type === 'bridge.execute' ? command : {};
      },
    },
  });
  const bridge = createContentScriptBridge(chromeFake as unknown as typeof chrome, {
    contentScriptTimeoutMs: 100,
    isRestrictedAutomationUrl: () => false,
  });
  const response = bridge.sendTabMessage(8, { type: 'bridge.execute', method: 'dom.query' }, 100);
  const rejected = assert.rejects(response, { code: ERROR_CODES.TIMEOUT });
  await Promise.resolve();
  t.mock.timers.tick(100);
  await rejected;
  assert.equal(typeof messages[0].requestId, 'string');
  assert.equal(typeof messages[0].deadlineMs, 'number');
  assert.deepEqual(messages[1], {
    type: 'bridge.cancel',
    requestId: messages[0].requestId,
  });
  resolveCommand({});
});

test('already canceled content requests never dispatch or reinject', async () => {
  const request = createRequest({ id: 'canceled-before-send', method: 'input.click' });
  const finish = requestLifetimes.begin(request);
  const chromeFake = createChromeFake({
    tabs: { sendMessage: async () => assert.fail('must not dispatch') },
    scripting: { executeScript: async () => assert.fail('must not reinject') },
  });
  const bridge = createContentScriptBridge(chromeFake as unknown as typeof chrome, {
    contentScriptTimeoutMs: 100,
    isRestrictedAutomationUrl: () => false,
  });
  try {
    requestLifetimes.cancel(request.id);
    await assert.rejects(
      bridge.sendTabMessage(
        8,
        { type: 'bridge.execute', requestId: request.id, method: request.method },
        100
      ),
      { code: ERROR_CODES.TIMEOUT }
    );
  } finally {
    finish();
  }
});

function createHarness(failMain = false) {
  const injections: Array<Record<string, unknown>> = [];
  const recoveryOutcomes: Array<{ outcome: 'success' | 'failure'; group: string }> = [];
  const chromeObj = {
    tabs: {
      async sendMessage() {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
      async query() {
        return [];
      },
    },
    scripting: {
      async executeScript(details: Record<string, unknown>) {
        injections.push(details);
        if (failMain && details.world === 'MAIN' && injections.length === 2) {
          throw new Error('MAIN injection failed');
        }
        return [];
      },
    },
  } as unknown as typeof chrome;
  return {
    injections,
    bridge: createContentScriptBridge(chromeObj, {
      contentScriptTimeoutMs: 1_000,
      isRestrictedAutomationUrl: () => false,
      recordReinjection: (outcome, group) => recoveryOutcomes.push({ outcome, group }),
    }),
    recoveryOutcomes,
  };
}

test('general content-script injection does not install navigation listeners or MAIN hooks', async () => {
  const { bridge, injections } = createHarness();

  await bridge.ensureContentScript(8);

  assert.equal(injections.length, 1);
  assert.deepEqual(injections[0].target, { tabId: 8 });
  assert.equal(injections[0].world, undefined);
  assert.ok(Array.isArray(injections[0].files));
  assert.deepEqual(injections[0].files, [
    'src/content-script-helpers.js',
    'src/content-dom-baseline.js',
    'src/content-element-registry.js',
    'src/content-dom-query.js',
    'src/content-input.js',
    'src/content-patch.js',
    'src/content-script.js',
  ]);
  assert.equal(injections[0].func, undefined);
});

test('concurrent content-script checks share one ping per tab without caching readiness', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pings: number[] = [];
  const chromeFake = createChromeFake({
    tabs: {
      sendMessage: async (tabId: number) => {
        pings.push(tabId);
        await pending;
        return { ok: true };
      },
    },
    scripting: { executeScript: async () => assert.fail('ready tabs must not reinject') },
  });
  const bridge = createContentScriptBridge(chromeFake as unknown as typeof chrome, {
    contentScriptTimeoutMs: 1_000,
    isRestrictedAutomationUrl: () => false,
  });
  const checks = [
    ...Array.from({ length: 16 }, () => bridge.ensureContentScript(8)),
    bridge.ensureContentScript(9),
  ];
  try {
    await Promise.resolve();
    assert.deepEqual(pings, [8, 9]);
  } finally {
    release();
    await Promise.all(checks);
  }
  await bridge.ensureContentScript(8);
  assert.deepEqual(pings, [8, 9, 8], 'later requests recheck the current document');
});

for (const fails of [false, true]) {
  test(`concurrent content-script checks share injection ${fails ? 'failure' : 'success'} and clear pending work`, async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let injections = 0;
    const outcomes: string[] = [];
    const chromeFake = createChromeFake({
      tabs: {
        sendMessage: async () => {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        },
      },
      scripting: {
        executeScript: async () => {
          injections += 1;
          await pending;
          if (fails) throw new Error('Injection failed');
          return [];
        },
      },
    });
    const bridge = createContentScriptBridge(chromeFake as unknown as typeof chrome, {
      contentScriptTimeoutMs: 1_000,
      isRestrictedAutomationUrl: () => false,
      recordReinjection: (outcome) => outcomes.push(outcome),
    });
    const checks = Promise.allSettled(
      Array.from({ length: 16 }, () => bridge.ensureContentScript(8))
    );
    release();
    const results = await checks;
    assert.equal(injections, 1);
    assert.deepEqual(outcomes, [fails ? 'failure' : 'success']);
    assert(results.every((result) => result.status === (fails ? 'rejected' : 'fulfilled')));
    if (fails) await assert.rejects(bridge.ensureContentScript(8), /Injection failed/);
    else await bridge.ensureContentScript(8);
    assert.equal(injections, 2, 'settled setup must not suppress later injections');
  });
}

test('preflight and missing-receiver recovery share injection but not command results', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const injecting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let ready = false;
  let injections = 0;
  const attempts = new Map<string, number>();
  const chromeFake = createChromeFake({
    tabs: {
      sendMessage: async (_tabId: number, message: Record<string, unknown>) => {
        if (message.type === 'bridge.execute') {
          const id = String(message.requestId);
          attempts.set(id, (attempts.get(id) ?? 0) + 1);
        }
        if (!ready)
          throw new Error('Could not establish connection. Receiving end does not exist.');
        return message.method;
      },
    },
    scripting: {
      executeScript: async () => {
        injections += 1;
        started();
        await pending;
        ready = true;
        return [];
      },
    },
  });
  const bridge = createContentScriptBridge(chromeFake as unknown as typeof chrome, {
    contentScriptTimeoutMs: 1_000,
    isRestrictedAutomationUrl: () => false,
  });
  const check = bridge.ensureContentScript(8);
  await injecting;
  const commands = ['page.get_state', 'page.get_text'].map((method) =>
    bridge.sendTabMessage(8, { type: 'bridge.execute', requestId: method, method }, 1_000)
  );
  try {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    assert.equal(injections, 1);
  } finally {
    release();
    await check;
    assert.deepEqual(await Promise.all(commands), ['page.get_state', 'page.get_text']);
  }
  assert.deepEqual(
    [...attempts],
    [
      ['page.get_state', 2],
      ['page.get_text', 2],
    ]
  );
});

test('restricted content-script injection returns a typed non-retryable error', async () => {
  const recoveryOutcomes: Array<{ outcome: 'success' | 'failure'; group: string }> = [];
  const chromeObj = {
    tabs: {
      async sendMessage() {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
      async query() {
        return [];
      },
    },
    scripting: {
      async executeScript() {
        throw new Error('Cannot access contents of url "chrome://settings".');
      },
    },
  } as unknown as typeof chrome;
  const bridge = createContentScriptBridge(chromeObj, {
    contentScriptTimeoutMs: 1_000,
    isRestrictedAutomationUrl: () => false,
    recordReinjection: (outcome, group) => recoveryOutcomes.push({ outcome, group }),
  });

  await assert.rejects(
    () => bridge.ensureContentScript(8),
    (error: { code?: string }) => error.code === ERROR_CODES.CONTENT_SCRIPT_UNAVAILABLE
  );
  assert.deepEqual(recoveryOutcomes, [{ outcome: 'failure', group: '8' }]);
});

test('missing content-script recovery records injection separately from replay', async () => {
  const { bridge, recoveryOutcomes } = createHarness();
  await assert.rejects(
    bridge.sendTabMessage(8, { type: 'bridge.execute' }, 100),
    /Receiving end does not exist/u
  );
  assert.deepEqual(recoveryOutcomes, [{ outcome: 'success', group: '8' }]);
});

test('URL wait signal instrumentation installs and uninstalls both worlds on demand', async () => {
  const { bridge, injections } = createHarness();

  await bridge.installNavigationSignals(7, 'channel-1');
  await bridge.uninstallNavigationSignals(7, 'channel-1');

  assert.equal(injections.length, 4);
  assert.deepEqual(
    injections.map((call) => ({ target: call.target, world: call.world, args: call.args })),
    [
      { target: { tabId: 7 }, world: undefined, args: ['channel-1'] },
      { target: { tabId: 7 }, world: 'MAIN', args: ['channel-1'] },
      { target: { tabId: 7 }, world: 'MAIN', args: ['channel-1'] },
      { target: { tabId: 7 }, world: undefined, args: ['channel-1'] },
    ]
  );
});

test('failed MAIN-world installation rolls back the isolated half', async () => {
  const { bridge, injections } = createHarness(true);

  await assert.rejects(bridge.installNavigationSignals(9, 'channel-2'), /MAIN injection failed/);

  assert.equal(injections.length, 4);
  assert.deepEqual(
    injections.slice(2).map((call) => call.world),
    ['MAIN', undefined]
  );
});

test('late tabs receive independent signal channels only when their waits request them', async () => {
  const { bridge, injections } = createHarness();

  await bridge.installNavigationSignals(10, 'late-10');
  await bridge.installNavigationSignals(11, 'late-11');

  assert.deepEqual(
    injections.map((call) => ({
      tabId: (call.target as { tabId: number }).tabId,
      args: call.args,
    })),
    [
      { tabId: 10, args: ['late-10'] },
      { tabId: 10, args: ['late-10'] },
      { tabId: 11, args: ['late-11'] },
      { tabId: 11, args: ['late-11'] },
    ]
  );
});
