import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getMainWorldInstrumentationKey,
  resetMainWorldInstrumentationKeyForTest,
} from '../src/background-main-world-instrumentation.js';

test('main-world instrumentation key is randomized, persisted, and reused after restart', async () => {
  let stored: Record<string, unknown> = {};
  const writes: Record<string, unknown>[] = [];
  const chrome = {
    storage: {
      session: {
        async get() {
          return stored;
        },
        async set(value: Record<string, unknown>) {
          writes.push(value);
          stored = { ...stored, ...value };
        },
      },
    },
  };

  resetMainWorldInstrumentationKeyForTest();
  const created = await getMainWorldInstrumentationKey(chrome);
  assert.match(created, /^__bbx_instrumentation_[a-z0-9]+$/);
  assert.deepEqual(writes, [{ mainWorldInstrumentationKey: created }]);

  resetMainWorldInstrumentationKeyForTest();
  assert.equal(await getMainWorldInstrumentationKey(chrome), created);
  assert.equal(writes.length, 1);
});

test('main-world instrumentation key ignores malformed persisted values', async () => {
  let written = '';
  resetMainWorldInstrumentationKeyForTest();
  const key = await getMainWorldInstrumentationKey({
    storage: {
      session: {
        async get() {
          return { mainWorldInstrumentationKey: 'predictable' };
        },
        async set(value) {
          written = String(value.mainWorldInstrumentationKey);
        },
      },
    },
  });

  assert.match(key, /^__bbx_instrumentation_[a-z0-9]+$/);
  assert.equal(written, key);
  resetMainWorldInstrumentationKeyForTest();
});
