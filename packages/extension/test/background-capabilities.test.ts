import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeError, createRequest } from '../../../protocol/src/index.js';
import { createBackgroundInputController } from '../src/background-input.js';
import type { RuntimeCapabilityCall } from '../../../protocol/src/types.js';
import {
  discoverRuntimeCapabilities,
  type CapabilityDependencies,
} from '../src/background-capabilities.js';

function harness(overrides: Partial<CapabilityDependencies> = {}) {
  let probes = 0;
  const dependencies: CapabilityDependencies = {
    resolveTarget: async () => ({
      tabId: 7,
      windowId: 2,
      url: 'https://fixture.test/',
      title: 'Fixture',
    }),
    captureAccess: () => () => {},
    assertActive: () => {},
    getTab: async () => ({ active: true, windowId: 2, url: 'https://fixture.test/' }),
    probeFrame: async () => {
      probes++;
      return { webmcp: true };
    },
    settings: () => ({
      settingsRevision: 'one',
      settings: {
        allowCreatingTabs: false,
        allowClosingUserTabs: false,
        closeAiTabsWhenDone: true,
        allowOffDomainNavigation: false,
      },
    }),
    ownsTab: () => false,
    debuggerReason: () => null,
    downloadsAvailable: true,
    ...overrides,
  };
  return {
    dependencies,
    probes: () => probes,
    discover: (calls: RuntimeCapabilityCall[], params: Record<string, unknown> = {}) =>
      discoverRuntimeCapabilities(
        createRequest({
          id: crypto.randomUUID(),
          method: 'protocol.capabilities',
          tabId: 7,
          params: { calls, ...params },
        }),
        dependencies
      ),
  };
}

test('runtime eligibility distinguishes background keys, pointers and supported insertText', async () => {
  const h = harness({ getTab: async () => ({ active: false, windowId: 2 }) });
  const result = await h.discover(
    [
      { method: 'input.fill' },
      { method: 'input.press_key' },
      { method: 'input.type', params: { clear: true } },
      { method: 'input.type', params: { submit: true } },
      { method: 'input.type', params: { clear: 'yes' } },
      { method: 'cdp.dispatch_key_event' },
      { method: 'input.click' },
      { method: 'input.type' },
      { method: 'input.fill', params: { executionMode: 'dom' } },
    ],
    { executionMode: 'cdp' }
  );
  assert.equal(result.advisory, true);
  assert.equal(result.tabId, 7);
  assert.equal(result.active, false);
  assert.deepEqual(
    result.operations.slice(0, 6).map((op) => op.reason),
    Array(6).fill('inactive_native_keyboard_target')
  );
  assert.equal(result.operations[6]?.reason, 'inactive_native_pointer_target');
  assert.deepEqual(
    result.operations.slice(7).map((op) => op.status),
    ['available', 'available']
  );
});

test('frame-specific capability discovery rejects native iframe input and top-only RPCs', async () => {
  let probedFrame = -1;
  const h = harness({
    probeFrame: async (_tab, frame) => {
      probedFrame = frame;
      return { webmcp: true };
    },
  });
  const result = await h.discover(
    [
      { method: 'input.fill' },
      { method: 'input.fill', params: { executionMode: 'dom' } },
      { method: 'page.evaluate' },
      { method: 'dom.query' },
    ],
    { executionMode: 'cdp', frameId: 12 }
  );
  assert.equal(probedFrame, 12);
  assert.deepEqual(
    result.operations.map((op) => op.reason),
    [
      'native_iframe_unsupported',
      'eligible_dispatch_checks_required',
      'top_frame_only',
      'eligible_dispatch_checks_required',
    ]
  );
});

test('unsupported native methods, auto selection and sequences do not overclaim availability', async () => {
  const result = await harness().discover(
    [
      { method: 'input.set_checked' },
      { method: 'input.fill', params: { executionMode: 'auto' } },
      { method: 'input.perform' },
    ],
    { executionMode: 'cdp' }
  );
  assert.deepEqual(
    result.operations.map((op) => [op.status, op.reason]),
    [
      ['unavailable', 'native_method_unsupported'],
      ['unknown', 'auto_mode_requires_target_inspection'],
      ['unknown', 'sequence_requires_per_step_checks'],
    ]
  );
});

