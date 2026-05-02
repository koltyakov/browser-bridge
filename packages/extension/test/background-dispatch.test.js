// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { createChromeFake } from '../../../tests/_helpers/chromeFake.js';
import { loadBackground } from '../../../tests/_helpers/loadBackground.js';
import { createRequest, ERROR_CODES } from '../../protocol/src/index.js';

/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */
/** @typedef {import('../../protocol/src/types.js').BridgeMethod} BridgeMethod */

/**
 * @param {Partial<chrome.tabs.Tab>} [overrides]
 * @returns {chrome.tabs.Tab}
 */
function createDispatchActiveTab(overrides = {}) {
  return /** @type {chrome.tabs.Tab} */ ({
    id: 81,
    windowId: 7,
    active: true,
    title: 'Dispatch tab',
    url: 'https://example.com/dispatch',
    status: 'complete',
    ...overrides,
  });
}

/**
 * @param {{
 *   queryLabel: string,
 *   activeTab?: chrome.tabs.Tab,
 *   chromeOverrides?: Record<string, any>,
 * }} options
 * @returns {Promise<{ loaded: Awaited<ReturnType<typeof loadBackground>>, activeTab: chrome.tabs.Tab }>}
 */
async function loadEnabledDispatchBackground({
  queryLabel,
  activeTab = createDispatchActiveTab(),
  chromeOverrides = {},
}) {
  const {
    tabs: tabOverrides = {},
    windows: windowOverrides = {},
    ...restChromeOverrides
  } = chromeOverrides;
  const chrome = createChromeFake({
    ...restChromeOverrides,
    tabs: {
      /** @param {chrome.tabs.QueryInfo} [queryInfo] */
      async query(queryInfo = /** @type {chrome.tabs.QueryInfo} */ ({})) {
        if (queryInfo.active && queryInfo.windowId === activeTab.windowId) {
          return [{ ...activeTab }];
        }
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [];
        }
        return [];
      },
      /** @param {number} tabId */
      async get(tabId) {
        assert.equal(tabId, activeTab.id);
        return { ...activeTab };
      },
      ...tabOverrides,
    },
    windows: {
      /** @param {number} windowId */
      async get(windowId) {
        return { id: windowId };
      },
      ...windowOverrides,
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `${queryLabel}-${Date.now()}-${Math.random()}`,
  });

  loaded.module.getStateForTest().enabledWindow = {
    windowId: activeTab.windowId,
    title: 'Enabled Window',
    enabledAt: Date.now(),
  };

  return { loaded, activeTab };
}

/**
 * @param {() => number} getCount
 * @param {number} expected
 * @returns {Promise<void>}
 */
async function waitForListenerCount(getCount, expected) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (getCount() === expected) {
      return;
    }
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(getCount(), expected);
}

