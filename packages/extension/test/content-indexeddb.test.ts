import test from 'node:test';
import assert from 'node:assert/strict';

import { withDocument } from '../../../tests/_helpers/dom.ts';
import { extensionFile } from '../../../tests/_helpers/extensionBuild.ts';

const MISSING = Symbol('missing');
const CANARY = 'BBX_IDB_CANARY_9a41';

type Listener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
) => boolean;

type FakeIndex = { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean };
type FakeStore = {
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: FakeIndex[];
  records: Array<{ key: unknown; value: unknown }>;
  countHangs?: boolean;
};
type FakeDatabase = { version: number; stores: Map<string, FakeStore> };
type FakeEvent = { preventDefault: () => void };
type FakeRequest = {
  result: unknown;
  error: unknown;
  transaction: { abort: () => void } | null;
  onsuccess: ((event: FakeEvent) => void) | null;
  onerror: ((event: FakeEvent) => void) | null;
  onupgradeneeded: ((event: FakeEvent) => void) | null;
  onblocked: ((event: FakeEvent) => void) | null;
};

const event = (): FakeEvent => ({ preventDefault() {} });

function keyId(key: unknown): string {
  if (key instanceof Date) return `d:${key.getTime()}`;
  if (Array.isArray(key)) return `[${key.map(keyId).join(',')}]`;
  return `${typeof key}:${String(key)}`;
}

/** A small IndexedDB model: enough to prove BBX opens only listed names
 * without a version, never creates or upgrades, closes every connection, and
 * yields to a version change. */
class FakeIndexedDb {
  readonly databasesByName = new Map<string, FakeDatabase>();
  /** Listed by databases() but gone by the time BBX opens it. */
  readonly listedButMissing = new Set<string>();
  readonly blocked = new Set<string>();
  readonly opens: Array<{ name: string; version: unknown }> = [];
  readonly created: string[] = [];
  readonly connections: FakeConnection[] = [];
  readonly transactionModes: string[] = [];
  upgradeAborts = 0;
  private releaseBlocked: Array<() => void> = [];

  async databases() {
    return [
      ...[...this.databasesByName].map(([name, db]) => ({ name, version: db.version })),
      ...[...this.listedButMissing].map((name) => ({ name, version: 1 })),
    ];
  }

  open(name: string, version?: number): FakeRequest {
    this.opens.push({ name, version });
    const request: FakeRequest = {
      result: undefined,
      error: null,
      transaction: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null,
    };
    const succeed = () => {
      const db = this.databasesByName.get(name);
      if (!db) {
        let aborted = false;
        request.transaction = {
          abort: () => {
            aborted = true;
            this.upgradeAborts += 1;
          },
        };
        request.onupgradeneeded?.(event());
        if (aborted) {
          request.error = new Error('AbortError');
          request.onerror?.(event());
          return;
        }
        this.created.push(name);
        this.databasesByName.set(name, { version: 1, stores: new Map() });
      }
      const connection = new FakeConnection(name, this.databasesByName.get(name)!, this);
      this.connections.push(connection);
      request.result = connection;
      request.onsuccess?.(event());
    };
    if (this.blocked.has(name)) this.releaseBlocked.push(() => setTimeout(succeed, 0));
    else setTimeout(succeed, 0);
    return request;
  }

  release() {
    for (const release of this.releaseBlocked.splice(0)) release();
  }
}

class FakeConnection {
  closed = false;
  closedByVersionChange = false;
  onversionchange: (() => void) | null = null;
  readonly objectStoreNames: string[] & { contains: (name: string) => boolean };

  constructor(
    readonly name: string,
    private readonly db: FakeDatabase,
    private readonly factory: FakeIndexedDb
  ) {
    const names = [...db.stores.keys()];
    this.objectStoreNames = Object.assign(names, {
      contains: (store: string) => names.includes(store),
    });
  }

  get version() {
    return this.db.version;
  }

  close() {
    this.closed = true;
  }

  /** What Chrome does when the page opens a newer version. */
  versionChange() {
    this.onversionchange?.();
    this.closedByVersionChange = this.closed;
  }

  transaction(names: string | string[], mode: string) {
    this.factory.transactionModes.push(mode);
    const db = this.db;
    const tx = {
      aborted: false,
      abort() {
        tx.aborted = true;
      },
      objectStore(storeName: string) {
        const store = db.stores.get(storeName);
        if (!store || !(Array.isArray(names) ? names : [names]).includes(storeName))
          throw new Error('NotFoundError');
        const request = (resolveValue: () => unknown, hang = false): FakeRequest => {
          const pending: FakeRequest = {
            result: undefined,
            error: null,
            transaction: null,
            onsuccess: null,
            onerror: null,
            onupgradeneeded: null,
            onblocked: null,
          };
          if (!hang)
            setTimeout(() => {
              pending.result = resolveValue();
              pending.onsuccess?.(event());
            }, 0);
          return pending;
        };
        return {
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
          indexNames: store.indexes.map((index) => index.name),
          index: (indexName: string) => store.indexes.find((index) => index.name === indexName),
          count: () => request(() => store.records.length, store.countHangs === true),
          openCursor: (key: unknown) =>
            request(() => {
              const found = store.records.find((record) => keyId(record.key) === keyId(key));
              return found ? { value: found.value } : null;
            }),
        };
      },
    };
    return tx;
  }
}

