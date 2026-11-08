import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { resolveNative, nativeTargets } from '../../packages/npm/src/runtime.js';
import { resolveNpmCli } from '../_helpers/npmCli.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const goAvailable = await exec('go', ['version']).then(
  () => true,
  () => false
);

async function port(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitForDaemon(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Wrapped daemon did not start');
}

function benchmarkLaunchers(
  t: TestContext,
  native: string,
  wrapper: string,
  installed: string,
  env: NodeJS.ProcessEnv
) {
  if (process.env.BBX_BENCH_NPM !== '1') return;
  const cases = [
    { name: 'direct Go', command: native, args: ['--version'] },
    { name: 'Node wrapper', command: process.execPath, args: [wrapper, '--version'] },
    {
      name: 'npm entry',
      command: process.platform === 'win32' ? process.execPath : installed,
      args: process.platform === 'win32' ? [wrapper, '--version'] : ['--version'],
    },
  ];
  const samples = cases.map(() => [] as number[]);
  for (let iteration = 0; iteration < 24; iteration++) {
    for (const [index, entry] of cases.entries()) {
      const start = performance.now();
      const result = spawnSync(entry.command, entry.args, { env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      if (iteration >= 3) samples[index].push(performance.now() - start);
    }
  }
  t.diagnostic(`npm launch benchmark: ${process.platform}-${process.arch}, ${process.version}`);
  for (const [index, entry] of cases.entries()) {
    const times = samples[index].sort((a, b) => a - b);
    t.diagnostic(
      `${entry.name}: min=${times[0].toFixed(1)} median=${times[10].toFixed(1)} max=${times[20].toFixed(1)} ms`
    );
  }
}

test(
  'packed npm module installs offline from verified cache and delegates setup, CLI, daemon, and MCP to Go',
  { skip: !goAvailable, timeout: 120_000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-npm-packed-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const source = path.join(directory, 'package');
    const project = path.join(directory, 'project');
    const home = path.join(directory, 'home');
    await Promise.all([source, project, home].map((item) => fs.mkdir(item)));
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as {
      version: string;
      dependencies?: Record<string, string>;
      files: string[];
      bin: Record<string, string>;
    };
    pkg.version = '0.0.1';
    assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify(pkg));
    await fs.cp(path.join(root, 'packages/npm/bin'), path.join(source, 'packages/npm/bin'), {
      recursive: true,
    });
    await fs.cp(path.join(root, 'packages/npm/src'), path.join(source, 'packages/npm/src'), {
      recursive: true,
    });
    const target = `${process.platform}-${process.arch}`;
    const native = path.join(directory, process.platform === 'win32' ? 'built.exe' : 'built');
    const goTarget = `go-${target.replace('win32', 'windows').replace('x64', 'amd64')}`;
    await exec(
      'go',
      [
        'build',
        '-trimpath',
        '-buildvcs=false',
        '-tags=nethttpomithttp2,purego',
        '-gcflags=all=-l',
        '-ldflags',
        `-s -w -funcalign=8 -X github.com/koltyakov/browser-bridge/internal/bridge.buildTarget=${goTarget}`,
        '-o',
        native,
        './cmd/bbx',
      ],
      { cwd: root, env: { ...process.env, CGO_ENABLED: '0' } }
    );
    const bytes = await fs.readFile(native);
    const nativeVersion = (await exec(native, ['--version'])).stdout.trim();
    const tcpPort = await port();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'roaming'),
      LOCALAPPDATA: path.join(home, 'local'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      BROWSER_BRIDGE_HOME: path.join(home, 'runtime'),
      BBX_TCP_HOST: '127.0.0.1',
      BBX_TCP_BIND_HOST: '127.0.0.1',
      BBX_TCP_PORT: String(tcpPort),
      BBX_AUTO_UPDATE: 'compatible',
      BBX_REMOTE: '',
      BBX_POSTINSTALL_FORCE: '0',
      npm_config_global: 'false',
    };
    let downloads = 0;
    const { binary: cached } = await resolveNative({
      root: source,
      env,
      fetchFn: async (url) => {
        if (String(url).startsWith('https://api.github.com/'))
          return Response.json({
            tag_name: `v${nativeVersion}`,
            draft: false,
            prerelease: false,
            assets: [{ name: nativeTargets[target], size: bytes.length }],
          });
        if (String(url).endsWith('/checksums.txt'))
          return new Response(
            `${createHash('sha256').update(bytes).digest('hex')}  ${nativeTargets[target]}\n`
          );
        downloads++;
        assert.equal(
          String(url),
          `https://github.com/koltyakov/browser-bridge/releases/download/v${nativeVersion}/${nativeTargets[target]}`
        );
        return new Response(bytes);
      },
    });
    assert.equal(downloads, 1);
    assert(!cached.includes('node_modules'));
    // Match a direct make invocation even when this test's parent was npm or Bun.
    delete env.npm_execpath;
    const npm = resolveNpmCli({ env });
    const npmRun = (args: string[], cwd: string) =>
      exec(process.execPath, [npm, ...args], {
        cwd,
        env,
        timeout: 30_000,
      });
    const packed = JSON.parse(
      (await npmRun(['pack', '--ignore-scripts', '--json'], source)).stdout
    ) as { filename: string; unpackedSize: number; files: { path: string }[] }[];
    assert(packed[0].unpackedSize < 100_000);
    assert(
      packed[0].files.every(
        ({ path: filename }) => filename === 'package.json' || filename.startsWith('packages/npm/')
      )
    );
    const tarball = path.join(source, packed[0].filename);
    await npmRun(
      ['install', '--offline', '--no-audit', '--no-fund', '--package-lock=false', tarball],
      project
    );
    const installed = path.join(project, 'node_modules/@browserbridge/bbx');
    const bin = (name: string) => path.join(installed, pkg.bin[name]);
    const entry = (name: string) =>
      process.platform === 'win32'
        ? { command: process.execPath, args: [bin(name)] }
        : { command: path.join(project, 'node_modules/.bin', name), args: [] };
    const runEntry = (name: string, args: string[]) => {
      const command = entry(name);
      return exec(command.command, [...command.args, ...args], {
        cwd: project,
        env,
        timeout: 15_000,
      });
    };
    const cli = (...args: string[]) => runEntry('bbx', args);
    assert.equal((await cli('--version')).stdout.trim(), nativeVersion);
    assert.equal(JSON.parse((await cli('update', 'status')).stdout).distribution, 'npm');
    assert.equal(
      JSON.parse((await exec(process.execPath, [bin('bbx'), 'update', 'status'], { env })).stdout)
        .distribution,
      'npm'
    );
    benchmarkLaunchers(t, cached, bin('bbx'), path.join(project, 'node_modules/.bin/bbx'), {
      ...env,
      BBX_NPM_VERSION: nativeVersion,
    });
    await assert.rejects(
      cli('unknown-command'),
      (error: unknown) =>
        typeof error === 'object' && error !== null && 'code' in error && error.code === 1
    );
    const mcp = runEntry('bbx-mcp', []);
    mcp.child.stdin?.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'npm-wrapper-test', version: '1' },
        },
      }) + '\n'
    );
    const initialized = JSON.parse((await mcp).stdout) as {
      result: { serverInfo: { version: string } };
    };
    assert.equal(initialized.result.serverInfo.version, nativeVersion);
    await assert.rejects(runEntry('bbx-install', ['--browser', 'invalid']), /unsupported browser/);
    if (process.platform !== 'win32') {
      // Real global initialization is isolated by HOME. Windows registration is
      // covered by fixtures rather than writing the developer's HKCU registry.
      const prefix = path.join(directory, 'global');
      await npmRun(
        [
          'install',
          '--global',
          '--prefix',
          prefix,
          '--offline',
          '--no-audit',
          '--no-fund',
          tarball,
        ],
        project
      );
      const launcher = await fs.readFile(
        path.join(home, 'runtime/native-host-launcher.sh'),
        'utf8'
      );
      assert(launcher.includes(cached));
      assert(launcher.includes('BBX_NPM_VERSION'));
      assert(!launcher.includes(process.execPath));
      const globalEntry = path.join(prefix, 'bin/bbx');
      assert((await fs.readlink(globalEntry)).endsWith('/.native/bbx'));
      assert.equal(
        JSON.parse((await exec(globalEntry, ['update', 'status'], { env })).stdout).distribution,
        'npm'
      );
      await npmRun(
        ['uninstall', '--global', '--prefix', prefix, '--offline', '@browserbridge/bbx'],
        project
      );
      await assert.rejects(fs.lstat(globalEntry), { code: 'ENOENT' });
    }
    const daemonEntry = entry('bbx-daemon');
    const daemon = spawn(daemonEntry.command, daemonEntry.args, {
      env,
      cwd: project,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(daemon, 'exit');
    t.after(() => {
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGTERM');
    });
    await waitForDaemon(tcpPort);
    assert.equal(JSON.parse((await cli('call', 'health.ping')).stdout).daemon, 'ok');
    daemon.kill('SIGTERM');
    await exited;
    if (process.platform !== 'win32') {
      assert((await fs.readlink(entry('bbx').command)).endsWith('/.native/bbx'));
      await npmRun(['rebuild', '--offline'], project);
      assert.equal((await cli('--version')).stdout.trim(), nativeVersion);
      assert.equal((await fs.stat(cached)).size, bytes.length);
    }
    try {
      await fs.writeFile(cached, Buffer.alloc(bytes.length));
      await assert.rejects(cli('--version'), /failed verification/);
      await assert.rejects(
        exec(process.execPath, [bin('bbx'), '--version'], { env }),
        /failed verification/
      );
    } finally {
      await fs.writeFile(cached, bytes);
    }
    if (process.platform !== 'win32') {
      const mockFetch = path.join(directory, 'fetch-release.mjs');
      const fetched = path.join(directory, 'fetch-url');
      const expected = `https://github.com/koltyakov/browser-bridge/releases/download/v${nativeVersion}/${nativeTargets[target]}`;
      await fs.writeFile(
        mockFetch,
        `import fs from 'node:fs/promises';
globalThis.fetch = async (url) => {
  if (String(url) !== ${JSON.stringify(expected)}) throw new Error('Unexpected download URL');
  await fs.writeFile(${JSON.stringify(fetched)}, String(url));
  return new Response(await fs.readFile(${JSON.stringify(native)}));
};\n`
      );
      await fs.unlink(cached);
      const restored = await exec(entry('bbx').command, ['--version'], {
        env: {
          ...env,
          NODE_OPTIONS: `${env.NODE_OPTIONS || ''} --import=${pathToFileURL(mockFetch).href}`,
        },
        timeout: 15_000,
      });
      assert.equal(restored.stdout.trim(), nativeVersion);
      assert.equal(await fs.readFile(fetched, 'utf8'), expected);
      assert.deepEqual(await fs.readFile(cached), bytes);
    }
    const noScripts = path.join(directory, 'no-scripts');
    await fs.mkdir(noScripts);
    await npmRun(
      ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', tarball],
      noScripts
    );
    const fallback = path.join(noScripts, 'node_modules/@browserbridge/bbx', pkg.bin.bbx);
    assert.equal(
      (await exec(process.execPath, [fallback, '--version'], { env })).stdout.trim(),
      nativeVersion
    );
  }
);
