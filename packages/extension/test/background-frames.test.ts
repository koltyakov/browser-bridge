import test from 'node:test';
import assert from 'node:assert/strict';

import { handleTabBoundRequest } from '../src/background-tab-bound.js';
import { enrichBridgeResponse } from '../src/background-action-log.js';
import { createFailure, createRequest } from '../../../protocol/src/index.js';
import type { BridgeMethod, BridgeRequest } from '../../../protocol/src/types.js';

type FrameMessage = { frameId: number; method: string; params: Record<string, unknown> };

/**
 * Top frame (0) holds the page; frame 7 is a payment iframe with a "Pay now"
 * button and its own ref tag.
 */
function createDependencies(
  childHasMatch = true,
  read?: (frameId: number, method: string, params: Record<string, unknown>) => unknown
) {
  const sent: FrameMessage[] = [];
  const reply = (frameId: number, method: string, params: Record<string, unknown>) => {
    const overridden = read?.(frameId, method, params);
    if (overridden !== undefined) return overridden;
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
  const outlineRequest = request('dom.get_accessibility_tree', { source: 'dom' });
  const response = await handleTabBoundRequest(outlineRequest, dependencies as never);
  assert.equal(response.ok, true);
  assert.equal(response.meta.debugger_backed, false);
  assert.equal(enrichBridgeResponse(outlineRequest, response).meta.debugger_backed, false);
  if (response.ok) {
    assert.equal(
      (response.result as { outline: string }).outline,
      '- heading "Checkout" [el_top0_1]\n- iframe [frame 7]\n  - button "Pay now" [el_pay7_1]'
    );
  }
});

test('finder shell matches do not hide iframe controls and share one result budget', async () => {
  for (const method of ['dom.find_by_text', 'dom.find_by_role'] as const) {
    for (const maxResults of [1, 2]) {
      const { dependencies } = createDependencies(true, (frameId, readMethod) =>
        readMethod === method
          ? {
              found: true,
              nodes: [{ elementRef: frameId === 0 ? 'el_top0_1' : 'el_pay7_1' }],
              count: 1,
              scanned: 5,
              truncated: false,
            }
          : undefined
      );
      const response = await handleTabBoundRequest(
        request(method, { text: 'Close', role: 'button', name: 'Close', maxResults }),
        dependencies as never
      );
      assert.equal(response.ok, true);
      const result = response.result as {
        nodes: Array<{ elementRef: string; frameId?: number }>;
        count: number;
        scanned: number;
        truncated: boolean;
      };
      assert.equal(result.count, maxResults);
      assert.equal(result.scanned, 10);
      assert.equal(result.truncated, maxResults === 1);
      assert.deepEqual(result.nodes[0], { elementRef: 'el_top0_1' });
      if (maxResults === 2)
        assert.deepEqual(result.nodes[1], { elementRef: 'el_pay7_1', frameId: 7 });
    }
  }
});

test('selector-scoped DOM outlines route to the owning child frame', async () => {
  const { dependencies, sent } = createDependencies();
  const response = await handleTabBoundRequest(
    request('dom.get_accessibility_tree', { source: 'dom', selector: '#pay' }),
    dependencies as never
  );
  assert.equal(response.ok, true);
  assert.deepEqual(
    sent
      .filter((entry) => entry.method === 'dom.get_accessibility_tree')
      .map((entry) => entry.frameId),
    [7]
  );
  assert.equal((response.result as { frameId: number }).frameId, 7);
});

test('DOM waits rediscover a child frame created after the wait starts', async () => {
  const { dependencies, sent } = createDependencies(true, (_frameId, method) =>
    method === 'dom.wait_for' ? { found: true, elementRef: 'el_pay7_1', duration: 0 } : undefined
  );
  let discoveries = 0;
  dependencies.frames.listFrames = async (_tabId?: number, options?: { refresh?: boolean }) => {
    assert.equal(options?.refresh, true);
    discoveries += 1;
    return discoveries === 1
      ? [{ frameId: 0, tag: 'top0' }]
      : [
          { frameId: 0, tag: 'top0' },
          { frameId: 7, tag: 'pay7' },
        ];
  };
  const response = await handleTabBoundRequest(
    request('dom.wait_for', { selector: '#pay', state: 'visible', timeoutMs: 1000 }),
    dependencies as never
  );
  assert.equal(response.ok, true);
  const result = response.result as { found: boolean; frameId: number; duration: number };
  assert.equal(result.found, true);
  assert.equal(result.frameId, 7);
  assert(result.duration >= 90);
  assert.deepEqual(
    sent.filter((entry) => entry.method === 'dom.wait_for').map((entry) => entry.frameId),
    [7]
  );
});

