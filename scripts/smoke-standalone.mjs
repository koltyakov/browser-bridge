// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const executable = path.resolve(process.argv[2] || 'dist/standalone/bbx-darwin-arm64');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-smoke-'));
const home = path.join(temporary, 'user home');
const bridgeHome = path.join(home, 'bridge');
/** @type {NodeJS.ProcessEnv} */
const env = {
  ...process.env,
  HOME: home,
  ZDOTDIR: home,
  USERPROFILE: home,
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  BROWSER_BRIDGE_HOME: bridgeHome,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  CODEX_HOME: path.join(home, '.codex'),
  BBX_AUTO_UPDATE: 'off',
  BBX_NO_PATH: process.platform === 'win32' ? '1' : '0',
  PATH: process.platform === 'win32' ? `${process.env.SystemRoot}\\System32` : '/usr/bin:/bin',
};
delete env.npm_execpath;
delete env.npm_command;
delete env.BBX_TCP_PORT;
delete env.BBX_REMOTE;
const registryKey =
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.browserbridge.browser_bridge';
/** @type {string | null} */
let oldRegistryValue = null;
if (process.platform === 'win32') {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', () => resolve(undefined)));
  env.BBX_TCP_PORT = String(/** @type {net.AddressInfo} */ (listener.address()).port);
  await new Promise((resolve) => listener.close(resolve));
  try {
    const result = await execFileAsync('reg.exe', ['query', registryKey, '/ve']);
    oldRegistryValue = /REG_SZ\s+(.+)/.exec(result.stdout)?.[1].trim() ?? null;
  } catch {
    /* No existing registration. */
  }
}
/** @param {string} file @param {string[]} args */
const run = (file, args) =>
  execFileAsync(file, args, { env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
/** @type {import('node:child_process').ChildProcess | undefined} */
let daemon;
try {
  await fs.mkdir(path.join(home, '.cursor'), { recursive: true });
  const oldConfig =
    '// keep this comment\n{"mcpServers":{"browser-bridge":{"command":"bbx","args":["mcp","serve"],"env":{"CUSTOM":"kept"},"disabled":true},"other":{"command":"other"}}}\n';
  await fs.writeFile(path.join(home, '.cursor', 'mcp.json'), oldConfig);
  const { stdout } = await run(executable, ['--self-test']);
  const version = JSON.parse(stdout).version;
  await run(executable, ['setup']);
  const launcher = path.join(
    bridgeHome,
    'companion',
    process.platform === 'win32' ? 'bbx.exe' : 'bbx'
  );
  assert.equal((await run(launcher, ['--version'])).stdout.trim(), version);
  if (process.platform !== 'win32') {
    assert.equal(
      (await run('/bin/sh', ['-c', '. "$HOME/.profile"; bbx --version'])).stdout.trim(),
      version
    );
  }
  const migratedRaw = await fs.readFile(path.join(home, '.cursor', 'mcp.json'), 'utf8');
  assert.ok(migratedRaw.startsWith('// keep this comment'));
  const migrated = JSON.parse(migratedRaw.slice(migratedRaw.indexOf('{')));
  assert.equal(migrated.mcpServers['browser-bridge'].command, launcher);
  assert.deepEqual(migrated.mcpServers['browser-bridge'].env, { CUSTOM: 'kept' });
  assert.equal(migrated.mcpServers['browser-bridge'].disabled, true);
  assert.equal(migrated.mcpServers.other.command, 'other');
  await run(launcher, ['setup']);
  assert.equal(await fs.readFile(path.join(home, '.cursor', 'mcp.json'), 'utf8'), migratedRaw);
  await run(launcher, ['install-skill', 'agents', '--global']);
  await run(launcher, ['install-mcp', 'agents']);
  const mcp = spawn(launcher, ['mcp', 'serve'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const initialized = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      mcp.kill();
      reject(new Error('Compiled MCP initialization timed out'));
    }, 10_000);
    mcp.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (!output.includes('\n')) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(output.split('\n')[0]));
      } catch (error) {
        reject(error);
      }
      mcp.kill();
    });
    mcp.once('error', reject);
  });
  mcp.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'standalone-smoke', version: '1.0.0' } } })}\n`
  );
  const initialization = /** @type {{ result: { serverInfo: { version: string } } }} */ (
    await initialized
  );
  assert.equal(initialization.result.serverInfo.version, version);
  // Use an isolated TCP port on Windows; never stop the user's own listener.
  daemon = spawn(launcher, ['--bridge-daemon'], { env, stdio: 'ignore' });
  let healthy = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const result = await run(launcher, ['call', 'health.ping', '{}']);
      assert.ok(result.stdout.includes('daemon'));
      healthy = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(healthy, 'compiled daemon responds to compiled client');
  // Verify native messaging is binary-clean and does not print CLI help.
  const native = spawn(launcher, ['chrome-extension://jjjkmmcdkpcgamlopogicbnnhdgebhie/'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const request = Buffer.from(
    JSON.stringify({ type: 'host.setup_status.request', requestId: 'smoke' })
  );
  const header = Buffer.alloc(4);
  header.writeUInt32LE(request.length);
  native.stdin.write(Buffer.concat([header, request]));
  const nativeOutput = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      native.kill();
      reject(new Error('Native messaging handshake timed out'));
    }, 10_000);
    native.stdout.once('data', (chunk) => {
      clearTimeout(timer);
      resolve(chunk);
      native.kill();
    });
    native.once('error', reject);
  });
  assert.ok(Buffer.isBuffer(nativeOutput));
  assert.ok(nativeOutput.readUInt32LE(0) > 0);
  assert.equal(nativeOutput[4], '{'.charCodeAt(0));
  console.log(
    'Standalone smoke passed: setup, migration, repair, embedded skills, MCP, daemon, CLI and native messaging.'
  );
} finally {
  if (process.platform === 'win32') {
    if (oldRegistryValue)
      await execFileAsync('reg.exe', [
        'add',
        registryKey,
        '/ve',
        '/t',
        'REG_SZ',
        '/d',
        oldRegistryValue,
        '/f',
      ]);
    else await execFileAsync('reg.exe', ['delete', registryKey, '/f']).catch(() => {});
  }
  if (daemon) {
    const pidFile = path.join(bridgeHome, 'daemon.pid');
    try {
      process.kill(Number((await fs.readFile(pidFile, 'utf8')).trim()), 'SIGTERM');
    } catch {
      /* Already stopped. */
    }
    daemon.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
