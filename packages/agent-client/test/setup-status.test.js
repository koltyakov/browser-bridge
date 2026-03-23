// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  formatManagedSkillSentinel,
  getCoreManagedSkillName,
  getManagedSkillNames,
  getManagedSkillSentinelFilename,
  getSkillBasePath
} from '../src/install.js';
import { installMcpConfig } from '../src/mcp-config.js';
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
    windsurf: () => detected.has('windsurf'),
    claude: () => detected.has('claude'),
    codex: () => detected.has('codex'),
    opencode: () => detected.has('opencode'),
    antigravity: () => detected.has('antigravity')
  };
}

/**
 * @param {string} basePath
 * @param {string} skillName
 * @param {string} sentinel
 * @param {string} [sentinelBody]
 * @returns {Promise<void>}
 */
async function writeManagedSkill(basePath, skillName, sentinel, sentinelBody = `${skillName} managed\n`) {
  const skillPath = path.join(basePath, skillName);
  await fs.promises.mkdir(skillPath, { recursive: true });
  const content = sentinelBody === `${skillName} managed\n`
    ? formatManagedSkillSentinel(skillName)
    : sentinelBody;
  await fs.promises.writeFile(path.join(skillPath, sentinel), content, 'utf8');
}

test('collectSetupStatus reports local MCP and skill installation state', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-setup-status-'));

  try {
    await installMcpConfig('windsurf', {
      global: false,
      cwd: tempDir,
      stdout: { write() { return true; } }
    });

    const codexBase = path.join(tempDir, '.codex', 'skills');
    const sentinel = getManagedSkillSentinelFilename();
    await writeManagedSkill(codexBase, getCoreManagedSkillName(), sentinel);

    const cursorBase = getSkillBasePath('cursor', {
      global: false,
      projectPath: tempDir
    });
    await writeManagedSkill(cursorBase, getCoreManagedSkillName(), sentinel, 'legacy managed\n');

    const windsurfBase = getSkillBasePath('windsurf', {
      global: false,
      projectPath: tempDir
    });
    for (const skillName of getManagedSkillNames()) {
      await writeManagedSkill(windsurfBase, skillName, sentinel);
    }

    const opencodeSkillPath = path.join(tempDir, '.opencode', 'skills', 'browser-bridge');
    await fs.promises.mkdir(opencodeSkillPath, { recursive: true });

    const status = await collectSetupStatus({
      global: false,
      cwd: tempDir,
      projectPath: tempDir,
      mcpDetectors: createDetectors(['windsurf']),
      skillDetectors: createDetectors(['codex', 'cursor', 'windsurf', 'opencode', 'antigravity'])
    });

    assert.equal(status.scope, 'local');

    const windsurf = status.mcpClients.find((entry) => entry.key === 'windsurf');
    assert.deepEqual(windsurf, {
      key: 'windsurf',
      label: 'Windsurf',
      detected: true,
      configPath: path.join(tempDir, '.windsurf', 'mcp_config.json'),
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
    assert.equal(codex.skills.length, 1);
    assert.equal(codex.updateAvailable, false);

    const windsurfSkills = status.skillTargets.find((entry) => entry.key === 'windsurf');
    assert.ok(windsurfSkills);
    assert.equal(windsurfSkills.label, 'Windsurf');
    assert.equal(windsurfSkills.detected, true);
    assert.equal(windsurfSkills.installed, true);
    assert.equal(windsurfSkills.managed, true);
    assert.equal(windsurfSkills.basePath, path.join(tempDir, '.windsurf', 'skills'));

    const antigravity = status.skillTargets.find((entry) => entry.key === 'antigravity');
    assert.ok(antigravity);
    assert.equal(antigravity.detected, true);
    assert.equal(antigravity.installed, false);
    assert.equal(antigravity.managed, false);
    assert.equal(antigravity.basePath, path.join(tempDir, '.agents', 'skills'));

    const opencode = status.skillTargets.find((entry) => entry.key === 'opencode');
    assert.ok(opencode);
    assert.equal(opencode.detected, true);
    assert.equal(opencode.installed, true);
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
      mcpDetectors: createDetectors(['cursor', 'windsurf']),
      skillDetectors: createDetectors([])
    });

    const cursorSkills = status.skillTargets.find((entry) => entry.key === 'cursor');
    assert.ok(cursorSkills);
    assert.equal(cursorSkills.detected, true);
    assert.equal(cursorSkills.installed, false);
    assert.equal(cursorSkills.basePath, path.join(tempDir, '.cursor', 'skills'));

    const windsurfSkills = status.skillTargets.find((entry) => entry.key === 'windsurf');
    assert.ok(windsurfSkills);
    assert.equal(windsurfSkills.detected, true);
    assert.equal(windsurfSkills.installed, false);
    assert.equal(windsurfSkills.basePath, path.join(tempDir, '.windsurf', 'skills'));
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('collectSetupStatus uses ~/.copilot/skills for GitHub Copilot global skills', async () => {
  const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-setup-status-copilot-home-'));
  const originalHome = process.env.HOME;
  const sentinel = getManagedSkillSentinelFilename();

  try {
    process.env.HOME = tempHome;

    const copilotBase = getSkillBasePath('copilot', {
      global: true,
      projectPath: '/tmp/unused'
    });
    await writeManagedSkill(copilotBase, getCoreManagedSkillName(), sentinel);

    const status = await collectSetupStatus({
      global: true,
      cwd: tempHome,
      projectPath: tempHome,
      mcpDetectors: createDetectors([]),
      skillDetectors: createDetectors(['copilot'])
    });

    const copilotSkills = status.skillTargets.find((entry) => entry.key === 'copilot');
    assert.ok(copilotSkills);
    assert.equal(copilotSkills.detected, true);
    assert.equal(copilotSkills.installed, true);
    assert.equal(copilotSkills.managed, true);
    assert.equal(copilotSkills.basePath, path.join(tempHome, '.copilot', 'skills'));
    assert.equal(copilotSkills.updateAvailable, false);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  }
});

test('collectSetupStatus reads Copilot global MCP from the user config path', async () => {
  const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-setup-status-copilot-mcp-home-'));
  const originalHome = process.env.HOME;
  const originalAppData = process.env.APPDATA;

  try {
    process.env.HOME = tempHome;
    if (process.platform === 'win32') {
      process.env.APPDATA = path.join(tempHome, 'AppData', 'Roaming');
    }

    await installMcpConfig('copilot', {
      global: true,
      stdout: { write() { return true; } }
    });

    const status = await collectSetupStatus({
      global: true,
      cwd: tempHome,
      projectPath: tempHome,
      mcpDetectors: createDetectors(['copilot']),
      skillDetectors: createDetectors([])
    });

    const copilot = status.mcpClients.find((entry) => entry.key === 'copilot');
    assert.ok(copilot);
    assert.equal(copilot.detected, true);
    assert.equal(copilot.configExists, true);
    assert.equal(copilot.configured, true);
    assert.equal(copilot.configPath, path.join(tempHome, '.copilot', 'mcp-config.json'));
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  }
});

test('collectSetupStatus reads Antigravity global MCP from the documented config path', async () => {
  const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-setup-status-antigravity-mcp-home-'));
  const originalHome = process.env.HOME;

  try {
    process.env.HOME = tempHome;

    await installMcpConfig('antigravity', {
      global: true,
      stdout: { write() { return true; } }
    });

    const status = await collectSetupStatus({
      global: true,
      cwd: tempHome,
      projectPath: tempHome,
      mcpDetectors: createDetectors(['antigravity']),
      skillDetectors: createDetectors(['antigravity'])
    });

    const antigravityMcp = status.mcpClients.find((entry) => entry.key === 'antigravity');
    assert.ok(antigravityMcp);
    assert.equal(antigravityMcp.label, 'Antigravity');
    assert.equal(antigravityMcp.detected, true);
    assert.equal(antigravityMcp.configExists, true);
    assert.equal(antigravityMcp.configured, true);
    assert.equal(antigravityMcp.configPath, path.join(tempHome, '.gemini', 'antigravity', 'mcp_config.json'));

    const antigravitySkills = status.skillTargets.find((entry) => entry.key === 'antigravity');
    assert.ok(antigravitySkills);
    assert.equal(antigravitySkills.detected, true);
    assert.equal(antigravitySkills.basePath, path.join(tempHome, '.gemini', 'antigravity', 'skills'));
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  }
});

test('collectSetupStatus marks legacy managed skills as updateable', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-setup-status-legacy-skill-'));
  const sentinel = getManagedSkillSentinelFilename();

  try {
    const cursorBase = getSkillBasePath('cursor', {
      global: false,
      projectPath: tempDir
    });
    await writeManagedSkill(cursorBase, getCoreManagedSkillName(), sentinel, 'legacy managed\n');

    const status = await collectSetupStatus({
      global: false,
      cwd: tempDir,
      projectPath: tempDir,
      mcpDetectors: createDetectors([]),
      skillDetectors: createDetectors(['cursor'])
    });

    const cursorSkills = status.skillTargets.find((entry) => entry.key === 'cursor');
    assert.ok(cursorSkills);
    assert.equal(cursorSkills.installed, true);
    assert.equal(cursorSkills.managed, true);
    assert.equal(cursorSkills.installedVersion, null);
    assert.equal(typeof cursorSkills.currentVersion, 'string');
    assert.equal(cursorSkills.updateAvailable, true);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('collectSetupStatus keeps managed core skill current when MCP is configured later', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-setup-status-mcp-unchanged-'));
  const sentinel = getManagedSkillSentinelFilename();

  try {
    const cursorBase = getSkillBasePath('cursor', {
      global: false,
      projectPath: tempDir
    });
    await writeManagedSkill(cursorBase, getCoreManagedSkillName(), sentinel);
    await installMcpConfig('cursor', {
      global: false,
      cwd: tempDir,
      stdout: { write() { return true; } }
    });

    const status = await collectSetupStatus({
      global: false,
      cwd: tempDir,
      projectPath: tempDir,
      mcpDetectors: createDetectors(['cursor']),
      skillDetectors: createDetectors(['cursor'])
    });

    const cursorSkills = status.skillTargets.find((entry) => entry.key === 'cursor');
    assert.ok(cursorSkills);
    assert.equal(cursorSkills.installed, true);
    assert.equal(cursorSkills.managed, true);
    assert.equal(cursorSkills.updateAvailable, false);
    assert.equal(cursorSkills.skills.length, 1);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});
