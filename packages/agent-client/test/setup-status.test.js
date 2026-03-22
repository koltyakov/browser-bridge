// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { installMcpConfig } from '../src/mcp-config.js';
import { getManagedSkillNames, getManagedSkillSentinelFilename, getSkillBasePath } from '../src/install.js';
import { collectSetupStatus } from '../src/setup-status.js';

/**
 * @param {string[]} detectedNames
 * @returns {Record<string, () => boolean>}
 */
function createDetectors(detectedNames) {
  const detected = new Set(detectedNames);
  return {
    copilot: () => detected.has('copilot'),
    cursor: () => detected.has('cursor'),
    claude: () => detected.has('claude'),
    codex: () => detected.has('codex'),
    opencode: () => detected.has('opencode')
  };
}

test('collectSetupStatus reports local MCP and skill installation state', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-setup-status-'));

  try {
    await installMcpConfig('cursor', {
      global: false,
      cwd: tempDir,
      stdout: { write() { return true; } }
    });

    const codexBase = path.join(tempDir, '.codex', 'skills');
    const sentinel = getManagedSkillSentinelFilename();
    for (const skillName of getManagedSkillNames()) {
      const skillPath = path.join(codexBase, skillName);
      await fs.promises.mkdir(skillPath, { recursive: true });
      await fs.promises.writeFile(path.join(skillPath, sentinel), `${skillName} managed\n`, 'utf8');
    }

    const cursorBase = getSkillBasePath('cursor', {
      global: false,
      projectPath: tempDir
    });
    for (const skillName of getManagedSkillNames()) {
      const skillPath = path.join(cursorBase, skillName);
      await fs.promises.mkdir(skillPath, { recursive: true });
      await fs.promises.writeFile(path.join(skillPath, sentinel), `${skillName} managed\n`, 'utf8');
    }

    const opencodeSkillPath = path.join(tempDir, '.opencode', 'skills', 'browser-bridge');
    await fs.promises.mkdir(opencodeSkillPath, { recursive: true });

    const status = await collectSetupStatus({
      global: false,
      cwd: tempDir,
      projectPath: tempDir,
      mcpDetectors: createDetectors(['cursor']),
      skillDetectors: createDetectors(['codex', 'cursor', 'opencode'])
    });

    assert.equal(status.scope, 'local');

    const cursor = status.mcpClients.find((entry) => entry.key === 'cursor');
    assert.deepEqual(cursor, {
      key: 'cursor',
      label: 'Cursor',
      detected: true,
      configPath: path.join(tempDir, '.cursor', 'mcp.json'),
      configExists: true,
      configured: true
    });

    const cursorSkills = status.skillTargets.find((entry) => entry.key === 'cursor');
    assert.ok(cursorSkills);
    assert.equal(cursorSkills.label, 'Cursor');
    assert.equal(cursorSkills.detected, true);
    assert.equal(cursorSkills.installed, true);
    assert.equal(cursorSkills.managed, true);
    assert.equal(cursorSkills.basePath, path.join(tempDir, '.cursor', 'skills'));

    const codex = status.skillTargets.find((entry) => entry.key === 'codex');
    assert.ok(codex);
    assert.equal(codex.detected, true);
    assert.equal(codex.installed, true);
    assert.equal(codex.managed, true);
    assert.equal(codex.skills.length, 2);

    const opencode = status.skillTargets.find((entry) => entry.key === 'opencode');
    assert.ok(opencode);
    assert.equal(opencode.detected, true);
    assert.equal(opencode.installed, false);
    assert.equal(opencode.managed, false);
    assert.equal(opencode.skills.filter((skill) => skill.exists).length, 1);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('collectSetupStatus treats detected MCP runtimes as skill-install targets too', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-setup-status-mcp-skill-'));

  try {
    const status = await collectSetupStatus({
      global: false,
      cwd: tempDir,
      projectPath: tempDir,
      mcpDetectors: createDetectors(['cursor']),
      skillDetectors: createDetectors([])
    });

    const cursorSkills = status.skillTargets.find((entry) => entry.key === 'cursor');
    assert.ok(cursorSkills);
    assert.equal(cursorSkills.detected, true);
    assert.equal(cursorSkills.installed, false);
    assert.equal(cursorSkills.basePath, path.join(tempDir, '.cursor', 'skills'));
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});
