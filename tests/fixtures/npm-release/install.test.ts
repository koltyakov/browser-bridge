import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';

const installer = fileURLToPath(new URL('../../../scripts/install.sh', import.meta.url));

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-installer-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  await fs.mkdir(bin);
  const binary = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify({ args, autoUpdate: process.env.BBX_AUTO_UPDATE }) + '\\n');
fs.appendFileSync(process.env.EVENTS, 'bbx ' + args[0] + '\\n');
if (args[0] === process.env.FAIL_COMMAND) process.exit(1);
if (args[0] === 'install-self') {
  const dir = args[args.indexOf('--bin-dir') + 1];
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(process.argv[1], path.join(dir, 'bbx'));
  fs.chmodSync(path.join(dir, 'bbx'), 0o700);
}
`;
  await fs.writeFile(path.join(directory, 'binary'), binary);
  await fs.writeFile(
    path.join(bin, 'uname'),
    '#!/bin/sh\nif [ "$1" = -s ]; then echo "$FAKE_OS"; else echo "$FAKE_ARCH"; fi\n',
    { mode: 0o755 }
  );
  await fs.writeFile(
    path.join(bin, 'npm'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NPM_CALLS, JSON.stringify(args) + '\\n');
fs.appendFileSync(process.env.EVENTS, 'npm ' + args[0] + '\\n');
if (args[0] === 'root') {
  if (process.env.FAIL_NPM_ROOT) process.exit(1);
  process.stdout.write(process.env.NPM_ROOT + '\\n');
} else if (JSON.stringify(args) === JSON.stringify(['uninstall', '--global', '@browserbridge/bbx'])) {
  if (process.env.FAIL_NPM_UNINSTALL) process.exit(1);
  fs.rmSync(path.join(process.env.NPM_ROOT, '@browserbridge/bbx'), { recursive: true, force: true });
} else process.exit(2);
`,
    { mode: 0o755 }
  );
  await fs.writeFile(
    path.join(bin, 'curl'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const url = args[1];
fs.appendFileSync(process.env.URLS, url + '\\n');
if (process.env.FAIL_DOWNLOAD) process.exit(22);
if (url.startsWith('https://api.github.com/')) {
  const path = require('node:path');
  const page = new URL(url).searchParams.get('page');
  const response = path.join(process.env.RELEASE_PAGES, page + '.json');
  if (!fs.existsSync(response)) process.exit(22);
  fs.copyFileSync(response, args[3]);
} else fs.copyFileSync(url.endsWith('/checksums.txt') ? process.env.CHECKSUMS : process.env.BINARY, args[3]);
`,
    { mode: 0o755 }
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
    HOME: path.join(directory, 'home with spaces'),
    BBX_INSTALL_DIR: path.join(directory, 'install with spaces'),
    BBX_VERSION: '2.3.4',
    BBX_EXTENSION_ID: 'a'.repeat(32),
    BBX_BROWSER: 'chrome',
    FAKE_OS: 'Linux',
    FAKE_ARCH: 'x86_64',
    BINARY: path.join(directory, 'binary'),
    CHECKSUMS: path.join(directory, 'checksums.txt'),
    CALLS: path.join(directory, 'calls.jsonl'),
    URLS: path.join(directory, 'urls.txt'),
    NPM_ROOT: path.join(directory, 'global npm/node_modules'),
    NPM_CALLS: path.join(directory, 'npm-calls.jsonl'),
    EVENTS: path.join(directory, 'events.txt'),
    RELEASE_PAGES: path.join(directory, 'releases'),
    FAIL_NPM_ROOT: '',
    FAIL_NPM_UNINSTALL: '',
    FAIL_DOWNLOAD: '',
    FAIL_COMMAND: '',
  };
  await fs.mkdir(env.RELEASE_PAGES!);
  const checksum = createHash('sha256').update(binary).digest('hex');
  return {
    directory,
    env,
    checksum,
    run: () => spawnSync('/bin/sh', [installer], { env, encoding: 'utf8' }),
  };
}

test(
  'Unix installer downloads, verifies, installs, registers, and restarts on each platform',
  { skip: process.platform === 'win32' },
  async (t) => {
    for (const [system, arch, asset] of [
      ['Darwin', 'arm64', 'bbx-darwin-arm64'],
      ['Darwin', 'x86_64', 'bbx-darwin-x64'],
      ['Linux', 'aarch64', 'bbx-linux-arm64'],
      ['Linux', 'amd64', 'bbx-linux-x64'],
    ]) {
      const { directory, env, checksum, run } = await fixture(t);
      env.FAKE_OS = system;
      env.FAKE_ARCH = arch;
      await fs.writeFile(env.CHECKSUMS!, `${checksum}  ${asset}\n`);
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        (await fs.readFile(env.CALLS!, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
        [
          {
            args: ['install-self', '--bin-dir', env.BBX_INSTALL_DIR, '--no-restart'],
            autoUpdate: 'off',
          },
          { args: ['install', env.BBX_EXTENSION_ID, '--browser', 'chrome'], autoUpdate: 'off' },
          { args: ['restart'], autoUpdate: 'off' },
        ]
      );
      assert.equal(
        await fs.readFile(env.URLS!, 'utf8'),
        `https://github.com/koltyakov/browser-bridge/releases/download/v2.3.4/checksums.txt\nhttps://github.com/koltyakov/browser-bridge/releases/download/v2.3.4/${asset}\n`
      );
      assert.ok((await fs.stat(path.join(directory, 'install with spaces/bbx'))).isFile());
    }
  }
);

