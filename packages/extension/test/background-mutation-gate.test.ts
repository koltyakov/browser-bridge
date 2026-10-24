import test from 'node:test';
import assert from 'node:assert/strict';
import { createMutationGate, mutationSnapshotScope } from '../src/background-mutation-gate.js';
import { requestLifetimes } from '../src/background-request-lifetime.js';
import { createRequest } from '../../../protocol/src/index.js';
import type { MutationReadyMessage } from '../../../protocol/src/types.js';

function harness() {
  let snapshot = { documentId: 'first', url: 'https://example.test/' };
  let access = true;
  let ready!: () => void;
  const prepared = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const sent: MutationReadyMessage[] = [];
  const request = createRequest({
    id: crypto.randomUUID(),
    method: 'input.click',
    params: {},
    meta: { mutation_schedule: true },
  });
  const finish = requestLifetimes.begin(request);
  const gate = createMutationGate({
    resolveTarget: async () => ({ tabId: 42, windowId: 1, url: snapshot.url }),
    captureAccess: () => () => {
      if (!access) throw new Error('access revoked');
    },
    snapshot: async () => snapshot,
    send: (message) => {
      sent.push(message);
      ready();
    },
  });
  return {
    gate,
    request,
    finish,
    prepared,
    sent,
    setSnapshot: (value: typeof snapshot) => {
      snapshot = value;
    },
    revoke: () => {
      access = false;
    },
  };
}

test('native grants pin implicit targets and do not grant browser permission', async () => {
  const h = harness();
  try {
    const result = h.gate.prepare(h.request);
    await h.prepared;
    assert.deepEqual(h.sent, [{ type: 'host.mutation_ready', requestId: h.request.id, tabId: 42 }]);
    assert.equal(h.gate.handle({ type: 'unrelated' }), false);
    assert.equal(h.gate.handle({ type: 'host.mutation_granted', requestId: 'another' }), true);
    h.gate.handle({ type: 'host.mutation_granted', requestId: h.request.id });
    assert.equal((await result).tab_id, 42);
  } finally {
    h.finish();
  }
});

test('a reload to the same URL invalidates queued input', async () => {
  const h = harness();
  try {
    const result = h.gate.prepare(h.request);
    await h.prepared;
    h.setSnapshot({ documentId: 'replacement', url: 'https://example.test/' });
    h.gate.handle({ type: 'host.mutation_granted', requestId: h.request.id });
    await assert.rejects(result, /document changed/);
  } finally {
    h.finish();
  }
});

test('navigation and tab closure reject waiting mutations before a grant', async () => {
  const h = harness();
  try {
    const result = h.gate.prepare(h.request);
    await h.prepared;
    h.gate.invalidate(42);
    await assert.rejects(result, /navigated, moved, or closed/);
  } finally {
    h.finish();
  }
});

test('cancellation stops a queued mutation and ignores a later native grant', async () => {
  const h = harness();
  try {
    const result = h.gate.prepare(h.request);
    await h.prepared;
    requestLifetimes.cancel(h.request.id);
    await assert.rejects(result, /canceled/);
    assert.equal(h.gate.handle({ type: 'host.mutation_granted', requestId: h.request.id }), true);
  } finally {
    h.finish();
  }
});

test('access revocation while queued still wins over a scheduling grant', async () => {
  const h = harness();
  try {
    const result = h.gate.prepare(h.request);
    await h.prepared;
    h.revoke();
    h.gate.handle({ type: 'host.mutation_granted', requestId: h.request.id });
    await assert.rejects(result, /access revoked/);
  } finally {
    h.finish();
  }
});

test('older daemon requests do not enter the scheduling handshake', async () => {
  const h = harness();
  try {
    delete h.request.meta.mutation_schedule;
    assert.equal(await h.gate.prepare(h.request), h.request);
    assert.equal(h.sent.length, 0);
  } finally {
    h.finish();
  }
});

test('cancellation abandons a page read that never settles', async () => {
  const request = createRequest({
    id: crypto.randomUUID(),
    method: 'input.click',
    params: {},
    meta: { mutation_schedule: true },
  });
  const finish = requestLifetimes.begin(request);
  const gate = createMutationGate({
    resolveTarget: async () => ({ tabId: 42, windowId: 1, url: 'https://example.test/' }),
    captureAccess: () => () => {},
    snapshot: () => new Promise(() => {}),
    send: () => assert.fail('a hung page read must not reach the scheduler'),
  });
  try {
    const result = gate.prepare(request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    requestLifetimes.cancel(request.id);
    await assert.rejects(result, /preparation canceled/);
  } finally {
    finish();
  }
});

test('navigation is checked at tab level so it can recover an unresponsive page', async () => {
  assert.equal(mutationSnapshotScope('navigation.reload'), 'tab');
  assert.equal(mutationSnapshotScope('navigation.navigate'), 'tab');
  assert.equal(mutationSnapshotScope('input.click'), 'document');
  const request = createRequest({
    id: crypto.randomUUID(),
    method: 'navigation.reload',
    params: {},
    meta: { mutation_schedule: true },
  });
  const finish = requestLifetimes.begin(request);
  const scopes: string[] = [];
  const gate = createMutationGate({
    resolveTarget: async () => ({ tabId: 42, windowId: 1, url: 'https://example.test/' }),
    captureAccess: () => () => {},
    snapshot: async (_tabId, scope) => {
      scopes.push(scope);
      return { documentId: '', url: 'https://example.test/' };
    },
    send: (message) =>
      queueMicrotask(() =>
        gate.handle({ type: 'host.mutation_granted', requestId: message.requestId })
      ),
  });
  try {
    assert.equal((await gate.prepare(request)).tab_id, 42);
    assert.deepEqual(scopes, ['tab', 'tab']);
  } finally {
    finish();
  }
});
