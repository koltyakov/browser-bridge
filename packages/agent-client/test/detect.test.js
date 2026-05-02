// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
 * @param {string} candidate
 * @returns {string}
 */
function normalizePath(candidate) {
  const normalized = path.normalize(candidate);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * @param {string} candidate
 * @returns {string}
 */
function getCommandName(candidate) {
  const parsed = path.parse(candidate).name;
  return process.platform === 'win32' ? parsed.toLowerCase() : parsed;
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{ homeDir: string, existingPaths?: string[], availableCommands?: string[] }} options
 * @returns {Promise<{ detectMcpClients: () => Promise<string[]>, detectSkillTargets: () => Promise<string[]>, commandChecks: string[] }>}
 */
async function loadDetectModule(t, { homeDir, existingPaths = [], availableCommands = [] }) {
  const binDir = path.join(homeDir, 'mock-bin');
  const commandExtension = process.platform === 'win32' ? '.CMD' : '';
  const existing = new Set(existingPaths.map((candidate) => normalizePath(candidate)));
  const commands = new Set(availableCommands.map((candidate) => getCommandName(candidate)));
  /** @type {string[]} */
  const commandChecks = [];

  for (const command of commands) {
    existing.add(normalizePath(path.join(binDir, `${command}${commandExtension}`)));
  }

  t.mock.method(os, 'homedir', () => homeDir);
  /** @param {string | Buffer | URL} directory */
  const mockReaddir = async (directory) => {
    if (normalizePath(String(directory)) === normalizePath(binDir)) {
      return [...commands].map((command) => `${command}${commandExtension}`);
    }
    const error = new Error(`ENOENT: ${directory}`);
    // @ts-expect-error emulate fs error shape for tests
    error.code = 'ENOENT';
    throw error;
  };
  /** @param {string | Buffer | URL} candidate */
  const mockAccess = async (candidate) => {
    const targetPath = normalizePath(String(candidate));
    if (targetPath.startsWith(`${normalizePath(binDir)}${path.sep}`)) {
      commandChecks.push(getCommandName(targetPath));
    }
    if (existing.has(targetPath)) {
      return;
    }
    const error = new Error(`ENOENT: ${candidate}`);
    // @ts-expect-error emulate fs error shape for tests
    error.code = 'ENOENT';
    throw error;
  };
  t.mock.method(fs.promises, 'readdir', mockReaddir);
  t.mock.method(fs.promises, 'access', mockAccess);

  const originalPath = process.env.PATH;
  const originalPathext = process.env.PATHEXT;
  process.env.PATH = binDir;
  process.env.PATHEXT = '.CMD;.EXE;.BAT;.COM';
  t.after(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalPathext === undefined) {
      delete process.env.PATHEXT;
    } else {
      process.env.PATHEXT = originalPathext;
    }
  });

  const detectModule = await import(
    `${new URL('../src/detect.js', import.meta.url).href}?case=${Date.now()}-${Math.random()}`
  );
  return {
    detectMcpClients: detectModule.detectMcpClients,
    detectSkillTargets: detectModule.detectSkillTargets,
    commandChecks,
  };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{
 *   platform: NodeJS.Platform,
 *   pathValue: string,
 *   directoryEntries?: Record<string, string[]>,
 *   readdirFailures?: string[],
 *   inaccessibleEntries?: Record<string, string[]>,
 * }} options
 * @returns {Promise<typeof import('../src/detect.js') & { commandChecks: string[], readdirStarts: Map<string, number> }>}
 */
