import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MCP_CLIENT_NAMES,
  buildMcpConfig,
  findConfiguredMcpClients,
  formatMcpConfig,
  getMcpConfigPath,
  getMcpConfigPaths,
  getMcpConfigShape,
  getMcpConfigShapeForPath,
  installMcpConfig,
  isMcpClientName,
  parseInstalledMcpConfig,
  removeMcpConfig,
} from '../src/mcp-config.js';
import type { McpClientName } from '../src/mcp-config.js';

const expectedMcpCommand = 'bbx';
const expectedMcpArgs = ['mcp', 'serve'];
const expectedOpencodeCommand = ['bbx', 'mcp', 'serve'];

test('isMcpClientName accepts supported clients only', () => {
  for (const clientName of MCP_CLIENT_NAMES) {
    assert.equal(isMcpClientName(clientName), true);
  }

  assert.equal(isMcpClientName('browser-bridge'), false);
  assert.equal(isMcpClientName(''), false);
});

test('getMcpConfigShape returns client-specific config metadata', () => {
  assert.deepEqual(getMcpConfigShape('codex'), {
    key: 'mcp_servers',
    includeType: false,
  });
  assert.deepEqual(getMcpConfigShape('opencode'), {
    key: 'mcp',
    includeType: false,
  });
  assert.deepEqual(getMcpConfigShape('agents'), {
    key: 'mcpServers',
    includeType: true,
  });
  assert.deepEqual(getMcpConfigShape('copilot'), {
    key: 'mcpServers',
    includeType: true,
    keepEmptyBlock: true,
  });
  assert.deepEqual(getMcpConfigShape('unsupported' as McpClientName), {
    key: 'mcpServers',
    includeType: false,
  });
});

test('getMcpConfigShapeForPath selects Copilot schema by destination', () => {
  const home = os.homedir();
  assert.equal(
    getMcpConfigShapeForPath('copilot', path.join(home, '.copilot', 'mcp-config.json')).key,
    'mcpServers'
  );
  assert.equal(
    getMcpConfigShapeForPath('copilot', path.join(home, '.vscode', 'mcp.json')).key,
    'servers'
  );
});

test('buildMcpConfig emits each client family in its expected shape', () => {
  assert.deepEqual(buildMcpConfig('codex'), {
    mcp_servers: {
      'browser-bridge': {
        command: expectedMcpCommand,
        args: expectedMcpArgs,
      },
    },
  });

  assert.deepEqual(buildMcpConfig('cursor'), {
    mcpServers: {
      'browser-bridge': {
        command: expectedMcpCommand,
        args: expectedMcpArgs,
        env: {},
      },
    },
  });

  assert.deepEqual(buildMcpConfig('agents'), {
    mcpServers: {
      'browser-bridge': {
        type: 'stdio',
        command: expectedMcpCommand,
        args: expectedMcpArgs,
        env: {},
      },
    },
  });

  assert.deepEqual(buildMcpConfig('opencode'), {
    mcp: {
      'browser-bridge': {
        type: 'local',
        command: expectedOpencodeCommand,
      },
    },
  });
});

test('formatMcpConfig returns TOML for Codex and JSON for JSON-backed clients', () => {
  assert.equal(
    formatMcpConfig('codex'),
    [
      '[mcp_servers."browser-bridge"]',
      `command = ${JSON.stringify(expectedMcpCommand)}`,
      `args = ${JSON.stringify(expectedMcpArgs)}`,
      '',
    ].join('\n')
  );

  assert.equal(formatMcpConfig('cursor'), `${JSON.stringify(buildMcpConfig('cursor'), null, 2)}\n`);
});

