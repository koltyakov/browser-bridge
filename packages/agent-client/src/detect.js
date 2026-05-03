// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @typedef {import('./mcp-config.js').McpClientName} McpClientName */
/** @typedef {import('./install.js').SupportedTarget} SupportedTarget */
/** @typedef {() => boolean | Promise<boolean>} Detector */

const home = os.homedir();
const platform = process.platform;
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set(
  (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean)
);
const DEFAULT_COMMAND_NAMES =
  platform === 'darwin'
    ? ['codex', 'claude', 'opencode', 'agy']
    : platform === 'linux'
      ? ['codex', 'claude', 'cursor', 'code', 'opencode', 'agy', 'windsurf']
      : ['codex', 'claude', 'cursor', 'opencode', 'agy', 'windsurf'];

const PATH_DELIMITER = platform === 'win32' ? ';' : ':';

/** @type {Promise<Set<string>> | null} */
let availableCommandsPromise = null;

/**
 * @returns {string}
 */
function getVsCodeUserDataDir() {
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Code');
  }
  if (platform === 'linux') {
    return path.join(home, '.config', 'Code');
  }
  return path.join(home, 'Library', 'Application Support', 'Code');
}

/**
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
async function fsExists(targetPath) {
  try {
    await fs.promises.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} command
 * @returns {string}
 */
function normalizeCommandName(command) {
  return platform === 'win32' ? command.toLowerCase() : command;
}

/**
 * @param {string} entryName
 * @returns {string | null}
 */
function getCommandNameFromPathEntry(entryName) {
  if (platform !== 'win32') {
    return entryName;
  }

  const extension = path.extname(entryName).toLowerCase();
  if (!WINDOWS_EXECUTABLE_EXTENSIONS.has(extension)) {
    return null;
  }
  return entryName.slice(0, -extension.length).toLowerCase();
}

/**
 * @param {readonly string[]} commands
 * @returns {Promise<Set<string>>}
 */
async function resolveAvailableCommands(commands) {
  const resolved = new Set();
  const unresolved = new Set(commands.map((command) => normalizeCommandName(command)));
  const pathEntries = (process.env.PATH || '').split(PATH_DELIMITER).filter(Boolean);
  const executeAccessMode = platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;

  for (const directory of pathEntries) {
    if (unresolved.size === 0) {
      break;
    }

    let entries;
    try {
      entries = await fs.promises.readdir(directory);
    } catch {
      continue;
    }

    const matches = await Promise.all(
      entries.map(async (entryName) => {
        const commandName = getCommandNameFromPathEntry(entryName);
        if (!commandName || !unresolved.has(commandName)) {
          return null;
        }

        try {
          await fs.promises.access(path.join(directory, entryName), executeAccessMode);
          return commandName;
        } catch {
          return null;
        }
      })
    );

    for (const commandName of matches) {
      if (!commandName) {
        continue;
      }
      unresolved.delete(commandName);
      resolved.add(commandName);
    }
  }

  return resolved;
}

/**
 * @returns {Promise<Set<string>>}
 */
function getAvailableCommands() {
  if (!availableCommandsPromise) {
    availableCommandsPromise = resolveAvailableCommands(DEFAULT_COMMAND_NAMES);
  }
  return availableCommandsPromise;
}

/**
 * @param {string} command
 * @returns {Promise<boolean>}
 */
async function commandExists(command) {
  const availableCommands = await getAvailableCommands();
  return availableCommands.has(normalizeCommandName(command));
}

/** @returns {Promise<boolean>} */
async function detectCopilot() {
  if (await fsExists(path.join(getVsCodeUserDataDir(), 'User'))) return true;
  if (await fsExists(path.join(home, '.vscode'))) return true;
  if (platform === 'darwin') return fsExists('/Applications/Visual Studio Code.app');
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return fsExists(path.join(localAppData, 'Programs', 'Microsoft VS Code'));
  }
  return commandExists('code');
}

/** @returns {Promise<boolean>} */
async function detectCursor() {
  if (await fsExists(path.join(home, '.cursor'))) return true;
  if (platform === 'darwin') return fsExists('/Applications/Cursor.app');
  return commandExists('cursor');
}

/** @returns {Promise<boolean>} */
async function detectWindsurf() {
  if (await fsExists(path.join(home, '.codeium', 'windsurf'))) return true;
  if (platform === 'darwin') return fsExists('/Applications/Windsurf.app');
  return commandExists('windsurf');
}

/** @returns {Promise<boolean>} */
async function detectClaude() {
  if (await fsExists(path.join(home, '.claude'))) return true;
  if (await fsExists(path.join(home, '.claude.json'))) return true;
  return commandExists('claude');
}

/** @returns {Promise<boolean>} */
async function detectCodex() {
  if (await fsExists(path.join(home, '.codex'))) return true;
  return commandExists('codex');
}

/** @returns {Promise<boolean>} */
async function detectOpencode() {
  if (await fsExists(path.join(home, '.config', 'opencode'))) return true;
  if (await fsExists(path.join(home, '.opencode'))) return true;
  return commandExists('opencode');
}

/** @returns {Promise<boolean>} */
async function detectAntigravity() {
  if (await fsExists(path.join(home, '.gemini', 'antigravity'))) return true;
  return commandExists('agy');
}

/** @type {Record<string, Detector>} */
const DETECTORS = {
  codex: detectCodex,
  claude: detectClaude,
  cursor: detectCursor,
  copilot: detectCopilot,
  opencode: detectOpencode,
  antigravity: detectAntigravity,
  windsurf: detectWindsurf,
};

/** @type {McpClientName[]} */
const MCP_CLIENT_KEYS = [
  'codex',
  'claude',
  'cursor',
  'copilot',
  'opencode',
  'antigravity',
  'windsurf',
];

/** @type {SupportedTarget[]} */
const SKILL_TARGET_KEYS = [
  'codex',
  'claude',
  'cursor',
  'copilot',
  'opencode',
  'antigravity',
  'windsurf',
];

/**
 * @template {string} T
 * @param {readonly T[]} keys
 * @param {Record<string, Detector>} detectors
 * @returns {Promise<T[]>}
 */
async function detectTargets(keys, detectors) {
  const detectionResults = await Promise.all(
    keys.map(async (name) => ({
      name,
      detected: await (detectors[name]?.() ?? false),
    }))
  );
  return detectionResults.filter((entry) => entry.detected).map((entry) => entry.name);
}

/**
 * Detect which MCP clients are installed on this machine.
 *
 * @param {Record<string, Detector>} [detectors=DETECTORS]
 * @returns {Promise<McpClientName[]>}
 */
export async function detectMcpClients(detectors = DETECTORS) {
  return detectTargets(MCP_CLIENT_KEYS, detectors);
}

/**
 * Detect which skill targets are installed on this machine.
 * Always includes 'agents' as a generic fallback.
 *
 * @param {Record<string, Detector>} [detectors=DETECTORS]
 * @returns {Promise<SupportedTarget[]>}
 */
export async function detectSkillTargets(detectors = DETECTORS) {
  /** @type {SupportedTarget[]} */
  const detected = await detectTargets(SKILL_TARGET_KEYS, detectors);
  detected.push('agents');
  return detected;
}
