import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';

test(
  'signed updates verify bytes, install side by side, and retain rollback state',
  { skip: process.platform === 'win32' },
  async (t) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-update-test-'));
    const originalEnv = { ...process.env };
    process.env.HOME = temporary;
    process.env.ZDOTDIR = temporary;
    process.env.BROWSER_BRIDGE_HOME = path.join(temporary, 'bridge');
    process.env.XDG_CONFIG_HOME = path.join(temporary, '.config');
    process.env.CODEX_HOME = path.join(temporary, '.codex');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const target = 'bun-darwin-arm64';
    Reflect.set(globalThis, 'BBX_BUILD', {
      version: '1.14.2',
      target,
      skills: {},
      updatePublicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    const { installCompanion } = await import('../src/installer.js');
    const { updateCompanion } = await import('../src/updater.js');
    const { getVersionExecutable, readInstallation } = await import('../src/runtime.js');
    const binary = (version: string) =>
      Buffer.from(`#!/bin/sh\nprintf '{"version":"${version}","target":"${target}"}\\n'\n`);
    const payload = binary('1.14.3');
    const manifest = JSON.stringify({
      version: '1.14.3',
      protocolMajor: 1,
      assets: {
        [target]: {
          name: 'bbx-darwin-arm64',
          size: payload.length,
          sha256: createHash('sha256').update(payload).digest('hex'),
        },
      },
    });
    const signature = sign(null, Buffer.from(manifest), privateKey).toString('base64');
    let corrupt = true;
    const requests: string[] = [];
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      if (url.endsWith('companion-update.json')) return new Response(manifest);
      if (url.endsWith('companion-update.sig')) return new Response(signature);
      assert.equal(
        url,
        'https://github.com/koltyakov/browser-bridge/releases/download/v1.14.3/bbx-darwin-arm64'
      );
      return new Response(corrupt ? Buffer.alloc(payload.length) : payload);
    });
    try {
      const oldSource = path.join(temporary, 'old-bbx');
      await fs.writeFile(oldSource, binary('1.14.2'), { mode: 0o755 });
      await installCompanion({ source: oldSource, restart: false });
      await assert.rejects(updateCompanion({ restart: false }), /verification failed/);
      assert.equal(readInstallation()?.version, '1.14.2');
      corrupt = false;
      assert.equal(await updateCompanion({ restart: false }), true);
      assert.deepEqual(readInstallation(), {
        version: '1.14.3',
        previousVersion: '1.14.2',
        managePath: true,
      });
      assert.deepEqual(await fs.readFile(getVersionExecutable('1.14.2')), binary('1.14.2'));
      assert.deepEqual(await fs.readFile(getVersionExecutable('1.14.3')), payload);
      const downloads = requests.filter((url) => url.endsWith('/bbx-darwin-arm64')).length;
      assert.equal(await updateCompanion({ restart: false }), false);
      assert.equal(requests.filter((url) => url.endsWith('/bbx-darwin-arm64')).length, downloads);
      await installCompanion({
        source: getVersionExecutable('1.14.2'),
        version: '1.14.2',
        allowDowngrade: true,
        restart: false,
      });
      assert.equal(readInstallation()?.blockedVersion, '1.14.3');
      await assert.rejects(updateCompanion({ restart: false }), /rolled back/);
      assert.equal(readInstallation()?.version, '1.14.2');
    } finally {
      process.env = originalEnv;
      Reflect.deleteProperty(globalThis, 'BBX_BUILD');
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
);
