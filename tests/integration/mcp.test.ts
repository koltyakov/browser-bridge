import test from 'node:test';
import assert from 'node:assert/strict';

import { Client, type CallToolResult, type TextContent } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Readable } from 'node:stream';
import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { createFailure, createSuccess, normalizeDomQuery } from '../../protocol/src/index.js';
import { startBridgeSocketServer } from '../_helpers/socketHarness.ts';
import { isolatedBridgeEnv, nativeExecutable, repoRoot } from '../_helpers/runCli.ts';
import type { BridgeRequest } from '../../protocol/src/types.js';

function toSpawnEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(isolatedBridgeEnv(env))) {
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

for (const era of ['legacy', 'modern'] as const) {
  test(
    `MCP ${era} retains connection-owned handles across calls and closes on disconnect`,
    {
      timeout: 15_000,
    },
    async () => {
      const owners = new Map<string, Socket>();
      const sockets = new Set<Socket>();
      let staged = 0;
      let notifyPending = () => {};
      const pendingObserved = new Promise<void>((resolve) => {
        notifyPending = resolve;
      });
      const bridge = await startBridgeSocketServer((message, { socket }) => {
        const request = getBridgeRequest(message);
        if (!request) return;
        if (!sockets.has(socket)) {
          sockets.add(socket);
          socket.on('close', () => {
            sockets.delete(socket);
            for (const [id, owner] of owners) if (owner === socket) owners.delete(id);
          });
        }
        if (request.method === 'page.get_state') {
          notifyPending();
          return;
        }
        let response;
        if (request.method === 'files.stage') {
          const transferId = `file_${++staged}`;
          owners.set(transferId, socket);
          response = createSuccess(request.id, { transferId, complete: true });
        } else if (request.method === 'input.set_files') {
          const files = request.params.files as string[];
          response = files.every((id) => owners.get(id) === socket)
            ? createSuccess(request.id, { assigned: true, count: files.length })
            : createFailure(request.id, 'ARTIFACT_NOT_FOUND', 'Wrong connection owner');
        } else {
          response = createSuccess(request.id, {});
        }
        socket.write(`${JSON.stringify({ type: 'agent.response', response })}\n`);
      });
      const connections: Array<{ client: Client; transport: StdioClientTransport }> = [];
      try {
        for (let i = 0; i < 2; i++) {
          const transport = new StdioClientTransport({
            command: nativeExecutable,
            args: ['mcp', 'serve'],
            cwd: repoRoot,
            env: toSpawnEnv({ ...process.env, BROWSER_BRIDGE_HOME: bridge.bridgeHome }),
            stderr: 'pipe',
          });
          const client = new Client(
            { name: 'owner-test', version: '1.0.0' },
            era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}
          );
          connections.push({ client, transport });
          await client.connect(transport);
        }
        const call = (index: number, method: string, params: Record<string, unknown>) =>
          connections[index].client.callTool({
            name: 'browser_call',
            arguments: { method, params, tabId: 17 },
          });
        const stagedResults = await Promise.all(
          [0, 1, 2].map(() =>
            call(0, 'files.stage', {
              name: 'test.txt',
              size: 3,
              data: 'YWJj',
            })
          )
        );
        const ids = stagedResults.map((result) => {
          assert.notEqual(result.isError, true);
          const evidence = (result.structuredContent as { evidence: { transferId: string } })
            .evidence;
          assert.equal(typeof evidence.transferId, 'string');
          return evidence.transferId;
        });
        assert.equal(sockets.size, 1, 'Concurrent calls share one connection');
        const abort = new AbortController();
        const cancelled = connections[0].client.callTool(
          {
            name: 'browser_call',
            arguments: { method: 'page.get_state', tabId: 17 },
          },
          { signal: abort.signal }
        );
        const rejected = assert.rejects(cancelled, /cancel|abort/iu);
        await pendingObserved;
        abort.abort();
        await rejected;
        assert.notEqual(
          (
            await call(0, 'input.set_files', {
              target: { selector: '#file' },
              files: ids,
            })
          ).isError,
          true
        );
        assert.equal(
          (
            await call(1, 'input.set_files', {
              target: { selector: '#file' },
              files: ids,
            })
          ).isError,
          true,
          'Another MCP connection cannot use the handles'
        );
        assert.notEqual(
          (
            await call(0, 'input.set_files', {
              target: { selector: '#file' },
              files: ids,
            })
          ).isError,
          true,
          'Rejected access does not invalidate the owner'
        );
        const owner = owners.get(ids[0]);
        assert.ok(owner);
        const disconnected = new Promise<void>((resolve) => owner.once('close', resolve));
        owner.destroy();
        await disconnected;
        assert.equal(
          (
            await call(0, 'input.set_files', {
              target: { selector: '#file' },
              files: ids,
            })
          ).isError,
          true,
          'Reconnecting does not regain handles from a lost connection'
        );
        const fresh = await call(0, 'files.stage', { name: 'new.txt', size: 0, data: '' });
        assert.notEqual(fresh.isError, true);
        assert.equal(owners.size, 1);
        await connections[0].client.close();
        for (let i = 0; i < 100 && owners.size > 0; i++) await delay(10);
        assert.equal(owners.size, 0, 'MCP disconnect releases the daemon connection');
        assert.deepEqual(bridge.errors, []);
      } finally {
        for (const { client, transport } of connections) {
          await client.close();
          await transport.close();
        }
        await bridge.close();
      }
    }
  );
}