function store(records: Array<{ key: unknown; value: unknown }>, extra: Partial<FakeStore> = {}) {
  return {
    keyPath: 'id',
    autoIncrement: false,
    indexes: [] as FakeIndex[],
    records,
    ...extra,
  };
}

async function importFresh(relativePath: string): Promise<void> {
  await import(`${extensionFile(relativePath).href}?case=${Date.now()}-${Math.random()}`);
}

/** Load the production content scripts with a fake IndexedDB in scope. */
async function withContentScript(
  t: import('node:test').TestContext,
  factory: FakeIndexedDb | null,
  run: (
    call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>
  ) => Promise<void>
): Promise<void> {
  const keys = [
    'chrome',
    'indexedDB',
    '__BBX_CONTENT_HELPERS__',
    '__bbxContentDomBaseline',
    '__BBX_CONTENT_REGISTRY__',
    '__BBX_CONTENT_DOM_QUERY__',
    '__BBX_CONTENT_INPUT__',
    '__BBX_CONTENT_PATCH__',
    '__chromeCodexBridgeContentScriptLoaded',
  ];
  const saved = new Map(
    keys.map((key) => [
      key,
      Object.hasOwn(globalThis, key) ? Reflect.get(globalThis, key) : MISSING,
    ])
  );
  t.after(() => {
    for (const [key, value] of saved)
      if (value === MISSING) Reflect.deleteProperty(globalThis, key);
      else Reflect.set(globalThis, key, value);
  });
  await withDocument('<!doctype html><html><body><p>idb</p></body></html>', async ({ window }) => {
    Reflect.set(window, 'location', {
      href: 'https://app.example/x',
      origin: 'https://app.example',
    });
    Reflect.set(globalThis, 'location', window.location);
    if (factory) Reflect.set(globalThis, 'indexedDB', factory);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
    let listener: Listener | null = null;
    Reflect.set(globalThis, 'chrome', {
      runtime: { onMessage: { addListener: (callback: Listener) => (listener = callback) } },
    });
    Reflect.deleteProperty(globalThis, '__chromeCodexBridgeContentScriptLoaded');
    for (const file of [
      'src/content-script-helpers.js',
      'src/content-dom-baseline.js',
      'src/content-element-registry.js',
      'src/content-dom-query.js',
      'src/content-input.js',
      'src/content-patch.js',
      'src/content-script.js',
    ])
      await importFresh(file);
    const registered = listener as Listener | null;
    assert.ok(registered, 'content script registered a listener');
    await run(
      (method, params) =>
        new Promise((resolve) => {
          registered(
            { type: 'bridge.execute', method, params },
            {} as chrome.runtime.MessageSender,
            (response) => resolve(response as Record<string, unknown>)
          );
        })
    );
  });
}

function appFactory(): FakeIndexedDb {
  const factory = new FakeIndexedDb();
  factory.databasesByName.set('app', {
    version: 3,
    stores: new Map([
      [
        'users',
        store(
          [
            { key: 1, value: { id: 1, name: `Ada ${CANARY}` } },
            { key: 2, value: { id: 2, name: 'Grace' } },
          ],
          {
            indexes: [{ name: 'byName', keyPath: 'name', unique: false, multiEntry: false }],
          }
        ),
      ],
      [
        'files',
        store(
          [
            {
              key: 'avatar',
              value: {
                id: 'avatar',
                blob: new Blob([`${CANARY} bytes`], { type: 'image/png' }),
                nested: { buffer: new Uint8Array([1, 2, 3]).buffer, view: new Uint16Array(4) },
                tags: new Set(['a', 'b']),
                at: new Date(Date.UTC(2026, 0, 2)),
                big: 12n,
                missing: undefined,
                inf: Number.POSITIVE_INFINITY,
              },
            },
          ],
          { keyPath: null, autoIncrement: true }
        ),
      ],
      [
        'events',
        store([
          { key: new Date(1_700_000_000_000), value: { kind: 'date-key' } },
          { key: ['team', 7], value: { kind: 'array-key' } },
          { key: 'huge', value: { text: 'x'.repeat(262_145) } },
        ]),
      ],
    ]),
  });
  factory.databasesByName.set('cache', { version: 1, stores: new Map() });
  return factory;
}

