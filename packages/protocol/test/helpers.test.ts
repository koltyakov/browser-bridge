import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';

import {
  BRIDGE_METHODS,
  BRIDGE_METHOD_REGISTRY,
  BridgeError,
  CAPABILITIES,
  DEFAULT_CAPABILITIES,
  DEBUGGER_BACKED_METHODS,
  ERROR_CODES,
  METHOD_CAPABILITIES,
  createBridgeMethodGroups,
  bridgeMethodNeedsTab,
  getBudgetPreset,
  getCostClass,
  getErrorRecovery,
  getMethodCapability,
  getMethodsByMaxComplexity,
  isBridgeMethod,
  isBudgetPresetName,
  isCapability,
  isDebuggerBackedMethod,
  parseJsonLines,
} from '../src/index.js';
import type { BridgeMethod, Capability } from '../src/types.js';

const EXPECTED_BRIDGE_METHOD_ORDER: readonly BridgeMethod[] = [
  'access.request',
  'skill.get_runtime_context',
  'setup.get_status',
  'setup.install',
  'log.tail',
  'health.ping',
  'daemon.metrics',
  'tabs.list',
  'tabs.create',
  'tabs.close',
  'tabs.activate',
  'page.get_state',
  'page.evaluate',
  'page.get_console',
  'page.wait_for_load_state',
  'page.get_storage',
  'page.get_text',
  'page.get_network',
  'network.intercept.add',
  'network.intercept.remove',
  'network.intercept.list',
  'network.intercept.clear',
  'navigation.navigate',
  'navigation.reload',
  'navigation.go_back',
  'navigation.go_forward',
  'dom.query',
  'dom.describe',
  'dom.get_text',
  'dom.get_attributes',
  'dom.wait_for',
  'dom.find_by_text',
  'dom.find_by_role',
  'dom.get_html',
  'dom.get_accessibility_tree',
  'layout.get_box_model',
  'layout.hit_test',
  'styles.get_computed',
  'styles.get_matched_rules',
  'viewport.scroll',
  'viewport.resize',
  'input.click',
  'input.focus',
  'input.type',
  'input.fill',
  'input.press_key',
  'input.set_checked',
  'input.select_option',
  'input.hover',
  'input.drag',
  'input.scroll_into_view',
  'screenshot.capture_region',
  'screenshot.capture_element',
  'screenshot.capture_full_page',
  'patch.apply_styles',
  'patch.apply_dom',
  'patch.list',
  'patch.rollback',
  'patch.commit_session_baseline',
  'cdp.get_document',
  'cdp.get_dom_snapshot',
  'cdp.get_box_model',
  'cdp.get_computed_styles_for_node',
  'cdp.dispatch_key_event',
  'performance.get_metrics',
];

class FakeSocket extends EventEmitter {
  encoding: BufferEncoding | null;
  destroyed: boolean;

  constructor() {
    super();
    this.encoding = null;
    this.destroyed = false;
  }

