import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Readable } from 'node:stream';
import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';

import { createSuccess } from '../protocol/src/index.js';
import { startBridgeSocketServer } from '../../tests/_helpers/socketHarness.ts';
import type { BridgeRequest } from '../protocol/src/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const mcpBinPath = path.resolve(__dirname, '../mcp-server/src/bin.js');

function toSpawnEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }

  return result;
}

function getBridgeRequest(message: unknown): BridgeRequest | null {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const record = message as Record<string, unknown>;
  if (
    record.type === 'agent.request' &&
    record.request &&
    typeof record.request === 'object' &&
    typeof (record.request as Record<string, unknown>).method === 'string'
  ) {
    return record.request as BridgeRequest;
  }

  return null;
}

test(
  'bbx-mcp serves tools/list and browser_investigate over stdio',
  {
    skip:
      process.platform === 'win32' ? 'Unix socket daemon test is not applicable on Windows' : false,
  },
  async () => {
    const bridgeServer = await startBridgeSocketServer(
      async (message, { socket }) => {
        const request = getBridgeRequest(message);
        if (!request) {
          return;
        }

        if (request.method === 'health.ping') {
          socket.write(
            `${JSON.stringify({
              type: 'agent.response',
              response: createSuccess(
                request.id,
                {
                  daemon: 'ok',
                  extensionConnected: true,
                  access: {
                    enabled: true,
                    routeReady: true,
                    routeTabId: 17,
                    windowId: 5,
                    reason: 'ok',
                  },
                },
                { method: request.method }
              ),
            })}\n`
          );
          return;
        }

        if (request.method === 'page.get_state') {
          socket.write(
            `${JSON.stringify({
              type: 'agent.response',
              response: createSuccess(
                request.id,
                {
                  url: 'https://example.com/article',
                  title: 'Example Article',
                  tabId: 17,
                  readyState: 'complete',
                },
                { method: request.method }
              ),
            })}\n`
          );
          return;
        }

        if (request.method === 'dom.query') {
          socket.write(
            `${JSON.stringify({
              type: 'agent.response',
              response: createSuccess(
                request.id,
                {
                  nodes: [
                    {
                      elementRef: 'el_main',
                      tagName: 'main',
                      text: 'Status panel is visible',
                    },
                  ],
                },
                { method: request.method }
              ),
            })}\n`
          );
        }
      },
      {
        prefix: 'bbx-it-mcp-',
      }
    );

    let transport: StdioClientTransport | null = null;
    let stderr = '';

    try {
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [mcpBinPath],
        cwd: repoRoot,
        env: toSpawnEnv({
          ...process.env,
          BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
        }),
        stderr: 'pipe',
      });

      const stderrStream = transport.stderr as Readable | null;
      stderrStream?.setEncoding('utf8');
      stderrStream?.on('data', (chunk) => {
        stderr += String(chunk);
      });

      const client = new Client({
        name: 'browser-bridge-mcp-integration-test',
        version: '1.0.0',
      });
      await client.connect(transport);

      const toolsResult = await client.listTools();
      const investigateTool = toolsResult.tools.find((tool) => tool.name === 'browser_investigate');

      assert.ok(investigateTool, 'expected browser_investigate in tools/list');
      assert.match(String(investigateTool.description), /Investigate a page/);

      const result = (await client.callTool({
        name: 'browser_investigate',
        arguments: {
          objective: 'Confirm the status panel is visible',
          scope: 'quick',
          tabId: 17,
          selector: 'main',
        },
      })) as CallToolResult;

      const content = result.content as Array<{ type: string }>;
      const textContent = content.find((entry) => entry.type === 'text') as TextContent | undefined;
      const structuredContent = (result.structuredContent ?? {}) as Record<string, unknown>;
      const steps: Array<Record<string, unknown>> = Array.isArray(structuredContent.steps)
        ? structuredContent.steps
        : [];

      assert.ok(textContent, `expected text result from browser_investigate\nstderr:\n${stderr}`);
      assert.match(textContent.text, /Investigation complete \(quick, 2 steps,/);
      assert.match(textContent.text, /Objective: Confirm the status panel is visible/);
      assert.equal(result.isError, undefined);
      assert.equal(structuredContent.ok, true);
      assert.equal(structuredContent.objective, 'Confirm the status panel is visible');
      assert.equal(structuredContent.scope, 'quick');
      assert.equal(structuredContent.heuristicFallback, true);
      assert.equal(typeof structuredContent.deliveredBytes, 'number');
      assert.equal(typeof structuredContent.deliveredTokens, 'number');
      assert.equal(typeof structuredContent.deliveredCostClass, 'string');
      assert.deepEqual(
        steps.map((step) => step.method),
        ['page.get_state', 'dom.query']
      );
      assert.equal(bridgeServer.errors.length, 0);
      assert.deepEqual(
        bridgeServer.requests.map((request) => request.method),
        ['health.ping', 'page.get_state', 'dom.query']
      );
      assert.equal(bridgeServer.requests[1].tab_id, 17);
      assert.equal(bridgeServer.requests[2].tab_id, 17);
      assert.deepEqual(bridgeServer.requests[2].params, {
        selector: 'main',
        withinRef: null,
        budget: {
          maxNodes: 10,
          maxDepth: 2,
          textBudget: 300,
          includeBbox: true,
          attributeAllowlist: [],
        },
      });
    } finally {
      await Promise.allSettled([transport?.close(), bridgeServer.close()]);
    }
  }
);
