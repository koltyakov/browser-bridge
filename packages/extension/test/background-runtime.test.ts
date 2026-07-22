import test from 'node:test';
import assert from 'node:assert/strict';

import { createRuntimeMessageListener } from '../src/background-runtime.js';

type RuntimeResponse = { ok: boolean; error?: string };
type OpenSidePanelCall = { tabId: number; windowId: number };

async function flushMicrotasks() {
  await Promise.resolve();
}

test('background runtime routes explicit side-panel requests', async () => {
  const calls: OpenSidePanelCall[] = [];
  const responses: RuntimeResponse[] = [];
  const listener = createRuntimeMessageListener({
    openSidePanelForTab: async (tabId, windowId) => {
      calls.push({ tabId, windowId });
    },
  });

  assert.equal(
    listener(
      { type: 'bridge.open-sidepanel', tabId: 17, windowId: 23 },
      {} as chrome.runtime.MessageSender,
      (response) => responses.push(response)
    ),
    true
  );

  await flushMicrotasks();

  assert.deepEqual(calls, [{ tabId: 17, windowId: 23 }]);
  assert.deepEqual(responses, [{ ok: true }]);
});

test('background runtime falls back to sender tab metadata', async () => {
  const calls: OpenSidePanelCall[] = [];
  const responses: RuntimeResponse[] = [];
  const listener = createRuntimeMessageListener({
    openSidePanelForTab: async (tabId, windowId) => {
      calls.push({ tabId, windowId });
    },
  });

  assert.equal(
    listener(
      { type: 'bridge.open-sidepanel' },
      {
        tab: { id: 9, windowId: 12 },
      } as unknown as chrome.runtime.MessageSender,
      (response) => responses.push(response)
    ),
    true
  );

  await flushMicrotasks();

  assert.deepEqual(calls, [{ tabId: 9, windowId: 12 }]);
  assert.deepEqual(responses, [{ ok: true }]);
});

test('background runtime reports side-panel open failures to the caller', async () => {
  const responses: RuntimeResponse[] = [];
  const listener = createRuntimeMessageListener({
    openSidePanelForTab: async () => {
      throw new Error('panel unavailable');
    },
  });

  assert.equal(
    listener(
      { type: 'bridge.open-sidepanel', tabId: 2, windowId: 4 },
      {} as chrome.runtime.MessageSender,
      (response) => responses.push(response)
    ),
    true
  );

  await flushMicrotasks();

  assert.deepEqual(responses, [{ ok: false, error: 'panel unavailable' }]);
});

test('background runtime ignores unrelated or unroutable messages', async () => {
  let called = false;
  const listener = createRuntimeMessageListener({
    openSidePanelForTab: async () => {
      called = true;
    },
  });

  assert.equal(
    listener(
      { type: 'bridge.noop' },
      {
        tab: { id: 9, windowId: 12 },
      } as unknown as chrome.runtime.MessageSender,
      () => {
        throw new Error('sendResponse should not be called');
      }
    ),
    false
  );

  assert.equal(
    listener({ type: 'bridge.open-sidepanel' }, {} as chrome.runtime.MessageSender, () => {
      throw new Error('sendResponse should not be called');
    }),
    false
  );

  await flushMicrotasks();

  assert.equal(called, false);
});

test('background runtime accepts navigation kinds only from sender tabs', () => {
  const signals: Array<{ tabId: number; kind: string; channel: string }> = [];
  const listener = createRuntimeMessageListener({
    openSidePanelForTab: async () => {},
    onNavigationSignal(tabId, kind, channel) {
      signals.push({ tabId, kind, channel });
    },
  });
  const sender = { tab: { id: 19, windowId: 4 } } as unknown as chrome.runtime.MessageSender;

  assert.equal(
    listener(
      { type: 'bridge.navigation-signal', channel: 'channel-1', kind: 'pushState' },
      sender,
      () => {}
    ),
    false
  );
  assert.equal(
    listener(
      { type: 'bridge.navigation-signal', channel: 'channel-1', kind: 'invalid' },
      sender,
      () => {}
    ),
    false
  );
  assert.equal(
    listener(
      { type: 'bridge.navigation-signal', channel: 'channel-1', kind: 'hashchange' },
      {} as chrome.runtime.MessageSender,
      () => {}
    ),
    false
  );
  assert.equal(
    listener({ type: 'bridge.navigation-signal', kind: 'pushState' }, sender, () => {}),
    false
  );
  assert.deepEqual(signals, [{ tabId: 19, kind: 'pushState', channel: 'channel-1' }]);
});
