import test from 'node:test';
import assert from 'node:assert/strict';

import { createChromeEvent } from '../../../tests/_helpers/chromeFake.ts';
import { createRequest, ERROR_CODES } from '../../protocol/src/index.js';
import type { BridgeRequest, BridgeResponse } from '../../protocol/src/types.js';
import type { ExtensionState } from '../src/background-state.js';
import { createPageRequestController } from '../src/background-page.js';

type DebuggerCommand = {
  method: string;
  params: Record<string, unknown>;
};

function createController() {
  const onUpdated = createChromeEvent();
  const onRemoved = createChromeEvent();
  const commands: DebuggerCommand[] = [];
  const state = {
    enabledWindow: {
      windowId: 5,
      title: 'Enabled',
      enabledAt: 1,
    },
  } as ExtensionState;
  const chromeObj = {
    windows: {
      async get() {
        return { id: 5 };
      },
    },
    tabs: {
      onUpdated,
      onRemoved,
      async get(tabId: number) {
        return {
          id: tabId,
          windowId: 5,
          title: 'Loading tab',
          url: 'https://example.com/loading',
          status: 'loading',
        };
      },
      async query() {
        return [
          {
            id: 21,
            windowId: 5,
            title: 'Active tab',
            url: 'https://example.com/active',
            status: 'complete',
          },
        ];
      },
    },
  } as unknown as typeof chrome;
  const controller = createPageRequestController(state, chromeObj, {
    async clearEnabledWindowIfGone() {
      return false;
    },
    async primeTabConsoleCapture() {},
    async readConsoleBuffer() {
      return { entries: [], dropped: 0 };
    },
    async ensureNetworkInterceptor() {},
    async readNetworkBuffer() {
      return { entries: [], dropped: 0 };
    },
    async runWithDebugger(tabId, operation) {
      return operation({ tabId });
    },
    async sendCommand(_target, method, params) {
      commands.push({ method, params });
      return { ok: true };
    },
  });

  return { controller, onUpdated, onRemoved, commands };
}

test('page request controller waits for matching load completion and ignores unrelated events', async () => {
  const { controller, onUpdated, onRemoved } = createController();
  const pending = controller.waitForTabComplete(21, 1_000);
  await Promise.resolve();

  onUpdated.dispatch(22, { status: 'complete' }, { id: 22 });
  onUpdated.dispatch(21, { status: 'loading' }, { id: 21 });
  onRemoved.dispatch(22);
  onUpdated.dispatch(21, { status: 'complete' }, { id: 21, status: 'complete' });

  assert.deepEqual(await pending, { id: 21, status: 'complete' });
});

test('page request controller rejects when a loading tab is removed', async () => {
  const { controller, onRemoved } = createController();
  const pending = controller.waitForTabComplete(21, 1_000);
  await Promise.resolve();

  onRemoved.dispatch(21);

  await assert.rejects(pending, {
    code: ERROR_CODES.TAB_MISMATCH,
    message: 'Tab was closed while waiting for load',
  });
});

test('page request controller handles CDP computed-style validation and dispatches valid requests', async () => {
  const { controller, commands } = createController();
  const invalid = await controller.handleCdpRequest({
    id: 'req-invalid-computed-style',
    method: 'cdp.get_computed_styles_for_node',
    tab_id: null,
    params: {},
    meta: { protocol_version: '1.0', token_budget: null },
  } as BridgeRequest);

  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, ERROR_CODES.INVALID_REQUEST);
  assert.equal(invalid.error.message, 'nodeId must be a finite number.');

  const valid = (await controller.handleCdpRequest(
    createRequest({
      id: 'req-valid-computed-style',
      method: 'cdp.get_computed_styles_for_node',
      params: { nodeId: 42 },
    })
  )) as BridgeResponse;

  assert.equal(valid.ok, true);
  assert.deepEqual(commands, [
    {
      method: 'CSS.getComputedStyleForNode',
      params: { nodeId: 42 },
    },
  ]);
});

test('page request controller can return current tab state without waiting for load', async () => {
  const { controller } = createController();

  const response = await controller.handleWaitForLoadState(
    createRequest({
      id: 'req-no-wait-load-state',
      method: 'page.wait_for_load_state',
      params: {
        waitForLoad: false,
      },
    })
  );

  assert.equal(response.ok, true);
  assert.deepEqual(response.result, {
    method: 'page.wait_for_load_state',
    tabId: 21,
    windowId: 5,
    url: 'https://example.com/loading',
    title: 'Loading tab',
    status: 'loading',
  });
});
