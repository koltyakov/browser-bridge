import test from 'node:test';
import assert from 'node:assert/strict';
import { createChromeFake } from '../../../tests/_helpers/chromeFake.ts';
import { createExtensionState } from '../src/background-state.js';
import {
  updateActionIndicatorForTab,
  syncGlobalBadgeToActiveTab,
} from '../src/background-badge.js';
import { getErrorMessage, normalizeRuntimeErrorMessage } from '../src/background-helpers.js';
import { isRestrictedAutomationUrl } from '../src/background-routing.js';

test('working AI-created tabs have a gray toolbar badge while working user tabs stay blue', async () => {
  const state = createExtensionState();
  state.enabledWindow = { windowId: 7, title: 'Example', enabledAt: 100 };
  state.workingTabIds = new Set([41, 42]);
  state.aiCreatedTabs['42'] = { windowId: 7, enabledAt: 100 };
  const backgrounds: Array<Parameters<typeof chrome.action.setBadgeBackgroundColor>[0]> = [];
  const texts: Array<Parameters<typeof chrome.action.setBadgeText>[0]> = [];
  let activeTabId = 42;
  let restricted = false;
  const tab = (id: number) =>
    ({
      id,
      windowId: 7,
      url: restricted ? 'chrome://settings' : 'https://example.com/',
    }) as chrome.tabs.Tab;
  const chromeObj = createChromeFake({
    tabs: {
      async get(id: number) {
        return tab(id);
      },
      async query() {
        return [tab(activeTabId)];
      },
    },
    action: {
      async setBadgeBackgroundColor(
        details: Parameters<typeof chrome.action.setBadgeBackgroundColor>[0]
      ) {
        backgrounds.push(details);
      },
      async setBadgeText(details: Parameters<typeof chrome.action.setBadgeText>[0]) {
        texts.push(details);
      },
    },
  }) as unknown as typeof chrome;
  const deps = { getErrorMessage, normalizeRuntimeErrorMessage, isRestrictedAutomationUrl };
  await updateActionIndicatorForTab(41, state, chromeObj, deps);
  await updateActionIndicatorForTab(42, state, chromeObj, deps);
  assert.deepEqual(backgrounds, [
    { tabId: 41, color: '#1a73e8' },
    { tabId: 42, color: '#787878' },
  ]);
  assert.deepEqual(texts, [
    { tabId: 41, text: 'BBX' },
    { tabId: 42, text: 'BBX' },
  ]);
  await syncGlobalBadgeToActiveTab(state, chromeObj, deps);
  assert.deepEqual(backgrounds.at(-1), { color: '#787878' });
  activeTabId = 41;
  await syncGlobalBadgeToActiveTab(state, chromeObj, deps);
  assert.deepEqual(backgrounds.at(-1), { color: '#1a73e8' });
  restricted = true;
  await updateActionIndicatorForTab(42, state, chromeObj, deps);
  assert.deepEqual(backgrounds.at(-1), { tabId: 42, color: '#e07020' });
  assert.deepEqual(
    texts.at(-1),
    { tabId: 42, text: '!' },
    'restricted-page warnings still take priority'
  );
  state.enabledWindow = null;
  await updateActionIndicatorForTab(42, state, chromeObj, deps);
  assert.deepEqual(
    texts.at(-1),
    { tabId: 42, text: '' },
    'AI ownership does not show enabled access after revocation'
  );
});