test('IndexedDB metadata lists databases, stores, indexes and counts, never records', async (t) => {
  const factory = appFactory();
  await withContentScript(t, factory, async (call) => {
    const result = await call('page.get_storage', { type: 'indexeddb', keys: null });
    assert.deepEqual(result, {
      type: 'indexeddb',
      origin: 'https://app.example',
      available: true,
      total: 2,
      incomplete: [],
      databases: [
        {
          name: 'app',
          version: 3,
          storeCount: 3,
          stores: [
            {
              name: 'users',
              keyPath: 'id',
              autoIncrement: false,
              indexes: [{ name: 'byName', keyPath: 'name', unique: false, multiEntry: false }],
              count: 2,
            },
            { name: 'files', keyPath: null, autoIncrement: true, indexes: [], count: 1 },
            { name: 'events', keyPath: 'id', autoIncrement: false, indexes: [], count: 3 },
          ],
        },
        { name: 'cache', version: 1, storeCount: 0, stores: [] },
      ],
    });
    assert.equal(JSON.stringify(result).includes(CANARY), false, 'no record in metadata');
  });
  assert.deepEqual(
    factory.opens.map((open) => open.version),
    [undefined, undefined],
    'opened without a version'
  );
  assert.deepEqual(factory.created, [], 'nothing created');
  assert.equal(
    factory.connections.every((connection) => connection.closed),
    true,
    'all closed'
  );
  assert.equal(
    factory.connections.every((connection) => typeof connection.onversionchange === 'function'),
    true
  );
  assert.deepEqual(new Set(factory.transactionModes), new Set(['readonly']));
});

