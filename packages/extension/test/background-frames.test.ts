import test from 'node:test';
import assert from 'node:assert/strict';

import { handleTabBoundRequest } from '../src/background-tab-bound.js';
import { createFailure, createRequest } from '../../protocol/src/index.js';
import type { BridgeMethod, BridgeRequest } from '../../protocol/src/types.js';

type FrameMessage = { frameId: number; method: string; params: Record<string, unknown> };

/**
 * Top frame (0) holds the page; frame 7 is a payment iframe with a "Pay now"
 * button and its own ref tag.
 */
function createDependencies(childHasMatch = true) {
  const sent: FrameMessage[] = [];
  const reply = (frameId: number, method: string, params: Record<string, unknown>) => {
    const target = (params.target ?? {}) as Record<string, unknown>;
    if (method === 'dom.probe_target') {
      const wantsPay = target.text === 'Pay now' || target.selector === '#pay';
      return { found: frameId === 7 ? wantsPay && childHasMatch : !wantsPay };
    }
    if (method === 'dom.find_by_text') {
      const match = frameId === 7 && params.text === 'Pay now' && childHasMatch;
      return {
        found: match,
        nodes: match ? [{ elementRef: 'el_pay7_1', tag: 'button' }] : [],
        count: match ? 1 : 0,
        scanned: 5,
        truncated: false,
        truncationReason: null,
      };
    }
    if (method === 'dom.get_accessibility_tree') {
      return {
        source: 'dom',
        format: 'outline',
        outline:
          frameId === 7 ? '- button "Pay now" [el_pay7_1]' : '- heading "Checkout" [el_top0_1]',
        count: 1,
        scanned: 3,
        truncated: false,
      };
    }
    return { clicked: true, elementRef: 'el_pay7_1', frameSeen: frameId };
  };
  const dependencies = {
    contentScriptTimeoutMs: 1000,
    async resolveRequestTarget() {
      return { tabId: 5, windowId: 1, title: 'Checkout', url: 'https://shop.test/' };
    },
    async ensureContentScript() {},
    async handleScreenshot() {
      return {};
    },
    async handleNativeInput() {
      return {};
    },
    async sendTabMessage(_tabId: number, message: Record<string, unknown>) {
      sent.push({
        frameId: 0,
        method: String(message.method),
        params: message.params as Record<string, unknown>,
      });
      return reply(0, String(message.method), message.params as Record<string, unknown>);
    },
    toFailureResponse: (request: BridgeRequest, error: unknown) =>
      createFailure(request.id, 'INTERNAL_ERROR', String(error)),
    frames: {
      async listFrames() {
        return [
          { frameId: 0, tag: 'top0' },
          { frameId: 7, tag: 'pay7' },
        ];
      },
      async getFrameForRef(_tabId: number, elementRef: string) {
        return elementRef.startsWith('el_pay7_') ? 7 : 0;
      },
      async sendFrameMessage(_tabId: number, frameId: number, message: Record<string, unknown>) {
        sent.push({
          frameId,
          method: String(message.method),
          params: message.params as Record<string, unknown>,
        });
        return reply(frameId, String(message.method), message.params as Record<string, unknown>);
      },
    },
  };
  return { dependencies, sent };
}

function request(method: BridgeMethod, params: Record<string, unknown>) {
  return createRequest({ id: `frames-${method}-${Math.random()}`, method, params });
}

test('locator inputs not found in the top frame run in the iframe that has them', async () => {
  const { dependencies, sent } = createDependencies();
  const response = await handleTabBoundRequest(
    request('input.click', { target: { text: 'Pay now' } }),
    dependencies as never
  );
  assert.equal(response.ok, true);
  const click = sent.find((message) => message.method === 'input.click');
  assert.equal(click?.frameId, 7);
  if (response.ok) assert.equal((response.result as { frameId?: number }).frameId, 7);
});

test('element refs route to the frame that minted them', async () => {
  const { dependencies, sent } = createDependencies();
  await handleTabBoundRequest(
    request('input.click', { target: { elementRef: 'el_pay7_1' } }),
    dependencies as never
  );
  assert.deepEqual(
    sent.map((message) => [message.method, message.frameId]),
    [['input.click', 7]]
  );
});

test('cdp input is rejected for iframe targets instead of clicking wrong coordinates', async () => {
  const { dependencies } = createDependencies();
  await assert.rejects(
    handleTabBoundRequest(
      request('input.click', { target: { elementRef: 'el_pay7_1' }, executionMode: 'cdp' }),
      dependencies as never
    ),
    /does not support targets inside iframes/
  );
});

test('finders fan out to child frames when the top frame has no match', async () => {
  const { dependencies } = createDependencies();
  const response = await handleTabBoundRequest(
    request('dom.find_by_text', { text: 'Pay now' }),
    dependencies as never
  );
  assert.equal(response.ok, true);
  if (response.ok) {
    const result = response.result as { found: boolean; nodes: Array<Record<string, unknown>> };
    assert.equal(result.found, true);
    assert.deepEqual(result.nodes, [{ elementRef: 'el_pay7_1', tag: 'button', frameId: 7 }]);
  }
});

test('the DOM outline includes iframe sections', async () => {
  const { dependencies } = createDependencies();
  const response = await handleTabBoundRequest(
    request('dom.get_accessibility_tree', { source: 'dom' }),
    dependencies as never
  );
  assert.equal(response.ok, true);
  if (response.ok) {
    assert.equal(
      (response.result as { outline: string }).outline,
      '- heading "Checkout" [el_top0_1]\n- iframe [frame 7]\n  - button "Pay now" [el_pay7_1]'
    );
  }
});