test('getMcpConfigPath resolves documented local config locations', () => {
  const cwd = path.join(path.sep, 'tmp', 'browser-bridge-project');

  assert.equal(
    getMcpConfigPath('copilot', { global: false, cwd }),
    path.join(cwd, '.vscode', 'mcp.json')
  );
  assert.equal(
    getMcpConfigPath('codex', { global: false, cwd }),
    path.join(cwd, '.codex', 'config.toml')
  );
  assert.equal(
    getMcpConfigPath('cursor', { global: false, cwd }),
    path.join(cwd, '.cursor', 'mcp.json')
  );
  assert.equal(
    getMcpConfigPath('windsurf', { global: false, cwd }),
    path.join(cwd, '.windsurf', 'mcp_config.json')
  );
  assert.equal(getMcpConfigPath('claude', { global: false, cwd }), path.join(cwd, '.mcp.json'));
  assert.equal(
    getMcpConfigPath('opencode', { global: false, cwd }),
    path.join(cwd, 'opencode.json')
  );
  assert.equal(
    getMcpConfigPath('antigravity', { global: false, cwd }),
    path.join(cwd, '.agents', 'mcp_config.json')
  );
  assert.equal(
    getMcpConfigPath('agents', { global: false, cwd }),
    path.join(cwd, '.agents', 'mcp.json')
  );
});

test('getMcpConfigPath resolves global config locations and honors CODEX_HOME', () => {
  const home = os.homedir();
  const originalCodexHome = process.env.CODEX_HOME;
  const testCodexHome = path.join(path.sep, 'tmp', 'codex-home');

  try {
    process.env.CODEX_HOME = testCodexHome;

    assert.equal(getMcpConfigPath('claude', { global: true }), path.join(home, '.claude.json'));
    assert.equal(
      getMcpConfigPath('copilot', { global: true }),
      path.join(home, '.copilot', 'mcp-config.json')
    );
    assert.equal(
      getMcpConfigPath('codex', { global: true }),
      path.join(testCodexHome, 'config.toml')
    );
    assert.equal(
      getMcpConfigPath('opencode', { global: true }),
      path.join(home, '.config', 'opencode', 'opencode.json')
    );
    assert.equal(
      getMcpConfigPath('antigravity', { global: true }),
      path.join(home, '.gemini', 'antigravity', 'mcp_config.json')
    );
    assert.equal(
      getMcpConfigPath('agents', { global: true }),
      path.join(home, '.agents', 'mcp.json')
    );
  } finally {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
  }
});

test('getMcpConfigPaths expands Copilot global config to legacy and profile files', async () => {
  const home = os.homedir();
  const userDir =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User')
      : process.platform === 'linux'
        ? path.join(home, '.config', 'Code', 'User')
        : path.join(home, 'Library', 'Application Support', 'Code', 'User');

  const configPaths = await getMcpConfigPaths('copilot', {
    global: true,
    readdir: (async () =>
      [
        { name: 'profile-a', isDirectory: () => true },
        { name: 'notes.txt', isDirectory: () => false },
        { name: 'profile-b', isDirectory: () => true },
      ] as Dirent[]) as unknown as typeof fs.promises.readdir,
  });

  assert.deepEqual(configPaths, [
    path.join(home, '.copilot', 'mcp-config.json'),
    path.join(userDir, 'mcp.json'),
    path.join(userDir, 'profiles', 'profile-a', 'mcp.json'),
    path.join(userDir, 'profiles', 'profile-b', 'mcp.json'),
  ]);
});

test('getMcpConfigPaths falls back to the primary path when profile discovery fails', async () => {
  const configPaths = await getMcpConfigPaths('copilot', {
    global: true,
    readdir: async () => {
      throw new Error('permission denied');
    },
  });

  assert.equal(configPaths.length, 2);
  assert.equal(configPaths[0], getMcpConfigPath('copilot', { global: true }));
  assert.match(configPaths[1], /mcp\.json$/);
});

