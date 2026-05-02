// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getAccessStatus,
  normalizeStoredEnabledWindow,
  restoreEnabledWindowState,
} from '../src/background-access.js';

test('restoreEnabledWindow rehydrates state from chrome.storage', async () => {
  const state = {
    enabledWindow: null,
  };
  /** @type {boolean[]} */
  const accessUpdates = [];

  await restoreEnabledWindowState({
    chrome: {
      storage: {
        session: {
          async get(key) {
            assert.equal(key, 'enabledWindow');
            return {
              enabledWindow: {
                windowId: '7',
                title: 'Workspace',
                enabledAt: 123,
              },
            };
          },
        },
      },
    },
    state,
    storageKey: 'enabledWindow',
    sendAccessUpdate(enabled) {
      accessUpdates.push(enabled);
    },
  });

  assert.deepEqual(state.enabledWindow, {
    windowId: 7,
    title: 'Workspace',
    enabledAt: 123,
  });
  assert.deepEqual(accessUpdates, [true]);
});

test('restoreEnabledWindow clears invalid stored state without sending an access update', async () => {
  const state = {
    enabledWindow: {
      windowId: 4,
      title: 'Old',
      enabledAt: 99,
    },
  };
  /** @type {boolean[]} */
  const accessUpdates = [];

  await restoreEnabledWindowState({
    chrome: {
      storage: {
        session: {
          async get() {
            return {
              enabledWindow: {
                windowId: 'not-a-number',
              },
            };
          },
        },
      },
    },
    state,
    storageKey: 'enabledWindow',
    sendAccessUpdate(enabled) {
      accessUpdates.push(enabled);
    },
  });

  assert.equal(state.enabledWindow, null);
  assert.deepEqual(accessUpdates, []);
});

test('normalizeStoredEnabledWindow fills defaults for optional fields', () => {
  assert.deepEqual(
    normalizeStoredEnabledWindow({ windowId: 9 }, () => 456),
    {
      windowId: 9,
      title: '',
      enabledAt: 456,
    }
  );
});

test('getAccessStatus reports access_disabled when no window is enabled', async () => {
  const status = await getAccessStatus({
    chrome: /** @type {any} */ ({
      windows: {
        async get() {
          throw new Error('should not be called');
        },
      },
      tabs: {
        async query() {
          throw new Error('should not be called');
        },
      },
    }),
    state: { enabledWindow: null },
    async clearEnabledWindowIfGone() {
      return false;
    },
    isRestrictedAutomationUrl() {
      return false;
    },
  });

  assert.deepEqual(status, {
    enabled: false,
    windowId: null,
    routeTabId: null,
    routeReady: false,
    routeUrl: '',
    reason: 'access_disabled',
  });
});

test('getAccessStatus reports enabled_window_missing when the enabled window is gone', async () => {
  let clearedCalls = 0;
  const status = await getAccessStatus({
    chrome: /** @type {any} */ ({
      windows: {
        async get() {
          throw new Error('window missing');
        },
      },
      tabs: {
        async query() {
          throw new Error('should not query tabs after clearing');
        },
      },
    }),
    state: {
      enabledWindow: {
        windowId: 7,
        title: 'Workspace',
        enabledAt: 1,
      },
    },
    async clearEnabledWindowIfGone() {
      clearedCalls += 1;
      return true;
    },
    isRestrictedAutomationUrl() {
      return false;
    },
  });

  assert.equal(clearedCalls, 1);
  assert.deepEqual(status, {
    enabled: false,
    windowId: null,
    routeTabId: null,
    routeReady: false,
    routeUrl: '',
    reason: 'enabled_window_missing',
  });
});

test('getAccessStatus reports no_routable_active_tab when the active tab lacks a routable target', async () => {
  /** @type {Array<{ active: boolean, windowId: number }>} */
  const queries = [];
  const status = await getAccessStatus({
    chrome: /** @type {any} */ ({
      windows: {
        /** @param {number} windowId */
        async get(windowId) {
          assert.equal(windowId, 7);
        },
      },
      tabs: {
        /** @param {{ active: boolean, windowId: number }} query */
        async query(query) {
          queries.push(query);
          return [{ url: 'https://example.com' }];
        },
      },
    }),
    state: {
      enabledWindow: {
        windowId: 7,
        title: 'Workspace',
        enabledAt: 1,
      },
    },
    async clearEnabledWindowIfGone() {
      return false;
    },
    isRestrictedAutomationUrl() {
      return false;
    },
  });

  assert.deepEqual(queries, [{ active: true, windowId: 7 }]);
  assert.deepEqual(status, {
    enabled: true,
    windowId: 7,
    routeTabId: null,
    routeReady: false,
    routeUrl: '',
    reason: 'no_routable_active_tab',
  });
});

test('getAccessStatus reports restricted_page when the active tab cannot be automated', async () => {
  const status = await getAccessStatus({
    chrome: /** @type {any} */ ({
      windows: {
        async get() {},
      },
      tabs: {
        async query() {
          return [{ id: 9, url: 'chrome://extensions' }];
        },
      },
    }),
    state: {
      enabledWindow: {
        windowId: 7,
        title: 'Workspace',
        enabledAt: 1,
      },
    },
    async clearEnabledWindowIfGone() {
      return false;
    },
    isRestrictedAutomationUrl(url) {
      return url.startsWith('chrome://');
    },
  });

  assert.deepEqual(status, {
    enabled: true,
    windowId: 7,
    routeTabId: 9,
    routeReady: false,
    routeUrl: 'chrome://extensions',
    reason: 'restricted_page',
  });
});

test('getAccessStatus reports enabled when the active tab is routable', async () => {
  let clearedCalls = 0;
  const status = await getAccessStatus({
    chrome: /** @type {any} */ ({
      windows: {
        async get() {
          throw new Error('transient window lookup failure');
        },
      },
      tabs: {
        async query() {
          return [{ id: 12, url: 'https://example.com' }];
        },
      },
    }),
    state: {
      enabledWindow: {
        windowId: 7,
        title: 'Workspace',
        enabledAt: 1,
      },
    },
    async clearEnabledWindowIfGone() {
      clearedCalls += 1;
      return false;
    },
    isRestrictedAutomationUrl() {
      return false;
    },
  });

  assert.equal(clearedCalls, 1);
  assert.deepEqual(status, {
    enabled: true,
    windowId: 7,
    routeTabId: 12,
    routeReady: true,
    routeUrl: 'https://example.com',
    reason: 'enabled',
  });
});
