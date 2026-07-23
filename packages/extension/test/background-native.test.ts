import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createChromeEvent,
  createChromeFake,
  createStorageArea,
  type ChromeFake,
  type FakeChromeEvent,
} from '../../../tests/_helpers/chromeFake.ts';
import {
  loadBackground,
  type FakeRuntimePort,
  type LoadedBackground,
} from '../../../tests/_helpers/loadBackground.ts';
import { createMessagePortPair } from '../../../tests/_helpers/messagePort.ts';
import {
  ERROR_CODES,
  createFailure,
  createRequest,
  createSuccess,
} from '../../protocol/src/index.js';
import type { SetupStatus } from '../../protocol/src/types.js';
import { createNativeConnectionController, refreshSetupStatus } from '../src/background-native.js';
import { createExtensionState } from '../src/background-state.js';
import type { ExtensionState } from '../src/background-state.js';

type ScheduledTimer = {
  handle: ReturnType<typeof setTimeout>;
  callback: () => void;
  delay: number;
};
type NativeRequestMessage = {
  type?: string;
  request?: { id?: string; method?: string };
};
type NativeTestPort = FakeRuntimePort & { name: string };
type ExecuteScriptDetails = chrome.scripting.ScriptInjection<unknown[], unknown> & {
  args?: unknown[];
};
type ExecuteScriptCall = { tabId: number | undefined; args: unknown[] | null };
type NetworkExecuteScriptCall = {
  target: chrome.scripting.InjectionTarget | undefined;
  world: string | undefined;
  args: unknown[] | null;
};
type ClearBufferExecuteScriptCall = {
  tabId: number | undefined;
  clear: unknown;
  source: string;
};
type SendMessageCall = { tabId: number; type: string; method: string | undefined };
type ClassifiedExecuteScriptCall = {
  tabId: number | undefined;
  kind: 'inject' | 'console' | 'network' | 'other';
  files?: string[];
};
type NativeBackgroundModule = {
  getStateForTest: () => ExtensionState;
  scheduleNativeReconnect: (
    reason: string,
    options: {
      method: string;
      summaryPrefix: string;
      updateDisconnectedUi: boolean;
    }
  ) => void;
  clearTabBridgeState: (tabId: number) => Promise<void>;
};
type StateSyncMessage = { type: 'state.sync'; state: Record<string, unknown> };

function createNativePort(messages: unknown[]): NativeTestPort {
  const onMessage = createChromeEvent();
  return {
    postMessage(message: unknown) {
      messages.push(message);
      const candidate = toNativeRequestMessage(message);
      const request = candidate.request;
      if (
        candidate.type === 'host.bridge_request' &&
        request?.method === 'setup.get_status' &&
        typeof request.id === 'string'
      ) {
        const requestId = request.id;
        queueMicrotask(() => {
          onMessage.dispatch({
            type: 'host.setup_status.response',
            requestId,
            status: {
              mcpClients: [],
              skillTargets: [],
            },
          });
        });
      }
      if (
        candidate.type === 'host.bridge_request' &&
        request?.method === 'health.ping' &&
        typeof request.id === 'string'
      ) {
        const requestId = request.id;
        queueMicrotask(() => {
          onMessage.dispatch({
            type: 'host.bridge_response',
            response: createSuccess(
              requestId,
              {
                daemon: 'ok',
                daemonVersion: '1.2.0',
                extensionConnected: true,
              },
              {
                method: 'health.ping',
              }
            ),
          });
        });
      }
    },
    disconnect() {},
    onMessage,
    onDisconnect: createChromeEvent(),
    name: 'native',
  };
}

async function flushAsyncWork(count = 8) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(predicate(), true);
}

function installManualTimers(): {
  scheduled: ScheduledTimer[];
  cleared: ReturnType<typeof setTimeout>[];
  restore: () => void;
} {
  const savedSetTimeout = globalThis.setTimeout;
  const savedClearTimeout = globalThis.clearTimeout;
  const scheduled: ScheduledTimer[] = [];
  const cleared: ReturnType<typeof setTimeout>[] = [];

  Reflect.set(globalThis, 'setTimeout', ((
    callback: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ) => {
    const handle = {
      id: `timer-${scheduled.length}`,
    } as unknown as ReturnType<typeof setTimeout>;
    scheduled.push({
      handle,
      delay: Number(delay ?? 0),
      callback: () => {
        if (typeof callback === 'function') {
          callback(...args);
        }
      },
    });
    return handle;
  }) as unknown as typeof setTimeout);
  Reflect.set(globalThis, 'clearTimeout', ((handle?: ReturnType<typeof setTimeout>) => {
    if (handle) {
      cleared.push(handle);
    }
  }) as typeof clearTimeout);

  return {
    scheduled,
    cleared,
    restore() {
      Reflect.set(globalThis, 'setTimeout', savedSetTimeout);
      Reflect.set(globalThis, 'clearTimeout', savedClearTimeout);
    },
  };
}

