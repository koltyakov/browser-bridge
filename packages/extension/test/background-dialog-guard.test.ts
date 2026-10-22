import test from 'node:test';
import assert from 'node:assert/strict';

import { BridgeError, createFailure, createRequest } from '../../../protocol/src/index.js';
import { handlePageEvaluate } from '../src/background-evaluate.js';
import { createBackgroundInputController } from '../src/background-input.js';
import { handleTabBoundRequest } from '../src/background-tab-bound.js';
import { TabDebuggerCoordinator } from '../src/debugger-coordinator.js';

const tab = { tabId: 7, windowId: 1, url: 'https://example.test/', title: 'Test page' };

function createHarness() {
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => {},
  });
  let finishCommand!: (value: Record<string, unknown>) => void;
  const pending = new Promise<Record<string, unknown>>((resolve) => {
    finishCommand = resolve;
  });
  const block = () => {
    assert.equal(coordinator.attachedTabs.has(7), true, 'observe before dispatching the action');
    coordinator.handleEvent(7, 'Page.javascriptDialogOpening', {
      type: 'alert',
      message: 'The expression is invalid.',
    });
    return pending;
  };
  const dismiss = async () => {
    await coordinator.runForDialog(7, async () => {
      coordinator.handleEvent(7, 'Page.javascriptDialogClosed', {});
      finishCommand({});
    });
    await coordinator.run(7, async () => {});
    await coordinator.discard(7);
  };
  return { coordinator, block, dismiss };
}

for (const childFrame of [false, true]) {
  test(`DOM input returns DIALOG_BLOCKED without waiting for the ${childFrame ? 'child' : 'top'} frame`, async () => {
    const { coordinator, block, dismiss } = createHarness();
    const dependencies: Parameters<typeof handleTabBoundRequest>[1] = {
      resolveRequestTarget: async () => tab,
      ensureContentScript: async () => {},
      assertNoDialog: (tabId) => coordinator.assertNoDialog(tabId),
      runWithDialogGuard: (tabId, operation) => coordinator.runGuarded(tabId, operation),
      handleScreenshot: async () => ({}),
      handleNativeInput: async () => {
        throw new Error('must use DOM input');
      },
      sendTabMessage: async () => block(),
      contentScriptTimeoutMs: 5000,
      toFailureResponse: (request, error) =>
        createFailure(request.id, 'INTERNAL_ERROR', String(error)),
      ...(childFrame
        ? {
            frames: {
              listFrames: async () => [],
              getFrameForRef: async () => 3,
              sendFrameMessage: async () => block(),
            },
          }
        : {}),
    };
    await assert.rejects(
      handleTabBoundRequest(
        createRequest({
          id: 'guard-dom-edit',
          method: 'input.fill',
          params: { target: { elementRef: 'el_test_1' }, value: 'invalid', executionMode: 'dom' },
        }),
        dependencies
      ),
      { code: 'DIALOG_BLOCKED' }
    );
    // Subsequent reads/edits fail before trying to reach the paused content script.
    dependencies.ensureContentScript = async () => assert.fail('must not wait on a blocked page');
    await assert.rejects(
      handleTabBoundRequest(
        createRequest({
          id: 'guard-dom-read',
          method: 'dom.query',
          params: { selector: 'input' },
        }),
        dependencies
      ),
      { code: 'DIALOG_BLOCKED' }
    );
    await dismiss();
  });
}

for (const phase of ['command', 'observation']) {
  test(`native input detects a dialog during ${phase} and never dispatches another edit`, async () => {
    const { coordinator, block, dismiss } = createHarness();
    let commands = 0;
    const controller = createBackgroundInputController({
      getTab: async () => ({ active: true }),
      runWithDebugger: (tabId, operation) => coordinator.runGuarded(tabId, operation),
      sendCommand: async (target) => {
        coordinator.assertTaskActive(target);
        commands += 1;
        return phase === 'command' ? block() : {};
      },
      sendTabMessage: async (_tabId, message) => {
        if (message.method === 'input.observe_start') return { observationId: 'obs_test' };
        if (message.method === 'input.observe_finish') return block();
        return {};
      },
      contentScriptTimeoutMs: 5000,
    });
    await assert.rejects(
      controller.handleNativeInput(
        createRequest({ id: 'guard-native', method: 'input.press_key', params: { key: 'Enter' } }),
        tab,
        {
          key: 'Enter',
          observe: phase === 'observation' ? { settleMs: 10 } : null,
        }
      ),
      { code: 'DIALOG_BLOCKED' }
    );
    await dismiss();
    assert.equal(commands, phase === 'command' ? 1 : 2);
  });
}

test('evaluation returns DIALOG_BLOCKED while Runtime.evaluate is still pending', async () => {
  const { coordinator, block, dismiss } = createHarness();
  let evaluations = 0;
  await assert.rejects(
    handlePageEvaluate(
      createRequest({
        id: 'guard-evaluate',
        method: 'page.evaluate',
        params: { expression: 'alert("invalid")' },
      }),
      {
        resolveRequestTarget: async () => tab,
        runWithDebugger: (tabId, operation) => coordinator.runGuarded(tabId, operation),
        sendCommand: async () => {
          evaluations += 1;
          return block();
        },
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'DIALOG_BLOCKED');
      return true;
    }
  );
  await dismiss();
  assert.equal(evaluations, 1);
});
