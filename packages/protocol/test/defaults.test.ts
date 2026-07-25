import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARTIFACT_CHUNK_BYTES,
  ARTIFACT_TTL_MS,
  BUDGET_PRESETS,
  CLIENT_REQUEST_TIMEOUT_MARGIN_MS,
  DAEMON_EXISTING_SOCKET_PING_TIMEOUT_MS,
  DAEMON_PENDING_TIMEOUT_MARGIN_MS,
  DAEMON_RECENT_LOG_LIMIT,
  DEBUGGER_BACKED_METHODS,
  DEFAULT_A11Y_MAX_DEPTH,
  DEFAULT_A11Y_MAX_NODES,
  DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
  DEFAULT_CONSOLE_LIMIT,
  DEFAULT_DAEMON_PENDING_TIMEOUT_MS,
  DEFAULT_DEVICE_SCALE_FACTOR,
  DEFAULT_EVAL_TIMEOUT_MS,
  DEFAULT_EXTRACT_SETTLE_TIMEOUT_MS,
  DEFAULT_HAR_LIMIT,
  DEFAULT_LOG_TAIL_LIMIT,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_HTML_LENGTH,
  DEFAULT_MAX_NODES,
  DEFAULT_NAV_TIMEOUT_MS,
  DEFAULT_NETWORK_INTERCEPT_ACTION,
  DEFAULT_NETWORK_LIMIT,
  DEFAULT_PAGE_TEXT_BUDGET,
  DEFAULT_TEXT_BUDGET,
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
  DEFAULT_WAIT_TIMEOUT_MS,
  DOM_BASELINE_TTL_MS,
  EXTRACT_SETTLE_QUIET_MS,
  HAR_AUTO_INLINE_BYTES,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_CLIENT_BYTES,
  MAX_ARTIFACT_TOTAL_BYTES,
  MAX_ARTIFACTS_PER_CLIENT,
  MAX_BATCH_CALLS,
  MAX_BATCH_CONCURRENCY,
  MAX_CLIENT_REQUEST_TIMEOUT_MS,
  MAX_DAEMON_PENDING_TIMEOUT_MS,
  MAX_DOM_BASELINE_BYTES,
  MAX_DOM_BASELINE_BYTES_GLOBAL,
  MAX_DOM_BASELINE_BYTES_PER_TAB,
  MAX_DOM_BASELINES_GLOBAL,
  MAX_DOM_BASELINES_PER_TAB,
  MAX_EXTRACT_SETTLE_TIMEOUT_MS,
  MAX_HAR_ENTRIES,
  MAX_JSON_LINE_BYTES,
  MAX_NATIVE_MESSAGE_BYTES,
  MAX_SENSITIVE_VALUE_BYTES,
  SCREENSHOT_AUTO_INLINE_BYTES,
  SCREENSHOT_MAX_INLINE_BYTES,
  getBudgetPreset,
  getCostClass,
  isBudgetPresetName,
  isDebuggerBackedMethod,
} from '../src/defaults.js';
import { BRIDGE_METHODS, BRIDGE_METHOD_REGISTRY } from '../src/registry.js';

