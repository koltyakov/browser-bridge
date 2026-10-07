import test from 'node:test';
import assert from 'node:assert/strict';

import { createChromeFake, createStorageArea } from '../../../tests/_helpers/chromeFake.ts';
import { loadBackground } from '../../../tests/_helpers/loadBackground.ts';
import { createRequest } from '../../protocol/src/index.js';
import type { ExtensionState } from '../src/background-state.js';
import {
  AGENT_GROUP_STORAGE_KEY,
  createAgentTabGroupController,
} from '../src/background-agent-groups.js';

type Tab = { id: number; index: number; windowId: number; groupId: number; pinned: boolean };

function harness(ids: number[] = [1, 2, 3, 4, 5]) {
  const tabs: Tab[] = ids.map((id, index) => ({
    id,
    index,
    windowId: 7,
    groupId: -1,
    pinned: false,
  }));
  const groups = new Map<number, chrome.tabGroups.TabGroup>();
  const storage = createStorageArea();
  const calls: Array<{ method: string; tabIds: number[] }> = [];
  let active = new Set<number>();
  let enabledWindow: number | null = 7;
  let nextGroupId = 100;
  let failUpdate = false;
  let beforeQuery = (_query: chrome.tabs.QueryInfo) => {};
  const chromeObj = {
    storage: { session: storage },
    tabs: {
      async query(query: chrome.tabs.QueryInfo = {}) {
        beforeQuery(query);
        return tabs
          .filter(
            (tab) =>
              (query.groupId === undefined || tab.groupId === query.groupId) &&
              (query.windowId === undefined || tab.windowId === query.windowId)
          )
          .map((tab) => ({ ...tab }));
      },
      async group(options: chrome.tabs.GroupOptions) {
        const tabIds =
          typeof options.tabIds === 'number' ? [options.tabIds] : (options.tabIds ?? []);
        const current = tabs
          .filter((tab) => tab.windowId === options.createProperties?.windowId)
          .sort((a, b) => a.index - b.index);
        const start = current.findIndex((tab) => tab.id === tabIds[0]);
        assert.ok(
          start >= 0 && tabIds.every((id, index) => current[start + index]?.id === id),
          'grouping must not require moving tabs'
        );
        assert.ok(
          tabIds.every((id) => tabs.find((tab) => tab.id === id)?.groupId === -1),
          'never take tabs from existing groups'
        );
        const groupId = nextGroupId++;
        calls.push({ method: 'group', tabIds: [...tabIds] });
        for (const tab of tabs) if (tabIds.includes(tab.id)) tab.groupId = groupId;
        groups.set(groupId, {
          id: groupId,
          windowId: options.createProperties?.windowId ?? 7,
          title: '',
          color: 'grey',
          collapsed: false,
          shared: false,
        });
        return groupId;
      },
      async ungroup(tabIds: number[]) {
        calls.push({ method: 'ungroup', tabIds: [...tabIds] });
        for (const id of tabIds) {
          const tab = tabs.find((tab) => tab.id === id);
          assert.ok(tab);
          assert.ok(
            tabs
              .filter((member) => member.groupId === tab.groupId)
              .every((member) => tabIds.includes(member.id)),
            'release complete groups to avoid reordering middle tabs'
          );
        }
        for (const tab of tabs) if (tabIds.includes(tab.id)) tab.groupId = -1;
        for (const id of groups.keys())
          if (!tabs.some((tab) => tab.groupId === id)) groups.delete(id);
      },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      async get(id: number) {
        const group = groups.get(id);
        if (!group) throw new Error('Group closed');
        return { ...group };
      },
      async update(id: number, properties: chrome.tabGroups.UpdateProperties) {
        if (failUpdate) throw new Error('Chrome group update unavailable');
        const group = groups.get(id);
        assert.ok(group);
        Object.assign(group, properties);
        return { ...group };
      },
    },
  } as unknown as typeof globalThis.chrome;
  const create = () =>
    createAgentTabGroupController(chromeObj, {
      async getActivity() {
        return { windowId: enabledWindow, tabIds: active };
      },
    });
  return {
    tabs,
    groups,
    storage,
    calls,
    create,
    controller: create(),
    chromeObj,
    setActive(ids: number[]) {
      active = new Set(ids);
    },
    disable() {
      enabledWindow = null;
    },
    failUpdate(value: boolean) {
      failUpdate = value;
    },
    beforeQuery(callback: typeof beforeQuery) {
      beforeQuery = callback;
    },
    order() {
      return [...tabs].sort((a, b) => a.index - b.index).map((tab) => tab.id);
    },
  };
}

