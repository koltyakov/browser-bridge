import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { buildMcpConfig, formatMcpConfig, MCP_CLIENT_NAMES } from '../src/mcp-config.js';
import { runCli } from '../../../tests/_helpers/runCli.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const cliPath = path.join(repoRoot, 'packages', 'agent-client', 'src', 'cli.js');
const mcpConfigUsage = `Usage: bbx mcp config <${MCP_CLIENT_NAMES.join('|')}>\n`;

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

test('bbx mcp config rejects obsolete profile arguments', async () => {
  const result = await runCli({
    args: ['mcp', 'config', 'claude', '--profile', 'minimal'],
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, mcpConfigUsage);
});

test('codex and opencode configs contain no toolset selector', () => {
  assert.doesNotMatch(formatMcpConfig('codex'), /env =/);

  const opencode = buildMcpConfig('opencode') as {
    mcp: { 'browser-bridge': { type: string; environment?: Record<string, string> } };
  };
  assert.equal(opencode.mcp['browser-bridge'].type, 'local');
  assert.equal(opencode.mcp['browser-bridge'].environment, undefined);
});

test('MCP always serves the compact progressive tool surface', { timeout: 10000 }, async () => {
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
      }),
      stderr: 'pipe',
    });

    const client = new Client({
      name: 'browser-bridge-cli-mcp-progressive-test',
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
      'browser_toolset',
    ]);
    assert.match(String(client.getInstructions()), /common tools are available immediately/i);
    assert.match(String(client.getInstructions()), /exact tool name/i);
  } finally {
    await transport?.close();
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
});

test('MCP serves the modern stateless surface over the same stdio command', async () => {
  let transport: StdioClientTransport | null = null;
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-cli-mcp-modern-'));

  try {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, 'mcp', 'serve'],
      cwd: repoRoot,
      env: toSpawnEnv({
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeHome,
      }),
      stderr: 'pipe',
    });
    const client = new Client(
      {
        name: 'browser-bridge-cli-mcp-modern-test',
        version: '1.0.0',
      },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    await client.connect(transport);

    assert.equal(client.getProtocolEra(), 'modern');
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
      'browser_access',
      'browser_batch',
      'browser_call',
      'browser_health',
      'browser_skill',
      'browser_status',
    ]);
    assert.match(String(client.getInstructions()), /tool list is static for stateless MCP/i);
    assert.doesNotMatch(String(client.getInstructions()), /call browser_toolset/i);
    const describeResult = await client.callTool({
      name: 'browser_call',
      arguments: {
        method: 'protocol.describe',
        params: { method: 'health.ping' },
      },
    });
    assert.equal(describeResult.isError, undefined);
    assert.equal(
      (describeResult.structuredContent as { method?: string } | undefined)?.method,
      'health.ping'
    );
    await assert.rejects(
      client.callTool({
        name: 'browser_toolset',
        arguments: { tool: 'browser_dom' },
      }),
      /browser_toolset disabled/
    );
  } finally {
    await transport?.close();
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
});

test('MCP auto negotiation selects the modern era', async () => {
  let transport: StdioClientTransport | null = null;
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-cli-mcp-auto-'));

  try {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, 'mcp', 'serve'],
      cwd: repoRoot,
      env: toSpawnEnv({
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeHome,
      }),
      stderr: 'pipe',
    });
    const client = new Client(
      {
        name: 'browser-bridge-cli-mcp-auto-test',
        version: '1.0.0',
      },
      { versionNegotiation: { mode: 'auto' } }
    );
    await client.connect(transport);

    assert.equal(client.getProtocolEra(), 'modern');
    assert.equal((await client.listTools()).tools.length, 6);
  } finally {
    await transport?.close();
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
});