test('refreshSetupStatus ignores a stale timer and expires the current request', async () => {
  const state = createExtensionState();
  const messages: unknown[] = [];
  let emittedStates = 0;
  state.nativePort = {
    postMessage(message: unknown) {
      messages.push(message);
    },
  } as unknown as chrome.runtime.Port;

  const timers = installManualTimers();
  try {
    refreshSetupStatus(state, {
      async emitUiState() {
        emittedStates += 1;
      },
    });
    const firstRequestId = state.setupStatusPendingRequestId;
    const firstTimer = timers.scheduled[0];

    state.setupStatusPending = false;
    state.setupStatusPendingRequestId = null;
    refreshSetupStatus(
      state,
      {
        async emitUiState() {
          emittedStates += 1;
        },
      },
      true
    );
    const secondRequestId = state.setupStatusPendingRequestId;
    const secondTimer = timers.scheduled[1];

    assert.equal(messages.length, 2);
    assert.equal(timers.scheduled.length, 2);
    assert.deepEqual(
      timers.scheduled.map((timer) => timer.delay),
      [5000, 5000]
    );
    assert.ok(firstRequestId);
    assert.ok(secondRequestId);
    assert.notEqual(firstRequestId, secondRequestId);
    assert.deepEqual(timers.cleared, [firstTimer.handle]);

    firstTimer.callback();
    await flushAsyncWork();
    assert.equal(state.setupStatusPending, true);
    assert.equal(state.setupStatusPendingRequestId, secondRequestId);
    assert.equal(state.setupStatusError, null);
    assert.equal(emittedStates, 0);

    secondTimer.callback();
    await flushAsyncWork();
    assert.equal(state.setupStatusPending, false);
    assert.equal(state.setupStatusPendingRequestId, null);
    assert.equal(state.setupStatusError, 'Host setup request timed out.');
    assert.equal(state.setupStatusTimeoutId, null);
    assert.equal(emittedStates, 1);
  } finally {
    timers.restore();
  }
});

test('native reconnect telemetry settles on disconnect or the existing stability timer', async () => {
  const state = createExtensionState();
  const messages: unknown[] = [];
  const firstPort = createNativePort(messages);
  const secondPort = createNativePort(messages);
  const thirdPort = createNativePort(messages);
  const ports = [firstPort, secondPort, thirdPort];
  const outcomes: Array<'success' | 'failure'> = [];
  const chromeObj = {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      connectNative() {
        const port = ports.shift();
        if (!port) throw new Error('no test port');
        return port;
      },
      lastError: undefined,
    },
    storage: {
      session: createStorageArea(),
    },
  } as unknown as typeof chrome;
  const timers = installManualTimers();
  try {
    const controller = createNativeConnectionController(state, chromeObj, {
      async appendActionLogEntry() {},
      broadcastUi() {},
      clearSetupStatus() {},
      async emitUiState() {},
      async handleBridgeRequest() {},
      handleHostStatusMessage: () => false,
      async refreshActionIndicators() {},
      refreshSetupStatus() {},
      reply() {},
      recordReconnect: (outcome) => outcomes.push(outcome),
    });

    controller.scheduleNativeReconnect('first disconnect');
    timers.scheduled[0].callback();
    firstPort.onDisconnect.dispatch();
    assert.deepEqual(outcomes, ['failure']);

    timers.scheduled[2].callback();
    timers.scheduled[3].callback();
    await flushAsyncWork();
    assert.deepEqual(outcomes, ['failure', 'success']);

    secondPort.onDisconnect.dispatch();
    assert.deepEqual(outcomes, ['failure', 'success']);
    timers.scheduled[5].callback();
    timers.scheduled[6].callback();
    await flushAsyncWork();
    assert.deepEqual(outcomes, ['failure', 'success', 'success']);
  } finally {
    timers.restore();
  }
});

function classifyExecuteScript(
  details: ExecuteScriptDetails
): 'inject' | 'console' | 'network' | 'other' {
  if (Array.isArray(details.files)) {
    return 'inject';
  }
  const source = String(details.func);
  if (source.includes('__bb_console_buffer')) {
    return 'console';
  }
  if (source.includes('__bb_network_buffer')) {
    return 'network';
  }
  return 'other';
}

function findMessage(messages: unknown[], type: string): Record<string, unknown> | undefined {
  return messages.find((message): message is Record<string, unknown> =>
    hasMessageType(message, type)
  );
}

function getStateSyncMessages(messages: unknown[]): StateSyncMessage[] {
  return messages.filter((message): message is StateSyncMessage =>
    hasMessageType(message, 'state.sync')
  );
}

function hasMessageType(message: unknown, type: string): message is Record<string, unknown> {
  return (
    typeof message === 'object' && message !== null && 'type' in message && message.type === type
  );
}

function toNativeRequestMessage(message: unknown): NativeRequestMessage {
  if (typeof message === 'object' && message !== null) {
    return message as unknown as NativeRequestMessage;
  }
  return {};
}

function getNativeModule(loaded: LoadedBackground): NativeBackgroundModule {
  return loaded.module as unknown as NativeBackgroundModule;
}

function getRuntimeOnConnect(chrome: ChromeFake): FakeChromeEvent {
  return chrome.runtime.onConnect as unknown as FakeChromeEvent;
}

function getTabsOnUpdated(chrome: ChromeFake): FakeChromeEvent {
  return chrome.tabs.onUpdated as unknown as FakeChromeEvent;
}

function createSetupStatus(overrides: Partial<SetupStatus> = {}): SetupStatus {
  return {
    scope: 'global',
    mcpClients: [],
    skillTargets: [],
    ...overrides,
  };
}

