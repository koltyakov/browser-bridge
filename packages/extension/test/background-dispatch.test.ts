import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createChromeFake,
  createStorageArea,
  type ChromeFakeOverrides,
  type FakeChromeEvent,
} from '../../../tests/_helpers/chromeFake.ts';
import { loadBackground } from '../../../tests/_helpers/loadBackground.ts';
import { createRequest, ERROR_CODES, PROTOCOL_VERSION } from '../../protocol/src/index.js';
import type { BridgeMethod, BridgeRequest, BridgeResponse } from '../../protocol/src/types.js';

type DebuggerAttachCall = {
  target: chrome.debugger.Debuggee;
  version: string;
};

type DebuggerSendCommandCall = {
  target: chrome.debugger.Debuggee;
  method: string;
  params?: object;
};

type AccessRequestState = {
  enabledWindow?: {
    windowId: number;
    title: string;
    enabledAt: number;
  };
  requestedAccessWindowId?: number | null;
  requestedAccessPopupWindowId?: number | null;
};

type LoadedDispatchBackground = Awaited<ReturnType<typeof loadBackground>>;

type ExecuteScriptCall = {
  target?: unknown;
  world?: unknown;
  args?: unknown[];
};

type TabMessageCall = {
  tabId: number;
  message: Record<string, unknown>;
};

type ChromeWithTabEvents = {
  tabs: {
    onUpdated: FakeChromeEvent;
    onDetached: FakeChromeEvent;
    onAttached: FakeChromeEvent;
    onRemoved: FakeChromeEvent;
  };
};

type HealthPingResult = {
  extension: string;
  extensionVersion: string;
  access: unknown;
  supported_versions: string[];
};

type RuntimeContextResult = {
  v: string;
  budgets: Record<string, unknown>;
  tips: unknown[];
  flow: string[];
};

type TabCreateCall = {
  url: string;
  active: boolean;
  windowId: number;
};

type NavigationUpdateCall = {
  tabId: number;
  properties: { url: string };
};

type NavigationScenario = {
  method: BridgeMethod;
  params: Record<string, unknown>;
  expectedUrl: string;
  expectedCalls: {
    update: NavigationUpdateCall[];
    reload: number[];
    goBack: number[];
    goForward: number[];
  };
};

function setEnabledWindow(loaded: LoadedDispatchBackground, windowId = 7): void {
  const state = loaded.module.getStateForTest() as AccessRequestState;
  state.enabledWindow = {
    windowId,
    title: 'Enabled Window',
    enabledAt: Date.now(),
  };
}

function getTabEvents(loaded: LoadedDispatchBackground): ChromeWithTabEvents['tabs'] {
  return (loaded.chrome as unknown as ChromeWithTabEvents).tabs;
}

function createDispatchActiveTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: 81,
    windowId: 7,
    active: true,
    title: 'Dispatch tab',
    url: 'https://example.com/dispatch',
    status: 'complete',
    ...overrides,
  } as chrome.tabs.Tab;
}

type LoadEnabledDispatchBackgroundOptions = {
  queryLabel: string;
  activeTab?: chrome.tabs.Tab;
  chromeOverrides?: ChromeFakeOverrides;
};

async function loadEnabledDispatchBackground({
  queryLabel,
  activeTab = createDispatchActiveTab(),
  chromeOverrides = {},
}: LoadEnabledDispatchBackgroundOptions): Promise<{
  loaded: LoadedDispatchBackground;
  activeTab: chrome.tabs.Tab;
}> {
  const {
    tabs: tabOverrides = {},
    windows: windowOverrides = {},
    debugger: debuggerOverrides = {},
    ...restChromeOverrides
  } = chromeOverrides;
  const debuggerSendCommand = debuggerOverrides.sendCommand;
  const chrome = createChromeFake({
    ...restChromeOverrides,
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
        if (queryInfo.active && queryInfo.windowId === activeTab.windowId) {
          return [{ ...activeTab }];
        }
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [];
        }
        return [];
      },
      async get(tabId: number) {
        assert.equal(tabId, activeTab.id);
        return { ...activeTab };
      },
      ...tabOverrides,
    },
    windows: {
      async get(windowId: number) {
        return { id: windowId };
      },
      ...windowOverrides,
    },
    debugger: {
      ...debuggerOverrides,
      async sendCommand(
        target: chrome.debugger.Debuggee,
        method: string,
        params?: Record<string, unknown>
      ) {
        if (method === 'Page.enable') return {};
        if (typeof debuggerSendCommand === 'function') {
          return debuggerSendCommand(target, method, params);
        }
        return {};
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `${queryLabel}-${Date.now()}-${Math.random()}`,
  });

  setEnabledWindow(loaded, activeTab.windowId);

  return { loaded, activeTab };
}

async function waitForListenerCount(getCount: () => number, expected: number): Promise<void> {
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
  const result = response.result as unknown as HealthPingResult;
  assert.equal(result.extension, 'ok');
  assert.equal(result.extensionVersion, '1.8.0');
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
  const result = response.result as unknown as RuntimeContextResult;
  assert.equal(typeof result.v, 'string');
  assert.deepEqual(Object.keys(result.budgets).sort(), ['deep', 'normal', 'quick']);
  assert.equal(Array.isArray(result.tips), true);
  assert.equal(result.tips.length > 0, true);
  assert.equal(Array.isArray(result.flow), true);
  assert.equal(result.flow[0], 'health.ping');
});