async function loadDetectModuleForPlatform(
  t,
  { platform, pathValue, directoryEntries = {}, readdirFailures = [], inaccessibleEntries = {} }
) {
  /** @type {string[]} */
  const commandChecks = [];
  /** @type {Map<string, number>} */
  const readdirStarts = new Map();
  const pathEntries = pathValue
    .split(platform === 'win32' ? ';' : ':')
    .filter(Boolean)
    .map((entry) => path.normalize(entry).toLowerCase());
  const pathEntrySet = new Set(pathEntries);
  const normalizedDirectoryEntries = new Map(
    Object.entries(directoryEntries).map(([directory, entries]) => [
      path.normalize(directory).toLowerCase(),
      entries.map((entry) => entry.toLowerCase()),
    ])
  );
  const normalizedReaddirFailures = new Set(
    readdirFailures.map((directory) => path.normalize(directory).toLowerCase())
  );
  const normalizedInaccessibleEntries = new Map(
    Object.entries(inaccessibleEntries).map(([directory, entries]) => [
      path.normalize(directory).toLowerCase(),
      new Set(entries.map((entry) => entry.toLowerCase())),
    ])
  );

  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
  t.after(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  t.mock.method(os, 'homedir', () => path.join('/tmp', `bbx-detect-${platform}`));
  /** @param {string | Buffer | URL} directory */
  const mockReaddir = async (directory) => {
    const normalizedDirectory = path.normalize(String(directory)).toLowerCase();
    readdirStarts.set(normalizedDirectory, Date.now());
    if (normalizedReaddirFailures.has(normalizedDirectory)) {
      const error = new Error(`EACCES: ${directory}`);
      // @ts-expect-error emulate fs error shape for tests
      error.code = 'EACCES';
      throw error;
    }
    if (normalizedDirectoryEntries.has(normalizedDirectory)) {
      return normalizedDirectoryEntries.get(normalizedDirectory) ?? [];
    }
    if (pathEntrySet.has(normalizedDirectory)) {
      return [];
    }
    const error = new Error(`ENOENT: ${directory}`);
    // @ts-expect-error emulate fs error shape for tests
    error.code = 'ENOENT';
    throw error;
  };
  /** @param {string | Buffer | URL} candidate */
  const mockAccess = async (candidate) => {
    const normalizedCandidate = path.normalize(String(candidate)).toLowerCase();
    const normalizedDirectory = path.dirname(normalizedCandidate);
    const entryName = path.basename(normalizedCandidate);
    if (pathEntrySet.has(normalizedDirectory)) {
      commandChecks.push(platform === 'win32' ? path.parse(entryName).name : entryName);
    }
    if (normalizedInaccessibleEntries.get(normalizedDirectory)?.has(entryName)) {
      const error = new Error(`EACCES: ${candidate}`);
      // @ts-expect-error emulate fs error shape for tests
      error.code = 'EACCES';
      throw error;
    }
    if ((normalizedDirectoryEntries.get(normalizedDirectory) ?? []).includes(entryName)) {
      return;
    }
    const error = new Error(`ENOENT: ${candidate}`);
    // @ts-expect-error emulate fs error shape for tests
    error.code = 'ENOENT';
    throw error;
  };
  t.mock.method(fs.promises, 'readdir', mockReaddir);
  t.mock.method(fs.promises, 'access', mockAccess);

  const originalPath = process.env.PATH;
  const originalPathext = process.env.PATHEXT;
  process.env.PATH = pathValue;
  process.env.PATHEXT = '.CMD;.EXE;.BAT;.COM';
  t.after(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalPathext === undefined) {
      delete process.env.PATHEXT;
    } else {
      process.env.PATHEXT = originalPathext;
    }
  });

  const detectModule = await import(
    `${new URL('../src/detect.js', import.meta.url).href}?platform-case=${Date.now()}-${Math.random()}`
  );
  return {
    ...detectModule,
    commandChecks,
    readdirStarts,
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
    path.join(homeDir, '.codeium', 'windsurf'),
  ];
  const detect = await loadDetectModule(t, { homeDir, existingPaths });

  assert.deepEqual(await detect.detectMcpClients(), [
    'codex',
    'claude',
    'cursor',
    'copilot',
    'opencode',
    'antigravity',
    'windsurf',
  ]);
  assert.deepEqual(await detect.detectSkillTargets(), [
    'codex',
    'claude',
    'cursor',
    'copilot',
    'opencode',
    'antigravity',
    'windsurf',
    'agents',
  ]);
  assert.deepEqual(detect.commandChecks, []);
});

test('default detectors honor alternate filesystem markers', async (t) => {
  const homeDir = path.join('/tmp', 'bbx-detect-home-alt');
  const existingPaths = [
    path.join(homeDir, '.vscode'),
    path.join(homeDir, '.claude.json'),
    path.join(homeDir, '.opencode'),
  ];
  const detect = await loadDetectModule(t, { homeDir, existingPaths });

  assert.deepEqual(await detect.detectMcpClients(), ['claude', 'copilot', 'opencode']);
  assert.deepEqual(await detect.detectSkillTargets(), ['claude', 'copilot', 'opencode', 'agents']);
  assert.deepEqual(detect.commandChecks, []);
});

test('default detectors fall back to command lookup when markers are absent', async (t) => {
  const homeDir = path.join('/tmp', 'bbx-detect-home-cmd');
  const detect = await loadDetectModule(t, {
    homeDir,
    availableCommands: ['codex', 'code', 'agy'],
  });

  assert.deepEqual(
    await detect.detectMcpClients(),
    process.platform === 'linux' ? ['codex', 'copilot', 'antigravity'] : ['codex', 'antigravity']
  );
  assert.deepEqual(
    await detect.detectSkillTargets(),
    process.platform === 'linux'
      ? ['codex', 'copilot', 'antigravity', 'agents']
      : ['codex', 'antigravity', 'agents']
  );
  assert.deepEqual(
    detect.commandChecks,
    process.platform === 'linux' ? ['codex', 'code', 'agy'] : ['codex', 'agy']
  );
});

test('detectors run concurrently when detectMcpClients resolves target table', async (_) => {
  /** @type {number[]} */
  const starts = [];
  /** @type {Record<string, () => Promise<boolean>>} */
  const detectors = {};
  for (const name of [
    'codex',
    'claude',
    'cursor',
    'copilot',
    'opencode',
    'antigravity',
    'windsurf',
  ]) {
    detectors[name] = async () => {
      starts.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 25));
      return name === 'codex' || name === 'copilot';
    };
  }

  const { detectMcpClients } = await import(
    `${new URL('../src/detect.js', import.meta.url).href}?concurrency-case=${Date.now()}-${Math.random()}`
  );
  const detected = await detectMcpClients(detectors);

  assert.deepEqual(detected, ['codex', 'copilot']);
  assert.equal(starts.length, 7);
  assert.ok(Math.max(...starts) - Math.min(...starts) < 15);
});

