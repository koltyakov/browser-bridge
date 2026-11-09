import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createChromeEvent,
  createChromeFake,
  type FakeChromeEvent,
} from '../../../tests/_helpers/chromeFake.ts';
import { loadBackground } from '../../../tests/_helpers/loadBackground.ts';
import type { ExtensionState } from '../src/background-state.js';
import { createExtensionState } from '../src/background-state.js';
import { createAccessSettingsController } from '../src/background-access-settings.js';
import { getErrorMessageWithCauses } from '../src/background-helpers.js';

test('disabling access succeeds when a sibling tab is showing a Chrome error page', async () => {
  const tabs = [41, 43].map(
    (id) =>
      ({
        id,
        windowId: 7,
        url: 'https://example.com/',
        title: 'Example',
      }) as chrome.tabs.Tab
  );
  const chromeObj = createChromeFake({
    tabs: {
      async query() {
        return tabs;
      },
      async get(id: number) {
        return tabs.find((tab) => tab.id === id)!;
      },
      async sendMessage() {
        return { patches: [] };
      },
    },
    scripting: {
      async executeScript(details: { target: { tabId: number } }) {
        if (details.target.tabId === 43) throw new Error('Frame with ID 0 is showing error page');
        return [];
      },
    },
  });
  const loaded = await loadBackground({ chrome: chromeObj });
  const state = loaded.module.getStateForTest() as ExtensionState;
  state.enabledWindow = { windowId: 7, title: 'Example', enabledAt: 100 };
  const disable = loaded.module.disableWindowAccess as (
    windowId: number,
    enabledAt: number
  ) => Promise<void>;
  await assert.doesNotReject(disable(7, 100));
  assert.equal(state.enabledWindow, null);
});

test('genuine cleanup failures show their cause while access stays off and AI tabs still close', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const removed: number[] = [];
  const tabs = [41, 42].map(
    (id) => ({ id, windowId: 7, url: 'https://example.com/', title: 'Example' }) as chrome.tabs.Tab
  );
  const chromeObj = createChromeFake({
    tabs: {
      async query() {
        return tabs;
      },
      async get(id: number) {
        return tabs.find((tab) => tab.id === id)!;
      },
      async remove(id: number) {
        removed.push(id);
      },
      async sendMessage() {
        return { patches: [] };
      },
    },
    scripting: {
      async executeScript(details: { target: { tabId: number } }) {
        if (details.target.tabId === 41) throw new Error('Unexpected script failure');
        return [];
      },
    },
  });
  const loaded = await loadBackground({ chrome: chromeObj });
  const state = loaded.module.getStateForTest() as ExtensionState;
  state.enabledWindow = { windowId: 7, title: 'Example', enabledAt: 100 };
  state.aiCreatedTabs['42'] = { windowId: 7, enabledAt: 100 };
  const messages: Array<{ type: string; error?: string }> = [];
  const onMessage = createChromeEvent();
  (chromeObj.runtime.onConnect as FakeChromeEvent).dispatch({
    name: 'ui-sidepanel',
    onMessage,
    onDisconnect: createChromeEvent(),
    postMessage(message: { type: string; error?: string }) {
      messages.push(message);
    },
  });
  onMessage.dispatch({ type: 'scope.set_enabled', tabId: 41, enabled: false });
  for (
    let attempt = 0;
    attempt < 30 && !messages.some((message) => message.type === 'toggle.error');
    attempt++
  ) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const warning = messages.find((message) => message.type === 'toggle.error')?.error;
  assert.match(warning ?? '', /^Access is disabled, but some cleanup could not finish\./);
  assert.match(
    warning ?? '',
    /Could not stop console capture for tab 41: Unexpected script failure/
  );
  assert.equal(state.enabledWindow, null);
  assert.deepEqual(removed, [42]);
  assert(
    logged.mock.calls.some((call) =>
      String(call.arguments[0]).includes('Unexpected script failure')
    )
  );
});

test('AI tab closing continues after a failure and tolerates a tab closing concurrently', async () => {
  const removed: number[] = [];
  const state = createExtensionState();
  for (const id of [42, 43, 44]) state.aiCreatedTabs[String(id)] = { windowId: 7, enabledAt: 100 };
  const chromeObj = createChromeFake({
    tabs: {
      async get(id: number) {
        return { id, windowId: 7 } as chrome.tabs.Tab;
      },
      async remove(id: number) {
        removed.push(id);
        if (id === 42) throw new Error('No tab with id: 42.');
        if (id === 43) throw new Error('Unexpected tab removal failure');
      },
    },
  }) as unknown as typeof chrome;
  const controller = createAccessSettingsController(state, chromeObj);
  await assert.rejects(controller.closeWhenDone(7), (error: unknown) => {
    assert(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.match(
      getErrorMessageWithCauses(error),
      /Could not close BBX tab 43: Unexpected tab removal failure/
    );
    return true;
  });
  assert.deepEqual(removed, [42, 43, 44]);
});