test('background dispatch lists tabs in the enabled window', async () => {
  const queries: chrome.tabs.QueryInfo[] = [];
  const chrome = createChromeFake({
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
        queries.push(queryInfo);
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [];
        }
        return [
          {
            id: 11,
            windowId: 7,
            active: true,
            title: 'Example',
            url: 'https://example.com/path',
          } as chrome.tabs.Tab,
          {
            id: undefined,
            windowId: 7,
            active: false,
            title: 'Broken',
            url: 'https://example.com/broken',
          } as chrome.tabs.Tab,
          {
            id: 12,
            windowId: 7,
            active: false,
            title: 'Missing URL',
          } as chrome.tabs.Tab,
        ];
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-dispatch-tabs-list-${Date.now()}`,
  });

  setEnabledWindow(loaded);

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
  const createCalls: TabCreateCall[] = [];
  const chrome = createChromeFake({
    tabs: {
      async create(createProperties: TabCreateCall) {
        createCalls.push(createProperties);
        return {
          id: 21,
          windowId: createProperties.windowId,
          url: createProperties.url,
          title: 'New tab',
          status: 'complete',
        } as chrome.tabs.Tab;
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-dispatch-tabs-create-${Date.now()}`,
  });

  setEnabledWindow(loaded);

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
        return { id: 1 } as chrome.tabs.Tab;
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
  const removedTabIds: number[] = [];
  const chrome = createChromeFake({
    tabs: {
      async get(tabId: number) {
        return {
          id: tabId,
          windowId: 7,
          url: 'https://example.com/close-me',
        } as chrome.tabs.Tab;
      },
      async remove(tabId: number) {
        removedTabIds.push(tabId);
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-dispatch-tabs-close-${Date.now()}`,
  });

  setEnabledWindow(loaded);

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
        return { id: 21, windowId: 7 } as chrome.tabs.Tab;
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
      async get(tabId: number) {
        return {
          id: tabId,
          windowId: 8,
          url: 'https://example.com/outside',
        } as chrome.tabs.Tab;
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

  setEnabledWindow(loaded);

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

const navigationScenarios: NavigationScenario[] = [
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
];

for (const scenario of navigationScenarios) {
  test(`background dispatch handles ${scenario.method} inside the enabled window`, async () => {
    const updateCalls: NavigationUpdateCall[] = [];
    const reloadCalls: number[] = [];
    const goBackCalls: number[] = [];
    const goForwardCalls: number[] = [];
    const tab = {
      id: 31,
      windowId: 7,
      active: true,
      title: 'Current page',
      url: 'https://example.com/current',
      status: 'complete',
    } as chrome.tabs.Tab;
    const chrome = createChromeFake({
      tabs: {
        async query(queryInfo: chrome.tabs.QueryInfo = {}) {
          if (
            queryInfo.active &&
            (queryInfo.windowId === 7 || queryInfo.lastFocusedWindow === true)
          ) {
            return [tab];
          }
          return [];
        },
        async get(tabId: number) {
          assert.equal(tabId, 31);
          return { ...tab };
        },
        async update(tabId: number, properties: { url: string }) {
          updateCalls.push({ tabId, properties });
          if (typeof properties.url === 'string') {
            tab.url = properties.url;
          }
          return { ...tab };
        },
        async reload(tabId: number) {
          reloadCalls.push(tabId);
        },
        async goBack(tabId: number) {
          goBackCalls.push(tabId);
        },
        async goForward(tabId: number) {
          goForwardCalls.push(tabId);
        },
      },
      windows: {
        async get(windowId: number) {
          return { id: windowId };
        },
      },
    });
    const loaded = await loadBackground({
      chrome,
      query: `test-background-dispatch-${scenario.method}-${Date.now()}`,
    });

    setEnabledWindow(loaded);

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

test('background dispatch reports TIMEOUT when navigation does not finish loading', async () => {
  const reloadCalls: number[] = [];
  const activeTab = createDispatchActiveTab({
    id: 32,
    status: 'loading',
  });
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-navigation-timeout',
    activeTab,
    chromeOverrides: {
      tabs: {
        async reload(tabId: number) {
          reloadCalls.push(tabId);
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-navigation-timeout',
      method: 'navigation.reload',
      params: { timeoutMs: 50 },
    })
  );

  assert.deepEqual(reloadCalls, [32]);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.TIMEOUT);
  assert.equal(
    response.error.message,
    'Timed out waiting for tab 32 to finish loading after 500ms.'
  );
  assert.equal(response.meta?.method, 'navigation.reload');
});

test('background dispatch returns sensitive storage values exactly and logs warning metadata only', async () => {
  const secret = 'line 1\n\u2603 {"token":"value"}';
  const { loaded, activeTab } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-sensitive-read',
    chromeOverrides: {
      tabs: {
        async sendMessage(_tabId: number, message: Record<string, unknown>) {
          if (message.type === 'bridge.ping') return { ok: true };
          if (message.type === 'bridge.execute' && message.method === 'sensitive.read') {
            return { source: 'local_storage', value: secret, exact: true };
          }
          return {};
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-sensitive-read',
      method: 'sensitive.read',
      tabId: activeTab.id,
      params: { source: 'local_storage', key: 'private-token' },
      meta: { token_budget: 1 },
    })
  );

  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.deepEqual(response.result, { source: 'local_storage', value: secret, exact: true });
  assert.equal(response.meta.transport_bytes, undefined);
  const state = (
    loaded.module as { getStateForTest: () => { actionLog: unknown[] } }
  ).getStateForTest();
  const serializedLog = JSON.stringify(state.actionLog);
  assert.match(serializedLog, /Sensitive local storage read succeeded/);
  assert.doesNotMatch(serializedLog, /private-token|line 1|"token"/);
});

test('background dispatch routes page.get_state through the tab-bound content script path', async () => {
  const sendMessageCalls: TabMessageCall[] = [];
  const executeScriptCalls: ExecuteScriptCall[] = [];
  const activeTab = {
    id: 41,
    windowId: 7,
    active: true,
    title: 'Stateful page',
    url: 'https://example.com/app',
  } as chrome.tabs.Tab;
  let pingAttempts = 0;
  const chrome = createChromeFake({
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
        if (queryInfo.active && queryInfo.windowId === 7) {
          return [activeTab];
        }
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [];
        }
        return [];
      },
      async sendMessage(tabId: number, message: Record<string, unknown>) {
        sendMessageCalls.push({ tabId, message });
        if (message.type === 'bridge.ping') {
          pingAttempts += 1;
          if (pingAttempts === 1) {
            throw new Error('Could not establish connection. Receiving end does not exist.');
          }
          return { ok: true };
        }
        return {
          url: activeTab.url,
          title: activeTab.title,
          ready: true,
        };
      },
    },
    windows: {
      async get(windowId: number) {
        return { id: windowId };
      },
    },
    scripting: {
      async executeScript(injection: ExecuteScriptCall) {
        executeScriptCalls.push(injection);
        return [];
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-dispatch-page-state-${Date.now()}`,
  });

  setEnabledWindow(loaded);

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
    dialog: { status: 'unknown', observable: false },
  });
  assert.deepEqual(executeScriptCalls, [
    {
      target: { tabId: 41 },
      files: [
        'packages/extension/src/content-script-helpers.js',
        'packages/extension/src/content-element-registry.js',
        'packages/extension/src/content-dom-query.js',
        'packages/extension/src/content-input.js',
        'packages/extension/src/content-patch.js',
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

test('background dispatch routes executionMode=cdp input without activating the tab', async () => {
  const commands: DebuggerSendCommandCall[] = [];
  const messages: TabMessageCall[] = [];
  const tabUpdates: Array<{ tabId: number; properties: Record<string, unknown> }> = [];
  const activeTab = createDispatchActiveTab({ id: 42, active: false });
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-cdp-input',
    activeTab,
    chromeOverrides: {
      tabs: {
        async sendMessage(tabId: number, message: Record<string, unknown>) {
          messages.push({ tabId, message });
          if (message.type === 'bridge.ping') return { ok: true };
          return {
            elementRef: 'el_native',
            point: { x: 25, y: 35 },
            resolution: {
              strategy: 'selector-first',
              candidateCount: 1,
              evaluatedCount: 1,
              scrolled: false,
              hitTest: 'target',
              recovered: false,
            },
          };
        },
        async update(tabId: number, properties: Record<string, unknown>) {
          tabUpdates.push({ tabId, properties });
          return { ...activeTab, ...properties };
        },
      },
      debugger: {
        async sendCommand(target: chrome.debugger.Debuggee, method: string, params?: object) {
          commands.push({ target, method, params });
          return {};
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-cdp-click',
      method: 'input.click',
      tabId: 42,
      params: { target: { selector: '#save' }, executionMode: 'cdp' },
    })
  );

  if (!response.ok) assert.fail(response.error.message);
  assert.equal(response.meta.debugger_backed, true);
  assert.equal((response.result as { clicked?: unknown }).clicked, true);
  assert.equal(
    messages.some((call) => call.message.method === 'input.resolve_native'),
    true
  );
  assert.deepEqual(
    commands.map((call) => call.method),
    ['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent']
  );
  assert.deepEqual(tabUpdates, []);
});

test('background dispatch reinjects and retries when content script receiver disappears', async () => {
  const sendMessageCalls: TabMessageCall[] = [];
  const executeScriptCalls: ExecuteScriptCall[] = [];
  const activeTab = {
    id: 42,
    windowId: 7,
    active: true,
    title: 'Reloading page',
    url: 'https://example.com/reloading',
  } as chrome.tabs.Tab;
  let executeAttempts = 0;
  const chrome = createChromeFake({
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
        if (queryInfo.active && queryInfo.windowId === 7) {
          return [activeTab];
        }
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [];
        }
        return [];
      },
      async sendMessage(tabId: number, message: Record<string, unknown>) {
        sendMessageCalls.push({ tabId, message });
        if (message.type === 'bridge.ping') {
          return { ok: true };
        }
        executeAttempts += 1;
        if (executeAttempts === 1) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        return {
          url: activeTab.url,
          title: activeTab.title,
          ready: true,
        };
      },
    },
    windows: {
      async get(windowId: number) {
        return { id: windowId };
      },
    },
    scripting: {
      async executeScript(injection: ExecuteScriptCall) {
        executeScriptCalls.push(injection);
        return [];
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-dispatch-content-script-retry-${Date.now()}`,
  });

  setEnabledWindow(loaded);

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-page-state-retry',
      method: 'page.get_state',
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.deepEqual(response.result, {
    url: 'https://example.com/reloading',
    title: 'Reloading page',
    ready: true,
    dialog: { status: 'unknown', observable: false },
  });
  assert.deepEqual(executeScriptCalls, [
    {
      target: { tabId: 42 },
      files: [
        'packages/extension/src/content-script-helpers.js',
        'packages/extension/src/content-element-registry.js',
        'packages/extension/src/content-dom-query.js',
        'packages/extension/src/content-input.js',
        'packages/extension/src/content-patch.js',
        'packages/extension/src/content-script.js',
      ],
    },
  ]);
  assert.deepEqual(sendMessageCalls, [
    {
      tabId: 42,
      message: { type: 'bridge.ping' },
    },
    {
      tabId: 42,
      message: {
        type: 'bridge.execute',
        method: 'page.get_state',
        params: {},
      },
    },
    {
      tabId: 42,
      message: {
        type: 'bridge.execute',
        method: 'page.get_state',
        params: {},
      },
    },
  ]);
});

test('background dispatch rejects tab-bound requests for tabs outside the enabled window', async () => {
  const getCalls: number[] = [];
  const queryCalls: chrome.tabs.QueryInfo[] = [];
  let sendMessageCalled = false;
  let executeScriptCalled = false;
  const chrome = createChromeFake({
    tabs: {
      async get(tabId: number) {
        getCalls.push(tabId);
        return {
          id: tabId,
          windowId: 8,
          title: 'Outside tab',
          url: 'https://example.com/outside',
        } as chrome.tabs.Tab;
      },
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
        queryCalls.push(queryInfo);
        if (queryInfo.active && queryInfo.windowId === 7) {
          return [
            {
              id: 41,
              windowId: 7,
              active: true,
              title: 'Inside tab',
              url: 'https://example.com/inside',
            } as chrome.tabs.Tab,
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
      async get(windowId: number) {
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

  setEnabledWindow(loaded);

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
  assert.equal(response.error.message, 'Tab does not belong to the enabled window');
  assert.equal(response.meta?.method, 'page.get_state');
});

test('background dispatch treats console levels as minimum severity', async () => {
  const executeScriptCalls: ExecuteScriptCall[] = [];
  const activeTab = {
    id: 71,
    windowId: 7,
    active: true,
    title: 'Console page',
    url: 'https://example.com/console',
  } as chrome.tabs.Tab;
  const chrome = createChromeFake({
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
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
      async get(windowId: number) {
        return { id: windowId };
      },
    },
    scripting: {
      async executeScript(injection: ExecuteScriptCall) {
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

  setEnabledWindow(loaded);

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-page-console',
      method: 'page.get_console',
      params: {
        level: 'warn',
        limit: 10,
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
      { level: 'error', args: ['boom'], ts: 2 },
      { level: 'exception', args: ['TypeError'], ts: 3 },
      { level: 'rejection', args: ['Promise rejected'], ts: 4 },
    ],
    count: 3,
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
        args: [executeScriptCalls[0].args?.[0]],
      },
      {
        target: { tabId: 71 },
        world: 'MAIN',
        args: [true, executeScriptCalls[0].args?.[0]],
      },
    ]
  );
});

test('background dispatch surfaces console buffer read failures', async () => {
  const executeScriptCalls: ExecuteScriptCall[] = [];
  const activeTab = {
    id: 72,
    windowId: 7,
    active: true,
    title: 'Console failure page',
    url: 'https://example.com/console-failure',
  } as chrome.tabs.Tab;
  const chrome = createChromeFake({
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
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
      async get(windowId: number) {
        return { id: windowId };
      },
    },
    scripting: {
      async executeScript(injection: ExecuteScriptCall) {
        executeScriptCalls.push(injection);
        if (typeof injection.args?.[0] === 'boolean') {
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

  setEnabledWindow(loaded);

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
        args: [executeScriptCalls[0].args?.[0]],
      },
      {
        target: { tabId: 72 },
        world: 'MAIN',
        args: [false, executeScriptCalls[0].args?.[0]],
      },
    ]
  );
});

test('background dispatch returns filtered network buffer entries', async () => {
  const executeScriptCalls: ExecuteScriptCall[] = [];
  const activeTab = {
    id: 73,
    windowId: 7,
    active: true,
    title: 'Network page',
    url: 'https://example.com/network',
  } as chrome.tabs.Tab;
  const chrome = createChromeFake({
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
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
      async get(windowId: number) {
        return { id: windowId };
      },
    },
    scripting: {
      async executeScript(injection: ExecuteScriptCall) {
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

  setEnabledWindow(loaded);

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
    filteredTotal: 2,
    dropped: 2,
    abandoned: 0,
    source: 'fetch-xhr',
    capture: null,
    armed: true,
    armedDuringCapture: true,
    captureState: 'instrumented',
    startedAt: null,
    inflight: 0,
    ownershipHeld: false,
    truncated: true,
    truncation: { reason: 'limit', limit: 1, omitted: 1 },
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
        args: [executeScriptCalls[0].args?.[0]],
      },
      {
        target: { tabId: 73 },
        world: 'MAIN',
        args: [true, executeScriptCalls[0].args?.[0]],
      },
    ]
  );
});

test('background dispatch surfaces network buffer read failures', async () => {
  const executeScriptCalls: ExecuteScriptCall[] = [];
  const activeTab = {
    id: 74,
    windowId: 7,
    active: true,
    title: 'Network failure page',
    url: 'https://example.com/network-failure',
  } as chrome.tabs.Tab;
  const chrome = createChromeFake({
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
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
      async get(windowId: number) {
        return { id: windowId };
      },
    },
    scripting: {
      async executeScript(injection: ExecuteScriptCall) {
        executeScriptCalls.push(injection);
        if (typeof injection.args?.[0] === 'boolean') {
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

  setEnabledWindow(loaded);

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
        args: [executeScriptCalls[0].args?.[0]],
      },
      {
        target: { tabId: 74 },
        world: 'MAIN',
        args: [false, executeScriptCalls[0].args?.[0]],
      },
    ]
  );
});

test('background dispatch wires explicit all-resource CDP network capture and dynamic debugger metadata', async () => {
  const commands: string[] = [];
  const detachCalls: chrome.debugger.Debuggee[] = [];
  const { loaded, activeTab } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-cdp-network',
    chromeOverrides: {
      debugger: {
        async sendCommand(_target: chrome.debugger.Debuggee, method: string) {
          commands.push(method);
          return {};
        },
        async detach(target: chrome.debugger.Debuggee) {
          detachCalls.push(target);
        },
      },
    },
  });

  const started = await loaded.dispatch(
    createRequest({
      id: 'dispatch-cdp-network-start',
      method: 'page.get_network',
      params: { source: 'cdp', capture: 'start' },
    })
  );
  assert.equal(started.ok, true);
  assert.equal(started.meta.debugger_backed, true);

  const debuggerEvents = (loaded.chrome as unknown as { debugger: { onEvent: FakeChromeEvent } })
    .debugger.onEvent;
  debuggerEvents.dispatch({ tabId: activeTab.id }, 'Network.requestWillBeSent', {
    requestId: 'resource-1',
    type: 'Stylesheet',
    timestamp: 1,
    wallTime: 1_700_000_000,
    request: {
      url: 'https://example.com/app.css',
      method: 'GET',
      headers: { Authorization: 'secret' },
    },
  });
  debuggerEvents.dispatch({ tabId: activeTab.id }, 'Network.responseReceived', {
    requestId: 'resource-1',
    type: 'Stylesheet',
    response: { status: 200, mimeType: 'text/css', protocol: 'h2' },
  });
  debuggerEvents.dispatch({ tabId: activeTab.id }, 'Network.loadingFinished', {
    requestId: 'resource-1',
    timestamp: 1.02,
  });

  const read = await loaded.dispatch(
    createRequest({
      id: 'dispatch-cdp-network-read',
      method: 'page.get_network',
      params: { source: 'cdp', capture: 'read' },
    })
  );
  assert.equal(read.ok, true);
  if (read.ok) {
    const result = read.result as { entries: Array<Record<string, unknown>>; armed: boolean };
    assert.equal(result.armed, true);
    assert.equal(result.entries[0]?.resourceType, 'Stylesheet');
    assert.doesNotMatch(JSON.stringify(result), /Authorization|secret/);
  }

  const stopped = await loaded.dispatch(
    createRequest({
      id: 'dispatch-cdp-network-stop',
      method: 'page.get_network',
      params: { source: 'cdp', capture: 'stop' },
    })
  );
  assert.equal(stopped.ok, true);
  assert.equal(stopped.meta.debugger_backed, true);
  assert.equal(commands.includes('Network.enable'), true);
  assert.equal(commands.includes('Network.disable'), true);
  assert.deepEqual(detachCalls, [{ tabId: activeTab.id }]);

  const unarmed = await loaded.dispatch(
    createRequest({
      id: 'dispatch-cdp-network-unarmed',
      method: 'page.get_network',
      params: { source: 'cdp', capture: 'read' },
    })
  );
  assert.equal(unarmed.ok, true);
  assert.equal(unarmed.meta.debugger_backed, false);
});

test('window bridge teardown clears interception rules and their debugger hold', async () => {
  const detachCalls: chrome.debugger.Debuggee[] = [];
  const activeTab = createDispatchActiveTab();
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-intercept-window-cleanup',
    activeTab,
    chromeOverrides: {
      tabs: {
        async query(queryInfo: chrome.tabs.QueryInfo = {}) {
          if (queryInfo.active) return [{ ...activeTab }];
          if (queryInfo.windowId === activeTab.windowId) {
            return [{ ...activeTab, url: 'chrome://settings' }];
          }
          return [];
        },
      },
      debugger: {
        async detach(target: chrome.debugger.Debuggee) {
          detachCalls.push(target);
        },
      },
    },
  });

  const invalid = await loaded.dispatch({
    id: 'dispatch-intercept-invalid',
    method: 'network.intercept.add',
    params: { urlPattern: '*', action: 'redirect' },
  } as unknown as BridgeRequest);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, ERROR_CODES.INVALID_REQUEST);

  const added = await loaded.dispatch(
    createRequest({
      id: 'dispatch-intercept-add',
      method: 'network.intercept.add',
      params: { urlPattern: '*api*' },
    })
  );
  assert.equal(added.ok, true);
  const captureStarted = await loaded.dispatch(
    createRequest({
      id: 'dispatch-window-cdp-network-start',
      method: 'page.get_network',
      params: { source: 'cdp', capture: 'start' },
    })
  );
  assert.equal(captureStarted.ok, true);
  if (added.ok) {
    assert.equal((added.result as { action: string }).action, 'continue');
  }

  const clearWindowBridgeState = loaded.module.clearWindowBridgeState;
  assert.equal(typeof clearWindowBridgeState, 'function');
  await (clearWindowBridgeState as (windowId: number) => Promise<void>)(activeTab.windowId);

  const listed = await loaded.dispatch(
    createRequest({
      id: 'dispatch-intercept-list-after-cleanup',
      method: 'network.intercept.list',
    })
  );
  assert.equal(listed.ok, true);
  if (listed.ok) {
    assert.deepEqual(listed.result, { rules: [] });
  }
  assert.deepEqual(detachCalls, [{ tabId: activeTab.id }]);
});

test('moving a tab out of the enabled window clears dialog, Fetch, debugger, and tab state before valid re-entry', async () => {
  const detachCalls: chrome.debugger.Debuggee[] = [];
  const activeTab = createDispatchActiveTab();
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-tab-move-cleanup',
    activeTab,
    chromeOverrides: {
      tabs: {
        async sendMessage(_tabId: number, message: Record<string, unknown>) {
          if (message.type === 'bridge.ping') return { ok: true };
          if (message.method === 'patch.list') return { patches: [] };
          if (message.method === 'page.get_state') {
            return {
              url: activeTab.url,
              title: activeTab.title,
              readyState: 'complete',
            };
          }
          return { ok: true };
        },
      },
      debugger: {
        async detach(target: chrome.debugger.Debuggee) {
          detachCalls.push(target);
        },
      },
    },
  });

  const added = await loaded.dispatch(
    createRequest({
      id: 'dispatch-move-intercept-add',
      method: 'network.intercept.add',
      params: { urlPattern: '*api*' },
    })
  );
  assert.equal(added.ok, true);
  const captureStarted = await loaded.dispatch(
    createRequest({
      id: 'dispatch-move-cdp-network-start',
      method: 'page.get_network',
      params: { source: 'cdp', capture: 'start' },
    })
  );
  assert.equal(captureStarted.ok, true);
  const debuggerEvents = (loaded.chrome as unknown as { debugger: { onEvent: FakeChromeEvent } })
    .debugger.onEvent;
  debuggerEvents.dispatch({ tabId: activeTab.id }, 'Page.javascriptDialogOpening', {
    type: 'alert',
    message: 'private dialog text',
  });

  const tabEvents = getTabEvents(loaded);
  tabEvents.onDetached.dispatch(activeTab.id, { oldWindowId: 7, oldPosition: 0 });
  activeTab.windowId = 8;
  tabEvents.onAttached.dispatch(activeTab.id, { newWindowId: 8, newPosition: 0 });
  await waitForListenerCount(() => detachCalls.length, 1);

  tabEvents.onDetached.dispatch(activeTab.id, { oldWindowId: 8, oldPosition: 0 });
  activeTab.windowId = 7;
  tabEvents.onAttached.dispatch(activeTab.id, { newWindowId: 7, newPosition: 0 });

  const listed = await loaded.dispatch(
    createRequest({ id: 'dispatch-move-intercept-list', method: 'network.intercept.list' })
  );
  assert.equal(listed.ok, true);
  if (listed.ok) assert.deepEqual(listed.result, { rules: [] });

  const captureAfterMove = await loaded.dispatch(
    createRequest({
      id: 'dispatch-move-cdp-network-read',
      method: 'page.get_network',
      params: { source: 'cdp', capture: 'read' },
    })
  );
  assert.equal(captureAfterMove.ok, true);
  if (captureAfterMove.ok) {
    assert.equal((captureAfterMove.result as { armed: boolean }).armed, false);
  }

  const pageState = await loaded.dispatch(
    createRequest({ id: 'dispatch-move-page-state', method: 'page.get_state' })
  );
  assert.equal(pageState.ok, true);
  if (pageState.ok) {
    assert.deepEqual((pageState.result as Record<string, unknown>).dialog, {
      status: 'unknown',
      observable: false,
    });
    assert.doesNotMatch(JSON.stringify(pageState.result), /private dialog text/);
  }
  assert.deepEqual(detachCalls, [{ tabId: activeTab.id }]);
});

test('background replies successfully when action-log persistence fails', async () => {
  const session = createStorageArea();
  const originalSet = session.set.bind(session);
  session.set = async (items) => {
    if ('actionLog' in items) throw new Error('action log storage unavailable');
    await originalSet(items);
  };
  const { loaded, activeTab } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-action-log-storage-failure',
    chromeOverrides: {
      storage: { session },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-activate-with-log-failure',
      method: 'tabs.activate',
      params: { tabId: activeTab.id },
    })
  );

  assert.equal(response.ok, true);
  assert.equal(response.id, 'dispatch-activate-with-log-failure');
});

test('background dispatch evaluates page expressions through the debugger', async () => {
  const attachCalls: DebuggerAttachCall[] = [];
  const sendCommandCalls: DebuggerSendCommandCall[] = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-page-evaluate',
    chromeOverrides: {
      debugger: {
        async attach(target: chrome.debugger.Debuggee, version: string) {
          attachCalls.push({ target, version });
        },
        async sendCommand(target: chrome.debugger.Debuggee, method: string, params?: object) {
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
  const sendCommandCalls: DebuggerSendCommandCall[] = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-accessibility-tree',
    chromeOverrides: {
      debugger: {
        async sendCommand(target: chrome.debugger.Debuggee, method: string, params?: object) {
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
  const result = response.result as {
    nodes: Array<Record<string, unknown>>;
    count: number;
    total: number;
    rawTotal: number;
    source: string;
    rootIds: string[];
    truncated: boolean;
    truncation: {
      reason: string;
      reasons: string[];
      maxDepth: number;
      partialTopology: boolean;
      missingChildCount: number;
    };
    continuationHint: string;
  };
  assert.equal(result.count, 2);
  assert.equal(result.total, 2);
  assert.equal(result.rawTotal, 2);
  assert.equal(result.source, 'cdp-accessibility');
  assert.deepEqual(result.rootIds, ['1']);
  assert.equal(result.truncated, true);
  assert.equal(result.truncation.reason, 'maxDepth');
  assert.deepEqual(result.truncation.reasons, ['maxDepth']);
  assert.equal(result.truncation.maxDepth, 3);
  assert.equal(result.truncation.partialTopology, true);
  assert.match(result.continuationHint, /larger maxDepth/);
  assert.equal(result.nodes[0]?.semanticInteractive, true);
  assert.equal(result.nodes[0]?.focusableAndEnabled, false);
  assert.deepEqual(result.nodes[0]?.childIds, ['2']);
});

test('background dispatch returns a uniquely selector-scoped accessibility tree', async () => {
  const calls: Array<{ method: string; params?: object }> = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-scoped-accessibility-tree',
    chromeOverrides: {
      debugger: {
        async sendCommand(_target: chrome.debugger.Debuggee, method: string, params?: object) {
          calls.push({ method, params });
          if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
          if (method === 'DOM.querySelectorAll') return { nodeIds: [7] };
          if (method === 'DOM.describeNode') return { node: { backendNodeId: 42 } };
          if (method === 'Accessibility.getPartialAXTree') {
            return {
              nodes: [
                { nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['dialog', 'side'] },
                {
                  nodeId: 'dialog',
                  backendDOMNodeId: 42,
                  role: { value: 'dialog' },
                  name: { value: 'Settings' },
                  childIds: ['save'],
                },
                { nodeId: 'save', role: { value: 'button' }, name: { value: 'Save' } },
                { nodeId: 'side', role: { value: 'navigation' }, name: { value: 'Unrelated' } },
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
      id: 'dispatch-scoped-accessibility-tree',
      method: 'dom.get_accessibility_tree',
      params: { selector: '#settings', maxDepth: 3, maxNodes: 20 },
    })
  );
  if (!response.ok) assert.fail(response.error.message);
  const result = response.result as { nodes: Array<{ nodeId: string }> };
  assert.deepEqual(
    result.nodes.map((node) => node.nodeId),
    ['root', 'dialog', 'save']
  );
  assert.deepEqual(calls, [
    { method: 'Accessibility.enable', params: {} },
    { method: 'DOM.getDocument', params: { depth: 0, pierce: false } },
    { method: 'DOM.querySelectorAll', params: { nodeId: 1, selector: '#settings' } },
    { method: 'DOM.describeNode', params: { nodeId: 7, depth: 0 } },
    {
      method: 'Accessibility.getPartialAXTree',
      params: { backendNodeId: 42, fetchRelatives: true },
    },
    { method: 'Accessibility.disable', params: {} },
  ]);
});

test('background dispatch rejects missing and ambiguous AX selectors', async () => {
  const methods: string[] = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-invalid-scoped-accessibility-tree',
    chromeOverrides: {
      debugger: {
        async sendCommand(_target: chrome.debugger.Debuggee, method: string, params?: object) {
          methods.push(method);
          if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
          if (method === 'DOM.querySelectorAll') {
            const selector = (params as { selector?: string })?.selector;
            return { nodeIds: selector === '.many' ? [2, 3] : [] };
          }
          return {};
        },
      },
    },
  });

  const missing = await loaded.dispatch(
    createRequest({
      id: 'dispatch-missing-ax-selector',
      method: 'dom.get_accessibility_tree',
      params: { selector: '.missing' },
    })
  );
  const ambiguous = await loaded.dispatch(
    createRequest({
      id: 'dispatch-ambiguous-ax-selector',
      method: 'dom.get_accessibility_tree',
      params: { selector: '.many' },
    })
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, ERROR_CODES.ELEMENT_NOT_FOUND);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error.code, ERROR_CODES.ELEMENT_AMBIGUOUS);
  assert.equal(methods.filter((method) => method === 'Accessibility.getPartialAXTree').length, 0);
  assert.equal(methods.filter((method) => method === 'Accessibility.disable').length, 2);
});

test('background dispatch surfaces accessibility tree failures', async () => {
  const methods: string[] = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-accessibility-tree-error',
    chromeOverrides: {
      debugger: {
        async sendCommand(_target: chrome.debugger.Debuggee, method: string) {
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

  assert.deepEqual(methods, [
    'Accessibility.enable',
    'Accessibility.getFullAXTree',
    'Accessibility.disable',
  ]);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INTERNAL_ERROR);
  assert.equal(response.error.message, 'AX tree unavailable');
  assert.equal(response.meta?.method, 'dom.get_accessibility_tree');
});

test('background dispatch resizes the viewport through CDP metrics override', async () => {
  const sendCommandCalls: DebuggerSendCommandCall[] = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-viewport-resize',
    chromeOverrides: {
      debugger: {
        async sendCommand(target: chrome.debugger.Debuggee, method: string, params?: object) {
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
        deviceScaleFactor: 2.5,
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
        deviceScaleFactor: 2.5,
        mobile: true,
      },
    },
  ]);
  assert.equal(response.meta?.method, 'viewport.resize');
  assert.deepEqual(response.result, {
    resized: true,
    width: 375,
    height: 667,
    deviceScaleFactor: 2.5,
    reset: false,
  });
});

test('background dispatch surfaces viewport reset failures', async () => {
  const methods: string[] = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-viewport-resize-error',
    chromeOverrides: {
      debugger: {
        async sendCommand(_target: chrome.debugger.Debuggee, method: string) {
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
  const sendCommandCalls: DebuggerSendCommandCall[] = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-performance-metrics',
    chromeOverrides: {
      debugger: {
        async sendCommand(target: chrome.debugger.Debuggee, method: string, params?: object) {
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
  const methods: string[] = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-performance-metrics-error',
    chromeOverrides: {
      debugger: {
        async sendCommand(_target: chrome.debugger.Debuggee, method: string) {
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

  assert.deepEqual(methods, [
    'Performance.enable',
    'Performance.getMetrics',
    'Performance.disable',
  ]);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INTERNAL_ERROR);
  assert.equal(response.error.message, 'metrics unavailable');
  assert.equal(response.meta?.method, 'performance.get_metrics');
});

test('background dispatch captures screenshot regions through a CDP clip', async () => {
  const sendMessageCalls: TabMessageCall[] = [];
  const attachCalls: DebuggerAttachCall[] = [];
  const sendCommandCalls: DebuggerSendCommandCall[] = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-screenshot-region',
    chromeOverrides: {
      tabs: {
        async sendMessage(tabId: number, message: Record<string, unknown>) {
          sendMessageCalls.push({ tabId, message });
          return { ok: true };
        },
      },
      debugger: {
        async attach(target: chrome.debugger.Debuggee, version: string) {
          attachCalls.push({ target, version });
        },
        async sendCommand(target: chrome.debugger.Debuggee, method: string, params?: object) {
          sendCommandCalls.push({ target, method, params });
          if (method === 'Page.getLayoutMetrics') {
            return { cssVisualViewport: { pageX: 100, pageY: 200 } };
          }
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
        format: 'jpeg',
        quality: 73.7,
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
      method: 'Page.getLayoutMetrics',
      params: undefined,
    },
    {
      target: { tabId: 81 },
      method: 'Page.captureScreenshot',
      params: {
        format: 'jpeg',
        quality: 73,
        clip: {
          x: 112,
          y: 234,
          width: 1,
          height: 56,
          scale: 2,
        },
        captureBeyondViewport: true,
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
    image: 'data:image/jpeg;base64,region-image-data',
    format: 'jpeg',
    mimeType: 'image/jpeg',
    byteLength: 12,
    dimensions: { width: 2, height: 112 },
    delivery: 'inline',
    complete: true,
    clipped: false,
  });
});

test('background dispatch uploads artifact screenshots as ordered native chunks', async (t) => {
  const data = Buffer.from('artifact screenshot').toString('base64');
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-screenshot-artifact',
    chromeOverrides: {
      debugger: {
        async attach() {},
        async sendCommand() {
          return { data };
        },
      },
    },
  });
  const nativePort = loaded.module.getStateForTest().nativePort;
  assert.ok(nativePort);
  const nativeMessages: unknown[] = [];
  const originalPostMessage = nativePort.postMessage.bind(nativePort);
  nativePort.postMessage = (message) => {
    nativeMessages.push(message);
    originalPostMessage(message);
  };
  t.after(() => {
    nativePort.postMessage = originalPostMessage;
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-screenshot-artifact',
      method: 'screenshot.capture_region',
      params: { x: 0, y: 0, width: 10, height: 10, delivery: 'artifact' },
    })
  );
  if (!response.ok) assert.fail(response.error.message);
  const result = response.result as {
    delivery: string;
    artifact: { artifactId: string; sha256: string };
  };
  assert.equal(result.delivery, 'artifact');
  assert.match(result.artifact.artifactId, /^art_[A-Za-z0-9_-]{43}$/u);
  assert.match(result.artifact.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    nativeMessages.map((message) => (message as { type?: string }).type),
    ['host.artifact.begin', 'host.artifact.chunk', 'host.artifact.commit']
  );
  assert.equal(
    (nativeMessages[0] as { artifact: { artifactId: string; requestId: string } }).artifact
      .artifactId,
    result.artifact.artifactId
  );
  assert.equal(
    (nativeMessages[0] as { artifact: { requestId: string } }).artifact.requestId,
    'dispatch-screenshot-artifact'
  );
  assert.equal((nativeMessages[1] as { chunkIndex: number }).chunkIndex, 0);
  assert.equal((nativeMessages[1] as { data: string }).data, data);
});

test('background dispatch defaults invalid screenshot region coordinates', async () => {
  const sendCommandCalls: DebuggerSendCommandCall[] = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-screenshot-region-defaults',
    chromeOverrides: {
      tabs: {
        async sendMessage() {
          return { ok: true };
        },
      },
      debugger: {
        async sendCommand(target: chrome.debugger.Debuggee, method: string, params?: object) {
          sendCommandCalls.push({ target, method, params });
          return { data: 'region-default-image-data' };
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-screenshot-region-defaults',
      method: 'screenshot.capture_region',
      params: {
        x: 'nope',
        y: null,
        width: '7',
        height: Number.NaN,
        scale: 0,
      },
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.equal(sendCommandCalls[0]?.method, 'Page.getLayoutMetrics');
  assert.deepEqual(sendCommandCalls[1]?.params, {
    format: 'png',
    clip: {
      x: 0,
      y: 0,
      width: 7,
      height: 1,
      scale: 1,
    },
    captureBeyondViewport: true,
  });
  assert.deepEqual(response.result, {
    rect: {
      x: 0,
      y: 0,
      width: 7,
      height: 1,
      scale: 1,
    },
    image: 'data:image/png;base64,region-default-image-data',
    format: 'png',
    mimeType: 'image/png',
    byteLength: 18,
    dimensions: { width: 7, height: 1 },
    delivery: 'inline',
    complete: true,
    clipped: false,
  });
});

test('background dispatch captures full-page screenshots after reading page dimensions', async () => {
  const sendMessageCalls: TabMessageCall[] = [];
  const sendCommandCalls: DebuggerSendCommandCall[] = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-screenshot-full-page',
    chromeOverrides: {
      tabs: {
        async sendMessage(tabId: number, message: Record<string, unknown>) {
          sendMessageCalls.push({ tabId, message });
          if (message.type === 'bridge.execute') {
            return {
              scrollWidth: 10_000,
              scrollHeight: 5_000,
              devicePixelRatio: 1.5,
            };
          }
          return { ok: true };
        },
      },
      debugger: {
        async sendCommand(_target: chrome.debugger.Debuggee, method: string, params?: object) {
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
          width: 10_000,
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
      width: 10_000,
      height: 5_000,
      scale: 1.5,
    },
    image: 'data:image/png;base64,full-page-image-data',
    format: 'png',
    mimeType: 'image/png',
    byteLength: 15,
    dimensions: { width: 15000, height: 7500 },
    delivery: 'inline',
    complete: true,
    clipped: false,
  });
});

test('background dispatch defaults invalid full-page screenshot dimensions', async () => {
  const sendCommandCalls: DebuggerSendCommandCall[] = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-screenshot-full-page-defaults',
    chromeOverrides: {
      tabs: {
        async sendMessage(_tabId: number, message: Record<string, unknown>) {
          if (message.type === 'bridge.execute') {
            return {
              scrollWidth: 'wide',
              scrollHeight: 0,
              devicePixelRatio: null,
            };
          }
          return { ok: true };
        },
      },
      debugger: {
        async sendCommand(target: chrome.debugger.Debuggee, method: string, params?: object) {
          sendCommandCalls.push({ target, method, params });
          return { data: 'full-page-default-image-data' };
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-screenshot-full-page-defaults',
      method: 'screenshot.capture_full_page',
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.deepEqual(sendCommandCalls[0]?.params, {
    format: 'png',
    clip: {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      scale: 1,
    },
    captureBeyondViewport: true,
  });
  assert.deepEqual(response.result, {
    rect: {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      scale: 1,
    },
    image: 'data:image/png;base64,full-page-default-image-data',
    format: 'png',
    mimeType: 'image/png',
    byteLength: 21,
    dimensions: { width: 1, height: 1 },
    delivery: 'inline',
    complete: true,
    clipped: false,
  });
});

test('background dispatch retries stale element screenshots before capturing', async () => {
  const sendMessageCalls: TabMessageCall[] = [];
  let elementAttemptCount = 0;
  const sendCommandCalls: DebuggerSendCommandCall[] = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-screenshot-element-retry',
    chromeOverrides: {
      tabs: {
        async sendMessage(tabId: number, message: Record<string, unknown>) {
          sendMessageCalls.push({ tabId, message });
          if (message.type === 'bridge.execute') {
            elementAttemptCount += 1;
            if (elementAttemptCount === 1) {
              throw new Error('stale element reference');
            }
            return {
              x: 5,
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
        async sendCommand(target: chrome.debugger.Debuggee, method: string, params?: object) {
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
          x: 5,
          y: 8,
          width: 120,
          height: 45,
          scale: 2,
        },
        captureBeyondViewport: true,
      },
    },
  ]);
  assert.equal(response.meta?.method, 'screenshot.capture_element');
  assert.deepEqual(response.result, {
    rect: {
      x: 5,
      y: 8,
      width: 120,
      height: 45,
      scale: 2,
    },
    image: 'data:image/png;base64,element-image-data',
    format: 'png',
    mimeType: 'image/png',
    byteLength: 13,
    dimensions: { width: 240, height: 90 },
    delivery: 'inline',
    complete: true,
    clipped: false,
  });
});

test('background dispatch surfaces non-stale element screenshot errors without retrying', async () => {
  let elementAttemptCount = 0;
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-screenshot-element-non-stale-error',
    chromeOverrides: {
      tabs: {
        async sendMessage(_tabId: number, message: Record<string, unknown>) {
          if (message.type === 'bridge.execute') {
            elementAttemptCount += 1;
            throw new Error('element lookup failed');
          }
          return { ok: true };
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-screenshot-element-non-stale-error',
      method: 'screenshot.capture_element',
      params: {
        selector: '#missing',
      },
    })
  );

  assert.equal(elementAttemptCount, 1);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INTERNAL_ERROR);
  assert.equal(response.error.message, 'element lookup failed');
  assert.equal(response.meta?.method, 'screenshot.capture_element');
});

test('background dispatch rejects element captures that cannot be guaranteed complete', async () => {
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-screenshot-incomplete-element',
    chromeOverrides: {
      tabs: {
        async sendMessage(_tabId: number, message: Record<string, unknown>) {
          if (message.type === 'bridge.execute') {
            throw new Error('Complete capture is unsupported for a fixed element.');
          }
          return { ok: true };
        },
      },
      debugger: {
        async sendCommand() {
          assert.fail('unsupported complete element captures should not reach CDP');
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-screenshot-incomplete-element',
      method: 'screenshot.capture_element',
      params: { selector: '.fixed' },
    })
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.RESULT_TRUNCATED);
  const details = response.error.details as Record<string, unknown>;
  assert.equal(details.complete, false);
  assert.equal(details.clipped, false);
  assert.equal(response.meta?.method, 'screenshot.capture_element');
});

test('background dispatch rejects zero-area element screenshots', async () => {
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-screenshot-zero-area-element',
    chromeOverrides: {
      tabs: {
        async sendMessage(_tabId: number, message: Record<string, unknown>) {
          if (message.type === 'bridge.execute') {
            return {
              x: 1,
              y: 2,
              width: 0,
              height: 4,
              scale: 1,
            };
          }
          return { ok: true };
        },
      },
      debugger: {
        async sendCommand() {
          assert.fail('zero-area screenshots should not reach CDP');
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-screenshot-zero-area-element',
      method: 'screenshot.capture_element',
      params: {
        selector: '#collapsed',
      },
    })
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INTERNAL_ERROR);
  assert.equal(
    response.error.message,
    'Capture target has no visible area (0×4px). It may be hidden, collapsed, or not yet rendered.'
  );
  assert.equal(response.meta?.method, 'screenshot.capture_element');
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

test('background dispatch rejects oversized screenshot regions before CDP capture', async () => {
  let sendCommandCalled = false;
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-screenshot-oversized-region',
    chromeOverrides: {
      tabs: {
        async sendMessage() {
          return { ok: true };
        },
      },
      debugger: {
        async sendCommand() {
          sendCommandCalled = true;
          return { data: 'should-not-capture' };
        },
      },
    },
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-screenshot-oversized-region',
      method: 'screenshot.capture_region',
      params: {
        x: 0,
        y: 0,
        width: 20_000,
        height: 20_000,
        scale: 1,
      },
    })
  );

  assert.equal(sendCommandCalled, false);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.RESULT_TRUNCATED);
  assert.match(response.error.message, /Screenshot capture is too large/);
  assert.equal(response.meta?.method, 'screenshot.capture_region');
});

test('background dispatch waits for the active tab to finish loading', async () => {
  const getCalls: number[] = [];
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
        async get(tabId: number) {
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

  const tabEvents = getTabEvents(loaded);
  await waitForListenerCount(() => tabEvents.onUpdated.listeners.length, 2);
  tabEvents.onUpdated.dispatch(
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
  assert.equal(tabEvents.onUpdated.listeners.length, 1);
  assert.equal(tabEvents.onRemoved.listeners.length, 1);
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
        async get(tabId: number) {
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

  const tabEvents = getTabEvents(loaded);
  await waitForListenerCount(() => tabEvents.onRemoved.listeners.length, 2);
  tabEvents.onRemoved.dispatch(92, { windowId: 7, isWindowClosing: false });
  const response = await responsePromise;

  assert.equal(tabEvents.onUpdated.listeners.length, 1);
  assert.equal(tabEvents.onRemoved.listeners.length, 1);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.TAB_MISMATCH);
  assert.equal(response.error.message, 'Tab was closed while waiting for load');
  assert.equal(response.meta?.method, 'page.wait_for_load_state');
});

test('background dispatch reports TIMEOUT when waiting for a load state times out', async () => {
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
        async get(tabId: number) {
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

  const tabEvents = getTabEvents(loaded);
  assert.equal(tabEvents.onUpdated.listeners.length, 1);
  assert.equal(tabEvents.onRemoved.listeners.length, 1);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.TIMEOUT);
  assert.equal(
    response.error.message,
    'Timed out waiting for tab 93 to finish loading after 500ms.'
  );
  assert.equal(response.meta?.method, 'page.wait_for_load_state');
});

const cdpScenarios: {
  method: BridgeMethod;
  params: Record<string, unknown>;
  command: string;
  commandParams: object;
  result: object;
}[] = [
  {
    method: 'cdp.get_document',
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
    method: 'cdp.get_dom_snapshot',
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
    method: 'cdp.get_box_model',
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
    method: 'cdp.get_computed_styles_for_node',
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
];

for (const scenario of cdpScenarios) {
  test(`background dispatch handles ${scenario.method} through the CDP request path`, async () => {
    const attachCalls: DebuggerAttachCall[] = [];
    const sendCommandCalls: DebuggerSendCommandCall[] = [];
    const { loaded } = await loadEnabledDispatchBackground({
      queryLabel: `test-background-dispatch-${scenario.method}`,
      chromeOverrides: {
        debugger: {
          async attach(target: chrome.debugger.Debuggee, version: string) {
            attachCalls.push({ target, version });
          },
          async sendCommand(target: chrome.debugger.Debuggee, method: string, params?: object) {
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
  'cdp.get_box_model',
  'cdp.get_computed_styles_for_node',
] satisfies BridgeMethod[]) {
  test(`background dispatch rejects ${method} without a finite nodeId`, async () => {
    let attachCalled = false;
    let sendCommandCalled = false;
    const { loaded } = await loadEnabledDispatchBackground({
      queryLabel: `test-background-dispatch-${method}-invalid-node`,
      chromeOverrides: {
        debugger: {
          async attach() {
            attachCalled = true;
          },
          async sendCommand() {
            sendCommandCalled = true;
            return {};
          },
        },
      },
    });

    const response = await loaded.dispatch({
      id: `dispatch-${method}-invalid-node`,
      method,
      tab_id: null,
      params: {
        nodeId: 'not-a-number',
      },
      meta: { protocol_version: PROTOCOL_VERSION, token_budget: null },
    } as unknown as BridgeRequest);

    assert.equal(attachCalled, false);
    assert.equal(sendCommandCalled, false);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, ERROR_CODES.INVALID_REQUEST);
    assert.equal(response.error.message, 'nodeId must be a finite number.');
    assert.equal(response.meta?.method, method);
  });
}

test('background dispatch surfaces CDP debugger-not-attached failures', async () => {
  const attachCalls: DebuggerAttachCall[] = [];
  const sendCommandCalls: DebuggerSendCommandCall[] = [];
  const { loaded } = await loadEnabledDispatchBackground({
    queryLabel: 'test-background-dispatch-cdp-not-attached',
    chromeOverrides: {
      debugger: {
        async attach(target: chrome.debugger.Debuggee, version: string) {
          attachCalls.push({ target, version });
        },
        async sendCommand(target: chrome.debugger.Debuggee, method: string, params?: object) {
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

  assert.deepEqual(attachCalls, [
    { target: { tabId: 81 }, version: '1.3' },
    { target: { tabId: 81 }, version: '1.3' },
  ]);
  assert.deepEqual(sendCommandCalls, [
    {
      target: { tabId: 81 },
      method: 'DOM.getDocument',
      params: {
        depth: 2,
        pierce: false,
      },
    },
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

  const invalidRequest = {
    id: 'dispatch-unhandled-method',
    method: 'not.a.real.method',
    params: {},
    meta: {},
  } as unknown as BridgeRequest;

  const response = await loaded.dispatch(invalidRequest);

  assert.equal(response.ok, false);
  assert.equal(response.id, 'dispatch-unhandled-method');
  assert.equal(response.error.code, ERROR_CODES.INVALID_REQUEST);
  assert.equal(response.error.message, 'Unsupported method: not.a.real.method');
  assert.equal(response.meta?.method, 'not.a.real.method');
});

test('background dispatch triggers the access-request UI after a window-off denial', async () => {
  const queryCalls: chrome.tabs.QueryInfo[] = [];
  const popupCreateCalls: chrome.windows.CreateData[] = [];
  const chrome = createChromeFake({
    runtime: {
      getURL(path: string) {
        return `chrome-extension://test-extension-id/${path}`;
      },
    },
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
        queryCalls.push(queryInfo);
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [
            {
              id: 61,
              windowId: 9,
              active: true,
              title: 'Needs access',
              url: 'https://example.com/needs-access',
            } as chrome.tabs.Tab,
          ];
        }
        return [
          {
            id: 61,
            windowId: 9,
            active: true,
            title: 'Needs access',
            url: 'https://example.com/needs-access',
          } as chrome.tabs.Tab,
        ];
      },
      async get(tabId: number) {
        return {
          id: tabId,
          windowId: 9,
          active: true,
          title: 'Needs access',
          url: 'https://example.com/needs-access',
        } as chrome.tabs.Tab;
      },
    },
    windows: {
      async get(windowId: number) {
        return {
          id: windowId,
          left: 100,
          top: 50,
          width: 1200,
        };
      },
      async create(createData: chrome.windows.CreateData = {}) {
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

  const state = loaded.module.getStateForTest() as AccessRequestState;
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

test('background dispatch triggers the access-request UI after tab-bound access denial', async () => {
  const popupCreateCalls: chrome.windows.CreateData[] = [];
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
              id: 62,
              windowId: 10,
              active: true,
              title: 'Needs tab access',
              url: 'https://example.com/needs-tab-access',
            } as chrome.tabs.Tab,
          ];
        }
        return [];
      },
    },
    windows: {
      async get(windowId: number) {
        return {
          id: windowId,
          left: 100,
          top: 50,
          width: 1200,
        };
      },
      async create(createData: chrome.windows.CreateData = {}) {
        popupCreateCalls.push(createData);
        return {
          id: 92,
          ...createData,
        };
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-dispatch-tab-bound-access-retry-${Date.now()}`,
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-page-state-access-retry',
      method: 'page.get_state',
    })
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.ACCESS_DENIED);
  assert.equal(response.error.message, 'No window is currently enabled for bridge access');

  const state = loaded.module.getStateForTest() as AccessRequestState;
  assert.equal(state.requestedAccessWindowId, 10);
  assert.equal(state.requestedAccessPopupWindowId, 92);
  assert.equal(popupCreateCalls.length, 1);
});

test('background dispatch does not prompt for access while the browser is not focused', async () => {
  const popupCreateCalls: chrome.windows.CreateData[] = [];
  const chrome = createChromeFake({
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [
            {
              id: 63,
              windowId: 11,
              active: true,
              title: 'Background tab',
              url: 'https://example.com/background-tab',
            } as chrome.tabs.Tab,
          ];
        }
        return [];
      },
    },
    windows: {
      async getLastFocused() {
        return { id: 11, focused: false };
      },
      async create(createData: chrome.windows.CreateData = {}) {
        popupCreateCalls.push(createData);
        return { id: 93, ...createData };
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-dispatch-unfocused-access-${Date.now()}`,
  });

  const response = await loaded.dispatch(
    createRequest({
      id: 'dispatch-page-state-unfocused-access',
      method: 'page.get_state',
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
    requestedTargetWindowId: 11,
    requestedTargetTabId: 63,
  });

  const state = loaded.module.getStateForTest() as AccessRequestState;
  assert.equal(state.requestedAccessWindowId, null);
  assert.equal(state.requestedAccessPopupWindowId, null);
  assert.deepEqual(popupCreateCalls, []);
});

test('background dispatch rejects invalid native requests before method dispatch', async () => {
  const loaded = await loadBackground({
    query: `test-background-dispatch-invalid-${Date.now()}`,
  });
  const nativePort = loaded.module.getStateForTest().nativePort;

  const response = await new Promise<BridgeResponse>((resolve, reject) => {
    if (!nativePort) {
      reject(new Error('Expected a native port for the background test harness.'));
      return;
    }

    const originalPostMessage = nativePort.postMessage.bind(nativePort);
    const timeoutId = setTimeout(() => {
      nativePort.postMessage = originalPostMessage;
      reject(new Error('No invalid-request response was posted.'));
    }, 50);

    nativePort.postMessage = (message) => {
      if (message && typeof message === 'object' && 'id' in message && 'ok' in message) {
        clearTimeout(timeoutId);
        nativePort.postMessage = originalPostMessage;
        resolve(message as unknown as BridgeResponse);
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
  });

  assert.equal(response.ok, false);
  assert.equal(response.id, 'dispatch-invalid-method');
  assert.equal(response.error.code, ERROR_CODES.INVALID_REQUEST);
  assert.match(response.error.message, /Unsupported method: not\.a\.real\.method/);
});
