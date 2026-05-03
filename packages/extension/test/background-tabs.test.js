// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { ERROR_CODES } from '../../protocol/src/index.js';
import { handleCreateTab, handleListTabs } from '../src/background-tabs.js';
import { makeRequest } from '../../../tests/_helpers/protocolFactories.js';

const ACCESS_DENIED_WINDOW_OFF = 'Browser Bridge is off for this window.';

test('handleListTabs denies access when no window is enabled', async () => {
  let queried = false;

  const response = await handleListTabs(
    makeRequest('tabs.list', {
      id: 'req-list-0',
      params: {},
    }),
    { enabledWindow: null },
    {
      async queryTabs() {
        queried = true;
        return [];
      },
    },
    ACCESS_DENIED_WINDOW_OFF
  );

  assert.equal(queried, false);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.ACCESS_DENIED);
  assert.equal(response.error.message, ACCESS_DENIED_WINDOW_OFF);
});

test('handleListTabs scopes the query to the enabled window and summarizes valid tabs', async () => {
  /** @type {Array<{ windowId: number }>} */
  const queries = [];

  const response = await handleListTabs(
    makeRequest('tabs.list', {
      id: 'req-list-1',
      params: {},
    }),
    { enabledWindow: { windowId: 7 } },
    {
      async queryTabs(query) {
        queries.push(query);
        return [
          /** @type {chrome.tabs.Tab} */ ({
            id: 11,
            windowId: 7,
            active: true,
            title: 'Example',
            url: 'https://example.com/path',
          }),
          /** @type {chrome.tabs.Tab} */ ({
            id: undefined,
            windowId: 7,
            active: false,
            title: 'Broken',
            url: 'https://example.com/broken',
          }),
          /** @type {chrome.tabs.Tab} */ ({
            id: 12,
            windowId: 7,
            active: false,
            title: 'Missing URL',
          }),
        ];
      },
    },
    ACCESS_DENIED_WINDOW_OFF
  );

  assert.deepEqual(queries, [{ windowId: 7 }]);
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, {
    tabs: [
      {
        tabId: 11,
        windowId: 7,
        active: true,
        title: 'Example',
        origin: 'https://example.com',
        url: 'https://example.com/path',
      },
    ],
  });
});

test('handleCreateTab denies access when no window is enabled', async () => {
  let created = false;

  const response = await handleCreateTab(
    makeRequest('tabs.create', {
      id: 'req-create-0',
      params: {},
    }),
    { enabledWindow: null },
    {
      async createTab() {
        created = true;
        return /** @type {chrome.tabs.Tab} */ ({});
      },
    },
    ACCESS_DENIED_WINDOW_OFF
  );

  assert.equal(created, false);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.ACCESS_DENIED);
  assert.equal(response.error.message, ACCESS_DENIED_WINDOW_OFF);
});

test('handleCreateTab normalizes the request and creates the tab inside the enabled window', async () => {
  /** @type {Array<{ url: string, active: boolean, windowId: number }>} */
  const creates = [];

  const response = await handleCreateTab(
    makeRequest('tabs.create', {
      id: 'req-create-1',
      params: {
        url: ' https://example.com/new ',
        active: false,
      },
    }),
    { enabledWindow: { windowId: 9 } },
    {
      async createTab(properties) {
        creates.push(properties);
        return /** @type {chrome.tabs.Tab} */ ({
          id: 41,
          windowId: properties.windowId,
          title: 'New Tab',
          url: properties.url,
          status: 'complete',
        });
      },
    },
    ACCESS_DENIED_WINDOW_OFF
  );

  assert.deepEqual(creates, [
    {
      url: 'https://example.com/new',
      active: false,
      windowId: 9,
    },
  ]);
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, {
    method: 'tabs.create',
    tabId: 41,
    windowId: 9,
    url: 'https://example.com/new',
    title: 'New Tab',
    status: 'complete',
  });
});

test('handleCreateTab rejects invalid tab URLs before calling chrome.tabs.create', async () => {
  let created = false;

  await assert.rejects(
    async () => {
      const request = makeRequest('tabs.create', {
        id: 'req-create-2',
        params: {
          url: 'not a url',
        },
      });
      await handleCreateTab(
        request,
        { enabledWindow: { windowId: 9 } },
        {
          async createTab() {
            created = true;
            return /** @type {chrome.tabs.Tab} */ ({});
          },
        },
        ACCESS_DENIED_WINDOW_OFF
      );
    },
    (error) => {
      assert.equal(error instanceof Error, true);
      const bridgeError = /** @type {Error & { code?: string }} */ (error);
      assert.equal(bridgeError.code, ERROR_CODES.INVALID_REQUEST);
      assert.match(bridgeError.message, /Invalid tab create URL: not a url/);
      return true;
    }
  );

  assert.equal(created, false);
});
