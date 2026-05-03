// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  connectSidepanelPort,
  createSidepanelMessageHandler,
  readRequestedTabId,
  renderSidepanelState,
} from '../src/sidepanel-runtime.js';
import { createMessagePortPair } from '../../../tests/_helpers/messagePort.js';

test('sidepanel runtime reads a valid requested tab id from search params', () => {
  assert.equal(readRequestedTabId('?tabId=17'), 17);
  assert.equal(readRequestedTabId('?tabId=0'), null);
  assert.equal(readRequestedTabId('?tabId=abc'), null);
});

test('sidepanel runtime connects the port, posts a state request, and schedules reconnects', () => {
  /** @type {chrome.runtime.ConnectInfo[]} */
  const connectCalls = [];
  /** @type {Array<{ callback: () => void, delayMs: number }>} */
  const reconnects = [];
  let reconnectCount = 0;
  const portPair = createMessagePortPair();
  const onMessage = () => {};

  const connection = connectSidepanelPort({
    connect: (connectInfo) => {
      connectCalls.push(connectInfo);
      return /** @type {any} */ (portPair.left.port);
    },
    onMessage,
    scheduleReconnect: (callback, delayMs) => {
      reconnects.push({ callback, delayMs });
    },
    onReconnect: () => {
      reconnectCount += 1;
    },
  });

  assert.equal(connection, portPair.left.port);
  assert.deepEqual(connectCalls, [{ name: 'ui-sidepanel' }]);
  assert.deepEqual(portPair.left.postedMessages, [{ type: 'state.request' }]);
  assert.deepEqual(portPair.left.onMessageListeners, [onMessage]);
  assert.equal(portPair.left.onDisconnectListeners.length, 1);

  portPair.left.dispatchDisconnect();

  assert.equal(reconnects.length, 1);
  assert.equal(reconnects[0].delayMs, 500);
  assert.equal(typeof reconnects[0].callback, 'function');

  reconnects[0].callback();
  assert.equal(reconnectCount, 1);
});

test('sidepanel runtime message handler routes native status, sync, and toggle errors', () => {
  /** @type {Array<[string, ...unknown[]]>} */
  const calls = [];
  const state = {
    nativeConnected: true,
    currentTab: null,
    setupStatus: null,
    setupStatusPending: false,
    setupStatusError: null,
    setupInstallPendingKey: null,
    setupInstallError: null,
    actionLog: [],
  };

  const handler = createSidepanelMessageHandler({
    renderNativeStatus: (connected, error) => calls.push(['native', connected, error ?? null]),
    renderState: (nextState) => calls.push(['state', nextState]),
    renderToggleError: (errorMessage) => calls.push(['error', errorMessage]),
  });

  handler({ type: 'native.status', connected: false, error: 'bridge down' });
  handler({ type: 'state.sync', state });
  handler({ type: 'toggle.error', error: 'No access' });

  assert.deepEqual(calls, [
    ['native', false, 'bridge down'],
    ['state', state],
    ['error', 'No access'],
  ]);
});

