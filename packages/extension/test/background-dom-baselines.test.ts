import test from 'node:test';
import assert from 'node:assert/strict';

import { createDomBaselineController, DomBaselineError } from '../src/background-dom-baselines.js';
import { createDomBaselineRequestHandler } from '../src/background-dom-baseline-requests.js';
import { BridgeError, createRequest, ERROR_CODES } from '../../protocol/src/index.js';

type SnapshotNode = {
  nodeId: string;
  parentId: string | null;
  tag?: string;
  role?: string;
  name?: string | null;
  nameFingerprint?: string;
  textExcerpt?: string;
  textFingerprint?: string;
  attrs?: Record<string, { value: string; fingerprint: string }>;
  attrsFingerprint?: string;
  state?: Record<string, unknown>;
};

type Snapshot = {
  documentToken: string;
  representation: string;
  selector: string | null;
  nodes: SnapshotNode[];
};

function snapshot(nodes: SnapshotNode[], overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    documentToken: 'document-1',
    representation: 'semantic',
    selector: '#app',
    nodes,
    ...overrides,
  };
}

function node(nodeId: string, parentId: string | null, name = nodeId): SnapshotNode {
  return {
    nodeId,
    parentId,
    tag: nodeId === 'root' ? 'main' : 'button',
    role: nodeId === 'root' ? 'main' : 'button',
    name,
    nameFingerprint: name,
    textExcerpt: name,
    textFingerprint: name,
    attrs: {},
    attrsFingerprint: '',
    state: { disabled: false },
  };
}

function harness(start = 1_000) {
  let currentTime = start;
  let nextId = 0;
  let measure = 0;
  const controller = createDomBaselineController({
    now: () => currentTime,
    createId: () => String(nextId++).padStart(32, '0'),
    measureNow: () => measure++,
  });
  return {
    controller,
    setTime(value: number) {
      currentTime = value;
    },
  };
}

function createBaseline(
  controller: ReturnType<typeof createDomBaselineController>,
  value: Snapshot,
  overrides: Partial<{
    windowId: number;
    tabId: number;
    frameId: number;
    selector: string | null;
    options: Record<string, unknown>;
    now: number;
  }> = {}
) {
  return controller.create({
    windowId: 1,
    tabId: 10,
    frameId: 0,
    selector: '#app',
    options: { compact: true },
    snapshot: value,
    ...overrides,
  });
}

test('create returns immutable metadata without nodes and equal comparison is read-only', () => {
  const { controller, setTime } = harness();
  const value = snapshot([node('root', null), node('save', 'root')]);
  const descriptor = createBaseline(controller, value);

  assert.match(descriptor.baselineId, /^baseline_[A-Za-z0-9_-]{32,64}$/);
  assert.equal(descriptor.createdAt, new Date(1_000).toISOString());
  assert.equal(descriptor.expiresAt, new Date(301_000).toISOString());
  assert.deepEqual(descriptor.scope, {
    windowId: 1,
    tabId: 10,
    frameId: 0,
    selector: '#app',
    documentToken: 'document-1',
    representation: 'semantic',
  });
  assert.equal('nodes' in descriptor, false);
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(Object.isFrozen(descriptor.options), true);
  assert.equal(descriptor.snapshot.nodeCount, 2);
  assert.ok(descriptor.snapshot.byteLength > 0);

  setTime(300_999);
  const result = controller.compare(descriptor.baselineId, value, 10);
  assert.deepEqual(result.counts, {
    added: 0,
    removed: 0,
    changed: 0,
    moved: 0,
    unchanged: 2,
    total: 2,
  });
  assert.equal(result.equal, true);
  assert.equal(result.comparedAt, new Date(300_999).toISOString());
  assert.deepEqual(result.returnedCounts, {
    added: 0,
    removed: 0,
    changed: 0,
    moved: 0,
    total: 0,
  });
  assert.equal(result.truncated, false);
  assert.equal(controller.get(descriptor.baselineId).expiresAt, new Date(301_000).toISOString());
  assert.equal('nodes' in controller.describe(descriptor.baselineId), false);
});

