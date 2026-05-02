// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  BRIDGE_METHODS,
  BRIDGE_METHOD_REGISTRY,
  BridgeError,
  CAPABILITIES,
  DEFAULT_CAPABILITIES,
  ERROR_CODES,
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

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    /** @type {string | null} */
    this.encoding = null;
  }

  /** @param {BufferEncoding} encoding */
  setEncoding(encoding) {
    this.encoding = encoding;
  }
}

test('capabilities helpers accept only declared capabilities and default unknown methods to null', () => {
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
  assert.equal(getMethodCapability(/** @type {any} */ ('unknown.method')), null);
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
  assert.equal(getBudgetPreset(/** @type {any} */ ('wide')), getBudgetPreset(null));

  assert.equal(getCostClass(250), 'cheap');
  assert.equal(getCostClass(251), 'moderate');
  assert.equal(getCostClass(1000), 'moderate');
  assert.equal(getCostClass(1001), 'heavy');
  assert.equal(getCostClass(3000), 'heavy');
  assert.equal(getCostClass(3001), 'extreme');

  assert.equal(isDebuggerBackedMethod('page.evaluate'), true);
  assert.equal(isDebuggerBackedMethod('dom.query'), false);
});

test('parseJsonLines buffers partial chunks and skips blank or malformed lines', () => {
  const socket = new FakeSocket();
  /** @type {unknown[]} */
  const messages = [];

  parseJsonLines(
    /** @type {import('node:net').Socket} */ (/** @type {unknown} */ (socket)),
    (message) => {
      messages.push(message);
    }
  );

  assert.equal(socket.encoding, 'utf8');

  socket.emit('data', '{"id":1');
  assert.deepEqual(messages, []);

  socket.emit('data', '}\n\n  \n{"broken"\n  {"ok":true}\n{"nested":');
  assert.deepEqual(messages, [{ id: 1 }, { ok: true }]);

  socket.emit('data', '{"value":2}}\n');
  assert.deepEqual(messages, [{ id: 1 }, { ok: true }, { nested: { value: 2 } }]);
});

test('registry helpers keep metadata aligned across methods, groups, and complexity filtering', () => {
  for (const method of BRIDGE_METHODS) {
    const entry = BRIDGE_METHOD_REGISTRY[method];
    assert.ok(entry.description.length > 0, `missing description for ${method}`);
    assert.equal(entry.since, '1.0');
    assert.equal(Array.isArray(entry.params), true, `params must be an array for ${method}`);
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

  assert.deepEqual(getMethodsByMaxComplexity(/** @type {any} */ ('invalid')), []);
});
