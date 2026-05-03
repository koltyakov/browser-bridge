// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  connectPopupPort,
  createPopupMessageHandler,
  isWindowedPopup,
  readScopedTabId,
  resolveInitialScopeTabId,
} from '../src/popup-runtime.js';
import { shouldResetPendingToggleOnSync } from '../src/popup-helpers.js';
import { createMessagePortPair } from '../../../tests/_helpers/messagePort.js';

test('popup runtime reads scoped tab ids and windowed state from popup search params', () => {
  assert.equal(readScopedTabId('?tabId=17'), 17);
  assert.equal(readScopedTabId('?tabId=0'), null);
  assert.equal(readScopedTabId('?tabId=abc'), null);

  assert.equal(isWindowedPopup('?windowed=1'), true);
  assert.equal(isWindowedPopup('?windowed=0'), false);
});

test('popup runtime resolves the initial scope tab from the explicit query before querying tabs', async () => {
  let queried = false;

  const scopeTabId = await resolveInitialScopeTabId({
    search: '?tabId=42',
    queryTabs: async () => {
      queried = true;
      return [];
    },
  });

  assert.equal(scopeTabId, 42);
  assert.equal(queried, false);
});

test('popup runtime falls back to the active tab and swallows tab query failures', async () => {
  /** @type {chrome.tabs.QueryInfo[]} */
  const queries = [];

  const activeScope = await resolveInitialScopeTabId({
    search: '',
    queryTabs: async (queryInfo) => {
      queries.push(queryInfo);
      return [/** @type {chrome.tabs.Tab} */ ({ id: 9 })];
    },
  });

  assert.equal(activeScope, 9);
  assert.deepEqual(queries, [{ active: true, currentWindow: true }]);

  const failedScope = await resolveInitialScopeTabId({
    search: '',
    queryTabs: async () => {
      throw new Error('tabs unavailable');
    },
  });

  assert.equal(failedScope, null);
});

test('popup runtime connects the popup port and posts a scoped state request', async () => {
  /** @type {chrome.runtime.ConnectInfo[]} */
  const connectCalls = [];
  const portPair = createMessagePortPair();
  const onMessage = () => {};

  const connection = await connectPopupPort({
    search: '?tabId=23',
    queryTabs: async () => {
      throw new Error('query should not run when tabId is explicit');
    },
    connect: (connectInfo) => {
      connectCalls.push(connectInfo);
      return /** @type {any} */ (portPair.left.port);
    },
    onMessage,
  });

  assert.equal(connection.popupScopeTabId, 23);
  assert.equal(connection.port, portPair.left.port);
  assert.deepEqual(connectCalls, [{ name: 'ui-popup' }]);
  assert.deepEqual(portPair.left.postedMessages, [{ type: 'state.request', scopeTabId: 23 }]);
  assert.deepEqual(portPair.left.onMessageListeners, [onMessage]);
});

test('popup runtime message handler closes a windowed popup only after a matching sync completes', () => {
  /** @type {Array<[string, ...(boolean | string | null)[]]>} */
  const calls = [];
  let pendingEnabledState = true;

  const handler = createPopupMessageHandler({
    renderNativeStatus: (connected) => calls.push(['native', connected]),
    renderPopupState: (currentTab) => calls.push(['state', currentTab?.enabled ?? null]),
    shouldResetPendingToggleOnSync,
    getPendingEnabledState: () => pendingEnabledState,
    resetPendingToggle: () => calls.push(['reset']),
    renderToggleError: (errorMessage) => calls.push(['error', errorMessage]),
    windowedPopup: true,
    closeWindow: () => calls.push(['close']),
  });

  handler({
    type: 'state.sync',
    state: {
      nativeConnected: true,
      currentTab: {
        tabId: 3,
        windowId: 1,
        title: 'Example',
        url: 'https://example.com',
        enabled: true,
        accessRequested: false,
        restricted: false,
      },
    },
  });

  pendingEnabledState = false;
  handler({ type: 'toggle.error', error: 'No access' });

  assert.deepEqual(calls, [
    ['native', true],
    ['state', true],
    ['reset'],
    ['close'],
    ['error', 'No access'],
  ]);
});

test('popup runtime message handler leaves non-windowed popups open when no pending state completes', () => {
  let closed = false;
  /** @type {Array<[string, ...(boolean | string | null)[]]>} */
  const calls = [];

  const handler = createPopupMessageHandler({
    renderNativeStatus: (connected) => calls.push(['native', connected]),
    renderPopupState: (currentTab) => calls.push(['state', currentTab?.enabled ?? null]),
    shouldResetPendingToggleOnSync,
    getPendingEnabledState: () => null,
    resetPendingToggle: () => calls.push(['reset']),
    renderToggleError: (errorMessage) => calls.push(['error', errorMessage]),
    windowedPopup: false,
    closeWindow: () => {
      closed = true;
    },
  });

  handler({
    type: 'state.sync',
    state: {
      nativeConnected: false,
      currentTab: null,
    },
  });

  assert.deepEqual(calls, [
    ['native', false],
    ['state', null],
  ]);
  assert.equal(closed, false);
});