test('compare reports exact added, removed, and semantic field changes', () => {
  const { controller } = harness();
  const before = snapshot([
    node('root', null),
    node('remove', 'root'),
    node('change', 'root', 'Before'),
  ]);
  const descriptor = createBaseline(controller, before);
  const after = snapshot([
    node('root', null),
    { ...node('change', 'root', 'After'), state: { disabled: true } },
    node('add', 'root'),
  ]);
  const result = controller.compare(descriptor.baselineId, after, 10);

  assert.deepEqual(result.counts, {
    added: 1,
    removed: 1,
    changed: 1,
    moved: 0,
    unchanged: 1,
    total: 4,
  });
  assert.equal(result.added[0]?.name, 'add');
  assert.equal(result.removed[0]?.name, 'remove');
  assert.deepEqual(result.changed[0]?.fields, ['name', 'text', 'state']);
});

test('compare detects parent moves and true surviving-sibling reorder at top roots only', () => {
  const { controller } = harness();
  const before = snapshot([
    node('root', null),
    node('other', null),
    node('a', 'root'),
    node('b', 'root'),
    node('c', 'root'),
    node('child', 'a'),
  ]);
  const descriptor = createBaseline(controller, before);
  const after = snapshot([
    node('root', null),
    node('other', null),
    node('c', 'root'),
    node('b', 'root'),
    node('a', 'other'),
    node('child', 'a'),
  ]);
  const result = controller.compare(descriptor.baselineId, after, 20);

  assert.equal(result.counts.moved, 3);
  assert.deepEqual(result.moved.map((item) => item.node.name).sort(), ['a', 'b', 'c']);
  assert.equal(
    result.moved.some((item) => item.node.name === 'child'),
    false
  );
});

test('compare retains an independently moved descendant when its former parent also moves', () => {
  const { controller } = harness();
  const before = snapshot([
    node('root', null),
    node('parent', 'root'),
    node('child', 'parent'),
    node('target', 'root'),
  ]);
  const descriptor = createBaseline(controller, before);
  const after = snapshot([
    node('root', null),
    node('target', 'root'),
    node('parent', 'target'),
    node('child', 'root'),
  ]);
  const result = controller.compare(descriptor.baselineId, after, 10);
  assert.equal(result.counts.moved, 2);
  assert.equal(result.counts.unchanged, 2);
});

test('compare retains descendant reorders inside reordered ancestors', () => {
  const { controller } = harness();
  const descriptor = createBaseline(
    controller,
    snapshot([
      node('root', null),
      node('section-a', 'root'),
      node('child-a', 'section-a'),
      node('child-b', 'section-a'),
      node('section-b', 'root'),
    ])
  );
  const result = controller.compare(
    descriptor.baselineId,
    snapshot([
      node('root', null),
      node('section-b', 'root'),
      node('section-a', 'root'),
      node('child-b', 'section-a'),
      node('child-a', 'section-a'),
    ]),
    10
  );
  assert.equal(result.counts.moved, 4);
  assert.deepEqual(result.moved.map((item) => item.node.name).sort(), [
    'child-a',
    'child-b',
    'section-a',
    'section-b',
  ]);
});

test('inserting before surviving siblings does not create false moves', () => {
  const { controller } = harness();
  const descriptor = createBaseline(
    controller,
    snapshot([node('root', null), node('a', 'root'), node('b', 'root')])
  );
  const result = controller.compare(
    descriptor.baselineId,
    snapshot([node('root', null), node('inserted', 'root'), node('a', 'root'), node('b', 'root')]),
    10
  );

  assert.equal(result.counts.added, 1);
  assert.equal(result.counts.moved, 0);
});

test('maxChanges bounds evidence while retaining exact per-category counts', () => {
  const { controller } = harness();
  const descriptor = createBaseline(
    controller,
    snapshot([node('root', null), node('remove-1', 'root'), node('remove-2', 'root')])
  );
  const result = controller.compare(
    descriptor.baselineId,
    snapshot([node('root', null), node('add-1', 'root'), node('add-2', 'root')]),
    2
  );

  assert.equal(result.counts.added, 2);
  assert.equal(result.counts.removed, 2);
  assert.equal(result.returnedCounts.added, 2);
  assert.equal(result.returnedCounts.removed, 0);
  assert.equal(result.removed.length, 0);
  assert.equal(result.omittedChanges, 2);
  assert.equal(result.truncated, true);
  assert.match(result.guidance, /Narrow the selector/);
});