test('parseInstalledMcpConfig accepts legacy Copilot keys and Codex table variants', () => {
  assert.deepEqual(
    parseInstalledMcpConfig(
      'copilot',
      JSON.stringify({
        servers: {
          'browser-bridge': {
            command: 'bbx',
          },
        },
      })
    ),
    { configured: true }
  );

  assert.deepEqual(
    parseInstalledMcpConfig(
      'codex',
      ['[mcp_servers.browser-bridge]', 'command = "bbx"', 'args = ["mcp", "serve"]'].join('\n')
    ),
    { configured: true }
  );

  assert.deepEqual(parseInstalledMcpConfig('cursor', '{not valid json'), { configured: false });
});

test('parseInstalledMcpConfig detects only the Copilot key valid for the destination', () => {
  const standalonePath = path.join(os.homedir(), '.copilot', 'mcp-config.json');
  const workspacePath = path.join(os.homedir(), 'project', '.vscode', 'mcp.json');
  const raw = JSON.stringify({
    mcpServers: { 'browser-bridge': { command: 'bbx' } },
    servers: {},
  });

  assert.equal(parseInstalledMcpConfig('copilot', raw, standalonePath).configured, true);
  assert.equal(parseInstalledMcpConfig('copilot', raw, workspacePath).configured, false);
});

