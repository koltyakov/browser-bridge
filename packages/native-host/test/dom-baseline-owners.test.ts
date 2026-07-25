import test from 'node:test';
import assert from 'node:assert/strict';

import { DomBaselineOwnerRegistry, isValidBaselineId } from '../src/dom-baseline-owners.js';
import { DOM_BASELINE_TTL_MS } from '../../protocol/src/index.js';
import type { ClientSocket } from '../src/daemon.js';

/**
 * The registry only reads the two bridge-owned markers off a socket, so a bare
 * stand-in is enough; the cast matches how daemon tests fake sockets.
 */
type FakeSocket = ClientSocket;

function createSocket(extensionId: string, accessEnabled = true): FakeSocket {
  return { __extensionId: extensionId, __accessEnabled: accessEnabled } as unknown as FakeSocket;
}

function makeBaselineId(seed: string): string {
  return `baseline_${seed.repeat(43).slice(0, 43)}`;
}

function futureExpiry(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** Registry whose liveness check tracks a simple extensionId -> socket map. */
function createRegistry(live = new Map<string, FakeSocket>()) {
  const registry = new DomBaselineOwnerRegistry({
    isCurrentExtensionSocket: (socket) => live.get(socket.__extensionId ?? '') === socket,
  });
  return { registry, live };
}

test('isValidBaselineId accepts only well-formed extension-minted IDs', () => {
  assert.equal(isValidBaselineId(makeBaselineId('a')), true);
  assert.equal(isValidBaselineId('baseline_short'), false);
  assert.equal(isValidBaselineId(`baseline_${'a'.repeat(65)}`), false);
  assert.equal(isValidBaselineId(`prefix_${'a'.repeat(43)}`), false);
  assert.equal(isValidBaselineId(`baseline_${'a'.repeat(42)}!`), false);
  assert.equal(isValidBaselineId(undefined), false);
  assert.equal(isValidBaselineId(42), false);
});

test('register rejects malformed IDs, expiries, and sockets without an extension', () => {
  const { registry, live } = createRegistry();
  const socket = createSocket('ext-1');
  live.set('ext-1', socket);
  const baselineId = makeBaselineId('a');

  assert.equal(registry.register('baseline_nope', socket, futureExpiry()), false);
  const socketWithoutExtension = { __accessEnabled: true } as unknown as FakeSocket;
  assert.equal(registry.register(baselineId, socketWithoutExtension, futureExpiry()), false);
  assert.equal(registry.register(baselineId, socket, 'not-a-date'), false);
  assert.equal(registry.register(baselineId, socket, undefined), false);
  // Already expired.
  assert.equal(
    registry.register(baselineId, socket, new Date(Date.now() - 1).toISOString()),
    false
  );
  // Beyond the TTL plus the allowed clock skew.
  assert.equal(
    registry.register(baselineId, socket, futureExpiry(DOM_BASELINE_TTL_MS + 60_000)),
    false
  );
  assert.equal(registry.size, 0);

  assert.equal(registry.register(baselineId, socket, futureExpiry()), true);
  assert.equal(registry.size, 1);
});

test('register refuses to reassign a baseline owned by another socket', () => {
  const { registry, live } = createRegistry();
  const owner = createSocket('ext-owner');
  const other = createSocket('ext-other');
  live.set('ext-owner', owner);
  live.set('ext-other', other);
  const baselineId = makeBaselineId('b');

  assert.equal(registry.register(baselineId, owner, futureExpiry()), true);
  assert.equal(registry.register(baselineId, other, futureExpiry()), false);
  assert.equal(registry.get(baselineId), owner);

  // The same socket may refresh its own expiry.
  assert.equal(registry.register(baselineId, owner, futureExpiry(90_000)), true);
});

test('get returns null when the owner lost access or was replaced', () => {
  const { registry, live } = createRegistry();
  const socket = createSocket('ext-1');
  live.set('ext-1', socket);
  const baselineId = makeBaselineId('c');
  assert.equal(registry.register(baselineId, socket, futureExpiry()), true);
  assert.equal(registry.get(baselineId), socket);

  socket.__accessEnabled = false;
  assert.equal(registry.get(baselineId), null);
  // Access loss is transient: the mapping survives for a later re-enable.
  socket.__accessEnabled = true;
  assert.equal(registry.get(baselineId), socket);

  // A reconnect replaces the socket for that extension; the mapping is dropped.
  live.set('ext-1', createSocket('ext-1'));
  assert.equal(registry.get(baselineId), null);
  assert.equal(registry.size, 0);
});

test('get returns null for an unknown baseline', () => {
  const { registry } = createRegistry();
  assert.equal(registry.get(makeBaselineId('d')), null);
});

test('prune drops expired mappings and keeps live ones', (t) => {
  const { registry, live } = createRegistry();
  const socket = createSocket('ext-1');
  live.set('ext-1', socket);
  const shortLived = makeBaselineId('e');
  const longLived = makeBaselineId('f');

  assert.equal(registry.register(shortLived, socket, futureExpiry(50)), true);
  assert.equal(registry.register(longLived, socket, futureExpiry(120_000)), true);
  assert.equal(registry.size, 2);

  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 60_000 });
  registry.prune();
  assert.equal(registry.size, 1);
  assert.equal(registry.get(longLived), socket);
});

