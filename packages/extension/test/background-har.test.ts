import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { Ajv as AjvInstance, Options as AjvOptions } from 'ajv';
import type { FormatsPlugin } from 'ajv-formats';

import { buildHar } from '../src/background-har.js';

type Evidence = Parameters<typeof buildHar>[0][number];
const require = createRequire(import.meta.url);
const Ajv = require('ajv') as unknown as new (options?: AjvOptions) => AjvInstance;
const addFormats = require('ajv-formats') as unknown as FormatsPlugin;
const harSchemas = require('har-schema') as unknown as Record<string, object>;
const draft6Schema = require('ajv/dist/refs/json-schema-draft-06.json') as unknown as object;

function validateStandardHar(value: unknown) {
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  ajv.addMetaSchema(draft6Schema);
  for (const schema of Object.values(harSchemas)) ajv.addSchema(schema);
  const valid = ajv.validate(harSchemas.har, value);
  assert.equal(valid, true, JSON.stringify(ajv.errors));
}

function evidence(index: number, overrides: Partial<Evidence> = {}): Evidence {
  return {
    url: `https://example.test/resource-${index}?token=secret-${index}#fragment`,
    method: 'GET',
    resourceType: 'Fetch',
    status: 200,
    mimeType: 'application/json',
    protocol: 'h2',
    fromCache: false,
    fromDiskCache: false,
    fromServiceWorker: false,
    fromPrefetchCache: false,
    failureReason: '',
    redirectURL: '',
    duration: 10 + index,
    startedAt: 1_700_000_000_000 + index,
    ...overrides,
  };
}

test('HAR builder emits valid metadata-only HAR with exact UTF-8 length', () => {
  const entry = evidence(1, {
    fromCache: true,
    fromDiskCache: true,
    fromServiceWorker: true,
    failureReason: 'net::ERR_FAILED snowman \u2603',
    redirectURL: 'https://user:pass@example.test/final?code=private#secret',
  }) as Evidence & Record<string, unknown>;
  entry.headers = { Authorization: 'Bearer private' };
  entry.cookies = [{ name: 'session', value: 'private' }];
  entry.body = 'private body';

  const result = buildHar([entry], {
    limit: 10,
    urlPattern: null,
    creatorVersion: '1.2.3',
  });
  const parsed = JSON.parse(result.json);

  assert.deepEqual(parsed, result.har);
  validateStandardHar(parsed);
  assert.equal(result.byteLength, Buffer.byteLength(result.json, 'utf8'));
  assert.equal(result.bytes.byteLength, result.byteLength);
  assert.equal(parsed.log.version, '1.2');
  assert.deepEqual(parsed.log.creator, { name: 'Browser Bridge', version: '1.2.3' });
  const harEntry = parsed.log.entries[0];
  assert.equal(harEntry.request.url, 'https://example.test/resource-1?token=%5Bredacted%5D');
  assert.equal(harEntry.response.redirectURL, 'https://example.test/final?code=%5Bredacted%5D');
  assert.deepEqual(harEntry.request.headers, []);
  assert.deepEqual(harEntry.request.cookies, []);
  assert.equal(harEntry.request.bodySize, -1);
  assert.deepEqual(harEntry.response.headers, []);
  assert.deepEqual(harEntry.response.cookies, []);
  assert.equal(harEntry.response.content.size, -1);
  assert.deepEqual(harEntry.timings, { send: -1, wait: -1, receive: -1 });
  assert.equal(harEntry.time, 11);
  assert.deepEqual(harEntry._bbx, {
    resourceType: 'Fetch',
    fromCache: true,
    fromDiskCache: true,
    fromServiceWorker: true,
    fromPrefetchCache: false,
    failed: true,
    failureReason: 'net::ERR_FAILED snowman \u2603',
  });
  assert.doesNotMatch(result.json, /Bearer private|session|private body|secret-1|user:pass/);
});

test('HAR builder applies count and byte limits by removing whole oldest entries', () => {
  const entries = [evidence(1), evidence(2), evidence(3)];
  const twoEntries = buildHar(entries, {
    limit: 2,
    urlPattern: null,
    creatorVersion: 'test',
  });
  const byteLimited = buildHar(entries, {
    limit: 3,
    urlPattern: null,
    creatorVersion: 'test',
    maxBytes: twoEntries.byteLength,
  });

  assert.equal(twoEntries.omittedByLimit, 1);
  assert.equal(byteLimited.fits, true);
  assert.equal(byteLimited.count, 2);
  assert.equal(byteLimited.omittedBySize, 1);
  assert.deepEqual(
    byteLimited.har.log.entries.map((entry) => entry.request.url),
    twoEntries.har.log.entries.map((entry) => entry.request.url)
  );
  assert.deepEqual(JSON.parse(byteLimited.json), byteLimited.har);

  const emptyTooLarge = buildHar([], {
    limit: 1,
    urlPattern: null,
    creatorVersion: 'test',
    maxBytes: 1,
  });
  assert.equal(emptyTooLarge.fits, false);
  assert.equal(emptyTooLarge.count, 0);
  assert.doesNotThrow(() => JSON.parse(emptyTooLarge.json));
});

test('HAR builder removes control characters from browser-provided metadata', () => {
  const result = buildHar(
    [
      evidence(1, {
        method: 'GE\u001bT\n',
        resourceType: 'Fetch\u0000Injected',
        mimeType: 'application/json\r\nInjected: true',
        protocol: 'h2\u007f',
        failureReason: 'failed\u0000\u001b[31m\nnext',
        url: 'not a url\u0000\u001b\n',
        redirectURL: 'also invalid\u007f\r',
      }),
    ],
    { limit: 1, urlPattern: null, creatorVersion: '1.9.0\u0000' }
  );
  const entry = result.har.log.entries[0];
  const values = [
    entry.request.method,
    entry.request.httpVersion,
    entry.response.content.mimeType,
    entry._bbx.resourceType,
    entry._bbx.failureReason,
    entry.request.url,
    entry.response.redirectURL,
    result.har.log.creator.version,
  ];
  for (const value of values) {
    assert.equal(
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code > 31 && (code < 127 || code > 159);
      }),
      true
    );
  }
});
