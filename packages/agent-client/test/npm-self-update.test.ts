import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';

import {
  acquireNpmUpdateLock,
  comparePackageVersions,
  derivePackageProtocolVersion,
  getNpmUpdateLockPort,
  parseStableVersion,
  selectCompatibleNpmVersion,
  updateCompatibleNpmPackage,
} from '../src/npm-self-update.js';

test('stable version helpers reject prereleases and compare numeric components', () => {
  assert.deepEqual(parseStableVersion('1.8.12'), [1, 8, 12]);
  assert.equal(parseStableVersion('1.8.2-beta.1'), null);
  assert.equal(derivePackageProtocolVersion('2.10.3'), '2.10');
  assert.equal(comparePackageVersions('1.10.0', '1.9.99'), 1);
});

test('npm update lock skips unrelated listeners on its preferred port', async (t) => {
  const lockKey = `unrelated-listener-${process.pid}-${Date.now()}`;
  const port = getNpmUpdateLockPort(lockKey);
  const blocker = net.createServer((socket) => socket.end('unrelated\n'));
  try {
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      t.skip('preferred lock port is already occupied');
      return;
    }
    throw error;
  }

  try {
    const release = await acquireNpmUpdateLock(lockKey, 1_000);
    await release();
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test('selectCompatibleNpmVersion chooses the highest patch on an advertised line', () => {
  assert.equal(
    selectCompatibleNpmVersion(
      ['1.8.2', '1.9.0', '1.8.7', '1.8.9-beta.1', '2.0.0'],
      ['1.8'],
      '1.8.1'
    ),
    '1.8.7'
  );
  assert.equal(selectCompatibleNpmVersion(['1.9.0'], ['1.8'], '1.8.1'), null);
});

test('npm update lock serializes callers and releases its OS resource', async () => {
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-update-lock-test-'));
  const lockPath = path.join(bridgeHome, 'npm-update.lock');
  try {
    const release = await acquireNpmUpdateLock(lockPath);
    await assert.rejects(acquireNpmUpdateLock(lockPath, 20), /Timed out/u);
    await release();
    const releaseAgain = await acquireNpmUpdateLock(lockPath);
    await releaseAgain();
  } finally {
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
});

test('updateCompatibleNpmPackage installs the highest compatible stable release', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-update-test-'));
  const globalRoot = path.join(root, 'global');
  const packageRoot = path.join(globalRoot, '@browserbridge', 'bbx');
  const calls: string[][] = [];
  try {
    await fs.promises.mkdir(packageRoot, { recursive: true });
    await fs.promises.writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@browserbridge/bbx', version: '1.8.1' }),
      'utf8'
    );
    const result = await updateCompatibleNpmPackage({
      extensionVersion: '1.8.2',
      supportedVersions: ['1.8'],
      packageRoot,
      lockPath: path.join(root, 'npm-update.lock'),
      runNpmFn: async (args) => {
        calls.push(args);
        if (args[0] === 'root') return `${globalRoot}\n`;
        if (args[0] === 'view') return JSON.stringify(['1.8.2', '1.9.0', '1.8.4']);
        if (args[0] === 'install') {
          await fs.promises.writeFile(
            path.join(packageRoot, 'package.json'),
            JSON.stringify({ name: '@browserbridge/bbx', version: '1.8.4' }),
            'utf8'
          );
          return '';
        }
        throw new Error(`Unexpected npm command: ${args.join(' ')}`);
      },
    });

    assert.deepEqual(result, {
      updated: true,
      reason: 'updated',
      previousVersion: '1.8.1',
      version: '1.8.4',
    });
    assert.deepEqual(calls[2], [
      'install',
      '--global',
      '--no-audit',
      '--no-fund',
      '--',
      '@browserbridge/bbx@1.8.4',
    ]);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('updateCompatibleNpmPackage skips checkout-local installations', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-update-local-test-'));
  const packageRoot = path.join(root, 'checkout');
  try {
    await fs.promises.mkdir(packageRoot, { recursive: true });
    await fs.promises.writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ version: '1.8.1' }),
      'utf8'
    );
    const result = await updateCompatibleNpmPackage({
      extensionVersion: '1.8.2',
      supportedVersions: ['1.8'],
      packageRoot,
      lockPath: path.join(root, 'npm-update.lock'),
      runNpmFn: async () => path.join(root, 'global'),
    });
    assert.deepEqual(result, {
      updated: false,
      reason: 'not_global_install',
    });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