function getBridgeRequestMethod(message: Record<string, unknown> | undefined): string | undefined {
  const request = message?.request;
  if (typeof request === 'object' && request !== null && 'method' in request) {
    return typeof request.method === 'string' ? request.method : undefined;
  }
  return undefined;
}

test('background native enable flow primes console capture and swallows recoverable tab errors', async () => {
  const nativeMessages: unknown[] = [];
  const executeScriptCalls: ExecuteScriptCall[] = [];
  const nativePort = createNativePort(nativeMessages);
  const portPair = createMessagePortPair({ leftName: 'ui-popup', rightName: 'agent' });
  const tabsById = new Map([
    [
      31,
      {
        id: 31,
        windowId: 8,
        title: 'Current Window',
        url: 'https://example.com/current',
        status: 'complete',
      },
    ],
    [
      32,
      {
        id: 32,
        windowId: 8,
        title: 'Restricted Tab',
        url: 'chrome://settings',
        status: 'complete',
      },
    ],
  ]);
  const loaded = await loadBackground({
    chrome: createChromeFake({
      runtime: {
        connectNative() {
          return nativePort;
        },
      },
      tabs: {
        async query(queryInfo: chrome.tabs.QueryInfo = {}) {
          if (queryInfo.active && queryInfo.lastFocusedWindow) {
            return [tabsById.get(31)];
          }
          if (queryInfo.windowId === 8) {
            return [tabsById.get(31), tabsById.get(32), { id: null, windowId: 8 }];
          }
          return [];
        },
        async get(tabId: number) {
          const tab = tabsById.get(tabId);
          if (!tab) {
            throw new Error(`No tab with id: ${tabId}.`);
          }
          return tab;
        },
        async sendMessage(_tabId: number, message: Record<string, unknown>) {
          if (message.type === 'bridge.ping') {
            return { ok: true };
          }
          return null;
        },
      },
      scripting: {
        async executeScript(details: ExecuteScriptDetails) {
          executeScriptCalls.push({
            tabId: details.target?.tabId,
            args: Array.isArray(details.args) ? details.args : null,
          });
          if (details.target?.tabId === 32) {
            throw new Error('Cannot access contents of url "chrome://settings".');
          }
          if (Array.isArray(details.args)) {
            return [
              { result: { entries: [{ level: 'log', args: ['stale'], ts: 1 }], dropped: 1 } },
            ];
          }
          return [];
        },
      },
    }),
    query: `test-background-native-console-prime-${Date.now()}-${Math.random()}`,
  });

  getRuntimeOnConnect(loaded.chrome).dispatch(portPair.left.port);
  await flushAsyncWork();
  portPair.left.postedMessages.length = 0;

  portPair.left.dispatchMessage({ type: 'scope.set_enabled', enabled: true });
  await flushAsyncWork();
  await waitForCondition(() => executeScriptCalls.length === 3);

  const state = getNativeModule(loaded).getStateForTest();
  assert.equal(state.enabledWindow?.windowId, 8);
  assert.equal(
    portPair.left.postedMessages.some(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'toggle.error'
    ),
    false
  );
  assert.deepEqual(executeScriptCalls, [
    { tabId: 31, args: [executeScriptCalls[0].args?.[0]] },
    { tabId: 32, args: [executeScriptCalls[0].args?.[0]] },
    { tabId: 31, args: [true, executeScriptCalls[0].args?.[0]] },
  ]);
  assert.deepEqual(findMessage(nativeMessages, 'host.access_update'), {
    type: 'host.access_update',
    accessEnabled: true,
  });
});

test('background native connect syncs restored enabled access after startup', async () => {
  const nativeMessages: unknown[] = [];
  const nativePort = createNativePort(nativeMessages);
  const loaded = await loadBackground({
    chrome: createChromeFake({
      runtime: {
        connectNative() {
          return nativePort;
        },
      },
      storage: {
        session: createStorageArea({
          enabledWindow: {
            windowId: 8,
            title: 'Restored Window',
            enabledAt: 123,
          },
        }),
      },
    }),
    query: `test-background-native-restored-access-${Date.now()}-${Math.random()}`,
  });

  await flushAsyncWork();
  await waitForCondition(() => Boolean(findMessage(nativeMessages, 'host.access_update')));

  assert.deepEqual(getNativeModule(loaded).getStateForTest().enabledWindow, {
    windowId: 8,
    title: 'Restored Window',
    enabledAt: 123,
  });
  assert.deepEqual(findMessage(nativeMessages, 'host.access_update'), {
    type: 'host.access_update',
    accessEnabled: true,
  });
});

test('background native tab updates log non-recoverable console priming failures', async () => {
  const loggedErrors: Error[] = [];
  const savedConsoleError = console.error;
  const loaded = await loadBackground({
    chrome: createChromeFake({
      tabs: {
        async get(tabId: number) {
          return {
            id: tabId,
            windowId: 8,
            title: 'Current Window',
            url: 'https://example.com/current',
            status: 'complete',
          };
        },
      },
      scripting: {
        async executeScript() {
          throw new Error('console priming failed');
        },
      },
    }),
    query: `test-background-native-console-prime-error-${Date.now()}-${Math.random()}`,
  });

  console.error = (error: unknown) => {
    loggedErrors.push(error instanceof Error ? error : new Error(String(error)));
  };

  try {
    getNativeModule(loaded).getStateForTest().enabledWindow = {
      windowId: 8,
      title: 'Current Window',
      enabledAt: Date.now(),
    };

    getTabsOnUpdated(loaded.chrome).dispatch(
      31,
      { status: 'complete' },
      {
        id: 31,
        windowId: 8,
        title: 'Current Window',
        url: 'https://example.com/current',
        status: 'complete',
      }
    );
    await flushAsyncWork();
  } finally {
    console.error = savedConsoleError;
  }

  assert.equal(loggedErrors.length, 1);
  assert.equal(loggedErrors[0]?.message, 'console priming failed');
});