test('adjacent active tabs share an AI group and separated tabs get separate groups without moving', async () => {
  const h = harness();
  h.setActive([1, 2, 4]);
  const before = h.order();
  await h.controller.sync();
  assert.deepEqual(h.calls, [
    { method: 'group', tabIds: [1, 2] },
    { method: 'group', tabIds: [4] },
  ]);
  assert.equal(h.tabs[0].groupId, h.tabs[1].groupId);
  assert.notEqual(h.tabs[0].groupId, h.tabs[3].groupId);
  assert.deepEqual(
    [...h.groups.values()].map((group) => [group.title, group.color]),
    [
      ['AI', 'blue'],
      ['AI', 'blue'],
    ]
  );
  assert.deepEqual(h.order(), before);
  await Promise.all([h.controller.sync(), h.controller.sync()]);
  assert.equal(h.calls.length, 2, 'repeated routing does not recreate groups');
});

test('neighboring blocks merge when the intervening tab becomes active and split when it becomes idle', async () => {
  const h = harness([1, 2, 3]);
  h.setActive([1, 3]);
  await h.controller.sync();
  h.setActive([1, 2, 3]);
  await h.controller.sync();
  assert.equal(h.groups.size, 1);
  assert.ok(h.tabs.every((tab) => tab.groupId === h.tabs[0].groupId));
  h.setActive([1, 3]);
  await h.controller.sync();
  assert.equal(h.groups.size, 2);
  assert.equal(h.tabs[1].groupId, -1);
  assert.deepEqual(h.order(), [1, 2, 3]);
});

test('pinned tabs and existing user groups are left untouched, even groups named AI', async () => {
  const h = harness();
  h.tabs[0].pinned = true;
  h.tabs[1].groupId = 50;
  h.tabs[2].groupId = 50;
  h.groups.set(50, {
    id: 50,
    windowId: 7,
    title: 'AI',
    color: 'blue',
    collapsed: false,
    shared: false,
  });
  h.setActive([1, 2, 3, 4, 5]);
  await h.controller.sync();
  assert.deepEqual(h.calls, [{ method: 'group', tabIds: [4, 5] }]);
  h.disable();
  await h.controller.sync();
  assert.equal(h.tabs[1].groupId, 50);
  assert.equal(h.tabs[2].groupId, 50);
  assert.equal(h.groups.size, 1);
  assert.deepEqual(h.order(), [1, 2, 3, 4, 5]);
});

test('owned groups survive worker restart and clear when activity expires or access is disabled', async () => {
  const h = harness();
  h.setActive([1, 2, 4]);
  await h.controller.sync();
  const restarted = h.create();
  await restarted.sync();
  assert.equal(h.calls.length, 2);
  h.setActive([]);
  await restarted.sync();
  assert.equal(h.groups.size, 0);
  h.setActive([3]);
  await restarted.sync();
  h.disable();
  await restarted.sync();
  assert.equal(h.groups.size, 0);
  assert.deepEqual(h.storage.snapshot()[AGENT_GROUP_STORAGE_KEY], []);
});

for (const change of [
  { title: 'My group' },
  { color: 'red' as const },
  { collapsed: true },
  { shared: true },
  { windowId: 8 },
]) {
  test(`user-edited group is no longer managed: ${JSON.stringify(change)}`, async () => {
    const h = harness();
    h.setActive([1, 2]);
    await h.controller.sync();
    const group = [...h.groups.values()][0];
    Object.assign(group, change);
    h.disable();
    await h.controller.sync();
    assert.equal(h.groups.size, 1);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.storage.snapshot()[AGENT_GROUP_STORAGE_KEY], []);
  });
}

test('a user adding another tab to an AI group relinquishes ownership without ungrouping it', async () => {
  const h = harness();
  h.setActive([1, 2]);
  await h.controller.sync();
  h.tabs[2].groupId = h.tabs[0].groupId;
  h.disable();
  await h.controller.sync();
  assert.equal(h.groups.size, 1);
  assert.equal(h.calls.length, 1);
});

