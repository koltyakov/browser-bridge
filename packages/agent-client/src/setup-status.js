// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import { detectMcpClients, detectSkillTargets } from './detect.js';
import {
  getMcpConfigPath,
  getMcpConfigPaths,
  MCP_CLIENT_NAMES,
  parseInstalledMcpConfig
} from './mcp-config.js';
import {
  getCoreManagedSkillName,
  getManagedPackageVersion,
  getManagedSkillNames,
  getManagedSkillSentinelFilename,
  getMcpManagedSkillName,
  getSkillBasePath,
  isManagedVersionOutdated,
  parseManagedSkillSentinel,
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
  windsurf: 'Windsurf',
  claude: 'Claude Code',
  opencode: 'OpenCode'
};

/** @type {Record<SupportedTarget, string>} */
const SKILL_TARGET_LABELS = {
  copilot: 'GitHub Copilot',
  claude: 'Claude Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
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
  const configuredMcpClients = new Set(
    mcpClients
      .filter((entry) => entry.configured)
      .map((entry) => entry.key)
  );

  const skillTargets = await Promise.all(SUPPORTED_TARGETS.map(async (target) => {
    return collectSkillTargetStatus(target, {
      global: isGlobal,
      projectPath,
      detected: detectedSkillTargets.has(target),
      mcpConfigured: configuredMcpClients.has(/** @type {McpClientName} */ (target)),
      access,
      readFile
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
  const primaryConfigPath = getMcpConfigPath(clientName, {
    global: options.global,
    cwd: options.cwd
  });
  const configPaths = await getMcpConfigPaths(clientName, {
    global: options.global,
    cwd: options.cwd
  });
  const entries = await Promise.all(configPaths.map(async (configPath) => {
    return readBrowserBridgeMcpEntry(clientName, configPath, options.readFile);
  }));
  const preferredEntry = entries.find((entry) => entry.configured)
    || entries.find((entry) => entry.configExists)
    || null;
  const preferredPath = preferredEntry?.configPath || primaryConfigPath;

  return {
    key: clientName,
    label: MCP_CLIENT_LABELS[clientName],
    detected: options.detected,
    configPath: preferredPath,
    configExists: entries.some((entry) => entry.configExists),
    configured: entries.some((entry) => entry.configured)
  };
}

/**
 * @param {SupportedTarget} target
 * @param {{
 *   global: boolean,
 *   projectPath: string,
 *   detected: boolean,
 *   mcpConfigured: boolean,
 *   access: (targetPath: string) => Promise<void>,
 *   readFile: (targetPath: string, encoding: BufferEncoding) => Promise<string>
 * }} options
 * @returns {Promise<SkillTargetStatus>}
 */
async function collectSkillTargetStatus(target, options) {
  const basePath = getSkillBasePath(target, {
    global: options.global,
    projectPath: options.projectPath
  });
  const managedSkillNames = getManagedSkillNames();
  const coreSkillName = getCoreManagedSkillName();
  const mcpSkillName = getMcpManagedSkillName();
  const sentinelFilename = getManagedSkillSentinelFilename();
  const currentVersion = getManagedPackageVersion();
  const skills = await Promise.all(managedSkillNames.map(async (skillName) => {
    return collectInstalledSkillStatus(basePath, skillName, sentinelFilename, options.access, options.readFile);
  }));
  const skillByName = new Map(skills.map((skill) => [skill.name, skill]));
  const requiredSkillNames = options.mcpConfigured
    ? [coreSkillName, mcpSkillName]
    : [coreSkillName];
  const requiredSkills = requiredSkillNames
    .map((skillName) => skillByName.get(skillName))
    .filter((skill) => Boolean(skill));
  const coreSkill = skillByName.get(coreSkillName) || null;
  const coreInstalled = Boolean(coreSkill?.exists);
  const coreManaged = Boolean(coreSkill?.exists && coreSkill.managed);
  const missingRequiredSkills = requiredSkills.some((skill) => !skill.exists);
  const unmanagedRequiredSkills = requiredSkills.some((skill) => skill.exists && !skill.managed);
  const outdatedRequiredSkills = requiredSkills.some((skill) => {
    return skill.exists
      && skill.managed
      && isManagedVersionOutdated(skill.version, currentVersion);
  });
  const installedVersion = getInstalledSkillBundleVersion(requiredSkills);
  const updateAvailable = coreManaged
    && !unmanagedRequiredSkills
    && (missingRequiredSkills || outdatedRequiredSkills);

  return {
    key: target,
    label: SKILL_TARGET_LABELS[target],
    detected: options.detected,
    basePath,
    installed: coreInstalled,
    managed: coreManaged,
    installedVersion,
    currentVersion,
    updateAvailable,
    skills
  };
}

/**
 * @param {string} basePath
 * @param {string} skillName
 * @param {string} sentinelFilename
 * @param {(targetPath: string) => Promise<void>} access
 * @param {(targetPath: string, encoding: BufferEncoding) => Promise<string>} readFile
 * @returns {Promise<SkillInstallationStatus>}
 */
async function collectInstalledSkillStatus(basePath, skillName, sentinelFilename, access, readFile) {
  const skillPath = path.join(basePath, skillName);
  const exists = await pathExists(skillPath, access);
  const sentinelPath = path.join(skillPath, sentinelFilename);
  const managed = exists && await pathExists(sentinelPath, access);
  const version = managed ? await readManagedSkillVersion(sentinelPath, readFile) : null;

  return {
    name: skillName,
    path: skillPath,
    exists,
    managed,
    version
  };
}

/**
 * @param {SkillInstallationStatus[]} skills
 * @returns {string | null}
 */
function getInstalledSkillBundleVersion(skills) {
  if (!skills.length) {
    return null;
  }
  const [first] = skills;
  if (!first || typeof first.version !== 'string') {
    return null;
  }
  return skills.every((skill) => skill.version === first.version) ? first.version : null;
}

/**
 * @param {string} sentinelPath
 * @param {(targetPath: string, encoding: BufferEncoding) => Promise<string>} readFile
 * @returns {Promise<string | null>}
 */
async function readManagedSkillVersion(sentinelPath, readFile) {
  try {
    const raw = await readFile(sentinelPath, 'utf8');
    return parseManagedSkillSentinel(raw).version;
  } catch {
    return null;
  }
}

/**
 * @param {McpClientName} clientName
 * @param {string} configPath
 * @param {(targetPath: string, encoding: BufferEncoding) => Promise<string>} readFile
 * @returns {Promise<{ configPath: string, configExists: boolean, configured: boolean }>}
 */
async function readBrowserBridgeMcpEntry(clientName, configPath, readFile) {
  try {
    const raw = await readFile(configPath, 'utf8');
    return {
      configPath,
      configExists: true,
      configured: parseInstalledMcpConfig(clientName, raw).configured
    };
  } catch {
    try {
      await readFile(configPath, 'utf8');
      return {
        configPath,
        configExists: true,
        configured: false
      };
    } catch {
      return {
        configPath,
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