test('background native scheduleNativeReconnect backs off and clears the prior reconnect timer', async () => {
  const nativeMessages: unknown[] = [];
  const nativePort = createNativePort(nativeMessages);
  const loaded = await loadBackground({
    chrome: createChromeFake({
      runtime: {
        connectNative() {
          return nativePort;
        },
      },
    }),
    query: `test-background-native-backoff-${Date.now()}-${Math.random()}`,
  });

  const timers = installManualTimers();
  try {
    const nativeModule = getNativeModule(loaded);
    const state = nativeModule.getStateForTest();
    const staleStatusTimer = { id: 'status-timeout' } as unknown as ReturnType<typeof setTimeout>;
    state.setupStatus = createSetupStatus();
    state.setupStatusPending = true;
    state.setupStatusPendingRequestId = 'pending-status';
    state.setupStatusUpdatedAt = 123;
    state.setupStatusError = 'stale';
    state.setupStatusTimeoutId = staleStatusTimer;

    nativeModule.scheduleNativeReconnect('bridge down', {
      method: 'native.disconnect',
      summaryPrefix: 'Native host disconnected',
      updateDisconnectedUi: false,
    });
    nativeModule.scheduleNativeReconnect('still down', {
      method: 'native.disconnect',
      summaryPrefix: 'Native host disconnected',
      updateDisconnectedUi: false,
    });
    await flushAsyncWork();

    assert.equal(state.nativeReconnectAttempts, 2);
    assert.equal(state.setupStatus, null);
    assert.equal(state.setupStatusPending, false);
    assert.equal(state.setupStatusPendingRequestId, null);
    assert.equal(state.setupStatusUpdatedAt, 0);
    assert.equal(state.setupStatusError, 'still down');
    assert.equal(state.setupStatusTimeoutId, null);
    assert.deepEqual(
      timers.scheduled.map((entry) => entry.delay),
      [2000, 4000]
    );
    assert.deepEqual(timers.cleared, [staleStatusTimer, timers.scheduled[0].handle]);
    assert.equal(
      state.actionLog.at(-1)?.summary,
      'Native host disconnected (attempt 2): still down. Reconnecting in 4000ms.'
    );
  } finally {
    timers.restore();
  }
});

test('background native marks the connection unstable after repeated disconnects and keeps the backoff', async () => {
  const nativeMessages: unknown[] = [];
  const nativePort = createNativePort(nativeMessages);
  const portPair = createMessagePortPair({ leftName: 'ui-popup', rightName: 'agent' });
  const loaded = await loadBackground({
    chrome: createChromeFake({
      runtime: {
        connectNative() {
          return nativePort;
        },
      },
    }),
    query: `test-background-native-unstable-${Date.now()}-${Math.random()}`,
  });

  getRuntimeOnConnect(loaded.chrome).dispatch(portPair.left.port);
  await flushAsyncWork();
  portPair.left.postedMessages.length = 0;

  const timers = installManualTimers();
  try {
    const nativeModule = getNativeModule(loaded);
    const state = nativeModule.getStateForTest();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      nativeModule.scheduleNativeReconnect('daemon exited', {
        method: 'native.disconnect',
        summaryPrefix: 'Native host disconnected',
        updateDisconnectedUi: true,
      });
    }
    await flushAsyncWork();

    assert.equal(state.nativeUnstable, true);
    assert.equal(state.nativeDisconnectTimes.length, 3);
    const lastStatus = portPair.left.postedMessages
      .filter(
        (message): message is { type: string; connected: boolean; unstable: boolean } =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'native.status'
      )
      .at(-1);
    assert.equal(lastStatus?.unstable, true);

    // Reconnect and let the stability window close: the connection stays
    // flagged unstable and the reconnect backoff is not reset.
    const reconnectTimer = timers.scheduled.at(-1);
    reconnectTimer?.callback();
    const stabilityTimer = timers.scheduled.at(-1);
    assert.equal(stabilityTimer?.delay, 500);
    stabilityTimer?.callback();
    await flushAsyncWork();

    assert.equal(state.nativeUnstable, true);
    assert.notEqual(state.nativeReconnectAttempts, 0);
    const connectedStatus = portPair.left.postedMessages
      .filter(
        (message): message is { type: string; connected: boolean; unstable: boolean } =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'native.status' &&
          'connected' in message &&
          message.connected === true
      )
      .at(-1);
    assert.equal(connectedStatus?.unstable, true);

    const unstableRecheckTimer = timers.scheduled.find((entry) => entry.delay > 50_000);
    assert.equal(
      typeof unstableRecheckTimer?.delay === 'number' && unstableRecheckTimer.delay > 500,
      true
    );
    const now = Date.now();
    state.nativeDisconnectTimes = [now - 70_000, now - 65_000, now - 61_000];
    unstableRecheckTimer?.callback();
    await flushAsyncWork();

    assert.equal(state.nativeUnstable, false);
    assert.equal(state.nativeReconnectAttempts, 0);
    const recoveredStatus = portPair.left.postedMessages
      .filter(
        (message): message is { type: string; connected: boolean; unstable: boolean } =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'native.status' &&
          'unstable' in message &&
          message.unstable === false
      )
      .at(-1);
    assert.equal(recoveredStatus?.connected, true);
  } finally {
    timers.restore();
  }
});

