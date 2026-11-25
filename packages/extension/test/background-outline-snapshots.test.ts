import test from 'node:test';
import assert from 'node:assert/strict';

import { handleTabBoundRequest } from '../src/background-tab-bound.js';
import {
  OUTLINE_SNAPSHOT_TTL_MS,
  createOutlineSnapshotStore,
  mergeOutlineDeltas,
} from '../src/background-outline-snapshots.js';
import { createFailure, createRequest } from '../../../protocol/src/index.js';
import type { BridgeRequest } from '../../../protocol/src/types.js';

type Sent = { frameId: number; params: Record<string, unknown> };
type Reply = (frameId: number, params: Record<string, unknown>) => Record<string, unknown>;

/** Tab-bound dependencies for outline reads in a tab with the given frames. */
function harness(reply: Reply, initialFrames: number[] = [0]) {
  const sent: Sent[] = [];
  let minted = 0;
  const state = { tabId: 5, frames: initialFrames, selectorFrame: 0 };
  const store = createOutlineSnapshotStore({ mint: () => `ol_test${(minted += 1)}` });
  const answer = (frameId: number, message: Record<string, unknown>) => {
    const params = message.params as Record<string, unknown>;
    if (message.method === 'dom.probe_target') return { found: frameId === state.selectorFrame };
    sent.push({ frameId, params });
    return reply(frameId, params);
  };
  const dependencies = {
    contentScriptTimeoutMs: 1000,
    outlineSnapshots: store,
    async resolveRequestTarget() {
      return { tabId: state.tabId, windowId: 1, title: 'Shop', url: 'https://shop.test/' };
    },
    async ensureContentScript() {},
    async handleScreenshot() {
      return {};
    },
    async handleNativeInput() {
      return {};
    },
    async sendTabMessage(_tabId: number, message: Record<string, unknown>) {
      return answer(0, message);
    },
    toFailureResponse: (request: BridgeRequest, error: unknown) =>
      createFailure(request.id, 'INTERNAL_ERROR', String(error)),
    frames: {
      async listFrames() {
        return state.frames.map((frameId) => ({ frameId, tag: null }));
      },
      async getFrameForRef() {
        return 0;
      },
      async sendFrameMessage(_tabId: number, frameId: number, message: Record<string, unknown>) {
        return answer(frameId, message);
      },
    },
  };
  const read = async (params: Record<string, unknown> = {}) => {
    const response = await handleTabBoundRequest(
      createRequest({
        id: `outline-${Math.random()}`,
        method: 'dom.get_accessibility_tree',
        params: { source: 'dom', ...params },
      }),
      dependencies as never
    );
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.result as Record<string, unknown>;
  };
  return { sent, state, store, read };
}

/** Content result for one frame: full unless since was passed. */
function frameOutline(frameId: number, line: string, params: Record<string, unknown>) {
  const common = {
    source: 'dom',
    format: 'outline',
    count: 1,
    scanned: 4,
    truncated: false,
    snapshotId: params.snapshotId,
  };
  return params.since ? { ...common, unchanged: true } : { ...common, outline: line };
}

test('the store binds snapshots to tabs and explains each unusable base', () => {
  let now = 1_000;
  const store = createOutlineSnapshotStore({ now: () => now, mint: () => `ol_${now}` });
  const first = store.begin(5, null);
  assert.deepEqual(first, { snapshotId: 'ol_1000', since: null, base: null, unavailable: null });
  store.commit(5, first.snapshotId, [0, 7, 7], false);
  now += 1;
  const next = store.begin(5, 'ol_1000');
  assert.equal(next.since, 'ol_1000');
  assert.deepEqual(next.base?.frames, [0, 7]);
  assert.equal(store.begin(6, 'ol_1000').unavailable, 'navigated');
  assert.equal(store.begin(5, 'ol_unknown').unavailable, 'expired');

  store.commit(5, 'ol_cut', [0], true);
  assert.equal(store.begin(5, 'ol_cut').unavailable, 'base_truncated');

  for (const id of ['ol_a', 'ol_b', 'ol_c', 'ol_d']) store.commit(5, id, [0], false);
  store.commit(6, 'ol_other', [0], false);
  assert.equal(store.begin(5, 'ol_1000').unavailable, 'evicted');
  assert.equal(store.begin(6, 'ol_1000').unavailable, 'navigated');
  assert.equal(store.begin(6, 'ol_other').unavailable, null);

  now += OUTLINE_SNAPSHOT_TTL_MS + 1;
  assert.equal(store.begin(5, 'ol_d').unavailable, 'expired');
  store.commit(5, 'ol_e', [0], false);
  store.clearTab(5);
  assert.equal(store.begin(5, 'ol_e').unavailable, 'expired');
  store.commit(6, 'ol_f', [0], false);
  store.clearAll();
  assert.equal(store.size(), 0);
});

