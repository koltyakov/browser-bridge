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
function detectClaude() {
  if (platform === 'darwin') {
    return fsExists(path.join(home, 'Library', 'Application Support', 'Claude'));
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return fsExists(path.join(appData, 'Claude'));
  }
  return fsExists(path.join(home, '.config', 'Claude'));
}

/** @returns {boolean} */
function detectCodex() {
  if (fsExists(path.join(home, '.codex'))) return true;
  return commandExists('codex');
}

/** @returns {boolean} */
function detectOpencode() {
  if (fsExists(path.join(home, '.opencode'))) return true;
  return commandExists('opencode');
}

/** @type {Record<string, () => boolean>} */
const DETECTORS = {
  copilot: detectCopilot,
  cursor: detectCursor,
  claude: detectClaude,
  codex: detectCodex,
  opencode: detectOpencode
};

/** @type {McpClientName[]} */
const MCP_CLIENT_KEYS = ['copilot', 'codex', 'cursor', 'claude'];

/** @type {SupportedTarget[]} */
const SKILL_TARGET_KEYS = ['copilot', 'codex', 'claude', 'opencode'];

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