test('a page version change closes the BBX connection at once, mid-walk', async (t) => {
  const factory = new FakeIndexedDb();
  factory.databasesByName.set('slow', {
    version: 1,
    stores: new Map([['items', store([{ key: 1, value: 1 }], { countHangs: true })]]),
  });
  await withContentScript(t, factory, async (call) => {
    const pending = call('page.get_storage', { type: 'indexeddb' });
    for (let attempt = 0; attempt < 100 && !factory.connections.length; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const [connection] = factory.connections;
    assert.ok(connection, 'BBX opened the database');
    assert.equal(connection.closed, false);
    connection.versionChange();
    assert.equal(connection.closedByVersionChange, true, 'closed synchronously on versionchange');
    const result = await pending;
    const [db] = result.databases as Array<{ stores: Array<{ count: unknown }> }>;
    assert.equal(db.stores[0].count, null, 'a count past the time bound is unknown, not guessed');
    assert.deepEqual(result.incomplete, ['time_budget']);
  });
});

test('a blocked open times out, and a late success is closed immediately', async (t) => {
  const factory = appFactory();
  factory.blocked.add('app');
  await withContentScript(t, factory, async (call) => {
    const result = await call('page.get_storage', { type: 'indexeddb' });
    const [app] = result.databases as Array<Record<string, unknown>>;
    assert.equal(app.name, 'app');
    assert.equal(app.error, 'open_timeout');
    assert.deepEqual(result.incomplete, ['database_error']);

    const read = await call('indexeddb.read_record', {
      database: 'app',
      store: 'users',
      key: 1,
      maxBytes: 262_144,
    });
    assert.deepEqual(read.error, {
      code: 'TIMEOUT',
      message:
        'The IndexedDB database did not open in time; another connection may be upgrading it.',
      details: { source: 'indexeddb', reason: 'open_timeout' },
    });
  });
  factory.release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(factory.connections.length >= 1, 'the queued opens eventually succeed');
  assert.equal(
    factory.connections.every((connection) => connection.closed),
    true
  );
});

test('a database deleted after listing is reported missing and never created', async (t) => {
  const factory = new FakeIndexedDb();
  factory.listedButMissing.add('ghost');
  await withContentScript(t, factory, async (call) => {
    const result = await call('page.get_storage', { type: 'indexeddb' });
    assert.deepEqual(result.databases, [
      { name: 'ghost', version: 1, stores: [], storeCount: 0, error: 'database_missing' },
    ]);
    const read = await call('indexeddb.read_record', {
      database: 'ghost',
      store: 's',
      key: 1,
      maxBytes: 262_144,
    });
    assert.equal((read.error as { code: string }).code, 'SENSITIVE_TARGET_NOT_FOUND');
  });
  assert.equal(factory.upgradeAborts, 2, 'the accidental upgrade was aborted each time');
  assert.deepEqual(factory.created, []);
  assert.equal(factory.databasesByName.has('ghost'), false);
});

test('one record is returned as JSON; non-JSON values are described, wherever nested', async (t) => {
  const factory = appFactory();
  await withContentScript(t, factory, async (call) => {
    const read = (store: string, key: unknown) =>
      call('indexeddb.read_record', { database: 'app', store, key, maxBytes: 262_144 });
    const user = await read('users', 1);
    assert.deepEqual(user, {
      source: 'indexeddb',
      database: 'app',
      store: 'users',
      value: { id: 1, name: `Ada ${CANARY}` },
      described: 0,
      bytes: JSON.stringify({ id: 1, name: `Ada ${CANARY}` }).length,
      exact: true,
    });

    const file = await read('files', 'avatar');
    assert.deepEqual(file.value, {
      id: 'avatar',
      blob: { $bbxType: 'Blob', mimeType: 'image/png', size: `${CANARY} bytes`.length },
      nested: {
        buffer: { $bbxType: 'ArrayBuffer', byteLength: 3 },
        view: { $bbxType: 'Uint16Array', byteLength: 8 },
      },
      tags: { $bbxType: 'Set', size: 2 },
      at: { $bbxType: 'Date', value: '2026-01-02T00:00:00.000Z' },
      big: { $bbxType: 'BigInt', value: '12' },
      missing: { $bbxType: 'undefined' },
      inf: { $bbxType: 'Number', value: 'Infinity' },
    });
    assert.equal(file.described, 8);
    assert.equal(JSON.stringify(file).includes(CANARY), false, 'Blob contents never copied');

    assert.deepEqual((await read('events', { type: 'date', value: 1_700_000_000_000 })).value, {
      kind: 'date-key',
    });
    assert.deepEqual((await read('events', ['team', 7])).value, { kind: 'array-key' });

    const huge = await read('events', 'huge');
    assert.equal((huge.error as { code: string }).code, 'RESULT_TOO_LARGE');
    assert.equal(JSON.stringify(huge).includes('xxxx'), false, 'no partial record');

    for (const [storeName, key, reason] of [
      ['users', 99, 'key_not_found'],
      ['nope', 1, 'store_not_found'],
    ] as const) {
      const missing = await read(storeName, key);
      assert.deepEqual(missing.error, {
        code: 'SENSITIVE_TARGET_NOT_FOUND',
        message: (missing.error as { message: string }).message,
        details: { source: 'indexeddb', reason },
      });
      assert.equal(JSON.stringify(missing).includes(storeName === 'nope' ? 'nope' : '99'), false);
    }
    const unknownDb = await call('indexeddb.read_record', {
      database: 'never-existed',
      store: 's',
      key: 1,
      maxBytes: 262_144,
    });
    assert.equal(
      (unknownDb.error as { details: { reason: string } }).details.reason,
      'database_not_found'
    );
    const badKey = await read('users', { type: 'blob' });
    assert.equal((badKey.error as { code: string }).code, 'INVALID_REQUEST');
  });
  assert.equal(
    factory.opens.some((open) => open.name === 'never-existed'),
    false,
    'an unlisted name is never opened, so never created'
  );
  assert.deepEqual(factory.created, []);
  assert.equal(
    factory.connections.every((connection) => connection.closed),
    true
  );
});

test('an exact IndexedDB read preserves own __proto__ fields including their encoded size', async (t) => {
  const factory = new FakeIndexedDb();
  const jsonRecords = [
    '{"__proto__":"ordinary field","name":"fixture"}',
    '{"__proto__":null,"constructor":"stored","prototype":"stored"}',
    '{"nested":{"__proto__":{"label":"stored"}},"items":[{"__proto__":42}]}',
  ];
  factory.databasesByName.set('app', {
    version: 1,
    stores: new Map([
      [
        'items',
        store(jsonRecords.map((json, key) => ({ key, value: JSON.parse(json) as unknown }))),
      ],
    ]),
  });
  await withContentScript(t, factory, async (call) => {
    for (const [key, json] of jsonRecords.entries()) {
      const read = await call('indexeddb.read_record', { database: 'app', store: 'items', key });
      assert.equal(read.exact, true);
      assert.equal(read.described, 0);
      assert.deepEqual(read.value, JSON.parse(json) as unknown);
      assert.equal(Object.getPrototypeOf(read.value), Object.prototype);
      assert.equal(JSON.stringify(read.value), json);
      assert.equal(read.bytes, Buffer.byteLength(json));
    }
  });
});

test('a document without IndexedDB reports it unavailable; other types never fall back', async (t) => {
  await withContentScript(t, null, async (call) => {
    const result = await call('page.get_storage', { type: 'indexeddb' });
    assert.equal(result.available, false);
    assert.deepEqual(result.databases, []);
    const cookies = await call('page.get_storage', { type: 'cookies' });
    assert.equal((cookies.error as { code: string }).code, 'INVALID_REQUEST');
  });
});
