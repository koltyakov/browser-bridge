// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MCP_CLIENT_NAMES, parseInstalledMcpConfig } from '../src/mcp-config.js';
import { formatManagedSkillSentinel } from '../src/install.js';
import { createInstallFs } from '../../../tests/_helpers/installFs.js';
import { runCli } from '../../../tests/_helpers/runCli.js';

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} targetPath
 * @returns {Promise<void>}
 */
async function assertPathMissing(targetPath) {
  await assert.rejects(fs.promises.access(targetPath), {
    code: 'ENOENT',
  });
}

/**
 * @param {string[]} paths
 * @returns {string[]}
 */
function uniquePaths(paths) {
  return [...new Set(paths)];
}

/**
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   cwd: string,
 *   launcherPath: string,
 *   browserManifests: Record<string, { manifestPath: string }>,
 * }} installFs
 * @returns {Promise<void>}
 */
async function seedUninstallFixtures(installFs) {
  const installCommands = [
    ['install-skill', 'all'],
    ['install-skill', 'all', '--local'],
    ['install-mcp', 'all'],
    ['install-mcp', '--local', 'all'],
  ];

  for (const args of installCommands) {
    const result = await runCli({
      args,
      env: installFs.env,
      cwd: installFs.cwd,
    });

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
  }

  await fs.promises.mkdir(path.dirname(installFs.launcherPath), { recursive: true });
  await fs.promises.writeFile(installFs.launcherPath, '#!/bin/sh\n', 'utf8');

  for (const { manifestPath } of Object.values(installFs.browserManifests)) {
    await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.promises.writeFile(manifestPath, '{}\n', 'utf8');
  }
}

/**
 * @param {Record<string, { skillDir: string }>} targets
 * @returns {string[]}
 */
function getUniqueSkillDirs(targets) {
  return uniquePaths(Object.values(targets).map((target) => target.skillDir));
}

/**
 * @param {Record<string, { configPaths: string[] }>} clients
 * @returns {string[]}
 */
function getUniqueConfigPaths(clients) {
  return uniquePaths(Object.values(clients).flatMap((client) => client.configPaths));
}

test('cli install-skill without targets falls back to detected agents when nothing is managed', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-cli-install-skill-detected-default-' });

  try {
    await fs.promises.rm(installFs.codexHome, { recursive: true, force: true });

    const result = await runCli({
      args: ['install-skill'],
      env: installFs.env,
    });

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.match(
      result.stdout,
      new RegExp(`Installed ${escapeRegExp(installFs.globalSkillTargets.agents.skillDir)}`)
    );

    await fs.promises.access(installFs.globalSkillTargets.agents.skillFile);
    await fs.promises.access(installFs.globalSkillTargets.agents.sentinelFile);
    await assertPathMissing(installFs.globalSkillTargets.claude.skillFile);
  } finally {
    await installFs.cleanup();
  }
});

test('cli install-skill without targets installs detected claude skill in non-interactive mode', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-cli-install-skill-detected-claude-' });

  try {
    await fs.promises.rm(installFs.codexHome, { recursive: true, force: true });
    await fs.promises.mkdir(installFs.globalSkillTargets.claude.baseDir, { recursive: true });

    const result = await runCli({
      args: ['install-skill'],
      env: installFs.env,
    });

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.match(
      result.stdout,
      new RegExp(`Installed ${escapeRegExp(installFs.globalSkillTargets.claude.skillDir)}`)
    );
    assert.match(
      result.stdout,
      new RegExp(`Installed ${escapeRegExp(installFs.globalSkillTargets.agents.skillDir)}`)
    );

    await fs.promises.access(installFs.globalSkillTargets.claude.skillFile);
    await fs.promises.access(installFs.globalSkillTargets.agents.skillFile);
  } finally {
    await installFs.cleanup();
  }
});

