// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { formatMcpConfig, MCP_CLIENT_NAMES } from '../src/mcp-config.js';
import { runCli } from '../../../tests/_helpers/runCli.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const cliPath = path.join(repoRoot, 'packages', 'agent-client', 'src', 'cli.js');
const mcpConfigUsage = `Usage: bbx mcp config <${MCP_CLIENT_NAMES.join('|')}>\n`;

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {Record<string, string>}
 */
function toSpawnEnv(env) {
  /** @type {Record<string, string>} */
  const result = {};

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }

  return result;
}

test('bbx mcp config <client> prints the formatted MCP config', async () => {
  const result = await runCli({
    args: ['mcp', 'config', 'claude'],
  });

  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, formatMcpConfig('claude'));
});

test('bbx mcp config rejects an unknown client name', async () => {
  const result = await runCli({
    args: ['mcp', 'config', 'bogus'],
  });

  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, mcpConfigUsage);
});

test('bbx mcp config requires a client name', async () => {
  const result = await runCli({
    args: ['mcp', 'config'],
  });

  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, mcpConfigUsage);
});

test('bbx mcp rejects unknown subcommands', async () => {
  const result = await runCli({
    args: ['mcp', 'foo'],
  });

  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Usage: bbx mcp <serve|config>\n');
});

test('bbx mcp serve starts the MCP server over stdio', { timeout: 10000 }, async () => {
  /** @type {StdioClientTransport | null} */
  let transport = null;
  let stderr = '';

  try {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, 'mcp', 'serve'],
      cwd: repoRoot,
      env: toSpawnEnv(process.env),
      stderr: 'pipe',
    });

    const stderrStream = /** @type {import('node:stream').Readable | null} */ (transport.stderr);
    stderrStream?.setEncoding('utf8');
    stderrStream?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const client = new Client({
      name: 'browser-bridge-cli-mcp-test',
      version: '1.0.0',
    });
    await client.connect(transport);

    const toolsResult = await client.listTools();
    const statusTool = toolsResult.tools.find((tool) => tool.name === 'browser_status');

    assert.ok(statusTool, `expected browser_status in tools/list\nstderr:\n${stderr}`);
    assert.match(String(statusTool.description), /bridge readiness/i);
  } finally {
    await transport?.close();
  }
});
