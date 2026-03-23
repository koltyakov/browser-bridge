// @ts-check

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @typedef {import('./mcp-config.js').McpClientName} McpClientName */
/** @typedef {import('./install.js').SupportedTarget} SupportedTarget */

const home = os.homedir();
const platform = process.platform;

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
 * @param {string} p
 * @returns {boolean}
 */
function fsExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} cmd
 * @returns {boolean}
 */
function commandExists(cmd) {
  try {
    execFileSync(platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** @returns {boolean} */
function detectCopilot() {
  if (fsExists(path.join(getVsCodeUserDataDir(), 'User'))) return true;
  if (fsExists(path.join(home, '.vscode'))) return true;
  if (platform === 'darwin') return fsExists('/Applications/Visual Studio Code.app');
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return fsExists(path.join(localAppData, 'Programs', 'Microsoft VS Code'));
  }
  return commandExists('code');
}

/** @returns {boolean} */
function detectCursor() {
  if (fsExists(path.join(home, '.cursor'))) return true;
  if (platform === 'darwin') return fsExists('/Applications/Cursor.app');
  return commandExists('cursor');
}

/** @returns {boolean} */
function detectWindsurf() {
  if (fsExists(path.join(home, '.codeium', 'windsurf'))) return true;
  if (platform === 'darwin') return fsExists('/Applications/Windsurf.app');
  return commandExists('windsurf');
}

/** @returns {boolean} */
function detectClaude() {
  if (fsExists(path.join(home, '.claude'))) return true;
  if (fsExists(path.join(home, '.claude.json'))) return true;
  return commandExists('claude');
}

/** @returns {boolean} */
function detectCodex() {
  if (fsExists(path.join(home, '.codex'))) return true;
  return commandExists('codex');
}

/** @returns {boolean} */
function detectOpencode() {
  if (fsExists(path.join(home, '.config', 'opencode'))) return true;
  if (fsExists(path.join(home, '.opencode'))) return true;
  return commandExists('opencode');
}

/** @returns {boolean} */
function detectAntigravity() {
  if (fsExists(path.join(home, '.gemini', 'antigravity'))) return true;
  return commandExists('agy');
}

/** @type {Record<string, () => boolean>} */
const DETECTORS = {
  codex: detectCodex,
  claude: detectClaude,
  cursor: detectCursor,
  copilot: detectCopilot,
  opencode: detectOpencode,
  antigravity: detectAntigravity,
  windsurf: detectWindsurf
};

/** @type {McpClientName[]} */
const MCP_CLIENT_KEYS = ['codex', 'claude', 'cursor', 'copilot', 'opencode', 'antigravity', 'windsurf'];

/** @type {SupportedTarget[]} */
const SKILL_TARGET_KEYS = ['codex', 'claude', 'cursor', 'copilot', 'opencode', 'antigravity', 'windsurf'];

/**
 * Detect which MCP clients are installed on this machine.
 *
 * @param {Record<string, () => boolean>} [detectors=DETECTORS]
 * @returns {McpClientName[]}
 */
export function detectMcpClients(detectors = DETECTORS) {
  return MCP_CLIENT_KEYS.filter(name => detectors[name]());
}

/**
 * Detect which skill targets are installed on this machine.
 * Always includes 'agents' as a generic fallback.
 *
 * @param {Record<string, () => boolean>} [detectors=DETECTORS]
 * @returns {SupportedTarget[]}
 */
export function detectSkillTargets(detectors = DETECTORS) {
  /** @type {SupportedTarget[]} */
  const detected = SKILL_TARGET_KEYS.filter(name => detectors[name]());
  detected.push('agents');
  return detected;
}
