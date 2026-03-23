// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '../../..');
const managedSkillNames = /** @type {const} */ (['browser-bridge', 'browser-bridge-mcp']);
const managedSentinelFilename = '.browser-bridge-managed';
const supportedTargets = /** @type {const} */ ([
  'copilot',
  'claude',
  'cursor',
  'windsurf',
  'opencode',
  'antigravity',
  'agents',
  'codex'
]);
const targetAliases = /** @type {const} */ ({
  openai: 'codex',
  google: 'antigravity'
});

const packageManifest = loadPackageManifest();
const managedPackageName = typeof packageManifest.name === 'string' ? packageManifest.name : '@browserbridge/bbx';
const managedPackageVersion = typeof packageManifest.version === 'string' ? packageManifest.version : null;

/**
 * @typedef {'copilot' | 'claude' | 'cursor' | 'windsurf' | 'opencode' | 'antigravity' | 'agents' | 'codex'} SupportedTarget
 */

/** @type {SupportedTarget[]} */
export const SUPPORTED_TARGETS = [...supportedTargets];

/**
 * @param {string} value
 * @returns {value is SupportedTarget}
 */
export function isSupportedTarget(value) {
  return supportedTargets.includes(/** @type {SupportedTarget} */ (value));
}

/**
 * @typedef {{targets: SupportedTarget[], projectPath: string, global: boolean}} InstallAgentOptions
 */

/**
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {InstallAgentOptions}
 */
