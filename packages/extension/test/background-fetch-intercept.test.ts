import test from 'node:test';
import assert from 'node:assert/strict';

import { createFetchInterceptor } from '../src/background-fetch-intercept.js';
import { TabDebuggerCoordinator } from '../src/debugger-coordinator.js';
import { MAX_INTERCEPT_RULES_PER_TAB } from '../../protocol/src/index.js';

type SentCommand = { tabId: number; method: string; params: Record<string, unknown> };
type FetchEventHandler = (method: string, params: unknown) => void;

function createHarness(
  overrides: {
    acquireError?: Error;
    sendCommandError?: (method: string) => Error | null;
  } = {}
) {
  const sent: SentCommand[] = [];
  const filters = new Map<number, FetchEventHandler>();
  const acquired: number[] = [];
  const released: number[] = [];

  const interceptor = createFetchInterceptor({
    acquireDebugger: async (tabId, init) => {
      if (overrides.acquireError) throw overrides.acquireError;
      acquired.push(tabId);
      await init?.({ tabId });
    },
    releaseDebugger: async (tabId) => {
      released.push(tabId);
    },
    sendCommand: async (target, method, params) => {
      sent.push({
        tabId: target.tabId,
        method,
        params: params as Record<string, unknown>,
      });
      const commandError = overrides.sendCommandError?.(method);
      if (commandError) throw commandError;
      return {};
    },
    addEventFilter: (tabId, handler) => filters.set(tabId, handler),
    removeEventFilter: (tabId) => filters.delete(tabId),
  });

  return { interceptor, sent, filters, acquired, released };
}

function lastEnable(sent: SentCommand[]): SentCommand | undefined {
  return [...sent].reverse().find((c) => c.method === 'Fetch.enable');
}

function enablePatterns(command: SentCommand | undefined): string[] {
  const patterns = (command?.params.patterns ?? []) as Array<{ urlPattern: string }>;
  return patterns.map((p) => p.urlPattern);
}

function createDeferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createCoordinatorHarness(
  options: {
    attach?: () => Promise<void>;
    sendCommand?: (method: string) => Promise<void>;
  } = {}
) {
  const sent: SentCommand[] = [];
  const filters = new Map<number, FetchEventHandler>();
  let detachCount = 0;
  const coordinator = new TabDebuggerCoordinator({
    attach: options.attach ?? (async () => {}),
    detach: async () => {
      detachCount += 1;
    },
  });
  const interceptor = createFetchInterceptor({
    acquireDebugger: (tabId, init) => coordinator.acquire(tabId, init),
    releaseDebugger: (tabId) => coordinator.release(tabId),
    assertDebuggerAvailable: (tabId) => coordinator.assertCanStart(tabId),
    sendCommand: async ({ tabId }, method, params) => {
      sent.push({ tabId, method, params: params as Record<string, unknown> });
      await options.sendCommand?.(method);
      return {};
    },
    addEventFilter: (tabId, handler) => filters.set(tabId, handler),
    removeEventFilter: (tabId) => filters.delete(tabId),
  });
  return { coordinator, interceptor, sent, filters, getDetachCount: () => detachCount };
}

test('stalled acquisition bounds flooded additions and mutations while reserving cleanup', async () => {
  const attaching = createDeferred();
  const attached = createDeferred();
  const { interceptor, coordinator } = createCoordinatorHarness({
    async attach() {
      attaching.resolve();
      await attached.promise;
    },
  });
  let rejected = 0;
  const observe = <T>(operation: Promise<T>) =>
    operation.catch((error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /at most 32|capacity exceeded/);
      rejected += 1;
      return null;
    });
  const first = interceptor.addRule(1, { urlPattern: '*', action: 'block' });
  await attaching.promise;
  const adds = Array.from({ length: 999 }, () =>
    observe(interceptor.addRule(1, { urlPattern: '*', action: 'block' }))
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejected, 968); // One running and 31 queued additions consume the rule quota.
  const removes = Array.from({ length: 1000 }, () => observe(interceptor.removeRule(1, 'missing')));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejected, 1936); // Only 32 more mutations fit the per-tab queue.
  const clearing = interceptor.clearAllRules(1);
  const clears = Array.from({ length: 999 }, () => observe(interceptor.clearAllRules(1)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejected, 2935);
  attached.resolve();
  await first;
  await Promise.all([...adds, ...removes, ...clears]);
  assert.equal(await clearing, 32);
  assert.deepEqual(interceptor.listRules(1), []);
  assert.equal(coordinator.getDiagnostics().status, 'idle');
  await interceptor.addRule(1, { urlPattern: '*recovered*', action: 'continue' });
  await interceptor.clearAllRules(1);
});

