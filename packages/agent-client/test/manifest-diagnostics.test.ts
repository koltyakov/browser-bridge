import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createWindowsManifestFs } from '../../../tests/_helpers/windowsManifests.js';
import { APP_NAME, PUBLISHED_EXTENSION_ID } from '../../native-host/src/config.js';
import { sanitizeIncidentalPath } from '../../protocol/src/index.js';
import {
  checkBrowserManifests,
  checkNativeHostManifestHealth,
  getDoctorReport,
  loadInstalledManifest,
  readInstalledExtensionIds,
} from '../src/runtime.js';

const customId = 'abcdefghijklmnopabcdefghijklmnop';

test('Windows diagnostics recognize mixed legacy and fresh browser layouts', async (t) => {
  const fixture = await createWindowsManifestFs(t);
  const legacyPath = fixture.manifestPath('chrome', 'legacy');
  const freshPath = fixture.manifestPath('edge');
  await fixture.writeManifest(legacyPath, [customId]);
  await fixture.writeManifest(freshPath, [PUBLISHED_EXTENSION_ID]);
  fixture.register('chrome', legacyPath);
  fixture.register('edge', freshPath);

  const statuses = await checkBrowserManifests(fixture.options);
  assert.deepEqual(
    statuses.filter((entry) => entry.installed),
    [
      { browser: 'chrome', manifestPath: legacyPath, installed: true },
      { browser: 'edge', manifestPath: freshPath, installed: true },
    ]
  );
  assert.deepEqual((await loadInstalledManifest('chrome', fixture.options))?.allowed_origins, [
    `chrome-extension://${customId}/`,
  ]);
  assert.deepEqual((await loadInstalledManifest('edge', fixture.options))?.allowed_origins, [
    `chrome-extension://${PUBLISHED_EXTENSION_ID}/`,
  ]);
  assert.deepEqual(await readInstalledExtensionIds(statuses), [customId, PUBLISHED_EXTENSION_ID]);
  assert.deepEqual(await checkNativeHostManifestHealth(statuses), []);

  const report = await getDoctorReport({
    loadManifest: () => loadInstalledManifest('chrome', fixture.options),
    checkBrowserManifests: () => checkBrowserManifests(fixture.options),
    readDaemonStartHistory: async () => [],
    checkUnwritableBridgePaths: async () => [],
    includeSetupStatus: false,
    bridgeClientRunner: async () => {
      throw new Error('Offline fixture');
    },
  });
  assert.equal(report.manifestPath, sanitizeIncidentalPath(legacyPath));
  assert.equal(report.manifestInstalled, true);
  assert.deepEqual(report.allowedOrigins, [`chrome-extension://${customId}/`]);
  assert.equal(report.issues.includes('native_host_manifest_missing'), false);
  assert.equal(report.issues.includes('native_host_manifest_invalid'), false);
});

test('Windows diagnostics prefer the registered manifest over stale files in either layout', async (t) => {
  const fixture = await createWindowsManifestFs(t);
  const legacyPath = fixture.manifestPath('chrome', 'legacy');
  const freshPath = fixture.manifestPath('chrome');
  await fixture.writeManifest(legacyPath, [customId]);
  await fixture.writeManifest(freshPath, [PUBLISHED_EXTENSION_ID]);
  for (const [registeredPath, extensionId] of [
    [legacyPath, customId],
    [freshPath, PUBLISHED_EXTENSION_ID],
  ]) {
    fixture.register('chrome', registeredPath);
    const statuses = await checkBrowserManifests(fixture.options);
    assert.equal(
      statuses.find((entry) => entry.browser === 'chrome')?.manifestPath,
      registeredPath
    );
    assert.deepEqual((await loadInstalledManifest('chrome', fixture.options))?.allowed_origins, [
      `chrome-extension://${extensionId}/`,
    ]);
  }
});

test('Windows diagnostics retain filesystem discovery for unregistered legacy manifests', async (t) => {
  const fixture = await createWindowsManifestFs(t);
  const legacyPath = fixture.manifestPath('chrome', 'legacy');
  await fixture.writeManifest(legacyPath, [customId]);
  const statuses = await checkBrowserManifests(fixture.options);
  assert.deepEqual(
    statuses.find((entry) => entry.browser === 'chrome'),
    {
      browser: 'chrome',
      manifestPath: legacyPath,
      installed: true,
    }
  );
  assert.deepEqual((await loadInstalledManifest('chrome', fixture.options))?.allowed_origins, [
    `chrome-extension://${customId}/`,
  ]);
});

test('Windows diagnostics honor custom registered paths and expose missing registered targets', async (t) => {
  const fixture = await createWindowsManifestFs(t);
  const registeredPath = path.join(fixture.root, 'Custom Manifest', `${APP_NAME}.json`);
  await fixture.writeManifest(registeredPath, [customId]);
  await fixture.writeManifest(fixture.manifestPath('chrome', 'legacy'), [PUBLISHED_EXTENSION_ID]);
  fixture.register('chrome', registeredPath);
  let statuses = await checkBrowserManifests(fixture.options);
  assert.deepEqual(
    statuses.find((entry) => entry.browser === 'chrome'),
    {
      browser: 'chrome',
      manifestPath: registeredPath,
      installed: true,
    }
  );
  await fs.promises.rm(registeredPath);
  statuses = await checkBrowserManifests(fixture.options);
  assert.deepEqual(
    statuses.find((entry) => entry.browser === 'chrome'),
    {
      browser: 'chrome',
      manifestPath: registeredPath,
      installed: false,
    }
  );
  assert.equal(await loadInstalledManifest('chrome', fixture.options), null);
});