test('sidepanel runtime orchestrates full state rendering and collapses examples when activity exists', () => {
  /** @type {Array<[string, ...unknown[]]>} */
  const calls = [];
  /** @type {import('../src/sidepanel-runtime.js').ActionLogEntry} */
  const entry = {
    id: 'entry-1',
    at: 1,
    method: 'tabs.list',
    source: 'cli',
    tabId: 4,
    url: 'https://example.com/',
    ok: true,
    summary: 'Listed tabs',
    responseBytes: 10,
    approxTokens: 2,
    imageApproxTokens: 0,
    costClass: 'cheap',
    imageBytes: 0,
    summaryBytes: 10,
    summaryTokens: 2,
    summaryCostClass: 'cheap',
    debuggerBacked: false,
    overBudget: false,
    hasScreenshot: false,
    nodeCount: null,
    continuationHint: null,
  };
  /** @type {Parameters<typeof renderSidepanelState>[0]} */
  const state = {
    nativeConnected: true,
    currentTab: {
      tabId: 4,
      windowId: 2,
      title: 'Example',
      url: 'https://example.com/',
      enabled: true,
      accessRequested: false,
      restricted: false,
    },
    setupStatus: null,
    setupStatusPending: false,
    setupStatusError: null,
    setupInstallPendingKey: null,
    setupInstallError: null,
    actionLog: [entry],
  };

  renderSidepanelState(state, {
    hideSetupContextMenu: () => calls.push(['hide-context']),
    renderNativeStatus: (connected) => calls.push(['native', connected]),
    renderCurrentTab: (currentTab) => calls.push(['current-tab', currentTab?.tabId ?? null]),
    renderAgentStatus: (snapshot) => calls.push(['agent', snapshot.currentTab?.enabled ?? null]),
    renderPromptExamples: (setupStatus) => calls.push(['prompts', setupStatus]),
    renderSetupStatus: (setupStatus, pending, error, installPendingKey, installError) =>
      calls.push(['setup', setupStatus, pending, error, installPendingKey, installError]),
    renderActionLogEntry: (nextEntry, setupStatus, entries, index) => {
      calls.push(['entry', nextEntry.id, setupStatus, entries.length, index]);
      return /** @type {any} */ ({ id: nextEntry.id });
    },
    replaceActionLogChildren: (children) => calls.push(['replace-log', children.length]),
    setCurrentActionLog: (entries) => calls.push(['set-log', entries.length]),
    updateActivityVisualizations: () => calls.push(['update-activity']),
    showEmptyActionLog: () => calls.push(['show-empty']),
    collapseExamples: () => calls.push(['collapse-examples']),
    syncConnectedSectionsVisibility: () => calls.push(['sync-sections']),
    syncSetupStatusPolling: () => calls.push(['sync-polling']),
  });

  assert.deepEqual(calls, [
    ['hide-context'],
    ['native', true],
    ['current-tab', 4],
    ['agent', true],
    ['prompts', null],
    ['setup', null, false, null, null, null],
    ['entry', 'entry-1', null, 1, 0],
    ['replace-log', 1],
    ['set-log', 1],
    ['update-activity'],
    ['collapse-examples'],
    ['sync-sections'],
    ['sync-polling'],
  ]);
});

test('sidepanel runtime shows the empty state when there is no activity', () => {
  /** @type {Array<[string, ...unknown[]]>} */
  const calls = [];
  /** @type {Parameters<typeof renderSidepanelState>[0]} */
  const state = {
    nativeConnected: false,
    currentTab: null,
    setupStatus: null,
    setupStatusPending: false,
    setupStatusError: null,
    setupInstallPendingKey: null,
    setupInstallError: null,
    actionLog: [],
  };

  renderSidepanelState(state, {
    hideSetupContextMenu: () => {},
    renderNativeStatus: () => {},
    renderCurrentTab: () => {},
    renderAgentStatus: () => {},
    renderPromptExamples: () => {},
    renderSetupStatus: () => {},
    renderActionLogEntry: () => {
      throw new Error('renderActionLogEntry should not run for an empty action log');
    },
    replaceActionLogChildren: (children) => calls.push(['replace-log', children.length]),
    setCurrentActionLog: (entries) => calls.push(['set-log', entries.length]),
    updateActivityVisualizations: () => calls.push(['update-activity']),
    showEmptyActionLog: () => calls.push(['show-empty']),
    collapseExamples: () => calls.push(['collapse-examples']),
    syncConnectedSectionsVisibility: () => calls.push(['sync-sections']),
    syncSetupStatusPolling: () => calls.push(['sync-polling']),
  });

  assert.deepEqual(calls, [
    ['replace-log', 0],
    ['set-log', 0],
    ['update-activity'],
    ['show-empty'],
    ['sync-sections'],
    ['sync-polling'],
  ]);
});