test('global admission bounds pending work but allows each saturated tab to clear', async () => {
  const attached = createDeferred();
  const { interceptor, coordinator } = createCoordinatorHarness({ attach: () => attached.promise });
  const adds: Array<Promise<unknown>> = [];
  for (let tabId = 1; tabId <= 8; tabId += 1) {
    for (let rule = 0; rule < 32; rule += 1) {
      adds.push(interceptor.addRule(tabId, { urlPattern: '*', action: 'block' }));
    }
  }
  await assert.rejects(interceptor.removeRule(1, 'missing'), /capacity exceeded/);
  await assert.rejects(interceptor.addRule(9, { urlPattern: '*' }), /capacity exceeded/);
  const clears = Array.from({ length: 8 }, (_, index) => interceptor.clearAllRules(index + 1));
  attached.resolve();
  await Promise.all(adds);
  assert.deepEqual(await Promise.all(clears), Array(8).fill(32));
  assert.equal(coordinator.getDiagnostics().status, 'idle');
  await interceptor.addRule(9, { urlPattern: '*' });
  await interceptor.clearAllRules(9);
});

test('admission bounds retained tabs and frees capacity after cleanup', async () => {
  const attached = createDeferred();
  const { interceptor, coordinator } = createCoordinatorHarness({ attach: () => attached.promise });
  let rejected = 0;
  const adds = Array.from({ length: 1000 }, (_, index) =>
    interceptor.addRule(index + 1, { urlPattern: '*' }).catch((error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /capacity exceeded/);
      rejected += 1;
    })
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejected, 936);
  attached.resolve();
  await Promise.all(adds);
  await assert.rejects(interceptor.addRule(1001, { urlPattern: '*' }), /capacity exceeded/);
  await interceptor.clearAllRules(1);
  await interceptor.addRule(1001, { urlPattern: '*' });
  await Promise.all(Array.from({ length: 64 }, (_, index) => interceptor.clearAllRules(index + 1)));
  await interceptor.clearAllRules(1001);
  assert.equal(coordinator.getDiagnostics().status, 'idle');
});

test('teardown retry retains its reserved admission when global work is saturated', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const attached = createDeferred();
  let stall = false;
  let failDisable = true;
  const { interceptor, coordinator, filters } = createCoordinatorHarness({
    async attach() {
      if (stall) await attached.promise;
    },
    async sendCommand(method) {
      if (method === 'Fetch.disable' && failDisable) throw new Error('temporary failure');
    },
  });
  await coordinator.acquire(1);
  await interceptor.addRule(1, { urlPattern: '*' });
  stall = true;
  const adds = Array.from({ length: 256 }, (_, index) =>
    interceptor.addRule(2 + Math.floor(index / 32), { urlPattern: '*' })
  );
  await assert.rejects(interceptor.removeRule(1, 'missing'), /capacity exceeded/);
  await assert.rejects(interceptor.clearAllRules(1), /temporary failure/);
  assert.equal(filters.has(1), true);
  failDisable = false;
  t.mock.timers.tick(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(filters.has(1), false);
  assert.equal(coordinator.holdsByTab.get(1), 1);
  attached.resolve();
  await Promise.all(adds);
  await Promise.all(Array.from({ length: 8 }, (_, index) => interceptor.clearAllRules(index + 2)));
  await coordinator.release(1);
  assert.equal(coordinator.getDiagnostics().status, 'idle');
});