test('default limits keep their documented scalar values', () => {
  assert.equal(DEFAULT_MAX_NODES, 25);
  assert.equal(DEFAULT_MAX_DEPTH, 4);
  assert.equal(DEFAULT_TEXT_BUDGET, 600);
  assert.equal(DEFAULT_PAGE_TEXT_BUDGET, 8000);
  assert.equal(DEFAULT_EXTRACT_SETTLE_TIMEOUT_MS, 2000);
  assert.equal(MAX_EXTRACT_SETTLE_TIMEOUT_MS, 10_000);
  assert.equal(EXTRACT_SETTLE_QUIET_MS, 100);
  assert.equal(DEFAULT_WAIT_TIMEOUT_MS, 5000);
  assert.equal(DEFAULT_EVAL_TIMEOUT_MS, 5000);
  assert.equal(DEFAULT_NAV_TIMEOUT_MS, 15_000);
  assert.equal(DEFAULT_MAX_HTML_LENGTH, 2000);
  assert.equal(DEFAULT_A11Y_MAX_NODES, 500);
  assert.equal(DEFAULT_A11Y_MAX_DEPTH, 6);
  assert.equal(DEFAULT_NETWORK_LIMIT, 50);
  assert.equal(DEFAULT_HAR_LIMIT, 50);
  assert.equal(MAX_HAR_ENTRIES, 200);
  assert.equal(HAR_AUTO_INLINE_BYTES, 262_144);
  assert.equal(DEFAULT_CONSOLE_LIMIT, 50);
  assert.equal(DEFAULT_VIEWPORT_WIDTH, 1280);
  assert.equal(DEFAULT_VIEWPORT_HEIGHT, 720);
  assert.equal(DEFAULT_DEVICE_SCALE_FACTOR, 0);
  assert.equal(DEFAULT_NETWORK_INTERCEPT_ACTION, 'continue');
  assert.equal(DEFAULT_LOG_TAIL_LIMIT, 20);
  assert.equal(DAEMON_RECENT_LOG_LIMIT, 200);
  assert.equal(DAEMON_EXISTING_SOCKET_PING_TIMEOUT_MS, 500);
});

test('byte and message limits keep their documented relationships', () => {
  assert.equal(MAX_NATIVE_MESSAGE_BYTES, 1_048_576);
  assert.equal(MAX_JSON_LINE_BYTES, MAX_NATIVE_MESSAGE_BYTES);
  assert.equal(MAX_SENSITIVE_VALUE_BYTES, 262_144);
  assert.equal(SCREENSHOT_AUTO_INLINE_BYTES, 262_144);
  assert.equal(SCREENSHOT_MAX_INLINE_BYTES, 524_288);
  assert.equal(ARTIFACT_CHUNK_BYTES, 196_608);
  assert.equal(MAX_ARTIFACT_BYTES, 33_554_432);
  assert.equal(MAX_ARTIFACT_CLIENT_BYTES, 67_108_864);
  assert.equal(MAX_ARTIFACT_TOTAL_BYTES, 268_435_456);
  assert.equal(MAX_ARTIFACTS_PER_CLIENT, 16);
  assert.equal(ARTIFACT_TTL_MS, 300_000);

  assert.equal(MAX_BATCH_CALLS, 20);
  assert.equal(MAX_BATCH_CONCURRENCY, 5);
  assert.ok(MAX_BATCH_CONCURRENCY <= MAX_BATCH_CALLS);
});

test('DOM baseline limits keep their documented values', () => {
  assert.equal(DOM_BASELINE_TTL_MS, 300_000);
  assert.equal(MAX_DOM_BASELINES_PER_TAB, 8);
  assert.equal(MAX_DOM_BASELINES_GLOBAL, 32);
  assert.equal(MAX_DOM_BASELINE_BYTES_PER_TAB, 1_048_576);
  assert.equal(MAX_DOM_BASELINE_BYTES_GLOBAL, 4_194_304);
  assert.equal(MAX_DOM_BASELINE_BYTES, 262_144);

  assert.ok(MAX_DOM_BASELINES_PER_TAB <= MAX_DOM_BASELINES_GLOBAL);
  assert.ok(MAX_DOM_BASELINE_BYTES <= MAX_DOM_BASELINE_BYTES_PER_TAB);
  assert.ok(MAX_DOM_BASELINE_BYTES_PER_TAB <= MAX_DOM_BASELINE_BYTES_GLOBAL);
});

test('daemon and client timeout windows stay ordered', () => {
  assert.equal(DEFAULT_DAEMON_PENDING_TIMEOUT_MS, 30_000);
  assert.equal(DAEMON_PENDING_TIMEOUT_MARGIN_MS, 2_000);
  assert.equal(MAX_DAEMON_PENDING_TIMEOUT_MS, 122_000);
  assert.equal(DEFAULT_CLIENT_REQUEST_TIMEOUT_MS, 8_000);
  assert.equal(CLIENT_REQUEST_TIMEOUT_MARGIN_MS, 4_000);
  assert.equal(MAX_CLIENT_REQUEST_TIMEOUT_MS, 124_000);

  assert.ok(DEFAULT_DAEMON_PENDING_TIMEOUT_MS <= MAX_DAEMON_PENDING_TIMEOUT_MS);
  assert.ok(DEFAULT_CLIENT_REQUEST_TIMEOUT_MS <= MAX_CLIENT_REQUEST_TIMEOUT_MS);
  assert.ok(MAX_CLIENT_REQUEST_TIMEOUT_MS > MAX_DAEMON_PENDING_TIMEOUT_MS);
});

