import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { withLiveIndexedDbFixture } from './fixture.ts';

test('live fixture cleanup owns only newly created names, including on failure', async () => {
  const databases = new Set(['bbx-live']);
  const deleted: string[] = [];
  let collide = false;
  const indexedDB = {
    databases: async () => [...databases].map((name) => ({ name })),
    open(name: string) {
      if (collide) databases.add(name);
      const request = {
        result: { close() {}, createObjectStore: () => ({ add() {} }) },
        onupgradeneeded() {},
        onsuccess() {},
      };
      queueMicrotask(() => {
        if (!databases.has(name)) {
          databases.add(name);
          request.onupgradeneeded();
        }
        request.onsuccess();
      });
      return request;
    },
    deleteDatabase(name: string) {
      deleted.push(name);
      databases.delete(name);
      const request = { onsuccess() {} };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  };
  const evaluate = (expression: string) =>
    runInNewContext(expression, { indexedDB }) as Promise<unknown>;
  const owned: string[] = [];
  for (let run = 0; run < 2; run++) {
    await assert.rejects(
      withLiveIndexedDbFixture(evaluate, 'example', async (name) => {
        assert.ok(databases.has(name));
        owned.push(name);
        throw new Error('check failed');
      }),
      /check failed/
    );
  }
  assert.equal(new Set(owned).size, 2);
  assert.deepEqual(deleted, owned);
  assert.deepEqual([...databases], ['bbx-live']);
  collide = true;
  await assert.rejects(
    withLiveIndexedDbFixture(evaluate, 'example', async () => assert.fail()),
    /already exists/
  );
  assert.deepEqual(deleted, owned);
  assert.equal(databases.size, 2);
});

test('live fixture cleanup reports blocked, failed and unverified deletions', async () => {
  for (const outcome of ['blocked', 'error', 'still_present'] as const) {
    const databases = new Set<string>();
    const indexedDB = {
      databases: async () => [...databases].map((name) => ({ name })),
      open(name: string) {
        const request = {
          result: { close() {}, createObjectStore: () => ({ add() {} }) },
          onupgradeneeded() {},
          onsuccess() {},
        };
        queueMicrotask(() => {
          databases.add(name);
          request.onupgradeneeded();
          request.onsuccess();
        });
        return request;
      },
      deleteDatabase(_name: string) {
        const request = {
          error: new Error('cleanup failed'),
          onsuccess() {},
          onerror() {},
          onblocked() {},
        };
        queueMicrotask(() => {
          if (outcome === 'blocked') request.onblocked();
          else if (outcome === 'error') request.onerror();
          else request.onsuccess();
        });
        return request;
      },
    };
    const evaluate = (expression: string) =>
      runInNewContext(expression, { indexedDB }) as Promise<unknown>;
    await assert.rejects(
      withLiveIndexedDbFixture(evaluate, 'example', async () => {}),
      outcome === 'blocked' ? /blocked/ : outcome === 'error' ? /cleanup failed/ : /still exists/
    );
  }
});

test('an uncertain live fixture setup never triggers a cleanup mutation', async () => {
  const expressions: string[] = [];
  await assert.rejects(
    withLiveIndexedDbFixture(
      async (expression) => {
        expressions.push(expression);
        throw new Error('setup response lost');
      },
      'example',
      async () => assert.fail('check must not run after uncertain setup')
    ),
    /setup response lost/
  );
  assert.equal(expressions.length, 1);
  assert.equal(expressions[0].includes('deleteDatabase'), false);
});
