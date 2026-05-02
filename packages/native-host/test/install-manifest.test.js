// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_EXTENSION_ID_ENV,
  getAllowedOrigins,
  getDefaultExtensionId,
  INSTALL_NATIVE_MANIFEST_ERROR,
  installNativeManifest,
  NativeManifestInstallError,
  uninstallNativeManifest,
  parseExtensionId,
} from '../src/install-manifest.js';
import { getLauncherFilename, getManifestInstallDir } from '../src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const installManifestCliPath = path.join(
  repoRoot,
  'packages',
  'native-host',
  'bin',
  'install-manifest.js'
);

test('parseExtensionId accepts raw ids and extension origins', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  assert.equal(parseExtensionId(id), id);
  assert.equal(parseExtensionId(`chrome-extension://${id}/`), id);
  assert.equal(parseExtensionId('not-an-id'), null);
});

test('getDefaultExtensionId reads a valid env override', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  assert.equal(
    getDefaultExtensionId({
      [DEFAULT_EXTENSION_ID_ENV]: id,
    }),
    id
  );
  assert.equal(
    getDefaultExtensionId({
      [DEFAULT_EXTENSION_ID_ENV]: 'invalid',
    }),
    null
  );
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
      stdout: {
        write: (value) => {
          output.push(String(value));
          return true;
        },
      },
      env: {
        ...process.env,
        [DEFAULT_EXTENSION_ID_ENV]: 'abcdefghijklmnopabcdefghijklmnop',
      },
    });

    assert.ok(
      output.some((line) => line.includes(`Used extension ID from ${DEFAULT_EXTENSION_ID_ENV}.`))
    );

    output.length = 0;

    await installNativeManifest({
      repoRoot: process.cwd(),
      installDir: path.join(tempDir, 'manifest-built-in'),
      bridgeDir: path.join(tempDir, 'bridge-built-in'),
      stdout: {
        write: (value) => {
          output.push(String(value));
          return true;
        },
      },
      env: { ...process.env, [DEFAULT_EXTENSION_ID_ENV]: undefined },
    });

    assert.ok(output.some((line) => line.includes('Used built-in Browser Bridge extension ID.')));
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('installNativeManifest rejects an invalid env extension id override', async () => {
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'bbx-install-manifest-invalid-')
  );

  try {
    await assert.rejects(
      installNativeManifest({
        repoRoot: process.cwd(),
        installDir: path.join(tempDir, 'manifest'),
        bridgeDir: path.join(tempDir, 'bridge'),
        env: { ...process.env, [DEFAULT_EXTENSION_ID_ENV]: 'invalid' },
      }),
      /Invalid BROWSER_BRIDGE_EXTENSION_ID/
    );
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('postinstall path preserves an existing custom extension id and warns', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-install-manifest-custom-'));
  const installDir = path.join(tempDir, 'manifest');
  const bridgeDir = path.join(tempDir, 'bridge');
  const manifestPath = path.join(installDir, 'com.browserbridge.browser_bridge.json');
  const customId = 'abcdefghijklmnopabcdefghijklmnop';
  /** @type {string[]} */
  const stdout = [];
  /** @type {string[]} */
  const stderr = [];

  try {
    await fs.promises.mkdir(installDir, { recursive: true });
    await fs.promises.writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          name: 'com.browserbridge.browser_bridge',
          description: 'Browser Bridge native host',
          path: '/tmp/native-host-launcher.sh',
          type: 'stdio',
          allowed_origins: [`chrome-extension://${customId}/`],
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const result = await installNativeManifest({
      repoRoot: process.cwd(),
      installDir,
      bridgeDir,
      preserveCustomExtensionId: true,
      stdout: {
        write: (value) => {
          stdout.push(String(value));
          return true;
        },
      },
      stderr: {
        write: (value) => {
          stderr.push(String(value));
          return true;
        },
      },
      env: { ...process.env, [DEFAULT_EXTENSION_ID_ENV]: undefined },
    });

    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${customId}/`]);
    assert.equal(result.extensionId, customId);
    assert.ok(
      stderr.some((line) =>
        line.includes(
          `keeps custom extension ID ${customId} instead of the Browser Bridge store ID`
        )
      )
    );
    assert.ok(stdout.every((line) => !line.includes('Used built-in Browser Bridge extension ID.')));
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('installNativeManifest overwrites an existing manifest with updated contents', async () => {
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'bbx-install-manifest-overwrite-')
  );
  const installDir = path.join(tempDir, 'manifest');
  const bridgeDir = path.join(tempDir, 'bridge');
  const manifestPath = path.join(installDir, 'com.browserbridge.browser_bridge.json');
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';

  try {
    await fs.promises.mkdir(installDir, { recursive: true });
    await fs.promises.writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          name: 'com.browserbridge.browser_bridge',
          description: 'Old description',
          path: '/tmp/old-launcher.sh',
          type: 'stdio',
          allowed_origins: ['chrome-extension://__REPLACE_WITH_EXTENSION_ID__/'],
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const result = await installNativeManifest({
      repoRoot: process.cwd(),
      extensionIdArg: extensionId,
      installDir,
      bridgeDir,
      stdout: {
        write() {
          return true;
        },
      },
    });

    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    assert.equal(result.manifestPath, manifestPath);
    assert.equal(manifest.description, 'Browser Bridge native host');
    assert.equal(manifest.path, path.join(bridgeDir, getLauncherFilename()));
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('installNativeManifest creates missing nested install and bridge directories', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-install-manifest-nested-'));
  const installDir = path.join(tempDir, 'deep', 'manifest', 'dir');
  const bridgeDir = path.join(tempDir, 'deep', 'bridge', 'dir');
  const extensionId = 'qrstuvwxyzabcdefghijklmnopqrstuv';

  try {
    const result = await installNativeManifest({
      repoRoot: process.cwd(),
      extensionIdArg: extensionId,
      installDir,
      bridgeDir,
      stdout: {
        write() {
          return true;
        },
      },
    });

    const manifest = JSON.parse(await fs.promises.readFile(result.manifestPath, 'utf8'));
    await fs.promises.access(result.manifestPath);
    await fs.promises.access(result.launcherPath);
    assert.equal(manifest.path, result.launcherPath);
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('installNativeManifest wraps target directory write failures in a typed error', async (t) => {
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'bbx-install-manifest-permission-')
  );
  const installDir = path.join(tempDir, 'manifest');
  const bridgeDir = path.join(tempDir, 'bridge');
  const permissionError = /** @type {NodeJS.ErrnoException} */ (
    Object.assign(new Error(`EACCES: permission denied, mkdir '${installDir}'`), { code: 'EACCES' })
  );
  const originalMkdir = fs.promises.mkdir;

  t.mock.method(
    fs.promises,
    'mkdir',
    /** @type {typeof fs.promises.mkdir} */ (
      async (targetPath, options) => {
        if (String(targetPath) === installDir) {
          throw permissionError;
        }
        return originalMkdir.call(fs.promises, targetPath, options);
      }
    )
  );

  try {
    await assert.rejects(
      installNativeManifest({
        repoRoot: process.cwd(),
        installDir,
        bridgeDir,
        stdout: {
          write() {
            return true;
          },
        },
      }),
      (error) => {
        assert.ok(error instanceof NativeManifestInstallError);
        assert.equal(error.code, INSTALL_NATIVE_MANIFEST_ERROR);
        assert.equal(error.targetPath, installDir);
        assert.equal(error.errnoCode, 'EACCES');
        assert.equal(error.cause, permissionError);
        assert.match(error.message, /Failed to install native host files at .*manifest/);
        return true;
      }
    );
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('getAllowedOrigins merges explicit ids and removes placeholders', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  const origins = getAllowedOrigins(
    {
      allowed_origins: [
        'chrome-extension://__REPLACE_WITH_EXTENSION_ID__/',
        'chrome-extension://qrstuvwxyzabcdefghijklmnopqrstuv/',
      ],
    },
    id
  );

  assert.deepEqual(
    origins.sort(),
    [
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
      'chrome-extension://qrstuvwxyzabcdefghijklmnopqrstuv/',
    ].sort()
  );
});

test('getAllowedOrigins falls back to placeholder when nothing is installed', () => {
  assert.deepEqual(getAllowedOrigins(null, null), [
    'chrome-extension://__REPLACE_WITH_EXTENSION_ID__/',
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
  await fs.promises.writeFile(
    path.join(installDir, 'com.browserbridge.browser_bridge.json'),
    '{}\n',
    'utf8'
  );
  await fs.promises.writeFile(path.join(bridgeDir, getLauncherFilename()), 'launcher\n', 'utf8');

  try {
    const result = await uninstallNativeManifest({
      installDir,
      bridgeDir,
      removeBridgeDir: true,
      stdout: {
        write() {
          return true;
        },
      },
    });

    assert.equal(result.removedManifest, true);
    assert.equal(result.removedBridgeDir, true);
    await assert.rejects(
      fs.promises.access(path.join(installDir, 'com.browserbridge.browser_bridge.json'))
    );
    await assert.rejects(fs.promises.access(bridgeDir));
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('uninstallNativeManifest is a no-op when the native host manifest is absent', async () => {
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'bbx-uninstall-manifest-absent-')
  );
  const installDir = path.join(tempDir, 'manifest');
  const bridgeDir = path.join(tempDir, 'bridge');
  /** @type {string[]} */
  const output = [];

  try {
    await fs.promises.mkdir(installDir, { recursive: true });

    const result = await uninstallNativeManifest({
      installDir,
      bridgeDir,
      stdout: {
        write(value) {
          output.push(String(value));
          return true;
        },
      },
    });

    assert.equal(
      result.manifestPath,
      path.join(installDir, 'com.browserbridge.browser_bridge.json')
    );
    assert.equal(result.bridgeDir, bridgeDir);
    assert.equal(result.removedManifest, false);
    assert.equal(result.removedBridgeDir, false);
    assert.deepEqual(output, []);
    await fs.promises.access(installDir);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('install-manifest CLI --uninstall removes installed native host files from a temp home', async () => {
  const tempHome = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'bbx-install-manifest-cli-home-')
  );
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const env = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    LOCALAPPDATA: path.join(tempHome, 'AppData', 'Local'),
  };

  try {
    const installResult = spawnSync(process.execPath, [installManifestCliPath, extensionId], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
    });

    assert.equal(installResult.status, 0);
    assert.equal(installResult.signal, null);
    assert.equal(installResult.stderr, '');

    const manifestMatch = installResult.stdout.match(
      /^Wrote (.+com\.browserbridge\.browser_bridge\.json)$/m
    );
    const launcherMatch = installResult.stdout.match(
      new RegExp(`^Wrote (.+${getLauncherFilename().replace('.', '\\.')})$`, 'm')
    );

    assert.ok(manifestMatch, 'install CLI should print the manifest path');
    assert.ok(launcherMatch, 'install CLI should print the launcher path');

    const manifestPath = manifestMatch[1];
    const launcherPath = launcherMatch[1];

    await fs.promises.access(manifestPath);
    await fs.promises.access(launcherPath);

    const uninstallResult = spawnSync(process.execPath, [installManifestCliPath, '--uninstall'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
    });

    assert.equal(uninstallResult.status, 0);
    assert.equal(uninstallResult.signal, null);
    assert.equal(uninstallResult.stderr, '');
    assert.match(
      uninstallResult.stdout,
      new RegExp(`Removed ${manifestPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    );
    assert.match(
      uninstallResult.stdout,
      new RegExp(`Removed ${path.dirname(launcherPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    );

    await assert.rejects(fs.promises.access(manifestPath));
    await assert.rejects(fs.promises.access(launcherPath));
  } finally {
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  }
});