test('background dispatch routes health.ping through the native reply path', async () => {
  const loaded = await loadBackground({
    query: `test-background-dispatch-health-${Date.now()}`,
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-health-ping',
      method: 'health.ping',
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.equal(response.id, 'dispatch-health-ping');
  assert.equal(response.meta?.method, 'health.ping');
  const result =
    /** @type {{ extension: string, access: unknown, supported_versions: string[] }} */ (
      response.result
    );
  assert.equal(result.extension, 'ok');
  assert.deepEqual(result.access, {
    enabled: false,
    windowId: null,
    routeTabId: null,
    routeReady: false,
    routeUrl: '',
    reason: 'access_disabled',
  });
  assert.equal(Array.isArray(result.supported_versions), true);
  assert.equal(result.supported_versions.length > 0, true);
  assert.equal(typeof response.meta?.transport_bytes, 'number');
});

test('background dispatch routes skill.get_runtime_context with enriched metadata', async () => {
  const loaded = await loadBackground({
    query: `test-background-dispatch-runtime-${Date.now()}`,
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-runtime-context',
      method: 'skill.get_runtime_context',
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.equal(response.id, 'dispatch-runtime-context');
  assert.equal(response.meta?.method, 'skill.get_runtime_context');
  const result =
    /** @type {{ v: string, budgets: Record<string, unknown>, tips: unknown[], flow: string[] }} */ (
      response.result
    );
  assert.equal(typeof result.v, 'string');
  assert.deepEqual(Object.keys(result.budgets).sort(), ['deep', 'normal', 'quick']);
  assert.equal(Array.isArray(result.tips), true);
  assert.equal(result.tips.length > 0, true);
  assert.equal(Array.isArray(result.flow), true);
  assert.equal(result.flow[0], 'health.ping');
});

test('background dispatch lists tabs in the enabled window', async () => {
  /** @type {Array<chrome.tabs.QueryInfo>} */
  const queries = [];
  const chrome = createChromeFake({
    tabs: {
      /** @param {chrome.tabs.QueryInfo} [queryInfo] */
      async query(queryInfo = /** @type {chrome.tabs.QueryInfo} */ ({})) {
        queries.push(queryInfo);
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [];
        }
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
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-dispatch-tabs-list-${Date.now()}`,
  });

  loaded.module.getStateForTest().enabledWindow = {
    windowId: 7,
    title: 'Enabled Window',
    enabledAt: Date.now(),
  };

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-tabs-list',
      method: 'tabs.list',
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.equal(response.meta?.method, 'tabs.list');
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
  assert.equal(
    queries.some(
      (query) => query && typeof query === 'object' && 'windowId' in query && query.windowId === 7
    ),
    true
  );
});

test('background dispatch creates a tab in the enabled window', async () => {
  /** @type {Array<{ url: string, active: boolean, windowId: number }>} */
  const createCalls = [];
  const chrome = createChromeFake({
    tabs: {
      /** @param {{ url: string, active: boolean, windowId: number }} createProperties */
      async create(createProperties) {
        createCalls.push(createProperties);
        return /** @type {chrome.tabs.Tab} */ ({
          id: 21,
          windowId: createProperties.windowId,
          url: createProperties.url,
          title: 'New tab',
          status: 'complete',
        });
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-dispatch-tabs-create-${Date.now()}`,
  });

  loaded.module.getStateForTest().enabledWindow = {
    windowId: 7,
    title: 'Enabled Window',
    enabledAt: Date.now(),
  };

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-tabs-create',
      method: 'tabs.create',
      params: {
        url: 'https://example.com/new',
        active: false,
      },
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.deepEqual(createCalls, [
    {
      url: 'https://example.com/new',
      active: false,
      windowId: 7,
    },
  ]);
  assert.equal(response.meta?.method, 'tabs.create');
  assert.deepEqual(response.result, {
    method: 'tabs.create',
    tabId: 21,
    windowId: 7,
    url: 'https://example.com/new',
    title: 'New tab',
    status: 'complete',
  });
});

test('background dispatch rejects tabs.create when no window is enabled', async () => {
  let createCalled = false;
  const chrome = createChromeFake({
    tabs: {
      async create() {
        createCalled = true;
        return /** @type {chrome.tabs.Tab} */ ({ id: 1 });
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-dispatch-tabs-create-denied-${Date.now()}`,
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-tabs-create-denied',
      method: 'tabs.create',
      params: {
        url: 'https://example.com/new',
      },
    })
  );

  assert.equal(createCalled, false);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.ACCESS_DENIED);
  assert.equal(response.error.message, 'Browser Bridge is off for this window.');
  assert.equal(response.meta?.method, 'tabs.create');
});

test('background dispatch closes a tab inside the enabled window', async () => {
  /** @type {number[]} */
  const removedTabIds = [];
  const chrome = createChromeFake({
    tabs: {
      /** @param {number} tabId */
      async get(tabId) {
        return /** @type {chrome.tabs.Tab} */ ({
          id: tabId,
          windowId: 7,
          url: 'https://example.com/close-me',
        });
      },
      /** @param {number} tabId */
      async remove(tabId) {
        removedTabIds.push(tabId);
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-dispatch-tabs-close-${Date.now()}`,
  });

  loaded.module.getStateForTest().enabledWindow = {
    windowId: 7,
    title: 'Enabled Window',
    enabledAt: Date.now(),
  };

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-tabs-close',
      method: 'tabs.close',
      params: {
        tabId: 21,
      },
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.deepEqual(removedTabIds, [21]);
  assert.equal(response.meta?.method, 'tabs.close');
  assert.deepEqual(response.result, {
    closed: true,
    tabId: 21,
  });
});

test('background dispatch rejects tabs.close when no window is enabled', async () => {
  const chrome = createChromeFake({
    tabs: {
      async get() {
        return /** @type {chrome.tabs.Tab} */ ({ id: 21, windowId: 7 });
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-dispatch-tabs-close-window-off-${Date.now()}`,
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-tabs-close-window-off',
      method: 'tabs.close',
      params: {
        tabId: 21,
      },
    })
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.ACCESS_DENIED);
  assert.equal(response.error.message, 'Browser Bridge is off for this window.');
  assert.equal(response.meta?.method, 'tabs.close');
});

test('background dispatch rejects tabs.close for a tab outside the enabled window', async () => {
  let removeCalled = false;
  const chrome = createChromeFake({
    tabs: {
      /** @param {number} tabId */
      async get(tabId) {
        return /** @type {chrome.tabs.Tab} */ ({
          id: tabId,
          windowId: 8,
          url: 'https://example.com/outside',
        });
      },
      async remove() {
        removeCalled = true;
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-dispatch-tabs-close-denied-${Date.now()}`,
  });

  loaded.module.getStateForTest().enabledWindow = {
    windowId: 7,
    title: 'Enabled Window',
    enabledAt: Date.now(),
  };

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-tabs-close-denied',
      method: 'tabs.close',
      params: {
        tabId: 21,
      },
    })
  );

  assert.equal(removeCalled, false);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.ACCESS_DENIED);
  assert.equal(response.error.message, 'tabs.close only works inside the enabled window.');
  assert.equal(response.meta?.method, 'tabs.close');
});

for (const scenario of [
  {
    method: 'navigation.navigate',
    params: {
      url: 'https://example.com/next',
      waitForLoad: false,
    },
    expectedUrl: 'https://example.com/next',
    expectedCalls: {
      update: [{ tabId: 31, properties: { url: 'https://example.com/next' } }],
      reload: [],
      goBack: [],
      goForward: [],
    },
  },
  {
    method: 'navigation.reload',
    params: {
      waitForLoad: false,
    },
    expectedUrl: 'https://example.com/current',
    expectedCalls: {
      update: [],
      reload: [31],
      goBack: [],
      goForward: [],
    },
  },
  {
    method: 'navigation.go_back',
    params: {
      waitForLoad: false,
    },
    expectedUrl: 'https://example.com/current',
    expectedCalls: {
      update: [],
      reload: [],
      goBack: [31],
      goForward: [],
    },
  },
  {
    method: 'navigation.go_forward',
    params: {
      waitForLoad: false,
    },
    expectedUrl: 'https://example.com/current',
    expectedCalls: {
      update: [],
      reload: [],
      goBack: [],
      goForward: [31],
    },
  },
]) {
  test(`background dispatch handles ${scenario.method} inside the enabled window`, async () => {
    /** @type {Array<{ tabId: number, properties: { url: string } }>} */
    const updateCalls = [];
    /** @type {number[]} */
    const reloadCalls = [];
    /** @type {number[]} */
    const goBackCalls = [];
    /** @type {number[]} */
    const goForwardCalls = [];
    const tab = /** @type {chrome.tabs.Tab} */ ({
      id: 31,
      windowId: 7,
      active: true,
      title: 'Current page',
      url: 'https://example.com/current',
      status: 'complete',
    });
    const chrome = createChromeFake({
      tabs: {
        /** @param {chrome.tabs.QueryInfo} [queryInfo] */
        async query(queryInfo = /** @type {chrome.tabs.QueryInfo} */ ({})) {
          if (
            queryInfo.active &&
            (queryInfo.windowId === 7 || queryInfo.lastFocusedWindow === true)
          ) {
            return [tab];
          }
          return [];
        },
        /** @param {number} tabId */
        async get(tabId) {
          assert.equal(tabId, 31);
          return { ...tab };
        },
        /** @param {number} tabId @param {{ url: string }} properties */
        async update(tabId, properties) {
          updateCalls.push({ tabId, properties });
          if (typeof properties.url === 'string') {
            tab.url = properties.url;
          }
          return { ...tab };
        },
        /** @param {number} tabId */
        async reload(tabId) {
          reloadCalls.push(tabId);
        },
        /** @param {number} tabId */
        async goBack(tabId) {
          goBackCalls.push(tabId);
        },
        /** @param {number} tabId */
        async goForward(tabId) {
          goForwardCalls.push(tabId);
        },
      },
      windows: {
        /** @param {number} windowId */
        async get(windowId) {
          return { id: windowId };
        },
      },
    });
    const loaded = await loadBackground({
      chrome,
      query: `test-background-dispatch-${scenario.method}-${Date.now()}`,
    });

    loaded.module.getStateForTest().enabledWindow = {
      windowId: 7,
      title: 'Enabled Window',
      enabledAt: Date.now(),
    };

    const response = await loaded.dispatch(
      createRequest({
        id: `dispatch-${scenario.method}`,
        method: /** @type {BridgeMethod} */ (scenario.method),
        params: scenario.params,
      })
    );

    if (!response.ok) {
      assert.fail(response.error.message);
    }
    assert.equal(response.meta?.method, scenario.method);
    assert.deepEqual(response.result, {
      method: scenario.method,
      tabId: 31,
      windowId: 7,
      url: scenario.expectedUrl,
      title: 'Current page',
      status: 'complete',
    });
    assert.deepEqual(updateCalls, scenario.expectedCalls.update);
    assert.deepEqual(reloadCalls, scenario.expectedCalls.reload);
    assert.deepEqual(goBackCalls, scenario.expectedCalls.goBack);
    assert.deepEqual(goForwardCalls, scenario.expectedCalls.goForward);
  });
}

test('background dispatch routes page.get_state through the tab-bound content script path', async () => {
  /** @type {Array<{ tabId: number, message: Record<string, unknown> }>} */
  const sendMessageCalls = [];
  /** @type {Array<Record<string, unknown>>} */
  const executeScriptCalls = [];
  const activeTab = /** @type {chrome.tabs.Tab} */ ({
    id: 41,
    windowId: 7,
    active: true,
    title: 'Stateful page',
    url: 'https://example.com/app',
  });
  const chrome = createChromeFake({
    tabs: {
      /** @param {chrome.tabs.QueryInfo} [queryInfo] */
      async query(queryInfo = /** @type {chrome.tabs.QueryInfo} */ ({})) {
        if (queryInfo.active && queryInfo.windowId === 7) {
          return [activeTab];
        }
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [];
        }
        return [];
      },
      /** @param {number} tabId @param {Record<string, unknown>} message */
      async sendMessage(tabId, message) {
        sendMessageCalls.push({ tabId, message });
        if (message.type === 'bridge.ping') {
          throw new Error('Receiving end does not exist.');
        }
        return {
          url: activeTab.url,
          title: activeTab.title,
          ready: true,
        };
      },
    },
    windows: {
      /** @param {number} windowId */
      async get(windowId) {
        return { id: windowId };
      },
    },
    scripting: {
      /** @param {Record<string, unknown>} injection */
      async executeScript(injection) {
        executeScriptCalls.push(injection);
        return [];
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-dispatch-page-state-${Date.now()}`,
  });

  loaded.module.getStateForTest().enabledWindow = {
    windowId: 7,
    title: 'Enabled Window',
    enabledAt: Date.now(),
  };

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-page-state',
      method: 'page.get_state',
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.equal(response.meta?.method, 'page.get_state');
  assert.deepEqual(response.result, {
    url: 'https://example.com/app',
    title: 'Stateful page',
    ready: true,
  });
  assert.deepEqual(executeScriptCalls, [
    {
      target: { tabId: 41 },
      files: [
        'packages/extension/src/content-script-helpers.js',
        'packages/extension/src/content-script.js',
      ],
    },
  ]);
  assert.deepEqual(sendMessageCalls, [
    {
      tabId: 41,
      message: { type: 'bridge.ping' },
    },
    {
      tabId: 41,
      message: {
        type: 'bridge.execute',
        method: 'page.get_state',
        params: {},
      },
    },
  ]);
});

test('background dispatch rejects tab-bound requests for tabs outside the enabled window', async () => {
  /** @type {Array<number>} */
  const getCalls = [];
  /** @type {Array<chrome.tabs.QueryInfo>} */
  const queryCalls = [];
  let sendMessageCalled = false;
  let executeScriptCalled = false;
  const chrome = createChromeFake({
    tabs: {
      /** @param {number} tabId */
      async get(tabId) {
        getCalls.push(tabId);
        return /** @type {chrome.tabs.Tab} */ ({
          id: tabId,
          windowId: 8,
          title: 'Outside tab',
          url: 'https://example.com/outside',
        });
      },
      /** @param {chrome.tabs.QueryInfo} [queryInfo] */
      async query(queryInfo = /** @type {chrome.tabs.QueryInfo} */ ({})) {
        queryCalls.push(queryInfo);
        if (queryInfo.active && queryInfo.windowId === 7) {
          return [
            /** @type {chrome.tabs.Tab} */ ({
              id: 41,
              windowId: 7,
              active: true,
              title: 'Inside tab',
              url: 'https://example.com/inside',
            }),
          ];
        }
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [];
        }
        return [];
      },
      async sendMessage() {
        sendMessageCalled = true;
        return {};
      },
    },
    windows: {
      /** @param {number} windowId */
      async get(windowId) {
        return { id: windowId };
      },
    },
    scripting: {
      async executeScript() {
        executeScriptCalled = true;
        return [];
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-dispatch-page-state-denied-${Date.now()}`,
  });

  loaded.module.getStateForTest().enabledWindow = {
    windowId: 7,
    title: 'Enabled Window',
    enabledAt: Date.now(),
  };

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-page-state-denied',
      method: 'page.get_state',
      tabId: 55,
    })
  );

  assert.equal(getCalls.length >= 1, true);
  assert.equal(
    getCalls.every((tabId) => tabId === 55),
    true
  );
  assert.deepEqual(queryCalls.at(-1), { active: true, windowId: 7 });
  assert.equal(sendMessageCalled, false);
  assert.equal(executeScriptCalled, false);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.ACCESS_DENIED);
  assert.equal(response.error.message, ERROR_CODES.ACCESS_DENIED);
  assert.equal(response.meta?.method, 'page.get_state');
});

test('background dispatch returns filtered console buffer entries', async () => {
  /** @type {Array<Record<string, unknown>>} */
  const executeScriptCalls = [];
  const activeTab = /** @type {chrome.tabs.Tab} */ ({
    id: 71,
    windowId: 7,
    active: true,
    title: 'Console page',
    url: 'https://example.com/console',
  });
  const chrome = createChromeFake({
    tabs: {
      /** @param {chrome.tabs.QueryInfo} [queryInfo] */
      async query(queryInfo = /** @type {chrome.tabs.QueryInfo} */ ({})) {
        if (queryInfo.active && queryInfo.windowId === 7) {
          return [activeTab];
        }
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [];
        }
        return [];
      },
    },
    windows: {
      /** @param {number} windowId */
      async get(windowId) {
        return { id: windowId };
      },
    },
    scripting: {
      /** @param {Record<string, unknown>} injection */
      async executeScript(injection) {
        executeScriptCalls.push(injection);
        if (Array.isArray(injection.args)) {
          return [
            {
              result: {
                entries: [
                  { level: 'log', args: ['ready'], ts: 1 },
                  { level: 'error', args: ['boom'], ts: 2 },
                  { level: 'exception', args: ['TypeError'], ts: 3 },
                  { level: 'rejection', args: ['Promise rejected'], ts: 4 },
                ],
                dropped: 3,
              },
            },
          ];
        }
        return [];
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-dispatch-page-console-${Date.now()}`,
  });

  loaded.module.getStateForTest().enabledWindow = {
    windowId: 7,
    title: 'Enabled Window',
    enabledAt: Date.now(),
  };

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-page-console',
      method: 'page.get_console',
      params: {
        level: 'error',
        limit: 2,
        clear: true,
      },
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.equal(response.meta?.method, 'page.get_console');
  assert.deepEqual(response.result, {
    entries: [
      { level: 'exception', args: ['TypeError'], ts: 3 },
      { level: 'rejection', args: ['Promise rejected'], ts: 4 },
    ],
    count: 2,
    total: 4,
    dropped: 3,
  });
  assert.deepEqual(
    executeScriptCalls.map((call) => ({
      target: call.target,
      world: call.world,
      args: call.args ?? null,
    })),
    [
      {
        target: { tabId: 71 },
        world: 'MAIN',
        args: null,
      },
      {
        target: { tabId: 71 },
        world: 'MAIN',
        args: [true],
      },
    ]
  );
});

test('background dispatch surfaces console buffer read failures', async () => {
  /** @type {Array<Record<string, unknown>>} */
  const executeScriptCalls = [];
  const activeTab = /** @type {chrome.tabs.Tab} */ ({
    id: 72,
    windowId: 7,
    active: true,
    title: 'Console failure page',
    url: 'https://example.com/console-failure',
  });
  const chrome = createChromeFake({
    tabs: {
      /** @param {chrome.tabs.QueryInfo} [queryInfo] */
      async query(queryInfo = /** @type {chrome.tabs.QueryInfo} */ ({})) {
        if (queryInfo.active && queryInfo.windowId === 7) {
          return [activeTab];
        }
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [];
        }
        return [];
      },
    },
    windows: {
      /** @param {number} windowId */
      async get(windowId) {
        return { id: windowId };
      },
    },
    scripting: {
      /** @param {Record<string, unknown>} injection */
      async executeScript(injection) {
        executeScriptCalls.push(injection);
        if (Array.isArray(injection.args)) {
          throw new Error('console buffer read failed');
        }
        return [];
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-dispatch-page-console-error-${Date.now()}`,
  });

  loaded.module.getStateForTest().enabledWindow = {
    windowId: 7,
    title: 'Enabled Window',
    enabledAt: Date.now(),
  };

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-page-console-error',
      method: 'page.get_console',
    })
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INTERNAL_ERROR);
  assert.equal(response.error.message, 'console buffer read failed');
  assert.equal(response.meta?.method, 'page.get_console');
  assert.deepEqual(
    executeScriptCalls.map((call) => ({
      target: call.target,
      world: call.world,
      args: call.args ?? null,
    })),
    [
      {
        target: { tabId: 72 },
        world: 'MAIN',
        args: null,
      },
      {
        target: { tabId: 72 },
        world: 'MAIN',
        args: [false],
      },
    ]
  );
});