test('commandExists reuses cached PATH scan across repeated detector calls', async (t) => {
  const detect = await loadDetectModuleForPlatform(t, {
    platform: 'linux',
    pathValue: '/mock/bin:/mock/tools',
    directoryEntries: {
      '/mock/bin': ['codex'],
    },
  });

  assert.deepEqual(await detect.detectMcpClients(), ['codex']);
  const readdirStartsAfterFirstCall = new Map(detect.readdirStarts);

  assert.deepEqual(await detect.detectMcpClients(), ['codex']);
  assert.deepEqual(detect.readdirStarts, readdirStartsAfterFirstCall);
  assert.deepEqual(detect.commandChecks, ['codex']);
});

test('command detection respects POSIX and Windows PATH delimiters', async (t) => {
  /** @type {Array<{
   *   name: string,
   *   platform: NodeJS.Platform,
   *   pathValue: string,
   *   directoryEntries: Record<string, string[]>,
   *   expectedClients: string[],
   *   expectedDirectories: string[]
   * }>} */
  const testCases = [
    {
      name: 'posix delimiter',
      platform: /** @type {const} */ ('linux'),
      pathValue: '/mock/bin:/mock/tools',
      directoryEntries: {
        '/mock/bin': ['codex'],
        '/mock/tools': ['code'],
      },
      expectedClients: ['codex', 'copilot'],
      expectedDirectories: ['/mock/bin', '/mock/tools'],
    },
    {
      name: 'windows delimiter',
      platform: /** @type {const} */ ('win32'),
      pathValue: 'C:\\Mock\\Bin;D:\\Mock\\Tools',
      directoryEntries: {
        'C:\\Mock\\Bin': [],
        'D:\\Mock\\Tools': ['codex.cmd'],
      },
      expectedClients: ['codex'],
      expectedDirectories: ['c:\\mock\\bin', 'd:\\mock\\tools'],
    },
  ];

  for (const testCase of testCases) {
    await t.test(testCase.name, async (innerT) => {
      const detect = await loadDetectModuleForPlatform(innerT, testCase);

      assert.deepEqual(await detect.detectMcpClients(), testCase.expectedClients);
      assert.deepEqual([...detect.readdirStarts.keys()], testCase.expectedDirectories);
    });
  }
});

test('windows command detection ignores non-executable extensions', async (t) => {
  const detect = await loadDetectModuleForPlatform(t, {
    platform: 'win32',
    pathValue: 'C:\\Mock\\Bin',
    directoryEntries: {
      'C:\\Mock\\Bin': ['codex.txt', 'claude.exe'],
    },
  });

  assert.deepEqual(await detect.detectMcpClients(), ['claude']);
  assert.deepEqual(detect.commandChecks, ['claude']);
});

test('command detection stops scanning PATH once every command is resolved', async (t) => {
  const detect = await loadDetectModuleForPlatform(t, {
    platform: 'linux',
    pathValue: '/mock/bin:/mock/tools:/mock/unused',
    directoryEntries: {
      '/mock/bin': ['codex', 'claude', 'cursor', 'code', 'opencode', 'agy', 'windsurf'],
      '/mock/tools': ['codex'],
      '/mock/unused': ['codex'],
    },
  });

  assert.deepEqual(await detect.detectMcpClients(), [
    'codex',
    'claude',
    'cursor',
    'copilot',
    'opencode',
    'antigravity',
    'windsurf',
  ]);
  assert.deepEqual([...detect.readdirStarts.keys()], ['/mock/bin']);
});

test('command detection skips unreadable PATH entries', async (t) => {
  const detect = await loadDetectModuleForPlatform(t, {
    platform: 'linux',
    pathValue: '/mock/denied:/mock/bin',
    directoryEntries: {
      '/mock/bin': ['codex'],
    },
    readdirFailures: ['/mock/denied'],
  });

  assert.deepEqual(await detect.detectMcpClients(), ['codex']);
  assert.deepEqual([...detect.readdirStarts.keys()], ['/mock/denied', '/mock/bin']);
  assert.deepEqual(detect.commandChecks, ['codex']);
});

test('command detection skips inaccessible executables and keeps scanning', async (t) => {
  const detect = await loadDetectModuleForPlatform(t, {
    platform: 'linux',
    pathValue: '/mock/bin:/mock/fallback',
    directoryEntries: {
      '/mock/bin': ['codex'],
      '/mock/fallback': ['codex'],
    },
    inaccessibleEntries: {
      '/mock/bin': ['codex'],
    },
  });

  assert.deepEqual(await detect.detectMcpClients(), ['codex']);
  assert.deepEqual(detect.commandChecks, ['codex', 'codex']);
});
