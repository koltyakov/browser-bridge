import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { deriveProtocolVersion } from '../../protocol/src/index.js';

test('extension manifest opens the side panel from the toolbar action', async () => {
  const manifestUrl = new URL('../../../manifest.json', import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));

  assert.equal(manifest.action.default_title, 'Browser Bridge');
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.side_panel.default_path, 'packages/extension/ui/sidepanel.html');
});

test('release metadata and protocol versions stay aligned', async () => {
  const [manifest, packageJson, packageLock] = await Promise.all(
    ['../../../manifest.json', '../../../package.json', '../../../package-lock.json'].map(
      async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))
    )
  );

  assert.equal(manifest.version, packageJson.version);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
  assert.notEqual(deriveProtocolVersion(packageJson.version), '0.0');
  assert.equal(deriveProtocolVersion(manifest.version), deriveProtocolVersion(packageJson.version));
  assert.deepEqual(manifest.permissions, [
    'alarms',
    'debugger',
    'nativeMessaging',
    'scripting',
    'sidePanel',
    'storage',
    'tabs',
  ]);
});