test('deleteIfOwnedBy only removes mappings the socket actually owns', () => {
  const { registry, live } = createRegistry();
  const owner = createSocket('ext-owner');
  const other = createSocket('ext-other');
  live.set('ext-owner', owner);
  live.set('ext-other', other);
  const baselineId = makeBaselineId('g');
  registry.register(baselineId, owner, futureExpiry());

  assert.equal(registry.deleteIfOwnedBy(baselineId, other), false);
  assert.equal(registry.get(baselineId), owner);
  assert.equal(registry.deleteIfOwnedBy(baselineId, owner), true);
  assert.equal(registry.get(baselineId), null);
  assert.equal(registry.deleteIfOwnedBy(baselineId, owner), false);
});

test('clearForSocket forgets both owned baselines and abandoned creates', () => {
  const { registry, live } = createRegistry();
  const socket = createSocket('ext-1');
  const survivor = createSocket('ext-2');
  live.set('ext-1', socket);
  live.set('ext-2', survivor);

  registry.register(makeBaselineId('h'), socket, futureExpiry());
  registry.register(makeBaselineId('i'), survivor, futureExpiry());
  registry.markAbandonedCreate('req-1', {
    method: 'dom.baseline.create',
    targets: new Set([socket]),
  });
  registry.markAbandonedCreate('req-2', {
    method: 'dom.baseline.create',
    targets: new Set([survivor]),
  });

  registry.clearForSocket(socket);

  assert.equal(registry.size, 1);
  assert.equal(registry.get(makeBaselineId('i')), survivor);
  assert.equal(registry.takeAbandonedCreate('req-1', socket), false);
  assert.equal(registry.takeAbandonedCreate('req-2', survivor), true);
});

test('markAbandonedCreate ignores non-create methods and targetless requests', () => {
  const { registry } = createRegistry();
  const socket = createSocket('ext-1');

  registry.markAbandonedCreate('req-compare', {
    method: 'dom.baseline.compare',
    targets: new Set([socket]),
  });
  registry.markAbandonedCreate('req-no-target', {
    method: 'dom.baseline.create',
    targets: new Set(),
  });
  registry.markAbandonedCreate('req-no-method', { targets: new Set([socket]) });

  assert.equal(registry.abandonedCreates.size, 0);
});

test('takeAbandonedCreate claims a request exactly once and only for its socket', () => {
  const { registry } = createRegistry();
  const socket = createSocket('ext-1');
  const other = createSocket('ext-2');
  registry.markAbandonedCreate('req-1', {
    method: 'dom.baseline.create',
    targets: new Set([socket]),
  });

  assert.equal(registry.takeAbandonedCreate('req-1', other), false);
  assert.equal(registry.takeAbandonedCreate('req-1', socket), true);
  assert.equal(registry.takeAbandonedCreate('req-1', socket), false);
  assert.equal(registry.takeAbandonedCreate('unknown', socket), false);
});

test('abandoned creates are bounded and expire', (t) => {
  const { registry } = createRegistry();
  const socket = createSocket('ext-1');

  for (let index = 0; index < 300; index += 1) {
    registry.markAbandonedCreate(`req-${index}`, {
      method: 'dom.baseline.create',
      targets: new Set([socket]),
    });
  }
  assert.ok(registry.abandonedCreates.size <= 300);
  const boundedSize = registry.abandonedCreates.size;

  // Past the TTL, the next mark sweeps everything stale first.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + DOM_BASELINE_TTL_MS + 1_000 });
  registry.markAbandonedCreate('req-fresh', {
    method: 'dom.baseline.create',
    targets: new Set([socket]),
  });
  assert.equal(registry.abandonedCreates.size, 1);
  assert.ok(boundedSize > 0);
});

test('register evicts the oldest mapping once a socket hits its cap', () => {
  const { registry, live } = createRegistry();
  const socket = createSocket('ext-1');
  live.set('ext-1', socket);

  const ids: string[] = [];
  for (let index = 0; index < 200; index += 1) {
    const baselineId = `baseline_${String(index).padStart(43, '0')}`;
    ids.push(baselineId);
    registry.register(baselineId, socket, futureExpiry());
  }

  // The cap is enforced, and what survives is the most recent tail.
  assert.ok(registry.size < ids.length);
  assert.equal(registry.get(ids[ids.length - 1]), socket);
  assert.equal(registry.get(ids[0]), null);
});

test('clear drops all tracked state', () => {
  const { registry, live } = createRegistry();
  const socket = createSocket('ext-1');
  live.set('ext-1', socket);
  registry.register(makeBaselineId('j'), socket, futureExpiry());
  registry.markAbandonedCreate('req-1', {
    method: 'dom.baseline.create',
    targets: new Set([socket]),
  });

  registry.clear();

  assert.equal(registry.size, 0);
  assert.equal(registry.abandonedCreates.size, 0);
});

test('delete removes a mapping regardless of owner', () => {
  const { registry, live } = createRegistry();
  const socket = createSocket('ext-1');
  live.set('ext-1', socket);
  const baselineId = makeBaselineId('k');
  registry.register(baselineId, socket, futureExpiry());

  assert.equal(registry.delete(baselineId), true);
  assert.equal(registry.get(baselineId), null);
  assert.equal(registry.delete(baselineId), false);
});
