// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRuntimeMessageListener } from '../src/background-runtime.js';

/**
 * @returns {Promise<void>}
 */
async function flushMicrotasks() {
  await Promise.resolve();
}

test('background runtime routes explicit side-panel requests', async () => {
  /** @type {Array<{ tabId: number, windowId: number }>} */
  const calls = [];
  /** @type {Array<{ ok: boolean, error?: string }>} */
  const responses = [];
  const listener = createRuntimeMessageListener({
    openSidePanelForTab: async (tabId, windowId) => {
      calls.push({ tabId, windowId });
    },
  });

  assert.equal(
    listener(
      { type: 'bridge.open-sidepanel', tabId: 17, windowId: 23 },
      /** @type {chrome.runtime.MessageSender} */ ({}),
      (response) => responses.push(response)
    ),
    true
  );

  await flushMicrotasks();

  assert.deepEqual(calls, [{ tabId: 17, windowId: 23 }]);
  assert.deepEqual(responses, [{ ok: true }]);
});

test('background runtime falls back to sender tab metadata', async () => {
  /** @type {Array<{ tabId: number, windowId: number }>} */
  const calls = [];
  /** @type {Array<{ ok: boolean, error?: string }>} */
  const responses = [];
  const listener = createRuntimeMessageListener({
    openSidePanelForTab: async (tabId, windowId) => {
      calls.push({ tabId, windowId });
    },
  });

  assert.equal(
    listener(
      { type: 'bridge.open-sidepanel' },
      /** @type {chrome.runtime.MessageSender} */ ({
        tab: { id: 9, windowId: 12 },
      }),
      (response) => responses.push(response)
    ),
    true
  );

  await flushMicrotasks();

  assert.deepEqual(calls, [{ tabId: 9, windowId: 12 }]);
  assert.deepEqual(responses, [{ ok: true }]);
});

test('background runtime reports side-panel open failures to the caller', async () => {
  /** @type {Array<{ ok: boolean, error?: string }>} */
  const responses = [];
  const listener = createRuntimeMessageListener({
    openSidePanelForTab: async () => {
      throw new Error('panel unavailable');
    },
  });

  assert.equal(
    listener(
      { type: 'bridge.open-sidepanel', tabId: 2, windowId: 4 },
      /** @type {chrome.runtime.MessageSender} */ ({}),
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
      /** @type {chrome.runtime.MessageSender} */ ({
        tab: { id: 9, windowId: 12 },
      }),
      () => {
        throw new Error('sendResponse should not be called');
      }
    ),
    false
  );

  assert.equal(
    listener(
      { type: 'bridge.open-sidepanel' },
      /** @type {chrome.runtime.MessageSender} */ ({}),
      () => {
        throw new Error('sendResponse should not be called');
      }
    ),
    false
  );

  await flushMicrotasks();

  assert.equal(called, false);
});
