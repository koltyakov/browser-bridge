import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { prepareNpm } from '../../../scripts/prepare-npm.mjs';
import { nativeMaxBytes } from '../../../packages/npm/src/install-targets.js';
import { createZipArchive } from '../../../scripts/extension-zip.mjs';
import { withDifferentZipMetadata } from '../../_helpers/zipMetadata.js';

const releaseEnv = {
  GITHUB_REF: 'refs/tags/v1.2.3',
  GITHUB_REF_TYPE: 'tag',
  GITHUB_REF_NAME: 'v1.2.3',
};

interface ReleaseFixtureState {
  tagName: string;
  isDraft: boolean;
  assets: Array<{ name: string }>;
  title?: string;
  body?: string;
  isPrerelease?: boolean;
  corrupt?: string;
  tagMissing?: boolean;
  failUpload?: string;
  failPublish?: 'before' | 'after' | 'stays-draft';
  corruptOnReview?: boolean;
  extraOnReview?: boolean;
  tagMissingOnReview?: boolean;
}

const platforms = [
  ['darwin-arm64', 'bbx-darwin-arm64'],
  ['darwin-x64', 'bbx-darwin-x64'],
  ['linux-arm64', 'bbx-linux-arm64'],
  ['linux-x64', 'bbx-linux-x64'],
  ['win32-arm64', 'bbx-windows-arm64.exe'],
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

test('native manifest uses the tag authority independently of the npm package version', async (t) => {
  const { directory } = await fixture(t);
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version: '1.2.2' }));
  assert.equal((await prepareNpm(directory, releaseEnv)).version, '1.2.3');
  const manifestPath = path.join(directory, 'packages/npm/native-manifest.json');
  const original = await fs.readFile(manifestPath, 'utf8');
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '1.2.2' }));
  assert.equal((await prepareNpm(directory, releaseEnv)).version, '1.2.3');
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

test('native manifest generation does not synchronize or require npm metadata', async (t) => {
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
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(path.join(directory, 'package.json'), 'utf8'), stale);
  assert.equal(await fs.readFile(manifestPath, 'utf8'), original);
});

test('npm preparation accepts former limits and sizes just below the current limit', async (t) => {
  const { directory } = await fixture(t);
  const [key, asset] = platforms[0];
  const file = path.join(directory, 'dist/cli', asset);
  for (const bytes of [10_000_000, 11_000_000, nativeMaxBytes - 1]) {
    await fs.truncate(file, bytes);
    const manifest = await prepareNpm(directory, {});
    assert.equal(manifest.artifacts[key].bytes, bytes);
  }
});

for (const mutation of [
  'invalid-manifest-version',
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
      case 'invalid-manifest-version':
        await fs.writeFile(
          path.join(directory, 'manifest.json'),
          JSON.stringify({ version: 'invalid' })
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
        await fs.truncate(file, nativeMaxBytes);
        break;
    }
    await assert.rejects(prepareNpm(directory, {}), /./);
    assert.equal(await fs.readFile(manifestPath, 'utf8'), original);
    assert.deepEqual(await fs.readdir(path.dirname(manifestPath)), ['native-manifest.json']);
  });
}