test('cli install-skill without targets reuses managed installs in non-interactive mode', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-cli-install-skill-managed-default-' });

  try {
    await fs.promises.mkdir(installFs.globalSkillTargets.claude.skillDir, { recursive: true });
    await fs.promises.writeFile(
      installFs.globalSkillTargets.claude.sentinelFile,
      formatManagedSkillSentinel('browser-bridge'),
      'utf8'
    );
    await fs.promises.writeFile(
      installFs.globalSkillTargets.claude.skillFile,
      'old skill\n',
      'utf8'
    );
    const oldDate = new Date('2000-01-01T00:00:00.000Z');
    await fs.promises.utimes(installFs.globalSkillTargets.claude.skillFile, oldDate, oldDate);
    const beforeStat = await fs.promises.stat(installFs.globalSkillTargets.claude.skillFile);

    const result = await runCli({
      args: ['install-skill'],
      env: installFs.env,
    });

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.match(
      result.stdout,
      new RegExp(`Installed ${escapeRegExp(installFs.globalSkillTargets.claude.skillDir)}`)
    );
    assert.doesNotMatch(result.stdout, /Removed /);

    const afterStat = await fs.promises.stat(installFs.globalSkillTargets.claude.skillFile);
    assert.ok(afterStat.mtimeMs > beforeStat.mtimeMs);
    assert.notEqual(
      await fs.promises.readFile(installFs.globalSkillTargets.claude.skillFile, 'utf8'),
      'old skill\n'
    );
    await assertPathMissing(installFs.globalSkillTargets.agents.skillFile);
  } finally {
    await installFs.cleanup();
  }
});

test('cli install-skill --local writes managed skills under the current project path', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-cli-install-skill-local-default-' });

  try {
    await fs.promises.rm(installFs.codexHome, { recursive: true, force: true });
    await fs.promises.mkdir(path.join(installFs.home, '.claude'), { recursive: true });

    const result = await runCli({
      args: ['install-skill', '--local'],
      env: installFs.env,
      cwd: installFs.cwd,
    });

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.match(
      result.stdout,
      new RegExp(`Installed ${escapeRegExp(installFs.localSkillTargets.claude.skillDir)}`)
    );
    assert.match(
      result.stdout,
      new RegExp(`Installed ${escapeRegExp(installFs.localSkillTargets.agents.skillDir)}`)
    );

    await fs.promises.access(installFs.localSkillTargets.claude.skillFile);
    await fs.promises.access(installFs.localSkillTargets.agents.skillFile);
    await assertPathMissing(installFs.globalSkillTargets.claude.skillFile);
    await assertPathMissing(installFs.globalSkillTargets.agents.skillFile);
  } finally {
    await installFs.cleanup();
  }
});

test('cli install-mcp <client-list> writes only the requested client configs', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-cli-install-mcp-list-' });

  try {
    const result = await runCli({
      args: ['install-mcp', 'claude,cursor'],
      env: installFs.env,
    });

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.match(
      result.stdout,
      new RegExp(`Wrote ${escapeRegExp(installFs.globalMcpClients.claude.primaryConfigPath)}`)
    );
    assert.match(
      result.stdout,
      new RegExp(`Wrote ${escapeRegExp(installFs.globalMcpClients.cursor.primaryConfigPath)}`)
    );

    const claudeConfig = JSON.parse(
      await fs.promises.readFile(installFs.globalMcpClients.claude.primaryConfigPath, 'utf8')
    );
    const cursorConfig = JSON.parse(
      await fs.promises.readFile(installFs.globalMcpClients.cursor.primaryConfigPath, 'utf8')
    );

    assert.deepEqual(claudeConfig.mcpServers['browser-bridge'], {
      type: 'stdio',
      command: 'bbx',
      args: ['mcp', 'serve'],
      env: {},
    });
    assert.deepEqual(cursorConfig.mcpServers['browser-bridge'], {
      command: 'bbx',
      args: ['mcp', 'serve'],
      env: {},
    });

    await assertPathMissing(installFs.globalMcpClients.codex.primaryConfigPath);
    await assertPathMissing(installFs.globalMcpClients.agents.primaryConfigPath);
  } finally {
    await installFs.cleanup();
  }
});

test('cli install-mcp without a client falls back to all clients when none are detected or configured', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-cli-install-mcp-default-all-' });

  try {
    const result = await runCli({
      args: ['install-mcp'],
      env: {
        ...installFs.env,
        BBX_TEST_DETECTED_MCP_CLIENTS: '',
      },
    });

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');

    for (const clientName of MCP_CLIENT_NAMES) {
      for (const configPath of installFs.globalMcpClients[clientName].configPaths) {
        await fs.promises.access(configPath);
        assert.match(result.stdout, new RegExp(`Wrote ${escapeRegExp(configPath)}`));
      }
    }
  } finally {
    await installFs.cleanup();
  }
});

