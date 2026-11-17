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
fs.appendFileSync(process.env.CALL_ENV, JSON.stringify({ browser: process.env.BBX_BROWSER, extensionId: process.env.BROWSER_BRIDGE_EXTENSION_ID }) + '\\n');
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
    path.join(bin, 'volta'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.VOLTA_CALLS, JSON.stringify(args) + '\\n');
if (JSON.stringify(args) !== JSON.stringify(['list', '--format', 'plain', '@browserbridge/bbx'])) process.exit(2);
if (process.env.FAIL_VOLTA_LIST) process.exit(1);
process.stdout.write(process.env.VOLTA_LIST);
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
    SHELL: '/bin/bash',
    ZDOTDIR: undefined,
    BBX_INSTALL_DIR: path.join(directory, 'install with spaces'),
    BBX_VERSION: '2.3.4',
    BBX_EXTENSION_ID: 'a'.repeat(32),
    BROWSER_BRIDGE_EXTENSION_ID: undefined,
    BBX_BROWSER: 'chrome',
    FAKE_OS: 'Linux',
    FAKE_ARCH: 'x86_64',
    BINARY: path.join(directory, 'binary'),
    CHECKSUMS: path.join(directory, 'checksums.txt'),
    CALLS: path.join(directory, 'calls.jsonl'),
    CALL_ENV: path.join(directory, 'call-env.jsonl'),
    URLS: path.join(directory, 'urls.txt'),
    NPM_ROOT: path.join(directory, 'global npm/node_modules'),
    NPM_CALLS: path.join(directory, 'npm-calls.jsonl'),
    VOLTA_CALLS: path.join(directory, 'volta-calls.jsonl'),
    VOLTA_LIST: '',
    FAIL_VOLTA_LIST: '',
    EVENTS: path.join(directory, 'events.txt'),
    RELEASE_PAGES: path.join(directory, 'releases'),
    FAIL_NPM_ROOT: '',
    FAIL_NPM_UNINSTALL: '',
    FAIL_DOWNLOAD: '',
    FAIL_COMMAND: '',
  };
  await fs.mkdir(env.HOME!, { recursive: true });
  await fs.mkdir(env.RELEASE_PAGES!);
  const checksum = createHash('sha256').update(binary).digest('hex');
  return {
    directory,
    env,
    checksum,
    run: () => spawnSync('/bin/sh', [installer], { env, encoding: 'utf8' }),
  };
}

async function zshFixture(t: TestContext) {
  const setup = await fixture(t);
  setup.env.SHELL = '/bin/zsh';
  delete setup.env.BBX_INSTALL_DIR;
  await fs.writeFile(setup.env.CHECKSUMS!, `${setup.checksum}  bbx-linux-x64\n`);
  return setup;
}

test(
  'Unix installer preserves zsh configuration and adds an idempotent PATH entry',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { env, run } = await zshFixture(t);
    const zshrc = path.join(env.HOME!, '.zshrc');
    const existing = 'export EXISTING_SETTING=kept'; // No trailing newline.
    await fs.writeFile(zshrc, existing);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /for future terminals/);
    assert.match(result.stdout, /For this terminal, run: export PATH=/);
    const configured = await fs.readFile(zshrc, 'utf8');
    assert.ok(configured.startsWith(`${existing}\n`));
    assert.equal(configured.split('# Browser Bridge').length - 1, 1);
    const repeated = run();
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(await fs.readFile(zshrc, 'utf8'), configured);

    // The generated entry is POSIX-compatible, so this also runs on CI without zsh.
    const startup = spawnSync(
      '/bin/sh',
      ['-c', '. "$ZSHRC"; . "$ZSHRC"; printf "%s\\n%s" "$EXISTING_SETTING" "$PATH"'],
      { env: { ...env, ZSHRC: zshrc }, encoding: 'utf8' }
    );
    assert.equal(startup.status, 0, startup.stderr);
    assert.equal(startup.stdout, `kept\n${env.HOME}/.local/bin:${env.PATH}`);
  }
);

