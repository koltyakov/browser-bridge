import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  resolveNative,
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
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
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
      if (String(url).startsWith('https://api.github.com/'))
        return Response.json({
          tag_name: `v${manifest.version}`,
          draft: false,
          prerelease: false,
          assets: Object.values(manifest.artifacts).map((artifact) => ({
            name: artifact.asset,
            size: artifact.bytes,
          })),
        });
      if (String(url).endsWith('/checksums.txt'))
        return new Response(
          Object.values(manifest.artifacts)
            .map((artifact) => `${artifact.sha256}  ${artifact.asset}`)
            .join('\n')
        );
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
  const writeManifest = () => loadRelease({ ...options, refresh: true });
  await writeManifest();
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

test('npm bootstrap selects a release independently of npm, verifies cache, and serializes concurrent downloads', async (t) => {
  const f = await fixture(t);
  const releases = await Promise.all(Array.from({ length: 8 }, () => resolveNative(f.options)));
  const binaries = releases.map((release) => release.binary);
  assert.equal(new Set(binaries).size, 1);
  assert.deepEqual(f.counts(), { downloads: 1, probes: 1 });
  assert.deepEqual(f.urls, [
    `https://github.com/koltyakov/browser-bridge/releases/download/v1.14.2/${nativeTargets[f.target]}`,
  ]);
  assert.equal(
    (
      await resolveNative({
        ...f.options,
        fetchFn: async () => {
          throw new Error('offline');
        },
      })
    ).binary,
    binaries[0]
  );
  assert.deepEqual(await fs.readdir(path.dirname(binaries[0])), [path.basename(binaries[0])]);
  if (process.platform !== 'win32') assert.equal((await fs.stat(binaries[0])).mode & 0o777, 0o755);
});

test('npm bootstrap never substitutes another platform and can refresh beyond the npm version', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    loadRelease({ ...f.options, platform: 'win32', arch: 'ia32' }),
    /does not publish/
  );
  const missingTarget = Object.keys(nativeTargets).find((target) => target !== f.target);
  assert(missingTarget);
  const [platform, arch] = missingTarget.split('-');
  await assert.rejects(
    loadRelease({ ...f.options, platform, arch }),
    /Missing or duplicate native artifact/
  );
  f.manifest.version = '1.14.3';
  await f.writeManifest();
  assert.equal((await loadRelease(f.options)).version, '1.14.3');
  assert.deepEqual(f.counts(), { downloads: 0, probes: 0 });
});