test('Fetch holds share Page-initialized attachments and recover together after detach', async () => {
  const events: string[] = [];
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {
      events.push('attach');
    },
    detach: async () => {
      events.push('detach');
    },
    initialize: async () => {
      events.push('Page.enable');
    },
    burstIdleMs: 500,
  });
  const interceptor = createFetchInterceptor({
    acquireDebugger: (tabId, initialize) => coordinator.acquire(tabId, initialize),
    releaseDebugger: (tabId) => coordinator.release(tabId),
    async sendCommand(_target, method) {
      events.push(method);
      return {};
    },
    addEventFilter() {},
    removeEventFilter() {},
  });

  await interceptor.addRule(5, { urlPattern: '*first*', action: 'block' });
  await coordinator.run(5, async () => {
    events.push('dialog.inspect');
  });
  assert.deepEqual(events, ['attach', 'Page.enable', 'Fetch.enable', 'dialog.inspect']);

  coordinator.markDetached(5);
  interceptor.handleDetach(5);
  await interceptor.addRule(5, { urlPattern: '*second*', action: 'block' });
  assert.deepEqual(events.slice(-3), ['attach', 'Page.enable', 'Fetch.enable']);
  await interceptor.clearAllRules(5);
  assert.equal(events.at(-1), 'detach');
});

test('addRule acquires the debugger and enables Fetch scoped to the rule pattern', async () => {
  const { interceptor, sent, filters, acquired } = createHarness();

  const rule = await interceptor.addRule(1, {
    urlPattern: 'https://api.example.com/*',
    action: 'block',
  });

  assert.match(rule.ruleId, /^intercept_\d+$/);
  assert.deepEqual(acquired, [1]);
  assert.ok(filters.has(1));
  assert.deepEqual(enablePatterns(lastEnable(sent)), ['https://api.example.com/*']);
  assert.deepEqual(interceptor.getDiagnostics(), {
    status: 'active',
    activeTabCount: 1,
    ruleCount: 1,
  });
});

test('addRule defaults an omitted action to continue', async () => {
  const { interceptor } = createHarness();

  const rule = await interceptor.addRule(1, {
    urlPattern: 'https://api.example.com/*',
  });

  assert.equal(rule.action, 'continue');
});

test('addRule enforces the per-tab rule cap and does not expose compiled matchers', async () => {
  const { interceptor } = createHarness();

  for (let index = 0; index < MAX_INTERCEPT_RULES_PER_TAB; index += 1) {
    const rule = await interceptor.addRule(1, {
      urlPattern: `*rule-${index}*`,
      action: 'continue',
    });
    assert.equal('matcher' in rule, false);
  }

  await assert.rejects(
    interceptor.addRule(1, { urlPattern: '*overflow*', action: 'continue' }),
    /at most 32 active or pending interception rules/
  );
  assert.equal(interceptor.listRules(1).length, MAX_INTERCEPT_RULES_PER_TAB);
  assert.equal(
    interceptor.listRules(1).some((rule) => 'matcher' in rule),
    false
  );
});

test('adding and removing rules re-sends Fetch.enable with the current pattern set', async () => {
  const { interceptor, sent } = createHarness();

  const first = await interceptor.addRule(1, { urlPattern: '*one*', action: 'block' });
  await interceptor.addRule(1, { urlPattern: '*two*', action: 'block' });
  assert.deepEqual(enablePatterns(lastEnable(sent)), ['*one*', '*two*']);

  // Duplicate patterns are deduped.
  await interceptor.addRule(1, { urlPattern: '*two*', action: 'continue' });
  assert.deepEqual(enablePatterns(lastEnable(sent)), ['*one*', '*two*']);

  const removed = await interceptor.removeRule(1, first.ruleId);
  assert.equal(removed, true);
  assert.deepEqual(enablePatterns(lastEnable(sent)), ['*two*']);
});

test('removing the last rule releases the debugger and clears the event filter', async () => {
  const { interceptor, filters, released } = createHarness();

  const rule = await interceptor.addRule(7, { urlPattern: '*', action: 'block' });
  await interceptor.removeRule(7, rule.ruleId);

  assert.deepEqual(released, [7]);
  assert.equal(filters.has(7), false);
  assert.deepEqual(interceptor.listRules(7), []);
  assert.deepEqual(interceptor.getDiagnostics(), {
    status: 'idle',
    activeTabCount: 0,
    ruleCount: 0,
  });
});

test('removeRule returns false for unknown tab or rule id', async () => {
  const { interceptor } = createHarness();
  assert.equal(await interceptor.removeRule(99, 'intercept_1'), false);

  await interceptor.addRule(1, { urlPattern: '*', action: 'block' });
  assert.equal(await interceptor.removeRule(1, 'no-such-rule'), false);
  assert.equal(interceptor.listRules(1).length, 1);
});

