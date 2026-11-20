import test from 'node:test';
import assert from 'node:assert/strict';

import { createFailure, createRequest } from '../../../protocol/src/index.js';
import { handleTabBoundRequest } from '../src/background-tab-bound.js';

const tab = { tabId: 7, windowId: 1, url: 'https://example.test/', title: 'Test page' };

function harness(installed: boolean) {
  const calls: string[] = [];
  const messages: Array<Record<string, unknown>> = [];
  const dependencies: Parameters<typeof handleTabBoundRequest>[1] = {
    resolveRequestTarget: async () => tab,
    ensureContentScript: async () => {},
    handleScreenshot: async () => ({}),
    handleNativeInput: async () => {
      throw new Error('must use DOM input');
    },
    sendTabMessage: async (_tabId, message) => {
      calls.push('dispatch');
      messages.push(message);
      return { clicked: true };
    },
    contentScriptTimeoutMs: 5000,
    toFailureResponse: (request, error) =>
      createFailure(request.id, 'INTERNAL_ERROR', String(error)),
    activitySignals: {
      install: async (tabId, frameId, channel) => {
        calls.push(`install:${tabId}:${frameId}:${channel.length > 0}`);
        return installed;
      },
      uninstall: async (tabId, frameId) => {
        calls.push(`uninstall:${tabId}:${frameId}`);
      },
    },
  };
  return { calls, messages, dependencies };
}

test('observed DOM input tracks page requests for the duration of the action', async () => {
  const { calls, messages, dependencies } = harness(true);
  const response = await handleTabBoundRequest(
    createRequest({
      id: 'observed-click',
      method: 'input.click',
      params: { target: { elementRef: 'el_test_1' }, executionMode: 'dom' },
    }),
    dependencies
  );
  assert.equal(response.ok, true);
  await Promise.resolve();
  assert.deepEqual(calls, ['install:7:0:true', 'dispatch', 'uninstall:7:0']);
  assert.equal(typeof messages[0].activityChannel, 'string');
});

test('unobserved input and failed installs keep the fixed observation window', async () => {
  const quiet = harness(true);
  await handleTabBoundRequest(
    createRequest({
      id: 'quiet-click',
      method: 'input.click',
      params: { target: { elementRef: 'el_test_1' }, executionMode: 'dom', observe: false },
    }),
    quiet.dependencies
  );
  assert.deepEqual(quiet.calls, ['dispatch']);
  assert.equal('activityChannel' in quiet.messages[0], false);

  const restricted = harness(false);
  await handleTabBoundRequest(
    createRequest({
      id: 'restricted-click',
      method: 'input.click',
      params: { target: { elementRef: 'el_test_1' }, executionMode: 'dom' },
    }),
    restricted.dependencies
  );
  assert.deepEqual(restricted.calls, ['install:7:0:true', 'dispatch']);
  assert.equal('activityChannel' in restricted.messages[0], false);
});
