import test from 'node:test';
import assert from 'node:assert/strict';
import { createChromeFake, type FakeChromeEvent } from '../../../tests/_helpers/chromeFake.ts';
import { loadBackground } from '../../../tests/_helpers/loadBackground.ts';
import { createRequest } from '../../../protocol/src/index.js';
import { DEFAULT_ACCESS_SETTINGS, normalizeAccessSettings } from '../src/access-settings.js';
import {
  createAccessSettingsController,
  ACCESS_SETTINGS_STORAGE_KEY,
  INHERITED_TABS_STORAGE_KEY,
} from '../src/background-access-settings.js';
import { createExtensionState } from '../src/background-state.js';
import { isGrantedTab, normalizeStoredEnabledWindow } from '../src/background-access.js';

test('access settings persist with safe defaults and ignore invalid values', async () => {
  assert.deepEqual(normalizeAccessSettings(null), DEFAULT_ACCESS_SETTINGS);
  assert.deepEqual(
    normalizeAccessSettings({ allowClosingUserTabs: 'true' }),
    DEFAULT_ACCESS_SETTINGS
  );
  const chromeObj = createChromeFake() as unknown as typeof chrome;
  const state = createExtensionState();
  const controller = createAccessSettingsController(state, chromeObj);
  await controller.restore();
  const settings = {
    allowCreatingTabs: false,
    allowClosingUserTabs: true,
    closeAiTabsWhenDone: false,
    allowOffDomainNavigation: false,
  };
  await controller.update(settings);
  assert.deepEqual(
    (await chromeObj.storage.local.get(ACCESS_SETTINGS_STORAGE_KEY))[ACCESS_SETTINGS_STORAGE_KEY],
    settings
  );
  const restarted = createExtensionState();
  await createAccessSettingsController(restarted, chromeObj).restore();
  assert.deepEqual(restarted.accessSettings, settings);
  chromeObj.storage.local.set = async () => {
    throw new Error('storage failed');
  };
  await assert.rejects(controller.update(DEFAULT_ACCESS_SETTINGS), /storage failed/);
  assert.deepEqual(state.accessSettings, settings);
});

test('AI tab cleanup respects its setting and never removes user or moved tabs', async () => {
  const removed: number[] = [];
  const chromeObj = createChromeFake({
    tabs: {
      async get(id: number) {
        return { id, windowId: id === 44 ? 8 : 7 } as chrome.tabs.Tab;
      },
      async remove(id: number) {
        removed.push(id);
      },
    },
  }) as unknown as typeof chrome;
  const state = createExtensionState();
  const controller = createAccessSettingsController(state, chromeObj);
  const grant = { windowId: 7, title: '', enabledAt: 100, tabId: 41 };
  state.enabledWindow = grant;
  await controller.track(42, grant);
  await controller.track(44, grant);
  assert.equal(isGrantedTab(state, 41, 7), true);
  assert.equal(isGrantedTab(state, 42, 7), true);
  assert.equal(isGrantedTab(state, 43, 7), false);
  assert.equal(isGrantedTab(state, 42, 8), false);
  const restarted = createExtensionState();
  await createAccessSettingsController(restarted, chromeObj).restore();
  assert.deepEqual(restarted.aiCreatedTabs, state.aiCreatedTabs);
  state.enabledWindow = { ...grant, enabledAt: 101 };
  assert.equal(isGrantedTab(state, 42, 7), false, 'old AI tabs do not inherit a new tab grant');
  state.accessSettings.closeAiTabsWhenDone = false;
  await controller.closeWhenDone(7);
  assert.deepEqual(removed, []);
  state.accessSettings.closeAiTabsWhenDone = true;
  await controller.closeWhenDone(7);
  assert.deepEqual(removed, [42]);
  await controller.forget(42);
  assert.equal(state.aiCreatedTabs['42'], undefined);
  assert.equal(normalizeStoredEnabledWindow({ ...grant, tabId: -1 }), null);
  assert.deepEqual(normalizeStoredEnabledWindow(grant), grant);
});

