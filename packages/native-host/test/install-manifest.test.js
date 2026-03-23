// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_EXTENSION_ID_ENV,
  getAllowedOrigins,
  getDefaultExtensionId,
  installNativeManifest,
  uninstallNativeManifest,
  parseExtensionId
} from '../src/install-manifest.js';
import { getLauncherFilename, getManifestInstallDir } from '../src/config.js';

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

test('installNativeManifest reports whether the extension id came from env or built-in default', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-install-manifest-'));
  /** @type {string[]} */
  const output = [];

  try {
    await installNativeManifest({
      repoRoot: process.cwd(),
      installDir: path.join(tempDir, 'manifest'),
      bridgeDir: path.join(tempDir, 'bridge'),
      stdout: { write: (value) => { output.push(value); return true; } },
      env: { ...process.env, [DEFAULT_EXTENSION_ID_ENV]: 'abcdefghijklmnopabcdefghijklmnop' }
    });

    assert.ok(output.some((line) => line.includes(`Used extension ID from ${DEFAULT_EXTENSION_ID_ENV}.`)));

    output.length = 0;

    await installNativeManifest({
      repoRoot: process.cwd(),
      installDir: path.join(tempDir, 'manifest-built-in'),
      bridgeDir: path.join(tempDir, 'bridge-built-in'),
      stdout: { write: (value) => { output.push(value); return true; } },
      env: { ...process.env, [DEFAULT_EXTENSION_ID_ENV]: undefined }
    });

    assert.ok(output.some((line) => line.includes('Used built-in Browser Bridge extension ID.')));
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('installNativeManifest rejects an invalid env extension id override', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-install-manifest-invalid-'));

  try {
    await assert.rejects(
      installNativeManifest({
        repoRoot: process.cwd(),
        installDir: path.join(tempDir, 'manifest'),
        bridgeDir: path.join(tempDir, 'bridge'),
        env: { ...process.env, [DEFAULT_EXTENSION_ID_ENV]: 'invalid' }
      }),
      /Invalid BROWSER_BRIDGE_EXTENSION_ID/
    );
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
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

test('getLauncherFilename matches the current platform', () => {
  if (process.platform === 'win32') {
    assert.equal(getLauncherFilename(), 'native-host-launcher.cmd');
    return;
  }

  assert.equal(getLauncherFilename(), 'native-host-launcher.sh');
});

test('uninstallNativeManifest removes the native host manifest and bridge dir', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-uninstall-manifest-'));
  const installDir = path.join(tempDir, 'manifest');
  const bridgeDir = path.join(tempDir, 'bridge');

  await fs.promises.mkdir(installDir, { recursive: true });
  await fs.promises.mkdir(bridgeDir, { recursive: true });
  await fs.promises.writeFile(path.join(installDir, 'com.browserbridge.browser_bridge.json'), '{}\n', 'utf8');
  await fs.promises.writeFile(path.join(bridgeDir, getLauncherFilename()), 'launcher\n', 'utf8');

  try {
    const result = await uninstallNativeManifest({
      installDir,
      bridgeDir,
      removeBridgeDir: true,
      stdout: { write() { return true; } }
    });

    assert.equal(result.removedManifest, true);
    assert.equal(result.removedBridgeDir, true);
    await assert.rejects(fs.promises.access(path.join(installDir, 'com.browserbridge.browser_bridge.json')));
    await assert.rejects(fs.promises.access(bridgeDir));
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});
