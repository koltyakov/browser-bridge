import test from 'node:test';
import assert from 'node:assert/strict';

import { createChromeFake, type FakeChromeEvent } from '../../../tests/_helpers/chromeFake.ts';
import { loadBackground } from '../../../tests/_helpers/loadBackground.ts';
import { createRequest } from '../../../protocol/src/index.js';
import type { BridgeMethod, BridgeResponse } from '../../../protocol/src/types.js';
import type { ExtensionState } from '../src/background-state.js';

// A value that must only ever reach the agent through the sensitive.read reply.
const CANARY = 'BBX_BODY_CANARY_7f3c9e1d';

async function loadCaptureBackground() {
  const activeTab = {
    id: 81,
    windowId: 7,
    active: true,
    title: 'Body tab',
    url: 'https://example.com/app',
    status: 'complete',
  } as chrome.tabs.Tab;
  const commands: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  const chromeObj = createChromeFake({
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
        return queryInfo.active && queryInfo.windowId === 7 ? [{ ...activeTab }] : [];
      },
      async get() {
        return { ...activeTab };
      },
    },
    windows: {
      async get(windowId: number) {
        return { id: windowId };
      },
    },
    debugger: {
      async sendCommand(
        _target: chrome.debugger.Debuggee,
        method: string,
        params?: Record<string, unknown>
      ) {
        commands.push({ method, params });
        if (method === 'Network.getResponseBody')
          return { body: `{"user":"${CANARY}"}`, base64Encoded: false };
        return {};
      },
    },
  });
  const loaded = await loadBackground({
    chrome: chromeObj,
    query: `test-background-sensitive-dispatch-${Date.now()}-${Math.random()}`,
  });
  const state = loaded.module.getStateForTest() as ExtensionState;
  state.enabledWindow = { windowId: 7, title: 'Enabled', enabledAt: Date.now() };
  const events = (loaded.chrome as unknown as { debugger: { onEvent: FakeChromeEvent } }).debugger
    .onEvent;
  const finishRequest = (requestId: string, url: string) => {
    events.dispatch({ tabId: 81 }, 'Network.requestWillBeSent', {
      requestId,
      type: 'Fetch',
      timestamp: 1,
      wallTime: 1_700_000_000,
      request: { url, method: 'GET', headers: { Authorization: 'Bearer hidden' } },
    });
    events.dispatch({ tabId: 81 }, 'Network.responseReceived', {
      requestId,
      type: 'Fetch',
      response: {
        status: 200,
        mimeType: 'application/json',
        headers: { 'Set-Cookie': 'sid=hidden' },
      },
    });
    events.dispatch({ tabId: 81 }, 'Network.loadingFinished', { requestId, timestamp: 1.5 });
  };
  return {
    loaded,
    state,
    commands,
    finishRequest,
    chromeObj: chromeObj as unknown as typeof chrome,
  };
}

function failure(response: BridgeResponse) {
  assert.equal(response.ok, false, JSON.stringify(response));
  if (response.ok) throw new Error('unreachable');
  return response.error as { code: string; details: Record<string, unknown> };
}

