import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chromeSkipReason,
  runContentCheckInChromeRealTime,
} from '../../../tests/_helpers/contentBrowser.ts';

/** Runs in real Chrome with the production content scripts. Proves BBX never
 * creates a database, yields to the page's version change, and times out
 * instead of waiting behind a blocked upgrade. */
async function checkIndexedDb(): Promise<void> {
  const listener = Reflect.get(globalThis, '__bbxListener') as (
    message: { type: string; method: string; params: Record<string, unknown> },
    sender: object,
    respond: (value: Record<string, unknown>) => void
  ) => void;
  const call = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) =>
      listener({ type: 'bridge.execute', method, params }, {}, resolve)
    );
  const equal = (actual: unknown, expected: unknown, label: string): void => {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  };
  const names = async () => (await indexedDB.databases()).map((entry) => entry.name).sort();
  const open = (name: string, version: number, upgrade?: (db: IDBDatabase) => void) =>
    new Promise<{ db: IDBDatabase; blocked: boolean }>((resolve, reject) => {
      let blocked = false;
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = () => upgrade?.(request.result);
      request.onblocked = () => {
        blocked = true;
      };
      request.onsuccess = () => resolve({ db: request.result, blocked });
      request.onerror = () => reject(request.error);
    });

  const { db: seeded } = await open('app', 1, (db) => {
    const users = db.createObjectStore('users', { keyPath: 'id' });
    users.createIndex('byName', 'name');
    users.put({ id: 1, name: 'Ada', avatar: new Blob(['pixels'], { type: 'image/png' }) });
    users.put(JSON.parse('{"id":2,"__proto__":null,"nested":{"__proto__":"stored"}}'));
    db.createObjectStore('events').put({ kind: 'compound' }, ['team', 7]);
  });
  seeded.close();

  const listed = await call('page.get_storage', { type: 'indexeddb' });
  const [app] = listed.databases as Array<Record<string, unknown>>;
  equal(app.name, 'app', 'database listed');
  equal(app.version, 1, 'version listed');
  equal(
    (app.stores as Array<Record<string, unknown>>).map((store) => [store.name, store.count]),
    [
      ['events', 1],
      ['users', 2],
    ],
    'stores and counts'
  );

  const user = await call('indexeddb.read_record', {
    database: 'app',
    store: 'users',
    key: 1,
    maxBytes: 262_144,
  });
  equal(
    user.value,
    { id: 1, name: 'Ada', avatar: { $bbxType: 'Blob', mimeType: 'image/png', size: 6 } },
    'record with a described Blob'
  );
  const prototypeJson = '{"id":2,"__proto__":null,"nested":{"__proto__":"stored"}}';
  const prototypeRecord = await call('indexeddb.read_record', {
    database: 'app',
    store: 'users',
    key: 2,
    maxBytes: 262_144,
  });
  equal(JSON.stringify(prototypeRecord.value), prototypeJson, 'own prototype fields preserved');
  equal(prototypeRecord.described, 0, 'ordinary JSON stays exact');
  equal(prototypeRecord.bytes, new TextEncoder().encode(prototypeJson).length, 'exact JSON bytes');
  const compound = await call('indexeddb.read_record', {
    database: 'app',
    store: 'events',
    key: ['team', 7],
    maxBytes: 262_144,
  });
  equal(compound.value, { kind: 'compound' }, 'array key');

  const ghost = await call('indexeddb.read_record', {
    database: 'ghost',
    store: 's',
    key: 1,
    maxBytes: 262_144,
  });
  equal(
    (ghost.error as { details: { reason: string } }).details.reason,
    'database_not_found',
    'unlisted'
  );
  equal(await names(), ['app'], 'nothing created by BBX');

  // BBX closed its connections, so the page's own upgrade is never blocked.
  const upgraded = await open('app', 2);
  equal(upgraded.blocked, false, 'page upgrade not blocked after a BBX walk');

  // Hold an old connection that ignores versionchange, then start an upgrade:
  // it waits, and BBX's open queues behind it. BBX must time out, not hang.
  const pendingUpgrade = open('app', 3);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const started = performance.now();
  const stuck = await call('page.get_storage', { type: 'indexeddb' });
  const elapsed = performance.now() - started;
  equal(
    (stuck.databases as Array<Record<string, unknown>>)[0].error,
    'open_timeout',
    'blocked open reported'
  );
  if (elapsed > 2_500) throw new Error(`blocked walk took ${Math.round(elapsed)} ms`);
  upgraded.db.close();
  const third = await pendingUpgrade;
  third.db.close();
  // BBX's queued open succeeds late and must close at once; a further upgrade
  // must not be blocked by it.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const fourth = await open('app', 4);
  equal(fourth.blocked, false, 'late BBX connection was closed');
  fourth.db.close();

  // A BBX connection that is open while the page upgrades closes on versionchange.
  const reading = call('page.get_storage', { type: 'indexeddb' });
  const fifth = await open('app', 5);
  equal(fifth.blocked, false, 'BBX yields to versionchange mid-walk');
  fifth.db.close();
  await reading;
  equal(await names(), ['app'], 'still nothing created');
}

test(
  'IndexedDB reads never create, upgrade or block a database in Chrome',
  { skip: chromeSkipReason },
  async () => {
    const { passed, output } = await runContentCheckInChromeRealTime(checkIndexedDb, {
      timeoutMs: 20_000,
    });
    assert.equal(passed, true, output);
  }
);
