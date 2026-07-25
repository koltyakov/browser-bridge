import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  buildMcpConfig,
  formatMcpConfig,
  MCP_CLIENT_NAMES,
  MCP_TOOLSET_PROFILE_ENV,
  MCP_TOOLSET_PROFILES,
} from '../src/mcp-config.js';
import { runCli } from '../../../tests/_helpers/runCli.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const cliPath = path.join(repoRoot, 'packages', 'agent-client', 'src', 'cli.js');
const mcpConfigUsage = `Usage: bbx mcp config <${MCP_CLIENT_NAMES.join('|')}> [--profile <${MCP_TOOLSET_PROFILES.join('|')}>]\n`;

function toSpawnEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};

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
  let transport: StdioClientTransport | null = null;
  let stderr = '';
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-cli-mcp-'));

  try {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, 'mcp', 'serve'],
      cwd: repoRoot,
      env: toSpawnEnv({ ...process.env, BROWSER_BRIDGE_HOME: bridgeHome }),
      stderr: 'pipe',
    });

    const stderrStream = transport.stderr as Readable | null;
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

    assert.match(String(client.getInstructions()), /Prefer Browser Bridge MCP tools/i);
    assert.match(String(client.getInstructions()), /Layout debugging:/);
  } finally {
    await transport?.close();
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
});

test('bbx mcp config --profile minimal writes the toolset selector', async () => {
  const result = await runCli({
    args: ['mcp', 'config', 'claude', '--profile', 'minimal'],
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, formatMcpConfig('claude', 'minimal'));

  const parsed = JSON.parse(result.stdout) as {
    mcpServers: { 'browser-bridge': { env?: Record<string, string> } };
  };
  assert.deepEqual(parsed.mcpServers['browser-bridge'].env, {
    [MCP_TOOLSET_PROFILE_ENV]: 'minimal',
  });
});

test('bbx mcp config defaults to the full profile and writes no selector', async () => {
  const result = await runCli({
    args: ['mcp', 'config', 'claude'],
  });

  const parsed = JSON.parse(result.stdout) as {
    mcpServers: { 'browser-bridge': { env?: Record<string, string> } };
  };

  assert.equal(result.status, 0);
  assert.deepEqual(parsed.mcpServers['browser-bridge'].env, {});
  assert.equal(result.stdout, formatMcpConfig('claude', 'full'));
  assert.equal(result.stdout, formatMcpConfig('claude'));
});

test('bbx mcp config rejects an unknown profile', async () => {
  const result = await runCli({
    args: ['mcp', 'config', 'claude', '--profile', 'tiny'],
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unknown MCP toolset profile "tiny"/);
  assert.match(result.stderr, /full, minimal/);
});

test('codex and opencode carry the profile in their own config shapes', () => {
  const codexMinimal = formatMcpConfig('codex', 'minimal');
  assert.match(codexMinimal, /env = \{ BBX_MCP_TOOLSET = "minimal" \}/);
  assert.doesNotMatch(formatMcpConfig('codex', 'full'), /env =/);

  const opencodeMinimal = buildMcpConfig('opencode', 'minimal') as {
    mcp: { 'browser-bridge': { type: string; environment?: Record<string, string> } };
  };
  assert.equal(opencodeMinimal.mcp['browser-bridge'].type, 'local');
  assert.deepEqual(opencodeMinimal.mcp['browser-bridge'].environment, {
    [MCP_TOOLSET_PROFILE_ENV]: 'minimal',
  });

  const opencodeFull = buildMcpConfig('opencode', 'full') as {
    mcp: { 'browser-bridge': { environment?: Record<string, string> } };
  };
  assert.equal(opencodeFull.mcp['browser-bridge'].environment, undefined);
});

test('BBX_MCP_TOOLSET=minimal trims the served tool surface', { timeout: 10000 }, async () => {
  let transport: StdioClientTransport | null = null;
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-cli-mcp-min-'));

  try {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, 'mcp', 'serve'],
      cwd: repoRoot,
      env: toSpawnEnv({
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeHome,
        [MCP_TOOLSET_PROFILE_ENV]: 'minimal',
      }),
      stderr: 'pipe',
    });

    const client = new Client({
      name: 'browser-bridge-cli-mcp-minimal-test',
      version: '1.0.0',
    });
    await client.connect(transport);

    const toolsResult = await client.listTools();
    const names = toolsResult.tools.map((tool) => tool.name).sort();

    assert.deepEqual(names, [
      'browser_access',
      'browser_batch',
      'browser_call',
      'browser_health',
      'browser_status',
    ]);
    assert.match(String(client.getInstructions()), /minimal tool profile/);
  } finally {
    await transport?.close();
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
});