test('every frame stores its base under one background-minted snapshotId', async () => {
  const { read, sent, store } = harness(
    (frameId, params) =>
      frameOutline(
        frameId,
        frameId ? '- button "Pay" [el_7_1]' : '- heading "Cart" [el_0_1]',
        params
      ),
    [0, 7]
  );
  const base = await read();
  assert.equal(base.snapshotId, 'ol_test1');
  assert.equal(
    base.outline,
    '- heading "Cart" [el_0_1]\n- iframe [frame 7]\n  - button "Pay" [el_7_1]'
  );
  assert.deepEqual(
    sent.map((entry) => [entry.frameId, entry.params.snapshotId, entry.params.since]),
    [
      [0, 'ol_test1', undefined],
      [7, 'ol_test1', undefined],
    ]
  );
  sent.length = 0;
  const same = await read({ since: 'ol_test1' });
  assert.equal(same.unchanged, true);
  assert.equal(same.snapshotId, 'ol_test2');
  assert.equal(same.count, 2);
  assert.deepEqual(
    sent.map((entry) => [entry.frameId, entry.params.since]),
    [
      [0, 'ol_test1'],
      [7, 'ol_test1'],
    ]
  );
  assert.equal(store.size(), 2);
});

test('a child frame that appears between reads is reported as added', async () => {
  const { read, state } = harness((frameId, params) => {
    if (frameId === 9)
      return {
        ...frameOutline(9, '- button "Chat" [el_9_1]', {}),
        snapshotId: params.snapshotId,
        deltaUnavailable: 'navigated',
      };
    return frameOutline(frameId, '- heading "Cart" [el_0_1]', params);
  });
  await read();
  state.frames = [0, 9];
  const result = await read({ since: 'ol_test1' });
  assert.deepEqual(result.delta, {
    added: ['- iframe [frame 9]', '  - button "Chat" [el_9_1]'],
    changed: [],
    removed: [],
  });
  assert.equal(result.count, 2);
});

test('a child frame that navigates while the top frame does not replaces its lines', async () => {
  let navigated = false;
  const { read } = harness(
    (frameId, params) => {
      if (frameId === 7 && navigated)
        return {
          ...frameOutline(7, '- link "Receipt" [el_7b_1]', {}),
          snapshotId: params.snapshotId,
          deltaUnavailable: 'navigated',
        };
      return frameOutline(
        frameId,
        frameId ? '- button "Pay" [el_7_1]' : '- heading "Cart" [el_0_1]',
        params
      );
    },
    [0, 7]
  );
  await read();
  navigated = true;
  const result = await read({ since: 'ol_test1' });
  assert.deepEqual(result.delta, {
    added: ['- iframe [frame 7]', '  - link "Receipt" [el_7b_1]'],
    changed: [],
    removed: [],
    removedFrames: [7],
  });
});

test('a removed child frame is listed, and child deltas keep their frame section', async () => {
  const { read, state } = harness(
    (frameId, params) => {
      if (frameId === 8 && params.since)
        return {
          source: 'dom',
          format: 'outline',
          count: 1,
          scanned: 2,
          truncated: false,
          snapshotId: params.snapshotId,
          delta: { added: [], changed: ['- button "Pay 2" [el_8_1]'], removed: ['el_8_2'] },
        };
      return frameOutline(frameId, `- button "Frame ${frameId}" [el_${frameId}_1]`, params);
    },
    [0, 7, 8]
  );
  await read();
  state.frames = [0, 8];
  const result = await read({ since: 'ol_test1' });
  assert.deepEqual(result.delta, {
    added: [],
    changed: ['- iframe [frame 8]', '  - button "Pay 2" [el_8_1]'],
    removed: ['el_8_2'],
    removedFrames: [7],
  });
});

test('a page whose last child frame went away reports that frame', async () => {
  const { read, state } = harness(
    (frameId, params) => frameOutline(frameId, `- button "F${frameId}" [el_${frameId}_1]`, params),
    [0, 7]
  );
  await read();
  state.frames = [0];
  const result = await read({ since: 'ol_test1' });
  assert.deepEqual(result.delta, { added: [], changed: [], removed: [], removedFrames: [7] });
  assert.equal(result.count, 1);
  // The new snapshot no longer includes frame 7, so it is not reported twice.
  assert.equal((await read({ since: String(result.snapshotId) })).unchanged, true);
});

