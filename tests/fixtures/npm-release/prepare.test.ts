import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { prepareNpm } from '../../../scripts/prepare-npm.mjs';

const releaseEnv = {
  GITHUB_REF: 'refs/tags/v1.2.3',
  GITHUB_REF_TYPE: 'tag',
  GITHUB_REF_NAME: 'v1.2.3',
};

const platforms = [
  ['darwin-arm64', 'bbx-darwin-arm64'],
  ['darwin-x64', 'bbx-darwin-x64'],
  ['linux-arm64', 'bbx-linux-arm64'],
  ['linux-x64', 'bbx-linux-x64'],
  ['win32-x64', 'bbx-windows-x64.exe'],
];

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-npm-release-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'dist/cli'), { recursive: true });
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version: '1.2.3' }));
  await fs.writeFile(
    path.join(directory, 'package-lock.json'),
    JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' } } })
  );
  for (const [, asset] of platforms) {
    const bytes = Buffer.from(`binary fixture: ${asset}`);
    await fs.writeFile(path.join(directory, 'dist/cli', asset), bytes);
  }
  return { directory };
}

test('npm manifest pins exact assets and platform keys, replacing atomically', async (t) => {
  const { directory } = await fixture(t);
  const manifest = await prepareNpm(directory, {});
  assert.equal(manifest.version, '1.2.3');
  assert.deepEqual(
    Object.keys(manifest.artifacts),
    platforms.map(([key]) => key)
  );
  for (const [key, asset] of platforms) {
    const bytes = await fs.readFile(path.join(directory, 'dist/cli', asset));
    assert.deepEqual(manifest.artifacts[key], {
      asset,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  assert.deepEqual(await prepareNpm(directory, {}), manifest);
  assert.deepEqual(await fs.readdir(path.join(directory, 'packages/npm')), [
    'native-manifest.json',
  ]);
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(directory, 'packages/npm/native-manifest.json'), 'utf8')
    ),
    manifest
  );
});

test('npm preparation uses the tag authority and requires a matching package version', async (t) => {
  const { directory } = await fixture(t);
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version: '1.2.2' }));
  assert.equal((await prepareNpm(directory, releaseEnv)).version, '1.2.3');
  const manifestPath = path.join(directory, 'packages/npm/native-manifest.json');
  const original = await fs.readFile(manifestPath, 'utf8');
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '1.2.2' }));
  await assert.rejects(prepareNpm(directory, releaseEnv), /match 1\.2\.3; run make sync-version/);
  assert.equal(await fs.readFile(manifestPath, 'utf8'), original);
});

