// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {'claude' | 'cursor' | 'windsurf' | 'copilot' | 'codex' | 'opencode'} McpClientName
 */

/** @type {McpClientName[]} */
export const MCP_CLIENT_NAMES = ['copilot', 'codex', 'cursor', 'windsurf', 'claude', 'opencode'];

/**
 * @param {string} value
 * @returns {value is McpClientName}
 */
export function isMcpClientName(value) {
  return MCP_CLIENT_NAMES.includes(/** @type {McpClientName} */ (value));
}

const BROWSER_BRIDGE_SERVER_NAME = 'browser-bridge';

/**
 * @returns {string}
 */
function getVsCodeUserDataDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Code');
  }
  if (process.platform === 'linux') {
    return path.join(home, '.config', 'Code');
  }
  return path.join(home, 'Library', 'Application Support', 'Code');
}

/**
 * @returns {string}
 */
function getCopilotUserConfigPath() {
  return path.join(os.homedir(), '.copilot', 'mcp-config.json');
}

/**
 * Legacy global path used by older VS Code Copilot MCP wiring.
 *
 * @returns {string}
 */
function getLegacyCopilotVsCodeConfigPath() {
  return path.join(getVsCodeUserDataDir(), 'User', 'mcp.json');
}

/**
 * @param {McpClientName} clientName
 * @returns {{ key: string, includeType: boolean }}
 */
export function getMcpConfigShape(clientName) {
  return MCP_CONFIG_SHAPES[clientName] ?? { key: 'mcpServers', includeType: false };
}

/**
 * @param {McpClientName} clientName
 * @returns {{
 *   command: string,
 *   args: string[],
 *   env: Record<string, string>
 * } | {
 *   type: 'local',
 *   command: string[]
 * }}
 */
function createBaseServerConfig(clientName) {
  if (clientName === 'opencode') {
    return {
      type: 'local',
      command: ['bbx', 'mcp', 'serve']
    };
  }
  return {
    command: 'bbx',
    args: ['mcp', 'serve'],
    env: {}
  };
}

/** @type {Record<McpClientName, { key: string, includeType: boolean }>} */
const MCP_CONFIG_SHAPES = {
  claude:  { key: 'mcpServers', includeType: true },
  copilot: { key: 'servers',    includeType: true },
  cursor:  { key: 'mcpServers', includeType: false },
  windsurf:{ key: 'mcpServers', includeType: false },
  codex:   { key: 'mcp_servers', includeType: false },
  opencode:{ key: 'mcp',        includeType: false },
};

/**
 * @param {McpClientName} clientName
 * @returns {Record<string, unknown>}
 */
export function buildMcpConfig(clientName) {
  if (clientName === 'codex') {
    return {
      mcp_servers: {
        [BROWSER_BRIDGE_SERVER_NAME]: {
          command: 'bbx',
          args: ['mcp', 'serve']
        }
      }
    };
  }
  const serverConfig = createBaseServerConfig(clientName);
  const shape = getMcpConfigShape(clientName);
  const entry = shape.includeType ? { type: 'stdio', ...serverConfig } : serverConfig;
  return { [shape.key]: { [BROWSER_BRIDGE_SERVER_NAME]: entry } };
}

/**
 * @param {McpClientName} clientName
 * @returns {string}
 */
export function formatMcpConfig(clientName) {
  if (clientName === 'codex') {
    return formatCodexServerBlock();
  }
  return `${JSON.stringify(buildMcpConfig(clientName), null, 2)}\n`;
}

/**
 * Return the config file path for a given client.
 * When isGlobal is true, returns the user-level config path.
 * When false, returns a project-local path relative to cwd.
 *
 * @param {McpClientName} clientName
 * @param {{ global: boolean, cwd?: string }} options
 * @returns {string}
 */