test('response body capture and reads are gated, scoped and keep the body out of every other sink', async () => {
  const { loaded, state, commands, finishRequest, chromeObj } = await loadCaptureBackground();
  const port = state.nativePort;
  assert.ok(port);
  const posted: unknown[] = [];
  const post = port.postMessage.bind(port);
  port.postMessage = (message: unknown) => {
    posted.push(message);
    post(message);
  };

  const start = (bodies?: Record<string, unknown>) =>
    loaded.dispatch(
      createRequest({
        id: crypto.randomUUID(),
        method: 'page.get_network',
        params: { source: 'cdp', capture: 'start', ...(bodies ? { bodies } : {}) },
      })
    );
  const readBody = (requestId: string) =>
    loaded.dispatch(
      createRequest({
        id: `read-${requestId}`,
        method: 'sensitive.read',
        params: { source: 'response_body', requestId },
      })
    );

  // Default off: both buffering and reading are refused before any CDP work.
  const deniedStart = failure(await start({ urlPattern: 'https://example.com/api/*' }));
  assert.equal(deniedStart.code, 'ACCESS_DENIED');
  assert.equal(deniedStart.details.reason, 'policy_setting_disabled');
  assert.equal(deniedStart.details.setting, 'allowResponseBodyReads');
  const deniedRead = failure(await readBody('api-1'));
  assert.equal(deniedRead.code, 'ACCESS_DENIED');
  assert.equal(deniedRead.details.setting, 'allowResponseBodyReads');
  assert.equal(deniedRead.details.dispatched, false);
  assert.equal(typeof deniedRead.details.settingsRevision, 'string');
  assert.equal(
    commands.some((command) => command.method.startsWith('Network.')),
    false
  );

  state.accessSettings.allowResponseBodyReads = true;
  assert.equal(failure(await readBody('api-1')).details.reason, 'capture_not_armed');
  const started = await start({ urlPattern: 'https://example.com/api/*' });
  assert.equal(started.ok, true);
  assert.deepEqual(commands.find((command) => command.method === 'Network.enable')?.params, {
    maxTotalBufferSize: 52_428_800,
    maxResourceBufferSize: 5_242_880,
    maxPostDataSize: 0,
  });
  finishRequest('api-1', 'https://example.com/api/me');
  finishRequest('asset-1', 'https://example.com/static/app.js');

  const list = await loaded.dispatch(
    createRequest({ id: 'list', method: 'page.get_network', params: { source: 'cdp' } })
  );
  assert.equal(list.ok, true);
  const listResult = list.ok
    ? (list.result as {
        entries: Array<{ requestId: string; bodyAvailable: boolean }>;
        bodyCapture?: unknown;
      })
    : null;
  assert.deepEqual(
    listResult?.entries.map((entry) => [entry.requestId, entry.bodyAvailable]),
    [
      ['api-1', true],
      ['asset-1', false],
    ]
  );
  assert.deepEqual(listResult?.bodyCapture, {
    urlPattern: 'https://example.com/api/*',
    maxResourceBytes: 5_242_880,
  });

  assert.equal(failure(await readBody('asset-1')).details.reason, 'body_not_matched');
  const read = await readBody('api-1');
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.deepEqual(read.ok && read.result, {
    source: 'response_body',
    requestId: 'api-1',
    body: `{"user":"${CANARY}"}`,
    encoding: 'text',
    mimeType: 'application/json',
    bytes: `{"user":"${CANARY}"}`.length,
    exact: true,
  });
  assert.equal(read.meta.transport_bytes, undefined, 'sensitive replies carry no size telemetry');

  const har = await loaded.dispatch(
    createRequest({
      id: 'har',
      method: 'network.export_har',
      params: { limit: 10, delivery: 'inline' },
    })
  );
  assert.equal(har.ok, true);
  const afterList = await loaded.dispatch(
    createRequest({ id: 'list-after', method: 'page.get_network', params: { source: 'cdp' } })
  );

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (state.actionLog.some((entry) => entry.method === 'sensitive.read' && entry.ok)) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const bodyLog = state.actionLog.filter((entry) => entry.method === 'sensitive.read');
  assert.equal(bodyLog.at(-1)?.summary, 'Sensitive response body read succeeded.');
  assert.deepEqual(bodyLog.at(-1)?.sensitiveAccess, {
    source: 'response_body',
    category: 'response_body',
    keyLength: 0,
  });

  // Canary sinks: lists, HAR, the action log in memory and in both storage
  // areas, and every native message except the agent's own reply.
  const [local, session] = await Promise.all([
    chromeObj.storage.local.get(null),
    chromeObj.storage.session.get(null),
  ]);
  for (const [name, sink] of [
    ['page.get_network list', list],
    ['page.get_network list after read', afterList],
    ['HAR export', har],
    ['action log', state.actionLog],
    ['chrome.storage.local', local],
    ['chrome.storage.session', session],
  ] as const) {
    assert.equal(JSON.stringify(sink).includes(CANARY), false, `${name} leaked the body`);
  }
  assert.equal(JSON.stringify(state.actionLog).includes('api-1'), false, 'no requestId in log');
  // The test dispatcher takes each reply before this wrapper, so everything
  // recorded here is a non-reply native message (logs, activity, artifacts).
  assert.equal(
    posted.filter((message) => JSON.stringify(message).includes(CANARY)).length,
    0,
    'no native message other than the reply carries the body'
  );
  assert.doesNotMatch(JSON.stringify(har), /Set-Cookie|sid=hidden|Bearer hidden/);

  // Stopping makes earlier requestIds unreadable.
  const stopped = await loaded.dispatch(
    createRequest({
      id: 'stop',
      method: 'page.get_network',
      params: { source: 'cdp', capture: 'stop' },
    })
  );
  assert.equal(stopped.ok, true);
  assert.equal(failure(await readBody('api-1')).details.reason, 'capture_not_armed');

  for (const reply of [started, list, afterList, har, stopped])
    assert.equal(JSON.stringify(reply).includes(CANARY), false, 'only the read reply has the body');

  // Turning the setting off refuses reads again without dropping the capture.
  assert.equal((await start({})).ok, true);
  finishRequest('api-2', 'https://example.com/api/again');
  state.accessSettings.allowResponseBodyReads = false;
  assert.equal(failure(await readBody('api-2')).details.reason, 'policy_setting_disabled');
  const bodyReads = commands.filter((command) => command.method === 'Network.getResponseBody');
  assert.deepEqual(
    bodyReads.map((command) => command.params?.requestId),
    ['api-1'],
    'Chrome was asked only for the one permitted body'
  );
});

const IDB_CANARY = 'BBX_IDB_E2E_CANARY_e02f';
// Names that are metadata for the agent but must never reach the action log.
const DATABASE_NAME = 'bbx_database_name_8f2b';
const STORE_NAME = 'bbx_store_name_3a6c';

