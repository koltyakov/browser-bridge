// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '../../..');
const managedSkillNames = /** @type {const} */ (['browser-bridge', 'browser-bridge-mcp']);
const managedSentinelFilename = '.browser-bridge-managed';
const supportedTargets = /** @type {const} */ (['copilot', 'claude', 'opencode', 'agents', 'codex']);
const targetAliases = /** @type {const} */ ({
  openai: 'codex'
});

/**
 * @typedef {'copilot' | 'claude' | 'opencode' | 'agents' | 'codex'} SupportedTarget
 */

/** @type {SupportedTarget[]} */
export const SUPPORTED_TARGETS = [...supportedTargets];

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
      throw new Error(`Unknown install-skill target "${value}". Supported targets: ${supportedTargets.join(', ')}, all. Alias: openai -> codex.`);
    }
    parsed.add(canonical);
  }

  return [...parsed];
}

/** @type {Partial<Record<SupportedTarget, string>>} */
const SKILL_PATHS = {
  copilot:  path.join('.github', 'skills'),
  claude:   path.join('.claude', 'skills'),
  opencode: path.join('.opencode', 'skills'),
  codex:    path.join('.codex', 'skills')
};

/**
 * @param {SupportedTarget} target
 * @returns {string}
 */
export function getSkillRelativePath(target) {
  return SKILL_PATHS[target] || path.join('.agents', 'skills');
}

/**
 * @param {SupportedTarget} target
 * @param {{ global: boolean, projectPath: string }} options
 * @returns {string}
 */
export function getSkillBasePath(target, options) {
  const basePath = options.global ? os.homedir() : options.projectPath;
  return path.join(basePath, getSkillRelativePath(target));
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
  await fs.promises.writeFile(sentinelPath, `${skillName} managed\n`, 'utf8');
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