test('clearAllRules reports the cleared count and releases the tab', async () => {
  const { interceptor, released } = createHarness();

  await interceptor.addRule(2, { urlPattern: '*a*', action: 'block' });
  await interceptor.addRule(2, { urlPattern: '*b*', action: 'block' });

  assert.equal(await interceptor.clearAllRules(2), 2);
  assert.deepEqual(released, [2]);
  assert.deepEqual(interceptor.listRules(2), []);
  assert.equal(await interceptor.clearAllRules(2), 0);
});

test('failed Fetch teardown retains shared ownership and passes requests through until retry succeeds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let failDisable = true;
  const { coordinator, interceptor, sent, filters, getDetachCount } = createCoordinatorHarness({
    async sendCommand(method) {
      if (method === 'Fetch.disable' && failDisable) throw new Error('temporary CDP failure');
    },
  });
  await coordinator.acquire(1); // A separate domain retains the physical session.
  await interceptor.addRule(1, { urlPattern: '*', action: 'block' });
  await assert.rejects(interceptor.clearAllRules(1), /temporary CDP failure/);
  assert.equal(coordinator.holdsByTab.get(1), 2);
  assert.equal(getDetachCount(), 0);
  assert.deepEqual(interceptor.listRules(1), []);
  assert.deepEqual(interceptor.getDiagnostics(), {
    status: 'active',
    activeTabCount: 1,
    ruleCount: 0,
  });
  filters.get(1)?.('Fetch.requestPaused', {
    requestId: 'during-stop',
    request: { url: 'https://example.com', headers: {} },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    sent.some(
      (command) =>
        command.method === 'Fetch.continueRequest' && command.params.requestId === 'during-stop'
    )
  );
  assert.equal(
    sent.some((command) => command.method === 'Fetch.failRequest'),
    false
  );

  t.mock.timers.tick(4_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.filter((command) => command.method === 'Fetch.disable').length, 1);
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.filter((command) => command.method === 'Fetch.disable').length, 2);
  assert.equal(filters.has(1), true);
  assert.equal(coordinator.holdsByTab.get(1), 2);

  failDisable = false;
  t.mock.timers.tick(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(filters.has(1), false);
  assert.equal(coordinator.holdsByTab.get(1), 1);
  assert.equal(getDetachCount(), 0);
  assert.equal(interceptor.getDiagnostics().status, 'idle');
  await coordinator.release(1);
  assert.equal(getDetachCount(), 1);
});

test('clear waits for pending acquisition and releases its completed hold', async () => {
  const attaching = createDeferred();
  const attached = createDeferred();
  const { coordinator, interceptor, sent, filters, getDetachCount } = createCoordinatorHarness({
    async attach() {
      attaching.resolve();
      await attached.promise;
    },
  });
  const adding = interceptor.addRule(1, { urlPattern: '*', action: 'block' });
  await attaching.promise;
  const clearing = interceptor.clearAllRules(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0);
  attached.resolve();
  await adding;
  assert.equal(await clearing, 1);
  assert.deepEqual(
    sent.map((command) => command.method),
    ['Fetch.enable', 'Fetch.disable']
  );
  assert.deepEqual(interceptor.listRules(1), []);
  assert.equal(filters.has(1), false);
  assert.equal(coordinator.holdsByTab.size, 0);
  assert.equal(coordinator.getDiagnostics().status, 'idle');
  assert.equal(getDetachCount(), 1);
});

test('new rules cannot overtake pending teardown or be removed by an old retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const disabling = createDeferred();
  const disabled = createDeferred();
  let disableCount = 0;
  const { coordinator, interceptor, filters, sent } = createCoordinatorHarness({
    async sendCommand(method) {
      if (method !== 'Fetch.disable') return;
      disableCount += 1;
      if (disableCount === 1) throw new Error('temporary CDP failure');
      if (disableCount === 2) {
        disabling.resolve();
        await disabled.promise;
      }
    },
  });
  await coordinator.acquire(1);
  await interceptor.addRule(1, { urlPattern: '*old*', action: 'block' });
  await assert.rejects(interceptor.clearAllRules(1), /temporary CDP failure/);
  const adding = interceptor.addRule(1, { urlPattern: '*new*', action: 'block' });
  await disabling.promise;
  assert.equal(filters.has(1), true);
  assert.equal(coordinator.holdsByTab.get(1), 2);
  assert.equal(sent.filter((command) => command.method === 'Fetch.enable').length, 1);
  disabled.resolve();
  const rule = await adding;
  t.mock.timers.tick(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(interceptor.listRules(1), [rule]);
  assert.equal(coordinator.holdsByTab.get(1), 2);
  assert.equal(filters.has(1), true);
  await interceptor.clearAllRules(1);
  await coordinator.release(1);
});

