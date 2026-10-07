// @ts-check

/**
 * Agent interaction benchmark against real Chrome.
 *
 * Opens the fixture in a background tab (the user's active tab is never
 * touched: the bench runs under its own BBX_SESSION working tab), runs each
 * scenario the way an agent would, and reports success, bridge calls, and the
 * tokens an agent would read. Requires a running daemon and an enabled window.
 *
 *   node tests/fixtures/agent-interaction/bench.mjs [--json]
 */

import { BridgeClient } from '../../../packages/agent-client/src/client.js';
import {
  annotateBridgeSummary,
  summarizeBridgeResponse,
} from '../../../packages/protocol/src/index.js';
import { startInteractionFixtureServer } from './server.mjs';

/** @typedef {import('../../../packages/protocol/src/types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('../../../packages/protocol/src/types.js').BridgeResponse} BridgeResponse */
/**
 * @typedef {{
 *   name: string,
 *   run: (call: (method: BridgeMethod, params?: Record<string, unknown>) => Promise<BridgeResponse>) => Promise<void>,
 *   verify: (state: Record<string, unknown>, last: BridgeResponse | null) => boolean,
 * }} Scenario
 */

/** @type {Scenario[]} */
const SCENARIOS = [
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
      const outline = last?.ok
        ? String(/** @type {{ outline?: unknown }} */ (last.result).outline)
        : '';
      return /button "Pay now" \[el_/.test(outline) && /button "Shadow save" \[el_/.test(outline);
    },
  },
];

const client = new BridgeClient({
  agentSession: 'bbx-interaction-bench',
  checkProtocolOnConnect: false,
});
const { server, origin } = await startInteractionFixtureServer({ port: 0 });
/** @type {Array<{ scenario: string, ok: boolean, calls: number, tokens: number, ms: number, error?: string }>} */
const rows = [];
let tabId = /** @type {number | null} */ (null);

try {
  await client.connect();
  const created = await client.request({
    method: 'tabs.create',
    params: { url: `${origin}/`, active: false },
  });
  if (!created.ok) throw new Error(`tabs.create failed: ${created.error.message}`);
  tabId = /** @type {{ tabId: number }} */ (created.result).tabId;
  await client.request({
    method: 'page.wait_for_load_state',
    tabId,
    params: { waitForLoad: true, timeoutMs: 10_000 },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  for (const scenario of SCENARIOS) {
    let calls = 0;
    let tokens = 0;
    /** @type {BridgeResponse | null} */
    let last = null;
    const started = Date.now();
    /** @param {BridgeMethod} method @param {Record<string, unknown>} [params] */
    const call = async (method, params = {}) => {
      calls += 1;
      const response = await client.request({ method, params, timeoutMs: 30_000 });
      tokens += annotateBridgeSummary(
        summarizeBridgeResponse(response, method),
        response
      ).summaryTokens;
      last = response;
      return response;
    };
    try {
      await scenario.run(call);
      const stateResponse = await client.request({
        method: 'dom.get_attributes',
        params: { target: { selector: '#state' }, attributes: ['data-state'] },
      });
      const attributes = stateResponse.ok
        ? /** @type {Record<string, string | undefined>} */ (stateResponse.result)
        : {};
      const state = JSON.parse(attributes['data-state'] ?? '{}');
      rows.push({
        scenario: scenario.name,
        ok: scenario.verify(state, last),
        calls,
        tokens,
        ms: Date.now() - started,
        ...(/** @type {BridgeResponse | null} */ (last)?.ok === false
          ? { error: /** @type {{ error: { code: string } }} */ (last).error.code }
          : {}),
      });
    } catch (error) {
      rows.push({
        scenario: scenario.name,
        ok: false,
        calls,
        tokens,
        ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
} finally {
  if (tabId !== null) {
    await client.request({ method: 'tabs.close', params: { tabId } }).catch(() => {});
  }
  await client.close().catch(() => {});
  server.close();
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
} else {
  const passed = rows.filter((row) => row.ok).length;
  for (const row of rows) {
    process.stdout.write(
      `${row.ok ? 'PASS' : 'FAIL'}  ${row.scenario.padEnd(44)} calls=${row.calls} tokens=${String(row.tokens).padStart(4)} ${row.ms}ms${row.error ? `  (${row.error})` : ''}\n`
    );
  }
  const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
  const totalCalls = rows.reduce((sum, row) => sum + row.calls, 0);
  process.stdout.write(
    `\n${passed}/${rows.length} scenarios passed, ${totalCalls} calls, ~${totalTokens} agent-visible tokens.\n`
  );
  process.exitCode = passed === rows.length ? 0 : 1;
}
