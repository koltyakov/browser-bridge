import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { nativeExecutable, repoRoot } from '../_helpers/runCli.ts';

function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function evidence(result: CallToolResult): Record<string, unknown> {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const structured = record(result.structuredContent);
  assert.equal(structured.ok, true);
  return record(structured.evidence);
}

// Read-only. Both tabs must already be authorized in the selected profile.
// No tabs are created, activated, navigated, closed, or attached to a debugger.
test(
  'live shared MCP conversations retain independent working tabs',
  { timeout: 60000 },
  async () => {
    const extensionId = process.env.BBX_LIVE_EXTENSION_ID;
    const firstTab = Number(process.env.BBX_LIVE_TAB_ID);
    const secondTab = Number(process.env.BBX_LIVE_SECOND_TAB_ID);
    assert(extensionId, 'Set BBX_LIVE_EXTENSION_ID to the selected connection ID.');
    assert(Number.isSafeInteger(firstTab) && firstTab > 0, 'Set BBX_LIVE_TAB_ID.');
    assert(
      Number.isSafeInteger(secondTab) && secondTab > 0 && secondTab !== firstTab,
      'Set BBX_LIVE_SECOND_TAB_ID to a different authorized tab.'
    );
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries({
      ...process.env,
      BBX_REMOTE: '',
      BBX_AUTO_UPDATE: 'off',
    })) {
      if (typeof value === 'string') env[key] = value;
    }
    for (const era of ['legacy', 'modern'] as const) {
      const transport = new StdioClientTransport({
        command: nativeExecutable,
        args: ['mcp', 'serve'],
        cwd: repoRoot,
        env,
        stderr: 'pipe',
      });
      const client = new Client(
        { name: 'bbx-live-conversations', version: '1.0.0' },
        era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}
      );
      const call = (
        session: string,
        method: string,
        tabId?: number,
        params: Record<string, unknown> = {}
      ): Promise<CallToolResult> =>
        client.callTool({
          name: 'browser_call',
          arguments: { method, extensionId, params, ...(tabId === undefined ? {} : { tabId }) },
          _meta: { 'ai.opencode/sessionID': session },
        });
      const listed = async (session: string): Promise<Record<string, unknown>> =>
        evidence(await call(session, 'tabs.list'));
      try {
        await client.connect(transport);
        const first = `ses_live_a_${crypto.randomUUID()}`;
        const second = `ses_live_b_${crypto.randomUUID()}`;
        const initial = await listed(first);
        const activeBefore = (initial.tabs as Array<Record<string, unknown>>)
          .filter((tab) => tab.active === true)
          .map((tab) => tab.tabId);
        evidence(await call(first, 'page.get_state', firstTab));
        evidence(await call(second, 'page.get_state', secondTab));
        for (let iteration = 0; iteration < 3; iteration += 1) {
          await Promise.all([
            call(first, 'page.get_state').then(evidence),
            call(second, 'page.get_state').then(evidence),
          ]);
          const [a, b] = await Promise.all([listed(first), listed(second)]);
          assert.equal(a.workingTabId, firstTab, `${era}: first conversation drifted`);
          assert.equal(b.workingTabId, secondTab, `${era}: second conversation drifted`);
        }
        const final = await listed(first);
        assert.deepEqual(
          (final.tabs as Array<Record<string, unknown>>)
            .filter((tab) => tab.active === true)
            .map((tab) => tab.tabId),
          activeBefore,
          'Read-only tests must preserve the active tab.'
        );
      } finally {
        await client.close();
        await transport.close();
      }
    }
  }
);