test('physical detach cancels failed teardown retries without releasing another session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let failDisable = true;
  const { coordinator, interceptor, filters, sent } = createCoordinatorHarness({
    async sendCommand(method) {
      if (method === 'Fetch.disable' && failDisable) throw new Error('temporary CDP failure');
    },
  });
  await coordinator.acquire(1);
  await interceptor.addRule(1, { urlPattern: '*', action: 'block' });
  await assert.rejects(interceptor.clearAllRules(1), /temporary CDP failure/);
  coordinator.handleDetach(1, 'canceled_by_user');
  interceptor.handleDetach(1);
  assert.equal(filters.has(1), false);
  failDisable = false;
  const rule = await interceptor.addRule(1, { urlPattern: '*new*', action: 'continue' });
  t.mock.timers.tick(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.filter((command) => command.method === 'Fetch.disable').length, 1);
  assert.deepEqual(interceptor.listRules(1), [rule]);
  assert.equal(coordinator.holdsByTab.get(1), 1);
  await interceptor.clearAllRules(1);
});

test('explicit debugger cleanup can confirm detachment through Fetch.disable without an event', async () => {
  let detached = false;
  const { coordinator, interceptor, filters, sent } = createCoordinatorHarness({
    async sendCommand(method) {
      if (detached && method === 'Fetch.disable')
        throw new Error('Debugger is not attached to the tab with id: 1.');
    },
  });
  await interceptor.addRule(1, { urlPattern: '*', action: 'block' });
  await coordinator.discard(1);
  detached = true;
  assert.equal(await interceptor.clearAllRules(1), 1);
  assert.equal(filters.has(1), false);
  assert.equal(interceptor.getDiagnostics().status, 'idle');
  assert.equal(sent.filter((command) => command.method === 'Fetch.disable').length, 1);
  assert.equal(coordinator.holdsByTab.size, 0);
});

test('an expired TTL queued behind an add cannot clear its renewed rules', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const enabling = createDeferred();
  const enabled = createDeferred();
  let enableCount = 0;
  const { interceptor } = createCoordinatorHarness({
    async sendCommand(method) {
      if (method === 'Fetch.enable' && ++enableCount === 2) {
        enabling.resolve();
        await enabled.promise;
      }
    },
  });
  const first = await interceptor.addRule(1, { urlPattern: '*first*', action: 'block' });
  const adding = interceptor.addRule(1, { urlPattern: '*second*', action: 'block' });
  await enabling.promise;
  t.mock.timers.tick(10 * 60 * 1000);
  enabled.resolve();
  const second = await adding;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(interceptor.listRules(1), [first, second]);
  t.mock.timers.tick(10 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(interceptor.listRules(1), []);
});

test('addRule rolls back the rule when debugger acquisition fails', async () => {
  const { interceptor, filters, sent, released } = createHarness({
    acquireError: new Error('Cannot attach'),
  });

  await assert.rejects(
    interceptor.addRule(3, { urlPattern: '*', action: 'block' }),
    /Cannot attach/
  );
  assert.deepEqual(interceptor.listRules(3), []);
  assert.equal(filters.has(3), false);
  assert.equal(lastEnable(sent), undefined);
  assert.deepEqual(released, []);
});

