// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_EXTENSION_ID_ENV,
  getAllowedOrigins,
  getDefaultExtensionId,
  parseExtensionId
} from '../src/install-manifest.js';

test('parseExtensionId accepts raw ids and extension origins', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  assert.equal(parseExtensionId(id), id);
  assert.equal(parseExtensionId(`chrome-extension://${id}/`), id);
  assert.equal(parseExtensionId('not-an-id'), null);
});

test('getDefaultExtensionId reads a valid env override', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  assert.equal(getDefaultExtensionId({
    [DEFAULT_EXTENSION_ID_ENV]: id
  }), id);
  assert.equal(getDefaultExtensionId({
    [DEFAULT_EXTENSION_ID_ENV]: 'invalid'
  }), null);
});

test('getAllowedOrigins merges explicit ids and removes placeholders', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  const origins = getAllowedOrigins({
    allowed_origins: [
      'chrome-extension://__REPLACE_WITH_EXTENSION_ID__/',
      'chrome-extension://qrstuvwxyzabcdefghijklmnopqrstuv/'
    ]
  }, id);

  assert.deepEqual(origins.sort(), [
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
    'chrome-extension://qrstuvwxyzabcdefghijklmnopqrstuv/'
  ].sort());
});

test('getAllowedOrigins falls back to placeholder when nothing is installed', () => {
  assert.deepEqual(getAllowedOrigins(null, null), [
    'chrome-extension://__REPLACE_WITH_EXTENSION_ID__/'
  ]);
});
