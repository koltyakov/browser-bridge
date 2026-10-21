import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test(
  'companion migration is transactional and preserves settings and custom origins',
  { skip: process.platform === 'win32' },
  async (t) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-install-test-'));
    const originalEnv = { ...process.env };
    process.env.HOME = temporary;
    process.env.ZDOTDIR = temporary;
    process.env.BROWSER_BRIDGE_HOME = path.join(temporary, 'bridge');
    process.env.XDG_CONFIG_HOME = path.join(temporary, '.config');
    process.env.CODEX_HOME = path.join(temporary, '.codex');
    Reflect.set(globalThis, 'BBX_BUILD', {
      version: '1.14.2',
      target: 'test',
      skills: {},
      updatePublicKey: '',
    });
    const { installCompanion } = await import('../src/installer.js');
    const { getStandaloneLauncher, readInstallation } = await import('../src/runtime.js');
    const { checkNativeHostManifestHealth } = await import('../../agent-client/src/runtime.js');
    const { APP_NAME, getManifestInstallDir } = await import('../../native-host/src/config.js');
    const manifestPath = path.join(getManifestInstallDir('chrome'), `${APP_NAME}.json`);
    const cursorPath = path.join(temporary, '.cursor', 'mcp.json');
    const cursorTarget = path.join(temporary, '.cursor', 'managed-mcp.json');
    const configPath = path.join(process.env.BROWSER_BRIDGE_HOME, 'config.json');
    const source = path.join(temporary, 'downloaded-bbx');
    const originalConfig =
      '{"mcpServers":{"browser-bridge":{"command":"bbx","args":["mcp","serve"],"env":{"BBX_REMOTE":"office"}},"other":{"command":"untouched"}}}';
    const origins = [
      'chrome-extension://jjjkmmcdkpcgamlopogicbnnhdgebhie/',
      `chrome-extension://${'a'.repeat(32)}/`,
    ];
    const originalManifest = JSON.stringify({
      name: APP_NAME,
      path: '/old/npm/launcher.sh',
      allowed_origins: origins,
    });
    try {
      await fs.mkdir(path.dirname(cursorPath), { recursive: true });
      await fs.mkdir(path.dirname(manifestPath), { recursive: true });
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(cursorTarget, originalConfig);
      await fs.symlink(cursorTarget, cursorPath);
      const bashTarget = path.join(temporary, 'managed-bashrc');
      await fs.writeFile(bashTarget, '# existing shell settings\n');
      await fs.symlink(bashTarget, path.join(temporary, '.bashrc'));
      await fs.writeFile(manifestPath, originalManifest);
      await fs.writeFile(configPath, '{"autoUpdate":"off","custom":"keep"}');
      await fs.writeFile(
        source,
        '#!/bin/sh\nprintf \'{"version":"1.14.2","target":"test"}\\n\'\n',
        { mode: 0o755 }
      );

      const rename = fs.rename;
      const canonicalCursorTarget = await fs.realpath(cursorTarget);
      let failed = false;
      const mock = t.mock.method(
        fs,
        'rename',
        async (from: import('node:fs').PathLike, to: import('node:fs').PathLike) => {
          if (to === canonicalCursorTarget && !failed) {
            failed = true;
            throw new Error('simulated agent config write failure');
          }
          return rename(from, to);
        }
      );
      await assert.rejects(installCompanion({ source, restart: false }), /simulated/);
      mock.mock.restore();
      assert.equal(readInstallation(), null);
      assert.equal(await fs.readFile(manifestPath, 'utf8'), originalManifest);
      assert.equal(await fs.readFile(cursorPath, 'utf8'), originalConfig);

      await installCompanion({ source, restart: false });
      assert.equal(readInstallation()?.version, '1.14.2');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      assert.equal(manifest.path, getStandaloneLauncher());
      assert.deepEqual(manifest.allowed_origins, origins);
      assert.deepEqual(
        await checkNativeHostManifestHealth([{ browser: 'chrome', manifestPath, installed: true }]),
        []
      );
      const migrated = JSON.parse(await fs.readFile(cursorPath, 'utf8'));
      assert.equal(migrated.mcpServers['browser-bridge'].command, getStandaloneLauncher());
      assert.equal(migrated.mcpServers['browser-bridge'].env.BBX_REMOTE, 'office');
      assert.equal(migrated.mcpServers.other.command, 'untouched');
      assert.equal(await fs.readlink(cursorPath), cursorTarget);
      assert.equal(await fs.readlink(path.join(temporary, '.bashrc')), bashTarget);
      assert.ok((await fs.readFile(bashTarget, 'utf8')).startsWith('# existing shell settings\n'));
      assert.equal(await fs.readFile(configPath, 'utf8'), '{"autoUpdate":"off","custom":"keep"}');
      await installCompanion({ source, restart: false });
      assert.equal(readInstallation()?.previousVersion, undefined);

      await fs.writeFile(cursorPath, '{"mcpServers":{"browser-bridge": broken}}');
      await assert.rejects(installCompanion({ source, restart: false }), /invalid agent settings/);
      assert.equal(readInstallation()?.version, '1.14.2');
    } finally {
      process.env = originalEnv;
      Reflect.deleteProperty(globalThis, 'BBX_BUILD');
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
);