test('detach during Fetch.enable rejects the stale add and lets queued acquisition recover', async () => {
  const enabling = createDeferred();
  const enabled = createDeferred();
  let enableCount = 0;
  const { coordinator, interceptor, filters } = createCoordinatorHarness({
    async sendCommand(method) {
      if (method === 'Fetch.enable' && ++enableCount === 1) {
        enabling.resolve();
        await enabled.promise;
      }
    },
  });
  const adding = interceptor.addRule(1, { urlPattern: '*old*', action: 'block' });
  const rejected = assert.rejects(adding, /Debugger detached while adding/);
  await enabling.promise;
  coordinator.handleDetach(1, 'canceled_by_user');
  interceptor.handleDetach(1);
  assert.equal(filters.has(1), false);
  const next = interceptor.addRule(1, { urlPattern: '*new*', action: 'block' });
  enabled.resolve();
  await rejected;
  const rule = await next;
  assert.deepEqual(interceptor.listRules(1), [rule]);
  assert.equal(coordinator.holdsByTab.get(1), 1);
  assert.equal(filters.has(1), true);
  await interceptor.clearAllRules(1);
});

test('failed Fetch.enable cleanup retains pass-through ownership and preserves the original error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fail = true;
  const { coordinator, interceptor, filters } = createCoordinatorHarness({
    async sendCommand(method) {
      if (fail && method === 'Fetch.enable') throw new Error('enable failed');
      if (fail && method === 'Fetch.disable') throw new Error('disable failed');
    },
  });
  await coordinator.acquire(1);
  await assert.rejects(
    interceptor.addRule(1, { urlPattern: '*', action: 'block' }),
    /enable failed/
  );
  assert.equal(coordinator.holdsByTab.get(1), 2);
  assert.equal(filters.has(1), true);
  assert.deepEqual(interceptor.listRules(1), []);
  fail = false;
  t.mock.timers.tick(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.holdsByTab.get(1), 1);
  assert.equal(filters.has(1), false);
  await coordinator.release(1);
});

test('addRule rejects invalid actions, status codes, bodies, and headers before acquiring', async () => {
  const { interceptor, acquired } = createHarness();
  const invalidRules: Array<{ rule: Record<string, unknown>; message: RegExp }> = [
    { rule: { urlPattern: '*', action: 'redirect' }, message: /action must be one of/ },
    {
      rule: { urlPattern: '*', action: 'fulfill', statusCode: 99 },
      message: /statusCode must be an integer/,
    },
    {
      rule: { urlPattern: '*', action: 'fulfill', body: { invalid: true } },
      message: /body must be a string/,
    },
    {
      rule: { urlPattern: '*', action: 'continue', headers: { 'x-test': 1 } },
      message: /must have a string value/,
    },
    {
      rule: { urlPattern: '*', action: 'continue', headers: { 'bad header': 'value' } },
      message: /Invalid header name/,
    },
  ];

  for (const { rule, message } of invalidRules) {
    await assert.rejects(interceptor.addRule(5, rule), message);
  }
  assert.deepEqual(acquired, []);
  assert.deepEqual(interceptor.listRules(5), []);
});

test('handleDetach drops rules and filters without touching the dead session', async () => {
  const { interceptor, filters, released, sent } = createHarness();

  await interceptor.addRule(4, { urlPattern: '*', action: 'block' });
  const sentBefore = sent.length;

  interceptor.handleDetach(4);

  assert.deepEqual(interceptor.listRules(4), []);
  assert.equal(filters.has(4), false);
  assert.deepEqual(released, []);
  assert.equal(sent.length, sentBefore);
});

