import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createWindowsManifestFs } from '../../../tests/_helpers/windowsManifests.js';
import { APP_NAME, PUBLISHED_EXTENSION_ID } from '../src/config.js';
import {
  getWindowsRegistryKey,
  installNativeManifest,
  NativeManifestInstallError,
  readWindowsRegistryValue,
  resolveNativeManifestPath,
  uninstallNativeManifest,
} from '../src/install-manifest.js';

const customId = 'abcdefghijklmnopabcdefghijklmnop';
const otherId = 'ponmlkjihgfedcbaponmlkjihgfedcba';

test('fresh Windows installs use separate browser manifests in the bridge directory', async (t) => {
  const fixture = await createWindowsManifestFs(t);
  for (const [browser, extensionId] of [
    ['chrome', customId],
    ['edge', otherId],
    ['brave', PUBLISHED_EXTENSION_ID],
  ] as const) {
    const result = await installNativeManifest({
      ...fixture.options,
      browser,
      extensionIdArg: extensionId,
    });
    assert.equal(result.manifestPath, fixture.manifestPath(browser));
    assert.equal(fixture.registry.get(getWindowsRegistryKey(browser)), result.manifestPath);
    assert.deepEqual(
      JSON.parse(await fs.promises.readFile(result.manifestPath, 'utf8')).allowed_origins,
      [`chrome-extension://${extensionId}/`]
    );
    assert.equal(fs.existsSync(fixture.manifestPath(browser, 'legacy')), false);
  }
  assert.notEqual(fixture.manifestPath('chrome'), fixture.manifestPath('edge'));
});

test('Windows upgrades preserve a registered legacy path and custom extension allowlist', async (t) => {
  const fixture = await createWindowsManifestFs(t);
  const legacyPath = fixture.manifestPath('chrome', 'legacy');
  const origins = [customId, otherId];
  await fixture.writeManifest(legacyPath, origins);
  const unusedManifest = await fixture.writeManifest(fixture.manifestPath('chrome'), [
    PUBLISHED_EXTENSION_ID,
  ]);
  fixture.register('chrome', legacyPath);
  const originalRegistry = new Map(fixture.registry);

  for (const preserveCustomExtensionId of [undefined, true]) {
    const result = await installNativeManifest({
      ...fixture.options,
      browser: 'chrome',
      preserveCustomExtensionId,
    });
    assert.equal(result.manifestPath, legacyPath);
    assert.equal(result.extensionId, customId);
    assert.deepEqual(
      result.allowedOrigins,
      origins.map((id) => `chrome-extension://${id}/`)
    );
    assert.deepEqual(fixture.registry, originalRegistry);
    assert.equal(
      await fs.promises.readFile(fixture.manifestPath('chrome'), 'utf8'),
      unusedManifest
    );
  }
});

test('Windows reinstallation reuses an unregistered legacy manifest, including mixed store/custom IDs', async (t) => {
  const fixture = await createWindowsManifestFs(t);
  const legacyPath = fixture.manifestPath('edge', 'legacy');
  await fixture.writeManifest(legacyPath, [PUBLISHED_EXTENSION_ID, customId]);
  const result = await installNativeManifest({ ...fixture.options, browser: 'edge' });
  assert.equal(result.manifestPath, legacyPath);
  assert.deepEqual(
    result.allowedOrigins,
    [PUBLISHED_EXTENSION_ID, customId].map((id) => `chrome-extension://${id}/`)
  );
  assert.equal(fixture.registry.get(getWindowsRegistryKey('edge')), legacyPath);
  assert.equal(fs.existsSync(fixture.manifestPath('edge')), false);
});

test('Windows upgrades honor a valid custom registered manifest location', async (t) => {
  const fixture = await createWindowsManifestFs(t);
  const registeredPath = path.join(fixture.root, 'Custom Host', `${APP_NAME}.json`);
  await fixture.writeManifest(registeredPath, [customId]);
  fixture.register('chrome', registeredPath);
  const result = await installNativeManifest({ ...fixture.options, browser: 'chrome' });
  assert.equal(result.manifestPath, registeredPath);
  assert.deepEqual(result.allowedOrigins, [`chrome-extension://${customId}/`]);
  assert.equal(fs.existsSync(fixture.manifestPath('chrome')), false);
});