test(
  'Unix installer creates the zsh config in HOME or ZDOTDIR even when PATH already contains the directory',
  { skip: process.platform === 'win32' },
  async (t) => {
    for (const useZdotdir of [false, true]) {
      const { directory, env, run } = await zshFixture(t);
      const configDir = useZdotdir ? path.join(directory, 'zsh config') : env.HOME!;
      if (useZdotdir) {
        await fs.mkdir(configDir);
        env.ZDOTDIR = configDir;
      }
      env.PATH = `${env.HOME}/.local/bin:${env.PATH}`;
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /For this terminal|shell profile PATH/);
      const zshrc = path.join(configDir, '.zshrc');
      const configured = await fs.readFile(zshrc, 'utf8');
      assert.match(configured, /# Browser Bridge/);
      if (useZdotdir) await assert.rejects(fs.access(path.join(env.HOME!, '.zshrc')));
      const repeated = run();
      assert.equal(repeated.status, 0, repeated.stderr);
      assert.equal(await fs.readFile(zshrc, 'utf8'), configured);
      const startup = spawnSync('/bin/sh', ['-c', '. "$ZSHRC"; . "$ZSHRC"; printf "%s" "$PATH"'], {
        env: { ...env, ZSHRC: zshrc },
        encoding: 'utf8',
      });
      assert.equal(startup.status, 0, startup.stderr);
      assert.equal(startup.stdout, env.PATH);
    }
  }
);

test(
  'Unix installer does not duplicate a PATH directory already configured by the user',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { env, run } = await zshFixture(t);
    const zshrc = path.join(env.HOME!, '.zshrc');
    await fs.writeFile(zshrc, 'export PATH="$HOME/.local/bin:$PATH"\n');
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const startup = spawnSync('/bin/sh', ['-c', '. "$ZSHRC"; printf "%s" "$PATH"'], {
      env: { ...env, ZSHRC: zshrc },
      encoding: 'utf8',
    });
    assert.equal(startup.status, 0, startup.stderr);
    assert.equal(startup.stdout, `${env.HOME}/.local/bin:${env.PATH}`);
  }
);

test(
  'Unix installer configures bash and zsh startup files for custom install directories',
  { skip: process.platform === 'win32' },
  async (t) => {
    for (const shell of ['/bin/bash', '/bin/zsh']) {
      const { env, checksum, run } = await fixture(t);
      env.SHELL = shell;
      await fs.writeFile(env.CHECKSUMS!, `${checksum}  bbx-linux-x64\n`);
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /For this terminal, run: export PATH=/);
      const profiles = shell === '/bin/zsh' ? ['.zshrc', '.zprofile'] : ['.bashrc', '.profile'];
      for (const profile of profiles) {
        const startup = spawnSync('/bin/sh', ['-c', '. "$PROFILE"; command -v bbx'], {
          env: { ...env, PROFILE: path.join(env.HOME!, profile) },
          encoding: 'utf8',
        });
        assert.equal(startup.status, 0, startup.stderr);
        assert.equal(startup.stdout.trim(), path.join(env.BBX_INSTALL_DIR!, 'bbx'));
      }
    }
  }
);

test(
  'Unix installer puts the standalone CLI ahead of a Volta shim even when its directory is already on PATH',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { directory, env, run } = await zshFixture(t);
    const shimDir = path.join(directory, 'volta shims');
    await fs.mkdir(shimDir);
    await fs.writeFile(path.join(shimDir, 'bbx'), '#!/bin/sh\necho 1.14.2\n', { mode: 0o755 });
    env.PATH = `${shimDir}:${env.HOME}/.local/bin:${env.PATH}`;
    const oldEntry =
      'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac';
    await fs.writeFile(path.join(env.HOME!, '.zshrc'), `${oldEntry}\n`);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /For this terminal, run: export PATH=/);
    for (const profile of ['.zshrc', '.zprofile']) {
      const startup = spawnSync(
        '/bin/sh',
        ['-c', '. "$PROFILE"; . "$PROFILE"; command -v bbx; printf "%s" "$PATH"'],
        { env: { ...env, PROFILE: path.join(env.HOME!, profile) }, encoding: 'utf8' }
      );
      assert.equal(startup.status, 0, startup.stderr);
      assert.equal(
        startup.stdout,
        `${env.HOME}/.local/bin/bbx\n${env.HOME}/.local/bin:${env.PATH}`
      );
    }
  }
);

