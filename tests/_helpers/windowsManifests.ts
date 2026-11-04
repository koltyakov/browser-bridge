import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

import {
  APP_NAME,
  BRIDGE_HOME_ENV,
  getLauncherFilename,
  getLegacyManifestInstallDir,
  getManifestInstallDir,
} from '../../packages/native-host/src/config.js';
import type { SupportedBrowser } from '../../packages/native-host/src/config.js';
import { getWindowsRegistryKey } from '../../packages/native-host/src/install-manifest.js';

export async function createWindowsManifestFs(t: TestContext) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-windows-manifests-'));
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(originalPlatform);
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  t.mock.method(os, 'platform', () => 'win32');
  t.after(async () => {
    Object.defineProperty(process, 'platform', originalPlatform);
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const bridgeDir = path.join(root, 'Browser Bridge');
  const env = {
    LOCALAPPDATA: path.join(root, 'Local AppData'),
    [BRIDGE_HOME_ENV]: bridgeDir,
  };
  const registry = new Map<string, string>();
  const options = {
    repoRoot: process.cwd(),
    env,
    bridgeDir,
    readRegistryValue: (key: string) => registry.get(key) ?? null,
    writeRegistryValue: (key: string, value: string) => {
      registry.set(key, value);
    },
    deleteRegistryKey: (key: string) => registry.delete(key),
    stdout: { write: () => true },
    stderr: { write: () => true },
  };
  const launcherPath = path.join(bridgeDir, getLauncherFilename());

  function manifestPath(browser: SupportedBrowser, layout: 'fresh' | 'legacy' = 'fresh') {
    const directory =
      layout === 'legacy'
        ? getLegacyManifestInstallDir(browser, env)
        : getManifestInstallDir(browser, env);
    return path.join(directory, `${APP_NAME}.json`);
  }

  async function writeManifest(filePath: string, extensionIds: string[]) {
    const manifest = {
      name: APP_NAME,
      description: 'Existing native host',
      path: launcherPath,
      type: 'stdio',
      allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
    };
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.mkdir(bridgeDir, { recursive: true });
    const hostPath = path.join(process.cwd(), 'packages', 'native-host', 'bin', 'native-host.js');
    await fs.promises.writeFile(
      launcherPath,
      `@echo off\r\n"${process.execPath}" "${hostPath}" %*\r\n`
    );
    const contents = `${JSON.stringify(manifest, null, 2)}\n`;
    await fs.promises.writeFile(filePath, contents);
    return contents;
  }

  function register(browser: SupportedBrowser, filePath: string) {
    registry.set(getWindowsRegistryKey(browser), filePath);
  }

  return {
    root,
    bridgeDir,
    launcherPath,
    env,
    registry,
    options,
    manifestPath,
    writeManifest,
    register,
  };
}