test('text waits select the matching frame rather than the first wildcard selector', async () => {
  const { dependencies, sent } = createDependencies(true, (frameId, method, params) => {
    if (method === 'dom.probe_target') {
      assert.equal(params.waitText, 'Pay now');
      return { found: frameId === 7 };
    }
    return method === 'dom.wait_for'
      ? { found: true, elementRef: 'el_pay7_1', duration: 0 }
      : undefined;
  });
  const response = await handleTabBoundRequest(
    request('dom.wait_for', { text: 'Pay now', timeoutMs: 1000 }),
    dependencies as never
  );
  assert.equal(response.ok, true);
  assert.equal(sent.find((entry) => entry.method === 'dom.wait_for')?.frameId, 7);
});

test('DOM waits report timeout without sending a long wait to the wrong frame', async () => {
  const { dependencies, sent } = createDependencies(false);
  const response = await handleTabBoundRequest(
    request('dom.wait_for', { selector: '#pay', timeoutMs: 100 }),
    dependencies as never
  );
  assert.equal(response.ok, true);
  const result = response.result as { found: boolean; duration: number };
  assert.equal(result.found, false);
  assert(result.duration >= 90);
  assert.equal(sent.filter((entry) => entry.method === 'dom.wait_for').length, 0);
});

test('page text includes child frames without exceeding the combined text budget', async () => {
  const childText = 'Dashboard widgets '.repeat(10).trim();
  const { dependencies } = createDependencies(true, (frameId, method) =>
    method === 'page.get_text'
      ? {
          value: frameId === 0 ? 'Shell' : childText,
          length: frameId === 0 ? 5 : childText.length,
          omitted: 0,
          truncated: false,
        }
      : undefined
  );
  for (const textBudget of [100, 300]) {
    const response = await handleTabBoundRequest(
      request('page.get_text', { textBudget }),
      dependencies as never
    );
    assert.equal(response.ok, true);
    const result = response.result as {
      value: string;
      length: number;
      omitted: number;
      truncated: boolean;
    };
    const full = `Shell\n[frame 7]\n${childText}`;
    assert.equal(result.value, full.slice(0, textBudget));
    assert.equal(result.length, full.length);
    assert.equal(result.omitted, Math.max(0, full.length - textBudget));
    assert.equal(result.truncated, full.length > textBudget);
  }
});

test('unscoped DOM outlines share a node budget in both formats', async () => {
  for (const format of ['tree', 'outline']) {
    const { dependencies } = createDependencies(true, (frameId, method) => {
      if (method !== 'dom.get_accessibility_tree') return undefined;
      const nodes = Array.from({ length: 8 }, (_, index) => ({
        ref: `el_${frameId}_${index}`,
        role: 'button',
      }));
      return {
        format,
        source: 'dom',
        nodes,
        outline: nodes.map((node) => `- button [${node.ref}]`).join('\n'),
        count: 8,
        scanned: 10,
        truncated: false,
      };
    });
    const response = await handleTabBoundRequest(
      request('dom.get_accessibility_tree', { source: 'dom', format, maxNodes: 10 }),
      dependencies as never
    );
    const result = response.result as {
      nodes: unknown[];
      outline: string;
      count: number;
      truncated: boolean;
    };
    assert.equal(result.count, 10);
    assert.equal(result.truncated, true);
    if (format === 'tree') assert.equal(result.nodes.length, 10);
    else
      assert.equal(
        result.outline.split('\n').filter((line) => line.includes('- button')).length,
        10
      );
  }
});

test('failed child reads are reported as incomplete rather than silently complete', async () => {
  const { dependencies } = createDependencies(true, (frameId, method) =>
    frameId === 7 && method === 'dom.find_by_text' ? { error: { code: 'TIMEOUT' } } : undefined
  );
  const response = await handleTabBoundRequest(
    request('dom.find_by_text', { text: 'Pay now' }),
    dependencies as never
  );
  assert.equal(response.ok, true);
  const result = response.result as { truncated: boolean; incompleteFrames: number[] };
  assert.equal(result.truncated, true);
  assert.deepEqual(result.incompleteFrames, [7]);
});
