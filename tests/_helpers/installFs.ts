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
import type { SupportedTarget } from '../../packages/agent-client/src/install.js';
import type { McpClientName } from '../../packages/agent-client/src/mcp-config.js';
import type { SupportedBrowser } from '../../packages/native-host/src/config.js';

export type SkillPathSet = {
  baseDir: string;
  skillDir: string;
  skillFile: string;
  sentinelFile: string;
};

export type McpPathSet = {
  primaryConfigPath: string;
  configPaths: string[];
};

export type BrowserManifestPathSet = {
  installDir: string;
  manifestPath: string;
};

export type InstallFs = {
  root: string;
  home: string;
  cwd: string;
  binDir: string;
  bridgeHome: string;
  localAppData: string;
  appData: string;
  codexHome: string;
  env: NodeJS.ProcessEnv;
  launcherPath: string;
  globalSkillTargets: Record<SupportedTarget, SkillPathSet>;
  localSkillTargets: Record<SupportedTarget, SkillPathSet>;
  globalMcpClients: Record<McpClientName, McpPathSet>;
  localMcpClients: Record<McpClientName, McpPathSet>;
  browserManifests: Record<SupportedBrowser, BrowserManifestPathSet>;
  cleanup: () => Promise<void>;
};

type HomeAppDataOptions = {
  home: string;
  appData: string;
};

type BrowserPathOptions = {
  home: string;
  localAppData: string;
};

type SkillPathOptions = {
  home: string;
  cwd: string;
  global: boolean;
};

type McpPathOptions = {
  home: string;
  cwd: string;
  appData: string;
  codexHome: string;
  global: boolean;
};

type HomeCwdOptions = {
  home: string;
  cwd: string;
};

type McpMapOptions = {
  home: string;
  cwd: string;
  appData: string;
  codexHome: string;
};

export type CreateInstallFsOptions = {
  prefix?: string;
};

function getVsCodeUserDir({ home, appData }: HomeAppDataOptions): string {
  if (process.platform === 'win32') {
    return path.join(appData, 'Code', 'User');
  }
  if (process.platform === 'linux') {
    return path.join(home, '.config', 'Code', 'User');
  }
  return path.join(home, 'Library', 'Application Support', 'Code', 'User');
}

function getManifestInstallDirForTest(
  browser: SupportedBrowser,
  { home, localAppData }: BrowserPathOptions
): string {
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

function buildSkillPathSet(
  target: SupportedTarget,
  { home, cwd, global: isGlobal }: SkillPathOptions
): SkillPathSet {
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

function buildMcpPathSet(
  clientName: McpClientName,
  { home, cwd, appData, codexHome, global: isGlobal }: McpPathOptions
): McpPathSet {
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

function buildSkillTargetMap({ home, cwd }: HomeCwdOptions): Record<SupportedTarget, SkillPathSet> {
  return Object.fromEntries(
    SUPPORTED_TARGETS.map((target) => [
      target,
      buildSkillPathSet(target, { home, cwd, global: true }),
    ])
  ) as Record<SupportedTarget, SkillPathSet>;
}

function buildLocalSkillTargetMap({
  home,
  cwd,
}: HomeCwdOptions): Record<SupportedTarget, SkillPathSet> {
  return Object.fromEntries(
    SUPPORTED_TARGETS.map((target) => [
      target,
      buildSkillPathSet(target, { home, cwd, global: false }),
    ])
  ) as Record<SupportedTarget, SkillPathSet>;
}

function buildGlobalMcpClientMap({
  home,
  cwd,
  appData,
  codexHome,
}: McpMapOptions): Record<McpClientName, McpPathSet> {
  return Object.fromEntries(
    MCP_CLIENT_NAMES.map((clientName) => [
      clientName,
      buildMcpPathSet(clientName, { home, cwd, appData, codexHome, global: true }),
    ])
  ) as Record<McpClientName, McpPathSet>;
}

function buildLocalMcpClientMap({
  home,
  cwd,
  appData,
  codexHome,
}: McpMapOptions): Record<McpClientName, McpPathSet> {
  return Object.fromEntries(
    MCP_CLIENT_NAMES.map((clientName) => [
      clientName,
      buildMcpPathSet(clientName, { home, cwd, appData, codexHome, global: false }),
    ])
  ) as Record<McpClientName, McpPathSet>;
}

function buildBrowserManifestMap({
  home,
  localAppData,
}: BrowserPathOptions): Record<SupportedBrowser, BrowserManifestPathSet> {
  return Object.fromEntries(
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
  ) as Record<SupportedBrowser, BrowserManifestPathSet>;
}

// Create a self-contained temp HOME/cwd layout for install-style CLI tests. The
// returned env also isolates PATH-backed detector lookups from the host.
export async function createInstallFs(options: CreateInstallFsOptions = {}): Promise<InstallFs> {
  const root = await fs.promises.realpath(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), options.prefix || 'bbx-install-fs-'))
  );
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  const binDir = path.join(root, 'bin');
  const bridgeHome = path.join(root, 'bridge-home');
  const xdgConfigHome = path.join(home, '.config');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  const codexHome = path.join(home, '.codex');

  await Promise.all([
    fs.promises.mkdir(home, { recursive: true }),
    fs.promises.mkdir(cwd, { recursive: true }),
    fs.promises.mkdir(binDir, { recursive: true }),
    fs.promises.mkdir(bridgeHome, { recursive: true }),
    fs.promises.mkdir(xdgConfigHome, { recursive: true }),
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
      XDG_CONFIG_HOME: xdgConfigHome,
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
