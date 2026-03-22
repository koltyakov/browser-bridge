// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_EXTENSION_ID_ENV,
  getAllowedOrigins,
  getDefaultExtensionId,
  parseExtensionId
} from '../src/install-manifest.js';
import { getManifestInstallDir } from '../src/config.js';

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

test('getManifestInstallDir returns different paths for different browsers on the same platform', () => {
  const chrome = getManifestInstallDir('chrome');
  const edge = getManifestInstallDir('edge');
  const brave = getManifestInstallDir('brave');
  const chromium = getManifestInstallDir('chromium');

  // Each browser should have a distinct install path.
  const paths = new Set([chrome, edge, brave, chromium]);
  assert.equal(paths.size, 4, 'Each browser must have a unique install path');

  // Chrome path should be the default (no arg).
  assert.equal(getManifestInstallDir(), chrome);
});

test('getManifestInstallDir contains browser-specific directory segment', () => {
  const platform = process.platform;
  if (platform === 'darwin') {
    assert.match(getManifestInstallDir('edge'), /Microsoft Edge/);
    assert.match(getManifestInstallDir('brave'), /BraveSoftware/);
    assert.match(getManifestInstallDir('chromium'), /Chromium/);
  } else if (platform === 'win32') {
    assert.match(getManifestInstallDir('edge'), /Microsoft.*Edge/);
    assert.match(getManifestInstallDir('brave'), /BraveSoftware/);
  } else {
    assert.match(getManifestInstallDir('edge'), /microsoft-edge/);
    assert.match(getManifestInstallDir('brave'), /BraveSoftware/);
    assert.match(getManifestInstallDir('chromium'), /chromium/);
  }
});
