import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ChaosHarness } from './chaos-harness.ts';
import { eventually, object } from '../_helpers/chromePipe.ts';
import { isolatedBridgeEnv, nativeExecutable, repoRoot } from '../_helpers/runCli.ts';

function evidence(result: CallToolResult): Record<string, unknown> {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const content = object(result.structuredContent);
  assert.equal(content.ok, true, JSON.stringify(content));
  return object(content.evidence);
}

class ChainClient {
  private readonly transport: StdioClientTransport;
  private readonly client: Client;
  extensionId = '';
  constructor(harness: ChaosHarness, era: 'legacy' | 'modern') {
    const env = Object.fromEntries(
      Object.entries({
        ...isolatedBridgeEnv(process.env),
        HOME: harness.root,
        CFFIXED_USER_HOME: harness.root,
        BROWSER_BRIDGE_HOME: harness.home,
      }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
    this.transport = new StdioClientTransport({
      command: nativeExecutable,
      args: ['mcp', 'serve'],
      cwd: repoRoot,
      env,
      stderr: 'pipe',
    });
    this.client = new Client(
      { name: 'bbx-full-chain-regression', version: '1.0.0' },
      era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}
    );
  }
  async connect(): Promise<void> {
    await this.client.connect(this.transport);
    await this.refresh();
  }
  async refresh(): Promise<Record<string, unknown>> {
    const health = evidence(
      await this.client.callTool({ name: 'browser_call', arguments: { method: 'health.ping' } })
    );
    assert.equal(health.extensionConnected, true);
    assert(Array.isArray(health.connectedExtensions));
    assert.equal(
      health.connectedExtensions.length,
      1,
      'Only the private extension may be connected'
    );
    this.extensionId = String(object(health.connectedExtensions[0]).extensionId);
    assert(this.extensionId);
    return health;
  }
  call(
    method: string,
    tabId: number,
    params: Record<string, unknown> = {},
    signal?: AbortSignal
  ): Promise<CallToolResult> {
    return this.client.callTool(
      {
        name: 'browser_call',
        arguments: { method, tabId, params, extensionId: this.extensionId },
        _meta: { 'ai.opencode/sessionID': 'ses_full_chain' },
      },
      signal ? { signal } : undefined
    );
  }
  async close(): Promise<void> {
    try {
      await this.client.close();
    } finally {
      await this.transport.close();
    }
  }
}

async function extensionIdentity(directory: string): Promise<Record<string, unknown>> {
  const manifest = object(
    JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))
  );
  const hashes: Record<string, string> = {};
  for (const name of ['manifest.json', 'src/background.js', 'src/content-input.js']) {
    hashes[name] = createHash('sha256')
      .update(await readFile(path.join(directory, name)))
      .digest('hex');
  }
  return { directory, version: manifest.version, hashes };
}