test('findConfiguredMcpClients uses the path-specific Copilot key', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-detect-copilot-mcp-'));
  const configPath = path.join(tempDir, '.vscode', 'mcp.json');
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });

  try {
    await fs.promises.writeFile(
      configPath,
      JSON.stringify({ mcpServers: { 'browser-bridge': { command: 'bbx' } } }),
      'utf8'
    );
    assert.deepEqual(
      await findConfiguredMcpClients({ clients: ['copilot'], global: false, cwd: tempDir }),
      []
    );

    await fs.promises.writeFile(
      configPath,
      JSON.stringify({ servers: { 'browser-bridge': { command: 'bbx' } } }),
      'utf8'
    );
    assert.deepEqual(
      await findConfiguredMcpClients({ clients: ['copilot'], global: false, cwd: tempDir }),
      ['copilot']
    );
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('removeMcpConfig removes Copilot from the path-specific block without migrating keys', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-remove-copilot-mcp-'));
  const configPath = path.join(tempDir, '.vscode', 'mcp.json');
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(
    configPath,
    `${JSON.stringify(
      {
        servers: {
          'browser-bridge': {
            type: 'stdio',
            command: 'bbx',
            args: ['mcp', 'serve'],
          },
        },
        mcpServers: {
          unrelated: { command: 'other' },
        },
        theme: 'dark',
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  try {
    const removed = await removeMcpConfig('copilot', {
      global: false,
      cwd: tempDir,
      stdout: {
        write() {
          return true;
        },
      },
    });

    const updated = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
    assert.deepEqual(removed, [configPath]);
    assert.equal(updated.theme, 'dark');
    assert.deepEqual(updated.servers, {});
    assert.deepEqual(updated.mcpServers, { unrelated: { command: 'other' } });
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('installMcpConfig preserves unrelated Copilot blocks instead of migrating them', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-install-copilot-mcp-'));
  const configPath = path.join(tempDir, '.vscode', 'mcp.json');
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(
    configPath,
    `${JSON.stringify({ mcpServers: { existing: { command: 'other' } }, theme: 'dark' }, null, 2)}\n`,
    'utf8'
  );

  try {
    await installMcpConfig('copilot', {
      global: false,
      cwd: tempDir,
      stdout: { write: () => true },
    });

    const updated = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
    assert.deepEqual(updated.mcpServers, { existing: { command: 'other' } });
    assert.equal(updated.servers['browser-bridge'].command, expectedMcpCommand);
    assert.equal(updated.theme, 'dark');
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('removeMcpConfig leaves unrelated client entries intact when browser-bridge is absent', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-remove-unrelated-mcp-'));
  const configPath = path.join(tempDir, '.cursor', 'mcp.json');
  const originalConfig = {
    mcpServers: {
      'other-server': {
        command: 'node',
        args: ['server.js'],
      },
    },
    theme: 'dark',
  };
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(configPath, `${JSON.stringify(originalConfig, null, 2)}\n`, 'utf8');

  try {
    const removed = await removeMcpConfig('cursor', {
      global: false,
      cwd: tempDir,
      stdout: {
        write() {
          return true;
        },
      },
    });

    const updated = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
    assert.deepEqual(removed, []);
    assert.deepEqual(updated, originalConfig);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('MCP config writes preserve existing modes and leave no sibling temp files', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-atomic-mcp-'));
  const configPath = path.join(tempDir, '.cursor', 'mcp.json');
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(configPath, '{}\n', { mode: 0o640 });

  try {
    await installMcpConfig('cursor', {
      global: false,
      cwd: tempDir,
      stdout: { write: () => true },
    });
    if (process.platform !== 'win32') {
      assert.equal((await fs.promises.stat(configPath)).mode & 0o777, 0o640);
    }
    assert.deepEqual(await fs.promises.readdir(path.dirname(configPath)), ['mcp.json']);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('atomic MCP replacement failure preserves existing JSON and Codex configs', async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-atomic-mcp-fail-'));
  const jsonPath = path.join(tempDir, '.cursor', 'mcp.json');
  const codexPath = path.join(tempDir, '.codex', 'config.toml');
  const originalJson = '{"theme":"dark"}\n';
  const originalCodex = 'model = "gpt-5"\n';
  await fs.promises.mkdir(path.dirname(jsonPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(codexPath), { recursive: true });
  await fs.promises.writeFile(jsonPath, originalJson, 'utf8');
  await fs.promises.writeFile(codexPath, originalCodex, 'utf8');

  const originalRename = fs.promises.rename;
  t.mock.method(fs.promises, 'rename', (async (oldPath, newPath) => {
    if (String(oldPath).endsWith('.tmp')) {
      throw new Error(`simulated atomic rename failure for ${String(newPath)}`);
    }
    return originalRename.call(fs.promises, oldPath, newPath);
  }) as typeof fs.promises.rename);

  try {
    await assert.rejects(
      installMcpConfig('cursor', {
        global: false,
        cwd: tempDir,
        stdout: { write: () => true },
      }),
      /simulated atomic rename failure/u
    );
    await assert.rejects(
      installMcpConfig('codex', {
        global: false,
        cwd: tempDir,
        stdout: { write: () => true },
      }),
      /simulated atomic rename failure/u
    );
    assert.equal(await fs.promises.readFile(jsonPath, 'utf8'), originalJson);
    assert.equal(await fs.promises.readFile(codexPath, 'utf8'), originalCodex);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('removeMcpConfig surfaces malformed and unreadable existing configs', async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-remove-invalid-mcp-'));
  const jsonPath = path.join(tempDir, '.cursor', 'mcp.json');
  const codexPath = path.join(tempDir, '.codex', 'config.toml');
  await fs.promises.mkdir(path.dirname(jsonPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(codexPath), { recursive: true });
  await fs.promises.writeFile(jsonPath, '{not json\n', 'utf8');
  await fs.promises.writeFile(codexPath, 'model = "gpt-5"\n', 'utf8');

  try {
    await assert.rejects(
      removeMcpConfig('cursor', { global: false, cwd: tempDir, stdout: { write: () => true } }),
      /not readable valid JSON/u
    );

    const originalReadFile = fs.promises.readFile;
    t.mock.method(fs.promises, 'readFile', (async (filePath, options) => {
      if (String(filePath) === codexPath) {
        const error = new Error('permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return originalReadFile.call(fs.promises, filePath, options);
    }) as typeof fs.promises.readFile);
    await assert.rejects(
      removeMcpConfig('codex', { global: false, cwd: tempDir, stdout: { write: () => true } }),
      /permission denied/u
    );
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});
