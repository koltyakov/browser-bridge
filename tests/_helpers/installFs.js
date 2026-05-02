// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SUPPORTED_TARGETS,
  getCoreManagedSkillName,
  getManagedSkillSentinelFilename,
  getSkillRelativePath,
} from '../../packages/agent-client/src/install.js';
import { MCP_CLIENT_NAMES } from '../../packages/agent-client/src/mcp-config.js';
import {
  APP_NAME,
  BRIDGE_HOME_ENV,
  SUPPORTED_BROWSERS,
  getLauncherFilename,
} from '../../packages/native-host/src/config.js';

/** @typedef {import('../../packages/agent-client/src/install.js').SupportedTarget} SupportedTarget */
/** @typedef {import('../../packages/agent-client/src/mcp-config.js').McpClientName} McpClientName */
/** @typedef {import('../../packages/native-host/src/config.js').SupportedBrowser} SupportedBrowser */

/**
 * @typedef {{
 *   baseDir: string,
 *   skillDir: string,
 *   skillFile: string,
 *   sentinelFile: string,
 * }} SkillPathSet
 */

/**
 * @typedef {{
 *   primaryConfigPath: string,
 *   configPaths: string[],
 * }} McpPathSet
 */

/**
 * @typedef {{
 *   installDir: string,
 *   manifestPath: string,
 * }} BrowserManifestPathSet
 */

/**
 * @typedef {{
 *   root: string,
 *   home: string,
 *   cwd: string,
 *   binDir: string,
 *   bridgeHome: string,
 *   localAppData: string,
 *   appData: string,
 *   codexHome: string,
 *   env: NodeJS.ProcessEnv,
 *   launcherPath: string,
 *   globalSkillTargets: Record<SupportedTarget, SkillPathSet>,
 *   localSkillTargets: Record<SupportedTarget, SkillPathSet>,
 *   globalMcpClients: Record<McpClientName, McpPathSet>,
 *   localMcpClients: Record<McpClientName, McpPathSet>,
 *   browserManifests: Record<SupportedBrowser, BrowserManifestPathSet>,
 *   cleanup: () => Promise<void>,
 * }} InstallFs
 */

/**
 * @param {{ home: string, appData: string }} options
 * @returns {string}
 */
function getVsCodeUserDir({ home, appData }) {
  if (process.platform === 'win32') {
    return path.join(appData, 'Code', 'User');
  }
  if (process.platform === 'linux') {
    return path.join(home, '.config', 'Code', 'User');
  }
  return path.join(home, 'Library', 'Application Support', 'Code', 'User');
}

/**
 * @param {SupportedBrowser} browser
 * @param {{ home: string, localAppData: string }} options
 * @returns {string}
 */
