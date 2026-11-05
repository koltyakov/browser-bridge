import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { entrypoints } from '../src/entrypoints.js';
import { installNativeLaunchers, renderNativeLauncher } from '../src/native-launchers.js';
import { packageRoot, type Release } from '../src/runtime.js';

const posix = process.platform !== 'win32';
const openssl = await fs.access('/usr/bin/openssl').then(
  () => true,
  () => false
);

async function fixture(t: TestContext, global = false) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "bbx launcher ' $;& "))
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const prefix = path.join(directory, 'prefix');
  const modules = path.join(prefix, global ? 'lib/node_modules' : 'node_modules');
  const root = path.join(modules, '@browserbridge/bbx');
  const links = global ? path.join(prefix, 'bin') : path.join(modules, '.bin');
  await fs.mkdir(path.join(root, 'packages/npm/bin'), { recursive: true });
  await fs.mkdir(links, { recursive: true });
  const body = Buffer.from(`#!/bin/sh
if [ "\${TEST_SIGNAL-}" = 1 ]; then kill -TERM $$; fi
printf '%s\\n' "$BBX_NPM_VERSION"
printf '<%s>\\n' "$@"
exit "\${TEST_EXIT-0}"
`);
  const binary = path.join(directory, "cache/bbx ' $;&");
  await fs.mkdir(path.dirname(binary));
  await fs.writeFile(binary, body, { mode: 0o755 });
  const release: Release = {
    version: '1.2.3',
    target: `${process.platform}-${process.arch}`,
    artifact: {
      asset: 'bbx',
      bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    },
    url: 'https://example.test/bbx',
    binary,
  };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_global: String(global),
    npm_config_prefix: prefix,
    BBX_NPM_VERSION: 'incorrect-inherited-version',
    TEST_SIGNAL: '0',
    TEST_EXIT: '0',
  };
  const wrapper = (name: string) => path.join(root, 'packages/npm/bin', `${name}.js`);
  const link = (name: string) => path.join(links, name);
  for (const name of Object.keys(entrypoints)) {
    await fs.writeFile(wrapper(name), 'console.log("Node fallback");\n');
    await fs.symlink(path.relative(links, wrapper(name)), link(name));
  }
  return { directory, root, links, release, env, wrapper, link, body };
}

test('npm entrypoint names match package bins and use their shared prefixes', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8')) as {
    bin: Record<string, string>;
  };
  assert.deepEqual(Object.keys(entrypoints).sort(), Object.keys(pkg.bin).sort());
  for (const name of Object.keys(entrypoints)) {
    assert.equal(pkg.bin[name], `packages/npm/bin/${name}.js`);
    assert.match(
      await fs.readFile(path.join(packageRoot, pkg.bin[name]), 'utf8'),
      new RegExp(`await launch\\('${name}'\\)`)
    );
  }
});