test('explicit extension ID overrides update only the selected Windows browser', async (t) => {
  const fixture = await createWindowsManifestFs(t);
  const chromePath = fixture.manifestPath('chrome', 'legacy');
  await fixture.writeManifest(chromePath, [customId]);
  fixture.register('chrome', chromePath);
  const edgePath = fixture.manifestPath('edge');
  const edgeContents = await fixture.writeManifest(edgePath, [customId]);
  fixture.register('edge', edgePath);

  const result = await installNativeManifest({
    ...fixture.options,
    browser: 'chrome',
    extensionIdArg: otherId,
  });
  assert.deepEqual(result.allowedOrigins, [`chrome-extension://${otherId}/`]);
  assert.equal(await fs.promises.readFile(edgePath, 'utf8'), edgeContents);
  assert.equal(fixture.registry.get(getWindowsRegistryKey('edge')), edgePath);

  const envResult = await installNativeManifest({
    ...fixture.options,
    browser: 'chrome',
    env: { ...fixture.env, BROWSER_BRIDGE_EXTENSION_ID: PUBLISHED_EXTENSION_ID },
  });
  assert.deepEqual(envResult.allowedOrigins, [`chrome-extension://${PUBLISHED_EXTENSION_ID}/`]);
});

for (const replacement of [false, true]) {
  test(`failed Windows registry writes preserve the old install${replacement ? ' during relocation' : ''}`, async (t) => {
    const fixture = await createWindowsManifestFs(t);
    const legacyPath = fixture.manifestPath('chrome', 'legacy');
    const originalManifest = await fixture.writeManifest(legacyPath, [customId]);
    fixture.register('chrome', legacyPath);
    const originalLauncher = await fs.promises.readFile(fixture.launcherPath, 'utf8');
    const originalRegistry = new Map(fixture.registry);
    const targetPath = replacement ? fixture.manifestPath('chrome') : legacyPath;
    const failure = new Error('Registry access denied');

    await assert.rejects(
      installNativeManifest({
        ...fixture.options,
        browser: 'chrome',
        installDir: replacement ? path.dirname(targetPath) : undefined,
        extensionIdArg: otherId,
        async writeRegistryValue() {
          assert.equal(
            fs.existsSync(targetPath),
            true,
            'replacement must exist before registration'
          );
          assert.equal(fs.existsSync(legacyPath), true, 'old manifest must still exist');
          if (replacement)
            assert.equal(await fs.promises.readFile(legacyPath, 'utf8'), originalManifest);
          throw failure;
        },
      }),
      (error) => {
        assert.ok(error instanceof NativeManifestInstallError);
        assert.equal(error.targetPath, getWindowsRegistryKey('chrome'));
        assert.equal(error.cause, failure);
        return true;
      }
    );

    assert.equal(await fs.promises.readFile(legacyPath, 'utf8'), originalManifest);
    assert.equal(await fs.promises.readFile(fixture.launcherPath, 'utf8'), originalLauncher);
    assert.deepEqual(fixture.registry, originalRegistry);
    if (replacement) assert.equal(fs.existsSync(targetPath), false);
    assert.equal(
      (await fs.promises.readdir(path.dirname(targetPath))).some((entry) => entry.endsWith('.tmp')),
      false
    );
  });
}

test('Windows manifest write failures restore the launcher and never update the registry', async (t) => {
  const fixture = await createWindowsManifestFs(t);
  const legacyPath = fixture.manifestPath('chrome', 'legacy');
  const originalManifest = await fixture.writeManifest(legacyPath, [customId]);
  fixture.register('chrome', legacyPath);
  const originalLauncher = await fs.promises.readFile(fixture.launcherPath, 'utf8');
  const rename = fs.promises.rename;
  let failed = false;
  t.mock.method(fs.promises, 'rename', async (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination) === legacyPath && !failed) {
      failed = true;
      throw new Error('Manifest write denied');
    }
    return rename(source, destination);
  });
  await assert.rejects(
    installNativeManifest({
      ...fixture.options,
      browser: 'chrome',
      writeRegistryValue() {
        assert.fail('must not register a failed manifest write');
      },
    }),
    /Manifest write denied/
  );
  assert.equal(await fs.promises.readFile(legacyPath, 'utf8'), originalManifest);
  assert.equal(await fs.promises.readFile(fixture.launcherPath, 'utf8'), originalLauncher);
});

test('Windows registry query failures do not touch existing host files or registrations', async (t) => {
  const fixture = await createWindowsManifestFs(t);
  const legacyPath = fixture.manifestPath('chrome', 'legacy');
  const contents = await fixture.writeManifest(legacyPath, [customId]);
  fixture.register('chrome', legacyPath);
  await assert.rejects(
    installNativeManifest({
      ...fixture.options,
      browser: 'chrome',
      readRegistryValue() {
        throw new Error('Registry query denied');
      },
    }),
    /Registry query denied/
  );
  assert.equal(await fs.promises.readFile(legacyPath, 'utf8'), contents);
  assert.equal(fixture.registry.get(getWindowsRegistryKey('chrome')), legacyPath);
});

