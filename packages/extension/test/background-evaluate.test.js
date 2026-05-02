// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { ERROR_CODES } from '../../protocol/src/index.js';
import { handlePageEvaluate } from '../src/background-evaluate.js';
import { makeRequest } from '../../../tests/_helpers/protocolFactories.js';

/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */

/**
 * @typedef {{
 *   resolveRequestTarget: (request: BridgeRequest, options?: { requireScriptable?: boolean }) => Promise<{ tabId: number, windowId: number, title: string, url: string }>,
 *   runWithDebugger: (tabId: number, operation: (debugTarget: chrome.debugger.Debuggee) => Promise<BridgeResponse>) => Promise<BridgeResponse>,
 *   sendCommand: (target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown>) => Promise<unknown>,
 * }} PageEvaluateDependencies
 */

/**
 * @param {Partial<PageEvaluateDependencies>} [overrides]
 */
function createDependencies(overrides = {}) {
  /** @type {Array<{ tabId: number, debugTarget: chrome.debugger.Debuggee | null }> } */
  const runs = [];
  /** @type {Array<{ target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown> }>} */
  const commands = [];

  /** @type {PageEvaluateDependencies & { runs: typeof runs, commands: typeof commands }} */
  const dependencies = {
    runs,
    commands,
    async resolveRequestTarget() {
      return {
        tabId: 21,
        windowId: 7,
        title: 'Example',
        url: 'https://example.com',
      };
    },
    async runWithDebugger(tabId, operation) {
      const debugTarget = /** @type {chrome.debugger.Debuggee} */ ({ tabId });
      runs.push({ tabId, debugTarget });
      return operation(debugTarget);
    },
    async sendCommand(target, method, params) {
      commands.push({ target, method, params });
      return {
        result: {
          type: 'number',
          value: 42,
        },
      };
    },
    ...overrides,
  };

  return dependencies;
}

test('handlePageEvaluate forwards normalized timeoutMs to Runtime.evaluate', async () => {
  const dependencies = createDependencies();

  const response = await handlePageEvaluate(
    makeRequest('page.evaluate', {
      id: 'req-eval-1',
      params: {
        expression: '2 + 2',
        timeoutMs: 12_345,
        awaitPromise: true,
        returnByValue: false,
      },
    }),
    dependencies
  );

  assert.deepEqual(dependencies.runs, [
    {
      tabId: 21,
      debugTarget: { tabId: 21 },
    },
  ]);
  assert.deepEqual(dependencies.commands, [
    {
      target: { tabId: 21 },
      method: 'Runtime.evaluate',
      params: {
        expression: '2 + 2',
        returnByValue: false,
        awaitPromise: true,
        timeout: 12_345,
        userGesture: true,
        generatePreview: false,
        replMode: true,
      },
    },
  ]);
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, {
    value: 42,
    type: 'number',
  });
});

test('handlePageEvaluate returns INVALID_REQUEST when expression is blank', async () => {
  const dependencies = createDependencies();

  const response = await handlePageEvaluate(
    makeRequest('page.evaluate', {
      id: 'req-eval-2',
      params: {
        expression: '',
      },
    }),
    dependencies
  );

  assert.deepEqual(dependencies.runs, []);
  assert.deepEqual(dependencies.commands, []);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INVALID_REQUEST);
  assert.equal(response.error.message, 'expression is required.');
});

test('handlePageEvaluate maps CDP exception details into an INTERNAL_ERROR response', async () => {
  /** @type {Array<{ target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown> }>} */
  const commands = [];
  const dependencies = createDependencies({
    async sendCommand(target, method, params) {
      commands.push({ target, method, params });
      return {
        exceptionDetails: {
          exception: {
            description: 'ReferenceError: missingValue is not defined',
          },
        },
      };
    },
  });

  const response = await handlePageEvaluate(
    makeRequest('page.evaluate', {
      id: 'req-eval-3',
      params: {
        expression: 'missingValue',
      },
    }),
    dependencies
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INTERNAL_ERROR);
  assert.equal(response.error.message, 'ReferenceError: missingValue is not defined');
  assert.equal(commands.length, 1);
});