test(
  'release publishing reuses immutable assets and safely resumes verified drafts',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { directory } = await fixture(t);
    await fs.mkdir(path.join(directory, 'scripts'));
    for (const name of [
      'prepare-npm.mjs',
      'publish-native.mjs',
      'version.mjs',
      'extension-zip.mjs',
    ]) {
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
// @ts-check
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
const statePath = 'release.json';
/** @typedef {{tagName: string, isDraft: boolean, assets: {name: string}[], corrupt?: string, tagMissing?: boolean, failUpload?: string, failPublish?: string, corruptOnReview?: boolean, extraOnReview?: boolean, tagMissingOnReview?: boolean}} ReleaseState */
/** @type {ReleaseState | null} */
let release = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
/** @param {string} name @returns {string} */
const option = (name) => args[args.indexOf(name) + 1];
if (args[0] === 'api') {
  if (!release || release.tagMissing || args[1] !== 'repos/koltyakov/browser-bridge/git/ref/tags/' + release.tagName) {
    process.stderr.write('tag not found');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ref: 'refs/tags/' + release.tagName}));
  process.exit(0);
}
switch (args[1]) {
  case 'view':
    if (!release) process.exit(1);
    if (fs.readFileSync('calls.jsonl', 'utf8').trim().split('\\n').filter((line) => line.startsWith('["release","view",')).length >= 2) {
      if (release.corruptOnReview) release.corrupt = release.assets[0].name;
      if (release.extraOnReview && !release.assets.some((asset) => asset.name === 'unverified.txt')) release.assets.push({name: 'unverified.txt'});
      if (release.tagMissingOnReview) release.tagMissing = true;
      fs.writeFileSync(statePath, JSON.stringify(release));
    }
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
    if (release.failUpload === name) process.exit(1);
    fs.mkdirSync('remote', { recursive: true });
    fs.copyFileSync(args[3], path.join('remote', name));
    release.assets.push({ name });
    fs.writeFileSync(statePath, JSON.stringify(release));
    break;
  }
  case 'edit':
    if (!release || !args.includes('--draft=false')) process.exit(1);
    if (release.failPublish === 'before') process.exit(1);
    if (release.failPublish !== 'stays-draft') release.isDraft = false;
    fs.writeFileSync(statePath, JSON.stringify(release));
    if (release.failPublish === 'after') process.exit(1);
    break;
  case 'download': {
    const name = option('--pattern');
    if (release.corrupt === name) fs.writeFileSync(path.join(option('--dir'), name), 'different bytes');
    else fs.copyFileSync(path.join('remote', name), path.join(option('--dir'), name));
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
    const publish = (args: string[] = []) =>
      spawnSync(process.execPath, ['scripts/publish-native.mjs', ...args], {
        cwd: directory,
        encoding: 'utf8',
        env,
      });
    const calls = async (): Promise<string[][]> =>
      (await fs.readFile(path.join(directory, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const first = publish();
    assert.equal(first.status, 0, first.stderr);
    assert.equal((await calls()).filter((args) => args[1] === 'create').length, 1);
    assert.equal(
      (await calls()).filter((args) => args[1] === 'upload').length,
      platforms.length + 1
    );
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
    assert.equal(
      (await calls()).filter((args) => args[1] === 'download').length,
      platforms.length + 1
    );
    await fs.writeFile(path.join(directory, 'calls.jsonl'), '');
    const missingExtension = publish(['--include-extension']);
    assert.notEqual(missingExtension.status, 0);
    assert.match(missingExtension.stderr, /ENOENT/);
    assert.deepEqual(await calls(), []);
    const extensionPath = path.join(directory, 'dist/browser-bridge-extension-v1.2.3.zip');
    await fs.writeFile(extensionPath, '');
    const emptyExtension = publish(['--include-extension']);
    assert.notEqual(emptyExtension.status, 0);
    assert.match(emptyExtension.stderr, /Extension ZIP is empty/);
    assert.deepEqual(await calls(), []);
    const extensionSource = path.join(directory, 'extension-source');
    await fs.mkdir(extensionSource);
    await fs.writeFile(path.join(extensionSource, 'manifest.json'), '{"version":"1.2.3"}');
    await createZipArchive(extensionSource, extensionPath);
    const extensionBytes = await fs.readFile(extensionPath);
    const withExtension = publish(['--include-extension']);
    assert.equal(withExtension.status, 0, withExtension.stderr);
    assert.equal((await calls()).filter((args) => args[1] === 'upload').length, 1);
    assert.equal(
      (await calls()).filter((args) => args[1] === 'download').length,
      platforms.length + 2
    );
    // Legacy archives differ only in timestamps. Never overwrite their
    // published bytes, and do not reject a rerun with identical payloads.
    await fs.writeFile(extensionPath, withDifferentZipMetadata(extensionBytes));
    await fs.writeFile(path.join(directory, 'calls.jsonl'), '');
    const metadataRerun = publish(['--include-extension']);
    assert.equal(metadataRerun.status, 0, metadataRerun.stderr);
    assert.match(metadataRerun.stdout, /reusing the existing immutable ZIP/);
    assert.equal((await calls()).filter((args) => args[1] === 'upload').length, 0);
    assert.deepEqual(
      await fs.readFile(path.join(directory, 'remote/bbx-browser-extension.zip')),
      extensionBytes
    );
    await fs.writeFile(path.join(extensionSource, 'manifest.json'), '{"version":"changed"}');
    await createZipArchive(extensionSource, extensionPath);
    await fs.writeFile(path.join(directory, 'calls.jsonl'), '');
    const changedExtension = publish(['--include-extension']);
    assert.notEqual(changedExtension.status, 0);
    assert.match(changedExtension.stderr, /Immutable release asset mismatch/);
    assert.equal((await calls()).filter((args) => args[1] === 'upload').length, 0);
    await fs.writeFile(extensionPath, extensionBytes);
    assert.deepEqual(
      await fs.readFile(path.join(directory, 'remote/bbx-browser-extension.zip')),
      extensionBytes
    );
    assert.equal(
      await fs.readFile(path.join(directory, 'remote/checksums.txt'), 'utf8'),
      checksums
    );
    await fs.writeFile(path.join(directory, 'calls.jsonl'), '');
    const rerunWithExtension = publish(['--include-extension']);
    assert.equal(rerunWithExtension.status, 0, rerunWithExtension.stderr);
    assert.equal((await calls()).filter((args) => args[1] === 'upload').length, 0);
    assert.equal(
      (await calls()).filter((args) => args[1] === 'download').length,
      platforms.length + 2
    );
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
      {
        tagName: 'v1.2.3',
        isDraft: false,
        assets: [{ name: 'bbx-browser-extension.zip' }],
        corrupt: 'bbx-browser-extension.zip',
      },
    ]) {
      await fs.writeFile(path.join(directory, 'release.json'), JSON.stringify(state));
      await fs.writeFile(path.join(directory, 'calls.jsonl'), '');
      const result = publish(['--include-extension']);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Immutable release asset mismatch/);
      assert.equal((await calls()).filter((args) => args[1] === 'upload').length, 0);
    }

    const required = [
      ...platforms.map(([, asset]) => asset),
      'checksums.txt',
      'bbx-browser-extension.zip',
    ];
    const expected: Record<string, Buffer> = {
      'bbx-browser-extension.zip': withDifferentZipMetadata(extensionBytes),
    };
    let seededAssets = new Set<string>();
    for (const name of required.filter((name) => name !== 'bbx-browser-extension.zip'))
      expected[name] = await fs.readFile(path.join(directory, 'dist/cli', name));
    const readState = async (): Promise<ReleaseFixtureState> =>
      JSON.parse(await fs.readFile(path.join(directory, 'release.json'), 'utf8'));
    const writeState = async (state: ReleaseFixtureState) =>
      fs.writeFile(path.join(directory, 'release.json'), JSON.stringify(state));
    const seedDraft = async (names: string[], overrides: Partial<ReleaseFixtureState> = {}) => {
      seededAssets = new Set(names);
      await fs.rm(path.join(directory, 'remote'), { recursive: true, force: true });
      await fs.mkdir(path.join(directory, 'remote'));
      for (const name of names)
        await fs.writeFile(
          path.join(directory, 'remote', name),
          expected[name] ?? Buffer.from('unverified')
        );
      await writeState({
        tagName: 'v1.2.3',
        isDraft: true,
        title: 'Keep title',
        body: 'Keep notes',
        isPrerelease: false,
        assets: names.map((name) => ({ name })),
        ...overrides,
      });
      await fs.writeFile(path.join(directory, 'calls.jsonl'), '');
    };
    const assertRemoteUnchanged = async (names: string[]) => {
      for (const name of names)
        assert.deepEqual(
          await fs.readFile(path.join(directory, 'remote', name)),
          name === 'bbx-browser-extension.zip' && !seededAssets.has(name)
            ? extensionBytes
            : expected[name]
        );
    };
    const mutations = async () =>
      (await calls()).filter(
        (args) => args[0] === 'release' && ['create', 'upload', 'edit'].includes(args[1])
      );

    await t.test(
      'a complete matching draft is verified before publication and a rerun does not republish it',
      async () => {
        await seedDraft(required);
        const result = publish(['--include-extension']);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(await mutations(), [
          ['release', 'edit', 'v1.2.3', '--repo', 'koltyakov/browser-bridge', '--draft=false'],
        ]);
        const actions = await calls();
        const edit = actions.findIndex((args) => args[1] === 'edit');
        assert(
          actions.slice(0, edit).filter((args) => args[1] === 'download').length >= required.length
        );
        assert(actions.slice(edit + 1).some((args) => args[1] === 'view'));
        const state = await readState();
        assert.equal(state.isDraft, false);
        assert.equal(state.tagName, 'v1.2.3');
        assert.equal(state.title, 'Keep title');
        assert.equal(state.body, 'Keep notes');
        assert.equal(state.isPrerelease, false);
        await assertRemoteUnchanged(required);
        await fs.writeFile(path.join(directory, 'calls.jsonl'), '');
        const rerun = publish(['--include-extension']);
        assert.equal(rerun.status, 0, rerun.stderr);
        assert.deepEqual(await mutations(), []);
        await assertRemoteUnchanged(required);
      }
    );

    await t.test(
      'a partial draft verifies existing assets before filling missing assets and publishing',
      async () => {
        const existing = [required[0], 'bbx-browser-extension.zip'];
        await seedDraft(existing);
        const result = publish(['--include-extension']);
        assert.equal(result.status, 0, result.stderr);
        const actions = await calls();
        const firstUpload = actions.findIndex((args) => args[1] === 'upload');
        assert.deepEqual(
          actions
            .slice(0, firstUpload)
            .filter((args) => args[1] === 'download')
            .map((args) => args[args.indexOf('--pattern') + 1])
            .sort(),
          [...existing].sort()
        );
        assert.equal(
          actions.filter((args) => args[1] === 'upload').length,
          required.length - existing.length
        );
        assert(!actions.some((args) => args.includes('--clobber') || args[1] === 'create'));
        const edit = actions.findIndex((args) => args[1] === 'edit');
        assert(
          actions.slice(edit + 1).every((args) => args[1] !== 'upload' && args[1] !== 'download')
        );
        assert.equal((await readState()).isDraft, false);
        await assertRemoteUnchanged(required);
      }
    );

    for (const name of [required[0], 'checksums.txt', 'bbx-browser-extension.zip']) {
      await t.test(
        `a mismatched draft asset ${name} prevents uploads and publication`,
        async () => {
          await seedDraft([name], { corrupt: name });
          const result = publish(['--include-extension']);
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /Immutable release asset mismatch/);
          assert.deepEqual(await mutations(), []);
          assert.equal((await readState()).isDraft, true);
          await assertRemoteUnchanged([name]);
        }
      );
    }

    await t.test('unverified draft attachments are not silently made public', async () => {
      await seedDraft([...required, 'unverified.txt']);
      const result = publish(['--include-extension']);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unverified asset unverified.txt/);
      assert.deepEqual(await mutations(), []);
      assert.equal((await readState()).isDraft, true);
    });

    await t.test(
      'native-only publishing cannot expose an unverified extension attached to a draft',
      async () => {
        await seedDraft(required);
        const result = publish();
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /unverified asset bbx-browser-extension.zip/);
        assert.deepEqual(await mutations(), []);
        assert.equal((await readState()).isDraft, true);
      }
    );

    await t.test(
      'a missing or mismatched tag cannot be recreated or changed during draft recovery',
      async () => {
        for (const overrides of [{ tagMissing: true }, { tagName: 'v9.9.9' }]) {
          await seedDraft(required, overrides);
          const result = publish(['--include-extension']);
          assert.notEqual(result.status, 0);
          assert.deepEqual(await mutations(), []);
          assert.equal((await readState()).isDraft, true);
        }
      }
    );

    for (const fault of ['failUpload', 'corrupt'] as const) {
      await t.test(
        `a ${fault} failure leaves the draft unpublished and can be resumed`,
        async () => {
          await seedDraft([required[0]], { [fault]: required[2] });
          const result = publish(['--include-extension']);
          assert.notEqual(result.status, 0);
          assert.equal((await readState()).isDraft, true);
          assert(!(await calls()).some((args) => args[1] === 'edit'));
          const partial = await readState();
          delete partial[fault];
          await writeState(partial);
          await fs.writeFile(path.join(directory, 'calls.jsonl'), '');
          const rerun = publish(['--include-extension']);
          assert.equal(rerun.status, 0, rerun.stderr);
          const uploads = (await calls())
            .filter((args) => args[1] === 'upload')
            .map((args) => path.basename(args[3]));
          assert(uploads.every((name) => !partial.assets.some((asset) => asset.name === name)));
          assert.equal((await readState()).isDraft, false);
          await assertRemoteUnchanged(required);
        }
      );
    }

    for (const fault of ['before', 'after', 'stays-draft'] as const) {
      await t.test(
        `publication outcome ${fault} is safe to rerun without reuploading assets`,
        async () => {
          await seedDraft(required, { failPublish: fault });
          const result = publish(['--include-extension']);
          assert.notEqual(result.status, 0);
          assert.equal((await readState()).isDraft, fault !== 'after');
          const state = await readState();
          delete state.failPublish;
          await writeState(state);
          await fs.writeFile(path.join(directory, 'calls.jsonl'), '');
          const rerun = publish(['--include-extension']);
          assert.equal(rerun.status, 0, rerun.stderr);
          assert.equal(
            (await calls()).filter((args) => args[1] === 'edit').length,
            fault === 'after' ? 0 : 1
          );
          assert(!(await calls()).some((args) => args[1] === 'create' || args[1] === 'upload'));
          await assertRemoteUnchanged(required);
        }
      );
    }

    for (const fault of ['corruptOnReview', 'extraOnReview', 'tagMissingOnReview'] as const) {
      await t.test(`${fault} is caught by the final verification before publication`, async () => {
        await seedDraft(required, { [fault]: true });
        const result = publish(['--include-extension']);
        assert.notEqual(result.status, 0);
        assert.match(
          result.stderr,
          /Immutable release asset mismatch|unverified asset|tag not found/
        );
        assert.deepEqual(await mutations(), []);
        assert.equal((await readState()).isDraft, true);
      });
    }
  }
);