test('background native surfaces bootstrap failures before the native port disconnects', async () => {
  const nativeMessages: unknown[] = [];
  const nativePort = createNativePort(nativeMessages);
  const portPair = createMessagePortPair({ leftName: 'ui-sidepanel', rightName: 'agent' });
  const timers = installManualTimers();

  try {
    const loaded = await loadBackground({
      chrome: createChromeFake({
        runtime: {
          connectNative() {
            return nativePort;
          },
        },
      }),
      query: `test-background-native-bootstrap-failure-${Date.now()}-${Math.random()}`,
    });

    getRuntimeOnConnect(loaded.chrome).dispatch(portPair.left.port);
    await flushAsyncWork();
    portPair.left.postedMessages.length = 0;

    const nativeModule = getNativeModule(loaded);
    const state = nativeModule.getStateForTest();
    nativePort.onMessage.dispatch({
      type: 'host.bridge_response',
      response: createFailure(
        'native_bootstrap',
        ERROR_CODES.NATIVE_HOST_UNAVAILABLE,
        'Permission denied'
      ),
    });
    await flushAsyncWork();

    assert.equal(state.pendingNativePort, null);
    assert.equal(state.nativeReconnectAttempts, 1);
    assert.equal(
      state.actionLog.at(-1)?.summary,
      'Native host startup failed (attempt 1): Permission denied. Reconnecting in 2000ms.'
    );
    assert.deepEqual(findMessage(portPair.left.postedMessages, 'native.status'), {
      type: 'native.status',
      connected: false,
      unstable: false,
      error: 'Permission denied',
    });

    nativePort.onDisconnect.dispatch();
    await flushAsyncWork();
    assert.equal(state.nativeReconnectAttempts, 1);
  } finally {
    timers.restore();
  }
});

test('background native scheduleNativeReconnect broadcasts disconnect state and logs reconnect recovery', async () => {
  const firstPortMessages: unknown[] = [];
  const secondPortMessages: unknown[] = [];
  const firstNativePort = createNativePort(firstPortMessages);
  const secondNativePort = createNativePort(secondPortMessages);
  const connectedPorts = [firstNativePort, secondNativePort];
  let connectCalls = 0;
  const portPair = createMessagePortPair({ leftName: 'ui-popup', rightName: 'agent' });
  const loaded = await loadBackground({
    chrome: createChromeFake({
      runtime: {
        connectNative() {
          const port = connectedPorts[connectCalls];
          connectCalls += 1;
          if (!port) {
            throw new Error('Unexpected connectNative call');
          }
          return port;
        },
      },
    }),
    query: `test-background-native-reconnect-${Date.now()}-${Math.random()}`,
  });

  getRuntimeOnConnect(loaded.chrome).dispatch(portPair.left.port);
  await flushAsyncWork();
  portPair.left.postedMessages.length = 0;

  const timers = installManualTimers();
  try {
    const nativeModule = getNativeModule(loaded);
    const state = nativeModule.getStateForTest();
    state.setupStatus = createSetupStatus();

    nativeModule.scheduleNativeReconnect('native host exited', {
      method: 'native.disconnect',
      summaryPrefix: 'Native host disconnected',
      updateDisconnectedUi: true,
    });
    await flushAsyncWork();

    assert.equal(state.nativePort, null);
    assert.equal(state.nativeReconnectAttempts, 1);
    assert.deepEqual(findMessage(portPair.left.postedMessages, 'native.status'), {
      type: 'native.status',
      connected: false,
      unstable: false,
      error: 'native host exited',
    });
    assert.deepEqual(portPair.left.postedMessages.at(-1), {
      type: 'state.sync',
      state: {
        nativeConnected: false,
        nativeUnstable: false,
        nativeHostVersion: null,
        daemonProxy: null,
        currentTab: null,
        setupStatus: null,
        setupStatusPending: false,
        setupStatusError: null,
        setupInstallPendingKey: null,
        setupInstallError: null,
        actionLog: [state.actionLog[0]],
      },
    });
    assert.equal(timers.scheduled[0]?.delay, 2000);

    timers.scheduled[0].callback();
    assert.equal(connectCalls, 2);
    assert.equal(timers.scheduled[1]?.delay, 500);

    timers.scheduled[1].callback();
    await flushAsyncWork();

    assert.equal(state.nativePort, secondNativePort);
    assert.equal(state.nativeReconnectAttempts, 0);
    assert.deepEqual(findMessage(portPair.left.postedMessages, 'native.status'), {
      type: 'native.status',
      connected: false,
      unstable: false,
      error: 'native host exited',
    });
    assert.equal(
      portPair.left.postedMessages.some(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'native.status' &&
          'connected' in message &&
          message.connected === true
      ),
      true
    );
    assert.equal(findMessage(secondPortMessages, 'host.activity')?.type, 'host.activity');
    assert.equal(findMessage(secondPortMessages, 'host.identity')?.type, 'host.identity');
    assert.equal(
      (findMessage(secondPortMessages, 'host.identity') as { browserExtensionId?: string })
        ?.browserExtensionId,
      'test-extension-id'
    );
    assert.equal(
      getBridgeRequestMethod(findMessage(secondPortMessages, 'host.bridge_request')),
      'setup.get_status'
    );
    assert.equal(
      state.actionLog.at(-2)?.summary,
      'Native host disconnected (attempt 1): native host exited. Reconnecting in 2000ms.'
    );
    assert.equal(state.actionLog.at(-1)?.summary, 'Native host reconnected after 1 attempt.');
  } finally {
    timers.restore();
  }
});

