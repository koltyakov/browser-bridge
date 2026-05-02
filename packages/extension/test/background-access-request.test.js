// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { createChromeEvent, createChromeFake } from '../../../tests/_helpers/chromeFake.js';
import { loadBackground } from '../../../tests/_helpers/loadBackground.js';
import { createMessagePortPair } from '../../../tests/_helpers/messagePort.js';
import { createRequest, ERROR_CODES } from '../../protocol/src/index.js';

/**
 * @param {unknown[]} messages
 * @returns {any}
 */
function createNativePort(messages) {
  return {
    /** @param {unknown} message */
    postMessage(message) {
      messages.push(message);
    },
    disconnect() {},
    onMessage: createChromeEvent(),
    onDisconnect: createChromeEvent(),
    name: 'native',
  };
}

/**
 * @param {number} [count]
 * @returns {Promise<void>}
 */
async function flushAsyncWork(count = 6) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

test('background access request opens a popup window when no side panel is open', async () => {
  /** @type {Array<chrome.windows.CreateData>} */
  const popupCreates = [];
  /** @type {Array<chrome.windows.UpdateInfo & { windowId: number }> } */
  const popupUpdates = [];
  const chrome = createChromeFake({
    runtime: {
      /** @param {string} path */
      getURL(path) {
        return `chrome-extension://test-extension-id/${path}`;
      },
    },
    tabs: {
      /** @param {chrome.tabs.QueryInfo} [queryInfo] */
      async query(queryInfo = {}) {
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [
            {
              id: 27,
              windowId: 8,
              title: 'Access target',
              url: 'https://example.com/access',
              status: 'complete',
            },
          ];
        }
        return [];
      },
    },
    windows: {
      /** @param {number} windowId */
      async get(windowId) {
        assert.equal(windowId, 8);
        return {
          id: 8,
          left: 100,
          top: 40,
          width: 1200,
        };
      },
      /** @param {chrome.windows.CreateData} [createData] */
      async create(createData = {}) {
        popupCreates.push(createData);
        return { id: 91, ...createData };
      },
      /** @param {number} windowId @param {chrome.windows.UpdateInfo} [updateInfo] */
      async update(windowId, updateInfo = {}) {
        popupUpdates.push({ windowId, ...updateInfo });
        return { id: windowId, ...updateInfo };
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-access-request-popup-${Date.now()}`,
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'background-access-request-popup',
      method: 'access.request',
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.equal(response.meta?.method, 'access.request');
  assert.deepEqual(response.result, {
    enabled: false,
    requested: true,
    windowId: 8,
    tabId: 27,
    title: 'Access target',
    url: 'https://example.com/access',
  });

  const state = loaded.module.getStateForTest();
  assert.equal(state.requestedAccessWindowId, 8);
  assert.equal(state.requestedAccessPopupWindowId, 91);
  assert.equal(popupUpdates.length, 0);
  assert.deepEqual(popupCreates, [
    {
      url: 'chrome-extension://test-extension-id/packages/extension/ui/popup.html?tabId=27&windowed=1',
      type: 'popup',
      focused: true,
      width: 420,
      height: 320,
      left: 840,
      top: 112,
    },
  ]);
});

test('background access request reuses an open side panel instead of opening a popup', async () => {
  /** @type {unknown[]} */
  const nativeMessages = [];
  /** @type {chrome.windows.CreateData[]} */
  const popupCreates = [];
  const portPair = createMessagePortPair({ leftName: 'ui-sidepanel', rightName: 'agent' });
  const chrome = createChromeFake({
    runtime: {
      connectNative() {
        return createNativePort(nativeMessages);
      },
    },
    tabs: {
      /** @param {chrome.tabs.QueryInfo} [queryInfo] */
      async query(queryInfo = {}) {
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [
            {
              id: 31,
              windowId: 8,
              title: 'Focused tab',
              url: 'https://example.com/focused',
              status: 'complete',
            },
          ];
        }
        return [];
      },
      /** @param {number} tabId */
      async get(tabId) {
        assert.equal(tabId, 31);
        return {
          id: 31,
          windowId: 8,
          title: 'Focused tab',
          url: 'https://example.com/focused',
          status: 'complete',
        };
      },
    },
    windows: {
      /** @param {chrome.windows.CreateData} [createData] */
      async create(createData = {}) {
        popupCreates.push(createData);
        return { id: 92, ...createData };
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-access-request-sidepanel-${Date.now()}`,
  });

  loaded.chrome.runtime.onConnect.dispatch(portPair.left.port);
  await flushAsyncWork();
  portPair.left.dispatchMessage({ type: 'state.request', scopeTabId: 31 });
  await flushAsyncWork();

  const response = await loaded.dispatch(
    createRequest({
      id: 'background-access-request-sidepanel',
      method: 'access.request',
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.deepEqual(response.result, {
    enabled: false,
    requested: true,
    windowId: 8,
    tabId: 31,
    title: 'Focused tab',
    url: 'https://example.com/focused',
  });

  const state = loaded.module.getStateForTest();
  assert.equal(state.requestedAccessWindowId, 8);
  assert.equal(state.requestedAccessPopupWindowId, null);
  assert.deepEqual(popupCreates, []);
  assert.equal(
    nativeMessages.some(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'host.access_update'
    ),
    false
  );
});

test('background access request rejects duplicate requests for the same pending window', async () => {
  /** @type {chrome.windows.CreateData[]} */
  const popupCreates = [];
  const chrome = createChromeFake({
    runtime: {
      /** @param {string} path */
      getURL(path) {
        return `chrome-extension://test-extension-id/${path}`;
      },
    },
    tabs: {
      /** @param {chrome.tabs.QueryInfo} [queryInfo] */
      async query(queryInfo = {}) {
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [
            {
              id: 41,
              windowId: 9,
              title: 'Pending tab',
              url: 'https://example.com/pending',
            },
          ];
        }
        return [];
      },
    },
    windows: {
      /** @param {number} windowId */
      async get(windowId) {
        assert.equal(windowId, 9);
        return { id: 9, left: 60, top: 30, width: 900 };
      },
      /** @param {chrome.windows.CreateData} [createData] */
      async create(createData = {}) {
        popupCreates.push(createData);
        return { id: 93, ...createData };
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-access-request-duplicate-${Date.now()}`,
  });

  const firstResponse = await loaded.dispatch(
    createRequest({
      id: 'background-access-request-first',
      method: 'access.request',
    })
  );

  if (!firstResponse.ok) {
    assert.fail(firstResponse.error.message);
  }
  assert.equal(popupCreates.length, 1);

  const duplicateResponse = await loaded.dispatch(
    createRequest({
      id: 'background-access-request-duplicate',
      method: 'access.request',
    })
  );

  assert.equal(duplicateResponse.ok, false);
  if (duplicateResponse.ok) {
    assert.fail('Expected duplicate access request to fail.');
  }
  assert.equal(duplicateResponse.error.code, ERROR_CODES.ACCESS_DENIED);
  assert.match(duplicateResponse.error.message, /already pending for this window/i);
  assert.deepEqual(duplicateResponse.error.details, {
    requestedWindowId: 9,
    requestedTargetWindowId: 9,
    requestedTargetTabId: 41,
  });
  assert.equal(duplicateResponse.meta?.method, 'access.request');
  assert.equal(popupCreates.length, 1);

  const state = loaded.module.getStateForTest();
  assert.equal(state.requestedAccessWindowId, 9);
  assert.equal(state.requestedAccessPopupWindowId, 93);
});

test('background access request clears popup state when the access popup window is dismissed', async () => {
  const chrome = createChromeFake({
    runtime: {
      /** @param {string} path */
      getURL(path) {
        return `chrome-extension://test-extension-id/${path}`;
      },
    },
    tabs: {
      /** @param {chrome.tabs.QueryInfo} [queryInfo] */
      async query(queryInfo = {}) {
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [
            {
              id: 52,
              windowId: 12,
              title: 'Dismissible popup target',
              url: 'https://example.com/dismiss',
              status: 'complete',
            },
          ];
        }
        return [];
      },
    },
    windows: {
      /** @param {number} windowId */
      async get(windowId) {
        assert.equal(windowId, 12);
        return {
          id: 12,
          left: 80,
          top: 20,
          width: 1000,
        };
      },
      /** @param {chrome.windows.CreateData} [createData] */
      async create(createData = {}) {
        return { id: 94, ...createData };
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-access-request-dismiss-${Date.now()}`,
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'background-access-request-dismiss',
      method: 'access.request',
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }

  const state = loaded.module.getStateForTest();
  assert.equal(state.requestedAccessWindowId, 12);
  assert.equal(state.requestedAccessPopupWindowId, 94);

  loaded.chrome.windows.onRemoved.dispatch(999);
  assert.equal(state.requestedAccessPopupWindowId, 94);

  loaded.chrome.windows.onRemoved.dispatch(94);
  assert.equal(state.requestedAccessPopupWindowId, null);
  assert.equal(state.requestedAccessWindowId, 12);
});
