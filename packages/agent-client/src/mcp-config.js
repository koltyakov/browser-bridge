// @ts-check

/**
 * @typedef {'claude' | 'cursor' | 'vscode'} McpClientName
 */

/**
 * @param {string} value
 * @returns {value is McpClientName}
 */
export function isMcpClientName(value) {
  return ['claude', 'cursor', 'vscode'].includes(value);
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

  if (clientName === 'vscode') {
    return {
      servers: {
        'browser-bridge': {
          type: 'stdio',
          ...serverConfig
        }
      }
    };
  }

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