test('background native replies to bridge requests that arrive before the stability window closes', async () => {
  const firstPortMessages: unknown[] = [];
  const secondPortMessages: unknown[] = [];
  const firstNativePort = createNativePort(firstPortMessages);
  const secondNativePort = createNativePort(secondPortMessages);
  const connectedPorts = [firstNativePort, secondNativePort];
  let connectCalls = 0;
  const loaded = await loadBackground({
    chrome: createChromeFake({
      runtime: {
        connectNative() {
          const port = connectedPorts[connectCalls];
          connectCalls += 1;
          if (!port) {
            throw new Error('Unexpected connectNative call');
          }
          return port;
        },
      },
    }),
    query: `test-background-native-early-reply-${Date.now()}-${Math.random()}`,
  });

  const timers = installManualTimers();
  try {
    const nativeModule = getNativeModule(loaded);
    const state = nativeModule.getStateForTest();

    nativeModule.scheduleNativeReconnect('native host exited', {
      method: 'native.disconnect',
      summaryPrefix: 'Native host disconnected',
      updateDisconnectedUi: true,
    });
    await flushAsyncWork();

    timers.scheduled[0].callback();
    assert.equal(connectCalls, 2);
    assert.equal(state.nativePort, null);
    assert.equal(state.pendingNativePort, secondNativePort);

    secondNativePort.onMessage.dispatch(
      createRequest({ id: 'early-request', method: 'skill.get_runtime_context' })
    );
    await flushAsyncWork();

    const earlyResponse = secondPortMessages.find(
      (message): message is Record<string, unknown> =>
        typeof message === 'object' &&
        message !== null &&
        'id' in message &&
        (message as { id?: unknown }).id === 'early-request'
    );
    assert.equal(earlyResponse?.ok, true);

    const stabilityTimer = timers.scheduled.find((entry) => entry.delay === 500);
    assert.notEqual(stabilityTimer, undefined);
    stabilityTimer?.callback();
    await flushAsyncWork();

    assert.equal(state.nativePort, secondNativePort);
    assert.equal(state.pendingNativePort, null);
  } finally {
    timers.restore();
  }
});

test('background native enable flow broadcasts synced UI state and posts an access update', async () => {
  const nativeMessages: unknown[] = [];
  const nativePort = createNativePort(nativeMessages);
  const popupPort = createMessagePortPair({ leftName: 'ui-popup', rightName: 'agent' });
  const sidePanelPort = createMessagePortPair({ leftName: 'ui-sidepanel', rightName: 'agent' });
  const chrome = createChromeFake({
    runtime: {
      connectNative() {
        return nativePort;
      },
    },
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          return [
            {
              id: 31,
              windowId: 8,
              title: 'Current Window',
              url: 'https://example.com/current',
              status: 'complete',
            },
          ];
        }
        if (queryInfo.windowId === 8) {
          return [
            {
              id: 31,
              windowId: 8,
              title: 'Current Window',
              url: 'https://example.com/current',
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
          title: 'Current Window',
          url: 'https://example.com/current',
          status: 'complete',
        };
      },
      async sendMessage() {
        return { ok: true };
      },
    },
    alarms: {
      async create() {},
      async clear() {
        return true;
      },
    },
    scripting: {
      async executeScript() {
        return [{ result: { entries: [], dropped: 0 } }];
      },
    },
  });
  const loaded = await loadBackground({
    chrome,
    query: `test-background-native-access-update-${Date.now()}-${Math.random()}`,
  });

  getRuntimeOnConnect(loaded.chrome).dispatch(popupPort.left.port);
  getRuntimeOnConnect(loaded.chrome).dispatch(sidePanelPort.left.port);
  await flushAsyncWork();
  popupPort.left.postedMessages.length = 0;
  sidePanelPort.left.postedMessages.length = 0;

  popupPort.left.dispatchMessage({ type: 'scope.set_enabled', enabled: true });
  await flushAsyncWork();
  await waitForCondition(() => getStateSyncMessages(popupPort.left.postedMessages).length > 0);

  const state = getNativeModule(loaded).getStateForTest();
  assert.equal(state.enabledWindow?.windowId, 8);

  const popupSync = getStateSyncMessages(popupPort.left.postedMessages).at(-1);
  const sidePanelSync = getStateSyncMessages(sidePanelPort.left.postedMessages).at(-1);
  assert.deepEqual(popupSync, {
    type: 'state.sync',
    state: {
      nativeConnected: true,
      nativeUnstable: false,
      nativeHostVersion: '1.2.0',
      daemonProxy: null,
      currentTab: {
        tabId: 31,
        windowId: 8,
        title: 'Current Window',
        url: 'https://example.com/current',
        enabled: true,
        accessRequested: false,
        restricted: false,
      },
      setupStatus: {
        mcpClients: [],
        skillTargets: [],
      },
      setupStatusPending: false,
      setupStatusError: null,
      setupInstallPendingKey: null,
      setupInstallError: null,
      actionLog: [],
    },
  });
  assert.deepEqual(sidePanelSync, popupSync);
  await waitForCondition(() => Boolean(findMessage(nativeMessages, 'host.access_update')));
  assert.deepEqual(findMessage(nativeMessages, 'host.access_update'), {
    type: 'host.access_update',
    accessEnabled: true,
  });
});