test('frame context and resource methods do not confuse input mode with unrelated RPC support', async () => {
  const frames = await harness().discover(
    [
      { method: 'dom.get_accessibility_tree', params: { source: 'dom' } },
      { method: 'page.get_state' },
      { method: 'screenshot.capture_region' },
    ],
    { frameId: 5 }
  );
  assert.deepEqual(
    frames.operations.map((op) => op.status),
    ['available', 'unavailable', 'unavailable']
  );
  const resources = await harness().discover(
    [{ method: 'input.set_files' }, { method: 'input.paste_image' }, { method: 'session.status' }],
    { executionMode: 'cdp' }
  );
  assert.deepEqual(
    resources.operations.map((op) => op.reason),
    Array(3).fill('operation_requires_resource_checks')
  );
});

test('disabled or changed grants never probe an unauthorized frame or leak page metadata', async () => {
  for (const reason of [
    'window_access_disabled',
    'tab_outside_access_scope',
    'window_access_changed',
  ]) {
    const h = harness({
      resolveTarget: async () => {
        throw new BridgeError('ACCESS_DENIED', 'denied', { reason });
      },
    });
    const result = await h.discover([{ method: 'dom.query' }]);
    assert.equal(result.grant.status, 'denied');
    assert.equal(result.operations[0]?.reason, reason);
    assert.equal(result.active, null);
    assert.equal(h.probes(), 0);
    assert.equal(JSON.stringify(result).includes('fixture.test'), false);
  }
});

test('revocation and settings changes during a frame probe invalidate the whole snapshot', async () => {
  for (const change of ['grant', 'settings']) {
    let changed = false;
    const h = harness({
      captureAccess: () => () => {
        if (change === 'grant' && changed)
          throw new BridgeError('ACCESS_DENIED', 'revoked', { reason: 'window_access_changed' });
      },
      probeFrame: async () => {
        changed = true;
        return { webmcp: true };
      },
    });
    const originalSettings = h.dependencies.settings;
    if (change === 'settings')
      h.dependencies.settings = () => ({
        ...originalSettings(),
        settingsRevision: changed ? 'two' : 'one',
      });
    const result = await h.discover([{ method: 'dom.query' }]);
    assert.equal(result.grant.status, 'denied');
    assert.equal(result.operations[0]?.status, 'unavailable');
    assert.equal(result.active, null);
  }
});

test('runtime policy settings distinguish AI-owned closes and off-domain navigation', async () => {
  const result = await harness({ ownsTab: () => true }).discover([
    { method: 'tabs.create' },
    { method: 'tabs.close', params: { tabId: 7 } },
    { method: 'tabs.close', params: { tabId: 8 } },
    { method: 'navigation.navigate', params: { url: 'https://other.test/' } },
    { method: 'navigation.navigate', params: { url: 'https://fixture.test/next' } },
  ]);
  assert.deepEqual(
    result.operations.map((op) => op.status),
    ['unavailable', 'available', 'unknown', 'unavailable', 'available']
  );
  assert.equal(result.operations[0]?.reason, 'allowCreatingTabs_disabled');
  assert.equal(result.operations[3]?.reason, 'allowOffDomainNavigation_disabled');
  const denied = await harness().discover([{ method: 'tabs.close', params: { tabId: 7 } }]);
  assert.equal(denied.operations[0]?.reason, 'allowClosingUserTabs_disabled');
});

for (const { name, currentUrl, destinationUrl } of [
  {
    name: 'blank-tab navigation',
    currentUrl: 'about:blank',
    destinationUrl: 'https://fixture.test/',
  },
  {
    name: 'localhost port changes',
    currentUrl: 'http://localhost:3000/',
    destinationUrl: 'http://localhost:4000/',
  },
  {
    name: 'HTTP-to-HTTPS navigation on the same hostname',
    currentUrl: 'http://fixture.test/',
    destinationUrl: 'https://fixture.test/',
  },
]) {
  test(`navigation capabilities allow ${name} with off-domain navigation disabled`, async () => {
    const h = harness({
      getTab: async () => ({ active: true, windowId: 2, url: currentUrl }),
    });
    assert.equal(h.dependencies.settings().settings.allowOffDomainNavigation, false);
    const result = await h.discover([
      { method: 'navigation.navigate', params: { url: destinationUrl } },
    ]);
    assert.equal(result.grant.status, 'granted');
    assert.equal(result.operations[0]?.status, 'available');
    assert.equal(result.operations[0]?.reason, 'eligible_dispatch_checks_required');
  });
}

