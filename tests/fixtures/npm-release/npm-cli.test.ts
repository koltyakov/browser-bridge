import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { resolveNpmCli } from '../../_helpers/npmCli.js';

const exec = promisify(execFile);

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-npm-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (relative: string, content = '') => {
    const filename = path.join(root, relative);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, content);
    return filename;
  };
  return { root, write };
}

test('standalone Windows npm resolution handles spaces without a command shell', async (t) => {
  const f = await fixture(t);
  const execPath = await f.write('Node installation/node.exe');
  const cli = await f.write(
    'Node installation/node_modules/npm/bin/npm-cli.js',
    'process.stdout.write(JSON.stringify(process.argv.slice(2)));'
  );
  const resolved = resolveNpmCli({ execPath, env: {} });
  assert.equal(resolved, await fs.realpath(cli));
  const args = ['pack', 'path with spaces & shell metacharacters'];
  const { stdout } = await exec(process.execPath, [resolved, ...args]);
  assert.deepEqual(JSON.parse(stdout), args);
});

test('standalone Unix npm resolution uses the Node installation prefix', async (t) => {
  const f = await fixture(t);
  const execPath = await f.write('prefix/bin/node');
  const cli = await f.write('prefix/lib/node_modules/npm/bin/npm-cli.js');
  assert.equal(resolveNpmCli({ execPath, env: {} }), await fs.realpath(cli));
});

test('npm resolution honors an explicit npm CLI but ignores stale paths and other package managers', async (t) => {
  const f = await fixture(t);
  const execPath = await f.write('node/node.exe');
  const bundled = await f.write('node/node_modules/npm/bin/npm-cli.js');
  const override = await f.write('custom/npm-cli.js');
  assert.equal(
    resolveNpmCli({ execPath, env: { npm_execpath: override } }),
    await fs.realpath(override)
  );
  for (const npm_execpath of [
    path.join(f.root, 'missing/npm-cli.js'),
    await f.write('bun/bun.exe'),
    await f.write('npm-cli.js/not-a-file'),
  ]) {
    assert.equal(resolveNpmCli({ execPath, env: { npm_execpath } }), await fs.realpath(bundled));
  }
});

test(
  'npm resolution follows PATH symlinks for separately packaged Unix installations',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    const execPath = await f.write('bin/node');
    const cli = await f.write('share/nodejs/npm/bin/npm-cli.js');
    await fs.symlink(cli, path.join(f.root, 'bin/npm'));
    assert.equal(
      resolveNpmCli({ execPath, env: { PATH: path.join(f.root, 'bin') } }),
      await fs.realpath(cli)
    );
  }
);

test('missing npm produces a setup error rather than trying a Windows command shim', async (t) => {
  const f = await fixture(t);
  const execPath = await f.write('bin/node.exe');
  await f.write('bin/npm.cmd');
  assert.throws(
    () => resolveNpmCli({ execPath, env: { PATH: path.join(f.root, 'bin') } }),
    /Cannot locate npm-cli\.js.*install npm alongside Node\.js/u
  );
});
