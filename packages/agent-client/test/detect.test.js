// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

/**
 * @param {string} homeDir
 * @returns {string}
 */
function getVsCodeUserDataDir(homeDir) {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    return path.join(appData, 'Code');
  }
  if (process.platform === 'linux') {
    return path.join(homeDir, '.config', 'Code');
  }
  return path.join(homeDir, 'Library', 'Application Support', 'Code');
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{ homeDir: string, existingPaths?: string[], availableCommands?: string[] }} options
 * @returns {Promise<{ detectMcpClients: () => string[], detectSkillTargets: () => string[], commandChecks: string[] }>}
 */
async function loadDetectModule(t, { homeDir, existingPaths = [], availableCommands = [] }) {
  const existing = new Set(existingPaths.map((candidate) => path.normalize(candidate)));
  const commands = new Set(availableCommands);
  /** @type {string[]} */
  const commandChecks = [];

  t.mock.method(os, 'homedir', () => homeDir);
  t.mock.method(fs, 'accessSync', (/** @type {import('node:fs').PathLike} */ candidate) => {
    if (existing.has(path.normalize(String(candidate)))) {
      return;
    }
    const error = new Error(`ENOENT: ${candidate}`);
    // @ts-expect-error emulate fs error shape for tests
    error.code = 'ENOENT';
    throw error;
  });
  t.mock.method(childProcess, 'execFileSync', (
    /** @type {string} */ _which,
    /** @type {readonly string[] | undefined} */ args
  ) => {
    const cmd = Array.isArray(args) ? String(args[0] ?? '') : '';
    commandChecks.push(cmd);
    if (commands.has(cmd)) {
      return Buffer.from('');
    }
    throw new Error(`command not found: ${cmd}`);
  });
  syncBuiltinESMExports();
  t.after(() => {
    syncBuiltinESMExports();
  });

  const detectModule = await import(
    `${new URL('../src/detect.js', import.meta.url).href}?case=${Date.now()}-${Math.random()}`
  );
  return {
    detectMcpClients: detectModule.detectMcpClients,
    detectSkillTargets: detectModule.detectSkillTargets,
    commandChecks
  };
}

test('default detectors honor filesystem markers before command lookup', async (t) => {
  const homeDir = path.join('/tmp', 'bbx-detect-home-fs');
  const existingPaths = [
    path.join(homeDir, '.codex'),
    path.join(homeDir, '.claude'),
    path.join(homeDir, '.cursor'),
    path.join(getVsCodeUserDataDir(homeDir), 'User'),
    path.join(homeDir, '.config', 'opencode'),
    path.join(homeDir, '.gemini', 'antigravity'),
    path.join(homeDir, '.codeium', 'windsurf')
  ];
  const detect = await loadDetectModule(t, { homeDir, existingPaths });

  assert.deepEqual(detect.detectMcpClients(), [
    'codex',
    'claude',
    'cursor',
    'copilot',
    'opencode',
    'antigravity',
    'windsurf'
  ]);
  assert.deepEqual(detect.detectSkillTargets(), [
    'codex',
    'claude',
    'cursor',
    'copilot',
    'opencode',
    'antigravity',
    'windsurf',
    'agents'
  ]);
  assert.deepEqual(detect.commandChecks, []);
});

test('default detectors honor alternate filesystem markers', async (t) => {
  const homeDir = path.join('/tmp', 'bbx-detect-home-alt');
  const existingPaths = [
    path.join(homeDir, '.vscode'),
    path.join(homeDir, '.claude.json'),
    path.join(homeDir, '.opencode')
  ];
  const detect = await loadDetectModule(t, { homeDir, existingPaths });

  assert.deepEqual(detect.detectMcpClients(), [
    'claude',
    'copilot',
    'opencode'
  ]);
  assert.deepEqual(detect.detectSkillTargets(), [
    'claude',
    'copilot',
    'opencode',
    'agents'
  ]);
  assert.deepEqual(
    detect.commandChecks,
    process.platform === 'darwin'
      ? ['codex', 'agy', 'codex', 'agy']
      : ['codex', 'cursor', 'agy', 'windsurf', 'codex', 'cursor', 'agy', 'windsurf']
  );
});

test('default detectors fall back to command lookup when markers are absent', async (t) => {
  const homeDir = path.join('/tmp', 'bbx-detect-home-cmd');
  const detect = await loadDetectModule(t, {
    homeDir,
    availableCommands: ['codex', 'code', 'agy']
  });

  assert.deepEqual(
    detect.detectMcpClients(),
    process.platform === 'linux'
      ? ['codex', 'copilot', 'antigravity']
      : ['codex', 'antigravity']
  );
  assert.deepEqual(
    detect.detectSkillTargets(),
    process.platform === 'linux'
      ? ['codex', 'copilot', 'antigravity', 'agents']
      : ['codex', 'antigravity', 'agents']
  );
  assert.deepEqual(
    detect.commandChecks,
    process.platform === 'darwin'
      ? ['codex', 'claude', 'opencode', 'agy', 'codex', 'claude', 'opencode', 'agy']
      : process.platform === 'linux'
        ? [
          'codex',
          'claude',
          'cursor',
          'code',
          'opencode',
          'agy',
          'windsurf',
          'codex',
          'claude',
          'cursor',
          'code',
          'opencode',
          'agy',
          'windsurf'
        ]
        : [
          'codex',
          'claude',
          'cursor',
          'opencode',
          'agy',
          'windsurf',
          'codex',
          'claude',
          'cursor',
          'opencode',
          'agy',
          'windsurf'
        ]
  );
});