export function parseInstallAgentArgs(args, cwd = process.cwd()) {
  /** @type {SupportedTarget[]} */
  let targets = [...supportedTargets];
  let projectPath = cwd;
  let isGlobal = true; // default to global install

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--agents' || arg === '--agent') {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Usage: install-skill [targets|all] [--project <path>]`);
      }
      targets = parseTargetList(value);
      index += 1;
      continue;
    }

    if (arg.startsWith('--agents=')) {
      targets = parseTargetList(arg.slice('--agents='.length));
      continue;
    }

    if (arg.startsWith('--agent=')) {
      targets = parseTargetList(arg.slice('--agent='.length));
      continue;
    }

    if (arg === '--project') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('Usage: install-skill [targets|all] [--project <path>] [--global]');
      }
      projectPath = path.resolve(cwd, value);
      isGlobal = false;
      index += 1;
      continue;
    }

    if (arg.startsWith('--project=')) {
      projectPath = path.resolve(cwd, arg.slice('--project='.length));
      isGlobal = false;
      continue;
    }

    if (arg === '--global') {
      isGlobal = true;
      continue;
    }

    if (arg === '--local') {
      isGlobal = false;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown install-skill option "${arg}".`);
    }

    if (index > 0) {
      throw new Error(`Unexpected extra argument "${arg}".`);
    }
    targets = parseTargetList(arg);
  }

  return {
    targets,
    projectPath,
    global: isGlobal
  };
}

/**
 * @param {InstallAgentOptions} options
 * @returns {Promise<string[]>}
 */
export async function installAgentFiles(options) {
  /** @type {string[]} */
  const created = [];
  /** @type {Set<string>} */
  const seenTargets = new Set();

  for (const target of options.targets) {
    const skillBaseDir = getSkillBasePath(target, options);

    for (const skillName of managedSkillNames) {
      const skillTargetDir = path.join(skillBaseDir, skillName);
      if (seenTargets.has(skillTargetDir)) {
        continue;
      }
      seenTargets.add(skillTargetDir);
      await installManagedSkill(skillName, skillTargetDir);
      created.push(skillTargetDir);
    }
  }

  return created;
}

/**
 * @param {InstallAgentOptions} options
 * @returns {Promise<SupportedTarget[]>}
 */
export async function findInstalledManagedTargets(options) {
  /** @type {SupportedTarget[]} */
  const installedTargets = [];

  for (const target of options.targets) {
    if (await hasManagedSkillInstall(target, options)) {
      installedTargets.push(target);
    }
  }

  return installedTargets;
}

/**
 * Remove only Browser Bridge-managed skill directories for the given targets.
 * Unmanaged custom skill folders are preserved.
 *
 * @param {InstallAgentOptions} options
 * @returns {Promise<string[]>}
 */
export async function removeAgentFiles(options) {
  /** @type {string[]} */
  const removed = [];
  /** @type {Set<string>} */
  const seenTargets = new Set();

  for (const target of options.targets) {
    const skillBaseDir = getSkillBasePath(target, options);

    for (const skillName of managedSkillNames) {
      const skillTargetDir = path.join(skillBaseDir, skillName);
      if (seenTargets.has(skillTargetDir)) {
        continue;
      }
      seenTargets.add(skillTargetDir);
      if (!(await isManagedSkillInstall(skillTargetDir))) {
        continue;
      }
      await fs.promises.rm(skillTargetDir, { recursive: true, force: true });
      removed.push(skillTargetDir);
    }
  }

  return removed;
}

/**
 * @param {string} raw
 * @returns {SupportedTarget[]}
 */
function parseTargetList(raw) {
  const input = raw.trim();
  if (!input) {
    throw new Error('Target list cannot be empty.');
  }

  const values = input.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (values.includes('all')) {
    return [...supportedTargets];
  }

  /** @type {Set<SupportedTarget>} */
  const parsed = new Set();
  for (const value of values) {
    const canonical = /** @type {SupportedTarget | undefined} */ (
      supportedTargets.includes(/** @type {SupportedTarget} */ (value))
        ? value
        : targetAliases[/** @type {keyof typeof targetAliases} */ (value)]
    );
    if (!canonical) {
      throw new Error(`Unknown install-skill target "${value}". Supported targets: ${supportedTargets.join(', ')}, all. Aliases: openai -> codex, google -> antigravity.`);
    }
    parsed.add(canonical);
  }

  return [...parsed];
}

/** @type {Partial<Record<SupportedTarget, string>>} */
const GLOBAL_SKILL_PATHS = {
  copilot:  path.join('.copilot', 'skills'),
  claude:   path.join('.claude', 'skills'),
  cursor:   path.join('.cursor', 'skills'),
  windsurf: path.join('.codeium', 'windsurf', 'skills'),
  opencode: path.join('.opencode', 'skills'),
  antigravity: path.join('.gemini', 'antigravity', 'skills'),
  codex:    path.join('.codex', 'skills')
};

/** @type {Partial<Record<SupportedTarget, string>>} */
const LOCAL_SKILL_PATHS = {
  copilot:  path.join('.github', 'skills'),
  claude:   path.join('.claude', 'skills'),
  cursor:   path.join('.cursor', 'skills'),
  windsurf: path.join('.windsurf', 'skills'),
  opencode: path.join('.opencode', 'skills'),
  antigravity: path.join('.agents', 'skills'),
  codex:    path.join('.codex', 'skills')
};

/**
 * @param {SupportedTarget} target
 * @param {{ global: boolean }} options
 * @returns {string}
 */
export function getSkillRelativePath(target, options) {
  const paths = options.global ? GLOBAL_SKILL_PATHS : LOCAL_SKILL_PATHS;
  return paths[target] || path.join('.agents', 'skills');
}

/**
 * @param {SupportedTarget} target
 * @param {{ global: boolean, projectPath: string }} options
 * @returns {string}
 */
export function getSkillBasePath(target, options) {
  const basePath = options.global ? os.homedir() : options.projectPath;
  return path.join(basePath, getSkillRelativePath(target, options));
}

/**
 * @returns {string[]}
 */
export function getManagedSkillNames() {
  return [...managedSkillNames];
}

/**
 * @returns {string}
 */
export function getManagedSkillSentinelFilename() {
  return managedSentinelFilename;
}

/**
 * @returns {string | null}
 */
export function getManagedPackageVersion() {
  return managedPackageVersion;
}

/**
 * @param {string} skillName
 * @returns {string}
 */
export function formatManagedSkillSentinel(skillName) {
  return `${JSON.stringify({
    skill: skillName,
    managedBy: managedPackageName,
    version: managedPackageVersion
  }, null, 2)}\n`;
}

/**
 * @param {string} raw
 * @returns {{ managed: boolean, version: string | null }}
 */
export function parseManagedSkillSentinel(raw) {
  const text = raw.trim();
  if (!text) {
    return { managed: true, version: null };
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        managed: true,
        version: typeof parsed.version === 'string' ? parsed.version : null
      };
    }
  } catch {
    // Legacy sentinel contents were plain text. Treat them as managed but unversioned.
  }

  return { managed: true, version: null };
}

/**
 * @param {string | null} installedVersion
 * @param {string | null} [currentVersion=managedPackageVersion]
 * @returns {boolean}
 */
export function isManagedVersionOutdated(installedVersion, currentVersion = managedPackageVersion) {
  if (!currentVersion) {
    return false;
  }
  if (!installedVersion) {
    return true;
  }
  return compareSemver(installedVersion, currentVersion) < 0;
}

/**
 * @param {string} skillName
 * @param {string} targetDir
 * @returns {Promise<void>}
 */
async function installManagedSkill(skillName, targetDir) {
  const sourceDir = path.join(packageRoot, 'skills', skillName);
  const sentinelPath = path.join(targetDir, managedSentinelFilename);
  const targetExists = await pathExists(targetDir);

  if (targetExists && !(await pathExists(sentinelPath))) {
    throw new Error(`Refusing to overwrite unmanaged skill directory: ${targetDir}`);
  }

  await fs.promises.rm(targetDir, { recursive: true, force: true });
  await copyDir(sourceDir, targetDir);
  await fs.promises.writeFile(sentinelPath, formatManagedSkillSentinel(skillName), 'utf8');
}

/**
 * @param {SupportedTarget} target
 * @param {{ global: boolean, projectPath: string }} options
 * @returns {Promise<boolean>}
 */
async function hasManagedSkillInstall(target, options) {
  const skillBaseDir = getSkillBasePath(target, options);
  for (const skillName of managedSkillNames) {
    if (await isManagedSkillInstall(path.join(skillBaseDir, skillName))) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} targetDir
 * @returns {Promise<boolean>}
 */
async function isManagedSkillInstall(targetDir) {
  if (!(await pathExists(targetDir))) {
    return false;
  }
  return pathExists(path.join(targetDir, managedSentinelFilename));
}

/**
 * @param {string} sourceDir
 * @param {string} targetDir
 * @returns {Promise<void>}
 */
async function copyDir(sourceDir, targetDir) {
  await fs.promises.mkdir(targetDir, { recursive: true });
  const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, targetPath);
      continue;
    }
    await fs.promises.copyFile(sourcePath, targetPath);
  }
}

/**
 * @returns {{ name?: unknown, version?: unknown }}
 */
function loadPackageManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareSemver(left, right) {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);

  for (let index = 0; index < 3; index += 1) {
    const diff = leftParts.core[index] - rightParts.core[index];
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }

  if (leftParts.prerelease === rightParts.prerelease) {
    return 0;
  }
  if (!leftParts.prerelease) {
    return 1;
  }
  if (!rightParts.prerelease) {
    return -1;
  }
  return leftParts.prerelease < rightParts.prerelease ? -1 : 1;
}

/**
 * @param {string} value
 * @returns {{ core: [number, number, number], prerelease: string }}
 */
function parseSemver(value) {
  const normalized = value.trim().replace(/^v/i, '');
  const [corePart, prerelease = ''] = normalized.split('-', 2);
  const parts = corePart.split('.');
  return {
    core: [
      Number.parseInt(parts[0] || '0', 10) || 0,
      Number.parseInt(parts[1] || '0', 10) || 0,
      Number.parseInt(parts[2] || '0', 10) || 0
    ],
    prerelease
  };
}

/**
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
async function pathExists(targetPath) {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
