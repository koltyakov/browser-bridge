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
    if (['EACCES', 'EADDRINUSE'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('preferred lock port is unavailable');
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

test('npm update lock spreads fallback ports across the dynamic range', () => {
  const lockKey = 'distributed-lock-candidates';
  const ports = Array.from({ length: 32 }, (_, offset) => getNpmUpdateLockPort(lockKey, offset));

  assert.equal(new Set(ports).size, ports.length);
  assert.ok(Math.max(...ports) - Math.min(...ports) >= 8_000);
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

/**
 * Build a global-install layout the updater accepts, so each test can focus on
 * one refusal or failure branch rather than re-deriving the happy path.
 */
async function withGlobalInstall(
  installedVersion: string,
  callback: (context: {
    root: string;
    globalRoot: string;
    packageRoot: string;
    lockPath: string;
  }) => Promise<void>
): Promise<void> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-update-branch-'));
  const globalRoot = path.join(root, 'global');
  const packageRoot = path.join(globalRoot, '@browserbridge', 'bbx');
  try {
    await fs.promises.mkdir(packageRoot, { recursive: true });
    await fs.promises.writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@browserbridge/bbx', version: installedVersion }),
      'utf8'
    );
    await callback({
      root,
      globalRoot,
      packageRoot,
      lockPath: path.join(root, 'npm-update.lock'),
    });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

test('comparePackageVersions rejects unparsable versions and reports equality', () => {
  assert.equal(comparePackageVersions('1.9.0', '1.9.0'), 0);
  assert.throws(() => comparePackageVersions('1.9.0', '1.9.0-rc.1'), {
    message: /Cannot compare invalid stable versions "1\.9\.0" and "1\.9\.0-rc\.1"/,
  });
  assert.throws(() => comparePackageVersions('not-a-version', '1.9.0'), {
    message: /Cannot compare invalid stable versions/,
  });
});

test('derivePackageProtocolVersion returns null for unparsable input', () => {
  assert.equal(derivePackageProtocolVersion('1.9.0'), '1.9');
  assert.equal(derivePackageProtocolVersion('1.9'), null);
  assert.equal(derivePackageProtocolVersion('1.9.0-beta.2'), null);
});

test('selectCompatibleNpmVersion ignores unusable candidates and current version', () => {
  // Unparsable current version disqualifies the whole check.
  assert.equal(selectCompatibleNpmVersion(['1.9.1'], ['1.9'], '1.9.0-rc.1'), null);
  // Non-strings, prereleases, unsupported protocol lines, and older releases.
  assert.equal(
    selectCompatibleNpmVersion([42, null, '1.9.2-beta.1', '2.0.0', '1.9.0'], ['1.9'], '1.9.0'),
    null
  );
  // Malformed protocol entries in the supported list are filtered out.
  assert.equal(selectCompatibleNpmVersion(['1.9.1'], ['nonsense', '1.9'], '1.9.0'), '1.9.1');
});

test('updateCompatibleNpmPackage refuses an extension version it cannot support', async () => {
  await withGlobalInstall('1.9.0', async ({ packageRoot, lockPath }) => {
    const unparsable = await updateCompatibleNpmPackage({
      extensionVersion: '1.9',
      supportedVersions: ['1.9'],
      packageRoot,
      lockPath,
      runNpmFn: async () => {
        throw new Error('npm must not run for an invalid extension version');
      },
    });
    assert.deepEqual(unparsable, { updated: false, reason: 'invalid_extension_version' });

    const unsupported = await updateCompatibleNpmPackage({
      extensionVersion: '2.4.0',
      supportedVersions: ['1.9'],
      packageRoot,
      lockPath,
      runNpmFn: async () => {
        throw new Error('npm must not run for an unsupported protocol line');
      },
    });
    assert.deepEqual(unsupported, { updated: false, reason: 'invalid_extension_version' });
  });
});

test('updateCompatibleNpmPackage refuses when the installed version is unreadable', async () => {
  await withGlobalInstall('1.9.0', async ({ globalRoot, packageRoot, lockPath }) => {
    await fs.promises.writeFile(path.join(packageRoot, 'package.json'), '{ broken json', 'utf8');

    const result = await updateCompatibleNpmPackage({
      extensionVersion: '1.9.1',
      supportedVersions: ['1.9'],
      packageRoot,
      lockPath,
      runNpmFn: async (args) => {
        if (args[0] === 'root') return `${globalRoot}\n`;
        throw new Error(`npm must not run "${args[0]}" for an unreadable install`);
      },
    });

    assert.deepEqual(result, { updated: false, reason: 'invalid_installed_version' });
  });
});

test('updateCompatibleNpmPackage refuses a non-stable installed version', async () => {
  await withGlobalInstall('1.9.0', async ({ globalRoot, packageRoot, lockPath }) => {
    await fs.promises.writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ version: '1.9.1-rc.3' }),
      'utf8'
    );

    const result = await updateCompatibleNpmPackage({
      extensionVersion: '1.9.2',
      supportedVersions: ['1.9'],
      packageRoot,
      lockPath,
      runNpmFn: async (args) => {
        if (args[0] === 'root') return `${globalRoot}\n`;
        throw new Error('npm must not run past the installed-version guard');
      },
    });

    assert.deepEqual(result, { updated: false, reason: 'invalid_installed_version' });
  });
});

test('updateCompatibleNpmPackage stops when the extension is not newer', async () => {
  await withGlobalInstall('1.9.4', async ({ globalRoot, packageRoot, lockPath }) => {
    const result = await updateCompatibleNpmPackage({
      extensionVersion: '1.9.4',
      supportedVersions: ['1.9'],
      packageRoot,
      lockPath,
      runNpmFn: async (args) => {
        if (args[0] === 'root') return `${globalRoot}\n`;
        throw new Error('npm must not be queried when the extension is not newer');
      },
    });

    assert.deepEqual(result, {
      updated: false,
      reason: 'extension_not_newer',
      previousVersion: '1.9.4',
    });
  });
});

test('updateCompatibleNpmPackage reports when the registry has no compatible release', async () => {
  await withGlobalInstall('1.9.0', async ({ globalRoot, packageRoot, lockPath }) => {
    const calls: string[][] = [];
    const result = await updateCompatibleNpmPackage({
      extensionVersion: '1.9.1',
      supportedVersions: ['1.9'],
      packageRoot,
      lockPath,
      runNpmFn: async (args) => {
        calls.push(args);
        if (args[0] === 'root') return `${globalRoot}\n`;
        // Newer, but on a protocol line this build does not support.
        if (args[0] === 'view') return JSON.stringify(['1.9.0', '2.0.0', '2.1.3']);
        throw new Error('npm install must not run without a compatible target');
      },
    });

    assert.deepEqual(result, {
      updated: false,
      reason: 'no_compatible_update',
      previousVersion: '1.9.0',
    });
    assert.deepEqual(
      calls.map((call) => call[0]),
      ['root', 'view']
    );
  });
});

test('updateCompatibleNpmPackage accepts a single non-array version payload', async () => {
  await withGlobalInstall('1.9.0', async ({ globalRoot, packageRoot, lockPath }) => {
    const result = await updateCompatibleNpmPackage({
      extensionVersion: '1.9.1',
      supportedVersions: ['1.9'],
      packageRoot,
      lockPath,
      runNpmFn: async (args) => {
        if (args[0] === 'root') return `${globalRoot}\n`;
        // npm view returns a bare string when only one version exists.
        if (args[0] === 'view') return JSON.stringify('1.9.1');
        if (args[0] === 'install') {
          await fs.promises.writeFile(
            path.join(packageRoot, 'package.json'),
            JSON.stringify({ version: '1.9.1' }),
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
      previousVersion: '1.9.0',
      version: '1.9.1',
    });
  });
});

test('updateCompatibleNpmPackage throws when npm succeeds but the version did not change', async () => {
  await withGlobalInstall('1.9.0', async ({ globalRoot, packageRoot, lockPath }) => {
    await assert.rejects(
      updateCompatibleNpmPackage({
        extensionVersion: '1.9.1',
        supportedVersions: ['1.9'],
        packageRoot,
        lockPath,
        runNpmFn: async (args) => {
          if (args[0] === 'root') return `${globalRoot}\n`;
          if (args[0] === 'view') return JSON.stringify(['1.9.1']);
          // Reports success without actually replacing the install.
          if (args[0] === 'install') return '';
          throw new Error(`Unexpected npm command: ${args.join(' ')}`);
        },
      }),
      {
        message: /npm reported success, but Browser Bridge 1\.9\.1 was not installed/,
      }
    );
  });
});

test('updateCompatibleNpmPackage releases its lock after a failure', async () => {
  await withGlobalInstall('1.9.0', async ({ globalRoot, packageRoot, lockPath }) => {
    const failing = updateCompatibleNpmPackage({
      extensionVersion: '1.9.1',
      supportedVersions: ['1.9'],
      packageRoot,
      lockPath,
      runNpmFn: async (args) => {
        if (args[0] === 'root') return `${globalRoot}\n`;
        if (args[0] === 'view') throw new Error('npm view exploded');
        throw new Error(`Unexpected npm command: ${args.join(' ')}`);
      },
    });

    await assert.rejects(failing, { message: /npm view exploded/ });

    // A crashed update must not wedge the lock for the next caller.
    const release = await acquireNpmUpdateLock(lockPath, 2_000);
    await release();
  });
});

test('updateCompatibleNpmPackage propagates npm root failures without touching the lock', async () => {
  await withGlobalInstall('1.9.0', async ({ packageRoot, lockPath }) => {
    await assert.rejects(
      updateCompatibleNpmPackage({
        extensionVersion: '1.9.1',
        supportedVersions: ['1.9'],
        packageRoot,
        lockPath,
        runNpmFn: async () => {
          throw new Error('npm root --global failed: offline');
        },
      }),
      { message: /npm root --global failed: offline/ }
    );

    const release = await acquireNpmUpdateLock(lockPath, 2_000);
    await release();
  });
});

test('runNpmCommand runs a JS npm_execpath through node and resolves stdout', async () => {
  const { runNpmCommand } = await import('../src/npm-self-update.js');
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-npm-exec-'));

  try {
    // A .mjs npm_execpath must be launched via process.execPath, not exec'd.
    const fakeNpm = path.join(root, 'fake-npm.mjs');
    await fs.promises.writeFile(
      fakeNpm,
      'process.stdout.write(`ran ${process.argv.slice(2).join(" ")}`);\n',
      'utf8'
    );

    const stdout = await runNpmCommand(['root', '--global'], {
      env: { ...process.env, npm_execpath: fakeNpm },
    });

    assert.equal(stdout, 'ran root --global');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('runNpmCommand rejects with trimmed stderr detail when npm fails', async () => {
  const { runNpmCommand } = await import('../src/npm-self-update.js');
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-npm-exec-fail-'));

  try {
    const failingNpm = path.join(root, 'failing-npm.mjs');
    await fs.promises.writeFile(
      failingNpm,
      'process.stderr.write("  E404 Not Found  \\n");\nprocess.exit(1);\n',
      'utf8'
    );

    await assert.rejects(
      runNpmCommand(['view', 'nope'], {
        env: { ...process.env, npm_execpath: failingNpm },
      }),
      { message: 'npm view nope failed: E404 Not Found' }
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('runNpmCommand falls back to the npm binary when npm_execpath is not JS', async () => {
  const { runNpmCommand } = await import('../src/npm-self-update.js');
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-npm-bin-'));

  try {
    // Non-JS npm_execpath is executed directly rather than through node.
    const isWindows = process.platform === 'win32';
    const shim = path.join(root, isWindows ? 'npm-shim.cmd' : 'npm-shim');
    await fs.promises.writeFile(
      shim,
      isWindows ? '@echo off\r\necho shim-ok\r\n' : '#!/bin/sh\nprintf shim-ok\n',
      'utf8'
    );
    await fs.promises.chmod(shim, 0o755);

    const stdout = await runNpmCommand(['root', '--global'], {
      env: { ...process.env, npm_execpath: shim },
    });

    assert.match(stdout, /shim-ok/);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('NpmPackageUpdatedError carries the restart contract', async () => {
  const { NpmPackageUpdatedError } = await import('../src/npm-self-update.js');
  const error = new NpmPackageUpdatedError('1.9.4');

  assert.equal(error.name, 'NpmPackageUpdatedError');
  assert.equal(error.code, 'BBX_NPM_UPDATED');
  assert.equal(error.version, '1.9.4');
  assert.match(error.message, /updated to 1\.9\.4; restarting to load the new version/);
  assert.ok(error instanceof Error);
});
