import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createChromeEvent,
  createChromeFake,
  createStorageArea,
  type FakeChromeEvent,
} from '../../../tests/_helpers/chromeFake.ts';
import { loadBackground } from '../../../tests/_helpers/loadBackground.ts';
import { createRequest } from '../../../protocol/src/index.js';
import { createExtensionState, type ExtensionState } from '../src/background-state.js';
import {
  createAccessSettingsController,
  ACCESS_SETTINGS_STORAGE_KEY,
} from '../src/background-access-settings.js';
import { DEFAULT_ACCESS_SETTINGS } from '../src/access-settings.js';

test('settings apply and wake waits before persistence finishes, with rollback on failure', async () => {
  const state = createExtensionState();
  const chromeObj = createChromeFake() as unknown as typeof chrome;
  let rejectSave = (_error: Error) => {};
  chromeObj.storage.local.set = () =>
    new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
  const changes: string[] = [];
  const controller = createAccessSettingsController(state, chromeObj, {
    onChanged() {
      changes.push(state.accessSettingsRevision);
    },
  });
  const oldRevision = state.accessSettingsRevision;
  const waiting = controller.waitForChange(oldRevision, 25_000);
  const saving = controller.update({ ...DEFAULT_ACCESS_SETTINGS, allowCreatingTabs: false });
  assert.equal(
    state.accessSettings.allowCreatingTabs,
    false,
    'enforcement does not wait for storage'
  );
  const change = await waiting;
  assert.equal(change.changed, true);
  assert.equal(change.settings.allowCreatingTabs, false);
  const rollback = controller.waitForChange(change.settingsRevision, 25_000);
  const failed = assert.rejects(saving, /storage unavailable/);
  rejectSave(new Error('storage unavailable'));
  await failed;
  assert.equal((await rollback).settings.allowCreatingTabs, true);
  assert.equal(changes.length, 2);
  assert.notEqual(changes[0], changes[1]);
});

test('settings waits return current data, time out truthfully, and release canceled waiters', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = createExtensionState();
  const controller = createAccessSettingsController(
    state,
    createChromeFake() as unknown as typeof chrome
  );
  assert.equal((await controller.waitForChange('old', 25_000)).changed, true);
  const unchanged = controller.waitForChange(state.accessSettingsRevision, 100);
  t.mock.timers.tick(100);
  assert.equal((await unchanged).changed, false);
  const cancelers: Array<() => void> = [];
  const waiting = Array.from({ length: 32 }, () =>
    controller.waitForChange(state.accessSettingsRevision, 25_000, (cancel) => {
      cancelers.push(cancel);
      return () => {};
    })
  );
  await assert.rejects(
    controller.waitForChange(state.accessSettingsRevision, 25_000),
    /capacity reached/
  );
  const canceled = waiting.map((promise) => assert.rejects(promise, /wait canceled/));
  cancelers.forEach((cancel) => cancel());
  await Promise.all(canceled);
  assert.equal((await controller.waitForChange(state.accessSettingsRevision, 0)).changed, false);
});

test('an agent denied tab creation sees the toggle, wakes its wait, and can retry without reconnecting', async () => {
  let created = 0;
  const chromeObj = createChromeFake({
    storage: {
      local: createStorageArea({
        [ACCESS_SETTINGS_STORAGE_KEY]: { ...DEFAULT_ACCESS_SETTINGS, allowCreatingTabs: false },
      }),
    },
    tabs: {
      async query() {
        return [{ id: 41, windowId: 7, url: 'https://example.com/', title: 'Example' }];
      },
      async get(id: number) {
        return { id, windowId: 7, url: 'https://example.com/', title: 'Example' };
      },
      async create() {
        created++;
        return { id: 42, windowId: 7, url: 'https://example.com/new' };
      },
    },
  });
  const loaded = await loadBackground({ chrome: chromeObj });
  const state = loaded.module.getStateForTest() as ExtensionState;
  state.enabledWindow = { windowId: 7, title: 'Example', enabledAt: 100 };
  const read = () =>
    loaded.dispatch(
      createRequest({
        id: crypto.randomUUID(),
        method: 'tabs.list',
        meta: { agent_session: 'reader' },
      })
    );
  const first = await read();
  assert.equal(
    (first.meta.access_settings as import('../../../protocol/src/types.js').AccessSettingsSnapshot)
      .settings.allowCreatingTabs,
    false
  );
  const denied = await loaded.dispatch(createRequest({ id: 'denied', method: 'tabs.create' }));
  assert.equal(denied.ok, false);
  if (denied.ok) assert.fail('Expected policy denial');
  const details = denied.error.details as {
    reason: string;
    settingsRevision: string;
    dispatched: boolean;
  };
  assert.equal(details.reason, 'policy_setting_disabled');
  assert.equal(details.dispatched, false);
  assert.equal(created, 0);
  assert.equal(state.requestedAccessWindowId, null);
  assert.equal(denied.error.recovery?.alternativeMethod, 'access.wait_for_change');
  const wait = loaded.dispatch(
    createRequest({
      id: 'waiting',
      method: 'access.wait_for_change',
      params: { revision: details.settingsRevision, timeoutMs: 25_000 },
    })
  );
  await new Promise((resolve) => setImmediate(resolve));
  const updates: Array<Record<string, unknown>> = [];
  const nativePost = state.nativePort!.postMessage.bind(state.nativePort);
  state.nativePort!.postMessage = (message: Record<string, unknown>) => {
    updates.push(message);
    nativePost(message);
  };
  const onMessage = createChromeEvent();
  (chromeObj.runtime.onConnect as FakeChromeEvent).dispatch({
    name: 'ui-sidepanel',
    onMessage,
    onDisconnect: createChromeEvent(),
    postMessage() {},
  });
  onMessage.dispatch({ type: 'access.settings.update', settings: DEFAULT_ACCESS_SETTINGS });
  const changed = await wait;
  assert.equal(changed.ok, true);
  assert.equal(
    (changed.result as { changed: boolean; settings: { allowCreatingTabs: boolean } }).changed,
    true
  );
  assert.equal(
    (changed.result as { settings: { allowCreatingTabs: boolean } }).settings.allowCreatingTabs,
    true
  );
  assert(
    updates.some(
      (message) => message.type === 'host.access_update' && Boolean(message.accessSettings)
    )
  );
  const nextRead = await read();
  assert.equal(
    (
      nextRead.meta
        .access_settings as import('../../../protocol/src/types.js').AccessSettingsSnapshot
    ).settings.allowCreatingTabs,
    true,
    'active agents see changes on their next ordinary response'
  );
  assert.equal(
    (await read()).meta.access_settings,
    undefined,
    'unchanged snapshots are not repeated'
  );
  const retry = await loaded.dispatch(createRequest({ id: 'retry', method: 'tabs.create' }));
  assert.equal(retry.ok, true);
  assert.equal(created, 1);
  const health = await loaded.dispatch(createRequest({ id: 'health', method: 'health.ping' }));
  assert.equal(
    (health.result as { accessSettings: { settings: { allowCreatingTabs: boolean } } })
      .accessSettings.settings.allowCreatingTabs,
    true
  );
});