test('requestPaused with a block rule fails the request as BlockedByClient', async () => {
  const { interceptor, sent, filters } = createHarness();
  await interceptor.addRule(1, { urlPattern: 'https://ads.example.com/*', action: 'block' });

  filters.get(1)?.('Fetch.requestPaused', {
    requestId: 'req-1',
    request: { url: 'https://ads.example.com/banner.js', method: 'GET', headers: [] },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const fail = sent.find((c) => c.method === 'Fetch.failRequest');
  assert.deepEqual(fail?.params, { requestId: 'req-1', errorReason: 'BlockedByClient' });
});

test('requestPaused with a fulfill rule responds with status, headers, and base64 body', async () => {
  const { interceptor, sent, filters } = createHarness();
  await interceptor.addRule(1, {
    urlPattern: '*api/users*',
    action: 'fulfill',
    statusCode: 503,
    body: '{"error":"down"}',
  });

  filters.get(1)?.('Fetch.requestPaused', {
    requestId: 'req-2',
    request: { url: 'https://example.com/api/users?id=1', method: 'GET', headers: [] },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const fulfill = sent.find((c) => c.method === 'Fetch.fulfillRequest');
  assert.equal(fulfill?.params.requestId, 'req-2');
  assert.equal(fulfill?.params.responseCode, 503);
  assert.deepEqual(fulfill?.params.responseHeaders, [
    { name: 'content-type', value: 'application/json' },
  ]);
  assert.equal(
    Buffer.from(String(fulfill?.params.body), 'base64').toString('utf8'),
    '{"error":"down"}'
  );
});

test('requestPaused merges continue-rule headers with originals case-insensitively', async () => {
  const { interceptor, sent, filters } = createHarness();
  await interceptor.addRule(1, {
    urlPattern: '*example.com*',
    action: 'continue',
    headers: { 'x-test': 'on', Authorization: 'replacement', 'x-added': 'new' },
  });

  filters.get(1)?.('Fetch.requestPaused', {
    requestId: 'req-3',
    request: {
      url: 'https://example.com/page',
      method: 'GET',
      headers: { Accept: 'text/html', 'X-Test': 'off', authorization: 'original' },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const cont = sent.find((c) => c.method === 'Fetch.continueRequest');
  assert.deepEqual(cont?.params, {
    requestId: 'req-3',
    headers: [
      { name: 'Accept', value: 'text/html' },
      { name: 'X-Test', value: 'on' },
      { name: 'authorization', value: 'replacement' },
      { name: 'x-added', value: 'new' },
    ],
  });
});

test('requestPaused attempts to continue when the matched action handler fails', async () => {
  const { interceptor, sent, filters } = createHarness({
    sendCommandError(method) {
      return method === 'Fetch.failRequest' ? new Error('fail command rejected') : null;
    },
  });
  await interceptor.addRule(1, { urlPattern: '*', action: 'block' });

  filters.get(1)?.('Fetch.requestPaused', {
    requestId: 'req-recover',
    request: { url: 'https://example.com/page', method: 'GET', headers: {} },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    sent.some(
      (command) =>
        command.method === 'Fetch.continueRequest' && command.params.requestId === 'req-recover'
    ),
    true
  );
});

test('requestPaused without a matching rule continues the request untouched', async () => {
  const { interceptor, sent, filters } = createHarness();
  await interceptor.addRule(1, { urlPattern: 'https://only-this.example.com/*', action: 'block' });

  filters.get(1)?.('Fetch.requestPaused', {
    requestId: 'req-4',
    request: { url: 'https://other.example.com/page', method: 'GET', headers: [] },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const cont = sent.find((c) => c.method === 'Fetch.continueRequest');
  assert.deepEqual(cont?.params, { requestId: 'req-4' });
  assert.equal(
    sent.some((c) => c.method === 'Fetch.failRequest'),
    false
  );
});

test('non-requestPaused debugger events are ignored', async () => {
  const { interceptor, sent, filters } = createHarness();
  await interceptor.addRule(1, { urlPattern: '*', action: 'block' });
  const sentBefore = sent.length;

  filters.get(1)?.('Network.responseReceived', { requestId: 'req-5' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.length, sentBefore);
});

test('pattern matching follows CDP glob semantics: * any chars, ? one char', async () => {
  const { interceptor, sent, filters } = createHarness();
  await interceptor.addRule(1, { urlPattern: 'https://a.example.com/v1?x=1*', action: 'block' });

  // "?" must behave as a single-char wildcard (matching the literal "?"),
  // not as a regex quantifier that makes the preceding char optional.
  filters.get(1)?.('Fetch.requestPaused', {
    requestId: 'req-6',
    request: { url: 'https://a.example.com/v1?x=123', method: 'GET', headers: [] },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    sent.some((c) => c.method === 'Fetch.failRequest' && c.params.requestId === 'req-6'),
    true
  );

  // Regex metacharacters in the pattern (the ".") stay literal: a URL where
  // "." is replaced by another char must not match.
  filters.get(1)?.('Fetch.requestPaused', {
    requestId: 'req-7',
    request: { url: 'https://aXexample.com/v1?x=199', method: 'GET', headers: [] },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    sent.some((c) => c.method === 'Fetch.failRequest' && c.params.requestId === 'req-7'),
    false
  );
});