  setEncoding(encoding: BufferEncoding): void {
    this.encoding = encoding;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

test('capabilities helpers accept only declared capabilities and default unknown methods to null', () => {
  assert.deepEqual(CAPABILITIES, {
    PAGE_READ: 'page.read',
    PAGE_EVALUATE: 'page.evaluate',
    DOM_READ: 'dom.read',
    STYLES_READ: 'styles.read',
    LAYOUT_READ: 'layout.read',
    VIEWPORT_CONTROL: 'viewport.control',
    NAVIGATION_CONTROL: 'navigation.control',
    SCREENSHOT_PARTIAL: 'screenshot.partial',
    PATCH_DOM: 'patch.dom',
    PATCH_STYLES: 'patch.styles',
    CDP_DOM_SNAPSHOT: 'cdp.dom_snapshot',
    CDP_BOX_MODEL: 'cdp.box_model',
    CDP_STYLES: 'cdp.styles',
    CDP_INPUT: 'cdp.input',
    AUTOMATION_INPUT: 'automation.input',
    TABS_MANAGE: 'tabs.manage',
    PERFORMANCE_READ: 'performance.read',
    NETWORK_READ: 'network.read',
    NETWORK_INTERCEPT: 'network.intercept',
  });
  assert.deepEqual(DEFAULT_CAPABILITIES, [
    'page.read',
    'page.evaluate',
    'dom.read',
    'styles.read',
    'layout.read',
    'viewport.control',
    'navigation.control',
    'screenshot.partial',
    'patch.dom',
    'patch.styles',
    'automation.input',
    'cdp.dom_snapshot',
    'cdp.box_model',
    'cdp.styles',
    'cdp.input',
    'tabs.manage',
    'performance.read',
    'network.read',
    'network.intercept',
  ]);
  assert.equal(isCapability(CAPABILITIES.PAGE_READ), true);
  assert.equal(isCapability('page.read '), false);
  assert.equal(isCapability('not-a-capability'), false);

  for (const capability of DEFAULT_CAPABILITIES) {
    assert.equal(
      isCapability(capability),
      true,
      `expected valid default capability: ${capability}`
    );
  }

  assert.equal(getMethodCapability('styles.get_computed'), CAPABILITIES.STYLES_READ);
  assert.equal(getMethodCapability('input.drag'), CAPABILITIES.AUTOMATION_INPUT);
  assert.equal(getMethodCapability('unknown.method' as unknown as BridgeMethod), null);
});

test('error helpers expose recovery guidance for known codes and preserve BridgeError details', () => {
  const timeoutRecovery = getErrorRecovery(ERROR_CODES.TIMEOUT);
  assert.deepEqual(timeoutRecovery, {
    retry: true,
    retryAfterMs: 1000,
    hint: 'Operation exceeded the time limit. Retry once, or simplify the request (smaller maxNodes, narrower selector).',
  });

  const truncationRecovery = getErrorRecovery(ERROR_CODES.RESULT_TRUNCATED);
  assert.ok(truncationRecovery);
  assert.equal(truncationRecovery.retry, false);
  assert.match(truncationRecovery.hint, /truncated/i);
  assert.match(getErrorRecovery(ERROR_CODES.ELEMENT_STALE)?.hint ?? '', /recoverStale=true/);
  assert.match(getErrorRecovery(ERROR_CODES.INPUT_UNSUPPORTED)?.hint ?? '', /executionMode=dom/);
  assert.match(getErrorRecovery(ERROR_CODES.INPUT_INVALID_TARGET)?.hint ?? '', /not compatible/);
  assert.match(getErrorRecovery(ERROR_CODES.INPUT_FOCUS_CHANGED)?.hint ?? '', /Focus moved/);
  assert.equal(getErrorRecovery('NOT_REAL'), null);

  const error = new BridgeError(ERROR_CODES.INVALID_REQUEST, 'Bad request', { field: 'method' });
  assert.equal(error instanceof Error, true);
  assert.equal(error.name, 'BridgeError');
  assert.equal(error.code, ERROR_CODES.INVALID_REQUEST);
  assert.deepEqual(error.details, { field: 'method' });
});

test('defaults helpers normalize invalid preset names, classify cost boundaries, and flag debugger-backed methods', () => {
  assert.equal(isBudgetPresetName('quick'), true);
  assert.equal(isBudgetPresetName('normal'), true);
  assert.equal(isBudgetPresetName('deep'), true);
  assert.equal(isBudgetPresetName('wide'), false);
  assert.equal(isBudgetPresetName(null), false);

  assert.deepEqual(getBudgetPreset('deep'), {
    maxNodes: 100,
    maxDepth: 8,
    textBudget: 2000,
    tokenBudget: 4000,
  });
  assert.equal(
    getBudgetPreset('wide' as unknown as Parameters<typeof getBudgetPreset>[0]),
    getBudgetPreset(null)
  );

  assert.equal(getCostClass(250), 'cheap');
  assert.equal(getCostClass(251), 'moderate');
  assert.equal(getCostClass(1000), 'moderate');
  assert.equal(getCostClass(1001), 'heavy');
  assert.equal(getCostClass(3000), 'heavy');
  assert.equal(getCostClass(3001), 'extreme');

  assert.equal(isDebuggerBackedMethod('page.evaluate'), true);
  assert.equal(isDebuggerBackedMethod('screenshot.capture_full_page'), true);
  assert.equal(isDebuggerBackedMethod('network.intercept.add'), true);
  assert.equal(isDebuggerBackedMethod('network.intercept.remove'), true);
  assert.equal(isDebuggerBackedMethod('network.intercept.list'), true);
  assert.equal(isDebuggerBackedMethod('network.intercept.clear'), true);
  assert.equal(isDebuggerBackedMethod('dom.query'), false);
});

test('parseJsonLines buffers partial chunks and skips blank or malformed lines', () => {
  const socket = new FakeSocket();
  const messages: unknown[] = [];

  parseJsonLines(socket as unknown as Socket, (message) => {
    messages.push(message);
  });

  assert.equal(socket.encoding, 'utf8');

  socket.emit('data', '{"id":1');
  assert.deepEqual(messages, []);

  socket.emit('data', '}\n\n  \n{"broken"\n  {"ok":true}\n{"nested":');
  assert.deepEqual(messages, [{ id: 1 }, { ok: true }]);

  socket.emit('data', '{"value":2}}\n');
  assert.deepEqual(messages, [{ id: 1 }, { ok: true }, { nested: { value: 2 } }]);
});

test('parseJsonLines closes sockets that exceed the line limit', () => {
  const socket = new FakeSocket();
  const errors: Error[] = [];

  parseJsonLines(socket as unknown as Socket, () => {}, {
    maxLineBytes: 8,
    onProtocolError: (error) => errors.push(error),
  });

  socket.emit('data', '{"oversized":true');

  assert.equal(socket.destroyed, true);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /JSON line exceeds 8 bytes/);
});

test('registry helpers keep metadata aligned across methods, groups, and complexity filtering', () => {
  assert.deepEqual(BRIDGE_METHODS, EXPECTED_BRIDGE_METHOD_ORDER);

  for (const method of BRIDGE_METHODS) {
    const entry = BRIDGE_METHOD_REGISTRY[method];
    assert.ok(entry.description.length > 0, `missing description for ${method}`);
    assert.equal(entry.since, '1.0');
    assert.equal(Array.isArray(entry.params), true, `params must be an array for ${method}`);
    assert.deepEqual(Object.keys(entry), [
      'group',
      'tab',
      'params',
      'description',
      'since',
      'complexity',
    ]);
    assert.equal(
      entry.capability === null || isCapability(entry.capability),
      true,
      `invalid capability for ${method}`
    );
    assert.equal(typeof entry.debuggerBacked, 'boolean');
  }

  assert.equal(isBridgeMethod('dom.query'), true);
  assert.equal(isBridgeMethod('dom.missing'), false);
  assert.equal(bridgeMethodNeedsTab('dom.query'), true);
  assert.equal(bridgeMethodNeedsTab('health.ping'), false);
  assert.equal(bridgeMethodNeedsTab('not.real'), true);

  const groups = createBridgeMethodGroups();
  const groupedMethods = Object.values(groups).flat();
  assert.equal(groupedMethods.length, BRIDGE_METHODS.length);
  assert.deepEqual(new Set(groupedMethods), new Set(BRIDGE_METHODS));

  assert.ok(getMethodsByMaxComplexity('trivial').includes('access.request'));
  assert.ok(getMethodsByMaxComplexity('trivial').includes('tabs.create'));
  assert.equal(getMethodsByMaxComplexity('trivial').includes('page.get_state'), false);

  assert.ok(getMethodsByMaxComplexity('moderate').includes('page.evaluate'));
  assert.ok(getMethodsByMaxComplexity('moderate').includes('input.drag'));
  assert.equal(getMethodsByMaxComplexity('moderate').includes('screenshot.capture_region'), false);

  assert.deepEqual(
    getMethodsByMaxComplexity(
      'invalid' as unknown as Parameters<typeof getMethodsByMaxComplexity>[0]
    ),
    []
  );
});

test('registry policies preserve every method capability classification', () => {
  const expectedGroups: ReadonlyArray<readonly [Capability | null, readonly BridgeMethod[]]> = [
    [
      null,
      [
        'access.request',
        'tabs.list',
        'skill.get_runtime_context',
        'setup.get_status',
        'setup.install',
        'log.tail',
        'health.ping',
        'daemon.metrics',
      ],
    ],
    [CAPABILITIES.TABS_MANAGE, ['tabs.create', 'tabs.close', 'tabs.activate']],
    [
      CAPABILITIES.PAGE_READ,
      [
        'page.get_state',
        'page.get_console',
        'page.wait_for_load_state',
        'page.get_storage',
        'page.get_text',
      ],
    ],
    [CAPABILITIES.PAGE_EVALUATE, ['page.evaluate']],
    [CAPABILITIES.NETWORK_READ, ['page.get_network']],
    [
      CAPABILITIES.NETWORK_INTERCEPT,
      [
        'network.intercept.add',
        'network.intercept.remove',
        'network.intercept.list',
        'network.intercept.clear',
      ],
    ],
    [
      CAPABILITIES.NAVIGATION_CONTROL,
      ['navigation.navigate', 'navigation.reload', 'navigation.go_back', 'navigation.go_forward'],
    ],
    [
      CAPABILITIES.DOM_READ,
      [
        'dom.query',
        'dom.describe',
        'dom.get_text',
        'dom.get_attributes',
        'dom.wait_for',
        'dom.find_by_text',
        'dom.find_by_role',
        'dom.get_html',
        'dom.get_accessibility_tree',
      ],
    ],
    [CAPABILITIES.LAYOUT_READ, ['layout.get_box_model', 'layout.hit_test']],
    [CAPABILITIES.STYLES_READ, ['styles.get_computed', 'styles.get_matched_rules']],
    [CAPABILITIES.VIEWPORT_CONTROL, ['viewport.scroll', 'viewport.resize']],
    [
      CAPABILITIES.AUTOMATION_INPUT,
      [
        'input.click',
        'input.focus',
        'input.type',
        'input.fill',
        'input.press_key',
        'input.set_checked',
        'input.select_option',
        'input.hover',
        'input.drag',
        'input.scroll_into_view',
      ],
    ],
    [
      CAPABILITIES.SCREENSHOT_PARTIAL,
      ['screenshot.capture_region', 'screenshot.capture_element', 'screenshot.capture_full_page'],
    ],
    [CAPABILITIES.PATCH_STYLES, ['patch.apply_styles']],
    [
      CAPABILITIES.PATCH_DOM,
      ['patch.apply_dom', 'patch.list', 'patch.rollback', 'patch.commit_session_baseline'],
    ],
    [CAPABILITIES.CDP_DOM_SNAPSHOT, ['cdp.get_document', 'cdp.get_dom_snapshot']],
    [CAPABILITIES.CDP_BOX_MODEL, ['cdp.get_box_model']],
    [CAPABILITIES.CDP_STYLES, ['cdp.get_computed_styles_for_node']],
    [CAPABILITIES.CDP_INPUT, ['cdp.dispatch_key_event']],
    [CAPABILITIES.PERFORMANCE_READ, ['performance.get_metrics']],
  ];
  const expected = new Map<BridgeMethod, Capability | null>();

  for (const [capability, methods] of expectedGroups) {
    for (const method of methods) {
      assert.equal(expected.has(method), false, `duplicate capability fixture for ${method}`);
      expected.set(method, capability);
    }
  }

  assert.equal(expected.size, BRIDGE_METHODS.length);
  assert.deepEqual(new Set(expected.keys()), new Set(BRIDGE_METHODS));
  const positionedMethods = new Set<BridgeMethod>([
    'access.request',
    'tabs.list',
    'tabs.create',
    'tabs.close',
    'tabs.activate',
    'skill.get_runtime_context',
    'setup.get_status',
    'setup.install',
    'log.tail',
    'health.ping',
    'daemon.metrics',
  ]);
  assert.deepEqual(Object.keys(METHOD_CAPABILITIES), [
    'access.request',
    'tabs.list',
    'tabs.create',
    'tabs.close',
    'tabs.activate',
    'skill.get_runtime_context',
    'setup.get_status',
    'setup.install',
    ...EXPECTED_BRIDGE_METHOD_ORDER.filter((method) => !positionedMethods.has(method)),
    'log.tail',
    'health.ping',
    'daemon.metrics',
  ]);

  for (const method of BRIDGE_METHODS) {
    assert.equal(BRIDGE_METHOD_REGISTRY[method].capability, expected.get(method), method);
    assert.equal(METHOD_CAPABILITIES[method], expected.get(method), method);
    assert.equal(getMethodCapability(method), expected.get(method), method);
  }
});

test('registry policies preserve debugger-backed method membership and order', () => {
  const expected: BridgeMethod[] = [
    'page.evaluate',
    'dom.get_accessibility_tree',
    'viewport.resize',
    'performance.get_metrics',
    'screenshot.capture_element',
    'screenshot.capture_region',
    'screenshot.capture_full_page',
    'network.intercept.add',
    'network.intercept.remove',
    'network.intercept.list',
    'network.intercept.clear',
    'cdp.get_document',
    'cdp.get_dom_snapshot',
    'cdp.get_box_model',
    'cdp.get_computed_styles_for_node',
    'cdp.dispatch_key_event',
  ];

  assert.deepEqual([...DEBUGGER_BACKED_METHODS], expected);
  assert.deepEqual(
    new Set(BRIDGE_METHODS.filter((method) => BRIDGE_METHOD_REGISTRY[method].debuggerBacked)),
    new Set(expected)
  );

  for (const method of BRIDGE_METHODS) {
    assert.equal(isDebuggerBackedMethod(method), expected.includes(method), method);
  }
});
