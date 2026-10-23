import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFailure,
  createRequest,
  MAX_NATIVE_MESSAGE_BYTES,
} from '../../../protocol/src/index.js';
import { enrichBridgeResponse } from '../src/background-action-log.js';
import { createRequestLifetimes, requestLifetimes } from '../src/background-request-lifetime.js';
import { createArtifactTransport } from '../src/background-artifact-transport.js';
import { createContentScriptBridge } from '../src/background-content-script.js';
import { createTabCleanupController } from '../src/background-tab-cleanup.js';
import { createEmulationController } from '../src/background-emulation.js';
import { TabDebuggerCoordinator } from '../src/debugger-coordinator.js';
import { executeInputPerform } from '../src/background-perform.js';
import { createChromeFake, createStorageArea } from '../../../tests/_helpers/chromeFake.ts';
import { loadBackground } from '../../../tests/_helpers/loadBackground.ts';
import { createAgentTabLeaseStore } from '../src/background-agent-tabs.js';
import type { ExtensionState } from '../src/background-state.js';

test('transport bounds complete error envelopes, Unicode details, and metadata', () => {
  const request = createRequest({
    id: 'oversized-failure',
    method: 'page.evaluate',
    params: { expression: 'throw 1' },
  });
  const response = enrichBridgeResponse(
    request,
    createFailure(
      request.id,
      'INTERNAL_ERROR',
      'x'.repeat(2_000_000),
      { text: '界'.repeat(500_000) },
      { extra: 'x'.repeat(2_000_000) }
    )
  );
  assert.equal(response.ok, false);
  assert(Buffer.byteLength(JSON.stringify(response)) < MAX_NATIVE_MESSAGE_BYTES);
  if (!response.ok) assert.equal(response.error.code, 'INTERNAL_ERROR');
});

test('request lifetimes preserve cancellation in captured guards, isolate owners, and bound admission', () => {
  const requests = createRequestLifetimes(2);
  const first = createRequest({
    id: 'lifetime-a',
    method: 'health.ping',
    meta: { transport_owner: 'a' },
  });
  const finish = requests.begin(first);
  const guard = requests.guard(first.id + '#0');
  let canceled = 0;
  requests.track(first.id, () => canceled++);
  const finishOther = requests.begin({
    ...first,
    id: 'lifetime-b',
    meta: { ...first.meta, transport_owner: 'b' },
  });
  assert.throws(() => requests.begin({ ...first, id: 'lifetime-c' }), /capacity/);
  requests.cancelOwner('a');
  assert.throws(guard, /canceled/);
  requests.guard('lifetime-b')();
  finish();
  assert.throws(guard, /canceled/);
  assert.equal(canceled, 1);
  requests.disconnect();
  assert.throws(requests.guard('lifetime-b'), /canceled/);
  finishOther();
  assert.equal(requests.size(), 0);
  assert.throws(requests.guard('untracked', Date.now() - 1), /expired/);
});

test('canceling a timed input sequence prevents its next mutation', async () => {
  const request = createRequest({
    id: 'canceled-perform',
    method: 'input.perform',
    params: {
      steps: [{ method: 'input.click', delayMs: 100 }],
      timeoutMs: 1000,
    },
  });
  const finish = requestLifetimes.begin(request);
  try {
    let dispatched = false;
    const response = await executeInputPerform(request, {
      resolveRequestTarget: async () => ({ tabId: 1 }),
      now: () => 0,
      sleep: async () => {
        requestLifetimes.cancel(request.id);
      },
      dispatch: async () => {
        dispatched = true;
        throw new Error('must not dispatch');
      },
    });
    assert.equal(response.ok, false);
    assert.equal(dispatched, false);
    if (!response.ok) assert.equal(response.error.code, 'TIMEOUT');
  } finally {
    finish();
  }
});

test('artifact transport limits unacknowledged writes and rejects all waiters on disconnect', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const port = {
    postMessage: (message: Record<string, unknown>) => {
      sent.push(message);
    },
  } as unknown as chrome.runtime.Port;
  const transport = createArtifactTransport(() => port);
  const pending = Array.from({ length: 4 }, () => transport.send({ type: 'host.artifact.chunk' }));
  const settled = Promise.allSettled(pending);
  await assert.rejects(transport.send({ type: 'host.artifact.chunk' }), /four/);
  assert.equal(sent.length, 4);
  transport.handle({ type: 'host.artifact.ack', messageId: sent[0].messageId });
  transport.disconnect();
  const results = await settled;
  assert.equal(results[0].status, 'fulfilled');
  assert(results.slice(1).every((result) => result.status === 'rejected'));
});

function cleanupDependencies() {
  return {
    ensureContentScript: async () => {},
    sendTabMessage: async () => ({ patches: [] }),
    beginDebuggerCleanup: async () => () => {},
    commitDebuggerCleanup: async () => {},
    clearFetchInterception: async () => 0,
    discardFetchInterception: () => {},
    stopCdpNetworkCapture: async () => {},
    discardCdpNetworkCapture: async () => {},
    cancelNavigationWaitsForWindow: () => {},
    isRecoverableInstrumentationError: () => false,
    isRestrictedAutomationUrl: () => false,
  };
}