export function getMcpConfigPath(clientName, { global: isGlobal, cwd = process.cwd() }) {
  const home = os.homedir();

  if (!isGlobal) {
    const localPaths = {
      copilot: path.join(cwd, '.vscode', 'mcp.json'),
      codex: path.join(cwd, '.codex', 'config.toml'),
      cursor: path.join(cwd, '.cursor', 'mcp.json'),
      // Windsurf documents the global file; use the repo-local analogue for --local installs.
      windsurf: path.join(cwd, '.windsurf', 'mcp_config.json'),
      claude: path.join(cwd, '.mcp.json'),
      opencode: path.join(cwd, 'opencode.json')
    };
    return localPaths[clientName];
  }

  if (clientName === 'claude') {
    return path.join(home, '.claude.json');
  }

  if (clientName === 'copilot') {
    return getCopilotUserConfigPath();
  }

  if (clientName === 'codex') {
    const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
    return path.join(codexHome, 'config.toml');
  }

  if (clientName === 'opencode') {
    return path.join(home, '.config', 'opencode', 'opencode.json');
  }

  if (clientName === 'windsurf') {
    return path.join(home, '.codeium', 'windsurf', 'mcp_config.json');
  }

  // cursor
  return path.join(home, '.cursor', 'mcp.json');
}

/**
 * Return all config paths that should receive Browser Bridge MCP config.
 * Copilot stores MCP config per VS Code profile, so global installs should
 * update the default user profile plus any existing named profiles.
 *
 * @param {McpClientName} clientName
 * @param {{ global: boolean, cwd?: string, readdir?: typeof fs.promises.readdir }} options
 * @returns {Promise<string[]>}
 */
export async function getMcpConfigPaths(clientName, options) {
  const primaryPath = getMcpConfigPath(clientName, options);
  if (clientName !== 'copilot' || options.global === false) {
    return [primaryPath];
  }

  /** @type {string[]} */
  const paths = [primaryPath];
  const legacyVsCodePath = getLegacyCopilotVsCodeConfigPath();
  if (!paths.includes(legacyVsCodePath)) {
    paths.push(legacyVsCodePath);
  }

  const readdir = options.readdir ?? fs.promises.readdir.bind(fs.promises);
  const profilesDir = path.join(path.dirname(legacyVsCodePath), 'profiles');

  try {
    const entries = await readdir(profilesDir, { withFileTypes: true });
    const profilePaths = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(profilesDir, entry.name, 'mcp.json'));
    for (const profilePath of profilePaths) {
      if (!paths.includes(profilePath)) {
        paths.push(profilePath);
      }
    }
    return paths;
  } catch {
    return paths;
  }
}

/**
 * @returns {string}
 */
function formatCodexServerBlock() {
  return [
    `[mcp_servers."${BROWSER_BRIDGE_SERVER_NAME}"]`,
    'command = "bbx"',
    'args = ["mcp", "serve"]',
    ''
  ].join('\n');
}

/**
 * @param {string} raw
 * @returns {boolean}
 */
function hasCodexServerBlock(raw) {
  return raw.includes(`[mcp_servers.${BROWSER_BRIDGE_SERVER_NAME}]`)
    || raw.includes(`[mcp_servers."${BROWSER_BRIDGE_SERVER_NAME}"]`);
}

/**
 * @param {string | undefined} line
 * @returns {boolean}
 */
function isCodexServerHeader(line) {
  const trimmed = line?.trim();
  return trimmed === `[mcp_servers.${BROWSER_BRIDGE_SERVER_NAME}]`
    || trimmed === `[mcp_servers."${BROWSER_BRIDGE_SERVER_NAME}"]`;
}

/**
 * Upsert the Browser Bridge section in a Codex TOML config while preserving
 * unrelated content. This intentionally manages only our own named table.
 *
 * @param {string} raw
 * @returns {string}
 */