for (const global of [false, true]) {
  test(
    `native launchers optimize ${global ? 'global' : 'local'} npm symlinks without replacing JS`,
    { skip: !posix },
    async (t) => {
      const f = await fixture(t, global);
      assert.equal(await installNativeLaunchers(f.release, f), 4);
      for (const [name, prefix] of Object.entries(entrypoints)) {
        const launcher = await fs.realpath(f.link(name));
        assert.equal(launcher, path.join(f.root, 'packages/npm/bin/.native', name));
        assert.equal(await fs.readFile(f.wrapper(name), 'utf8'), 'console.log("Node fallback");\n');
        const args = ['', 'space and\nnewline', "quote ' and $;&", '--remote', 'a destination'];
        const result = spawnSync(f.link(name), args, {
          env: { ...f.env, PATH: '' },
          encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr || String(result.error));
        if (openssl) {
          assert.equal(
            result.stdout,
            `1.2.3\n${[...prefix, ...args].map((arg) => `<${arg}>\n`).join('')}`
          );
        } else assert.equal(result.stdout, 'Node fallback\n');
      }
      assert.equal(await installNativeLaunchers(f.release, f), 4);
      assert.deepEqual((await fs.readdir(f.links)).sort(), Object.keys(entrypoints).sort());
    }
  );
}

test(
  'native exec preserves exit status and termination signals',
  { skip: !posix || !openssl },
  async (t) => {
    const f = await fixture(t);
    await installNativeLaunchers(f.release, f);
    const exited = spawnSync(f.link('bbx'), [], { env: { ...f.env, TEST_EXIT: '23' } });
    assert.equal(exited.status, 23);
    const signaled = spawnSync(f.link('bbx'), [], { env: { ...f.env, TEST_SIGNAL: '1' } });
    assert.equal(signaled.signal, 'SIGTERM');
  }
);

test(
  'native launchers reject modified, truncated, oversized, symlinked, and non-file cache entries',
  { skip: !posix || !openssl },
  async (t) => {
    for (const kind of ['modified', 'truncated', 'oversized', 'symlink', 'directory']) {
      await t.test(kind, async (t) => {
        const f = await fixture(t);
        await installNativeLaunchers(f.release, f);
        if (kind === 'modified') await fs.writeFile(f.release.binary, Buffer.alloc(f.body.length));
        if (kind === 'truncated') await fs.writeFile(f.release.binary, f.body.subarray(1));
        if (kind === 'oversized') await fs.appendFile(f.release.binary, '\n');
        if (kind === 'symlink') {
          const target = `${f.release.binary}.original`;
          await fs.rename(f.release.binary, target);
          await fs.symlink(target, f.release.binary);
        }
        if (kind === 'directory') {
          await fs.unlink(f.release.binary);
          await fs.mkdir(f.release.binary);
        }
        const result = spawnSync(f.link('bbx'), [], { env: f.env, encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /Cached Browser Bridge binary failed verification/);
      });
    }
  }
);

test(
  'missing binary or OpenSSL delegates to the original Node wrapper',
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    const launcher = path.join(f.directory, 'launcher');
    await fs.writeFile(
      launcher,
      renderNativeLauncher(f.release, f.wrapper('bbx'), [], {
        openssl: path.join(f.directory, 'missing'),
      }),
      { mode: 0o755 }
    );
    assert.equal(
      spawnSync(launcher, [], { env: f.env, encoding: 'utf8' }).stdout,
      'Node fallback\n'
    );
    await installNativeLaunchers(f.release, f);
    await fs.unlink(f.release.binary);
    const missing = spawnSync(f.link('bbx'), [], { env: f.env, encoding: 'utf8' });
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(missing.stdout, 'Node fallback\n');
  }
);

test(
  'a failed checksum tool fails closed instead of executing the binary',
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    const verifier = path.join(f.directory, 'failed-openssl');
    await fs.writeFile(verifier, '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    const launcher = path.join(f.directory, 'launcher');
    await fs.writeFile(
      launcher,
      renderNativeLauncher(f.release, f.wrapper('bbx'), [], { openssl: verifier }),
      { mode: 0o755 }
    );
    const result = spawnSync(launcher, [], { env: f.env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /failed verification/);
  }
);

test(
  'optimization leaves unrelated commands, source checkouts, and Windows shims unchanged',
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    await fs.unlink(f.link('bbx'));
    await fs.writeFile(f.link('bbx'), 'unrelated executable');
    await fs.unlink(f.link('bbx-mcp'));
    await fs.symlink(f.link('bbx'), f.link('bbx-mcp'));
    assert.equal(await installNativeLaunchers(f.release, { ...f, platform: 'win32' }), 0);
    assert.equal(await installNativeLaunchers(f.release, { ...f, root: f.directory }), 0);
    assert.equal(await installNativeLaunchers(f.release, f), 2);
    assert.equal(await fs.readFile(f.link('bbx'), 'utf8'), 'unrelated executable');
    assert.equal(await fs.realpath(f.link('bbx-mcp')), f.link('bbx'));
  }
);