test('closed groups and malformed stored records are cleaned safely', async () => {
  const h = harness();
  await h.storage.set({
    [AGENT_GROUP_STORAGE_KEY]: [
      null,
      'bad',
      { groupId: -1 },
      { groupId: 10, windowId: 7, tabIds: ['1'] },
      { groupId: 99, windowId: 7, tabIds: [1] },
    ],
  });
  await h.controller.sync();
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.storage.snapshot()[AGENT_GROUP_STORAGE_KEY], []);
});

test('user tab movements during synchronization never cause stale blocks to be grouped', async () => {
  const h = harness([1, 2, 3]);
  h.setActive([1, 2]);
  h.beforeQuery((query) => {
    if (query.windowId === 7) {
      h.tabs[1].index = 2;
      h.tabs[2].index = 1;
    }
  });
  await h.controller.sync();
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.order(), [1, 3, 2]);
});

test('failed group labeling rolls back the new group and does not block later synchronization', async () => {
  const h = harness();
  h.setActive([1]);
  h.failUpdate(true);
  await assert.rejects(h.controller.sync(), /group update unavailable/);
  assert.equal(h.groups.size, 0);
  h.failUpdate(false);
  await h.controller.sync();
  assert.equal(h.groups.size, 1);
});

test('a group edited while cleanup is pending is not ungrouped', async () => {
  const h = harness();
  h.setActive([1, 2]);
  await h.controller.sync();
  h.disable();
  h.beforeQuery((query) => {
    if (query.groupId !== undefined) {
      const group = h.groups.get(query.groupId);
      assert.ok(group);
      group.title = 'Keep this group';
    }
  });
  await h.controller.sync();
  assert.equal(h.calls.length, 1);
  assert.equal([...h.groups.values()][0].title, 'Keep this group');
});

test('failed ownership reads prevent grouping and can be retried; unsupported APIs are a no-op', async () => {
  const h = harness();
  h.setActive([1]);
  const read = h.storage.get;
  h.storage.get = async () => {
    throw new Error('Storage unavailable');
  };
  await assert.rejects(h.controller.sync(), /Storage unavailable/);
  assert.equal(h.calls.length, 0);
  h.storage.get = read;
  await h.controller.sync();
  assert.equal(h.groups.size, 1);
  const unsupported = createAgentTabGroupController({} as typeof globalThis.chrome, {
    async getActivity() {
      throw new Error('Should not read activity');
    },
  });
  await unsupported.sync();
});

test('background routes real agent requests into adjacent AI groups, ignores pings, and cleans up access', async () => {
  const h = harness([81, 82, 90, 93]);
  const chromeObj = createChromeFake({
    storage: { session: h.storage },
    tabs: {
      ...h.chromeObj.tabs,
      async get(tabId: number) {
        const tab = h.tabs.find((entry) => entry.id === tabId);
        if (!tab) throw new Error('Tab closed');
        return { ...tab, url: 'https://example.test/', title: `Tab ${tabId}`, status: 'complete' };
      },
      async reload() {},
    },
  });
  Reflect.set(chromeObj, 'tabGroups', h.chromeObj.tabGroups);
  const loaded = await loadBackground({ chrome: chromeObj });
  const state = loaded.module.getStateForTest() as ExtensionState;
  state.enabledWindow = { windowId: 7, title: 'Enabled window', enabledAt: Date.now() };
  for (const tabId of [81, 82, 93]) {
    const response = await loaded.dispatch(
      createRequest({
        id: `group-live-${tabId}`,
        method: 'navigation.reload',
        tabId,
        params: { waitForLoad: false },
        meta: { agent_session: 'agent-groups-test' },
      })
    );
    assert.equal(response.ok, true, JSON.stringify(response));
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(h.groups.size, 2);
  assert.equal(h.tabs[0].groupId, h.tabs[1].groupId);
  assert.notEqual(h.tabs[0].groupId, h.tabs[3].groupId);
  assert.equal(h.tabs[2].groupId, -1);
  assert.deepEqual(h.order(), [81, 82, 90, 93]);
  const mutations = h.calls.length;
  await loaded.dispatch(createRequest({ id: 'group-ping', method: 'health.ping' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, mutations);
  const clearWindow = loaded.module.clearWindowBridgeState as (windowId: number) => Promise<void>;
  await clearWindow(7);
  assert.equal(h.groups.size, 0);
});
