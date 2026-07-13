import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createChromeEvent,
  createChromeFake,
  type FakeChromeEvent,
} from '../../../tests/_helpers/chromeFake.ts';
import { loadBackground } from '../../../tests/_helpers/loadBackground.ts';
import { createMessagePortPair } from '../../../tests/_helpers/messagePort.ts';
import { createRequest, ERROR_CODES } from '../../protocol/src/index.js';

type AccessRequestState = {
  requestedAccessWindowId: number | null;
  requestedAccessPopupWindowId: number | null;
};

type AccessRequestChrome = {
  runtime: {
    onConnect: FakeChromeEvent;
  };
  windows: {
    onRemoved: FakeChromeEvent;
  };
};

function getAccessRequestState(module: { getStateForTest: () => unknown }): AccessRequestState {
  return module.getStateForTest() as AccessRequestState;
}

function getAccessRequestChrome(chrome: unknown): AccessRequestChrome {
  return chrome as AccessRequestChrome;
}

function createNativePort(messages: unknown[]): unknown {
  return {
    postMessage(message: unknown) {
      messages.push(message);
    },
    disconnect() {},
    onMessage: createChromeEvent(),
    onDisconnect: createChromeEvent(),
    name: 'native',
  };
}

async function flushAsyncWork(count = 6): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

