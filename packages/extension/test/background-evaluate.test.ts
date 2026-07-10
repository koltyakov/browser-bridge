import test from 'node:test';
import assert from 'node:assert/strict';

import { ERROR_CODES } from '../../protocol/src/index.js';
import type { BridgeRequest, BridgeResponse } from '../../protocol/src/types.js';
import { handlePageEvaluate } from '../src/background-evaluate.js';
import { makeRequest } from '../../../tests/_helpers/protocolFactories.ts';

type ResolvedTarget = {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
};

type PageEvaluateDependencies = {
  resolveRequestTarget: (
    request: BridgeRequest,
    options?: { requireScriptable?: boolean }
  ) => Promise<ResolvedTarget>;
  runWithDebugger: (
    tabId: number,
    operation: (debugTarget: chrome.debugger.Debuggee) => Promise<BridgeResponse>
  ) => Promise<BridgeResponse>;
  sendCommand: (
    target: chrome.debugger.Debuggee,
    method: string,
    params: Record<string, unknown>
  ) => Promise<unknown>;
};

type DebuggerRun = { tabId: number; debugTarget: chrome.debugger.Debuggee | null };
type DebuggerCommand = {
  target: chrome.debugger.Debuggee;
  method: string;
  params: Record<string, unknown>;
};

type TestDependencies = PageEvaluateDependencies & {
  runs: DebuggerRun[];
  commands: DebuggerCommand[];
};

function createDependencies(overrides: Partial<PageEvaluateDependencies> = {}): TestDependencies {
  const runs: DebuggerRun[] = [];
  const commands: DebuggerCommand[] = [];

  const dependencies: TestDependencies = {
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
    async runWithDebugger(tabId: number, operation) {
      const debugTarget = { tabId } as chrome.debugger.Debuggee;
      runs.push({ tabId, debugTarget });
      return operation(debugTarget);
    },
    async sendCommand(
      target: chrome.debugger.Debuggee,
      method: string,
      params: Record<string, unknown>
    ) {
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
  const commands: DebuggerCommand[] = [];
  const dependencies = createDependencies({
    async sendCommand(
      target: chrome.debugger.Debuggee,
      method: string,
      params: Record<string, unknown>
    ) {
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

test('handlePageEvaluate falls back through CDP exception text and default error copy', async () => {
  const textDependencies = createDependencies({
    async sendCommand() {
      return {
        exceptionDetails: {
          text: 'SyntaxError',
        },
      };
    },
  });
  const textResponse = await handlePageEvaluate(
    makeRequest('page.evaluate', {
      id: 'req-eval-text-error',
      params: { expression: 'bad(' },
    }),
    textDependencies
  );

  assert.equal(textResponse.ok, false);
  assert.equal(textResponse.error.message, 'SyntaxError');

  const defaultDependencies = createDependencies({
    async sendCommand() {
      return {
        exceptionDetails: {},
      };
    },
  });
  const defaultResponse = await handlePageEvaluate(
    makeRequest('page.evaluate', {
      id: 'req-eval-default-error',
      params: { expression: 'bad(' },
    }),
    defaultDependencies
  );

  assert.equal(defaultResponse.ok, false);
  assert.equal(defaultResponse.error.message, 'Evaluation failed.');
});

test('handlePageEvaluate defaults missing CDP result fields', async () => {
  const dependencies = createDependencies({
    async sendCommand() {
      return {};
    },
  });

  const response = await handlePageEvaluate(
    makeRequest('page.evaluate', {
      id: 'req-eval-missing-result',
      params: { expression: 'undefined' },
    }),
    dependencies
  );

  assert.equal(response.ok, true);
  assert.deepEqual(response.result, {
    value: null,
    type: 'undefined',
  });
});
