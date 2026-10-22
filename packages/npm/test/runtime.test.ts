import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  ensureNative,
  loadRelease,
  nativeTargets,
  isSourceCheckout,
  type InstallOptions,
} from '../src/runtime.js';
import { postinstall, shouldInitialize } from '../bin/postinstall.js';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-npm-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const body = Buffer.from('verified native release bytes');
  const target = `${process.platform}-${process.arch}`;
  const manifest = {
    version: '1.14.2',
    artifacts: {
      [target]: {
        asset: nativeTargets[target],
        bytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      },
    },
  };
  await fs.mkdir(path.join(root, 'packages/npm'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ version: manifest.version })
  );
  const writeManifest = () =>
    fs.writeFile(path.join(root, 'packages/npm/native-manifest.json'), JSON.stringify(manifest));
  await writeManifest();
  let downloads = 0;
  let probes = 0;
  const urls: string[] = [];
  const options: InstallOptions = {
    root,
    env: {
      HOME: path.join(root, 'home'),
      USERPROFILE: path.join(root, 'home'),
      LOCALAPPDATA: path.join(root, 'local'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
    },
    fetchFn: async (url) => {
      downloads++;
      urls.push(String(url));
      return new Response(body);
    },
    probeFn: async (filename, release) => {
      probes++;
      assert.deepEqual(await fs.readFile(filename), body);
      assert.equal(release.version, '1.14.2');
    },
  };
  return {
    root,
    target,
    manifest,
    body,
    options,
    urls,
    writeManifest,
    counts: () => ({ downloads, probes }),
  };
}

test('npm bootstrap pins version and platform, verifies cache, and serializes concurrent downloads', async (t) => {
  const f = await fixture(t);
  const binaries = await Promise.all(Array.from({ length: 8 }, () => ensureNative(f.options)));
  assert.equal(new Set(binaries).size, 1);
  assert.deepEqual(f.counts(), { downloads: 1, probes: 1 });
  assert.deepEqual(f.urls, [
    `https://github.com/koltyakov/browser-bridge/releases/download/v1.14.2/${nativeTargets[f.target]}`,
  ]);
  assert.equal(
    await ensureNative({
      ...f.options,
      fetchFn: async () => {
        throw new Error('offline');
      },
    }),
    binaries[0]
  );
  assert.deepEqual(await fs.readdir(path.dirname(binaries[0])), [path.basename(binaries[0])]);
  if (process.platform !== 'win32') assert.equal((await fs.stat(binaries[0])).mode & 0o777, 0o755);
});

test('npm bootstrap never substitutes another platform or version', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    loadRelease({ ...f.options, platform: 'win32', arch: 'arm64' }),
    /does not publish/
  );
  f.manifest.version = '1.14.3';
  await f.writeManifest();
  await assert.rejects(ensureNative(f.options), /does not match npm version/);
  assert.deepEqual(f.counts(), { downloads: 0, probes: 0 });
});

test('npm bootstrap validates all supported artifact mappings', async (t) => {
  const f = await fixture(t);
  for (const [target, asset] of Object.entries(nativeTargets)) {
    const [platform, arch] = target.split('-');
    f.manifest.artifacts[target] = { ...f.manifest.artifacts[f.target], asset };
    await f.writeManifest();
    const release = await loadRelease({ ...f.options, platform, arch });
    assert(release.url.endsWith(`/v1.14.2/${asset}`));
    assert.equal(path.basename(release.binary), platform === 'win32' ? 'bbx.exe' : 'bbx');
  }
});

test('npm bootstrap rejects missing or malformed release metadata before download', async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.root, 'packages/npm/native-manifest.json');
  for (const artifact of [
    null,
    { asset: '../bbx' },
    { ...f.manifest.artifacts[f.target], bytes: 10_000_000 },
    { ...f.manifest.artifacts[f.target], sha256: 'invalid' },
  ]) {
    await fs.writeFile(
      filename,
      JSON.stringify({ version: f.manifest.version, artifacts: { [f.target]: artifact } })
    );
    await assert.rejects(ensureNative(f.options), /Invalid native/);
  }
  await fs.rm(filename);
  await assert.rejects(ensureNative(f.options), /manifest is missing/);
  await f.writeManifest();
  await fs.writeFile(
    path.join(f.root, 'package.json'),
    JSON.stringify({ version: '../../latest' })
  );
  await assert.rejects(ensureNative(f.options), /Invalid npm package version/);
  assert.equal(f.counts().downloads, 0);
});