test('Windows uninstall removes both layouts for one browser but keeps other browsers working', async (t) => {
  const fixture = await createWindowsManifestFs(t);
  const chromeLegacy = fixture.manifestPath('chrome', 'legacy');
  const chromeFresh = fixture.manifestPath('chrome');
  await fixture.writeManifest(chromeLegacy, [customId]);
  await fixture.writeManifest(chromeFresh, [customId]);
  fixture.register('chrome', chromeLegacy);
  const edgePath = fixture.manifestPath('edge');
  const edgeContents = await fixture.writeManifest(edgePath, [otherId]);
  fixture.register('edge', edgePath);

  const chromeResult = await uninstallNativeManifest({
    ...fixture.options,
    browser: 'chrome',
    removeBridgeDir: true,
  });
  assert.equal(chromeResult.removedManifest, true);
  assert.equal(chromeResult.removedBridgeDir, false);
  assert.equal(fs.existsSync(chromeLegacy), false);
  assert.equal(fs.existsSync(chromeFresh), false);
  assert.equal(fixture.registry.has(getWindowsRegistryKey('chrome')), false);
  assert.equal(fixture.registry.get(getWindowsRegistryKey('edge')), edgePath);
  assert.equal(await fs.promises.readFile(edgePath, 'utf8'), edgeContents);
  assert.equal(fs.existsSync(fixture.launcherPath), true);

  const edgeResult = await uninstallNativeManifest({
    ...fixture.options,
    browser: 'edge',
    removeBridgeDir: true,
  });
  assert.equal(edgeResult.removedBridgeDir, true);
  assert.equal(fixture.registry.size, 0);
  assert.equal(fs.existsSync(fixture.bridgeDir), false);
});

test('failed Windows unregistration leaves both manifest layouts and launcher intact', async (t) => {
  const fixture = await createWindowsManifestFs(t);
  const legacyPath = fixture.manifestPath('chrome', 'legacy');
  await fixture.writeManifest(legacyPath, [customId]);
  await fixture.writeManifest(fixture.manifestPath('chrome'), [customId]);
  fixture.register('chrome', legacyPath);
  await assert.rejects(
    uninstallNativeManifest({
      ...fixture.options,
      browser: 'chrome',
      removeBridgeDir: true,
      deleteRegistryKey() {
        throw new Error('Cannot delete registry key');
      },
    }),
    /Cannot delete registry key/
  );
  assert.equal(fs.existsSync(legacyPath), true);
  assert.equal(fs.existsSync(fixture.manifestPath('chrome')), true);
  assert.equal(fs.existsSync(fixture.launcherPath), true);
  assert.equal(fixture.registry.get(getWindowsRegistryKey('chrome')), legacyPath);
});

test('Windows uninstall preserves a shared manifest until its last registration is removed', async (t) => {
  const fixture = await createWindowsManifestFs(t);
  const sharedPath = path.join(fixture.bridgeDir, `${APP_NAME}.json`);
  await fixture.writeManifest(sharedPath, [customId]);
  fixture.register('chrome', sharedPath);
  fixture.register('edge', sharedPath);
  await uninstallNativeManifest({ ...fixture.options, browser: 'chrome', removeBridgeDir: true });
  assert.equal(fs.existsSync(sharedPath), true);
  assert.equal(fixture.registry.has(getWindowsRegistryKey('chrome')), false);
  assert.equal(fixture.registry.get(getWindowsRegistryKey('edge')), sharedPath);
  await uninstallNativeManifest({ ...fixture.options, browser: 'edge', removeBridgeDir: true });
  assert.equal(fs.existsSync(sharedPath), false);
  assert.equal(fs.existsSync(fixture.bridgeDir), false);
});

test('Windows uninstall respects the existing Arc/Chromium registry alias', async (t) => {
  const fixture = await createWindowsManifestFs(t);
  const chromiumPath = fixture.manifestPath('chromium');
  await fixture.writeManifest(chromiumPath, [customId]);
  await fixture.writeManifest(fixture.manifestPath('arc'), [otherId]);
  fixture.register('chromium', chromiumPath);
  await uninstallNativeManifest({ ...fixture.options, browser: 'arc', removeBridgeDir: true });
  assert.equal(fixture.registry.get(getWindowsRegistryKey('chromium')), chromiumPath);
  assert.equal(fs.existsSync(chromiumPath), true);
  assert.equal(fs.existsSync(fixture.manifestPath('arc')), false);
  assert.equal(fs.existsSync(fixture.launcherPath), true);
  await uninstallNativeManifest({ ...fixture.options, browser: 'chromium', removeBridgeDir: true });
  assert.equal(fixture.registry.size, 0);
  assert.equal(fs.existsSync(fixture.bridgeDir), false);
});