test('baseline verification returns less agent payload than two equivalent snapshots', () => {
  const { controller } = harness();
  const before = snapshot([
    node('root', null),
    ...Array.from({ length: 40 }, (_, index) => node(`item-${index}`, 'root')),
  ]);
  const after = snapshot(
    before.nodes.map((item) =>
      item.nodeId === 'item-20' ? { ...item, name: 'changed', nameFingerprint: 'changed' } : item
    )
  );
  const descriptor = createBaseline(controller, before);
  const comparison = controller.compare(descriptor.baselineId, after, 10);
  const baselinePayloadBytes =
    Buffer.byteLength(JSON.stringify(descriptor)) + Buffer.byteLength(JSON.stringify(comparison));
  const snapshotPayloadBytes =
    Buffer.byteLength(JSON.stringify(before)) + Buffer.byteLength(JSON.stringify(after));
  assert.ok(baselinePayloadBytes < snapshotPayloadBytes);
});

test('semantically identical added and removed nodes are reported as ambiguous replacements', () => {
  const { controller } = harness();
  const descriptor = createBaseline(
    controller,
    snapshot([node('root', null), node('old-id', 'root', 'Same')])
  );
  const result = controller.compare(
    descriptor.baselineId,
    snapshot([node('root', null), node('new-id', 'root', 'Same')]),
    10
  );

  assert.equal(result.counts.added, 1);
  assert.equal(result.counts.removed, 1);
  assert.equal(result.ambiguity.count, 1);
  assert.equal(result.ambiguity.examples[0]?.name, 'Same');
  assert.match(result.guidance, /stable distinguishing attributes/);
});

test('scope mismatch is typed invalidation and does not delete or retarget the record', () => {
  const { controller } = harness();
  const original = snapshot([node('root', null)]);
  const descriptor = createBaseline(controller, original);

  assert.throws(
    () =>
      controller.compare(
        descriptor.baselineId,
        snapshot([node('root', null)], { documentToken: 'document-2' }),
        10
      ),
    (error: unknown) => {
      assert.ok(error instanceof DomBaselineError);
      assert.equal(error.code, 'DOM_BASELINE_INVALIDATED');
      assert.deepEqual(error.details, { reason: 'document_token_mismatch' });
      return true;
    }
  );
  assert.throws(
    () =>
      controller.compare(
        descriptor.baselineId,
        snapshot([node('root', null)], { representation: 'different' }),
        10
      ),
    (error: unknown) =>
      error instanceof DomBaselineError &&
      error.code === 'DOM_BASELINE_INVALIDATED' &&
      (error.details as { reason?: string }).reason === 'representation_mismatch'
  );
  assert.throws(
    () =>
      controller.compare(
        descriptor.baselineId,
        snapshot([node('root', null)], { selector: '#other' }),
        10
      ),
    (error: unknown) =>
      error instanceof DomBaselineError &&
      error.code === 'DOM_BASELINE_INVALIDATED' &&
      (error.details as { reason?: string }).reason === 'selector_mismatch'
  );
  assert.equal(controller.get(descriptor.baselineId), descriptor);
});

test('expiry is a typed not-found condition and pruneExpired removes expired records', () => {
  const first = harness();
  const descriptor = createBaseline(first.controller, snapshot([node('root', null)]));
  first.setTime(301_000);
  assert.throws(
    () => first.controller.get(descriptor.baselineId),
    (error: unknown) => {
      assert.ok(error instanceof DomBaselineError);
      assert.equal(error.code, 'DOM_BASELINE_NOT_FOUND');
      assert.equal((error.details as { reason: string }).reason, 'expired');
      return true;
    }
  );

  const second = harness();
  createBaseline(second.controller, snapshot([node('root', null)]));
  second.setTime(301_000);
  const pruned = second.controller.pruneExpired();
  assert.equal(pruned.count, 1);
  assert.ok(pruned.bytes > 0);
});

test('release is idempotent and oversized snapshots fail with typed quota errors', () => {
  const { controller } = harness();
  const descriptor = createBaseline(controller, snapshot([node('root', null)]));
  assert.deepEqual(controller.release(descriptor.baselineId), {
    baselineId: descriptor.baselineId,
    released: true,
  });
  assert.deepEqual(controller.release(descriptor.baselineId), {
    baselineId: descriptor.baselineId,
    released: false,
  });

  const huge = snapshot([
    {
      ...node('root', null),
      textFingerprint: 'x'.repeat(262_144),
    },
  ]);
  assert.throws(
    () => createBaseline(controller, huge),
    (error: unknown) => {
      assert.ok(error instanceof DomBaselineError);
      assert.equal(error.code, 'DOM_BASELINE_QUOTA_EXCEEDED');
      return true;
    }
  );
});

