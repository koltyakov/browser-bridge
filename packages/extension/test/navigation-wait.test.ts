import test from 'node:test';
import assert from 'node:assert/strict';

import { NavigationWaitCoordinator } from '../src/navigation-wait.js';
import type { NormalizedWaitForLoadStateParams } from '../../protocol/src/types.js';

function tab(value: Partial<chrome.tabs.Tab>): chrome.tabs.Tab {
  return value as chrome.tabs.Tab;
}

function params(
  overrides: Partial<NormalizedWaitForLoadStateParams> = {}
): NormalizedWaitForLoadStateParams {
  return {
    waitForLoad: true,
    timeoutMs: 1_000,
    url: 'https://example.com/final',
    urlMatch: 'exact',
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(predicate(), true);
}

test('URL wait returns immediately when current state already matches', async () => {
  let reads = 0;
  const waits = new NavigationWaitCoordinator({
    async getTab() {
      reads += 1;
      return tab({ id: 7, windowId: 2, status: 'complete', url: 'https://example.com/final' });
    },
  });

  const result = await waits.wait(7, 2, params());

  assert.equal(reads, 1);
  assert.equal(result.observedNavigationKind, 'current');
  assert.equal(result.tab.url, 'https://example.com/final');
});

test('URL wait follows redirect updates and reports a full navigation truthfully', async () => {
  let currentTab = tab({
    id: 7,
    windowId: 2,
    status: 'complete',
    url: 'https://example.com/start',
  });
  const waits = new NavigationWaitCoordinator({ getTab: async () => tab({ ...currentTab }) });
  const pending = waits.wait(7, 2, params());
  await Promise.resolve();

  currentTab = tab({ ...currentTab, status: 'loading', url: 'https://example.com/redirect' });
  waits.handleTabUpdated(7, { status: 'loading', url: currentTab.url });
  await Promise.resolve();
  currentTab = tab({ ...currentTab, status: 'loading', url: 'https://example.com/final' });
  waits.handleTabUpdated(7, { url: currentTab.url });
  await Promise.resolve();
  currentTab = tab({ ...currentTab, status: 'complete' });
  waits.handleTabUpdated(7, { status: 'complete' });

  const result = await pending;
  assert.equal(result.observedNavigationKind, 'full-navigation');
  assert.equal(result.tab.url, 'https://example.com/final');
});

test('SPA signal survives tabs URL lag and labels the authoritative recheck', async () => {
  let currentTab = tab({
    id: 8,
    windowId: 2,
    status: 'complete',
    url: 'https://example.com/start',
  });
  const waits = new NavigationWaitCoordinator({ getTab: async () => tab({ ...currentTab }) });
  const pending = waits.wait(8, 2, params({ waitForLoad: false }));
  await waitFor(() => waits.signalsByTab.has(8));

  waits.handleSpaSignal(8, 'pushState');
  await Promise.resolve();
  currentTab = tab({ ...currentTab, url: 'https://example.com/final' });
  waits.handleTabUpdated(8, { url: currentTab.url });

  assert.equal((await pending).observedNavigationKind, 'pushState');
});

for (const kind of ['replaceState', 'popstate', 'hashchange'] as const) {
  test(`URL wait reports ${kind} SPA signals`, async () => {
    let url = 'https://example.com/start';
    const waits = new NavigationWaitCoordinator({
      getTab: async () => tab({ id: 9, windowId: 2, status: 'complete', url }),
    });
    const pending = waits.wait(9, 2, params({ waitForLoad: false }));
    await waitFor(() => waits.signalsByTab.has(9));
    url = 'https://example.com/final';
    waits.handleSpaSignal(9, kind);
    assert.equal((await pending).observedNavigationKind, kind);
  });
}

test('URL wait timeout includes elapsed time and final authoritative URL', async () => {
  const waits = new NavigationWaitCoordinator({
    getTab: async () =>
      tab({
        id: 10,
        windowId: 2,
        status: 'complete',
        url: 'https://example.com/still-here',
      }),
  });

  await assert.rejects(waits.wait(10, 2, params({ timeoutMs: 5 })), (error: unknown) => {
    const failure = error as { code?: string; details?: Record<string, unknown> };
    assert.equal(failure.code, 'TIMEOUT');
    assert.equal(failure.details?.finalUrl, 'https://example.com/still-here');
    assert.equal(typeof failure.details?.elapsedMs, 'number');
    return true;
  });
  assert.equal(waits.waitersByTab.size, 0);
});

test('URL wait registers before its first read so immediate access cancellation cannot leak', async () => {
  let resolveTab: (value: chrome.tabs.Tab) => void = () => {};
  const tabRead = new Promise<chrome.tabs.Tab>((resolve) => {
    resolveTab = resolve;
  });
  const waits = new NavigationWaitCoordinator({ getTab: async () => tabRead });

  const pending = waits.wait(20, 2, params());
  assert.equal(waits.waitersByTab.get(20)?.size, 1);
  waits.cancelWindow(2);
  await assert.rejects(pending, { code: 'ACCESS_DENIED' });

  resolveTab(tab({ id: 20, windowId: 2, status: 'complete', url: 'https://example.com/final' }));
  await Promise.resolve();
  assert.equal(waits.waitersByTab.size, 0);
});

test('URL wait rejects tabs moved before or during authoritative rechecks', async () => {
  const initiallyMoved = new NavigationWaitCoordinator({
    getTab: async () =>
      tab({ id: 21, windowId: 3, status: 'complete', url: 'https://example.com/final' }),
  });
  await assert.rejects(initiallyMoved.wait(21, 2, params()), { code: 'ACCESS_DENIED' });

  let current = tab({
    id: 22,
    windowId: 2,
    status: 'complete',
    url: 'https://example.com/start',
  });
  const movedDuringWait = new NavigationWaitCoordinator({
    getTab: async () => tab({ ...current }),
  });
  const pending = movedDuringWait.wait(22, 2, params());
  await waitFor(() => movedDuringWait.signalsByTab.has(22));
  current = tab({ ...current, windowId: 3, url: 'https://example.com/final' });
  movedDuringWait.handleTabUpdated(22, { url: current.url }, current);
  await assert.rejects(pending, { code: 'ACCESS_DENIED' });
});

test('URL wait revalidates access immediately before resolving', async () => {
  let access = true;
  let reads = 0;
  const waits = new NavigationWaitCoordinator({
    hasWindowAccess: () => access,
    getTab: async () => {
      reads += 1;
      if (reads > 1) access = false;
      return tab({
        id: 23,
        windowId: 2,
        status: 'complete',
        url: reads > 1 ? 'https://example.com/final' : 'https://example.com/start',
      });
    },
  });
  await assert.rejects(waits.wait(23, 2, params()), { code: 'ACCESS_DENIED' });
});

test('URL wait installs signals only while pending, refreshes after navigation, and uninstalls', async () => {
  let current = tab({
    id: 24,
    windowId: 2,
    status: 'complete',
    url: 'https://example.com/start',
  });
  const installs: string[] = [];
  const uninstalls: string[] = [];
  const waits = new NavigationWaitCoordinator({
    getTab: async () => tab({ ...current }),
    createSignalChannel: () => 'random-channel',
    installSignals: async (_tabId, channel) => {
      installs.push(channel);
    },
    uninstallSignals: async (_tabId, channel) => {
      uninstalls.push(channel);
    },
  });

  const immediate = await waits.wait(24, 2, params({ url: current.url, waitForLoad: false }));
  assert.equal(immediate.observedNavigationKind, 'current');
  assert.deepEqual(installs, []);

  const pending = waits.wait(24, 2, params({ waitForLoad: false }));
  await waitFor(() => installs.length === 1);
  waits.handleSpaSignal(24, 'pushState', 'wrong-channel');
  current = tab({ ...current, status: 'loading', url: 'https://example.com/intermediate' });
  waits.handleTabUpdated(24, { status: 'loading', url: current.url }, current);
  current = tab({ ...current, status: 'complete' });
  waits.handleTabUpdated(24, { status: 'complete' }, current);
  await waitFor(() => installs.length === 2);
  current = tab({ ...current, url: 'https://example.com/final' });
  waits.handleSpaSignal(24, 'replaceState', 'random-channel');

  assert.equal((await pending).observedNavigationKind, 'replaceState');
  await waitFor(() => uninstalls.length === 1);
  assert.deepEqual(uninstalls, ['random-channel']);
  assert.equal(waits.signalsByTab.size, 0);
});

test('URL waits clean up on tab close and access/window changes', async () => {
  const waits = new NavigationWaitCoordinator({
    getTab: async (tabId) =>
      tab({
        id: tabId,
        windowId: 2,
        status: 'complete',
        url: 'https://example.com/start',
      }),
  });
  const closed = waits.wait(11, 2, params());
  const disabled = waits.wait(12, 2, params());
  await Promise.resolve();

  waits.handleTabRemoved(11);
  waits.cancelWindow(2);

  await assert.rejects(closed, { code: 'TAB_MISMATCH' });
  await assert.rejects(disabled, { code: 'ACCESS_DENIED' });
  assert.equal(waits.waitersByTab.size, 0);
});
