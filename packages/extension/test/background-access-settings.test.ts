import test from 'node:test';
import assert from 'node:assert/strict';
import { createChromeFake } from '../../../tests/_helpers/chromeFake.ts';
import { loadBackground } from '../../../tests/_helpers/loadBackground.ts';
import { createRequest } from '../../../protocol/src/index.js';
import { DEFAULT_ACCESS_SETTINGS, normalizeAccessSettings } from '../src/access-settings.js';
import {
  createAccessSettingsController,
  ACCESS_SETTINGS_STORAGE_KEY,
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