async function loadStorageBackground() {
  const tab = {
    id: 82,
    windowId: 7,
    active: true,
    title: 'Storage tab',
    url: 'https://app.example.com/home',
    status: 'complete',
  } as chrome.tabs.Tab;
  const contentMessages: Array<{ frameId: unknown; method: unknown }> = [];
  const chromeObj = createChromeFake({
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo = {}) {
        return queryInfo.active && queryInfo.windowId === 7 ? [{ ...tab }] : [];
      },
      async get() {
        return { ...tab };
      },
      async sendMessage(
        _tabId: number,
        message: Record<string, unknown>,
        options?: { frameId?: number }
      ) {
        contentMessages.push({ frameId: options?.frameId, method: message.method ?? message.type });
        if (message.type === 'bridge.ping') return { ok: true };
        if (message.method === 'indexeddb.read_record')
          return {
            source: 'indexeddb',
            database: DATABASE_NAME,
            store: STORE_NAME,
            value: { user: IDB_CANARY },
            described: 0,
            bytes: 30,
            exact: true,
          };
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
        return [{ frameId: 0, result: tab.url }];
      },
    },
  });
  const loaded = await loadBackground({
    chrome: chromeObj,
    query: `test-background-sensitive-storage-${Date.now()}-${Math.random()}`,
  });
  const state = loaded.module.getStateForTest() as ExtensionState;
  state.enabledWindow = { windowId: 7, title: 'Enabled', enabledAt: Date.now() };
  return {
    loaded,
    state,
    contentMessages,
    chromeObj: chromeObj as unknown as typeof chrome,
  };
}

test('IndexedDB value reads are gated, scoped and stay out of every other sink', async () => {
  const { loaded, state, contentMessages, chromeObj } = await loadStorageBackground();
  const port = state.nativePort;
  assert.ok(port);
  const posted: unknown[] = [];
  const post = port.postMessage.bind(port);
  port.postMessage = (message: unknown) => {
    posted.push(message);
    post(message);
  };
  const call = (method: BridgeMethod, params: Record<string, unknown>) =>
    loaded.dispatch(createRequest({ id: crypto.randomUUID(), method, params }));
  const idbRead = () =>
    call('sensitive.read', {
      source: 'indexeddb',
      database: DATABASE_NAME,
      store: STORE_NAME,
      key: ['team', 7],
    });

  for (const response of [await idbRead()]) {
    const error = failure(response);
    assert.equal(error.code, 'ACCESS_DENIED');
    assert.equal(error.details.reason, 'policy_setting_disabled');
    assert.equal(error.details.setting, 'allowIndexedDBReads');
  }
  assert.equal(
    contentMessages.some((message) => message.method === 'indexeddb.read_record'),
    false,
    'no IndexedDB read while the setting is off'
  );

  state.accessSettings.allowIndexedDBReads = true;
  const record = await idbRead();
  assert.equal(record.ok, true, JSON.stringify(record));
  assert.deepEqual(record.ok && (record.result as { value: unknown }).value, { user: IDB_CANARY });
  assert.equal(record.ok && (record.result as { frameId: number }).frameId, 0);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (state.actionLog.filter((entry) => entry.method === 'sensitive.read').length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const sensitiveLog = state.actionLog.filter((entry) => entry.method === 'sensitive.read');
  assert.deepEqual(
    sensitiveLog.map((entry) => entry.summary),
    [
      'Sensitive IndexedDB record read failed: ACCESS_DENIED.',
      'Sensitive IndexedDB record read succeeded.',
    ]
  );
  assert.deepEqual(sensitiveLog.at(-1)?.sensitiveAccess, {
    source: 'indexeddb',
    category: 'indexeddb_record',
    keyLength: 0,
  });

  const [local, session] = await Promise.all([
    chromeObj.storage.local.get(null),
    chromeObj.storage.session.get(null),
  ]);
  const secrets = [IDB_CANARY, DATABASE_NAME, STORE_NAME];
  for (const [name, sink] of [
    ['action log', state.actionLog],
    ['chrome.storage.local', local],
    ['chrome.storage.session', session],
    ['non-reply native messages', posted],
  ] as const) {
    const text = JSON.stringify(sink);
    for (const secret of secrets) assert.equal(text.includes(secret), false, `${name}: ${secret}`);
  }
  assert.equal(
    contentMessages.filter((message) => message.method === 'indexeddb.read_record').length,
    1
  );
});

test('storage reads keep their content-script path when the new setting is off', async () => {
  const { loaded, state } = await loadCaptureBackground();
  assert.equal(state.accessSettings.allowIndexedDBReads, false);
  const response = await loaded.dispatch(
    createRequest({
      id: 'storage',
      method: 'sensitive.read',
      params: { source: 'local_storage', key: 'k' },
    })
  );
  // The fake content script answers nothing useful; what matters is that the
  // storage source was not refused by the sensitive-data gate.
  if (!response.ok) assert.notEqual(response.error.code, 'ACCESS_DENIED');
});