test('background native page.get_network falls back to an empty buffer when the page read returns no result', async () => {
  const executeScriptCalls: NetworkExecuteScriptCall[] = [];
  const activeTab = {
    id: 75,
    windowId: 7,
    active: true,
    title: 'Network buffer page',
    url: 'https://example.com/network-buffer',
    status: 'complete',
  } as chrome.tabs.Tab;
  const loaded = await loadBackground({
    chrome: createChromeFake({
      tabs: {
        async query(queryInfo: chrome.tabs.QueryInfo = {}) {
          if (queryInfo.active && queryInfo.windowId === activeTab.windowId) {
            return [activeTab];
          }
          if (queryInfo.active && queryInfo.lastFocusedWindow) {
            return [];
          }
          return [];
        },
        async get(tabId: number) {
          assert.equal(tabId, activeTab.id);
          return activeTab;
        },
      },
      windows: {
        async get(windowId: number) {
          return { id: windowId };
        },
      },
      scripting: {
        async executeScript(details: ExecuteScriptDetails) {
          executeScriptCalls.push({
            target: details.target,
            world: details.world,
            args: Array.isArray(details.args) ? details.args : null,
          });
          return [];
        },
      },
    }),
    query: `test-background-native-network-empty-${Date.now()}-${Math.random()}`,
  });

  getNativeModule(loaded).getStateForTest().enabledWindow = {
    windowId: activeTab.windowId,
    title: 'Enabled Window',
    enabledAt: Date.now(),
  };

  const response = await loaded.dispatch(
    createRequest({
      id: 'native-page-network-empty',
      method: 'page.get_network',
    })
  );

  if (!response.ok) {
    assert.fail(response.error.message);
  }
  assert.equal(response.meta?.method, 'page.get_network');
  assert.deepEqual(response.result, {
    entries: [],
    count: 0,
    total: 0,
    filteredTotal: 0,
    dropped: 0,
    abandoned: 0,
    source: 'fetch-xhr',
    capture: null,
    armed: true,
    armedDuringCapture: true,
    captureState: 'instrumented',
    startedAt: null,
    inflight: 0,
    ownershipHeld: false,
    truncated: false,
    truncation: { reason: null, limit: 50, omitted: 0 },
  });
  assert.deepEqual(executeScriptCalls, [
    {
      target: { tabId: 75 },
      world: 'MAIN',
      args: [executeScriptCalls[0].args?.[0]],
    },
    {
      target: { tabId: 75 },
      world: 'MAIN',
      args: [false, executeScriptCalls[0].args?.[0]],
    },
  ]);
});

test('background native clearTabBridgeState surfaces unexpected network buffer read failures', async () => {
  const executeScriptCalls: ClearBufferExecuteScriptCall[] = [];
  const loaded = await loadBackground({
    chrome: createChromeFake({
      tabs: {
        async sendMessage(_tabId: number, message: Record<string, unknown>) {
          if (message.type === 'bridge.ping') {
            return { ok: true };
          }

          if (message.type === 'bridge.execute' && message.method === 'patch.list') {
            return { patches: [] };
          }

          return null;
        },
      },
      scripting: {
        async executeScript(details: ExecuteScriptDetails) {
          const source = String(details.func);
          executeScriptCalls.push({
            tabId: details.target?.tabId,
            clear: details.args?.[0],
            source,
          });
          if (source.includes('__bb_console_buffer')) {
            return [{ result: { entries: [], dropped: 0 } }];
          }
          if (source.includes('__bb_network_buffer')) {
            throw new Error('network buffer exploded');
          }
          return [];
        },
      },
    }),
    query: `test-background-native-network-error-${Date.now()}-${Math.random()}`,
  });

  await assert.rejects(getNativeModule(loaded).clearTabBridgeState(91), /network buffer exploded/);
  assert.deepEqual(
    executeScriptCalls.map((call) => ({
      tabId: call.tabId,
      clear: call.clear,
      source: call.source.includes('__bb_console_buffer')
        ? 'console'
        : call.source.includes('__bb_network_buffer')
          ? 'network'
          : 'other',
    })),
    [
      {
        tabId: 91,
        clear: true,
        source: 'console',
      },
      {
        tabId: 91,
        clear: true,
        source: 'network',
      },
    ]
  );
});