test(
  'Unix installer quotes custom PATH entries and preserves existing bash login settings',
  { skip: process.platform === 'win32' },
  async (t) => {
    for (const login of ['.bash_profile', '.bash_login', '.profile']) {
      const { directory, env, checksum, run } = await fixture(t);
      env.BBX_INSTALL_DIR = path.join(directory, 'bin with \' "$` characters');
      const profile = path.join(env.HOME!, login);
      await fs.writeFile(profile, 'export EXISTING_SETTING=kept\n');
      await fs.writeFile(env.CHECKSUMS!, `${checksum}  bbx-linux-x64\n`);
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      const startup = spawnSync(
        '/bin/sh',
        ['-c', '. "$PROFILE"; . "$PROFILE"; command -v bbx; printf "%s" "$EXISTING_SETTING"'],
        { env: { ...env, PROFILE: profile }, encoding: 'utf8' }
      );
      assert.equal(startup.status, 0, startup.stderr);
      assert.equal(startup.stdout, `${env.BBX_INSTALL_DIR}/bbx\nkept`);
      if (login !== '.bash_profile')
        await assert.rejects(fs.access(path.join(env.HOME!, '.bash_profile')));
    }
  }
);

test(
  'Unix installer configures POSIX login shells and gives explicit guidance for unsupported shells',
  { skip: process.platform === 'win32' },
  async (t) => {
    for (const shell of ['/bin/sh', '/bin/dash', '/bin/ksh', '/bin/fish', '']) {
      const { env, checksum, run } = await fixture(t);
      env.SHELL = shell;
      await fs.writeFile(env.CHECKSUMS!, `${checksum}  bbx-linux-x64\n`);
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      if (shell === '/bin/fish' || shell === '') {
        assert.match(result.stderr, /not supported for automatic PATH configuration/);
        assert.match(result.stderr, /export PATH=/);
        await assert.rejects(fs.access(path.join(env.HOME!, '.profile')));
      } else {
        assert.match(await fs.readFile(path.join(env.HOME!, '.profile'), 'utf8'), /Browser Bridge/);
      }
    }
  }
);