test('npm preparation reads updated binary sizes and hashes directly', async (t) => {
  const { directory } = await fixture(t);
  await prepareNpm(directory, {});
  const [key, asset] = platforms[0];
  const bytes = Buffer.from('rebuilt binary with different contents and size');
  await fs.writeFile(path.join(directory, 'dist/cli', asset), bytes);
  const manifest = await prepareNpm(directory, {});
  assert.deepEqual(manifest.artifacts[key], {
    asset,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
});

test('prepack rejects stale metadata without synchronizing it during npm packing', async (t) => {
  const { directory } = await fixture(t);
  await fs.mkdir(path.join(directory, 'scripts'));
  for (const name of ['prepare-npm.mjs', 'version.mjs']) {
    await fs.copyFile(
      new URL(`../../../scripts/${name}`, import.meta.url),
      path.join(directory, 'scripts', name)
    );
  }
  await fs.mkdir(path.join(directory, 'packages/npm/src'), { recursive: true });
  await fs.copyFile(
    new URL('../../../packages/npm/src/install-targets.js', import.meta.url),
    path.join(directory, 'packages/npm/src/install-targets.js')
  );
  const env: NodeJS.ProcessEnv = { ...process.env, ...releaseEnv };
  delete env.RELEASE_TAG;
  const prepare = () =>
    spawnSync(process.execPath, ['scripts/prepare-npm.mjs'], {
      cwd: directory,
      encoding: 'utf8',
      env,
    });
  const first = prepare();
  assert.equal(first.status, 0, first.stderr);
  const stale = JSON.stringify({ version: '1.2.2' });
  await fs.writeFile(path.join(directory, 'package.json'), stale);
  const manifestPath = path.join(directory, 'packages/npm/native-manifest.json');
  const original = await fs.readFile(manifestPath, 'utf8');
  const result = prepare();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /run make sync-version/);
  assert.equal(await fs.readFile(path.join(directory, 'package.json'), 'utf8'), stale);
  assert.equal(await fs.readFile(manifestPath, 'utf8'), original);
});

for (const mutation of [
  'wrong-manifest-version',
  'wrong-package-version',
  'missing-file',
  'wrong-filename',
  'directory',
  'empty-file',
  'oversized-file',
] as const) {
  test(`npm manifest rejects ${mutation} without replacing an existing manifest`, async (t) => {
    const { directory } = await fixture(t);
    await prepareNpm(directory, {});
    const manifestPath = path.join(directory, 'packages/npm/native-manifest.json');
    const original = await fs.readFile(manifestPath, 'utf8');
    const file = path.join(directory, 'dist/cli', platforms[0][1]);
    switch (mutation) {
      case 'wrong-manifest-version':
      case 'wrong-package-version':
        await fs.writeFile(
          path.join(
            directory,
            mutation === 'wrong-manifest-version' ? 'manifest.json' : 'package.json'
          ),
          JSON.stringify({ version: '1.2.2' })
        );
        break;
      case 'missing-file':
        await fs.rm(file);
        break;
      case 'wrong-filename':
        await fs.rename(file, `${file}-other`);
        break;
      case 'directory':
        await fs.rm(file);
        await fs.mkdir(file);
        break;
      case 'empty-file':
        await fs.truncate(file, 0);
        break;
      case 'oversized-file':
        await fs.truncate(file, 10_000_000);
        break;
    }
    await assert.rejects(
      prepareNpm(directory, {}),
      mutation === 'wrong-manifest-version' || mutation === 'wrong-package-version'
        ? /run make sync-version/
        : /./
    );
    assert.equal(await fs.readFile(manifestPath, 'utf8'), original);
    assert.deepEqual(await fs.readdir(path.dirname(manifestPath)), ['native-manifest.json']);
  });
}

test(
  'native publishing reuses identical assets and refuses replacement or draft releases',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { directory } = await fixture(t);
    await fs.mkdir(path.join(directory, 'scripts'));
    for (const name of ['prepare-npm.mjs', 'publish-native.mjs', 'version.mjs']) {
      await fs.copyFile(
        new URL(`../../../scripts/${name}`, import.meta.url),
        path.join(directory, 'scripts', name)
      );
    }
    await fs.mkdir(path.join(directory, 'packages/npm/src'), { recursive: true });
    await fs.copyFile(
      new URL('../../../packages/npm/src/install-targets.js', import.meta.url),
      path.join(directory, 'packages/npm/src/install-targets.js')
    );
    const bin = path.join(directory, 'bin');
    await fs.mkdir(bin);
    // This fake gh only copies fixture bytes; no request reaches GitHub.
    await fs.writeFile(
      path.join(bin, 'gh'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
const statePath = 'release.json';
let release = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
const option = (name) => args[args.indexOf(name) + 1];
switch (args[1]) {
  case 'view':
    if (!release) process.exit(1);
    process.stdout.write(JSON.stringify(release));
    break;
  case 'create':
    if (release || !args.includes('--verify-tag')) process.exit(1);
    release = { tagName: args[2], isDraft: false, assets: [] };
    fs.writeFileSync(statePath, JSON.stringify(release));
    break;
  case 'upload': {
    const name = path.basename(args[3]);
    if (!release || args.includes('--clobber') || release.assets.some((asset) => asset.name === name)) process.exit(1);
    release.assets.push({ name });
    fs.writeFileSync(statePath, JSON.stringify(release));
    break;
  }
  case 'download': {
    const name = option('--pattern');
    if (release.corrupt === name) fs.writeFileSync(path.join(option('--dir'), name), 'different bytes');
    else fs.copyFileSync(path.join('dist/cli', name), path.join(option('--dir'), name));
    break;
  }
  default: process.exit(1);
}
`,
      { mode: 0o755 }
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...releaseEnv,
      PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
    };
    delete env.RELEASE_TAG;
    // The tag remains authoritative even when the checkout's extension version is older.
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version: '1.2.2' }));
    const publish = () =>
      spawnSync(process.execPath, ['scripts/publish-native.mjs'], {
        cwd: directory,
        encoding: 'utf8',
        env,
      });
    const calls = async (): Promise<string[][]> =>
      (await fs.readFile(path.join(directory, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    const first = publish();
    assert.equal(first.status, 0, first.stderr);
    assert.equal((await calls()).filter((args) => args[1] === 'create').length, 1);
    assert.equal((await calls()).filter((args) => args[1] === 'upload').length, 6);
    const checksums = await fs.readFile(path.join(directory, 'dist/cli/checksums.txt'), 'utf8');
    for (const [, asset] of platforms) {
      const bytes = await fs.readFile(path.join(directory, 'dist/cli', asset));
      assert.ok(
        checksums.includes(`${createHash('sha256').update(bytes).digest('hex')}  ${asset}\n`)
      );
    }
    await fs.writeFile(path.join(directory, 'calls.jsonl'), '');
    const rerun = publish();
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal((await calls()).filter((args) => args[1] === 'upload').length, 0);
    assert.equal((await calls()).filter((args) => args[1] === 'download').length, 6);
    for (const state of [
      {
        tagName: 'v1.2.3',
        isDraft: false,
        assets: [{ name: platforms[0][1] }],
        corrupt: platforms[0][1],
      },
      {
        tagName: 'v1.2.3',
        isDraft: false,
        assets: [{ name: 'checksums.txt' }],
        corrupt: 'checksums.txt',
      },
      { tagName: 'v1.2.3', isDraft: true, assets: [] },
    ]) {
      await fs.writeFile(path.join(directory, 'release.json'), JSON.stringify(state));
      await fs.writeFile(path.join(directory, 'calls.jsonl'), '');
      const result = publish();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, state.isDraft ? /non-draft/ : /Immutable release asset mismatch/);
      assert.equal((await calls()).filter((args) => args[1] === 'upload').length, 0);
    }
  }
);