function upsertCodexServerBlock(raw) {
  const lines = raw.split(/\r?\n/);
  const replacement = formatCodexServerBlock().trimEnd().split('\n');

  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (isCodexServerHeader(lines[index])) {
      start = index;
      break;
    }
  }

  if (start !== -1) {
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (lines[index]?.trim().startsWith('[')) {
        end = index;
        break;
      }
    }
    lines.splice(start, end - start, ...replacement);
    return `${lines.join('\n').replace(/\s+$/, '')}\n`;
  }

  const trimmed = raw.trimEnd();
  if (!trimmed) {
    return formatCodexServerBlock();
  }
  return `${trimmed}\n\n${formatCodexServerBlock()}`;
}

/**
 * Remove the Browser Bridge server block from a Codex TOML config while
 * preserving unrelated content.
 *
 * @param {string} raw
 * @returns {string}
 */
function removeCodexServerBlock(raw) {
  const lines = raw.split(/\r?\n/);

  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (isCodexServerHeader(lines[index])) {
      start = index;
      break;
    }
  }

  if (start === -1) {
    return raw;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]?.trim().startsWith('[')) {
      end = index;
      break;
    }
  }

  lines.splice(start, end - start);
  while (start < lines.length && lines[start]?.trim() === '' && start > 0 && lines[start - 1]?.trim() === '') {
    lines.splice(start, 1);
  }
  const trimmed = lines.join('\n').replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n` : '';
}

/**
 * Merge the browser-bridge entry into an existing client config file, or
 * create it if it does not exist. Existing unrelated entries are preserved.
 *
 * @param {McpClientName} clientName
 * @param {{ global: boolean, cwd?: string, stdout?: Pick<NodeJS.WriteStream, 'write'> }} options
 * @returns {Promise<string>} The path written to.
 */
export async function installMcpConfig(clientName, options) {
  const stdout = options.stdout ?? process.stdout;
  const configPaths = await getMcpConfigPaths(clientName, options);

  for (const configPath of configPaths) {
    if (clientName === 'codex') {
      await installCodexMcpConfig(configPath, stdout);
      continue;
    }
    await installJsonMcpConfig(clientName, configPath, stdout);
  }

  return configPaths[0] || getMcpConfigPath(clientName, options);
}

/**
 * @param {{ clients: McpClientName[], global: boolean, cwd?: string }} options
 * @returns {Promise<McpClientName[]>}
 */
export async function findConfiguredMcpClients(options) {
  /** @type {McpClientName[]} */
  const configuredClients = [];

  for (const clientName of options.clients) {
    const configPaths = await getMcpConfigPaths(clientName, options);
    let configured = false;

    for (const configPath of configPaths) {
      try {
        const raw = await fs.promises.readFile(configPath, 'utf8');
        if (parseInstalledMcpConfig(clientName, raw).configured) {
          configured = true;
          break;
        }
      } catch {
        // Missing or unreadable config is treated as absent.
      }
    }

    if (configured) {
      configuredClients.push(clientName);
    }
  }

  return configuredClients;
}

/**
 * Remove only the Browser Bridge MCP server entry for the given client while
 * preserving unrelated config.
 *
 * @param {McpClientName} clientName
 * @param {{ global: boolean, cwd?: string, stdout?: Pick<NodeJS.WriteStream, 'write'> }} options
 * @returns {Promise<string[]>}
 */
export async function removeMcpConfig(clientName, options) {
  const stdout = options.stdout ?? process.stdout;
  const configPaths = await getMcpConfigPaths(clientName, options);
  /** @type {string[]} */
  const updatedPaths = [];

  for (const configPath of configPaths) {
    let changed = false;
    if (clientName === 'codex') {
      changed = await removeCodexMcpConfig(configPath, stdout);
    } else {
      changed = await removeJsonMcpConfig(clientName, configPath, stdout);
    }
    if (changed) {
      updatedPaths.push(configPath);
    }
  }

  return updatedPaths;
}

/**
 * @param {McpClientName} clientName
 * @param {string} configPath
 * @param {Pick<NodeJS.WriteStream, 'write'>} stdout
 * @returns {Promise<void>}
 */
async function installJsonMcpConfig(clientName, configPath, stdout) {
  const newEntry = buildMcpConfig(clientName);

  /** @type {Record<string, unknown>} */
  let existing = {};
  try {
    const raw = await fs.promises.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed;
    }
  } catch {
    // File missing or unparseable - start fresh.
  }

  const topKey = getMcpConfigShape(clientName).key;
  const entryBlock = /** @type {Record<string, unknown>} */ (newEntry[topKey]);

  const merged = {
    ...existing,
    [topKey]: {
      .../** @type {Record<string, unknown>} */ (existing[topKey] ?? {}),
      ...entryBlock
    }
  };

  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  stdout.write(`Wrote ${configPath}\n`);
}

/**
 * @param {string} configPath
 * @param {Pick<NodeJS.WriteStream, 'write'>} stdout
 * @returns {Promise<void>}
 */
async function installCodexMcpConfig(configPath, stdout) {
  let raw = '';
  try {
    raw = await fs.promises.readFile(configPath, 'utf8');
  } catch {
    raw = '';
  }

  const updated = upsertCodexServerBlock(raw);
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(configPath, updated, 'utf8');
  stdout.write(`Wrote ${configPath}\n`);
}

/**
 * @param {McpClientName} clientName
 * @param {string} configPath
 * @param {Pick<NodeJS.WriteStream, 'write'>} stdout
 * @returns {Promise<boolean>}
 */
async function removeJsonMcpConfig(clientName, configPath, stdout) {
  /** @type {Record<string, unknown>} */
  let existing = {};
  try {
    const raw = await fs.promises.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed;
    } else {
      return false;
    }
  } catch {
    return false;
  }

  const topKey = getMcpConfigShape(clientName).key;
  const block = existing[topKey];
  if (!block || typeof block !== 'object' || Array.isArray(block) || !Object.hasOwn(block, BROWSER_BRIDGE_SERVER_NAME)) {
    return false;
  }

  const updatedBlock = { .../** @type {Record<string, unknown>} */ (block) };
  delete updatedBlock[BROWSER_BRIDGE_SERVER_NAME];

  const merged = { ...existing };
  if (Object.keys(updatedBlock).length === 0) {
    delete merged[topKey];
  } else {
    merged[topKey] = updatedBlock;
  }

  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  stdout.write(`Removed ${configPath}\n`);
  return true;
}

/**
 * @param {string} configPath
 * @param {Pick<NodeJS.WriteStream, 'write'>} stdout
 * @returns {Promise<boolean>}
 */
async function removeCodexMcpConfig(configPath, stdout) {
  let raw = '';
  try {
    raw = await fs.promises.readFile(configPath, 'utf8');
  } catch {
    return false;
  }

  if (!hasCodexServerBlock(raw)) {
    return false;
  }

  const updated = removeCodexServerBlock(raw);
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(configPath, updated, 'utf8');
  stdout.write(`Removed ${configPath}\n`);
  return true;
}

/**
 * @param {McpClientName} clientName
 * @param {string} raw
 * @returns {{ configured: boolean }}
 */
export function parseInstalledMcpConfig(clientName, raw) {
  if (clientName === 'codex') {
    return { configured: hasCodexServerBlock(raw) };
  }

  try {
    const parsed = JSON.parse(raw);
    const topKey = getMcpConfigShape(clientName).key;
    const block = parsed && typeof parsed === 'object'
      ? /** @type {Record<string, unknown>} */ (parsed[topKey] ?? {})
      : {};
    return {
      configured: Boolean(block && typeof block === 'object' && Object.hasOwn(block, BROWSER_BRIDGE_SERVER_NAME))
    };
  } catch {
    return { configured: false };
  }
}