test(
  'bbx-mcp serves tools/list and browser_investigate over stdio',
  {
    timeout: 15_000,
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
        command: nativeExecutable,
        args: ['mcp', 'serve'],
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

      const initialTools = await client.listTools();
      assert.equal(
        initialTools.tools.some((tool) => tool.name === 'browser_investigate'),
        false
      );
      const loadResult = (await client.callTool({
        name: 'browser_toolset',
        arguments: { tool: 'browser_investigate' },
      })) as CallToolResult;
      assert.equal((loadResult.structuredContent as { newlyEnabled: boolean }).newlyEnabled, true);

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
      assert.match(textContent.text, /Investigation complete \(quick, 2 steps\)/);
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
        ['page.get_state', 'dom.query']
      );
      assert.equal(bridgeServer.requests[0].tab_id, 17);
      assert.equal(bridgeServer.requests[1].tab_id, 17);
      assert.equal(bridgeServer.requests[0].meta.mcp_era, 'legacy');
      assert.equal(bridgeServer.requests[1].meta.mcp_era, 'legacy');
      assert.deepEqual(normalizeDomQuery(bridgeServer.requests[1].params), {
        selector: 'main',
        withinRef: null,
        budget: {
          maxNodes: 10,
          maxDepth: 2,
          textBudget: 300,
          // MCP query evidence omits boxes, so the request skips them too.
          includeBbox: false,
          attributeAllowlist: [],
        },
      });
    } finally {
      await Promise.allSettled([transport?.close(), bridgeServer.close()]);
    }
  }
);

test(
  'bbx-mcp forwards the modern MCP era to bridge requests',
  {
    timeout: 15_000,
  },
  async () => {
    const bridgeServer = await startBridgeSocketServer(async (message, { socket }) => {
      const request = getBridgeRequest(message);
      if (!request) return;
      socket.write(
        `${JSON.stringify({
          type: 'agent.response',
          response: createSuccess(
            request.id,
            {
              daemon: 'ok',
              extensionConnected: false,
              access: { enabled: false, routeReady: false, reason: 'access_disabled' },
            },
            { method: request.method }
          ),
        })}\n`
      );
    });
    let transport: StdioClientTransport | null = null;

    try {
      transport = new StdioClientTransport({
        command: nativeExecutable,
        args: ['mcp', 'serve'],
        cwd: repoRoot,
        env: toSpawnEnv({
          ...process.env,
          BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
        }),
        stderr: 'pipe',
      });
      const client = new Client(
        {
          name: 'browser-bridge-modern-era-integration-test',
          version: '1.0.0',
        },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } }
      );
      await client.connect(transport);
      await client.callTool({ name: 'browser_health', arguments: {} });

      assert.equal(client.getProtocolEra(), 'modern');
      assert.equal(bridgeServer.requests.length, 1);
      assert.equal(bridgeServer.requests[0].meta.source, 'mcp');
      assert.equal(bridgeServer.requests[0].meta.mcp_era, 'modern');
    } finally {
      await Promise.allSettled([transport?.close(), bridgeServer.close()]);
    }
  }
);

test('MCP toolset loads exact tools through tools/list notifications and fails closed', async () => {
  const clientTransport = new StdioClientTransport({
    command: nativeExecutable,
    args: ['mcp', 'serve'],
    cwd: repoRoot,
    env: toSpawnEnv(process.env),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'browser-bridge-toolset-test', version: '1.0.0' });
  let listChangedNotifications = 0;
  client.setNotificationHandler('notifications/tools/list_changed', () => {
    listChangedNotifications += 1;
  });

  try {
    await client.connect(clientTransport);

    assert.equal(client.getServerCapabilities()?.tools?.listChanged, true);
    assert.equal(listChangedNotifications, 0);
    assert.deepEqual((await client.listTools()).tools.map(({ name }) => name).sort(), [
      'browser_access',
      'browser_batch',
      'browser_call',
      'browser_health',
      'browser_status',
      'browser_toolset',
    ]);

    await assert.rejects(
      client.callTool({
        name: 'browser_dom',
        arguments: { action: 'query' },
      }),
      /Unknown tool: browser_dom/
    );

    const loaded = (await client.callTool({
      name: 'browser_toolset',
      arguments: { tool: 'browser_dom' },
    })) as CallToolResult;
    assert.equal((loaded.structuredContent as { newlyEnabled: boolean }).newlyEnabled, true);
    // Notifications are delivered independently of the tool-call response over
    // stdio. Wait for the SDK handler rather than relying on pipe chunk timing.
    for (let i = 0; i < 100 && listChangedNotifications === 0; i++) await delay(10);
    assert.equal(listChangedNotifications, 1);
    assert.equal((await client.listTools()).tools.length, 7);

    const repeated = (await client.callTool({
      name: 'browser_toolset',
      arguments: { tool: 'browser_dom' },
    })) as CallToolResult;
    assert.equal((repeated.structuredContent as { newlyEnabled: boolean }).newlyEnabled, false);
    assert.equal(listChangedNotifications, 1);

    await assert.rejects(
      client.callTool({
        name: 'browser_toolset',
        arguments: { tool: 'all' },
      }),
      /arguments.tool: value is not one of the permitted choices/
    );
    assert.equal(listChangedNotifications, 1);
  } finally {
    await client.close();
    await clientTransport.close();
  }
});
