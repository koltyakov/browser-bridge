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

/**
 * Detect which MCP clients are installed on this machine.
 *
 * @returns {McpClientName[]}
 */
export function detectMcpClients() {
  /** @type {McpClientName[]} */
  const detected = [];
  if (detectCopilot()) detected.push('copilot');
  if (detectCodex()) detected.push('codex');
  if (detectCursor()) detected.push('cursor');
  if (detectClaude()) detected.push('claude');
  return detected;
}

/**
 * Detect which skill targets are installed on this machine.
 * Always includes 'agents' as a generic fallback.
 *
 * @returns {SupportedTarget[]}
 */
export function detectSkillTargets() {
  /** @type {SupportedTarget[]} */
  const detected = [];
  if (detectCopilot()) detected.push('copilot');
  if (detectCodex()) detected.push('codex');
  if (detectClaude()) detected.push('claude');
  if (detectOpencode()) detected.push('opencode');
  detected.push('agents');
  return detected;
}
