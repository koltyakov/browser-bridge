import assert from 'node:assert/strict';
import test from 'node:test';
import type { Socket } from 'node:net';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createSuccess, createFailure } from '../../protocol/src/index.js';
import type { BridgeMethod } from '../../protocol/src/types.js';
import { createAgentTabLeaseStore } from '../../packages/extension/src/background-agent-tabs.js';
import { createFileStaging } from '../../packages/extension/src/background-files.js';
import { bridgeServerWith } from '../_helpers/socketHarness.ts';
import { isolatedBridgeEnv, nativeExecutable, repoRoot } from '../_helpers/runCli.ts';

function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function evidence(result: CallToolResult): Record<string, unknown> {
  assert.notEqual(result.isError, true);
  const structured = record(result.structuredContent);
  assert.equal(structured.ok, true);
  return record(structured.evidence);
}

for (const era of ['legacy', 'modern'] as const) {
  test(`MCP ${era} partitions pooled conversations without splitting their transport`, async () => {
    const leases = createAgentTabLeaseStore();
    const files = createFileStaging();
    const sockets = new Set<Socket>();
    const identities = new Set<string>();
    const bridge = await bridgeServerWith({
      'page.get_state': async (request, { socket }) => {
        sockets.add(socket);
        const session = request.meta?.agent_session;
        assert.equal(typeof session, 'string');
        const identity = String(session);
        identities.add(identity);
        assert.match(identity, /^mcp_[a-f0-9]{64}$/u);
        const tabId = request.tab_id ?? (await leases.get(identity))?.tabId;
        assert(tabId, 'The caller must bind its own tab before an implicit read.');
        await leases.bind(identity, tabId, 1);
        return createSuccess(request.id, {
          url: `https://example.test/${tabId}`,
          title: `Tab ${tabId}`,
          readyState: 'complete',
        });
      },
      'files.stage': (request, { socket }) => {
        assert(sockets.has(socket), 'File staging must retain the shared daemon transport.');
        return createSuccess(
          request.id,
          files.stage(
            { name: 'note.txt', size: 1, data: 'YQ==' },
            `transport:${String(request.meta?.agent_session)}`,
            11
          )
        );
      },
      'input.set_files': (request) => {
        try {
          const assigned = files.resolve(
            request.params.files as string[],
            `transport:${String(request.meta?.agent_session)}`,
            11
          );
          return createSuccess(request.id, { assigned: true, count: assigned.length });
        } catch {
          return createFailure(
            request.id,
            'ACCESS_DENIED',
            'File belongs to another conversation.'
          );
        }
      },
    });
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      isolatedBridgeEnv({
        ...process.env,
        BROWSER_BRIDGE_HOME: bridge.bridgeHome,
        BBX_SESSION: 'shared-namespace',
      })
    )) {
      if (typeof value === 'string') env[key] = value;
    }
    const transport = new StdioClientTransport({
      command: nativeExecutable,
      args: ['mcp', 'serve'],
      cwd: repoRoot,
      env,
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'conversation-integration', version: '1.0.0' },
      era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}
    );
    const call = (
      session: string,
      method: BridgeMethod,
      tabId?: number,
      params: Record<string, unknown> = {}
    ) =>
      client.callTool({
        name: 'browser_call',
        arguments: { method, params, ...(tabId === undefined ? {} : { tabId }) },
        _meta: { 'ai.opencode/sessionID': session },
      });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 6, 'Isolation must not expand the default catalog.');
      assert.equal(
        evidence(await call('ses_a', 'page.get_state', 11)).url,
        'https://example.test/11'
      );
      assert.equal(
        evidence(await call('ses_b', 'page.get_state', 12)).url,
        'https://example.test/12'
      );
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          call(index % 2 === 0 ? 'ses_a' : 'ses_b', 'page.get_state')
        )
      );
      results.forEach((result, index) =>
        assert.equal(evidence(result).url, `https://example.test/${index % 2 === 0 ? 11 : 12}`)
      );
      assert.equal(
        sockets.size,
        1,
        'Conversation isolation must not open a connection per caller.'
      );
      assert.equal(identities.size, 2);
      const staged = evidence(await call('ses_a', 'files.stage', 11));
      const fileParams = { target: { selector: '#upload' }, files: [staged.transferId] };
      assert.equal(
        (await call('ses_b', 'input.set_files', 11, fileParams)).isError,
        true,
        'Same transport and tab must not permit another conversation to use a staged file.'
      );
      assert.equal(evidence(await call('ses_a', 'input.set_files', 11, fileParams)).assigned, true);
      assert.equal(evidence(await call('ses_a', 'page.get_state')).url, 'https://example.test/11');
      assert.equal(evidence(await call('ses_b', 'page.get_state')).url, 'https://example.test/12');
      assert(bridge.requests.every((request) => !JSON.stringify(request).includes('ses_')));
      assert.deepEqual(bridge.errors, []);
    } finally {
      await client.close();
      await transport.close();
      await bridge.close();
    }
  });
}