test('probe failure means unknown, missing browser APIs have explicit reasons', async () => {
  const failed = await harness({
    probeFrame: async () => {
      throw new Error('PRIVATE PAGE ERROR');
    },
  }).discover([{ method: 'dom.query' }]);
  assert.equal(failed.operations[0]?.status, 'unknown');
  assert.equal(failed.operations[0]?.reason, 'frame_probe_failed');
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE PAGE ERROR/);
  const result = await harness({
    probeFrame: async () => ({ webmcp: false }),
    debuggerReason: () => 'debugger_api_unavailable',
    downloadsAvailable: false,
  }).discover([
    { method: 'webmcp.list_tools' },
    { method: 'page.evaluate' },
    { method: 'download.start' },
    { method: 'dom.get_accessibility_tree', params: { source: 'dom' } },
  ]);
  assert.deepEqual(
    result.operations.map((op) => op.reason),
    [
      'webmcp_unavailable',
      'debugger_api_unavailable',
      'downloads_api_unavailable',
      'eligible_dispatch_checks_required',
    ]
  );
});

test('restricted documents are not probed and do not masquerade as revoked grants', async () => {
  const h = harness({
    getTab: async () => ({ active: true, windowId: 2, url: 'chrome://settings/' }),
  });
  const result = await h.discover([{ method: 'dom.query' }, { method: 'tabs.list' }]);
  assert.equal(h.probes(), 0);
  assert.equal(result.grant.status, 'granted');
  assert.equal(result.operations[0]?.reason, 'restricted_page');
  assert.equal(result.operations[1]?.status, 'available');
});

test('capability discovery rejects malformed bounds and modes before reading browser state', async () => {
  const h = harness({
    resolveTarget: async () => {
      assert.fail('Invalid requests must not resolve a tab');
    },
  });
  for (const params of [
    { calls: [] },
    { calls: Array(33).fill({ method: 'dom.query' }) },
    { calls: [{ method: 'missing' }] },
    { calls: [{ method: 'dom.query', params: [] }] },
    { frameId: -1 },
    { frameId: null },
    { frameId: 1.5 },
    { executionMode: 'magic' },
    { calls: [{ method: 'input.fill', params: { executionMode: 'magic' } }] },
  ])
    await assert.rejects(h.discover([{ method: 'dom.query' }], params), {
      code: 'INVALID_REQUEST',
    });
});

test('cancellation remains an error instead of a successful capability snapshot', async () => {
  await assert.rejects(
    harness({
      assertActive: () => {
        throw new BridgeError('TIMEOUT', 'Canceled');
      },
    }).discover([{ method: 'dom.query' }]),
    { code: 'TIMEOUT' }
  );
});

test('an available capability snapshot never bypasses a later native dispatch check', async () => {
  let active = true;
  const h = harness({ getTab: async () => ({ active, windowId: 2 }) });
  const snapshot = await h.discover([{ method: 'input.fill' }], { executionMode: 'cdp' });
  assert.equal(snapshot.operations[0]?.status, 'available');
  active = false;
  const controller = createBackgroundInputController({
    getTab: h.dependencies.getTab,
    runWithDebugger: async () => {
      assert.fail('A stale capability snapshot must not permit debugger attachment');
    },
    sendCommand: async () => {
      assert.fail('No native event may be dispatched');
    },
    sendTabMessage: async () => {
      assert.fail('No target may be focused');
    },
    contentScriptTimeoutMs: 1000,
  });
  const request = createRequest({
    id: crypto.randomUUID(),
    method: 'input.fill',
    tabId: 7,
    params: { target: { selector: '#field' }, value: 'replacement', executionMode: 'cdp' },
  });
  await assert.rejects(
    controller.handleNativeInput(
      request,
      {
        tabId: 7,
        windowId: 2,
        url: 'https://fixture.test/',
        title: 'Fixture',
      },
      request.params
    ),
    (error: unknown) => {
      assert(error instanceof BridgeError);
      const details = error.details as { reason: string; aftermath: { dispatch: string } };
      assert.equal(details.reason, 'inactive_native_keyboard_target');
      assert.equal(details.aftermath.dispatch, 'not_started');
      return true;
    }
  );
});