test('BUDGET_PRESETS exposes the frozen quick, normal, and deep shapes', () => {
  assert.equal(Object.isFrozen(BUDGET_PRESETS), true);
  assert.deepEqual(Object.keys(BUDGET_PRESETS), ['quick', 'normal', 'deep']);

  assert.deepEqual(BUDGET_PRESETS.quick, {
    maxNodes: 5,
    maxDepth: 2,
    textBudget: 300,
    tokenBudget: 500,
  });
  assert.deepEqual(BUDGET_PRESETS.normal, {
    maxNodes: DEFAULT_MAX_NODES,
    maxDepth: DEFAULT_MAX_DEPTH,
    textBudget: DEFAULT_TEXT_BUDGET,
    tokenBudget: 1500,
  });
  assert.deepEqual(BUDGET_PRESETS.deep, {
    maxNodes: 100,
    maxDepth: 8,
    textBudget: 2000,
    tokenBudget: 4000,
  });
});

test('isBudgetPresetName accepts only declared preset names', () => {
  assert.equal(isBudgetPresetName('quick'), true);
  assert.equal(isBudgetPresetName('normal'), true);
  assert.equal(isBudgetPresetName('deep'), true);
  assert.equal(isBudgetPresetName('wide'), false);
  assert.equal(isBudgetPresetName(''), false);
  assert.equal(isBudgetPresetName(null), false);
  assert.equal(isBudgetPresetName(undefined), false);
  assert.equal(isBudgetPresetName(42), false);
  assert.equal(isBudgetPresetName({ name: 'quick' }), false);
});

test('getBudgetPreset returns presets by name and falls back to normal', () => {
  assert.equal(getBudgetPreset('quick'), BUDGET_PRESETS.quick);
  assert.equal(getBudgetPreset('normal'), BUDGET_PRESETS.normal);
  assert.equal(getBudgetPreset('deep'), BUDGET_PRESETS.deep);

  assert.equal(getBudgetPreset(null), BUDGET_PRESETS.normal);
  assert.equal(getBudgetPreset(undefined), BUDGET_PRESETS.normal);
  assert.equal(
    getBudgetPreset('wide' as unknown as Parameters<typeof getBudgetPreset>[0]),
    BUDGET_PRESETS.normal
  );
});

test('getCostClass classifies the documented token boundaries', () => {
  assert.equal(getCostClass(0), 'cheap');
  assert.equal(getCostClass(250), 'cheap');
  assert.equal(getCostClass(251), 'moderate');
  assert.equal(getCostClass(1000), 'moderate');
  assert.equal(getCostClass(1001), 'heavy');
  assert.equal(getCostClass(3000), 'heavy');
  assert.equal(getCostClass(3001), 'extreme');
  assert.equal(getCostClass(Number.MAX_SAFE_INTEGER), 'extreme');
});

test('DEBUGGER_BACKED_METHODS matches the registry debugger flags exactly', () => {
  const registryBacked = BRIDGE_METHODS.filter(
    (method) => BRIDGE_METHOD_REGISTRY[method].debuggerBacked
  );

  assert.deepEqual([...DEBUGGER_BACKED_METHODS].sort(), [...registryBacked].sort());

  for (const method of BRIDGE_METHODS) {
    assert.equal(
      isDebuggerBackedMethod(method),
      BRIDGE_METHOD_REGISTRY[method].debuggerBacked,
      `isDebuggerBackedMethod must mirror the registry flag for ${method}`
    );
  }

  assert.equal(isDebuggerBackedMethod('not.a.method'), false);
});