test('background native enable flow injects content scripts after ping timeouts and skips restricted tabs', async () => {
  const nativeMessages: unknown[] = [];
  const sendMessageCalls: SendMessageCall[] = [];
  const executeScriptCalls: ClassifiedExecuteScriptCall[] = [];
  const nativePort = createNativePort(nativeMessages);
  const portPair = createMessagePortPair({ leftName: 'ui-popup', rightName: 'agent' });
  const tabsById = new Map([
    [
      41,
      {
        id: 41,
        windowId: 8,
        title: 'Scriptable Tab',
        url: 'https://example.com/scriptable',
        status: 'complete',
      },
    ],
    [
      42,
      {
        id: 42,
        windowId: 8,
        title: 'Restricted Tab',
        url: 'chrome://settings',
        status: 'complete',
      },
    ],
  ]);
  const loaded = await loadBackground({
    chrome: createChromeFake({
      runtime: {
        connectNative() {
          return nativePort;
        },
      },
      tabs: {
        async query(queryInfo: chrome.tabs.QueryInfo = {}) {
          if (queryInfo.active && queryInfo.lastFocusedWindow) {
            return [tabsById.get(41)];
          }
          if (queryInfo.windowId === 8) {
            return [tabsById.get(41), tabsById.get(42)];
          }
          return [];
        },
        async get(tabId: number) {
          const tab = tabsById.get(tabId);
          if (!tab) {
            throw new Error(`No tab with id: ${tabId}.`);
          }
          return tab;
        },
        async sendMessage(tabId: number, message: Record<string, unknown>) {
          sendMessageCalls.push({
            tabId,
            type: String(message.type),
            method: typeof message.method === 'string' ? message.method : undefined,
          });
          if (message.type === 'bridge.ping' && tabId === 41) {
            return new Promise(() => {});
          }
          return { ok: true };
        },
      },
      scripting: {
        async executeScript(details: ExecuteScriptDetails) {
          executeScriptCalls.push({
            tabId: details.target?.tabId,
            kind: classifyExecuteScript(details),
            files: Array.isArray(details.files) ? details.files.map(String) : undefined,
          });
          if (details.target?.tabId === 42) {
            throw new Error('Cannot access contents of url "chrome://settings".');
          }
          if (Array.isArray(details.args)) {
            return [{ result: { entries: [], dropped: 0 } }];
          }
          return [];
        },
      },
    }),
    query: `test-background-native-content-script-timeout-${Date.now()}-${Math.random()}`,
  });

  getRuntimeOnConnect(loaded.chrome).dispatch(portPair.left.port);
  await flushAsyncWork();
  portPair.left.postedMessages.length = 0;

  const timers = installManualTimers();
  try {
    portPair.left.dispatchMessage({ type: 'scope.set_enabled', enabled: true });
    await flushAsyncWork();
    await waitForCondition(() => timers.scheduled.length === 1);

    assert.equal(timers.scheduled.length, 1);
    assert.equal(timers.scheduled[0]?.delay, 5000);

    timers.scheduled[0].callback();
    await flushAsyncWork();

    assert.deepEqual(sendMessageCalls, [
      {
        tabId: 41,
        type: 'bridge.ping',
        method: undefined,
      },
    ]);
    assert.deepEqual(
      executeScriptCalls.filter((call) => call.kind === 'inject'),
      [
        {
          tabId: 41,
          kind: 'inject',
          files: [
            'packages/extension/src/content-script-helpers.js',
            'packages/extension/src/content-dom-baseline.js',
            'packages/extension/src/content-element-registry.js',
            'packages/extension/src/content-dom-query.js',
            'packages/extension/src/content-input.js',
            'packages/extension/src/content-patch.js',
            'packages/extension/src/content-script.js',
          ],
        },
      ]
    );
    assert.equal(
      portPair.left.postedMessages.some(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'toggle.error'
      ),
      false
    );
  } finally {
    timers.restore();
  }
});

test('background native clearTabBridgeState swallows restricted content script cleanup failures', async () => {
  const sendMessageCalls: SendMessageCall[] = [];
  const executeScriptCalls: ClassifiedExecuteScriptCall[] = [];
  const loaded = await loadBackground({
    chrome: createChromeFake({
      tabs: {
        async sendMessage(tabId: number, message: Record<string, unknown>) {
          sendMessageCalls.push({
            tabId,
            type: String(message.type),
            method: typeof message.method === 'string' ? message.method : undefined,
          });
          throw new Error('Receiving end does not exist.');
        },
      },
      scripting: {
        async executeScript(details: ExecuteScriptDetails) {
          executeScriptCalls.push({
            tabId: details.target?.tabId,
            kind: classifyExecuteScript(details),
          });
          throw new Error('Cannot access contents of url "chrome://settings".');
        },
      },
    }),
    query: `test-background-native-content-script-restricted-${Date.now()}-${Math.random()}`,
  });

  await assert.doesNotReject(getNativeModule(loaded).clearTabBridgeState(92));
  assert.deepEqual(sendMessageCalls, [
    {
      tabId: 92,
      type: 'bridge.ping',
      method: undefined,
    },
  ]);
  assert.deepEqual(executeScriptCalls, [
    {
      tabId: 92,
      kind: 'console',
    },
    {
      tabId: 92,
      kind: 'network',
    },
    {
      tabId: 92,
      kind: 'inject',
    },
  ]);
});
