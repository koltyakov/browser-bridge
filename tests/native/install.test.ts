import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const available =
  Boolean(process.env.BBX_NATIVE_EXECUTABLE) || spawnSync('go', ['version']).status === 0;

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

async function diskBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    bytes += entry.isDirectory() ? await diskBytes(filename) : (await fs.stat(filename)).size;
  }
  return bytes;
}

test(
  'packaged Go runtime installs agents without Node and stays within the fresh-install budget',
  { skip: !available, timeout: 120_000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-native-install-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const home = path.join(directory, 'home');
    const project = path.join(directory, 'project');
    const emptyPath = path.join(directory, 'empty-path');
    await Promise.all([home, project, emptyPath].map((item) => fs.mkdir(item)));
    const executable = path.join(directory, process.platform === 'win32' ? 'bbx.exe' : 'bbx');
    if (process.env.BBX_NATIVE_EXECUTABLE) {
      await fs.copyFile(process.env.BBX_NATIVE_EXECUTABLE, executable);
      await fs.chmod(executable, 0o755);
    } else {
      // Checked-in generated files make this a plain Go build, with no codegen.
      await exec(
        'go',
        [
          'build',
          '-trimpath',
          '-buildvcs=false',
          '-tags=nethttpomithttp2',
          '-gcflags=all=-l',
          '-ldflags',
          '-s -w',
          '-o',
          executable,
          './cmd/bbx',
        ],
        { cwd: root, env: { ...process.env, CGO_ENABLED: '0' } }
      );
    }
    const env = {
      ...process.env,
      PATH: emptyPath,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      CODEX_HOME: '',
      GEMINI_CLI_HOME: '',
      CLINE_DIR: '',
      CLINE_DATA_DIR: '',
      CLINE_MCP_SETTINGS_PATH: '',
      AMP_HOME: '',
      FLATPAK_XDG_CONFIG_HOME: '',
      PI_CODING_AGENT_DIR: '',
      QWEN_HOME: '',
      GOOSE_PATH_ROOT: '',
      GOOSE_BIN_DIR: '',
      OPENHANDS_PERSISTENCE_DIR: '',
      MUSE_INSTALL_DIR: '',
      GROK_HOME: '',
      GROK_BIN_DIR: '',
      BROWSER_BRIDGE_HOME: path.join(home, 'runtime'),
      BBX_TCP_HOST: '127.0.0.1',
      BBX_TCP_BIND_HOST: '127.0.0.1',
      BBX_TCP_PORT: String(await reservePort()),
      BBX_REMOTE: '',
      BBX_AUTO_UPDATE: 'off',
    };
    const run = (...args: string[]) =>
      exec(executable, args, { cwd: project, env, timeout: 30_000 });
    assert.equal(spawnSync('node', ['--version'], { env }).error?.message.includes('ENOENT'), true);
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as {
      version: string;
    };
    assert.equal((await run('--version')).stdout.trim(), pkg.version);
    // Windows native-host registration writes HKCU, so its real registry is not
    // modified by this isolated test. Platform registration has Go fixture tests.
    if (process.platform !== 'win32') await run('install', '--all');
    await run('install-mcp', 'codex');
    await run('install-skill', 'codex', '--global');
    const installedBytes = await diskBytes(directory);
    assert(
      installedBytes < 10_000_000,
      `Fresh runtime plus agent setup uses ${installedBytes} bytes`
    );
    t.diagnostic(
      `Fresh runtime plus one agent: ${installedBytes} bytes; executable: ${(await fs.stat(executable)).size} bytes`
    );
    await run('install-mcp', 'all');
    await run('install-skill', 'all', '--global');
    const zedSettings =
      process.platform === 'win32'
        ? path.join(home, 'AppData', 'Roaming', 'Zed', 'settings.json')
        : path.join(home, '.config', 'zed', 'settings.json');
    const newClients = [
      [path.join(home, '.gemini', 'settings.json'), 'mcpServers'],
      [path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'), 'mcpServers'],
      [zedSettings, 'context_servers'],
      [path.join(home, '.config', 'amp', 'settings.json'), 'amp.mcpServers'],
      [path.join(home, '.factory', 'mcp.json'), 'mcpServers'],
      [path.join(home, '.pi', 'agent', 'mcp.json'), 'mcpServers'],
      [path.join(home, '.qwen', 'settings.json'), 'mcpServers'],
      [path.join(home, '.openhands', 'mcp.json'), 'mcpServers'],
      [path.join(home, '.config', 'muse', 'settings.json'), 'mcp_servers'],
    ] as const;
    for (const [filename, key] of newClients) {
      const config = JSON.parse(await fs.readFile(filename, 'utf8')) as Record<
        string,
        Record<string, { command: unknown; args: unknown }>
      >;
      assert.equal(config[key]['browser-bridge'].command, 'bbx');
      assert.deepEqual(config[key]['browser-bridge'].args, ['mcp', 'serve']);
    }
    const kilo = JSON.parse(
      await fs.readFile(path.join(home, '.config', 'kilo', 'kilo.jsonc'), 'utf8')
    ) as { mcp: Record<string, { type: string; command: string[] }> };
    assert.equal(kilo.mcp['browser-bridge'].type, 'local');
    assert.deepEqual(kilo.mcp['browser-bridge'].command, ['bbx', 'mcp', 'serve']);
    const gooseConfig =
      process.platform === 'win32'
        ? path.join(home, 'AppData', 'Roaming', 'Block', 'goose', 'config', 'config.yaml')
        : path.join(home, '.config', 'goose', 'config.yaml');
    assert.match(await fs.readFile(gooseConfig, 'utf8'), /cmd: bbx/u);
    assert.match(
      await fs.readFile(path.join(home, '.grok', 'config.toml'), 'utf8'),
      /command = "bbx"/u
    );
    await run('install-mcp', 'all', '--local');
    await run(
      'install-skill',
      'gemini,cline,zed,amp,droid,pi,kilo,qwen,goose,openhands,muse,grok',
      '--local'
    );
    for (const target of ['cline', 'goose', 'openhands', 'muse']) {
      await assert.rejects(run('install-mcp', target, '--local'), /user-scope MCP only/u);
    }
    for (const root of [
      '.gemini',
      '.cline',
      '.agents',
      '.factory',
      '.pi',
      '.kilo',
      '.qwen',
      '.grok',
    ]) {
      assert.match(
        await fs.readFile(path.join(project, root, 'skills', 'browser-bridge', 'SKILL.md'), 'utf8'),
        /Browser Bridge/u
      );
    }
    t.diagnostic(`All-agent setup: ${await diskBytes(directory)} bytes`);
    assert(
      (
        await fs.readFile(path.join(home, '.codex', 'skills', 'browser-bridge', 'SKILL.md'), 'utf8')
      ).includes('Browser Bridge')
    );
    assert.equal(JSON.parse((await run('update', 'status')).stdout).runtime, 'go');
    if (process.platform !== 'win32') await run('uninstall');
  }
);
