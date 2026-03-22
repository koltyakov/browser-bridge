// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import { detectMcpClients, detectSkillTargets } from './detect.js';
import {
  getMcpConfigShape,
  getMcpConfigPath,
  MCP_CLIENT_NAMES
} from './mcp-config.js';
import {
  getManagedSkillNames,
  getManagedSkillSentinelFilename,
  getSkillBasePath,
  SUPPORTED_TARGETS
} from './install.js';

/** @typedef {import('./mcp-config.js').McpClientName} McpClientName */
/** @typedef {import('./install.js').SupportedTarget} SupportedTarget */
/** @typedef {import('../../protocol/src/types.js').SetupStatus} SetupStatus */
/** @typedef {import('../../protocol/src/types.js').McpClientStatus} McpClientStatus */
/** @typedef {import('../../protocol/src/types.js').SkillTargetStatus} SkillTargetStatus */
/** @typedef {import('../../protocol/src/types.js').SkillInstallationStatus} SkillInstallationStatus */

/** @type {Record<McpClientName, string>} */
const MCP_CLIENT_LABELS = {
  copilot: 'GitHub Copilot',
  codex: 'OpenAI Codex',
  cursor: 'Cursor',
  claude: 'Claude',
  opencode: 'OpenCode'
};

/** @type {Record<SupportedTarget, string>} */
const SKILL_TARGET_LABELS = {
  copilot: 'GitHub Copilot',
  claude: 'Claude',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  agents: 'Generic agents',
  codex: 'OpenAI Codex'
};

/**
 * @typedef {{
 *   global?: boolean,
 *   cwd?: string,
 *   projectPath?: string,
 *   mcpDetectors?: Record<string, () => boolean>,
 *   skillDetectors?: Record<string, () => boolean>,
 *   access?: (targetPath: string) => Promise<void>,
 *   readFile?: (targetPath: string, encoding: BufferEncoding) => Promise<string>
 * }} SetupStatusOptions
 */

/**
 * Return Browser Bridge MCP and skill installation status for supported clients.
 *
 * @param {SetupStatusOptions} [options={}]
 * @returns {Promise<SetupStatus>}
 */
export async function collectSetupStatus(options = {}) {
  const isGlobal = options.global !== false;
  const cwd = options.cwd || process.cwd();
  const projectPath = options.projectPath || cwd;
  const access = options.access || fs.promises.access.bind(fs.promises);
  const readFile = options.readFile || fs.promises.readFile.bind(fs.promises);
  const detectedMcpClients = new Set(detectMcpClients(options.mcpDetectors));
  const detectedSkillTargets = new Set(detectSkillTargets(options.skillDetectors));
  for (const clientName of detectedMcpClients) {
    if (SUPPORTED_TARGETS.includes(/** @type {SupportedTarget} */ (clientName))) {
      detectedSkillTargets.add(/** @type {SupportedTarget} */ (clientName));
    }
  }

  const mcpClients = await Promise.all(MCP_CLIENT_NAMES.map(async (clientName) => {
    return collectMcpClientStatus(clientName, {
      global: isGlobal,
      cwd,
      detected: detectedMcpClients.has(clientName),
      readFile
    });
  }));

  const skillTargets = await Promise.all(SUPPORTED_TARGETS.map(async (target) => {
    return collectSkillTargetStatus(target, {
      global: isGlobal,
      projectPath,
      detected: detectedSkillTargets.has(target),
      access
    });
  }));

  return {
    scope: isGlobal ? 'global' : 'local',
    mcpClients,
    skillTargets
  };
}

/**
 * @param {McpClientName} clientName
 * @param {{
 *   global: boolean,
 *   cwd: string,
 *   detected: boolean,
 *   readFile: (targetPath: string, encoding: BufferEncoding) => Promise<string>
 * }} options
 * @returns {Promise<McpClientStatus>}
 */
async function collectMcpClientStatus(clientName, options) {
  const configPath = getMcpConfigPath(clientName, {
    global: options.global,
    cwd: options.cwd
  });
  const entry = await readBrowserBridgeMcpEntry(clientName, configPath, options.readFile);

  return {
    key: clientName,
    label: MCP_CLIENT_LABELS[clientName],
    detected: options.detected,
    configPath,
    configExists: entry.configExists,
    configured: entry.configured
  };
}

/**
 * @param {SupportedTarget} target
 * @param {{
 *   global: boolean,
 *   projectPath: string,
 *   detected: boolean,
 *   access: (targetPath: string) => Promise<void>
 * }} options
 * @returns {Promise<SkillTargetStatus>}
 */
async function collectSkillTargetStatus(target, options) {
  const basePath = getSkillBasePath(target, {
    global: options.global,
    projectPath: options.projectPath
  });
  const managedSkillNames = getManagedSkillNames();
  const sentinelFilename = getManagedSkillSentinelFilename();
  const skills = await Promise.all(managedSkillNames.map(async (skillName) => {
    return collectInstalledSkillStatus(basePath, skillName, sentinelFilename, options.access);
  }));

  return {
    key: target,
    label: SKILL_TARGET_LABELS[target],
    detected: options.detected,
    basePath,
    installed: skills.every((skill) => skill.exists),
    managed: skills.every((skill) => skill.exists && skill.managed),
    skills
  };
}

/**
 * @param {string} basePath
 * @param {string} skillName
 * @param {string} sentinelFilename
 * @param {(targetPath: string) => Promise<void>} access
 * @returns {Promise<SkillInstallationStatus>}
 */
async function collectInstalledSkillStatus(basePath, skillName, sentinelFilename, access) {
  const skillPath = path.join(basePath, skillName);
  const exists = await pathExists(skillPath, access);
  const managed = exists && await pathExists(path.join(skillPath, sentinelFilename), access);

  return {
    name: skillName,
    path: skillPath,
    exists,
    managed
  };
}

/**
 * @param {McpClientName} clientName
 * @param {string} configPath
 * @param {(targetPath: string, encoding: BufferEncoding) => Promise<string>} readFile
 * @returns {Promise<{ configExists: boolean, configured: boolean }>}
 */
async function readBrowserBridgeMcpEntry(clientName, configPath, readFile) {
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const topKey = getMcpConfigShape(clientName).key;
    const block = parsed && typeof parsed === 'object'
      ? /** @type {Record<string, unknown>} */ (parsed[topKey] ?? {})
      : {};
    return {
      configExists: true,
      configured: Boolean(block && typeof block === 'object' && Object.hasOwn(block, 'browser-bridge'))
    };
  } catch {
    try {
      await readFile(configPath, 'utf8');
      return {
        configExists: true,
        configured: false
      };
    } catch {
      return {
        configExists: false,
        configured: false
      };
    }
  }
}

/**
 * @param {string} targetPath
 * @param {(targetPath: string) => Promise<void>} access
 * @returns {Promise<boolean>}
 */
async function pathExists(targetPath, access) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
