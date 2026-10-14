import assert from 'node:assert/strict';
import test from 'node:test';
import { createStorageArea } from '../../../tests/_helpers/chromeFake.ts';
import { getProfileLabel } from '../src/background-native.js';

test('profile labels migrate from session storage and survive browser restarts', async () => {
  const local = createStorageArea();
  const session = createStorageArea({ bb_profile_label: 'profile_abc123' });
  assert.equal(await getProfileLabel({ storage: { local, session } }), 'profile_abc123');
  await session.clear();
  assert.equal(await getProfileLabel({ storage: { local, session } }), 'profile_abc123');
  assert.equal(local.snapshot().bb_profile_label, 'profile_abc123');
});

test('a persisted label wins over a conflicting session label', async () => {
  const local = createStorageArea({ bb_profile_label: 'profile_local1' });
  const session = createStorageArea({ bb_profile_label: 'profile_session1' });
  assert.equal(await getProfileLabel({ storage: { local, session } }), 'profile_local1');
});

test('invalid labels are replaced and concurrent initial identity requests agree', async () => {
  const storage = {
    local: createStorageArea({ bb_profile_label: 42 }),
    session: createStorageArea({ bb_profile_label: '../invalid' }),
  };
  const target = { storage };
  const labels = await Promise.all([getProfileLabel(target), getProfileLabel(target)]);
  assert.equal(labels[0], labels[1]);
  assert.match(labels[0], /^profile_[a-f0-9-]{36}$/);
  assert.equal(storage.local.snapshot().bb_profile_label, labels[0]);
});

test('fresh installations in separate profiles receive different labels', async () => {
  const makeProfile = () => ({
    storage: { local: createStorageArea(), session: createStorageArea() },
  });
  assert.notEqual(await getProfileLabel(makeProfile()), await getProfileLabel(makeProfile()));
});

test('local storage failure preserves the existing session label', async (t) => {
  t.mock.method(console, 'error', () => {});
  const local = createStorageArea();
  t.mock.method(local, 'get', async () => {
    throw new Error('storage unavailable');
  });
  const session = createStorageArea({ bb_profile_label: 'profile_abc123' });
  assert.equal(await getProfileLabel({ storage: { local, session } }), 'profile_abc123');
});

test('session storage failure does not prevent persistent identity creation', async (t) => {
  t.mock.method(console, 'error', () => {});
  const local = createStorageArea();
  const session = createStorageArea();
  t.mock.method(session, 'get', async () => {
    throw new Error('session unavailable');
  });
  t.mock.method(session, 'set', async () => {
    throw new Error('session unavailable');
  });
  const label = await getProfileLabel({ storage: { local, session } });
  assert.equal(local.snapshot().bb_profile_label, label);
});