test('npm bootstrap rejects corrupt, oversized, truncated, and wrong-version binaries without activation', async (t) => {
  for (const kind of ['checksum', 'oversized', 'truncated', 'probe']) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      const bad =
        kind === 'checksum'
          ? Buffer.alloc(f.body.length)
          : kind === 'oversized'
            ? Buffer.concat([f.body, Buffer.from('extra')])
            : kind === 'truncated'
              ? f.body.subarray(1)
              : f.body;
      await assert.rejects(
        ensureNative({
          ...f.options,
          fetchFn: async () => new Response(bad),
          probeFn:
            kind === 'probe'
              ? async () => {
                  throw new Error('wrong executable version');
                }
              : f.options.probeFn,
        }),
        /verification|expected size|wrong executable/
      );
      const release = await loadRelease(f.options);
      await assert.rejects(fs.stat(release.binary), { code: 'ENOENT' });
      assert.deepEqual(await fs.readdir(path.dirname(release.binary)), []);
      if (kind !== 'probe') assert.equal(f.counts().probes, 0);
      assert.equal(await ensureNative(f.options), release.binary);
    });
  }
});

test('npm bootstrap refuses a modified cached binary rather than executing it', async (t) => {
  const f = await fixture(t);
  const binary = await ensureNative(f.options);
  await fs.writeFile(binary, Buffer.alloc(f.body.length));
  await assert.rejects(ensureNative(f.options), /Cached Browser Bridge binary failed verification/);
  assert.deepEqual(f.counts(), { downloads: 1, probes: 1 });
});

test('npm bootstrap follows HTTPS release redirects and fails explicitly for unavailable versions', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await ensureNative({
    ...f.options,
    fetchFn: async (url) => {
      calls++;
      if (calls === 1)
        return new Response(null, {
          status: 302,
          headers: { location: 'https://release-assets.githubusercontent.com/pinned' },
        });
      assert.equal(String(url), 'https://release-assets.githubusercontent.com/pinned');
      return new Response(f.body);
    },
  });
  assert.equal(calls, 2);
  const other = await fixture(t);
  await assert.rejects(
    ensureNative({ ...other.options, fetchFn: async () => new Response(null, { status: 404 }) }),
    /1\.14\.2.*HTTP 404/
  );
  await assert.rejects(
    ensureNative({
      ...other.options,
      fetchFn: async () =>
        new Response(null, { status: 302, headers: { location: 'http://example.test/bbx' } }),
    }),
    /HTTPS redirects/
  );
  await assert.rejects(
    ensureNative({ ...other.options, fetchFn: async () => new Response(null, { status: 302 }) }),
    /no location/
  );
  await assert.rejects(
    ensureNative({
      ...other.options,
      fetchFn: async () => new Response(null, { status: 302, headers: { location: '/loop' } }),
    }),
    /Too many/
  );
  await assert.rejects(
    ensureNative({ ...other.options, fetchFn: async () => new Response(null) }),
    /empty body/
  );
});

test('npm bootstrap recovers abandoned download locks', async (t) => {
  const f = await fixture(t);
  const release = await loadRelease(f.options);
  const lock = path.join(path.dirname(release.binary), '.install-lock');
  await fs.mkdir(lock, { recursive: true });
  await fs.utimes(lock, new Date(0), new Date(0));
  assert.equal(await ensureNative(f.options), release.binary);
});

test('npm postinstall downloads locally, initializes globally, and skips source checkouts', async (t) => {
  const f = await fixture(t);
  let initializations = 0;
  const initialize = async () => {
    initializations++;
  };
  await postinstall({ ...f.options, initialize });
  assert.equal(f.counts().downloads, 1);
  assert.equal(initializations, 0);
  await postinstall({
    ...f.options,
    env: { ...f.options.env, npm_config_global: 'true' },
    initialize,
  });
  assert.equal(initializations, 1);
  assert.equal(shouldInitialize({ npm_command: 'exec', BBX_POSTINSTALL_FORCE: '1' }), false);
  assert.equal(shouldInitialize({ BBX_POSTINSTALL_FORCE: '1' }), true);
  assert.equal(shouldInitialize({ npm_config_global: '1' }), true);
  await fs.mkdir(path.join(f.root, 'cmd/bbx'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'go.mod'), 'module test');
  await fs.writeFile(path.join(f.root, 'cmd/bbx/main.go'), 'package main');
  assert.equal(await isSourceCheckout(f.root), true);
  await postinstall({
    ...f.options,
    env: { ...f.options.env, npm_config_global: 'true' },
    initialize,
  });
  assert.equal(initializations, 1);
});
