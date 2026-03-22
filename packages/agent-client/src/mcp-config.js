// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {'claude' | 'cursor' | 'copilot' | 'codex'} McpClientName
 */

/** @type {McpClientName[]} */
export const MCP_CLIENT_NAMES = ['copilot', 'codex', 'cursor', 'claude'];

/**
 * @param {string} value
 * @returns {value is McpClientName}
 */
export function isMcpClientName(value) {
  return MCP_CLIENT_NAMES.includes(/** @type {McpClientName} */ (value));
}

/**
 * @returns {{ command: string, args: string[], env: Record<string, string> }}
 */
function createBaseServerConfig() {
  return {
    command: 'bbx',
    args: ['mcp', 'serve'],
    env: {}
  };
}

/**
 * @param {McpClientName} clientName
 * @returns {Record<string, unknown>}
 */
export function buildMcpConfig(clientName) {
  const serverConfig = createBaseServerConfig();

  if (clientName === 'claude') {
    return {
      mcpServers: {
        'browser-bridge': {
          type: 'stdio',
          ...serverConfig
        }
      }
    };
  }

  if (clientName === 'copilot') {
    return {
      servers: {
        'browser-bridge': {
          type: 'stdio',
          ...serverConfig
        }
      }
    };
  }

  // cursor, codex, and others use the mcpServers shape
  return {
    mcpServers: {
      'browser-bridge': serverConfig
    }
  };
}

/**
 * @param {McpClientName} clientName
 * @returns {string}
 */
export function formatMcpConfig(clientName) {
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
      codex: path.join(cwd, '.codex', 'mcp.json'),
      cursor: path.join(cwd, '.cursor', 'mcp.json'),
      claude: path.join(cwd, '.claude', 'mcp.json')
    };
    return localPaths[clientName];
  }

  if (clientName === 'claude') {
    const platform = process.platform;
    if (platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      return path.join(appData, 'Claude', 'claude_desktop_config.json');
    }
    if (platform === 'linux') {
      return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
    }
    return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }

  if (clientName === 'copilot') {
    return path.join(home, '.vscode', 'mcp.json');
  }

  if (clientName === 'codex') {
    const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
    return path.join(codexHome, 'mcp.json');
  }

  // cursor
  return path.join(home, '.cursor', 'mcp.json');
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
  const configPath = getMcpConfigPath(clientName, options);
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

  // Merge only the browser-bridge entry under the relevant top-level key.
  const topKey = clientName === 'copilot' ? 'servers' : 'mcpServers';
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
  return configPath;
}