test('background dispatch returns filtered network buffer entries', async () => {
  /** @type {Array<Record<string, unknown>>} */
  const executeScriptCalls = [];
  const activeTab = /** @type {chrome.tabs.Tab} */ ({
    id: 73,
    windowId: 7,
    active: true,
    title: 'Network page',
    url: 'https://example.com/network',
  });
  const chrome = createChromeFake({
    tabs: {
      /** @param {chrome.tabs.QueryInfo} [queryInfo] */
      async query(queryInfo = /** @type {chrome.tabs.QueryInfo} */ ({})) {
        if (queryInfo.active && queryInfo.windowId === 7) {
          return [activeTab];
        }
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [];
        }
        return [];
      },
    },
    windows: {
      /** @param {number} windowId */
      async get(windowId) {
        return { id: windowId };
      },
    },
    scripting: {
      /** @param {Record<string, unknown>} injection */
      async executeScript(injection) {
        executeScriptCalls.push(injection);
        if (Array.isArray(injection.args)) {
          return [
            {
              result: {
                entries: [
                  {
                    method: 'GET',
                    url: 'https://example.com/api/users',
                    status: 200,
                    duration: 12,
                    type: 'fetch',
                    ts: 10,
                    size: 321,
                  },
                  {
                    method: 'POST',
                    url: 'https://example.com/metrics',
                    status: 202,
                    duration: 8,
                    type: 'xhr',
                    ts: 11,
                    size: 64,
                  },
                  {
                    method: 'GET',
                    url: 'https://example.com/api/orders',
                    status: 200,
                    duration: 18,
                    type: 'fetch',
                    ts: 12,
                    size: 654,
                  },
                ],
                dropped: 2,
              },
            },
          ];
        }
        return [];
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-dispatch-page-network-${Date.now()}`,
  });

  loaded.module.getStateForTest().enabledWindow = {
    windowId: 7,
    title: 'Enabled Window',
    enabledAt: Date.now(),
  };

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-page-network',
      method: 'page.get_network',
      params: {
        urlPattern: '/api/',
        limit: 1,
        clear: true,
      },
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.equal(response.meta?.method, 'page.get_network');
  assert.deepEqual(response.result, {
    entries: [
      {
        method: 'GET',
        url: 'https://example.com/api/orders',
        status: 200,
        duration: 18,
        type: 'fetch',
        ts: 12,
        size: 654,
      },
    ],
    count: 1,
    total: 3,
    dropped: 2,
  });
  assert.deepEqual(
    executeScriptCalls.map((call) => ({
      target: call.target,
      world: call.world,
      args: call.args ?? null,
    })),
    [
      {
        target: { tabId: 73 },
        world: 'MAIN',
        args: null,
      },
      {
        target: { tabId: 73 },
        world: 'MAIN',
        args: [true],
      },
    ]
  );
});

test('background dispatch surfaces network buffer read failures', async () => {
  /** @type {Array<Record<string, unknown>>} */
  const executeScriptCalls = [];
  const activeTab = /** @type {chrome.tabs.Tab} */ ({
    id: 74,
    windowId: 7,
    active: true,
    title: 'Network failure page',
    url: 'https://example.com/network-failure',
  });
  const chrome = createChromeFake({
    tabs: {
      /** @param {chrome.tabs.QueryInfo} [queryInfo] */
      async query(queryInfo = /** @type {chrome.tabs.QueryInfo} */ ({})) {
        if (queryInfo.active && queryInfo.windowId === 7) {
          return [activeTab];
        }
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [];
        }
        return [];
      },
    },
    windows: {
      /** @param {number} windowId */
      async get(windowId) {
        return { id: windowId };
      },
    },
    scripting: {
      /** @param {Record<string, unknown>} injection */
      async executeScript(injection) {
        executeScriptCalls.push(injection);
        if (Array.isArray(injection.args)) {
          throw new Error('network buffer read failed');
        }
        return [];
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-dispatch-page-network-error-${Date.now()}`,
  });

  loaded.module.getStateForTest().enabledWindow = {
    windowId: 7,
    title: 'Enabled Window',
    enabledAt: Date.now(),
  };

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-page-network-error',
      method: 'page.get_network',
    })
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INTERNAL_ERROR);
  assert.equal(response.error.message, 'network buffer read failed');
  assert.equal(response.meta?.method, 'page.get_network');
  assert.deepEqual(
    executeScriptCalls.map((call) => ({
      target: call.target,
      world: call.world,
      args: call.args ?? null,
    })),
    [
      {
        target: { tabId: 74 },
        world: 'MAIN',
        args: null,
      },
      {
        target: { tabId: 74 },
        world: 'MAIN',
        args: [false],
      },
    ]
  );
});

