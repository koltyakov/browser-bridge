import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ensureNative, nativeTargets } from '../../packages/npm/src/runtime.js';

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
        '-gcflags=all=-l',
        '-ldflags',
        `-s -w -X github.com/koltyakov/browser-bridge/internal/bridge.buildTarget=${goTarget}`,
        '-o',
        native,
        './cmd/bbx',
      ],
      { cwd: root, env: { ...process.env, CGO_ENABLED: '0' } }
    );
    const bytes = await fs.readFile(native);
    await fs.writeFile(
      path.join(source, 'packages/npm/native-manifest.json'),
      JSON.stringify({
        version: pkg.version,
        artifacts: {
          [target]: {
            asset: nativeTargets[target],
            sha256: createHash('sha256').update(bytes).digest('hex'),
            bytes: bytes.length,
          },
        },
      })
    );
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
    const cached = await ensureNative({
      root: source,
      env,
      fetchFn: async (url) => {
        downloads++;
        assert.equal(
          String(url),
          `https://github.com/koltyakov/browser-bridge/releases/download/v${pkg.version}/${nativeTargets[target]}`
        );
        return new Response(bytes);
      },
    });
    assert.equal(downloads, 1);
    assert(!cached.includes('node_modules'));
    const npm = process.env.npm_execpath;
    const npmRun = (args: string[], cwd: string) =>
      exec(npm ? process.execPath : 'npm', npm ? [npm, ...args] : args, {
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
    const cli = (...args: string[]) =>
      exec(process.execPath, [bin('bbx'), ...args], { cwd: project, env, timeout: 15_000 });
    assert.equal((await cli('--version')).stdout.trim(), pkg.version);
    assert.equal(JSON.parse((await cli('update', 'status')).stdout).distribution, 'npm');
    await assert.rejects(
      cli('unknown-command'),
      (error: unknown) =>
        typeof error === 'object' && error !== null && 'code' in error && error.code === 1
    );
    const mcp = exec(process.execPath, [bin('bbx-mcp')], { env, cwd: project, timeout: 15_000 });
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
    assert.equal(initialized.result.serverInfo.version, pkg.version);
    await assert.rejects(
      exec(process.execPath, [bin('bbx-install'), '--browser', 'invalid'], { env, cwd: project }),
      /unsupported browser/
    );
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
    }
    const daemon = spawn(process.execPath, [bin('bbx-daemon')], {
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
  }
);
