import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { checkVersion, resolveVersion, synchronizeVersion } from '../../../scripts/version.mjs';

const filenames = ['manifest.json', 'package.json', 'package-lock.json'] as const;

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bbx-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = { version: '2.0.0', name: 'Extension', permissions: ['tabs'] };
  const pkg = { version: '2.1.3', name: '@browserbridge/bbx', custom: { keep: true } };
  const lock = {
    version: '2.1.4',
    lockfileVersion: 3,
    packages: {
      '': { version: '2.1.5', name: '@browserbridge/bbx', license: 'MIT' },
      'node_modules/example': { version: '9.8.7', integrity: 'sha512-keep' },
    },
  };
  for (const [index, value] of [manifest, pkg, lock].entries()) {
    fs.writeFileSync(path.join(root, filenames[index]), JSON.stringify(value));
  }
  const snapshot = () => filenames.map((name) => fs.readFileSync(path.join(root, name), 'utf8'));
  return { root, manifest, pkg, lock, snapshot };
}

test('manifest authority repairs package and both lock mirrors without changing metadata', (t) => {
  const { root, manifest, pkg, lock, snapshot } = fixture(t);
  const options = { root, env: {} };
  const originalManifest = snapshot()[0];
  assert.deepEqual(resolveVersion(options), { version: '2.0.0', source: 'manifest' });
  assert.throws(() => checkVersion(options), /Version mismatch.*2\.0\.0.*package-lock.json/);
  assert.deepEqual(synchronizeVersion(options), resolveVersion(options));
  assert.deepEqual(
    snapshot().map((value): unknown => JSON.parse(value)),
    [
      manifest,
      { ...pkg, version: '2.0.0' },
      {
        ...lock,
        version: '2.0.0',
        packages: { ...lock.packages, '': { ...lock.packages[''], version: '2.0.0' } },
      },
    ]
  );
  assert.equal(snapshot()[0], originalManifest);
  assert.deepEqual(checkVersion(options), resolveVersion(options));
  const synchronized = snapshot();
  const mtimes = filenames.map((name) => fs.statSync(path.join(root, name)).mtimeMs);
  synchronizeVersion(options);
  assert.deepEqual(snapshot(), synchronized);
  assert.deepEqual(
    filenames.map((name) => fs.statSync(path.join(root, name)).mtimeMs),
    mtimes
  );
});

for (const env of [
  { GITHUB_REF: 'refs/tags/v3.4.5' },
  { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v3.4.5' },
  { RELEASE_TAG: 'v3.4.5' },
  {
    GITHUB_REF: 'refs/tags/v3.4.5',
    GITHUB_REF_TYPE: 'tag',
    GITHUB_REF_NAME: 'v3.4.5',
    RELEASE_TAG: 'v3.4.5',
  },
]) {
  test(`tag authority updates stale versions: ${JSON.stringify(env)}`, (t) => {
    const { root, manifest } = fixture(t);
    const options = { root, env };
    assert.equal(resolveVersion(options).source, 'tag');
    assert.equal(resolveVersion(options).version, '3.4.5');
    assert.equal(resolveVersion(options).tag, env.RELEASE_TAG ?? 'v3.4.5');
    assert.throws(() => checkVersion(options), /manifest.json.version is "2.0.0"/);
    synchronizeVersion(options);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')), {
      ...manifest,
      version: '3.4.5',
    });
    assert.equal(checkVersion(options).version, '3.4.5');
  });
}

for (const env of [
  { GITHUB_REF_NAME: 'v9.9.9' },
  {
    CI: 'true',
    GITHUB_REF: 'refs/heads/v9.9.9',
    GITHUB_REF_TYPE: 'branch',
    GITHUB_REF_NAME: 'v9.9.9',
  },
  { CI: 'true', GITHUB_REF: 'refs/pull/123/merge', GITHUB_REF_NAME: '123/merge' },
]) {
  test(`branch and PR environment uses manifest: ${JSON.stringify(env)}`, (t) => {
    const { root } = fixture(t);
    assert.deepEqual(resolveVersion({ root, env }), { version: '2.0.0', source: 'manifest' });
  });
}