test('a full top-frame read asks every child for its full outline', async () => {
  const { read, sent } = harness(
    (frameId, params) => {
      if (frameId === 0 && params.since)
        return {
          ...frameOutline(0, '- heading "Cart" [el_0_1]', {}),
          snapshotId: params.snapshotId,
          deltaUnavailable: 'refs_pruned',
        };
      return frameOutline(frameId, `- button "F${frameId}" [el_${frameId}_1]`, params);
    },
    [0, 7]
  );
  await read();
  sent.length = 0;
  const result = await read({ since: 'ol_test1' });
  assert.equal(result.deltaUnavailable, 'refs_pruned');
  assert.match(String(result.outline), /iframe \[frame 7\]/);
  assert.deepEqual(
    sent.map((entry) => [entry.frameId, entry.params.since]),
    [
      [0, 'ol_test1'],
      [7, undefined],
    ]
  );
});

test('an ID from another tab never reaches a content script', async () => {
  const { read, sent, state } = harness((frameId, params) =>
    frameOutline(frameId, '- heading "Cart" [el_0_1]', params)
  );
  await read();
  state.tabId = 6;
  sent.length = 0;
  const result = await read({ since: 'ol_test1' });
  assert.equal(result.deltaUnavailable, 'navigated');
  assert.equal(result.outline, '- heading "Cart" [el_0_1]');
  assert.equal(sent[0].params.since, undefined);
});

test('a base taken in another frame maps to scope_changed', async () => {
  const { read, state } = harness(
    (frameId, params) =>
      params.since
        ? {
            ...frameOutline(frameId, '- button "Pay" [el_x_1]', {}),
            snapshotId: params.snapshotId,
            deltaUnavailable: 'navigated',
          }
        : frameOutline(frameId, '- button "Pay" [el_x_1]', params),
    [0, 7]
  );
  state.selectorFrame = 7;
  const base = await read({ selector: '#pay' });
  assert.equal(base.frameId, 7);
  state.selectorFrame = 0;
  const result = await read({ selector: '#pay', since: 'ol_test1' });
  assert.equal(result.deltaUnavailable, 'scope_changed');
});

test('a merged delta that a full read would cut falls back to a full read', async () => {
  let grown = false;
  const { read, sent } = harness(
    (frameId, params) => {
      // The child frame gains three lines after the base.
      const count = frameId === 7 && grown ? 8 : 5;
      const many = Array.from(
        { length: count },
        (_, index) => `- button "B${index}" [el_${frameId}_${index}]`
      );
      return {
        source: 'dom',
        format: 'outline',
        count,
        scanned: count,
        truncated: false,
        snapshotId: params.snapshotId,
        ...(!params.since
          ? { outline: many.join('\n') }
          : frameId === 7
            ? { delta: { added: many.slice(5), changed: [], removed: [] } }
            : { unchanged: true }),
      };
    },
    [0, 7]
  );
  // Each frame fits maxNodes alone; after the change both together do not.
  await read({ maxNodes: 10 });
  grown = true;
  sent.length = 0;
  const result = await read({ maxNodes: 10, since: 'ol_test1' });
  assert.equal(result.deltaUnavailable, 'base_truncated');
  assert.equal(result.count, 10);
  assert.equal(result.delta, undefined);
  assert.deepEqual(
    sent.map((entry) => [entry.frameId, entry.params.since]),
    [
      [0, 'ol_test1'],
      [7, 'ol_test1'],
      [0, undefined],
      [7, undefined],
    ]
  );
});

test('a content script without snapshot support returns no snapshotId', async () => {
  const { read, store } = harness(() => ({
    source: 'dom',
    format: 'outline',
    outline: '- heading "Cart" [el_0_1]',
    count: 1,
    scanned: 1,
    truncated: false,
  }));
  const result = await read();
  assert.equal(result.snapshotId, undefined);
  assert.equal(store.size(), 0);
});

test('tree deltas from child frames carry their frameId', () => {
  const merged = mergeOutlineDeltas({
    top: { source: 'dom', format: 'tree', count: 1, unchanged: true, snapshotId: 'ol_2' },
    children: [
      {
        frameId: 4,
        result: {
          count: 1,
          delta: {
            added: [{ ref: 'el_4_1', role: 'button', name: 'Go', depth: 0, states: [] }],
            changed: [],
            removed: [],
          },
        },
      },
    ],
    baseFrames: [0, 4],
    incompleteFrames: [],
    format: 'tree',
    maxNodes: 150,
    scanned: 3,
    truncated: false,
    frameMetadata: {},
  });
  assert.equal(merged.overflow, false);
  assert.deepEqual(merged.result.delta, {
    added: [{ ref: 'el_4_1', role: 'button', name: 'Go', depth: 0, states: [], frameId: 4 }],
    changed: [],
    removed: [],
  });
  assert.equal(merged.result.snapshotId, 'ol_2');
  assert.equal(merged.result.unchanged, undefined);
});