test(
  'Unix installer resolves the highest stable patch in the requested release line',
  { skip: process.platform === 'win32' },
  async (t) => {
    for (const indentation of [undefined, 2]) {
      const { env, checksum, run } = await fixture(t);
      env.BBX_VERSION = '2.3';
      const releases = [
        { tag_name: 'v2.3.9', draft: false, prerelease: false },
        { tag_name: 'v2.4.999', draft: false, prerelease: false },
        { tag_name: 'v2.3.12', draft: false, prerelease: false },
        { tag_name: 'v2.3.99', draft: true, prerelease: false },
        { tag_name: 'v2.3.98', draft: false, prerelease: true },
        { tag_name: 'v2.3.97-rc.1', draft: false, prerelease: false },
        { tag_name: 'v2.30.100', draft: false, prerelease: false },
        { tag_name: 'v3.3.100', draft: false, prerelease: false },
        {
          prerelease: false,
          tag_name: 'v2.3.2',
          draft: false,
          body: '\n"tag_name": "v2.3.500", "draft": false, "prerelease": false \\ } ]',
          assets: [{ tag_name: 'v2.3.600', draft: false, prerelease: false }],
        },
      ];
      await fs.writeFile(
        path.join(env.RELEASE_PAGES!, '1.json'),
        JSON.stringify(releases, null, indentation)
      );
      await fs.writeFile(env.CHECKSUMS!, `${checksum}  bbx-linux-x64\n`);
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Selected Browser Bridge v2\.3\.12 for 2\.3\.x/);
      assert.equal(
        await fs.readFile(env.URLS!, 'utf8'),
        'https://api.github.com/repos/koltyakov/browser-bridge/releases?per_page=100&page=1\nhttps://github.com/koltyakov/browser-bridge/releases/download/v2.3.12/checksums.txt\nhttps://github.com/koltyakov/browser-bridge/releases/download/v2.3.12/bbx-linux-x64\n'
      );
    }
  }
);

test(
  'Unix installer scans all release pages and compares patches numerically',
  { skip: process.platform === 'win32' },
  async (t) => {
    for (const patches of [
      [9, 120],
      [120, 9],
    ]) {
      const { env, checksum, run } = await fixture(t);
      env.BBX_VERSION = 'v2.3';
      const first = Array.from({ length: 99 }, (_, index) => ({
        tag_name: `v3.0.${index}`,
        draft: false,
        prerelease: false,
      }));
      first.push({ tag_name: `v2.3.${patches[0]}`, draft: false, prerelease: false });
      await fs.writeFile(path.join(env.RELEASE_PAGES!, '1.json'), JSON.stringify(first));
      await fs.writeFile(
        path.join(env.RELEASE_PAGES!, '2.json'),
        JSON.stringify([{ tag_name: `v2.3.${patches[1]}`, draft: false, prerelease: false }])
      );
      await fs.writeFile(env.CHECKSUMS!, `${checksum}  bbx-linux-x64\n`);
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Selected Browser Bridge v2\.3\.120/);
      assert.match(await fs.readFile(env.URLS!, 'utf8'), /page=2\n/);
    }
  }
);

test(
  'Unix installer fails before npm removal when a release line cannot be resolved',
  { skip: process.platform === 'win32' },
  async (t) => {
    for (const response of [
      '[]',
      JSON.stringify([
        { tag_name: 'v2.3.99', draft: false, prerelease: true },
        { tag_name: 'v2.4.0', draft: false, prerelease: false },
      ]),
      '{"message":"API failure"}',
      '[{"tag_name":',
      '',
    ]) {
      const { env, run } = await fixture(t);
      env.BBX_VERSION = '2.3';
      await fs.writeFile(path.join(env.RELEASE_PAGES!, '1.json'), response);
      assert.notEqual(run().status, 0);
      await assert.rejects(fs.access(env.CALLS!));
      await assert.rejects(fs.access(env.NPM_CALLS!));
      assert.doesNotMatch(await fs.readFile(env.URLS!, 'utf8'), /releases\/download/);
    }
  }
);