function getManifestInstallDirForTest(browser, { home, localAppData }) {
  if (process.platform === 'darwin') {
    const macBase = path.join(home, 'Library', 'Application Support');
    const macPaths = {
      chrome: path.join(macBase, 'Google', 'Chrome', 'NativeMessagingHosts'),
      edge: path.join(macBase, 'Microsoft Edge', 'NativeMessagingHosts'),
      brave: path.join(macBase, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
      chromium: path.join(macBase, 'Chromium', 'NativeMessagingHosts'),
      arc: path.join(macBase, 'Arc', 'User Data', 'NativeMessagingHosts'),
    };
    return macPaths[browser];
  }

  if (process.platform === 'win32') {
    const winPaths = {
      chrome: path.join(localAppData, 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts'),
      edge: path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'NativeMessagingHosts'),
      brave: path.join(
        localAppData,
        'BraveSoftware',
        'Brave-Browser',
        'User Data',
        'NativeMessagingHosts'
      ),
      chromium: path.join(localAppData, 'Chromium', 'User Data', 'NativeMessagingHosts'),
      arc: path.join(localAppData, 'Arc', 'User Data', 'NativeMessagingHosts'),
    };
    return winPaths[browser];
  }

  const linuxPaths = {
    chrome: path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts'),
    edge: path.join(home, '.config', 'microsoft-edge', 'NativeMessagingHosts'),
    brave: path.join(home, '.config', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
    chromium: path.join(home, '.config', 'chromium', 'NativeMessagingHosts'),
    arc: path.join(home, '.config', 'Arc', 'User Data', 'NativeMessagingHosts'),
  };
  return linuxPaths[browser];
}

/**
 * @param {SupportedTarget} target
 * @param {{ home: string, cwd: string, global: boolean }} options
 * @returns {SkillPathSet}
 */
function buildSkillPathSet(target, { home, cwd, global: isGlobal }) {
  const baseRoot = isGlobal ? home : cwd;
  const baseDir = path.join(baseRoot, getSkillRelativePath(target, { global: isGlobal }));
  const skillDir = path.join(baseDir, getCoreManagedSkillName());

  return {
    baseDir,
    skillDir,
    skillFile: path.join(skillDir, 'SKILL.md'),
    sentinelFile: path.join(skillDir, getManagedSkillSentinelFilename()),
  };
}

/**
 * @param {McpClientName} clientName
 * @param {{ home: string, cwd: string, appData: string, codexHome: string, global: boolean }} options
 * @returns {McpPathSet}
 */
function buildMcpPathSet(clientName, { home, cwd, appData, codexHome, global: isGlobal }) {
  if (!isGlobal) {
    const localPaths = {
      copilot: path.join(cwd, '.vscode', 'mcp.json'),
      codex: path.join(cwd, '.codex', 'config.toml'),
      cursor: path.join(cwd, '.cursor', 'mcp.json'),
      windsurf: path.join(cwd, '.windsurf', 'mcp_config.json'),
      claude: path.join(cwd, '.mcp.json'),
      opencode: path.join(cwd, 'opencode.json'),
      antigravity: path.join(cwd, '.agents', 'mcp_config.json'),
      agents: path.join(cwd, '.agents', 'mcp.json'),
    };
    const primaryConfigPath = localPaths[clientName];
    return {
      primaryConfigPath,
      configPaths: [primaryConfigPath],
    };
  }

  const primaryPaths = {
    claude: path.join(home, '.claude.json'),
    copilot: path.join(home, '.copilot', 'mcp-config.json'),
    codex: path.join(codexHome, 'config.toml'),
    cursor: path.join(home, '.cursor', 'mcp.json'),
    opencode: path.join(home, '.config', 'opencode', 'opencode.json'),
    antigravity: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
    windsurf: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    agents: path.join(home, '.agents', 'mcp.json'),
  };
  const primaryConfigPath = primaryPaths[clientName];

  if (clientName === 'copilot') {
    return {
      primaryConfigPath,
      configPaths: [primaryConfigPath, path.join(getVsCodeUserDir({ home, appData }), 'mcp.json')],
    };
  }

  return {
    primaryConfigPath,
    configPaths: [primaryConfigPath],
  };
}

/**
 * @param {{ home: string, cwd: string }} options
 * @returns {Record<SupportedTarget, SkillPathSet>}
 */
function buildSkillTargetMap({ home, cwd }) {
  return /** @type {Record<SupportedTarget, SkillPathSet>} */ (
    Object.fromEntries(
      SUPPORTED_TARGETS.map((target) => [
        target,
        buildSkillPathSet(target, { home, cwd, global: true }),
      ])
    )
  );
}

/**
 * @param {{ home: string, cwd: string }} options
 * @returns {Record<SupportedTarget, SkillPathSet>}
 */
function buildLocalSkillTargetMap({ home, cwd }) {
  return /** @type {Record<SupportedTarget, SkillPathSet>} */ (
    Object.fromEntries(
      SUPPORTED_TARGETS.map((target) => [
        target,
        buildSkillPathSet(target, { home, cwd, global: false }),
      ])
    )
  );
}

/**
 * @param {{ home: string, cwd: string, appData: string, codexHome: string }} options
 * @returns {Record<McpClientName, McpPathSet>}
 */
function buildGlobalMcpClientMap({ home, cwd, appData, codexHome }) {
  return /** @type {Record<McpClientName, McpPathSet>} */ (
    Object.fromEntries(
      MCP_CLIENT_NAMES.map((clientName) => [
        clientName,
        buildMcpPathSet(clientName, { home, cwd, appData, codexHome, global: true }),
      ])
    )
  );
}

/**
 * @param {{ home: string, cwd: string, appData: string, codexHome: string }} options
 * @returns {Record<McpClientName, McpPathSet>}
 */
function buildLocalMcpClientMap({ home, cwd, appData, codexHome }) {
  return /** @type {Record<McpClientName, McpPathSet>} */ (
    Object.fromEntries(
      MCP_CLIENT_NAMES.map((clientName) => [
        clientName,
        buildMcpPathSet(clientName, { home, cwd, appData, codexHome, global: false }),
      ])
    )
  );
}

/**
 * @param {{ home: string, localAppData: string }} options
 * @returns {Record<SupportedBrowser, BrowserManifestPathSet>}
 */
function buildBrowserManifestMap({ home, localAppData }) {
  return /** @type {Record<SupportedBrowser, BrowserManifestPathSet>} */ (
    Object.fromEntries(
      SUPPORTED_BROWSERS.map((browser) => {
        const installDir = getManifestInstallDirForTest(browser, { home, localAppData });
        return [
          browser,
          {
            installDir,
            manifestPath: path.join(installDir, `${APP_NAME}.json`),
          },
        ];
      })
    )
  );
}

/**
 * Create a self-contained temp HOME/cwd layout for install-style CLI tests.
 * The returned env also isolates PATH-backed detector lookups from the host.
 *
 * @param {{ prefix?: string }} [options]
 * @returns {Promise<InstallFs>}
 */
export async function createInstallFs(options = {}) {
  const root = await fs.promises.realpath(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), options.prefix || 'bbx-install-fs-'))
  );
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  const binDir = path.join(root, 'bin');
  const bridgeHome = path.join(root, 'bridge-home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  const codexHome = path.join(home, '.codex');

  await Promise.all([
    fs.promises.mkdir(home, { recursive: true }),
    fs.promises.mkdir(cwd, { recursive: true }),
    fs.promises.mkdir(binDir, { recursive: true }),
    fs.promises.mkdir(bridgeHome, { recursive: true }),
    fs.promises.mkdir(appData, { recursive: true }),
    fs.promises.mkdir(localAppData, { recursive: true }),
    fs.promises.mkdir(codexHome, { recursive: true }),
  ]);

  return {
    root,
    home,
    cwd,
    binDir,
    bridgeHome,
    localAppData,
    appData,
    codexHome,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      CODEX_HOME: codexHome,
      PATH: binDir,
      [BRIDGE_HOME_ENV]: bridgeHome,
    },
    launcherPath: path.join(bridgeHome, getLauncherFilename()),
    globalSkillTargets: buildSkillTargetMap({ home, cwd }),
    localSkillTargets: buildLocalSkillTargetMap({ home, cwd }),
    globalMcpClients: buildGlobalMcpClientMap({ home, cwd, appData, codexHome }),
    localMcpClients: buildLocalMcpClientMap({ home, cwd, appData, codexHome }),
    browserManifests: buildBrowserManifestMap({ home, localAppData }),
    cleanup: async () => {
      await fs.promises.rm(root, { recursive: true, force: true });
    },
  };
}