test('Windows uninstall unregisters a browser referencing another browser-owned manifest', async (t) => {
  const fixture = await createWindowsManifestFs(t);
  const edgePath = fixture.manifestPath('edge');
  await fixture.writeManifest(edgePath, [customId]);
  fixture.register('chrome', edgePath);
  fixture.register('edge', edgePath);
  await uninstallNativeManifest({ ...fixture.options, browser: 'chrome', removeBridgeDir: true });
  assert.equal(fixture.registry.has(getWindowsRegistryKey('chrome')), false);
  assert.equal(fixture.registry.get(getWindowsRegistryKey('edge')), edgePath);
  assert.equal(fs.existsSync(edgePath), true);
  assert.equal(fs.existsSync(fixture.launcherPath), true);
});

test('Windows registry value reads support localized labels and paths containing spaces', async () => {
  const key = getWindowsRegistryKey('chrome');
  const target = 'C:\\Users\\Test User\\Browser Bridge\\chrome.json';
  const value = await readWindowsRegistryValue(key, async (file, args) => {
    assert.match(file, /reg\.exe$/u);
    assert.deepEqual(args, ['query', key, '/ve']);
    return { stdout: `\r\n${key}\r\n    (Par défaut)    REG_SZ    ${target}\r\n` };
  });
  assert.equal(value, target);
  assert.equal(
    await readWindowsRegistryValue(key, async () => {
      throw new Error('ERROR: The system was unable to find the specified registry key or value.');
    }),
    null
  );
  await assert.rejects(
    readWindowsRegistryValue(key, async () => {
      throw new Error('Access is denied.');
    }),
    /Access is denied/
  );
  await assert.rejects(
    readWindowsRegistryValue(key, async () => ({ stdout: '    (Default)    REG_DWORD    123' })),
    /not a REG_SZ/
  );
});

test('a missing registered Windows target is not replaced by a stale manifest in another layout', async (t) => {
  const fixture = await createWindowsManifestFs(t);
  await fixture.writeManifest(fixture.manifestPath('chrome', 'legacy'), [customId]);
  fixture.register('chrome', fixture.manifestPath('chrome'));
  assert.equal(
    await resolveNativeManifestPath('chrome', fixture.options),
    fixture.manifestPath('chrome')
  );
});

test('localized Windows registry failures distinguish absent keys from denied access', async () => {
  const key = getWindowsRegistryKey('chrome');
  const localizedError = Object.assign(
    new Error('Der angegebene Registrierungsschlüssel wurde nicht gefunden.'),
    { code: 1 }
  );
  for (const value of [null, 'C:\\Browser Bridge\\chrome.json']) {
    const calls: string[] = [];
    const result = await readWindowsRegistryValue(key, async (file, args) => {
      calls.push(file);
      if (file.endsWith('reg.exe')) throw localizedError;
      assert.match(file, /powershell\.exe$/u);
      assert.match(args.at(-1) || '', /Microsoft\.Win32\.Registry/u);
      return { stdout: JSON.stringify(value) };
    });
    assert.equal(result, value);
    assert.equal(calls.length, 2);
  }
  await assert.rejects(
    readWindowsRegistryValue(key, async (file) => {
      if (file.endsWith('reg.exe'))
        throw Object.assign(new Error('Zugriff verweigert'), { code: 1 });
      throw new Error('Registry API access denied');
    }),
    /Registry API access denied/
  );
  await assert.rejects(
    readWindowsRegistryValue(key, async (file) => {
      if (file.endsWith('reg.exe')) throw localizedError;
      return { stdout: '42' };
    }),
    /not a string path/
  );
});

test('Windows refuses a relative registered manifest path before writing host files', async (t) => {
  const fixture = await createWindowsManifestFs(t);
  fixture.register('chrome', 'relative-manifest.json');
  await assert.rejects(
    installNativeManifest({ ...fixture.options, browser: 'chrome' }),
    /must be absolute/
  );
  assert.equal(fs.existsSync(fixture.launcherPath), false);
});

test('Windows uninstall aborts without changes if another registration cannot be inspected', async (t) => {
  const fixture = await createWindowsManifestFs(t);
  const manifestPath = fixture.manifestPath('chrome', 'legacy');
  const contents = await fixture.writeManifest(manifestPath, [customId]);
  fixture.register('chrome', manifestPath);
  await assert.rejects(
    uninstallNativeManifest({
      ...fixture.options,
      browser: 'chrome',
      readRegistryValue(key) {
        if (key === getWindowsRegistryKey('edge'))
          throw new Error('Cannot inspect other registration');
        return fixture.options.readRegistryValue(key);
      },
    }),
    /Cannot inspect other registration/
  );
  assert.equal(await fs.promises.readFile(manifestPath, 'utf8'), contents);
  assert.equal(fixture.registry.get(getWindowsRegistryKey('chrome')), manifestPath);
});