test(
  'Unix installer supports latest, v-prefixed versions, default registration, and another browser',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { env, checksum, run } = await fixture(t);
    await fs.writeFile(env.CHECKSUMS!, `${checksum}  bbx-linux-x64\n`);
    env.BBX_VERSION = '';
    env.BBX_EXTENSION_ID = '';
    env.BBX_BROWSER = 'brave';
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(await fs.readFile(env.URLS!, 'utf8'), /releases\/latest\/download/);
    assert.match(await fs.readFile(env.CALLS!, 'utf8'), /jjjkmmcdkpcgamlopogicbnnhdgebhie/);
    assert.match(await fs.readFile(env.CALLS!, 'utf8'), /brave/);
    env.BBX_VERSION = 'v2.3.4';
    result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(await fs.readFile(env.URLS!, 'utf8'), /releases\/download\/v2\.3\.4/);
  }
);

test(
  'Unix installer rejects invalid settings, unsupported platforms, bad checksums, and download failures before execution',
  { skip: process.platform === 'win32' },
  async (t) => {
    for (const overrides of [
      { BBX_VERSION: '../../other' },
      { BBX_EXTENSION_ID: 'invalid' },
      { BBX_BROWSER: 'invalid' },
      { FAKE_OS: 'Unknown' },
      { FAKE_ARCH: 'i686' },
      { FAIL_DOWNLOAD: '1' },
      {},
    ]) {
      const { env, run } = await fixture(t);
      Object.assign(env, overrides);
      await fs.writeFile(env.CHECKSUMS!, `${'0'.repeat(64)}  bbx-linux-x64\n`);
      const result = run();
      assert.notEqual(result.status, 0);
      await assert.rejects(fs.access(env.CALLS!));
      await assert.rejects(fs.access(env.NPM_CALLS!));
    }
  }
);

test(
  'Unix installer removes an existing global npm package before standalone installation',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { env, checksum, run } = await fixture(t);
    const legacy = path.join(env.NPM_ROOT!, '@browserbridge/bbx');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, 'package.json'), '{}');
    await fs.writeFile(env.CHECKSUMS!, `${checksum}  bbx-linux-x64\n`);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(fs.access(legacy));
    assert.equal(
      await fs.readFile(env.EVENTS!, 'utf8'),
      'npm root\nnpm uninstall\nbbx install-self\nbbx install\nbbx restart\n'
    );
    assert.deepEqual(
      (await fs.readFile(env.NPM_CALLS!, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      [
        ['root', '--global'],
        ['uninstall', '--global', '@browserbridge/bbx'],
      ]
    );
  }
);

test(
  'Unix installer skips npm removal when the global package is absent',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { env, checksum, run } = await fixture(t);
    await fs.writeFile(env.CHECKSUMS!, `${checksum}  bbx-linux-x64\n`);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await fs.readFile(env.NPM_CALLS!, 'utf8'), '["root","--global"]\n');
  }
);

test(
  'Unix installer warns and continues when npm detection or removal fails',
  { skip: process.platform === 'win32' },
  async (t) => {
    for (const failure of ['FAIL_NPM_ROOT', 'FAIL_NPM_UNINSTALL']) {
      const { env, checksum, run } = await fixture(t);
      env[failure] = '1';
      const legacy = path.join(env.NPM_ROOT!, '@browserbridge/bbx');
      await fs.mkdir(legacy, { recursive: true });
      await fs.writeFile(path.join(legacy, 'package.json'), '{}');
      await fs.writeFile(env.CHECKSUMS!, `${checksum}  bbx-linux-x64\n`);
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /Warning: could not/);
      assert.match(await fs.readFile(env.CALLS!, 'utf8'), /restart/);
      assert.ok((await fs.stat(legacy)).isDirectory());
    }
  }
);

test(
  'Unix installer works without npm on PATH',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { directory, env, checksum, run } = await fixture(t);
    const bin = path.join(directory, 'bin');
    await fs.unlink(path.join(bin, 'npm'));
    await fs.symlink(process.execPath, path.join(bin, 'node'));
    for (const name of ['grep', 'mktemp', 'awk', 'chmod', 'rm', 'sha256sum', 'shasum']) {
      const located = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
      if (located.status === 0) await fs.symlink(located.stdout.trim(), path.join(bin, name));
    }
    env.PATH = bin;
    await fs.writeFile(env.CHECKSUMS!, `${checksum}  bbx-linux-x64\n`);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(fs.access(env.NPM_CALLS!));
    assert.match(await fs.readFile(env.CALLS!, 'utf8'), /restart/);
  }
);

test(
  'Unix installer stops when self-install or browser registration fails',
  { skip: process.platform === 'win32' },
  async (t) => {
    for (const [command, calls] of [
      ['install-self', 1],
      ['install', 2],
    ] as const) {
      const { env, checksum, run } = await fixture(t);
      env.FAIL_COMMAND = command;
      await fs.writeFile(env.CHECKSUMS!, `${checksum}  bbx-linux-x64\n`);
      assert.notEqual(run().status, 0);
      assert.equal((await fs.readFile(env.CALLS!, 'utf8')).trim().split('\n').length, calls);
    }
  }
);