for (const tag of [
  'v1.2.3-rc.1',
  '1.2.3',
  '1.2.3+build',
  'v01.2.3',
  'v1.02.3',
  'v1.2.03',
  'v0.0.0',
  'v65536.0.1',
  'v1.2.65536',
  'v1.2',
  'v1.2.3.4',
  'release/v1.2.3',
  'vv1.2.3',
  ' v1.2.3',
  'v1.2.3\n',
  '',
]) {
  test(`invalid tag ${JSON.stringify(tag)} fails before writing`, (t) => {
    const { root, snapshot } = fixture(t);
    const before = snapshot();
    const options = { root, env: { RELEASE_TAG: tag } };
    assert.throws(() => resolveVersion(options), /Invalid/);
    assert.throws(() => synchronizeVersion(options), /Invalid/);
    assert.deepEqual(snapshot(), before);
    if (tag.includes('-rc'))
      assert.throws(() => checkVersion(options), /Prerelease.*Chrome and npm share one version/);
  });
}

for (const env of [
  { GITHUB_REF: 'refs/tags/v3.4.5', RELEASE_TAG: 'v3.4.6' },
  { GITHUB_REF: 'refs/tags/v3.4.5', GITHUB_REF_NAME: 'v3.4.6' },
  { GITHUB_REF: 'refs/tags/v3.4.5', GITHUB_REF_TYPE: 'branch' },
  { GITHUB_REF: 'refs/heads/main', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v3.4.5' },
  { GITHUB_REF_TYPE: 'tag' },
]) {
  test(`conflicting or incomplete tag context fails before writing: ${JSON.stringify(env)}`, (t) => {
    const { root, snapshot } = fixture(t);
    const before = snapshot();
    assert.throws(() => synchronizeVersion({ root, env }), /Inconsistent|requires/);
    assert.deepEqual(snapshot(), before);
  });
}

test('shared version accepts Chrome component boundaries and rejects invalid manifest versions', (t) => {
  const { root } = fixture(t);
  for (const version of ['0.0.1', '65535.65535.65535']) {
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ version }));
    assert.equal(resolveVersion({ root, env: {} }).version, version);
  }
  for (const version of ['v2.0.0', '2.0', '2.0.0-rc.1', '0.0.0', '65536.0.0', 2, null]) {
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ version }));
    assert.throws(() => resolveVersion({ root, env: {} }), /Invalid manifest.json.version/);
  }
});

test('malformed mirror files fail before sync writes and each mirror is checked exactly', (t) => {
  const { root, snapshot } = fixture(t);
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"packages":{}}');
  const before = snapshot();
  assert.throws(
    () => synchronizeVersion({ root, env: { RELEASE_TAG: 'v3.4.5' } }),
    /packages\[''\].*JSON object/
  );
  assert.deepEqual(snapshot(), before);
  for (const lock of [
    { version: '2.0.0', packages: { '': { version: '2.0.1' } } },
    { version: '2.0.1', packages: { '': { version: '2.0.0' } } },
  ]) {
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"2.0.0"}');
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
    assert.throws(() => checkVersion({ root, env: {} }), /package-lock.json.*2\.0\.1/);
  }
});

test('CLI uses its repository root, prints only the version, syncs, and checks exact mirrors', (t) => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const name of ['version.mjs', 'check-release-version.mjs']) {
    fs.copyFileSync(
      new URL(`../../../scripts/${name}`, import.meta.url),
      path.join(root, 'scripts', name)
    );
  }
  const run = (script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
      encoding: 'utf8',
      env,
    });
  const printed = run('version.mjs', ['--print']);
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, '2.0.0\n');
  assert.equal(printed.stderr, '');
  assert.equal(run('version.mjs').status, 1);
  assert.equal(run('check-release-version.mjs').status, 1);
  assert.equal(run('version.mjs', ['--sync']).status, 0);
  assert.equal(run('version.mjs', ['--check']).status, 0);
  assert.equal(run('check-release-version.mjs').status, 0);
  const tagEnv = { RELEASE_TAG: 'v4.5.6' };
  assert.equal(run('version.mjs', ['--print'], tagEnv).stdout, '4.5.6\n');
  assert.equal(run('check-release-version.mjs', [], tagEnv).status, 1);
  assert.equal(run('version.mjs', ['--sync'], tagEnv).status, 0);
  assert.equal(run('check-release-version.mjs', [], tagEnv).status, 0);
  assert.match(run('version.mjs', ['--unknown']).stderr, /Usage:/);
  assert.equal(run('version.mjs', ['--check', '--print']).status, 1);
  const invalid = run('version.mjs', ['--print'], { RELEASE_TAG: 'v4.5.6-rc.1' });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
});