test('per-tab quota evicts the deterministic same-tab oldest record', () => {
  const { controller } = harness();
  const descriptors = Array.from({ length: 8 }, (_, index) =>
    createBaseline(controller, snapshot([node(`root-${index}`, null)]), { now: 1_000 + index })
  );
  const ninth = createBaseline(controller, snapshot([node('root-8', null)]), { now: 2_000 });

  assert.deepEqual(ninth.evicted, [
    { baselineId: descriptors[0].baselineId, reason: 'per_tab_quota' },
  ]);
  assert.throws(() => controller.get(descriptors[0].baselineId), /not found/i);
  assert.equal(controller.get(descriptors[1].baselineId), descriptors[1]);
});

test('global quota evicts the deterministic global oldest record', () => {
  const { controller } = harness();
  const descriptors = Array.from({ length: 32 }, (_, index) =>
    createBaseline(controller, snapshot([node(`root-${index}`, null)]), {
      tabId: index,
      now: 1_000 + index,
    })
  );
  const next = createBaseline(controller, snapshot([node('root-next', null)]), {
    tabId: 99,
    now: 2_000,
  });

  assert.deepEqual(next.evicted, [
    { baselineId: descriptors[0].baselineId, reason: 'global_quota' },
  ]);
  assert.throws(() => controller.get(descriptors[0].baselineId), /not found/i);
});

test('per-tab and global byte quotas evict oldest records before count limits', () => {
  const largeSnapshot = (index: number) =>
    snapshot([
      {
        ...node(`root-${index}`, null),
        textFingerprint: `${index}:${'x'.repeat(220_000)}`,
      },
    ]);

  const perTab = harness().controller;
  const sameTab = Array.from({ length: 4 }, (_, index) =>
    createBaseline(perTab, largeSnapshot(index), { now: 1_000 + index })
  );
  const fifth = createBaseline(perTab, largeSnapshot(4), { now: 2_000 });
  assert.deepEqual(fifth.evicted, [{ baselineId: sameTab[0].baselineId, reason: 'per_tab_quota' }]);
  assert.equal(perTab.metrics().baselineCount, 4);

  const global = harness().controller;
  const acrossTabs = Array.from({ length: 19 }, (_, index) =>
    createBaseline(global, largeSnapshot(index), { tabId: index, now: 1_000 + index })
  );
  const twentieth = createBaseline(global, largeSnapshot(19), { tabId: 99, now: 2_000 });
  assert.deepEqual(twentieth.evicted, [
    { baselineId: acrossTabs[0].baselineId, reason: 'global_quota' },
  ]);
  assert.equal(global.metrics().baselineCount, 19);
});

test('tab, window, navigation, explicit invalidation, and full cleanup are scoped', () => {
  const { controller } = harness();
  const tabOne = createBaseline(controller, snapshot([node('one', null)]), {
    windowId: 1,
    tabId: 1,
  });
  const tabTwo = createBaseline(controller, snapshot([node('two', null)]), {
    windowId: 1,
    tabId: 2,
  });
  const otherWindow = createBaseline(controller, snapshot([node('three', null)]), {
    windowId: 2,
    tabId: 3,
  });

  assert.equal(controller.invalidate(tabOne.baselineId, 'test').invalidated, true);
  assert.equal(controller.invalidate(tabOne.baselineId, 'test').invalidated, false);
  assert.equal(controller.invalidateNavigation(2).count, 1);
  assert.throws(
    () => controller.get(tabTwo.baselineId),
    (error: { code?: string }) => error.code === ERROR_CODES.DOM_BASELINE_INVALIDATED
  );
  assert.equal(controller.clearWindow(1).count, 0);
  assert.equal(controller.clearTab(3).count, 1);
  assert.throws(() => controller.get(otherWindow.baselineId), /not found/i);

  createBaseline(controller, snapshot([node('four', null)]), { tabId: 4 });
  assert.equal(controller.clearAll().count, 1);
  assert.equal(controller.metrics().baselineCount, 0);
});

test('scope generations expose navigation and access cleanup races', () => {
  const { controller } = harness();
  const initialTabOne = controller.getScopeGeneration(1);
  const initialTabTwo = controller.getScopeGeneration(2);
  controller.invalidateNavigation(1);
  assert.notEqual(controller.getScopeGeneration(1), initialTabOne);
  assert.equal(controller.getScopeGeneration(2), initialTabTwo);

  const beforeWindowCleanup = controller.getScopeGeneration(2);
  controller.clearWindow(9);
  assert.notEqual(controller.getScopeGeneration(2), beforeWindowCleanup);

  const beforeDestinationCleanup = controller.getScopeGeneration(2);
  controller.clearAll();
  assert.notEqual(controller.getScopeGeneration(2), beforeDestinationCleanup);
});

