// @ts-check

/**
 * Agent interaction benchmark against real Chrome.
 *
 * Opens the fixture in a background tab (the user's active tab is never
 * touched: the bench runs under its own BBX_SESSION working tab), runs each
 * scenario the way an agent would, and reports success, bridge calls, and the
 * tokens an agent would read. Requires a running daemon and an enabled window.
 *
 *   make build-native
 *   node tests/fixtures/agent-interaction/bench.mjs [--json] [--runs=5]
 */

import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startInteractionFixtureServer } from './server.mjs';
import { latencyPercentiles, measureScenario, outlineText } from './measure.mjs';

/** @typedef {import('../../../protocol/types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('./measure.mjs').BridgeResponse} BridgeResponse */
/**
 * @typedef {{
 *   name: string,
 *   run: (call: (method: BridgeMethod, params?: Record<string, unknown>) => Promise<BridgeResponse>) => Promise<unknown>,
 *   verify: (state: Record<string, unknown>, last: BridgeResponse | null) => boolean,
 * }} Scenario
 */

/** @type {Scenario[]} */
const SCENARIOS = [
  {
    name: 'verified save with response and DOM evidence',
    run: (call) =>
      call('input.perform', {
        steps: [
          {
            method: 'input.click',
            params: { target: { role: 'button', name: 'Save profile', exact: true } },
          },
        ],
        outcomes: [
          {
            kind: 'network',
            urlPattern: '/api/profile',
            method: 'POST',
            statusMin: 200,
            statusMax: 299,
          },
          { kind: 'dom', selector: '#profile-status', text: 'Profile saved' },
        ],
        timeoutMs: 10000,
      }),
    verify: (state, last) =>
      state.profileSaved === true &&
      last?.ok === true &&
      /** @type {{verified?: boolean}} */ (last.result).verified === true,
  },
  {
    name: 'verified navigation with URL and DOM evidence',
    run: (call) =>
      call('input.perform', {
        steps: [{ method: 'input.click', params: { target: { role: 'link', name: 'Dashboard' } } }],
        outcomes: [
          { kind: 'url', url: '/dashboard', urlMatch: 'contains' },
          { kind: 'dom', selector: 'h1', text: 'Dashboard' },
        ],
        timeoutMs: 10000,
      }),
    verify: (state, last) =>
      state.route === '/dashboard' &&
      last?.ok === true &&
      /** @type {{verified?: boolean}} */ (last.result).verified === true,
  },
  {
    name: 'fill by label[for]',
    run: (call) =>
      call('input.fill', { target: { label: 'Email address' }, value: 'ada@example.test' }),
    verify: (state) => state.email === 'ada@example.test',
  },
  {
    name: 'fill by wrapped label (role+name)',
    run: (call) =>
      call('input.fill', { target: { role: 'textbox', name: 'Full name' }, value: 'Ada' }),
    verify: (state) => state.fullname === 'Ada',
  },
  {
    name: 'click inside closed shadow root',
    run: (call) => call('input.click', { target: { role: 'button', name: 'Shadow save' } }),
    verify: (state) => state.shadowSaved === true,
  },
  {
    name: 'click element that appears late',
    run: (call) => call('input.click', { target: { text: 'Load more' }, timeoutMs: 4000 }),
    verify: (state) => state.loadedMore === true,
  },
  {
    name: 'click with hidden duplicate + observe toast',
    run: (call) => call('input.click', { target: { role: 'button', name: 'Place order' } }),
    verify: (state, last) =>
      state.orderPlaced === true &&
      JSON.stringify(last?.ok ? last.result : null).includes('Order placed'),
  },
  {
    name: 'click inside iframe',
    run: (call) => call('input.click', { target: { text: 'Pay now' } }),
    verify: (state) => state.paid === true,
  },
  {
    name: 'fill and submit with final effects in one call',
    run: (call) =>
      call('input.perform', {
        returnLastResult: true,
        steps: [
          {
            method: 'input.fill',
            params: { target: { label: 'Email address' }, value: 'flow@example.test' },
          },
          {
            method: 'input.fill',
            params: { target: { role: 'textbox', name: 'Full name' }, value: 'Flow test' },
          },
          {
            method: 'input.click',
            params: { target: { role: 'button', name: 'Place order' }, observe: true },
          },
        ],
      }),
    verify: (state, last) =>
      state.email === 'flow@example.test' &&
      state.fullname === 'Flow test' &&
      state.orderPlaced === true &&
      JSON.stringify(last?.ok ? last.result : null).includes('Order placed'),
  },
  {
    name: 'fill model-driven rich editor',
    run: (call) =>
      call('input.fill', { target: { role: 'textbox', name: 'Notes' }, value: 'Leave at door' }),
    verify: (state) => state.notes === 'Leave at door',
  },
  {
    name: 'click animated button',
    run: (call) => call('input.click', { target: { role: 'button', name: 'Animated action' } }),
    verify: (state) => state.animatedClicked === true,
  },
  {
    name: 'SPA navigation reported in effects',
    run: (call) => call('input.click', { target: { role: 'link', name: 'Dashboard' } }),
    verify: (state, last) =>
      state.route === '/dashboard' &&
      JSON.stringify(last?.ok ? last.result : null).includes('/dashboard'),
  },
  {
    name: 'actionable outline overview',
    run: (call) => call('dom.get_accessibility_tree', { source: 'dom', interactiveOnly: true }),
    verify: (_state, last) => {
      const outline = last?.ok ? outlineText(last.result) : '';
      return /button "Pay now" \[el_/.test(outline) && /button "Shadow save" \[el_/.test(outline);
    },
  },
];

const executable =
  process.env.BBX_NATIVE_EXECUTABLE ||
  fileURLToPath(
    new URL(`../../../dist/cli/bbx${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url)
  );
const runs = Number(
  process.argv.find((argument) => argument.startsWith('--runs='))?.split('=')[1] ?? 1
);
if (!Number.isInteger(runs) || runs < 1 || runs > 100)
  throw new Error('--runs must be an integer between 1 and 100');
const client = new Client({ name: 'bbx-interaction-bench', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: executable,
  args: ['mcp', 'serve'],
  env: Object.fromEntries(
    Object.entries({
      ...process.env,
      BBX_SESSION: 'bbx-interaction-bench',
      BBX_AUTO_UPDATE: 'off',
    }).filter((entry) => typeof entry[1] === 'string')
  ),
  stderr: 'inherit',
});
const { server, origin } = await startInteractionFixtureServer({ port: 0 });
/** @type {Array<Awaited<ReturnType<typeof measureScenario>> & {run: number}>} */
const rows = [];
let tabId = /** @type {number | null} */ (null);
let extensionId = /** @type {string | null} */ (null);

/**
 * @param {{method: BridgeMethod, params?: Record<string, unknown>, tabId?: number}} input
 * @returns {Promise<BridgeResponse>}
 */
async function request(input) {
  const result = await client.callTool({
    name: 'browser_call',
    arguments: {
      method: input.method,
      params: input.params ?? {},
      ...((input.tabId ?? tabId) ? { tabId: input.tabId ?? tabId } : {}),
      ...(extensionId ? { extensionId } : {}),
    },
  });
  const structured =
    /** @type {{ok?: boolean, evidence?: unknown, error?: {code?: string, message?: string}, deliveredTokens?: number, timing?: import('./measure.mjs').BridgeTiming}} */ (
      result.structuredContent ?? {}
    );
  const tokens = structured.deliveredTokens ?? Math.ceil(JSON.stringify(result.content).length / 4);
  if (result.isError || structured.ok === false) {
    return {
      ok: false,
      result: null,
      error: {
        code: structured.error?.code ?? 'BRIDGE_ERROR',
        message: structured.error?.message ?? JSON.stringify(result.content),
      },
      tokens,
      ...(structured.timing ? { timing: structured.timing } : {}),
    };
  }
  return {
    ok: true,
    result: structured.evidence,
    tokens,
    ...(structured.timing ? { timing: structured.timing } : {}),
  };
}

try {
  await client.connect(transport);
  const health = await request({ method: 'health.ping' });
  if (!health.ok) throw new Error(`health.ping failed: ${health.error.message}`);
  const connections =
    /** @type {{connectedExtensions?: Array<{extensionId?: string, accessEnabled?: boolean}>}} */ (
      health.result
    ).connectedExtensions ?? [];
  const enabled = connections.filter(
    (connection) => connection.accessEnabled && connection.extensionId
  );
  if (enabled.length !== 1)
    throw new Error(
      'The benchmark requires exactly one enabled profile to avoid ambiguous routing.'
    );
  extensionId = enabled[0].extensionId ?? null;
  const created = await request({
    method: 'tabs.create',
    params: { url: `${origin}/`, active: false },
  });
  if (!created.ok) throw new Error(`tabs.create failed: ${created.error.message}`);
  tabId = /** @type {{ tabId: number }} */ (created.result).tabId;
  const loaded = await request({
    method: 'page.wait_for_load_state',
    params: { waitForLoad: true, url: origin, urlMatch: 'contains', timeoutMs: 10_000 },
  });
  if (!loaded.ok) throw new Error(`Fixture initial load failed: ${loaded.error.message}`);
  for (let run = 1; run <= runs; run += 1) {
    for (const [index, scenario] of SCENARIOS.entries()) {
      // Reset state outside the measured interval so repeated actions cannot pass
      // from a prior scenario's state or miss an already-visible toast.
      const reset = await request({
        method: 'navigation.navigate',
        params: {
          url: `${origin}/?run=${run}&scenario=${index}`,
          waitForLoad: true,
          timeoutMs: 10_000,
        },
      });
      if (!reset.ok) throw new Error(`Fixture reset failed: ${reset.error.message}`);
      rows.push({
        ...(await measureScenario(scenario, (method, params) => request({ method, params }))),
        run,
      });
    }
  }
} finally {
  if (tabId !== null) {
    await request({ method: 'tabs.close', params: { tabId } }).catch(() => {});
  }
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
  server.close();
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
} else {
  const passed = rows.filter((row) => row.ok).length;
  for (const row of rows) {
    process.stdout.write(
      `${row.ok ? 'PASS' : 'FAIL'}  ${row.scenario.padEnd(44)} calls=${row.calls} tokens=${String(row.tokens).padStart(4)} ${row.ms.toFixed(1)}ms${row.error ? `  (${row.error})` : ''}\n`
    );
  }
  const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
  const totalCalls = rows.reduce((sum, row) => sum + row.calls, 0);
  process.stdout.write(
    `\n${passed}/${rows.length} scenarios passed, ${totalCalls} calls, ~${totalTokens} agent-visible tokens.\n`
  );
  for (const scenario of SCENARIOS) {
    const samples = rows
      .filter((row) => row.scenario === scenario.name && row.ok)
      .map((row) => row.ms);
    const latency = latencyPercentiles(samples);
    process.stdout.write(
      `${scenario.name}: successes=${samples.length}/${runs} ${samples.length ? `p50=${latency.p50.toFixed(1)}ms p95=${latency.p95.toFixed(1)}ms` : 'no successful latency samples'}\n`
    );
  }
}
process.exitCode = rows.every((row) => row.ok) ? 0 : 1;