// A separate opt-in target. No personal browser, system native registration or
// synthetic transport adapters are used. CDP only injects faults/observes fixtures.
test('MCP to installed extension full-chain regressions', { timeout: 240000 }, async (t) => {
  const executable = process.env.BBX_CHAIN_CHROME;
  const legacyDirectory = process.env.BBX_CHAIN_LEGACY_EXTENSION;
  assert(
    executable && path.isAbsolute(executable),
    'Set BBX_CHAIN_CHROME to an absolute Chrome for Testing/Chromium executable.'
  );
  assert(
    legacyDirectory && path.isAbsolute(legacyDirectory),
    'Set BBX_CHAIN_LEGACY_EXTENSION to an actual older built extension directory. No version relabeling or fabricated legacy responses.'
  );
  const currentDirectory = path.join(repoRoot, 'dist/ext');
  const current = await extensionIdentity(currentDirectory);
  const legacy = await extensionIdentity(await realpath(legacyDirectory));
  assert.notEqual(
    legacy.version,
    current.version,
    'Mixed-version coverage requires genuinely different extension versions.'
  );
  assert.equal(
    String(legacy.version).split('.')[0],
    String(current.version).split('.')[0],
    'Supply a protocol-compatible older extension from the same major release.'
  );
  const output = path.join(
    repoRoot,
    'dist',
    'full-chain-live',
    `${Date.now()}-${randomUUID().slice(0, 8)}`
  );
  await mkdir(output, { recursive: true });
  const measurements: Array<Record<string, unknown>> = [];
  let passed = false;
  t.after(() =>
    writeFile(
      path.join(output, 'results.json'),
      JSON.stringify(
        {
          passed,
          boundary:
            'Real MCP stdio, current Go server/client/daemon, Chrome native messaging, installed unpacked extension and synthetic Chrome fixture.',
          current,
          legacy,
          measurements,
        },
        null,
        2
      )
    )
  );
  t.diagnostic(`Full-chain evidence: ${output}`);

  for (const [name, directory, identity] of [
    ['current', currentDirectory, current],
    ['legacy', String(legacy.directory), legacy],
  ] as const) {
    let completed = false;
    let cleaned = false;
    await t.test(`${name} extension with current Go/MCP`, async (child) => {
      const harness = new ChaosHarness({
        portable: true,
        extensionDirectory: directory,
        outputDirectory: path.join(output, name),
      });
      const clients = new Set<ChainClient>();
      child.after(async () => {
        let clientsClosed = false;
        try {
          for (const client of clients) await client.close();
          clientsClosed = true;
        } finally {
          await harness.close();
          cleaned = clientsClosed;
          measurements.push({ name, cleanup: cleaned, harness: harness.measurements });
        }
      });
      await harness.start(executable);
      async function connect(era: 'legacy' | 'modern' = 'modern') {
        const client = new ChainClient(harness, era);
        clients.add(client);
        await client.connect();
        return client;
      }
      async function close(client: ChainClient) {
        await client.close();
        clients.delete(client);
      }
      async function verifiedClick(client: ChainClient) {
        const before = Number((await harness.state()).probe);
        const result = evidence(
          await client.call('input.click', harness.tabId, {
            target: { selector: '#probe' },
            executionMode: 'cdp',
            observe: true,
          })
        );
        assert.equal((await harness.state()).probe, before + 1);
        return result;
      }
      async function idle() {
        assert(harness.control);
        await eventually('full-chain cancellation/cleanup', 15000, async () => {
          const metrics = await harness.call(harness.control!, 'daemon.metrics');
          assert.equal(metrics.pendingRequests, 0);
          assert.equal(metrics.activeExtensions, 1);
          assert.equal(metrics.activeAgents, clients.size + 1);
          const scheduler = object(metrics.scheduler);
          for (const key of ['preparing', 'queued', 'running', 'canceling'])
            assert.equal(scheduler[key], 0, key);
        });
      }
      for (const era of ['legacy', 'modern'] as const) {
        const client = await connect(era);
        const health = await client.refresh();
        assert.equal(health.extensionVersion, identity.version);
        assert.equal(health.daemonVersion, current.version);
        const state = evidence(await client.call('page.get_state', harness.tabId));
        assert.match(String(state.url), /^http:\/\/127\.0\.0\.1:/);
        const click = await verifiedClick(client);
        const search = await client.call('protocol.describe', harness.tabId, {
          query: 'input.fill',
          limit: 1,
        });
        const matches = object(search.structuredContent).matches;
        assert(Array.isArray(matches));
        assert.equal(object(matches[0]).method, 'input.fill');
        measurements.push({ name, era, health, click });
        await close(client);
      }
      let client = await connect();
      if (name === 'current') {
        const capability = evidence(
          await client.call('protocol.capabilities', harness.tabId, {
            calls: [{ method: 'input.fill' }],
            executionMode: 'cdp',
          })
        );
        assert.equal(capability.advisory, true);
        assert(Array.isArray(capability.operations));
        assert.equal(object(capability.operations[0]).status, 'available');
        for (const attachment of ['retained', 'normally_detached'] as const) {
          await verifiedClick(client);
          const attached = () =>
            harness.uiEvaluate(
              `(await chrome.debugger.getTargets()).some(target => target.tabId === ${harness.tabId} && target.attached)`
            );
          if (attachment === 'retained') {
            assert.equal(await attached(), true, 'Restart must interrupt a retained attachment');
          } else {
            await eventually('normal burst-idle detach before restart', 10000, async () => {
              assert.equal(await attached(), false);
            });
          }
          const oldConnection = client.extensionId;
          const workerId = await harness.stopWorker();
          await eventually('MCP recovery after MV3 restart/native reconnect', 30000, async () => {
            const health = await client.refresh();
            assert.notEqual(client.extensionId, oldConnection);
            const loaded = object(
              health.loadedBuild ??
                evidence(await client.call('health.ping', harness.tabId, { diagnostics: true }))
                  .loadedBuild
            );
            assert.notEqual(loaded.workerId, workerId, 'Worker must actually be replaced');
            evidence(await client.call('page.get_state', harness.tabId));
          });
          // No retries or manual debugger resets: recovery must precede this
          // one deliberate action, whose exact-once effect is checked separately.
          const click = await verifiedClick(client);
          measurements.push({
            name,
            fault: 'worker_restart_and_native_reconnect',
            attachment,
            oldConnection,
            newConnection: client.extensionId,
            workerId,
            click,
          });
        }
      } else {
        const unsupported = await client.call('protocol.capabilities', harness.tabId, {
          calls: [{ method: 'input.fill' }],
        });
        assert.equal(
          unsupported.isError,
          true,
          'Old extension must not invent support for a new RPC'
        );
        assert.equal(object(object(unsupported.structuredContent).error).code, 'INVALID_REQUEST');
        measurements.push({ name, mixedVersions: true, unsupported });
      }

      for (const fault of ['cancel', 'mcp_disconnect'] as const) {
        const before = await harness.state();
        const abort = new AbortController();
        const pending = client.call(
          'input.perform',
          harness.tabId,
          {
            timeoutMs: 10000,
            steps: [
              {
                method: 'input.click',
                params: { target: { selector: '#first' }, executionMode: 'cdp', observe: false },
              },
              {
                method: 'input.click',
                delayMs: 2500,
                params: { target: { selector: '#late' }, executionMode: 'cdp', observe: false },
              },
            ],
          },
          abort.signal
        );
        // Attach rejection handling before fault injection, including transport EOF.
        const settled = pending.then(
          (value) => ({ result: value }),
          (error) => ({ error: String(error) })
        );
        await eventually('first full-chain native step', 5000, async () => {
          assert.equal((await harness.state()).first, Number(before.first) + 1);
        });
        if (fault === 'cancel') abort.abort();
        else await close(client);
        const outcome = await settled;
        assert(
          'error' in outcome || outcome.result?.isError === true,
          'Interrupted sequence must not report success'
        );
        if ('result' in outcome) {
          const recovery = object(object(outcome.result.structuredContent).recovery);
          assert.equal(recovery.retry, false, 'Interrupted input must not advertise replay');
          assert.equal(
            recovery.retryAfterMs,
            undefined,
            'Interrupted input must not advertise backoff'
          );
          assert.match(String(recovery.hint), /do not replay/i);
        }
        if (fault === 'mcp_disconnect') client = await connect();
        await delay(2800);
        const after = await harness.state();
        assert.equal(after.first, Number(before.first) + 1, 'First step was replayed');
        assert.equal(after.late, before.late, 'Canceled/disconnected sequence resumed');
        await idle();
        await verifiedClick(client);
        measurements.push({ name, fault, before, after, outcome });
      }
      await close(client);
      await idle();
      completed = true;
    });
    assert(completed && cleaned, 'Stop after a failed full-chain version; inspect saved evidence.');
  }
  passed = true;
});
