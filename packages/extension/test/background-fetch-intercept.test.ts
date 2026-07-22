import test from 'node:test';
import assert from 'node:assert/strict';

import { createFetchInterceptor } from '../src/background-fetch-intercept.js';
import { TabDebuggerCoordinator } from '../src/debugger-coordinator.js';

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

test('Fetch disable failures still release the debugger hold', async () => {
  const { interceptor, released } = createHarness({
    sendCommandError: (method) =>
      method === 'Fetch.disable' ? new Error('already disabled') : null,
  });
  await interceptor.addRule(1, { urlPattern: '*', action: 'continue' });
  assert.equal(await interceptor.clearAllRules(1), 1);
  assert.deepEqual(released, [1]);
});

test('addRule rolls back the rule when debugger acquisition fails', async () => {
  const { interceptor, filters, sent } = createHarness({
    acquireError: new Error('Cannot attach'),
  });

  await assert.rejects(
    interceptor.addRule(3, { urlPattern: '*', action: 'block' }),
    /Cannot attach/
  );
  assert.deepEqual(interceptor.listRules(3), []);
  assert.equal(filters.has(3), false);
  assert.equal(lastEnable(sent), undefined);
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