test('tab cleanup cancels the debugger before awaiting emulation release behind a dialog', async () => {
  let unblock = () => {};
  let detached = false;
  const debuggerCoordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {
      detached = true;
      unblock();
    },
    burstIdleMs: 0,
  });
  const emulation = createEmulationController({
    acquire: (id) => debuggerCoordinator.acquire(id),
    release: (id) => debuggerCoordinator.release(id),
    send: async () => ({}),
  });
  await emulation.apply(7, { cpuRate: 2 });
  let started = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const action = debuggerCoordinator.runGuarded(7, async () => {
    debuggerCoordinator.handleEvent(7, 'Page.javascriptDialogOpening', {
      type: 'alert',
      message: 'blocked',
    });
    started();
    await new Promise<void>((resolve) => {
      unblock = resolve;
    });
  });
  const interrupted = assert.rejects(action, { code: 'DIALOG_BLOCKED' });
  await ready;
  const cleanup = createTabCleanupController(createChromeFake() as unknown as typeof chrome, {
    ...cleanupDependencies(),
    beginDebuggerCleanup: (id) => debuggerCoordinator.beginCleanup(id),
    commitDebuggerCleanup: (id) => debuggerCoordinator.commitCleanup(id),
    resources: [{ name: 'emulation', clear: (id) => emulation.reset(id) }],
  });
  await cleanup.clearTabBridgeState(7);
  await interrupted;
  assert.equal(detached, true);
  assert.equal(debuggerCoordinator.attachedTabs.size, 0);
});

test('patch rollback visits child frames and restores patches in reverse order', async () => {
  const rolledBack: string[] = [];
  const cleanup = createTabCleanupController(createChromeFake() as unknown as typeof chrome, {
    ...cleanupDependencies(),
    listFrames: async () => [{ frameId: 0 }, { frameId: 7 }],
    sendFrameMessage: async (_tab, frameId, message) => {
      assert.equal(frameId, 7);
      if (message.method === 'patch.list') return [{ patchId: 'first' }, { patchId: 'second' }];
      rolledBack.push(String((message.params as { patchId: string }).patchId));
      return { rolledBack: true };
    },
  });
  await cleanup.rollbackAllPatchesForTab(1);
  assert.deepEqual(rolledBack, ['second', 'first']);
});

test('patch cleanup retains touched frame IDs independently of frame enumeration and cache expiry', async () => {
  const chromeFake = createChromeFake({ tabs: { sendMessage: async () => ({ applied: true }) } });
  const bridge = createContentScriptBridge(chromeFake as unknown as typeof chrome, {
    contentScriptTimeoutMs: 5000,
    isRestrictedAutomationUrl: () => false,
  });
  await bridge.sendFrameMessage(1, 77, { type: 'bridge.execute', method: 'patch.apply_dom' }, 5000);
  assert.deepEqual(await bridge.getCleanupFrames(1), [{ frameId: 77 }]);
  bridge.clearCleanupFrames(1);
  assert.deepEqual(await bridge.getCleanupFrames(1), []);
  const restoredChrome = createChromeFake({
    scripting: {
      executeScript: async () => [{ frameId: 999, result: true }],
    },
  });
  const restored = createContentScriptBridge(restoredChrome as unknown as typeof chrome, {
    contentScriptTimeoutMs: 5000,
    isRestrictedAutomationUrl: () => false,
  });
  assert.deepEqual(await restored.getCleanupFrames(1), [{ frameId: 999 }]);
});

test('title-only updates do not interrupt a partially applied emulation configuration', async () => {
  let state: ExtensionState;
  const commands: string[] = [];
  const tab = {
    id: 81,
    windowId: 7,
    active: true,
    title: 'Old',
    url: 'https://example.test/',
    status: 'complete',
  } as chrome.tabs.Tab;
  const chromeFake = createChromeFake({
    tabs: {
      query: async (q: chrome.tabs.QueryInfo) => (q.active && q.windowId === 7 ? [tab] : []),
      get: async () => tab,
      sendMessage: async () => ({ patches: [] }),
    },
    windows: { get: async () => ({ id: 7 }) },
    debugger: {
      sendCommand: async (_target: chrome.debugger.Debuggee, method: string) => {
        commands.push(method);
        if (method === 'Emulation.setCPUThrottlingRate' && state.enabledWindow)
          state.enabledWindow = { ...state.enabledWindow, title: 'New' };
        return {};
      },
    },
  });
  const loaded = await loadBackground({ chrome: chromeFake });
  state = loaded.module.getStateForTest() as ExtensionState;
  state.enabledWindow = { windowId: 7, title: 'Old', enabledAt: 123 };
  const response = await loaded.dispatch(
    createRequest({
      id: 'title-emulation',
      method: 'emulation.apply',
      tabId: 81,
      params: { cpuRate: 2, timezoneId: 'UTC' },
    })
  );
  assert.equal(response.ok, true);
  assert(commands.includes('Emulation.setTimezoneOverride'));
  await (loaded.module.clearTabBridgeState as (id: number) => Promise<void>)(81);
});

test('concurrent working-tab updates coalesce storage writes without persisting stale state', async () => {
  const storage = createStorageArea();
  let writes = 0;
  const store = createAgentTabLeaseStore({
    storage: {
      get: storage.get,
      set: async (values) => {
        writes++;
        await storage.set(values);
      },
    },
  });
  await Promise.all(Array.from({ length: 10 }, (_, index) => store.bind('same', index + 1, 7)));
  assert(writes < 10);
  const restarted = createAgentTabLeaseStore({ storage });
  assert.equal((await restarted.get('same'))?.tabId, 10);
});