test('background access request opens a popup window when no side panel is open', async () => {
  const popupCreates: chrome.windows.CreateData[] = [];
  const popupUpdates: Array<chrome.windows.UpdateInfo & { windowId: number }> = [];
  const chrome = createChromeFake({
    runtime: {
      getURL(path: string) {
        return `chrome-extension://test-extension-id/${path}`;
      },
    },
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
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
      async get(windowId: number) {
        assert.equal(windowId, 8);
        return {
          id: 8,
          left: 100,
          top: 40,
          width: 1200,
        };
      },
      async create(createData: chrome.windows.CreateData = {}) {
        popupCreates.push(createData);
        return { id: 91, ...createData };
      },
      async update(windowId: number, updateInfo: chrome.windows.UpdateInfo = {}) {
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

  const state = getAccessRequestState(loaded.module);
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

test('background access request requires manual enablement when the browser is not focused', async () => {
  const popupCreates: chrome.windows.CreateData[] = [];
  const chrome = createChromeFake({
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [
            {
              id: 28,
              windowId: 8,
              title: 'Background target',
              url: 'https://example.com/background',
              status: 'complete',
            },
          ];
        }
        return [];
      },
    },
    windows: {
      async getLastFocused() {
        return { id: 8, focused: false };
      },
      async create(createData: chrome.windows.CreateData = {}) {
        popupCreates.push(createData);
        return { id: 92, ...createData };
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-access-request-unfocused-${Date.now()}`,
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'background-access-request-unfocused',
      method: 'access.request',
    })
  );

  assert.equal(response.ok, false);
  if (response.ok) {
    assert.fail('Expected background access request to fail.');
  }
  assert.equal(response.error.code, ERROR_CODES.ACCESS_DENIED);
  assert.match(response.error.message, /enable access manually/i);
  assert.match(response.error.message, /do not retry/i);
  assert.deepEqual(response.error.details, {
    reason: 'browser_background',
    requestedTargetWindowId: 8,
    requestedTargetTabId: 28,
  });
  assert.equal(getAccessRequestState(loaded.module).requestedAccessWindowId, null);
  assert.deepEqual(popupCreates, []);
});

test('background access request reuses an open side panel instead of opening a popup', async () => {
  const nativeMessages: unknown[] = [];
  const popupCreates: chrome.windows.CreateData[] = [];
  const portPair = createMessagePortPair({ leftName: 'ui-sidepanel', rightName: 'agent' });
  const chrome = createChromeFake({
    runtime: {
      connectNative() {
        return createNativePort(nativeMessages);
      },
    },
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
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
      async get(tabId: number) {
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
      async create(createData: chrome.windows.CreateData = {}) {
        popupCreates.push(createData);
        return { id: 92, ...createData };
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-access-request-sidepanel-${Date.now()}`,
  });

  getAccessRequestChrome(loaded.chrome).runtime.onConnect.dispatch(portPair.left.port);
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

  const state = getAccessRequestState(loaded.module);
  assert.equal(state.requestedAccessWindowId, 8);
  assert.equal(state.requestedAccessPopupWindowId, null);
  assert.deepEqual(popupCreates, []);
  assert.equal(
    nativeMessages.some(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        (message as { type: unknown }).type === 'host.access_update'
    ),
    false
  );
});

test('background access request rejects duplicate requests for the same pending window', async () => {
  const popupCreates: chrome.windows.CreateData[] = [];
  const chrome = createChromeFake({
    runtime: {
      getURL(path: string) {
        return `chrome-extension://test-extension-id/${path}`;
      },
    },
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
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
      async get(windowId: number) {
        assert.equal(windowId, 9);
        return { id: 9, left: 60, top: 30, width: 900 };
      },
      async create(createData: chrome.windows.CreateData = {}) {
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

  const state = getAccessRequestState(loaded.module);
  assert.equal(state.requestedAccessWindowId, 9);
  assert.equal(state.requestedAccessPopupWindowId, 93);
});

test('background access request reports enabled access without queuing a prompt', async () => {
  const popupCreates: chrome.windows.CreateData[] = [];
  const chrome = createChromeFake({
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [
            {
              id: 43,
              windowId: 9,
              title: 'Enabled tab',
              url: 'https://example.com/enabled',
              status: 'complete',
            },
          ];
        }
        return [];
      },
      async get(tabId: number) {
        assert.equal(tabId, 43);
        return {
          id: 43,
          windowId: 9,
          title: 'Enabled tab',
          url: 'https://example.com/enabled',
          status: 'complete',
        };
      },
    },
    windows: {
      async getLastFocused() {
        return { id: 9, focused: false };
      },
      async create(createData: chrome.windows.CreateData = {}) {
        popupCreates.push(createData);
        return { id: 95, ...createData };
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-access-request-enabled-${Date.now()}`,
  });
  const state = getAccessRequestState(loaded.module) as AccessRequestState & {
    enabledWindow?: { windowId: number; title: string; enabledAt: number };
  };
  state.enabledWindow = { windowId: 9, title: 'Enabled Window', enabledAt: 123 };

  const response = await loaded.dispatch(
    createRequest({
      id: 'background-access-request-enabled',
      method: 'access.request',
      tabId: 43,
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.equal(response.meta?.method, 'access.request');
  assert.deepEqual(response.result, {
    enabled: true,
    access: {
      enabled: true,
      windowId: 9,
      routeTabId: null,
      routeReady: false,
      routeUrl: '',
      reason: 'no_routable_active_tab',
    },
  });
  assert.deepEqual(popupCreates, []);
});

test('background access request rejects a different requested window while access is enabled', async () => {
  const chrome = createChromeFake({
    tabs: {
      async get(tabId: number) {
        assert.equal(tabId, 44);
        return {
          id: 44,
          windowId: 10,
          title: 'Other window tab',
          url: 'https://example.com/other-window',
          status: 'complete',
        };
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-access-request-enabled-mismatch-${Date.now()}`,
  });
  const state = getAccessRequestState(loaded.module) as AccessRequestState & {
    enabledWindow?: { windowId: number; title: string; enabledAt: number };
  };
  state.enabledWindow = { windowId: 9, title: 'Enabled Window', enabledAt: 123 };

  const response = await loaded.dispatch(
    createRequest({
      id: 'background-access-request-enabled-mismatch',
      method: 'access.request',
      tabId: 44,
    })
  );

  assert.equal(response.ok, false);
  if (response.ok) {
    assert.fail('Expected enabled window mismatch to fail.');
  }
  assert.equal(response.error.code, ERROR_CODES.ACCESS_DENIED);
  assert.match(response.error.message, /enabled for another window/i);
  assert.deepEqual(response.error.details, {
    enabledWindowId: 9,
    requestedTargetWindowId: 10,
    requestedTargetTabId: 44,
  });
});

test('background access request rejects when no scriptable target exists', async () => {
  const chrome = createChromeFake({
    tabs: {
      async query() {
        return [];
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-access-request-no-target-${Date.now()}`,
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'background-access-request-no-target',
      method: 'access.request',
    })
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.ACCESS_DENIED);
  assert.equal(response.error.message, 'No scriptable tab found in the focused window.');
  assert.equal(response.meta?.method, 'access.request');
});

test('background access request rejects duplicate requests for another pending window', async () => {
  const chrome = createChromeFake({
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [
            {
              id: 44,
              windowId: 10,
              title: 'Other pending tab',
              url: 'https://example.com/other-pending',
              status: 'complete',
            },
          ];
        }
        return [];
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-access-request-other-pending-${Date.now()}`,
  });
  const state = getAccessRequestState(loaded.module);
  state.requestedAccessWindowId = 9;

  const response = await loaded.dispatch(
    createRequest({
      id: 'background-access-request-other-pending',
      method: 'access.request',
    })
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.ACCESS_DENIED);
  assert.match(response.error.message, /already pending for another window/i);
  assert.deepEqual(response.error.details, {
    requestedWindowId: 9,
    requestedTargetWindowId: 10,
    requestedTargetTabId: 44,
  });
});

test('background access request clears popup state when the access popup window is dismissed', async () => {
  const chrome = createChromeFake({
    runtime: {
      getURL(path: string) {
        return `chrome-extension://test-extension-id/${path}`;
      },
    },
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
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
      async get(windowId: number) {
        assert.equal(windowId, 12);
        return {
          id: 12,
          left: 80,
          top: 20,
          width: 1000,
        };
      },
      async create(createData: chrome.windows.CreateData = {}) {
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

  const state = getAccessRequestState(loaded.module);
  assert.equal(state.requestedAccessWindowId, 12);
  assert.equal(state.requestedAccessPopupWindowId, 94);

  getAccessRequestChrome(loaded.chrome).windows.onRemoved.dispatch(999);
  assert.equal(state.requestedAccessPopupWindowId, 94);

  getAccessRequestChrome(loaded.chrome).windows.onRemoved.dispatch(94);
  assert.equal(state.requestedAccessPopupWindowId, null);
  assert.equal(state.requestedAccessWindowId, 12);
});