test('tab-only access blocks other user tabs and enforces create and close settings', async () => {
  const tabs = new Map<number, chrome.tabs.Tab>(
    [41, 43].map((id) => [
      id,
      { id, windowId: 7, url: `https://example.com/${id}`, active: id === 43 } as chrome.tabs.Tab,
    ])
  );
  const removed: number[] = [];
  let created = 0;
  const chromeObj = createChromeFake({
    tabs: {
      async query() {
        return [...tabs.values()];
      },
      async get(id: number) {
        const tab = tabs.get(id);
        if (!tab) throw new Error('No tab');
        return tab;
      },
      async create() {
        created++;
        const tab = { id: 42, windowId: 7, url: 'https://example.com/new' } as chrome.tabs.Tab;
        tabs.set(42, tab);
        return tab;
      },
      async remove(id: number) {
        removed.push(id);
        tabs.delete(id);
      },
    },
  });
  const loaded = await loadBackground({ chrome: chromeObj, query: 'tab-only-access-settings' });
  const state =
    loaded.module.getStateForTest() as import('../src/background-state.js').ExtensionState;
  state.enabledWindow = { windowId: 7, title: 'Example', enabledAt: 100, tabId: 41 };
  const list = await loaded.dispatch(
    createRequest({ id: 'list', method: 'tabs.list', params: {} })
  );
  assert.equal(list.ok, true);
  assert.deepEqual(
    (list.result as { tabs: Array<{ tabId: number }> }).tabs.map((tab) => tab.tabId),
    [41]
  );
  const denied = await loaded.dispatch(
    createRequest({ id: 'denied', method: 'page.get_state', tabId: 43, params: {} })
  );
  assert.equal(denied.ok, false);
  if (denied.ok) assert.fail('Expected the other user tab to be denied');
  assert.deepEqual(denied.error.details, {
    reason: 'tab_outside_access_scope',
    tabId: 43,
    grantedTabId: 41,
    dispatched: false,
  });
  assert.equal(denied.error.recovery?.alternativeMethod, 'health.ping');
  assert.match(denied.error.recovery?.hint ?? '', /Access is enabled/);
  assert.doesNotMatch(denied.error.recovery?.hint ?? '', /Access is off|click Enable/);
  const initial = await loaded.dispatch(
    createRequest({ id: 'initial', method: 'page.get_state', params: {} })
  );
  assert.equal(initial.ok, true);
  assert.equal(initial.meta?.tab_id, 41, 'tab grant does not follow the active user tab');
  const navigate = () =>
    loaded.dispatch(
      createRequest({
        id: crypto.randomUUID(),
        method: 'navigation.navigate',
        tabId: 41,
        params: { url: 'https://other.example/', waitForLoad: false },
      })
    );
  assert.equal((await navigate()).ok, false);
  state.accessSettings.allowOffDomainNavigation = true;
  assert.equal((await navigate()).ok, true);
  state.accessSettings.allowCreatingTabs = false;
  assert.equal(
    (
      await loaded.dispatch(
        createRequest({ id: 'create-denied', method: 'tabs.create', params: {} })
      )
    ).ok,
    false
  );
  assert.equal(created, 0);
  state.accessSettings.allowCreatingTabs = true;
  assert.equal(
    (await loaded.dispatch(createRequest({ id: 'created', method: 'tabs.create', params: {} }))).ok,
    true
  );
  assert.equal(isGrantedTab(state, 42, 7), true);
  const linked = {
    id: 45,
    windowId: 7,
    openerTabId: 42,
    url: 'https://example.com/linked',
  } as chrome.tabs.Tab;
  tabs.set(45, linked);
  (chromeObj.tabs.onCreated as FakeChromeEvent).dispatch(linked);
  for (let i = 0; i < 30 && !state.inheritedTabs['45']; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(isGrantedTab(state, 45, 7), true, 'links from AI-created tabs inherit access too');
  assert.equal(
    (
      await loaded.dispatch(
        createRequest({ id: 'linked-state', method: 'page.get_state', tabId: 45, params: {} })
      )
    ).ok,
    true
  );
  assert.equal(
    (
      await loaded.dispatch(
        createRequest({ id: 'close-linked-user', method: 'tabs.close', params: { tabId: 45 } })
      )
    ).ok,
    false
  );
  linked.windowId = 8;
  (chromeObj.tabs.onAttached as FakeChromeEvent).dispatch(45, { newWindowId: 8, newPosition: 0 });
  for (let i = 0; i < 30 && state.inheritedTabs['45']; i++)
    await new Promise((resolve) => setImmediate(resolve));
  linked.windowId = 7;
  assert.equal(
    isGrantedTab(state, 45, 7),
    false,
    'moving a linked tab out and back does not restore access'
  );
  assert.equal(
    (
      await loaded.dispatch(
        createRequest({ id: 'close-user', method: 'tabs.close', params: { tabId: 41 } })
      )
    ).ok,
    false
  );
  assert.equal(
    (
      await loaded.dispatch(
        createRequest({ id: 'close-ai', method: 'tabs.close', params: { tabId: 42 } })
      )
    ).ok,
    true
  );
  assert.deepEqual(removed, [42]);
});

test('linked user tabs inherit the current grant across descendants and worker restarts without AI ownership', async () => {
  const tabs = new Map<number, chrome.tabs.Tab>([
    [41, { id: 41, windowId: 7 } as chrome.tabs.Tab],
    [42, { id: 42, windowId: 7, openerTabId: 41 } as chrome.tabs.Tab],
    [43, { id: 43, windowId: 7, openerTabId: 42 } as chrome.tabs.Tab],
    [44, { id: 44, windowId: 7 } as chrome.tabs.Tab],
    [45, { id: 45, windowId: 7, openerTabId: 44 } as chrome.tabs.Tab],
    [46, { id: 46, windowId: 8, openerTabId: 41 } as chrome.tabs.Tab],
  ]);
  const removed: number[] = [];
  const chromeObj = createChromeFake({
    tabs: {
      async get(id: number) {
        const tab = tabs.get(id);
        if (!tab) throw new Error('Tab closed');
        return tab;
      },
      async remove(id: number) {
        removed.push(id);
      },
    },
  }) as unknown as typeof chrome;
  const state = createExtensionState();
  const grant = { windowId: 7, title: '', enabledAt: 100, tabId: 41 };
  state.enabledWindow = grant;
  const controller = createAccessSettingsController(state, chromeObj);
  await controller.restore();
  // Serialize rapid child creation so grandchildren can see their parent's grant.
  await Promise.all([...tabs.values()].map((tab) => controller.inherit(tab)));
  assert.deepEqual(Object.keys(state.inheritedTabs), ['42', '43']);
  assert.deepEqual(state.aiCreatedTabs, {});
  assert.equal(isGrantedTab(state, 43, 7), true);
  assert.equal(isGrantedTab(state, 43, 8), false);
  await controller.closeWhenDone(7);
  assert.deepEqual(removed, [], 'auto-close must not close linked user tabs');
  const restarted = createExtensionState();
  restarted.enabledWindow = grant;
  await createAccessSettingsController(restarted, chromeObj).restore();
  assert.equal(isGrantedTab(restarted, 43, 7), true);
  state.enabledWindow = { ...grant, enabledAt: 101 };
  assert.equal(isGrantedTab(state, 42, 7), false);
  state.enabledWindow = null;
  assert.equal(isGrantedTab(state, 43, 7), false);
  await controller.forget(42);
  assert.equal(state.inheritedTabs['42'], undefined);
  const stored = await chromeObj.storage.session.get(INHERITED_TABS_STORAGE_KEY);
  assert.deepEqual(stored[INHERITED_TABS_STORAGE_KEY], state.inheritedTabs);
});

test('linked-tab inheritance rejects revoked grants, closed tabs, and moved openers during lookup', async () => {
  const state = createExtensionState();
  const grant = { windowId: 7, title: '', enabledAt: 100, tabId: 41 };
  const child = { id: 42, windowId: 7, openerTabId: 41 } as chrome.tabs.Tab;
  let change: 'revoke' | 'replace' | 'close' | 'move' = 'revoke';
  const chromeObj = createChromeFake({
    tabs: {
      async get(id: number) {
        if (change === 'revoke') state.enabledWindow = null;
        if (change === 'replace') state.enabledWindow = { ...grant, enabledAt: 101 };
        if (change === 'close' && id === 42) throw new Error('Tab closed');
        return { id, windowId: change === 'move' && id === 41 ? 8 : 7 } as chrome.tabs.Tab;
      },
    },
  }) as unknown as typeof chrome;
  const controller = createAccessSettingsController(state, chromeObj);
  for (const scenario of ['revoke', 'replace', 'close', 'move'] as const) {
    change = scenario;
    state.enabledWindow = grant;
    await controller.inherit(child);
    assert.deepEqual(state.inheritedTabs, {}, scenario);
  }
});
