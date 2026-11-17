import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createBrowserBridge } from '../../internal/bridge/generated/code-mode/browser-bridge.mjs';
import { createFailure, createSuccess } from '../../protocol/src/index.js';
import type { BridgeRequest } from '../../protocol/types.js';
import { startBridgeSocketServer } from '../_helpers/socketHarness.ts';
import { isolatedBridgeEnv, nativeExecutable, repoRoot, runCli } from '../_helpers/runCli.ts';

test('the Go CLI exports the complete Code Mode adapter without a running daemon', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-code-mode-cli-'));
  try {
    const env = isolatedBridgeEnv({ ...process.env, BROWSER_BRIDGE_HOME: home });
    for (const [format, extension] of [
      ['javascript', 'mjs'],
      ['declarations', 'd.mts'],
      ['typescript', 'ts'],
    ]) {
      const result = await runCli({ args: ['protocol', 'adapter', format], env });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        result.stdout,
        await fs.readFile(
          path.join(repoRoot, 'internal/bridge/generated/code-mode', `browser-bridge.${extension}`),
          'utf8'
        )
      );
    }
    const invalid = await runCli({ args: ['protocol', 'adapter', 'unknown'], env });
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, /usage: bbx protocol adapter/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

for (const era of ['legacy', 'modern'] as const) {
  test(
    `Code Mode preserves ${era} Go MCP validation, routing, denials, and cancellation`,
    { timeout: 15000 },
    async () => {
      const requests: BridgeRequest[] = [];
      let allowed = false;
      let sawPending = () => {};
      const pending = new Promise<void>((resolve) => {
        sawPending = resolve;
      });
      const server = await startBridgeSocketServer((message, { socket }) => {
        const frame = message as { type?: string; request?: BridgeRequest };
        if (frame.type !== 'agent.request' || !frame.request) return;
        const request = frame.request;
        requests.push(request);
        if (request.method === 'page.get_text') {
          sawPending();
          return;
        }
        const response =
          request.method === 'input.click' && !allowed
            ? createFailure(
                request.id,
                'ACCESS_DENIED',
                'The current browser grant denies input.',
                { dispatched: false }
              )
            : createSuccess(request.id, { clicked: request.method === 'input.click', count: 2 });
        socket.write(`${JSON.stringify({ type: 'agent.response', response })}\n`);
      });
      const transport = new StdioClientTransport({
        command: nativeExecutable,
        args: ['mcp', 'serve'],
        cwd: repoRoot,
        env: Object.fromEntries(
          Object.entries(
            isolatedBridgeEnv({ ...process.env, BROWSER_BRIDGE_HOME: server.bridgeHome })
          ).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        ),
        stderr: 'pipe',
      });
      const client = new Client(
        { name: 'code-mode-test', version: '1.0.0' },
        era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}
      );
      try {
        await client.connect(transport);
        const initialTools = (await client.listTools()).tools.map((tool) => tool.name);
        assert.equal(initialTools.length, 6, 'The adapter must not expand MCP startup tools');
        const bridge = createBrowserBridge(
          (args, options) => client.callTool({ name: 'browser_call', arguments: args }, options),
          { extensionId: 'owned-profile', tabId: 17, budgetPreset: 'quick' }
        );
        assert.equal(requests.length, 0, 'Binding creation does not probe or act');
        const denied = await bridge.input.click({ target: { selector: '#save' }, observe: false });
        assert.equal(denied.isError, true);
        const content = denied.structuredContent as {
          error: { code: string; details: { dispatched: boolean } };
        };
        assert.equal(content.error.code, 'ACCESS_DENIED');
        assert.equal(content.error.details.dispatched, false);
        assert.equal(requests.length, 1, 'A denied mutation is not retried');
        assert.equal(requests[0].method, 'input.click');
        assert.equal(requests[0].tab_id, 17);
        assert.equal(requests[0].meta.target_extension, 'owned-profile');
        assert.equal(requests[0].meta.source, 'mcp');
        assert.equal(requests[0].meta.mcp_era, era);
        assert.deepEqual(requests[0].params.target, { selector: '#save' });
        await assert.rejects(bridge.page.get_state({}, { tabId: -1 }));
        assert.equal(
          requests.length,
          1,
          'Go MCP validation still rejects invalid routing before dispatch'
        );
        allowed = true;
        assert.notEqual(
          (await bridge.input.click({ target: { selector: '#save' } })).isError,
          true
        );
        assert.equal(requests.length, 2, 'Only the next explicit action executes');
        const abort = new AbortController();
        const waiting = bridge.page.get_text({}, { signal: abort.signal });
        const rejected = assert.rejects(waiting, /cancel|abort/iu);
        await pending;
        abort.abort();
        await rejected;
        assert.deepEqual(
          (await client.listTools()).tools.map((tool) => tool.name),
          initialTools
        );
        assert.deepEqual(server.errors, []);
      } finally {
        await client.close();
        await transport.close();
        await server.close();
      }
    }
  );
}