test('npm bootstrap selects the newest stable patch in the extension release line across pages', async (t) => {
  const f = await fixture(t);
  const candidate = (version: string, extra = {}) => ({
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [{ name: nativeTargets[f.target], size: f.body.length }],
    ...extra,
  });
  const pages: string[] = [];
  const release = await loadRelease({
    ...f.options,
    env: { ...f.options.env, BBX_VERSION: 'v1.14' },
    fetchFn: async (url) => {
      if (String(url).includes('?per_page=')) {
        pages.push(String(url));
        return Response.json(
          pages.length === 1
            ? [
                ...Array.from({ length: 96 }, () => candidate('2.0.0')),
                candidate('1.14.99', { draft: true }),
                candidate('1.14.20', { prerelease: true }),
                candidate('1.14.11-beta'),
                candidate('1.14.2'),
              ]
            : [candidate('1.14.10'), candidate('1.14.9')]
        );
      }
      return f.options.fetchFn!(url);
    },
  });
  assert.equal(release.version, '1.14.10');
  assert.equal(pages.length, 2);
  assert.match(release.url, /\/v1\.14\.10\//);
  await assert.rejects(
    loadRelease({
      ...f.options,
      env: { ...f.options.env, BBX_VERSION: '9.0' },
      fetchFn: async () => Response.json([candidate('1.14.10')]),
    }),
    /No published stable release found for 9\.0/
  );
});

test('npm bootstrap honors exact native versions without consulting npm metadata', async (t) => {
  const f = await fixture(t);
  await fs.rm(path.join(f.root, 'package.json'));
  const urls: string[] = [];
  const release = await loadRelease({
    ...f.options,
    env: { ...f.options.env, BBX_VERSION: '1.14.2' },
    fetchFn: async (url) => {
      urls.push(String(url));
      return f.options.fetchFn!(url);
    },
  });
  assert.equal(release.version, '1.14.2');
  assert.match(urls[0], /\/releases\/tags\/v1\.14\.2$/);
  await assert.rejects(
    loadRelease({
      ...f.options,
      env: { ...f.options.env, BBX_VERSION: '1.14.3' },
    }),
    /Invalid published stable release/
  );
});

test('npm bootstrap retains each installation selection without a persistent environment override', async (t) => {
  const f = await fixture(t);
  await loadRelease({ ...f.options, env: { ...f.options.env, BBX_VERSION: '1.14.2' } });
  f.manifest.version = '1.14.3';
  const other = await loadRelease({
    ...f.options,
    root: path.join(f.root, 'other-install'),
    refresh: true,
  });
  assert.equal(other.version, '1.14.3');
  const original = await loadRelease({
    ...f.options,
    fetchFn: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(original.version, '1.14.2');
  assert.equal(
    (await loadRelease({ ...f.options, root: path.join(f.root, 'other-install') })).version,
    '1.14.3'
  );
});

test('npm bootstrap rejects unavailable, draft, malformed, or unverifiable release selections', async (t) => {
  const f = await fixture(t);
  for (const value of [
    null,
    { tag_name: 'v1.14.2', draft: true, prerelease: false },
    { tag_name: 'v1.14.2', draft: false, prerelease: false },
    { tag_name: 'v1.14.2', draft: false, prerelease: false, assets: [] },
  ]) {
    await assert.rejects(
      loadRelease({ ...f.options, refresh: true, fetchFn: async () => Response.json(value) }),
      /Invalid|Missing/
    );
  }
  for (const checksum of [
    '',
    `invalid  ${nativeTargets[f.target]}`,
    `${f.manifest.artifacts[f.target].sha256}  ${nativeTargets[f.target]}\n`.repeat(2),
  ]) {
    await assert.rejects(
      loadRelease({
        ...f.options,
        refresh: true,
        fetchFn: async (url) =>
          String(url).endsWith('/checksums.txt') ? new Response(checksum) : f.options.fetchFn!(url),
      }),
      /checksum|Invalid native artifact/
    );
  }
  await assert.rejects(
    loadRelease({
      ...f.options,
      refresh: true,
      fetchFn: async () => new Response('x'.repeat(8 * 1024 * 1024 + 1)),
    }),
    /size limit/
  );
  await assert.rejects(
    loadRelease({
      ...f.options,
      refresh: true,
      fetchFn: async () => new Response(null, { status: 403 }),
    }),
    /HTTP 403/
  );
  assert.equal((await loadRelease(f.options)).version, '1.14.2');
  assert.equal(f.counts().downloads, 0);
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

test('Windows ARM64 bootstrap downloads and verifies the native ARM64 asset', async (t) => {
  const f = await fixture(t);
  const target = 'win32-arm64';
  const asset = 'bbx-windows-arm64.exe';
  assert.equal(nativeTargets[target], asset);
  f.manifest.artifacts[target] = { ...f.manifest.artifacts[f.target], asset };
  const release = await resolveNative({
    ...f.options,
    platform: 'win32',
    arch: 'arm64',
    refresh: true,
  });
  assert.equal(release.target, target);
  assert.equal(path.basename(release.binary), 'bbx.exe');
  assert.deepEqual(f.urls, [
    `https://github.com/koltyakov/browser-bridge/releases/download/v1.14.2/${asset}`,
  ]);
  assert.deepEqual(f.counts(), { downloads: 1, probes: 1 });
});

test('Linux npm cache ignores relative XDG overrides', async (t) => {
  const f = await fixture(t);
  const target = 'linux-x64';
  f.manifest.artifacts[target] = {
    ...f.manifest.artifacts[f.target],
    asset: nativeTargets[target],
  };
  await f.writeManifest();
  for (const cache of ['', 'relative', '~/not-expanded', path.join(f.root, 'absolute-cache')]) {
    const release = await loadRelease({
      ...f.options,
      platform: 'linux',
      arch: 'x64',
      env: { HOME: path.join(f.root, 'home'), XDG_CACHE_HOME: cache },
    });
    const base = path.isAbsolute(cache) ? cache : path.join(f.root, 'home', '.cache');
    assert.ok(release.binary.startsWith(path.join(base, 'browser-bridge', 'npm') + path.sep));
  }
});

test('npm bootstrap rejects malformed release metadata before download', async (t) => {
  const f = await fixture(t);
  for (const artifact of [
    { ...f.manifest.artifacts[f.target], bytes: 10_000_000 },
    { ...f.manifest.artifacts[f.target], sha256: 'invalid' },
  ]) {
    f.manifest.artifacts[f.target] = artifact;
    await assert.rejects(f.writeManifest(), /Invalid native/);
  }
  await assert.rejects(
    loadRelease({ ...f.options, env: { BBX_VERSION: '../../latest' } }),
    /Invalid BBX_VERSION/
  );
  f.manifest.version = '../../latest';
  await assert.rejects(f.writeManifest(), /Invalid published stable release/);
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
        resolveNative({
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
      assert.equal((await resolveNative(f.options)).binary, release.binary);
    });
  }
});

test('npm bootstrap refuses a modified cached binary rather than executing it', async (t) => {
  const f = await fixture(t);
  const { binary } = await resolveNative(f.options);
  await fs.writeFile(binary, Buffer.alloc(f.body.length));
  await assert.rejects(
    resolveNative(f.options),
    /Cached Browser Bridge binary failed verification/
  );
  assert.deepEqual(f.counts(), { downloads: 1, probes: 1 });
});

test('npm bootstrap follows HTTPS release redirects and fails explicitly for unavailable versions', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await resolveNative({
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
    resolveNative({ ...other.options, fetchFn: async () => new Response(null, { status: 404 }) }),
    /HTTP 404.*1\.14\.2/
  );
  await assert.rejects(
    resolveNative({
      ...other.options,
      fetchFn: async () =>
        new Response(null, { status: 302, headers: { location: 'http://example.test/bbx' } }),
    }),
    /HTTPS redirects/
  );
  await assert.rejects(
    resolveNative({ ...other.options, fetchFn: async () => new Response(null, { status: 302 }) }),
    /no location/
  );
  await assert.rejects(
    resolveNative({
      ...other.options,
      fetchFn: async () => new Response(null, { status: 302, headers: { location: '/loop' } }),
    }),
    /Too many/
  );
  await assert.rejects(
    resolveNative({ ...other.options, fetchFn: async () => new Response(null) }),
    /empty body/
  );
});

test('npm bootstrap recovers abandoned download locks', async (t) => {
  const f = await fixture(t);
  const release = await loadRelease(f.options);
  const lock = path.join(path.dirname(release.binary), '.install-lock');
  await fs.mkdir(lock, { recursive: true });
  await fs.utimes(lock, new Date(0), new Date(0));
  assert.equal((await resolveNative(f.options)).binary, release.binary);
});

test('npm postinstall downloads locally, initializes globally, and skips source checkouts', async (t) => {
  const f = await fixture(t);
  let initializations = 0;
  const initialize = async () => {
    initializations++;
  };
  await postinstall({ ...f.options, refresh: false, initialize });
  assert.equal(f.counts().downloads, 1);
  assert.equal(initializations, 0);
  await postinstall({
    ...f.options,
    refresh: false,
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

test(
  'npm postinstall keeps the Node entry and initializes even if command optimization fails',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    const root = path.join(f.root, 'node_modules/@browserbridge/bbx');
    await fs.mkdir(path.join(root, 'packages/npm/bin'), { recursive: true });
    await fs.cp(path.join(f.root, 'package.json'), path.join(root, 'package.json'));
    const wrapper = path.join(root, 'packages/npm/bin/bbx.js');
    const link = path.join(f.root, 'node_modules/.bin/bbx');
    await fs.writeFile(wrapper, 'original Node entry');
    await fs.mkdir(path.dirname(link));
    await fs.symlink(wrapper, link);
    await fs.writeFile(path.join(root, 'packages/npm/bin/.native'), 'not a directory');
    const errors = t.mock.method(console, 'error', () => {});
    let initialized = false;
    await postinstall({
      ...f.options,
      root,
      env: { ...f.options.env, BBX_POSTINSTALL_FORCE: '1' },
      initialize: async () => {
        initialized = true;
      },
    });
    assert.equal(initialized, true);
    assert.match(String(errors.mock.calls[0].arguments[0]), /native command optimization skipped/);
    assert.equal(await fs.readFile(link, 'utf8'), 'original Node entry');
  }
);
