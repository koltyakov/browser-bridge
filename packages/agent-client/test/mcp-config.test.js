// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MCP_CLIENT_NAMES,
  buildMcpConfig,
  formatMcpConfig,
  getMcpConfigPath,
  getMcpConfigPaths,
  getMcpConfigShape,
  isMcpClientName,
  parseInstalledMcpConfig,
  removeMcpConfig,
} from '../src/mcp-config.js';

const expectedMcpCommand = process.platform === 'win32' ? process.execPath : 'bbx';
const expectedMcpArgs =
  process.platform === 'win32'
    ? [path.join(process.cwd(), 'packages', 'mcp-server', 'src', 'bin.js')]
    : ['mcp', 'serve'];
const expectedOpencodeCommand =
  process.platform === 'win32'
    ? [process.execPath, path.join(process.cwd(), 'packages', 'mcp-server', 'src', 'bin.js')]
    : ['bbx', 'mcp', 'serve'];

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
    legacyKeys: ['servers'],
    keepEmptyBlock: true,
  });
  assert.deepEqual(getMcpConfigShape(/** @type {any} */ ('unsupported')), {
    key: 'mcpServers',
    includeType: false,
  });
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
    readdir: async () => /** @type {any} */ ([
      { name: 'profile-a', isDirectory: () => true },
      { name: 'notes.txt', isDirectory: () => false },
      { name: 'profile-b', isDirectory: () => true },
    ]),
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

test('removeMcpConfig migrates legacy Copilot server keys into an empty managed block', async () => {
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
    assert.deepEqual(updated.mcpServers, {});
    assert.equal(Object.hasOwn(updated, 'servers'), false);
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