test(
  'Unix installer reports failure when the zsh PATH cannot be persisted',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { env, run } = await zshFixture(t);
    await fs.mkdir(path.join(env.HOME!, '.zshrc'));
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Warning: could not update .*\.zshrc/);
    assert.match(result.stderr, /Configure PATH manually with: export PATH=/);
    assert.match(await fs.readFile(env.CALLS!, 'utf8'), /restart/);
  }
);

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
  'Unix installer leaves browser selection to shared detection unless explicitly overridden',
  { skip: process.platform === 'win32' },
  async (t) => {
    for (const [browser, extensionId] of [
      ['', ''],
      ['brave', ''],
      ['', 'a'.repeat(32)],
      ['brave', 'a'.repeat(32)],
    ]) {
      const { env, checksum, run } = await fixture(t);
      if (browser) env.BBX_BROWSER = browser;
      else delete env.BBX_BROWSER;
      if (extensionId) env.BBX_EXTENSION_ID = extensionId;
      else delete env.BBX_EXTENSION_ID;
      await fs.writeFile(env.CHECKSUMS!, `${checksum}  bbx-linux-x64\n`);
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      const calls = (await fs.readFile(env.CALLS!, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { args: string[] });
      assert.deepEqual(calls[1].args, [
        'install',
        ...(extensionId ? [extensionId] : []),
        ...(browser ? ['--browser', browser] : []),
      ]);
      const environments = (await fs.readFile(env.CALL_ENV!, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { browser?: string; extensionId?: string });
      assert.deepEqual(environments[0], {
        browser,
        ...(extensionId ? { extensionId } : {}),
      });
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
    assert.doesNotMatch(await fs.readFile(env.CALLS!, 'utf8'), /jjjkmmcdkpcgamlopogicbnnhdgebhie/);
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
  'Unix installer warns about a Volta package without removing it through Volta or npm',
  { skip: process.platform === 'win32' },
  async (t) => {
    for (const npmVisible of [false, true]) {
      const { env, checksum, run } = await fixture(t);
      env.VOLTA_LIST =
        'package @browserbridge/bbx@1.14.2 / bbx, bbx-daemon / node@22.0.0 npm@built-in (default)\n';
      const legacy = path.join(env.NPM_ROOT!, '@browserbridge/bbx');
      if (npmVisible) {
        await fs.mkdir(legacy, { recursive: true });
        await fs.writeFile(path.join(legacy, 'package.json'), '{}');
      }
      await fs.writeFile(env.CHECKSUMS!, `${checksum}  bbx-linux-x64\n`);
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /Volta manages an existing @browserbridge\/bbx/);
      assert.match(result.stderr, /has not been removed and may shadow/);
      assert.match(result.stderr, /volta uninstall @browserbridge\/bbx/);
      assert.match(result.stderr, /new terminal.*bbx --version/);
      assert.equal(
        await fs.readFile(env.VOLTA_CALLS!, 'utf8'),
        '["list","--format","plain","@browserbridge/bbx"]\n'
      );
      await assert.rejects(fs.access(env.NPM_CALLS!));
      if (npmVisible)
        assert.equal(await fs.readFile(path.join(legacy, 'package.json'), 'utf8'), '{}');
      assert.match(await fs.readFile(env.CALLS!, 'utf8'), /restart/);
    }
  }
);

test(
  'Unix installer does not mistake cached or unrelated Volta packages for an installed package',
  { skip: process.platform === 'win32' },
  async (t) => {
    for (const output of [
      '',
      'package @browserbridge/bbx@1.14.2 (fetched)\n',
      'package @browserbridge/bbx-other@1.14.2 / other / node@22.0.0 npm@built-in (default)\n',
    ]) {
      const { env, checksum, run } = await fixture(t);
      env.VOLTA_LIST = output;
      await fs.writeFile(env.CHECKSUMS!, `${checksum}  bbx-linux-x64\n`);
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /Volta/);
      assert.equal(await fs.readFile(env.NPM_CALLS!, 'utf8'), '["root","--global"]\n');
    }
  }
);

test(
  'Unix installer preserves packages and continues when the Volta query fails',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { env, checksum, run } = await fixture(t);
    env.FAIL_VOLTA_LIST = '1';
    const legacy = path.join(env.NPM_ROOT!, '@browserbridge/bbx');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, 'package.json'), '{}');
    await fs.writeFile(env.CHECKSUMS!, `${checksum}  bbx-linux-x64\n`);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /could not inspect Volta packages/);
    assert.match(result.stderr, /Skipping automatic npm removal/);
    assert.match(result.stderr, /volta uninstall @browserbridge\/bbx/);
    await assert.rejects(fs.access(env.NPM_CALLS!));
    assert.equal(await fs.readFile(path.join(legacy, 'package.json'), 'utf8'), '{}');
    assert.match(await fs.readFile(env.CALLS!, 'utf8'), /restart/);
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
    for (const name of ['grep', 'mktemp', 'awk', 'chmod', 'rm', 'sed', 'sha256sum', 'shasum']) {
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