test('cli install-mcp without a client falls back to detected clients in non-interactive mode', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-cli-install-mcp-default-detected-' });

  try {
    await fs.promises.mkdir(path.dirname(installFs.globalMcpClients.claude.primaryConfigPath), {
      recursive: true,
    });
    await fs.promises.writeFile(
      installFs.globalMcpClients.claude.primaryConfigPath,
      '{}\n',
      'utf8'
    );

    const result = await runCli({
      args: ['install-mcp'],
      env: {
        ...installFs.env,
        BBX_TEST_DETECTED_MCP_CLIENTS: 'claude',
      },
    });

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.match(
      result.stdout,
      new RegExp(`Wrote ${escapeRegExp(installFs.globalMcpClients.claude.primaryConfigPath)}`)
    );

    await fs.promises.access(installFs.globalMcpClients.claude.primaryConfigPath);
    await assertPathMissing(installFs.globalMcpClients.cursor.primaryConfigPath);
    await assertPathMissing(installFs.globalMcpClients.agents.primaryConfigPath);
  } finally {
    await installFs.cleanup();
  }
});

test('cli install-mcp without a client prefers already configured clients over detected ones', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-cli-install-mcp-default-configured-' });

  try {
    await fs.promises.mkdir(path.dirname(installFs.globalMcpClients.claude.primaryConfigPath), {
      recursive: true,
    });
    await fs.promises.writeFile(
      installFs.globalMcpClients.claude.primaryConfigPath,
      `${JSON.stringify(
        {
          mcpServers: {
            'browser-bridge': {
              type: 'stdio',
              command: 'bbx',
              args: ['mcp', 'serve'],
              env: {},
            },
          },
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const result = await runCli({
      args: ['install-mcp'],
      env: {
        ...installFs.env,
        BBX_TEST_DETECTED_MCP_CLIENTS: 'claude,cursor',
      },
    });

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.match(
      result.stdout,
      new RegExp(`Wrote ${escapeRegExp(installFs.globalMcpClients.claude.primaryConfigPath)}`)
    );

    await fs.promises.access(installFs.globalMcpClients.claude.primaryConfigPath);
    await assertPathMissing(installFs.globalMcpClients.codex.primaryConfigPath);
    await assertPathMissing(installFs.globalMcpClients.cursor.primaryConfigPath);
  } finally {
    await installFs.cleanup();
  }
});

test('cli install-mcp all writes config for every supported client', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-cli-install-mcp-all-' });

  try {
    const result = await runCli({
      args: ['install-mcp', 'all'],
      env: installFs.env,
    });

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');

    for (const clientName of MCP_CLIENT_NAMES) {
      for (const configPath of installFs.globalMcpClients[clientName].configPaths) {
        await fs.promises.access(configPath);
        assert.match(result.stdout, new RegExp(`Wrote ${escapeRegExp(configPath)}`));
      }
    }

    const codexConfig = await fs.promises.readFile(
      installFs.globalMcpClients.codex.primaryConfigPath,
      'utf8'
    );
    assert.match(codexConfig, /\[mcp_servers\."browser-bridge"\]/);
  } finally {
    await installFs.cleanup();
  }
});

test('cli install-mcp rejects unknown explicit clients', async () => {
  const result = await runCli({
    args: ['install-mcp', 'bogus'],
  });

  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unknown client "bogus"/);
  assert.match(
    result.stderr,
    /Supported: codex, claude, cursor, copilot, opencode, antigravity, windsurf, agents, all/
  );
});

test('cli install-mcp --local writes config under the current project path', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-cli-install-mcp-local-' });

  try {
    const result = await runCli({
      args: ['install-mcp', '--local', 'claude'],
      env: installFs.env,
      cwd: installFs.cwd,
    });

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.match(
      result.stdout,
      new RegExp(`Wrote ${escapeRegExp(installFs.localMcpClients.claude.primaryConfigPath)}`)
    );

    await fs.promises.access(installFs.localMcpClients.claude.primaryConfigPath);
    await assertPathMissing(installFs.globalMcpClients.claude.primaryConfigPath);
  } finally {
    await installFs.cleanup();
  }
});

test('cli install-mcp --global keeps writing config under HOME', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-cli-install-mcp-global-' });

  try {
    const result = await runCli({
      args: ['install-mcp', '--global', 'claude'],
      env: installFs.env,
      cwd: installFs.cwd,
    });

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.match(
      result.stdout,
      new RegExp(`Wrote ${escapeRegExp(installFs.globalMcpClients.claude.primaryConfigPath)}`)
    );

    await fs.promises.access(installFs.globalMcpClients.claude.primaryConfigPath);
    await assertPathMissing(installFs.localMcpClients.claude.primaryConfigPath);
  } finally {
    await installFs.cleanup();
  }
});

test('cli install-skill <target> installs only the requested managed skill', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-cli-install-skill-target-' });

  try {
    const result = await runCli({
      args: ['install-skill', 'claude'],
      env: installFs.env,
    });

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.match(
      result.stdout,
      new RegExp(`Installed ${escapeRegExp(installFs.globalSkillTargets.claude.skillDir)}`)
    );

    await fs.promises.access(installFs.globalSkillTargets.claude.skillFile);
    await fs.promises.access(installFs.globalSkillTargets.claude.sentinelFile);
    await assertPathMissing(installFs.globalSkillTargets.cursor.skillFile);
  } finally {
    await installFs.cleanup();
  }
});

test('cli install-skill all installs managed skill files for every supported target', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-cli-install-skill-all-' });

  try {
    const result = await runCli({
      args: ['install-skill', 'all'],
      env: installFs.env,
    });

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');

    for (const targetPaths of Object.values(installFs.globalSkillTargets)) {
      await fs.promises.access(targetPaths.skillFile);
      await fs.promises.access(targetPaths.sentinelFile);
      assert.match(result.stdout, new RegExp(`Installed ${escapeRegExp(targetPaths.skillDir)}`));
    }
  } finally {
    await installFs.cleanup();
  }
});

test('cli install-skill rejects unknown explicit targets', async () => {
  const result = await runCli({
    args: ['install-skill', 'vscode'],
  });

  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unknown install-skill target "vscode"/);
});

test('cli install surfaces unsupported browser errors from the native installer', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-cli-install-browser-error-' });

  try {
    const result = await runCli({
      args: ['install', '--browser', 'unsupported'],
      env: installFs.env,
    });

    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Unsupported browser: unsupported/);
    assert.match(result.stderr, /Supported: chrome, edge, brave, chromium, arc/);
    assert.match(result.stderr, /Command failed:/);
  } finally {
    await installFs.cleanup();
  }
});

test('cli uninstall removes managed skills and manifests and strips browser-bridge MCP entries', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-cli-uninstall-clean-' });

  try {
    await seedUninstallFixtures(installFs);

    const result = await runCli({
      args: ['uninstall'],
      env: installFs.env,
      cwd: installFs.cwd,
    });

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');

    for (const skillDir of [
      ...getUniqueSkillDirs(installFs.globalSkillTargets),
      ...getUniqueSkillDirs(installFs.localSkillTargets),
    ]) {
      assert.match(result.stdout, new RegExp(`Removed ${escapeRegExp(skillDir)}`));
      await assertPathMissing(skillDir);
    }

    for (const configPath of [
      ...getUniqueConfigPaths(installFs.globalMcpClients),
      ...getUniqueConfigPaths(installFs.localMcpClients),
    ]) {
      assert.match(result.stdout, new RegExp(`Removed ${escapeRegExp(configPath)}`));
    }

    for (const clientName of MCP_CLIENT_NAMES) {
      for (const configPath of installFs.globalMcpClients[clientName].configPaths) {
        const raw = await fs.promises.readFile(configPath, 'utf8');
        assert.equal(parseInstalledMcpConfig(clientName, raw).configured, false);
      }

      for (const configPath of installFs.localMcpClients[clientName].configPaths) {
        const raw = await fs.promises.readFile(configPath, 'utf8');
        assert.equal(parseInstalledMcpConfig(clientName, raw).configured, false);
      }
    }

    for (const { manifestPath } of Object.values(installFs.browserManifests)) {
      assert.match(result.stdout, new RegExp(`Removed ${escapeRegExp(manifestPath)}`));
      await assertPathMissing(manifestPath);
    }

    assert.match(result.stdout, new RegExp(`Removed ${escapeRegExp(installFs.bridgeHome)}`));
    await assertPathMissing(installFs.bridgeHome);
  } finally {
    await installFs.cleanup();
  }
});

test('cli uninstall rejects unexpected extra arguments', async () => {
  const result = await runCli({
    args: ['uninstall', 'foo'],
  });

  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Usage: bbx uninstall\n');
});

test('cli uninstall is idempotent after a successful removal', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-cli-uninstall-idempotent-' });

  try {
    await seedUninstallFixtures(installFs);

    const first = await runCli({
      args: ['uninstall'],
      env: installFs.env,
      cwd: installFs.cwd,
    });
    const second = await runCli({
      args: ['uninstall'],
      env: installFs.env,
      cwd: installFs.cwd,
    });

    assert.equal(first.status, 0);
    assert.equal(first.signal, null);
    assert.equal(first.stderr, '');
    assert.notEqual(first.stdout, '');

    assert.equal(second.status, 0);
    assert.equal(second.signal, null);
    assert.equal(second.stdout, '');
    assert.equal(second.stderr, '');
  } finally {
    await installFs.cleanup();
  }
});