test('scope generation eviction cannot restore a stale in-flight token', () => {
  const { controller } = harness();
  const beforeNavigation = controller.getScopeGeneration(1);
  controller.invalidateNavigation(1);
  for (let tabId = 2; tabId <= 258; tabId += 1) {
    controller.getScopeGeneration(tabId);
  }
  assert.notEqual(controller.getScopeGeneration(1), beforeNavigation);
});

test('create rejects a navigation that races with semantic snapshot capture', async () => {
  const { controller } = harness();
  const handler = createDomBaselineRequestHandler(controller, {
    async resolveRequestTarget() {
      return { tabId: 1, windowId: 9, title: 'Page', url: 'https://example.com' };
    },
    async ensureContentScript() {},
    async sendTabMessage() {
      controller.invalidateNavigation(1);
      return snapshot([node('root', null)], {
        selector: 'main',
        representation: 'semantic-dom-v1',
      });
    },
    contentScriptTimeoutMs: 1_000,
  });

  await assert.rejects(
    handler.handle(
      createRequest({
        id: 'baseline-racing-navigation',
        method: 'dom.baseline.create',
        params: { selector: 'main' },
      })
    ),
    (error: { code?: string }) => error.code === ERROR_CODES.DOM_BASELINE_INVALIDATED
  );
  assert.equal(controller.metrics().baselineCount, 0);
});

test('create revalidates access after semantic snapshot capture', async () => {
  const { controller } = harness();
  let resolveCount = 0;
  const handler = createDomBaselineRequestHandler(controller, {
    async resolveRequestTarget() {
      resolveCount += 1;
      if (resolveCount > 1) {
        throw new BridgeError(ERROR_CODES.ACCESS_DENIED, 'Window access was disabled.');
      }
      return { tabId: 1, windowId: 9, title: 'Page', url: 'https://example.com' };
    },
    async ensureContentScript() {},
    async sendTabMessage() {
      return snapshot([node('root', null)], {
        selector: 'main',
        representation: 'semantic-dom-v1',
      });
    },
    contentScriptTimeoutMs: 1_000,
  });

  await assert.rejects(
    handler.handle(
      createRequest({
        id: 'baseline-racing-access-disable',
        method: 'dom.baseline.create',
        params: { selector: 'main' },
      })
    ),
    (error: { code?: string }) => error.code === ERROR_CODES.ACCESS_DENIED
  );
  assert.equal(controller.metrics().baselineCount, 0);
});

test('metrics expose only counts, bytes, and operation latency counters', () => {
  const { controller } = harness();
  const secret = 'page-content-that-must-not-leak';
  const descriptor = createBaseline(
    controller,
    snapshot([{ ...node('root', null), textFingerprint: secret }])
  );
  controller.compare(descriptor.baselineId, snapshot([node('root', null, 'changed')]), 1);
  const metrics = controller.metrics();
  const serialized = JSON.stringify(metrics);

  assert.equal(metrics.baselineCount, 1);
  assert.equal(metrics.tabCount, 1);
  assert.ok(metrics.bytes > 0);
  assert.equal(metrics.operations.create?.calls, 1);
  assert.equal(metrics.operations.compare?.calls, 1);
  assert.ok((metrics.operations.compare?.totalLatencyMs ?? 0) > 0);
  assert.doesNotMatch(serialized, /page-content|document-1|#app|root/);
});

test('invalidated navigation tombstones remain globally bounded', () => {
  const { controller } = harness();
  const ids: string[] = [];
  for (let index = 0; index < 40; index += 1) {
    const descriptor = createBaseline(controller, snapshot([node(`node-${index}`, null)]), {
      tabId: index,
    });
    ids.push(descriptor.baselineId);
    controller.invalidateNavigation(index);
  }
  assert.throws(
    () => controller.get(ids[0]),
    (error: { code?: string }) => error.code === ERROR_CODES.DOM_BASELINE_NOT_FOUND
  );
  assert.throws(
    () => controller.get(ids.at(-1) ?? ''),
    (error: { code?: string }) => error.code === ERROR_CODES.DOM_BASELINE_INVALIDATED
  );
});