test('background dispatch evaluates page expressions through the debugger', async () => {
  /** @type {Array<{ target: chrome.debugger.Debuggee, version: string }>} */
  const attachCalls = [];
  /** @type {Array<{ target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown> }>} */
  const sendCommandCalls = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-page-evaluate',
    chromeOverrides: {
      debugger: {
        /** @param {chrome.debugger.Debuggee} target @param {string} version */
        async attach(target, version) {
          attachCalls.push({ target, version });
        },
        /** @param {chrome.debugger.Debuggee} target @param {string} method @param {Record<string, unknown>} params */
        async sendCommand(target, method, params) {
          sendCommandCalls.push({ target, method, params });
          return {
            result: {
              type: 'number',
              value: 4,
            },
          };
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-page-evaluate',
      method: 'page.evaluate',
      params: {
        expression: '2 + 2',
        awaitPromise: true,
        timeoutMs: 1234,
      },
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.deepEqual(attachCalls, [{ target: { tabId: 81 }, version: '1.3' }]);
  assert.deepEqual(sendCommandCalls, [
    {
      target: { tabId: 81 },
      method: 'Runtime.evaluate',
      params: {
        expression: '2 + 2',
        returnByValue: true,
        awaitPromise: true,
        timeout: 1234,
        userGesture: true,
        generatePreview: false,
        replMode: true,
      },
    },
  ]);
  assert.equal(response.meta?.method, 'page.evaluate');
  assert.deepEqual(response.result, {
    value: 4,
    type: 'number',
  });
});

test('background dispatch returns evaluation failures from page.evaluate', async () => {
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-page-evaluate-error',
    chromeOverrides: {
      debugger: {
        async sendCommand() {
          return {
            exceptionDetails: {
              exception: {
                description: 'ReferenceError: missingValue is not defined',
              },
            },
          };
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-page-evaluate-error',
      method: 'page.evaluate',
      params: {
        expression: 'missingValue + 1',
      },
    })
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INTERNAL_ERROR);
  assert.equal(response.error.message, 'ReferenceError: missingValue is not defined');
  assert.equal(response.meta?.method, 'page.evaluate');
});

test('background dispatch returns a simplified accessibility tree', async () => {
  /** @type {Array<{ target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown> }>} */
  const sendCommandCalls = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-accessibility-tree',
    chromeOverrides: {
      debugger: {
        /** @param {chrome.debugger.Debuggee} target @param {string} method @param {Record<string, unknown>} params */
        async sendCommand(target, method, params) {
          sendCommandCalls.push({ target, method, params });
          if (method === 'Accessibility.getFullAXTree') {
            return {
              nodes: [
                {
                  nodeId: 1,
                  role: { value: 'button' },
                  name: { value: 'Submit' },
                  description: { value: 'Primary action' },
                  value: { value: 'Confirm' },
                  focused: { value: true },
                  checked: { value: 'mixed' },
                  childIds: [2],
                },
                {
                  nodeId: 2,
                  role: { value: 'StaticText' },
                  name: { value: 'Ignored' },
                },
              ],
            };
          }
          return {};
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-accessibility-tree',
      method: 'dom.get_accessibility_tree',
      params: {
        maxDepth: 3,
        maxNodes: 1,
      },
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.deepEqual(sendCommandCalls, [
    {
      target: { tabId: 81 },
      method: 'Accessibility.enable',
      params: {},
    },
    {
      target: { tabId: 81 },
      method: 'Accessibility.getFullAXTree',
      params: { depth: 3 },
    },
    {
      target: { tabId: 81 },
      method: 'Accessibility.disable',
      params: {},
    },
  ]);
  assert.equal(response.meta?.method, 'dom.get_accessibility_tree');
  assert.deepEqual(response.result, {
    nodes: [
      {
        nodeId: '1',
        role: 'button',
        name: 'Submit',
        description: 'Primary action',
        value: 'Confirm',
        focused: true,
        required: false,
        checked: 'mixed',
        disabled: false,
        interactive: true,
        childIds: ['2'],
      },
      {
        nodeId: '2',
        role: 'StaticText',
        name: 'Ignored',
        description: '',
        value: '',
        focused: false,
        required: false,
        checked: null,
        disabled: false,
        interactive: false,
        childIds: [],
      },
    ],
    count: 2,
    total: 2,
    truncated: false,
  });
});

test('background dispatch surfaces accessibility tree failures', async () => {
  /** @type {string[]} */
  const methods = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-accessibility-tree-error',
    chromeOverrides: {
      debugger: {
        /** @param {chrome.debugger.Debuggee} _target @param {string} method */
        async sendCommand(_target, method) {
          methods.push(method);
          if (method === 'Accessibility.getFullAXTree') {
            throw new Error('AX tree unavailable');
          }
          return {};
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-accessibility-tree-error',
      method: 'dom.get_accessibility_tree',
    })
  );

  assert.deepEqual(methods, ['Accessibility.enable', 'Accessibility.getFullAXTree']);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INTERNAL_ERROR);
  assert.equal(response.error.message, 'AX tree unavailable');
  assert.equal(response.meta?.method, 'dom.get_accessibility_tree');
});

test('background dispatch resizes the viewport through CDP metrics override', async () => {
  /** @type {Array<{ target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown> }>} */
  const sendCommandCalls = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-viewport-resize',
    chromeOverrides: {
      debugger: {
        /** @param {chrome.debugger.Debuggee} target @param {string} method @param {Record<string, unknown>} params */
        async sendCommand(target, method, params) {
          sendCommandCalls.push({ target, method, params });
          return {};
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-viewport-resize',
      method: 'viewport.resize',
      params: {
        width: 375,
        height: 667,
        deviceScaleFactor: 2,
      },
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.deepEqual(sendCommandCalls, [
    {
      target: { tabId: 81 },
      method: 'Emulation.setDeviceMetricsOverride',
      params: {
        width: 375,
        height: 667,
        deviceScaleFactor: 2,
        mobile: true,
      },
    },
  ]);
  assert.equal(response.meta?.method, 'viewport.resize');
  assert.deepEqual(response.result, {
    resized: true,
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    reset: false,
  });
});

test('background dispatch surfaces viewport reset failures', async () => {
  /** @type {string[]} */
  const methods = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-viewport-resize-error',
    chromeOverrides: {
      debugger: {
        /** @param {chrome.debugger.Debuggee} _target @param {string} method */
        async sendCommand(_target, method) {
          methods.push(method);
          throw new Error('Resize failed');
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-viewport-resize-error',
      method: 'viewport.resize',
      params: {
        reset: true,
      },
    })
  );

  assert.deepEqual(methods, ['Emulation.clearDeviceMetricsOverride']);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INTERNAL_ERROR);
  assert.equal(response.error.message, 'Resize failed');
  assert.equal(response.meta?.method, 'viewport.resize');
});

test('background dispatch returns performance metrics from CDP', async () => {
  /** @type {Array<{ target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown> }>} */
  const sendCommandCalls = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-performance-metrics',
    chromeOverrides: {
      debugger: {
        /** @param {chrome.debugger.Debuggee} target @param {string} method @param {Record<string, unknown>} params */
        async sendCommand(target, method, params) {
          sendCommandCalls.push({ target, method, params });
          if (method === 'Performance.getMetrics') {
            return {
              metrics: [
                { name: 'LayoutDuration', value: 12.5 },
                { name: 'Nodes', value: 42 },
              ],
            };
          }
          return {};
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-performance-metrics',
      method: 'performance.get_metrics',
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.deepEqual(sendCommandCalls, [
    {
      target: { tabId: 81 },
      method: 'Performance.enable',
      params: { timeDomain: 'timeTicks' },
    },
    {
      target: { tabId: 81 },
      method: 'Performance.getMetrics',
      params: {},
    },
    {
      target: { tabId: 81 },
      method: 'Performance.disable',
      params: {},
    },
  ]);
  assert.equal(response.meta?.method, 'performance.get_metrics');
  assert.deepEqual(response.result, {
    metrics: {
      LayoutDuration: 12.5,
      Nodes: 42,
    },
  });
});

test('background dispatch surfaces performance metric failures', async () => {
  /** @type {string[]} */
  const methods = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-performance-metrics-error',
    chromeOverrides: {
      debugger: {
        /** @param {chrome.debugger.Debuggee} _target @param {string} method */
        async sendCommand(_target, method) {
          methods.push(method);
          if (method === 'Performance.getMetrics') {
            throw new Error('metrics unavailable');
          }
          return {};
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-performance-metrics-error',
      method: 'performance.get_metrics',
    })
  );

  assert.deepEqual(methods, ['Performance.enable', 'Performance.getMetrics']);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INTERNAL_ERROR);
  assert.equal(response.error.message, 'metrics unavailable');
  assert.equal(response.meta?.method, 'performance.get_metrics');
});

test('background dispatch captures screenshot regions through a CDP clip', async () => {
  /** @type {Array<{ tabId: number, message: Record<string, unknown> }>} */
  const sendMessageCalls = [];
  /** @type {Array<{ target: chrome.debugger.Debuggee, version: string }>} */
  const attachCalls = [];
  /** @type {Array<{ target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown> }>} */
  const sendCommandCalls = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-screenshot-region',
    chromeOverrides: {
      tabs: {
        /** @param {number} tabId @param {Record<string, unknown>} message */
        async sendMessage(tabId, message) {
          sendMessageCalls.push({ tabId, message });
          return { ok: true };
        },
      },
      debugger: {
        /** @param {chrome.debugger.Debuggee} target @param {string} version */
        async attach(target, version) {
          attachCalls.push({ target, version });
        },
        /** @param {chrome.debugger.Debuggee} target @param {string} method @param {Record<string, unknown>} params */
        async sendCommand(target, method, params) {
          sendCommandCalls.push({ target, method, params });
          return { data: 'region-image-data' };
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-screenshot-region',
      method: 'screenshot.capture_region',
      params: {
        x: '12',
        y: '34',
        width: 0,
        height: '56',
        scale: '2',
      },
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.deepEqual(sendMessageCalls, [
    {
      tabId: 81,
      message: { type: 'bridge.ping' },
    },
  ]);
  assert.deepEqual(attachCalls, [{ target: { tabId: 81 }, version: '1.3' }]);
  assert.deepEqual(sendCommandCalls, [
    {
      target: { tabId: 81 },
      method: 'Page.captureScreenshot',
      params: {
        format: 'png',
        clip: {
          x: 12,
          y: 34,
          width: 1,
          height: 56,
          scale: 2,
        },
        captureBeyondViewport: false,
      },
    },
  ]);
  assert.equal(response.meta?.method, 'screenshot.capture_region');
  assert.deepEqual(response.result, {
    rect: {
      x: 12,
      y: 34,
      width: 1,
      height: 56,
      scale: 2,
    },
    image: 'data:image/png;base64,region-image-data',
  });
});

test('background dispatch captures full-page screenshots after reading page dimensions', async () => {
  /** @type {Array<{ tabId: number, message: Record<string, unknown> }>} */
  const sendMessageCalls = [];
  /** @type {Array<{ target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown> }>} */
  const sendCommandCalls = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-screenshot-full-page',
    chromeOverrides: {
      tabs: {
        /** @param {number} tabId @param {Record<string, unknown>} message */
        async sendMessage(tabId, message) {
          sendMessageCalls.push({ tabId, message });
          if (message.type === 'bridge.execute') {
            return {
              scrollWidth: 20_000,
              scrollHeight: 5_000,
              devicePixelRatio: 1.5,
            };
          }
          return { ok: true };
        },
      },
      debugger: {
        /** @param {chrome.debugger.Debuggee} _target @param {string} method @param {Record<string, unknown>} params */
        async sendCommand(_target, method, params) {
          sendCommandCalls.push({ target: { tabId: 81 }, method, params });
          return { data: 'full-page-image-data' };
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-screenshot-full-page',
      method: 'screenshot.capture_full_page',
      params: {},
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.deepEqual(sendMessageCalls, [
    {
      tabId: 81,
      message: { type: 'bridge.ping' },
    },
    {
      tabId: 81,
      message: { type: 'bridge.ping' },
    },
    {
      tabId: 81,
      message: {
        type: 'bridge.execute',
        method: 'screenshot.capture_full_page',
        params: {},
      },
    },
  ]);
  assert.deepEqual(sendCommandCalls, [
    {
      target: { tabId: 81 },
      method: 'Page.captureScreenshot',
      params: {
        format: 'png',
        clip: {
          x: 0,
          y: 0,
          width: 16_384,
          height: 5_000,
          scale: 1.5,
        },
        captureBeyondViewport: true,
      },
    },
  ]);
  assert.equal(response.meta?.method, 'screenshot.capture_full_page');
  assert.deepEqual(response.result, {
    rect: {
      x: 0,
      y: 0,
      width: 16_384,
      height: 5_000,
      scale: 1.5,
    },
    image: 'data:image/png;base64,full-page-image-data',
  });
});

test('background dispatch retries stale element screenshots before capturing', async () => {
  /** @type {Array<{ tabId: number, message: Record<string, unknown> }>} */
  const sendMessageCalls = [];
  let elementAttemptCount = 0;
  /** @type {Array<{ target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown> }>} */
  const sendCommandCalls = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-screenshot-element-retry',
    chromeOverrides: {
      tabs: {
        /** @param {number} tabId @param {Record<string, unknown>} message */
        async sendMessage(tabId, message) {
          sendMessageCalls.push({ tabId, message });
          if (message.type === 'bridge.execute') {
            elementAttemptCount += 1;
            if (elementAttemptCount === 1) {
              throw new Error('stale element reference');
            }
            return {
              x: -5,
              y: '8',
              width: '120',
              height: 45,
              scale: '2',
            };
          }
          return { ok: true };
        },
      },
      debugger: {
        /** @param {chrome.debugger.Debuggee} target @param {string} method @param {Record<string, unknown>} params */
        async sendCommand(target, method, params) {
          sendCommandCalls.push({ target, method, params });
          return { data: 'element-image-data' };
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-screenshot-element',
      method: 'screenshot.capture_element',
      params: {
        selector: '#hero',
      },
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.equal(elementAttemptCount, 2);
  assert.deepEqual(sendMessageCalls, [
    {
      tabId: 81,
      message: { type: 'bridge.ping' },
    },
    {
      tabId: 81,
      message: { type: 'bridge.ping' },
    },
    {
      tabId: 81,
      message: {
        type: 'bridge.execute',
        method: 'screenshot.capture_element',
        params: {
          selector: '#hero',
        },
      },
    },
    {
      tabId: 81,
      message: {
        type: 'bridge.execute',
        method: 'screenshot.capture_element',
        params: {
          selector: '#hero',
        },
      },
    },
  ]);
  assert.deepEqual(sendCommandCalls, [
    {
      target: { tabId: 81 },
      method: 'Page.captureScreenshot',
      params: {
        format: 'png',
        clip: {
          x: 0,
          y: 8,
          width: 120,
          height: 45,
          scale: 2,
        },
        captureBeyondViewport: false,
      },
    },
  ]);
  assert.equal(response.meta?.method, 'screenshot.capture_element');
  assert.deepEqual(response.result, {
    rect: {
      x: 0,
      y: 8,
      width: 120,
      height: 45,
      scale: 2,
    },
    image: 'data:image/png;base64,element-image-data',
  });
});

test('background dispatch surfaces empty CDP screenshot payloads', async () => {
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-screenshot-empty-data',
    chromeOverrides: {
      tabs: {
        async sendMessage() {
          return { ok: true };
        },
      },
      debugger: {
        async sendCommand() {
          return {};
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-screenshot-empty-data',
      method: 'screenshot.capture_region',
      params: {
        x: 1,
        y: 2,
        width: 3,
        height: 4,
      },
    })
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INTERNAL_ERROR);
  assert.equal(response.error.message, 'CDP Page.captureScreenshot returned empty data.');
  assert.equal(response.meta?.method, 'screenshot.capture_region');
});

test('background dispatch waits for the active tab to finish loading', async () => {
  /** @type {number[]} */
  const getCalls = [];
  const activeTab = createDispatchActiveTab({
    id: 91,
    title: 'Loading page',
    url: 'https://example.com/wait',
    status: 'loading',
  });
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-wait-for-load',
    activeTab,
    chromeOverrides: {
      tabs: {
        /** @param {number} tabId */
        async get(tabId) {
          getCalls.push(tabId);
          return { ...activeTab };
        },
      },
    },
  });

  const responsePromise = loaded.dispatch(
    createRequest({
      id: 'dispatch-wait-for-load',
      method: 'page.wait_for_load_state',
      params: {
        timeoutMs: 2000,
      },
    })
  );

  await waitForListenerCount(() => loaded.chrome.tabs.onUpdated.listeners.length, 2);
  loaded.chrome.tabs.onUpdated.dispatch(
    91,
    { status: 'complete' },
    {
      id: 91,
      windowId: 7,
      title: 'Loaded page',
      url: 'https://example.com/wait',
      status: 'complete',
    }
  );
  const response = await responsePromise;

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.equal(getCalls.length >= 1, true);
  assert.equal(
    getCalls.every((tabId) => tabId === 91),
    true
  );
  assert.equal(loaded.chrome.tabs.onUpdated.listeners.length, 1);
  assert.equal(loaded.chrome.tabs.onRemoved.listeners.length, 1);
  assert.equal(response.meta?.method, 'page.wait_for_load_state');
  assert.deepEqual(response.result, {
    method: 'page.wait_for_load_state',
    tabId: 91,
    windowId: 7,
    title: 'Loaded page',
    url: 'https://example.com/wait',
    status: 'complete',
  });
});

test('background dispatch reports TAB_MISMATCH when a waited-on tab closes', async () => {
  const activeTab = createDispatchActiveTab({
    id: 92,
    title: 'Closing page',
    url: 'https://example.com/closing',
    status: 'loading',
  });
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-wait-for-load-error',
    activeTab,
    chromeOverrides: {
      tabs: {
        /** @param {number} tabId */
        async get(tabId) {
          assert.equal(tabId, 92);
          return { ...activeTab };
        },
      },
    },
  });

  const responsePromise = loaded.dispatch(
    createRequest({
      id: 'dispatch-wait-for-load-error',
      method: 'page.wait_for_load_state',
      params: {
        timeoutMs: 2000,
      },
    })
  );

  await waitForListenerCount(() => loaded.chrome.tabs.onRemoved.listeners.length, 2);
  loaded.chrome.tabs.onRemoved.dispatch(92, { windowId: 7, isWindowClosing: false });
  const response = await responsePromise;

  assert.equal(loaded.chrome.tabs.onUpdated.listeners.length, 1);
  assert.equal(loaded.chrome.tabs.onRemoved.listeners.length, 1);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.TAB_MISMATCH);
  assert.equal(response.error.message, ERROR_CODES.TAB_MISMATCH);
  assert.equal(response.meta?.method, 'page.wait_for_load_state');
});

test('background dispatch reports INTERNAL_ERROR when waiting for a load state times out', async () => {
  const activeTab = createDispatchActiveTab({
    id: 93,
    title: 'Slow page',
    url: 'https://example.com/slow',
    status: 'loading',
  });
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-wait-for-load-timeout',
    activeTab,
    chromeOverrides: {
      tabs: {
        /** @param {number} tabId */
        async get(tabId) {
          assert.equal(tabId, 93);
          return { ...activeTab };
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-wait-for-load-timeout',
      method: 'page.wait_for_load_state',
      params: {
        timeoutMs: 50,
      },
    })
  );

  assert.equal(loaded.chrome.tabs.onUpdated.listeners.length, 1);
  assert.equal(loaded.chrome.tabs.onRemoved.listeners.length, 1);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INTERNAL_ERROR);
  assert.equal(
    response.error.message,
    'Timed out waiting for tab 93 to finish loading after 500ms.'
  );
  assert.equal(response.meta?.method, 'page.wait_for_load_state');
});

for (const scenario of [
  {
    method: /** @type {BridgeMethod} */ ('cdp.get_document'),
    params: {},
    command: 'DOM.getDocument',
    commandParams: {
      depth: 2,
      pierce: false,
    },
    result: {
      root: {
        nodeId: 1,
        nodeName: 'HTML',
      },
    },
  },
  {
    method: /** @type {BridgeMethod} */ ('cdp.get_dom_snapshot'),
    params: {
      computedStyles: ['display', 'color'],
    },
    command: 'DOMSnapshot.captureSnapshot',
    commandParams: {
      computedStyles: ['display', 'color'],
    },
    result: {
      documents: [{ nodes: { nodeName: [1] } }],
      strings: ['HTML'],
    },
  },
  {
    method: /** @type {BridgeMethod} */ ('cdp.get_box_model'),
    params: {
      nodeId: 42,
    },
    command: 'DOM.getBoxModel',
    commandParams: {
      nodeId: 42,
    },
    result: {
      model: {
        width: 120,
        height: 60,
      },
    },
  },
  {
    method: /** @type {BridgeMethod} */ ('cdp.get_computed_styles_for_node'),
    params: {
      nodeId: 42,
    },
    command: 'CSS.getComputedStyleForNode',
    commandParams: {
      nodeId: 42,
    },
    result: {
      computedStyle: [{ name: 'display', value: 'block' }],
    },
  },
]) {
  test(`background dispatch handles ${scenario.method} through the CDP request path`, async () => {
    /** @type {Array<{ target: chrome.debugger.Debuggee, version: string }>} */
    const attachCalls = [];
    /** @type {Array<{ target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown> }>} */
    const sendCommandCalls = [];
    const { loaded } = await loadEnabledDispatchBackground({
      queryLabel: `test-background-dispatch-${scenario.method}`,
      chromeOverrides: {
        debugger: {
          /** @param {chrome.debugger.Debuggee} target @param {string} version */
          async attach(target, version) {
            attachCalls.push({ target, version });
          },
          /** @param {chrome.debugger.Debuggee} target @param {string} method @param {Record<string, unknown>} params */
          async sendCommand(target, method, params) {
            sendCommandCalls.push({ target, method, params });
            return scenario.result;
          },
        },
      },
    });

    const response = await loaded.dispatch(
      createRequest({
        id: `dispatch-${scenario.method}`,
        method: scenario.method,
        params: scenario.params,
      })
    );

    if (!response.ok) {
      assert.fail(response.error.message);
    }
    assert.deepEqual(attachCalls, [{ target: { tabId: 81 }, version: '1.3' }]);
    assert.deepEqual(sendCommandCalls, [
      {
        target: { tabId: 81 },
        method: scenario.command,
        params: scenario.commandParams,
      },
    ]);
    assert.equal(response.meta?.method, scenario.method);
    assert.deepEqual(response.result, scenario.result);
  });
}

for (const method of [
  /** @type {BridgeMethod} */ ('cdp.get_box_model'),
  /** @type {BridgeMethod} */ ('cdp.get_computed_styles_for_node'),
]) {
  test(`background dispatch rejects ${method} without a finite nodeId`, async () => {
    let sendCommandCalled = false;
    const { loaded } = await loadEnabledDispatchBackground({
      queryLabel: `test-background-dispatch-${method}-invalid-node`,
      chromeOverrides: {
        debugger: {
          async sendCommand() {
            sendCommandCalled = true;
            return {};
          },
        },
      },
    });

    const response = await loaded.dispatch(
      createRequest({
        id: `dispatch-${method}-invalid-node`,
        method,
        params: {
          nodeId: 'not-a-number',
        },
      })
    );

    assert.equal(sendCommandCalled, false);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, ERROR_CODES.INVALID_REQUEST);
    assert.equal(response.error.message, 'nodeId must be a finite number.');
    assert.equal(response.meta?.method, method);
  });
}

test('background dispatch surfaces CDP debugger-not-attached failures', async () => {
  /** @type {Array<{ target: chrome.debugger.Debuggee, version: string }>} */
  const attachCalls = [];
  /** @type {Array<{ target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown> }>} */
  const sendCommandCalls = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-cdp-not-attached',
    chromeOverrides: {
      debugger: {
        /** @param {chrome.debugger.Debuggee} target @param {string} version */
        async attach(target, version) {
          attachCalls.push({ target, version });
        },
        /** @param {chrome.debugger.Debuggee} target @param {string} method @param {Record<string, unknown>} params */
        async sendCommand(target, method, params) {
          sendCommandCalls.push({ target, method, params });
          throw new Error('Debugger is not attached to the tab with id: 81.');
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-cdp-not-attached',
      method: 'cdp.get_document',
    })
  );

  assert.deepEqual(attachCalls, [{ target: { tabId: 81 }, version: '1.3' }]);
  assert.deepEqual(sendCommandCalls, [
    {
      target: { tabId: 81 },
      method: 'DOM.getDocument',
      params: {
        depth: 2,
        pierce: false,
      },
    },
  ]);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INTERNAL_ERROR);
  assert.equal(response.error.message, 'Debugger is not attached to the tab with id: 81.');
  assert.equal(response.meta?.method, 'cdp.get_document');
});

test('background dispatch returns INVALID_REQUEST for unhandled bridge methods', async () => {
  const loaded = await loadBackground({
    query: `test-background-dispatch-unhandled-${Date.now()}`,
  });

  const response = await loaded.dispatch(
    /** @type {BridgeRequest} */ (
      /** @type {unknown} */ ({
        id: 'dispatch-unhandled-method',
        method: 'not.a.real.method',
        params: {},
        meta: {},
      })
    )
  );

  assert.equal(response.ok, false);
  assert.equal(response.id, 'dispatch-unhandled-method');
  assert.equal(response.error.code, ERROR_CODES.INVALID_REQUEST);
  assert.equal(response.error.message, 'Unsupported method: not.a.real.method');
  assert.equal(response.meta?.method, 'not.a.real.method');
});

test('background dispatch triggers the access-request UI after a window-off denial', async () => {
  /** @type {Array<chrome.tabs.QueryInfo>} */
  const queryCalls = [];
  /** @type {Array<chrome.windows.CreateData>} */
  const popupCreateCalls = [];
  const chrome = createChromeFake({
    runtime: {
      /** @param {string} path */
      getURL(path) {
        return `chrome-extension://test-extension-id/${path}`;
      },
    },
    tabs: {
      /** @param {chrome.tabs.QueryInfo} [queryInfo] */
      async query(queryInfo = /** @type {chrome.tabs.QueryInfo} */ ({})) {
        queryCalls.push(queryInfo);
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [
            /** @type {chrome.tabs.Tab} */ ({
              id: 61,
              windowId: 9,
              active: true,
              title: 'Needs access',
              url: 'https://example.com/needs-access',
            }),
          ];
        }
        return [
          /** @type {chrome.tabs.Tab} */ ({
            id: 61,
            windowId: 9,
            active: true,
            title: 'Needs access',
            url: 'https://example.com/needs-access',
          }),
        ];
      },
      /** @param {number} tabId */
      async get(tabId) {
        return /** @type {chrome.tabs.Tab} */ ({
          id: tabId,
          windowId: 9,
          active: true,
          title: 'Needs access',
          url: 'https://example.com/needs-access',
        });
      },
    },
    windows: {
      /** @param {number} windowId */
      async get(windowId) {
        return {
          id: windowId,
          left: 100,
          top: 50,
          width: 1200,
        };
      },
      /** @param {chrome.windows.CreateData} createData */
      async create(createData = {}) {
        popupCreateCalls.push(createData);
        return {
          id: 91,
          ...createData,
        };
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-dispatch-access-retry-${Date.now()}`,
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-tabs-create-access-retry',
      method: 'tabs.create',
      params: {
        url: 'https://example.com/new',
      },
    })
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.ACCESS_DENIED);
  assert.equal(response.error.message, 'Browser Bridge is off for this window.');
  assert.equal(response.meta?.method, 'tabs.create');

  const state = loaded.module.getStateForTest();
  assert.equal(state.requestedAccessWindowId, 9);
  assert.equal(state.requestedAccessPopupWindowId, 91);
  assert.equal(
    queryCalls.filter((call) => call.active && call.lastFocusedWindow).length >= 2,
    true
  );
  assert.deepEqual(popupCreateCalls, [
    {
      url: 'chrome-extension://test-extension-id/packages/extension/ui/popup.html?tabId=61&windowed=1',
      type: 'popup',
      focused: true,
      width: 420,
      height: 320,
      left: 840,
      top: 122,
    },
  ]);
});

test('background dispatch rejects invalid native requests before method dispatch', async () => {
  const loaded = await loadBackground({
    query: `test-background-dispatch-invalid-${Date.now()}`,
  });
  const nativePort = loaded.module.getStateForTest().nativePort;

  const response = await new Promise(
    /** @param {(response: BridgeResponse) => void} resolve @param {(error: Error) => void} reject */
    (resolve, reject) => {
      if (!nativePort) {
        reject(new Error('Expected a native port for the background test harness.'));
        return;
      }

      const originalPostMessage = nativePort.postMessage.bind(nativePort);
      const timeoutId = setTimeout(() => {
        nativePort.postMessage = originalPostMessage;
        reject(new Error('No invalid-request response was posted.'));
      }, 50);

      /** @param {unknown} message */
      nativePort.postMessage = (message) => {
        if (message && typeof message === 'object' && 'id' in message && 'ok' in message) {
          clearTimeout(timeoutId);
          nativePort.postMessage = originalPostMessage;
          resolve(/** @type {BridgeResponse} */ (message));
          return;
        }
        originalPostMessage(message);
      };

      nativePort.onMessage.dispatch({
        id: 'dispatch-invalid-method',
        method: 'not.a.real.method',
        params: {},
        meta: {},
      });
    }
  );

  assert.equal(response.ok, false);
  assert.equal(response.id, 'dispatch-invalid-method');
  assert.equal(response.error.code, ERROR_CODES.INVALID_REQUEST);
  assert.match(response.error.message, /Unsupported method: not\.a\.real\.method/);
});
