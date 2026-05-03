// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import {
  interactiveCheckbox,
  interactiveConfirm,
  methodNeedsSession,
  parseCommaList,
  parseIntArg,
  parseJsonObject,
  parsePropertyAssignments,
} from '../src/cli-helpers.js';
import {
  findInstalledManagedTargets,
  getManagedSkillSentinelFilename,
  getSkillBasePath,
  installAgentFiles,
  installMcpClientSetup,
  parseInstallAgentArgs,
  removeAgentFiles,
} from '../src/install.js';
import {
  buildMcpConfig,
  formatMcpConfig,
  getMcpConfigPath,
  getMcpConfigPaths,
  installMcpConfig,
  isMcpClientName,
  removeMcpConfig,
} from '../src/mcp-config.js';
import { annotateBridgeSummary, summarizeBridgeResponse } from '../src/subagent.js';
import { BridgeClient } from '../src/client.js';
import { clockController } from '../../../tests/_helpers/faultInjection.js';

const expectedMcpCommand = process.platform === 'win32' ? process.execPath : 'bbx';
const expectedMcpArgs =
  process.platform === 'win32'
    ? [path.join(process.cwd(), 'packages', 'mcp-server', 'src', 'bin.js')]
    : ['mcp', 'serve'];
const expectedOpencodeCommand =
  process.platform === 'win32'
    ? [process.execPath, path.join(process.cwd(), 'packages', 'mcp-server', 'src', 'bin.js')]
    : ['bbx', 'mcp', 'serve'];

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Ensure failures stay compact for parent-agent reporting. */
test('summarizeBridgeResponse condenses failures', () => {
  const summary = summarizeBridgeResponse({
    id: 'req_fail',
    ok: false,
    result: null,
    error: {
      code: 'ACCESS_DENIED',
      message: 'Denied',
      details: { scope: 'tab' },
    },
    meta: { protocol_version: '1.0' },
  });

  assert.equal(summary.ok, false);
  assert.match(summary.summary, /ACCESS_DENIED/);
});

test('annotateBridgeSummary exposes transport and summary estimates', () => {
  const response =
    /** @type {import('../../protocol/src/types.js').BridgeResponse} */ ({
      id: 'req_meta',
      ok: true,
      result: { nodes: [{ tag: 'div', textExcerpt: 'hello' }] },
      error: null,
      meta: {
        protocol_version: '1.0',
        transport_bytes: 640,
        transport_approx_tokens: 160,
        transport_cost_class: 'moderate',
      },
    });

  const summary = annotateBridgeSummary(summarizeBridgeResponse(response), response);

  assert.equal(summary.transportBytes, 640);
  assert.equal(summary.transportTokens, 160);
  assert.equal(summary.transportCostClass, 'moderate');
  assert.ok(summary.summaryBytes > 0);
  assert.ok(summary.summaryTokens > 0);
});

test('BridgeClient.checkProtocolVersion prefers remote migration hints', () => {
  const result = BridgeClient.checkProtocolVersion({
    supported_versions: ['1.1'],
    migration_hint: 'Update the Browser Bridge CLI to match the extension.',
  });

  assert.equal(result.compatible, false);
  assert.equal(result.warning, 'Update the Browser Bridge CLI to match the extension.');
});

test('BridgeClient.checkProtocolVersion falls back to a generated mismatch warning', () => {
  const result = BridgeClient.checkProtocolVersion({
    supported_versions: ['0.0'],
  });

  assert.equal(result.compatible, false);
  assert.match(result.warning || '', /Protocol mismatch: client speaks/);
  assert.match(result.warning || '', /remote supports \[0\.0\]/);
});

test('BridgeClient.rejectAllPending rejects every pending request and clears the map', () => {
  const client = new BridgeClient();
  const error = new Error('Bridge socket closed.');
  /** @type {Error[]} */
  const rejected = [];

  for (const key of ['req_1', 'req_2']) {
    client.waiting.set(key, {
      resolve() {},
      reject(rejectionError) {
        rejected.push(rejectionError);
      },
      timeoutId: setTimeout(() => {}, 10_000),
    });
  }

  client.rejectAllPending(error);

  assert.equal(client.waiting.size, 0);
  assert.deepEqual(rejected, [error, error]);
});

test('BridgeClient.attachProtocolWarning returns the original response when empty and injects warnings when set', () => {
  const client = new BridgeClient();
  const response = /** @type {import('../../protocol/src/types.js').BridgeResponse} */ ({
    id: 'req_warn',
    ok: true,
    result: { value: 1 },
    error: null,
    meta: { protocol_version: '1.0' },
  });

  assert.strictEqual(client.attachProtocolWarning(response), response);

  client.protocolWarning = 'Update the extension to match the client.';
  assert.deepEqual(client.attachProtocolWarning(response), {
    ...response,
    meta: {
      ...response.meta,
      protocol_warning: 'Update the extension to match the client.',
    },
  });
});

test('BridgeClient.request rejects on timeout and removes the waiting entry', async (t) => {
  const client = new BridgeClient();

  t.mock.method(
    globalThis,
    'setTimeout',
    /** @type {typeof setTimeout} */ (
      /** @param {TimerHandler} callback */
      (callback) => {
        queueMicrotask(() => {
          if (typeof callback === 'function') {
            callback();
          }
        });
        return /** @type {any} */ ({ mocked: true });
      }
    )
  );

  client.socket = /** @type {any} */ ({
    destroyed: false,
    writable: true,
    write() {
      return true;
    },
  });

  await assert.rejects(client.request({ method: 'health.ping', timeoutMs: 25 }), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(/** @type {Error & { code?: string }} */ (error).code, 'BRIDGE_TIMEOUT');
    assert.match(error.message, /Timed out waiting for bridge response to health\.ping/);
    return true;
  });

  assert.equal(client.waiting.size, 0);
});

test('summarizeBridgeResponse adds stale element recovery hint', () => {
  const summary = summarizeBridgeResponse({
    id: 'req_stale',
    ok: false,
    result: null,
    error: {
      code: 'ELEMENT_STALE',
      message: 'Element reference is stale.',
      details: null,
    },
    meta: { protocol_version: '1.0' },
  });

  assert.equal(summary.ok, false);
  assert.match(summary.summary, /ELEMENT_STALE/);
  assert.match(summary.summary, /Re-query the current page after navigation or DOM updates/);
});

test('summarizeBridgeResponse surfaces protocol warnings from response metadata', () => {
  const summary = summarizeBridgeResponse({
    id: 'req_warn',
    ok: true,
    result: {
      url: 'https://example.com/',
      title: 'Example',
      origin: 'https://example.com',
      hints: {},
    },
    error: null,
    meta: {
      protocol_version: '1.0',
      protocol_warning: 'Update the Browser Bridge CLI to match the extension.',
    },
  });

  assert.equal(summary.ok, true);
  assert.match(summary.summary, /Protocol warning:/);
  assert.match(summary.summary, /Update the Browser Bridge CLI/);
});

/** Ensure generic successes return compact evidence. */
test('summarizeBridgeResponse condenses success payloads', () => {
  const summary = summarizeBridgeResponse({
    id: 'req_ok',
    ok: true,
    result: {
      a: 1,
      b: 2,
    },
    error: null,
    meta: { protocol_version: '1.0' },
  });

  assert.equal(summary.ok, true);
  assert.deepEqual(summary.evidence, ['a', 'b']);
});

/** Ensure CSS assignment parsing ignores malformed entries. */
test('parsePropertyAssignments handles css style pairs', () => {
  assert.deepEqual(parsePropertyAssignments(['display=flex', 'gap=8px', 'broken']), {
    display: 'flex',
    gap: '8px',
  });
});

/** Ensure property lists split cleanly for style queries. */
test('parseCommaList splits and trims values', () => {
  assert.deepEqual(parseCommaList('display, color, width'), ['display', 'color', 'width']);
});

/** Ensure JSON object parsing rejects non-object shapes. */
test('parseJsonObject parses objects and rejects arrays', () => {
  assert.deepEqual(parseJsonObject('{"selector":"body"}'), {
    selector: 'body',
  });
  assert.throws(() => parseJsonObject('[1,2,3]'), /Expected a JSON object but got array/);
  assert.throws(() => parseJsonObject('{bad json'), /Invalid JSON syntax/);
});

/** Ensure session requirements are inferred correctly for generic calls. */
test('methodNeedsSession distinguishes tab-bound methods', () => {
  assert.equal(methodNeedsSession('dom.query'), true);
  assert.equal(methodNeedsSession('input.click'), true);
  assert.equal(methodNeedsSession('navigation.navigate'), true);
  assert.equal(methodNeedsSession('page.get_state'), true);
  assert.equal(methodNeedsSession('tabs.list'), false);
});

/** Ensure network response summarization handles fetch entries correctly. */
test('summarizeBridgeResponse summarizes network entries', () => {
  const summary = summarizeBridgeResponse({
    id: 'req_net',
    ok: true,
    result: {
      entries: [
        {
          type: 'fetch',
          method: 'GET',
          url: '/api/data',
          status: 200,
          duration: 50,
        },
        {
          type: 'xhr',
          method: 'POST',
          url: '/api/save',
          status: 201,
          duration: 120,
        },
      ],
      count: 2,
      total: 2,
    },
    error: null,
    meta: { protocol_version: '1.0' },
  });

  assert.equal(summary.ok, true);
  assert.match(summary.summary, /Network: 2 requests/);
});

/** Ensure non-fetch/xhr entries are NOT matched as network. */
test('summarizeBridgeResponse does not misidentify non-network entries', () => {
  const summary = summarizeBridgeResponse({
    id: 'req_console',
    ok: true,
    result: {
      entries: [{ level: 'warn', args: ['test'], ts: 123 }],
      count: 1,
      total: 1,
    },
    error: null,
    meta: { protocol_version: '1.0' },
  });

  assert.equal(summary.ok, true);
  assert.match(summary.summary, /Console/);
});

/** Ensure health.ping responses show daemon/extension status. */
test('summarizeBridgeResponse formats health ping correctly', () => {
  const connected = summarizeBridgeResponse({
    id: 'req_health',
    ok: true,
    result: {
      daemon: 'ok',
      extensionConnected: true,
      socketPath: '/tmp/test.sock',
    },
    error: null,
    meta: { protocol_version: '1.0' },
  });
  assert.equal(connected.ok, true);
  assert.match(connected.summary, /Daemon: ok/);
  assert.match(connected.summary, /Extension: connected/);

  const disconnected = summarizeBridgeResponse({
    id: 'req_health2',
    ok: true,
    result: {
      daemon: 'ok',
      extensionConnected: false,
      socketPath: '/tmp/test.sock',
    },
    error: null,
    meta: { protocol_version: '1.0' },
  });
  assert.match(disconnected.summary, /Extension: disconnected/);
});

/** Ensure page state responses include title and origin. */
test('summarizeBridgeResponse formats page state correctly', () => {
  const summary = summarizeBridgeResponse({
    id: 'req_page',
    ok: true,
    result: {
      url: 'https://example.com/page',
      title: 'Example Page',
      origin: 'https://example.com',
      hints: { tailwind: true, react: false },
    },
    error: null,
    meta: { protocol_version: '1.0' },
  });
  assert.equal(summary.ok, true);
  assert.match(summary.summary, /Page: Example Page/);
  assert.match(summary.summary, /example\.com/);
  assert.match(summary.summary, /tailwind/);
});

/** Ensure page text responses show character count. */
test('summarizeBridgeResponse formats page text correctly', () => {
  const summary = summarizeBridgeResponse({
    id: 'req_text',
    ok: true,
    result: { text: 'Hello world content...', length: 22, truncated: false },
    error: null,
    meta: { protocol_version: '1.0' },
  });
  assert.equal(summary.ok, true);
  assert.match(summary.summary, /Page text: 22 chars/);
});

/** Ensure page.get_text (value field) also matches page text summarizer. */
test('summarizeBridgeResponse formats page.get_text value field', () => {
  const summary = summarizeBridgeResponse({
    id: 'req_text_val',
    ok: true,
    result: {
      value: 'Some page content...',
      length: 5000,
      truncated: true,
      omitted: 3000,
    },
    error: null,
    meta: { protocol_version: '1.0' },
  });
  assert.equal(summary.ok, true);
  assert.match(summary.summary, /Page text: 5000 chars \(truncated\)/);
});

/** Ensure log entries are not misidentified as console entries. */
test('summarizeBridgeResponse formats daemon log entries correctly', () => {
  const summary = summarizeBridgeResponse({
    id: 'req_logs',
    ok: true,
    result: {
      entries: [
        {
          at: '2026-01-01T00:00:00Z',
          method: 'dom.query',
          ok: true,
          id: 'req_1',
        },
        {
          at: '2026-01-01T00:00:01Z',
          method: 'page.evaluate',
          ok: false,
          id: 'req_2',
        },
      ],
    },
    error: null,
    meta: { protocol_version: '1.0' },
  });
  assert.equal(summary.ok, true);
  assert.match(summary.summary, /Log: 2 entries/);
  assert.ok(!summary.summary.includes('Console'));
});

/** Ensure accessibility tree is detected before generic DOM nodes. */
test('summarizeBridgeResponse formats accessibility tree correctly', () => {
  const summary = summarizeBridgeResponse({
    id: 'req_a11y',
    ok: true,
    result: {
      nodes: [
        { nodeId: 1, role: 'button', name: 'Submit', interactive: true },
        { nodeId: 2, role: 'heading', name: 'Title', interactive: false },
      ],
      total: 2,
      count: 2,
      truncated: false,
    },
    error: null,
    meta: { protocol_version: '1.0' },
  });
  assert.equal(summary.ok, true);
  assert.match(summary.summary, /Accessibility tree/);
  assert.match(summary.summary, /1 interactive/);
});

/** @param {unknown} result */
function ok(result) {
  return /** @type {import('../../protocol/src/types.js').BridgeResponse} */ ({
    id: 'req_test',
    ok: true,
    result,
    error: null,
    meta: { protocol_version: '1.0' },
  });
}

test('summarizer: clicked action', () => {
  const s = summarizeBridgeResponse(ok({ clicked: true, elementRef: 'el_abc' }));
  assert.match(s.summary, /Clicked el_abc/);
});

test('summarizer: focused action', () => {
  const s = summarizeBridgeResponse(ok({ focused: true, elementRef: 'el_def' }));
  assert.match(s.summary, /Focused el_def/);
});

test('summarizer: typed action', () => {
  const s = summarizeBridgeResponse(ok({ typed: true, elementRef: 'el_ghi' }));
  assert.match(s.summary, /Typed into el_ghi/);
});

test('summarizer: pressed key action', () => {
  const s = summarizeBridgeResponse(ok({ pressed: true, key: 'Enter' }));
  assert.match(s.summary, /Key pressed \(Enter\)/);
});

test('summarizer: navigated action', () => {
  const s = summarizeBridgeResponse(ok({ navigated: true, url: 'https://example.com' }));
  assert.match(s.summary, /Navigated to https:\/\/example\.com/);
});

test('summarizer: scrolled action', () => {
  const s = summarizeBridgeResponse(ok({ scrolled: true, x: 0, y: 500 }));
  assert.match(s.summary, /Scrolled to \(0, 500\)/);
});

test('summarizer: resized viewport', () => {
  const s = summarizeBridgeResponse(ok({ resized: true, width: 1024, height: 768 }));
  assert.match(s.summary, /Viewport resized to 1024\u00d7768/);
});

test('summarizer: tab created', () => {
  const s = summarizeBridgeResponse(ok({ tabId: 42, url: 'https://new.tab' }));
  assert.match(s.summary, /Tab 42 created/);
});

test('summarizer: navigation result does not look like tab creation', () => {
  const s = summarizeBridgeResponse(
    ok({
      method: 'navigation.navigate',
      tabId: 42,
      url: 'https://example.com',
      title: 'Example',
      status: 'complete',
    })
  );
  assert.match(s.summary, /Navigated to https:\/\/example\.com/);
});

test('summarizer: element describe', () => {
  const s = summarizeBridgeResponse(
    ok({
      tag: 'button',
      elementRef: 'el_xyz',
      id: 'submit',
      text: 'Save',
      bbox: { x: 10, y: 20, width: 80, height: 30 },
      role: 'button',
    })
  );
  assert.match(s.summary, /Element button#submit, Save, 80\u00d730/);
});

test('summarizer: element describe with object text', () => {
  const s = summarizeBridgeResponse(
    ok({
      tag: 'h1',
      elementRef: 'el_h1',
      text: { value: 'Page Title', truncated: false, omitted: 0 },
      bbox: { x: 0, y: 0, width: 400, height: 30 },
    })
  );
  assert.match(s.summary, /Element h1, Page Title, 400\u00d730/);
  assert.equal(/** @type {any} */ (s.evidence).text, 'Page Title');
});

test('summarizer: computed styles', () => {
  const s = summarizeBridgeResponse(
    ok({
      elementRef: 'el_css',
      properties: { display: 'flex', color: 'red', gap: '8px' },
    })
  );
  assert.match(s.summary, /Computed 3 style\(s\) for el_css/);
});

test('summarizer: flat computed styles via method hint', () => {
  const s = summarizeBridgeResponse(
    ok({
      color: 'rgb(0,0,0)',
      display: 'block',
      'font-size': '16px',
    }),
    'styles.get_computed'
  );
  assert.match(s.summary, /Computed 3 style\(s\)/);
  assert.deepEqual(s.evidence, {
    color: 'rgb(0,0,0)',
    display: 'block',
    'font-size': '16px',
  });
});

test('summarizer: box model', () => {
  const s = summarizeBridgeResponse(
    ok({
      content: { x: 10, y: 20, width: 200, height: 100 },
      padding: { top: 5 },
      border: { top: 1 },
      margin: { top: 0 },
    })
  );
  assert.match(s.summary, /Box model: 200\u00d7100 at \(10, 20\)/);
});

test('summarizer: flat box model', () => {
  const s = summarizeBridgeResponse(ok({ x: 104, y: 105, width: 1183, height: 30 }));
  assert.match(s.summary, /Box model: 1183\u00d730 at \(104, 105\)/);
});

test('summarizer: patch list', () => {
  const s = summarizeBridgeResponse(ok({ patches: [{ id: 'p1' }, { id: 'p2' }] }));
  assert.match(s.summary, /2 active patch\(es\)/);
});

test('summarizer: patch rolled back', () => {
  const s = summarizeBridgeResponse(ok({ rolled_back: true, patchId: 'p1' }));
  assert.match(s.summary, /Patch rolled back/);
});

test('summarizer: health includes access routing state', () => {
  const s = summarizeBridgeResponse(
    ok({
      daemon: 'ok',
      extensionConnected: true,
      access: {
        enabled: true,
        routeReady: true,
        routeTabId: 42,
      },
    })
  );
  assert.match(s.summary, /Access: ready on tab 42/);
});

test('summarizer: storage truncates long values', () => {
  const longValue = 'x'.repeat(200);
  const s = summarizeBridgeResponse(
    ok({
      type: 'local',
      count: 2,
      entries: { key1: 'short', key2: longValue },
    })
  );
  assert.match(s.summary, /Storage \(local\): 2 entries/);
  const evidence = /** @type {Record<string, string>} */ (s.evidence);
  assert.equal(evidence.key1, 'short');
  assert.ok(evidence.key2.length <= 80);
  assert.ok(evidence.key2.endsWith('\u2026'));
});

test('summarizer: empty network uses method hint', () => {
  const s = summarizeBridgeResponse(
    ok({
      entries: [],
      count: 0,
      total: 0,
    }),
    'page.get_network'
  );
  assert.match(s.summary, /Network: 0 requests/);
});

test('summarizer: empty console without method hint', () => {
  const s = summarizeBridgeResponse(
    ok({
      entries: [],
      count: 0,
      total: 0,
    })
  );
  assert.match(s.summary, /Console: 0 entries/);
});

test('summarizer: find by text uses specific label', () => {
  const s = summarizeBridgeResponse(
    ok({
      nodes: [
        {
          elementRef: 'el_a',
          tag: 'button',
          textExcerpt: 'Submit',
          attrs: {},
          bbox: {},
        },
      ],
    }),
    'dom.find_by_text'
  );
  assert.match(s.summary, /Found 1 element/);
});

test('summarizer: find by role uses specific label', () => {
  const s = summarizeBridgeResponse(
    ok({
      nodes: [],
      count: 0,
    }),
    'dom.find_by_role'
  );
  assert.match(s.summary, /Found 0 element/);
});

test('summarizer: DOM query evidence includes textExcerpt and attrs', () => {
  const s = summarizeBridgeResponse(
    ok({
      nodes: [
        {
          elementRef: 'el_1',
          tag: 'div',
          textExcerpt: 'Hello',
          attrs: { id: 'main', class: 'container wide' },
          bbox: {},
        },
      ],
    })
  );
  const evidence = /** @type {Array<Record<string, unknown>>} */ (s.evidence);
  assert.equal(evidence[0].ref, 'el_1');
  assert.equal(evidence[0].text, 'Hello');
  assert.equal(evidence[0].id, 'main');
  assert.equal(evidence[0].cls, 'container wide');
});

test('summarizer: eval undefined shows clean summary', () => {
  const s = summarizeBridgeResponse(ok({ value: null, type: 'undefined' }));
  assert.equal(s.summary, 'Evaluated to undefined.');
  assert.ok(!s.summary.includes('null'));
});

test('summarizer: eval null shows null not object', () => {
  const s = summarizeBridgeResponse(ok({ value: null, type: 'object' }));
  assert.match(s.summary, /Evaluated to null/);
  assert.ok(!s.summary.includes('object'));
});

test('summarizer: eval empty object hints non-serializable', () => {
  const s = summarizeBridgeResponse(ok({ value: {}, type: 'object' }));
  assert.match(s.summary, /non-serializable/);
});

test('summarizer: wait timeout returns ok false', () => {
  const s = summarizeBridgeResponse(ok({ found: false, elementRef: null, duration: 5000 }));
  assert.equal(s.ok, false);
  assert.match(s.summary, /not found/);
});

test('summarizer: wait success returns ok true', () => {
  const s = summarizeBridgeResponse(ok({ found: true, elementRef: 'el_abc', duration: 200 }));
  assert.equal(s.ok, true);
  assert.match(s.summary, /Element found/);
});

test('summarizer: network URLs are truncated', () => {
  const longUrl = 'https://example.com/api/v2/endpoint?' + 'param=value&'.repeat(20);
  const s = summarizeBridgeResponse(
    ok({
      entries: [
        {
          type: 'fetch',
          method: 'GET',
          url: longUrl,
          status: 200,
          duration: 50,
        },
      ],
      count: 1,
      total: 1,
    })
  );
  const evidence = /** @type {Array<Record<string, unknown>>} */ (s.evidence);
  assert.ok(/** @type {string} */ (evidence[0].url).length <= 130);
});

test('summarizer: a11y tree shows non-interactive nodes when no interactive found', () => {
  const s = summarizeBridgeResponse(
    ok({
      nodes: [
        { nodeId: '1', role: 'heading', name: 'Title', interactive: false },
        { nodeId: '2', role: 'generic', name: '', interactive: false },
      ],
      total: 2,
      count: 2,
      truncated: false,
    })
  );
  const evidence = /** @type {Array<Record<string, unknown>>} */ (s.evidence);
  assert.ok(evidence.length > 0, 'should show non-interactive nodes');
  assert.equal(evidence[0].role, 'heading');
});

test('summarizer: dom.get_text uses Element text label', () => {
  const s = summarizeBridgeResponse(
    ok({
      text: 'Hello world',
      truncated: false,
      length: 11,
    }),
    'dom.get_text'
  );
  assert.match(s.summary, /Element text/);
});

test('summarizer: page.get_text still uses Page text label', () => {
  const s = summarizeBridgeResponse(
    ok({
      text: 'Hello world',
      truncated: false,
      length: 11,
    }),
    'page.get_text'
  );
  assert.match(s.summary, /Page text/);
});

test('summarizer: DOM query evidence includes role and label', () => {
  const s = summarizeBridgeResponse(
    ok({
      nodes: [
        {
          elementRef: 'el_1',
          tag: 'button',
          role: 'button',
          name: 'Submit',
          attrs: { role: 'button', 'aria-label': 'Submit form' },
          bbox: {},
        },
      ],
    })
  );
  const evidence = /** @type {Array<Record<string, unknown>>} */ (s.evidence);
  assert.equal(evidence[0].role, 'button');
  assert.equal(evidence[0].label, 'Submit form');
});

test('parseInstallAgentArgs defaults to all supported targets', () => {
  const options = parseInstallAgentArgs([], '/tmp/example');
  assert.deepEqual(options.targets, [
    'codex',
    'claude',
    'cursor',
    'copilot',
    'opencode',
    'antigravity',
    'windsurf',
    'agents',
  ]);
  assert.equal(options.projectPath, '/tmp/example');
});

test('parseInstallAgentArgs supports explicit selection and project path', () => {
  const options = parseInstallAgentArgs(['copilot,codex', '--project', './demo'], '/tmp/example');
  assert.deepEqual(options.targets, ['copilot', 'codex']);
  assert.equal(options.projectPath, path.resolve('/tmp/example', './demo'));
});

test('parseInstallAgentArgs accepts openai as a codex alias', () => {
  const options = parseInstallAgentArgs(['openai'], '/tmp/example');
  assert.deepEqual(options.targets, ['codex']);
});

test('parseInstallAgentArgs accepts google as an antigravity alias', () => {
  const options = parseInstallAgentArgs(['google'], '/tmp/example');
  assert.deepEqual(options.targets, ['antigravity']);
});

test('interactiveConfirm returns null without a TTY', async () => {
  const originalIn = process.stdin.isTTY;
  const originalOut = process.stdout.isTTY;

  Object.defineProperty(process.stdin, 'isTTY', {
    value: false,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: false,
    configurable: true,
  });

  try {
    const result = await interactiveConfirm('Remove skills?');
    assert.equal(result, null);
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIn,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalOut,
      configurable: true,
    });
  }
});

test('interactiveCheckbox toggles selections and returns checked values', async () => {
  const originalIn = process.stdin.isTTY;
  const originalOut = process.stdout.isTTY;
  const originalSetRawMode = /** @type {any} */ (process.stdin).setRawMode;
  const originalResume = process.stdin.resume.bind(process.stdin);
  const originalPause = process.stdin.pause.bind(process.stdin);
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalEmitKeypressEvents = readline.emitKeypressEvents;
  /** @type {string[]} */
  const output = [];
  /** @type {boolean[]} */
  const rawModeCalls = [];
  let resumed = false;
  let paused = false;

  Object.defineProperty(process.stdin, 'isTTY', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: true,
    configurable: true,
  });
  /** @type {any} */ (process.stdin).setRawMode = (/** @type {boolean} */ value) => {
    rawModeCalls.push(Boolean(value));
  };
  process.stdin.resume = () => {
    resumed = true;
    return process.stdin;
  };
  process.stdin.pause = () => {
    paused = true;
    return process.stdin;
  };
  process.stdout.write = /** @type {typeof process.stdout.write} */ (
    (chunk) => {
      output.push(String(chunk));
      return true;
    }
  );
  readline.emitKeypressEvents = () => {};

  try {
    const resultPromise = interactiveCheckbox('Select targets', [
      { value: 'codex', label: 'Codex' },
      { value: 'claude', label: 'Claude', hint: 'installed' },
    ]);

    process.stdin.emit('keypress', '', { name: 'space' });
    process.stdin.emit('keypress', '', { name: 'down' });
    process.stdin.emit('keypress', '', { name: 'a' });
    process.stdin.emit('keypress', '', { name: 'return' });

    const result = await resultPromise;
    assert.deepEqual(result?.sort(), ['claude', 'codex']);
    assert.equal(resumed, true);
    assert.equal(paused, true);
    assert.deepEqual(rawModeCalls, [true, false]);
    assert.ok(output.some((chunk) => chunk.includes('Select targets')));
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIn,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalOut,
      configurable: true,
    });
    /** @type {any} */ (process.stdin).setRawMode = originalSetRawMode;
    process.stdin.resume = originalResume;
    process.stdin.pause = originalPause;
    process.stdout.write = originalWrite;
    readline.emitKeypressEvents = originalEmitKeypressEvents;
  }
});

test('interactiveConfirm honors defaults and closes the readline interface', async () => {
  const originalIn = process.stdin.isTTY;
  const originalOut = process.stdout.isTTY;
  const originalCreateInterface = readline.createInterface;
  /** @type {string[]} */
  const prompts = [];
  let closeCount = 0;

  Object.defineProperty(process.stdin, 'isTTY', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: true,
    configurable: true,
  });
  readline.createInterface = /** @type {typeof readline.createInterface} */ (
    /** @type {unknown} */ (
      () => ({
        question(/** @type {string} */ prompt, /** @type {unknown} */ callback) {
          prompts.push(prompt);
          /** @type {(answer: string) => void} */ (callback)('');
        },
        close() {
          closeCount += 1;
        },
      })
    )
  );

  try {
    const result = await interactiveConfirm('Remove skills?', {
      defaultValue: true,
    });
    assert.equal(result, true);
    assert.equal(closeCount, 1);
    assert.deepEqual(prompts, ['Remove skills? [Y/n] ']);
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIn,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalOut,
      configurable: true,
    });
    readline.createInterface = originalCreateInterface;
  }
});

test('parseIntArg returns numbers and rejects invalid input', () => {
  assert.equal(parseIntArg('42', 'limit'), 42);
  assert.throws(() => parseIntArg(undefined, 'limit'), /limit must be a number/);
  assert.throws(() => parseIntArg('abc', 'limit'), /limit must be a number/);
});

test('installAgentFiles writes managed files for supported runtimes', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bb-install-agent-'));
  await installMcpConfig('copilot', {
    global: false,
    cwd: tempDir,
    stdout: {
      write() {
        return true;
      },
    },
  });
  await installMcpConfig('cursor', {
    global: false,
    cwd: tempDir,
    stdout: {
      write() {
        return true;
      },
    },
  });
  await installMcpConfig('codex', {
    global: false,
    cwd: tempDir,
    stdout: {
      write() {
        return true;
      },
    },
  });
  const installed = await installAgentFiles({
    targets: [
      'codex',
      'claude',
      'cursor',
      'copilot',
      'opencode',
      'antigravity',
      'windsurf',
      'agents',
    ],
    projectPath: tempDir,
    global: false,
  });

  assert.ok(
    installed.some((entry) => entry.endsWith(path.join('.github', 'skills', 'browser-bridge')))
  );
  assert.ok(
    installed.some((entry) => entry.endsWith(path.join('.claude', 'skills', 'browser-bridge')))
  );
  assert.ok(
    installed.some((entry) => entry.endsWith(path.join('.cursor', 'skills', 'browser-bridge')))
  );
  assert.ok(
    installed.some((entry) => entry.endsWith(path.join('.windsurf', 'skills', 'browser-bridge')))
  );
  assert.ok(
    installed.some((entry) => entry.endsWith(path.join('.opencode', 'skills', 'browser-bridge')))
  );
  assert.ok(
    installed.some((entry) => entry.endsWith(path.join('.agents', 'skills', 'browser-bridge')))
  );
  assert.ok(
    installed.some((entry) => entry.endsWith(path.join('.codex', 'skills', 'browser-bridge')))
  );

  await assert.doesNotReject(
    fs.promises.access(path.join(tempDir, '.github', 'skills', 'browser-bridge', 'SKILL.md'))
  );
  await assert.doesNotReject(
    fs.promises.access(path.join(tempDir, '.claude', 'skills', 'browser-bridge', 'SKILL.md'))
  );
  await assert.doesNotReject(
    fs.promises.access(path.join(tempDir, '.cursor', 'skills', 'browser-bridge', 'SKILL.md'))
  );
  await assert.doesNotReject(
    fs.promises.access(path.join(tempDir, '.windsurf', 'skills', 'browser-bridge', 'SKILL.md'))
  );
  await assert.doesNotReject(
    fs.promises.access(path.join(tempDir, '.opencode', 'skills', 'browser-bridge', 'SKILL.md'))
  );
  await assert.doesNotReject(
    fs.promises.access(path.join(tempDir, '.agents', 'skills', 'browser-bridge', 'SKILL.md'))
  );
  await assert.doesNotReject(
    fs.promises.access(path.join(tempDir, '.codex', 'skills', 'browser-bridge', 'SKILL.md'))
  );
  await assert.doesNotReject(
    fs.promises.access(
      path.join(tempDir, '.codex', 'skills', 'browser-bridge', 'agents', 'openai.yaml')
    )
  );
  await assert.doesNotReject(
    fs.promises.access(
      path.join(tempDir, '.agents', 'skills', 'browser-bridge', 'references', 'protocol.md')
    )
  );
});

test('installAgentFiles writes GitHub Copilot global skills to ~/.copilot/skills', async () => {
  const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bb-install-agent-home-'));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  try {
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const installed = await installAgentFiles({
      targets: ['copilot'],
      projectPath: '/tmp/unused',
      global: true,
    });

    assert.ok(
      installed.some((entry) => entry.endsWith(path.join('.copilot', 'skills', 'browser-bridge')))
    );
    await assert.doesNotReject(
      fs.promises.access(path.join(tempHome, '.copilot', 'skills', 'browser-bridge', 'SKILL.md'))
    );
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  }
});

test('installAgentFiles applies the GitHub Copilot-specific CLI skill note', async () => {
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'bb-install-agent-copilot-note-')
  );

  try {
    await installAgentFiles({
      targets: ['copilot', 'cursor'],
      projectPath: tempDir,
      global: false,
    });

    const copilotSkill = await fs.promises.readFile(
      path.join(tempDir, '.github', 'skills', 'browser-bridge', 'SKILL.md'),
      'utf8'
    );
    const cursorSkill = await fs.promises.readFile(
      path.join(tempDir, '.cursor', 'skills', 'browser-bridge', 'SKILL.md'),
      'utf8'
    );

    assert.match(copilotSkill, /## GitHub Copilot Note/);
    assert.match(copilotSkill, /use the MCP tools directly instead of shelling out to `bbx`/);
    assert.doesNotMatch(cursorSkill, /## GitHub Copilot Note/);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('installAgentFiles rolls back new skill directories when a later write fails', async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bb-install-agent-rollback-'));
  const originalWriteFile = fs.promises.writeFile;

  t.mock.method(
    fs.promises,
    'writeFile',
    /** @type {typeof fs.promises.writeFile} */ (
      async (filePath, data, options) => {
        const targetPath = String(filePath);
        if (
          targetPath.endsWith(
            path.join('.cursor', 'skills', 'browser-bridge', getManagedSkillSentinelFilename())
          )
        ) {
          throw new Error('simulated sentinel write failure');
        }
        return originalWriteFile.call(fs.promises, filePath, data, options);
      }
    )
  );

  try {
    await assert.rejects(
      installAgentFiles({
        targets: ['copilot', 'cursor'],
        projectPath: tempDir,
        global: false,
      }),
      /simulated sentinel write failure/
    );

    await assert.rejects(
      fs.promises.access(path.join(tempDir, '.github', 'skills', 'browser-bridge'))
    );
    await assert.rejects(
      fs.promises.access(path.join(tempDir, '.cursor', 'skills', 'browser-bridge'))
    );
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('installAgentFiles still installs only the CLI skill when global MCP is configured', async () => {
  const tempHome = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'bb-install-agent-copilot-mcp-home-')
  );
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalAppData = process.env.APPDATA;

  try {
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    if (process.platform === 'win32') {
      process.env.APPDATA = path.join(tempHome, 'AppData', 'Roaming');
    }
    await installMcpConfig('copilot', {
      global: true,
      stdout: {
        write() {
          return true;
        },
      },
    });

    const installed = await installAgentFiles({
      targets: ['copilot'],
      projectPath: '/tmp/unused',
      global: true,
    });

    assert.ok(
      installed.some((entry) => entry.endsWith(path.join('.copilot', 'skills', 'browser-bridge')))
    );
    await assert.doesNotReject(
      fs.promises.access(path.join(tempHome, '.copilot', 'skills', 'browser-bridge', 'SKILL.md'))
    );
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  }
});

test('installMcpClientSetup writes GitHub Copilot MCP config without installing the CLI skill', async () => {
  const tempHome = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'bb-install-copilot-setup-home-')
  );
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalAppData = process.env.APPDATA;

  try {
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    if (process.platform === 'win32') {
      process.env.APPDATA = path.join(tempHome, 'AppData', 'Roaming');
    }

    const result = await installMcpClientSetup(['copilot'], {
      global: true,
      projectPath: '/tmp/unused',
      stdout: {
        write() {
          return true;
        },
      },
    });

    assert.ok(
      result.configPaths.some((entry) => entry.endsWith(path.join('.copilot', 'mcp-config.json')))
    );
    await assert.doesNotReject(
      fs.promises.access(path.join(tempHome, '.copilot', 'mcp-config.json'))
    );
    await assert.rejects(
      fs.promises.access(path.join(tempHome, '.copilot', 'skills', 'browser-bridge', 'SKILL.md'))
    );
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  }
});

test('installMcpClientSetup keeps Codex MCP setup separate from CLI skill install', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bb-install-codex-mcp-'));

  try {
    const result = await installMcpClientSetup(['codex'], {
      global: false,
      projectPath: tempDir,
      stdout: {
        write() {
          return true;
        },
      },
    });

    assert.ok(
      result.configPaths.some((entry) => entry.endsWith(path.join('.codex', 'config.toml')))
    );
    await assert.rejects(
      fs.promises.access(path.join(tempDir, '.codex', 'skills', 'browser-bridge', 'SKILL.md'))
    );
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('installMcpClientSetup writes generic agents MCP config without installing the CLI skill', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bb-install-agents-mcp-'));

  try {
    const result = await installMcpClientSetup(['agents'], {
      global: false,
      projectPath: tempDir,
      stdout: {
        write() {
          return true;
        },
      },
    });

    assert.deepEqual(result.configPaths, [path.join(tempDir, '.agents', 'mcp.json')]);
    await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.agents', 'mcp.json')));
    await assert.rejects(
      fs.promises.access(path.join(tempDir, '.agents', 'skills', 'browser-bridge', 'SKILL.md'))
    );
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('installMcpClientSetup is idempotent for repeated client installs', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bb-install-idempotent-mcp-'));

  try {
    const stdout = {
      write() {
        return true;
      },
    };

    const first = await installMcpClientSetup(['cursor', 'cursor'], {
      global: false,
      projectPath: tempDir,
      stdout,
    });
    const configPath = path.join(tempDir, '.cursor', 'mcp.json');
    const firstContents = await fs.promises.readFile(configPath, 'utf8');

    const second = await installMcpClientSetup(['cursor'], {
      global: false,
      projectPath: tempDir,
      stdout,
    });
    const secondContents = await fs.promises.readFile(configPath, 'utf8');

    assert.deepEqual(first.configPaths, [configPath]);
    assert.deepEqual(second.configPaths, [configPath]);
    assert.equal(secondContents, firstContents);
    assert.deepEqual(JSON.parse(secondContents), buildMcpConfig('cursor'));
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('findInstalledManagedTargets reports targets with managed skill installs', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bb-find-managed-targets-'));

  try {
    await installMcpConfig('cursor', {
      global: false,
      cwd: tempDir,
      stdout: {
        write() {
          return true;
        },
      },
    });
    await installAgentFiles({
      targets: ['cursor'],
      projectPath: tempDir,
      global: false,
    });

    const installed = await findInstalledManagedTargets({
      targets: ['cursor', 'copilot'],
      projectPath: tempDir,
      global: false,
    });

    assert.deepEqual(installed, ['cursor']);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('removeAgentFiles removes only managed Browser Bridge skill directories', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bb-remove-agent-files-'));

  try {
    await installMcpConfig('cursor', {
      global: false,
      cwd: tempDir,
      stdout: {
        write() {
          return true;
        },
      },
    });
    await installAgentFiles({
      targets: ['cursor'],
      projectPath: tempDir,
      global: false,
    });

    const skillBasePath = getSkillBasePath('cursor', {
      projectPath: tempDir,
      global: false,
    });
    const unmanagedSkillPath = path.join(skillBasePath, 'custom-skill');
    const managedSentinel = getManagedSkillSentinelFilename();
    await fs.promises.mkdir(unmanagedSkillPath, { recursive: true });
    await fs.promises.writeFile(path.join(unmanagedSkillPath, 'SKILL.md'), '# Custom\n', 'utf8');
    await fs.promises.mkdir(path.join(skillBasePath, 'browser-bridge-extra'), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(skillBasePath, 'browser-bridge-extra', 'SKILL.md'),
      '# Extra\n',
      'utf8'
    );
    await fs.promises.writeFile(
      path.join(skillBasePath, 'browser-bridge-extra', managedSentinel),
      'managed\n',
      'utf8'
    );

    const removed = await removeAgentFiles({
      targets: ['cursor'],
      projectPath: tempDir,
      global: false,
    });

    assert.ok(
      removed.some((entry) => entry.endsWith(path.join('.cursor', 'skills', 'browser-bridge')))
    );
    assert.equal(
      await fs.promises.access(unmanagedSkillPath).then(
        () => true,
        () => false
      ),
      true
    );
    assert.equal(
      await fs.promises.access(path.join(skillBasePath, 'browser-bridge-extra')).then(
        () => true,
        () => false
      ),
      true
    );
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('installAgentFiles writes Windsurf and Antigravity global skills to their documented locations', async () => {
  const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bb-install-agent-home-'));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  try {
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    await installMcpConfig('windsurf', {
      global: true,
      stdout: {
        write() {
          return true;
        },
      },
    });
    const installed = await installAgentFiles({
      targets: ['windsurf', 'antigravity'],
      projectPath: '/tmp/unused',
      global: true,
    });

    assert.ok(
      installed.some((entry) =>
        entry.endsWith(path.join('.codeium', 'windsurf', 'skills', 'browser-bridge'))
      )
    );
    assert.ok(
      installed.some((entry) =>
        entry.endsWith(path.join('.gemini', 'antigravity', 'skills', 'browser-bridge'))
      )
    );
    await assert.doesNotReject(
      fs.promises.access(
        path.join(tempHome, '.codeium', 'windsurf', 'skills', 'browser-bridge', 'SKILL.md')
      )
    );
    await assert.doesNotReject(
      fs.promises.access(
        path.join(tempHome, '.gemini', 'antigravity', 'skills', 'browser-bridge', 'SKILL.md')
      )
    );
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  }
});

test('isMcpClientName recognizes supported clients', () => {
  assert.equal(isMcpClientName('claude'), true);
  assert.equal(isMcpClientName('cursor'), true);
  assert.equal(isMcpClientName('windsurf'), true);
  assert.equal(isMcpClientName('copilot'), true);
  assert.equal(isMcpClientName('codex'), true);
  assert.equal(isMcpClientName('opencode'), true);
  assert.equal(isMcpClientName('vscode'), false);
  assert.equal(isMcpClientName('other'), false);
});

test('buildMcpConfig produces client-specific config shapes', () => {
  assert.deepEqual(buildMcpConfig('cursor'), {
    mcpServers: {
      'browser-bridge': {
        command: expectedMcpCommand,
        args: expectedMcpArgs,
        env: {},
      },
    },
  });

  assert.deepEqual(buildMcpConfig('windsurf'), {
    mcpServers: {
      'browser-bridge': {
        command: expectedMcpCommand,
        args: expectedMcpArgs,
        env: {},
      },
    },
  });

  assert.deepEqual(buildMcpConfig('antigravity'), {
    mcpServers: {
      'browser-bridge': {
        command: expectedMcpCommand,
        args: expectedMcpArgs,
        env: {},
      },
    },
  });

  assert.deepEqual(buildMcpConfig('claude'), {
    mcpServers: {
      'browser-bridge': {
        type: 'stdio',
        command: expectedMcpCommand,
        args: expectedMcpArgs,
        env: {},
      },
    },
  });

  assert.deepEqual(buildMcpConfig('copilot'), {
    mcpServers: {
      'browser-bridge': {
        type: 'stdio',
        command: expectedMcpCommand,
        args: expectedMcpArgs,
        env: {},
      },
    },
  });

  assert.deepEqual(buildMcpConfig('opencode'), {
    mcp: {
      'browser-bridge': {
        type: 'local',
        command: expectedOpencodeCommand,
      },
    },
  });

  assert.deepEqual(buildMcpConfig('codex'), {
    mcp_servers: {
      'browser-bridge': {
        command: expectedMcpCommand,
        args: expectedMcpArgs,
      },
    },
  });
});

test('formatMcpConfig returns pretty JSON with newline', () => {
  const formatted = formatMcpConfig('cursor');
  assert.match(formatted, /"browser-bridge"/);
  assert.ok(formatted.endsWith('\n'));
});

test('formatMcpConfig returns Codex TOML with newline', () => {
  const formatted = formatMcpConfig('codex');
  assert.match(formatted, /\[mcp_servers\."browser-bridge"\]/);
  assert.match(formatted, new RegExp(`command = ${escapeRegExp(JSON.stringify(expectedMcpCommand))}`));
  assert.ok(formatted.endsWith('\n'));
});

test('getMcpConfigPath supports Copilot global and local locations', () => {
  const home = os.homedir();
  const expectedGlobal = path.join(home, '.copilot', 'mcp-config.json');
  const cwd = path.join(path.sep, 'tmp', 'demo');

  assert.equal(
    getMcpConfigPath('copilot', { global: false, cwd }),
    path.join(cwd, '.vscode', 'mcp.json')
  );
  assert.equal(getMcpConfigPath('copilot', { global: true }), expectedGlobal);
});

test('getMcpConfigPath supports Claude Code global and local locations', () => {
  const home = os.homedir();
  const cwd = path.join(path.sep, 'tmp', 'demo');
  assert.equal(
    getMcpConfigPath('claude', { global: false, cwd }),
    path.join(cwd, '.mcp.json')
  );
  assert.equal(getMcpConfigPath('claude', { global: true }), path.join(home, '.claude.json'));
});

test('getMcpConfigPath supports Codex global and local locations', () => {
  const home = os.homedir();
  const cwd = path.join(path.sep, 'tmp', 'demo');
  assert.equal(
    getMcpConfigPath('codex', { global: false, cwd }),
    path.join(cwd, '.codex', 'config.toml')
  );
  assert.equal(
    getMcpConfigPath('codex', { global: true }),
    path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml')
  );
});

test('getMcpConfigPath supports OpenCode global and local locations', () => {
  const home = os.homedir();
  const cwd = path.join(path.sep, 'tmp', 'demo');
  assert.equal(
    getMcpConfigPath('opencode', { global: false, cwd }),
    path.join(cwd, 'opencode.json')
  );
  assert.equal(
    getMcpConfigPath('opencode', { global: true }),
    path.join(home, '.config', 'opencode', 'opencode.json')
  );
});

test('getMcpConfigPath supports Windsurf global and local locations', () => {
  const home = os.homedir();
  const cwd = path.join(path.sep, 'tmp', 'demo');
  assert.equal(
    getMcpConfigPath('windsurf', { global: false, cwd }),
    path.join(cwd, '.windsurf', 'mcp_config.json')
  );
  assert.equal(
    getMcpConfigPath('windsurf', { global: true }),
    path.join(home, '.codeium', 'windsurf', 'mcp_config.json')
  );
});

test('getMcpConfigPath supports Antigravity global and local locations', () => {
  const home = os.homedir();
  const cwd = path.join(path.sep, 'tmp', 'demo');
  assert.equal(
    getMcpConfigPath('antigravity', { global: false, cwd }),
    path.join(cwd, '.agents', 'mcp_config.json')
  );
  assert.equal(
    getMcpConfigPath('antigravity', { global: true }),
    path.join(home, '.gemini', 'antigravity', 'mcp_config.json')
  );
});

test('getMcpConfigPath supports generic agents global and local locations', () => {
  const home = os.homedir();
  const cwd = path.join(path.sep, 'tmp', 'demo');
  assert.equal(
    getMcpConfigPath('agents', { global: false, cwd }),
    path.join(cwd, '.agents', 'mcp.json')
  );
  assert.equal(
    getMcpConfigPath('agents', { global: true }),
    path.join(home, '.agents', 'mcp.json')
  );
});

test('getMcpConfigPaths includes existing Copilot profile configs for global installs', async () => {
  const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-copilot-mcp-paths-'));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalAppData = process.env.APPDATA;

  try {
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    if (process.platform === 'win32') {
      process.env.APPDATA = path.join(tempHome, 'AppData', 'Roaming');
    }
    const profileDir =
      process.platform === 'win32'
        ? path.join(
            process.env.APPDATA || path.join(tempHome, 'AppData', 'Roaming'),
            'Code',
            'User',
            'profiles',
            'profile-a'
          )
        : process.platform === 'linux'
          ? path.join(tempHome, '.config', 'Code', 'User', 'profiles', 'profile-a')
          : path.join(
              tempHome,
              'Library',
              'Application Support',
              'Code',
              'User',
              'profiles',
              'profile-a'
            );
    await fs.promises.mkdir(profileDir, { recursive: true });

    const paths = await getMcpConfigPaths('copilot', { global: true });
    assert.equal(paths.length, 3);
    assert.equal(paths[0], path.join(tempHome, '.copilot', 'mcp-config.json'));
    assert.ok(paths[1]?.endsWith(path.join('Code', 'User', 'mcp.json')));
    assert.equal(paths[2], path.join(profileDir, 'mcp.json'));
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  }
});

test('installMcpConfig migrates Copilot legacy servers config to mcpServers', async () => {
  const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-copilot-mcp-migrate-'));
  const originalHome = process.env.HOME;

  try {
    process.env.HOME = tempHome;
    const configPath = getMcpConfigPath('copilot', { global: true });
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(
      configPath,
      `${JSON.stringify(
        {
          servers: {
            existing: {
              type: 'stdio',
              command: 'node',
              args: ['existing.js'],
              env: {},
            },
          },
          unrelated: true,
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    await installMcpConfig('copilot', {
      global: true,
      stdout: {
        write() {
          return true;
        },
      },
    });

    const updated = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
    assert.equal(typeof updated.mcpServers, 'object');
    assert.equal(updated.servers, undefined);
    assert.deepEqual(updated.mcpServers.existing, {
      type: 'stdio',
      command: 'node',
      args: ['existing.js'],
      env: {},
    });
    assert.equal(updated.unrelated, true);
    assert.deepEqual(updated.mcpServers['browser-bridge'], {
      type: 'stdio',
      command: expectedMcpCommand,
      args: expectedMcpArgs,
      env: {},
    });
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  }
});

// --- BridgeClient socket error/disconnect scenarios (5.2) ---

import net from 'node:net';

/**
 * Create a minimal mock TCP "daemon" that:
 * 1. Accepts one connection
 * 2. Sends a `registered` message immediately
 * 3. Invokes `onRequest(socket, message)` for each `agent.request` line received
 *
 * Returns the server and the port it's listening on.
 *
 * @param {(socket: net.Socket, msg: unknown) => void} [onRequest]
 * @returns {Promise<{ server: net.Server, port: number }>}
 */
async function startMockDaemon(onRequest) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.write(
        `${JSON.stringify({ type: 'registered', role: 'agent', clientId: 'mock_client' })}\n`
      );
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk;
        while (buf.includes('\n')) {
          const idx = buf.indexOf('\n');
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'agent.request') {
              onRequest?.(socket, msg);
            }
          } catch {
            /* ignore */
          }
        }
      });
    });
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ server, port: address.port });
    });
  });
}

/**
 * Connect a BridgeClient to a TCP mock daemon at the given port.
 * BridgeClient natively uses Unix sockets; this patches connect() to use TCP.
 *
 * @param {number} port
 * @returns {import('../src/client.js').BridgeClient}
 */
function makeTcpClient(port) {
  const client = new BridgeClient({ defaultTimeoutMs: 5_000 });
  /**
   * @this {BridgeClient}
   * @returns {Promise<void>}
   */
  async function connectOverTcp() {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    await new Promise((res, rej) => {
      socket.once('connect', res);
      socket.once('error', rej);
    });
    this.socket = socket;
    const { parseJsonLines } = await import('../../protocol/src/index.js');
    parseJsonLines(socket, (raw) => {
      const msg = /** @type {any} */ (raw);
      if (msg.type === 'registered') {
        const p = this.waiting.get('registered');
        if (p) {
          this.waiting.delete('registered');
          this.connected = true;
          clearTimeout(p.timeoutId);
          p.resolve(msg);
        }
        return;
      }
      if (msg.type === 'agent.response') {
        const p = this.waiting.get(msg.response.id);
        if (p) {
          this.waiting.delete(msg.response.id);
          clearTimeout(p.timeoutId);
          p.resolve(msg.response);
        }
      }
    });
    socket.on('close', () => this.rejectAllPending(new Error('Bridge socket closed.')));
    socket.on('error', (err) => this.rejectAllPending(err));
    socket.write(
      `${JSON.stringify({ type: 'register', role: 'agent', clientId: this.clientId })}\n`
    );
    await new Promise((res, rej) => {
      const tid = setTimeout(() => {
        this.waiting.delete('registered');
        rej(new Error('register timeout'));
      }, this.defaultTimeoutMs);
      this.waiting.set('registered', {
        resolve: res,
        reject: rej,
        timeoutId: tid,
      });
    });
  }
  client.connect =
    /** @type {typeof client.connect} */ (/** @type {unknown} */ (connectOverTcp.bind(client)));
  return client;
}

test('BridgeClient pending request rejects when server destroys connection mid-request', async () => {
  // Mock daemon that immediately closes the connection when it receives any request.
  const { server, port } = await startMockDaemon((socket) => {
    socket.destroy();
  });
  const client = makeTcpClient(port);
  try {
    await client.connect();
    await assert.rejects(client.request({ method: 'health.ping', timeoutMs: 5_000 }), (err) => {
      assert.ok(err instanceof Error);
      return true;
    });
  } finally {
    await client.close().catch(() => {});
    server.close();
  }
});

test('BridgeClient.request rejects immediately when socket is disconnected', async () => {
  // Mock daemon that never responds to requests (hangs).
  const { server, port } = await startMockDaemon(() => {});
  const client = makeTcpClient(port);
  try {
    await client.connect();

    // Destroy the underlying socket (simulates daemon crash / explicit close).
    client.socket?.destroy();

    // BridgeClient.request() checks socket state eagerly and should throw
    // ENOTCONN without hanging.
    await assert.rejects(client.request({ method: 'health.ping', timeoutMs: 2_000 }), (err) => {
      assert.ok(err instanceof Error);
      return true;
    });
  } finally {
    server.close();
  }
});

test('BridgeClient cleans up all pending requests on socket error event', async () => {
  // Mock daemon that hangs on all requests.
  const { server, port } = await startMockDaemon(() => {});
  const client = makeTcpClient(port);
  try {
    await client.connect();

    const p1 = client.request({ method: 'health.ping', timeoutMs: 5_000 });
    const p2 = client.request({ method: 'health.ping', timeoutMs: 5_000 });
    // Let the writes complete before destroying the socket.
    await new Promise((r) => setTimeout(r, 10));

    client.socket?.destroy(new Error('simulated network error'));

    const [r1, r2] = await Promise.allSettled([p1, p2]);
    assert.equal(r1.status, 'rejected', 'p1 should reject');
    assert.equal(r2.status, 'rejected', 'p2 should reject');
    assert.equal(client.waiting.size, 0, 'waiting map should be empty after error');
  } finally {
    await client.close().catch(() => {});
    server.close();
  }
});

test('BridgeClient.batch sends requests concurrently and preserves response order', async () => {
  let requestCount = 0;
  const { server, port } = await startMockDaemon((socket, message) => {
    const typedMessage = /** @type {{ request?: { id: string, method: string } }} */ (message);
    const request = typedMessage.request;
    if (!request) {
      return;
    }

    requestCount += 1;
    const response = {
      type: 'agent.response',
      response: {
        id: request.id,
        ok: true,
        result: { method: request.method, ordinal: requestCount },
        error: null,
        meta: { protocol_version: '1.0' },
      },
    };
    const delay = request.method === 'tabs.list' ? 20 : 5;
    setTimeout(() => {
      if (!socket.destroyed) {
        socket.write(`${JSON.stringify(response)}\n`);
      }
    }, delay);
  });
  const client = makeTcpClient(port);

  try {
    await client.connect();
    const responses = await client.batch([{ method: 'tabs.list' }, { method: 'health.ping' }]);

    assert.equal(requestCount, 2);
    assert.equal(responses.length, 2);
    assert.deepEqual(
      responses.map((response) => response.result),
      [
        { method: 'tabs.list', ordinal: 1 },
        { method: 'health.ping', ordinal: 2 },
      ]
    );
  } finally {
    await client.close().catch(() => {});
    server.close();
  }
});

// --- autoReconnect (3.1) ---

test('BridgeClient reconnects and emits reconnected event after server drops connection', async () => {
  // Server that accepts connections, sends registered, then destroys them after 50ms.
  let acceptCount = 0;
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    acceptCount += 1;
    socket.setEncoding('utf8');
    socket.write(
      `${JSON.stringify({ type: 'registered', role: 'agent', clientId: 'mock_client' })}\n`
    );
    if (acceptCount === 1) {
      // First connection: destroy after a short delay to trigger reconnect.
      setTimeout(() => socket.destroy(), 50);
    }
    // Second+ connections: stay open so the client reconnects successfully.
  });
  await new Promise((resolve) =>
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve(undefined))
  );
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

  const client = new BridgeClient({
    defaultTimeoutMs: 3_000,
    autoReconnect: true,
  });
  /**
   * @this {BridgeClient}
   * @returns {Promise<void>}
   */
  async function reconnectingTcpConnect() {
    if (this.socket) throw new Error('BridgeClient is already connected.');
    const socket = net.createConnection({ host: '127.0.0.1', port });
    this.socket = socket;
    try {
      await new Promise((res, rej) => {
        socket.once('connect', res);
        socket.once('error', rej);
      });
    } catch (error) {
      socket.destroy();
      this.socket = null;
      throw error;
    }
    const { parseJsonLines } = await import('../../protocol/src/index.js');
    parseJsonLines(socket, (raw) => {
      const msg = /** @type {any} */ (raw);
      if (msg.type === 'registered') {
        const p = this.waiting.get('registered');
        if (p) {
          this.waiting.delete('registered');
          this.connected = true;
          clearTimeout(p.timeoutId);
          p.resolve(msg);
        }
        return;
      }
      if (msg.type === 'agent.response') {
        const p = this.waiting.get(msg.response.id);
        if (p) {
          this.waiting.delete(msg.response.id);
          clearTimeout(p.timeoutId);
          p.resolve(msg.response);
        }
      }
    });
    socket.on('close', () => {
      this.connected = false;
      this.socket = null;
      this.rejectAllPending(new Error('Bridge socket closed.'));
      if (this.autoReconnect && !this._reconnecting) {
        void this._scheduleReconnect();
      }
    });
    socket.on('error', (error) => {
      this.rejectAllPending(error);
    });
    socket.write(
      `${JSON.stringify({ type: 'register', role: 'agent', clientId: this.clientId })}\n`
    );
    await new Promise((res, rej) => {
      const tid = setTimeout(() => {
        this.waiting.delete('registered');
        rej(new Error('register timeout'));
      }, this.defaultTimeoutMs);
      this.waiting.set('registered', {
        resolve: res,
        reject: rej,
        timeoutId: tid,
      });
    });
  }
  client.connect =
    /** @type {typeof client.connect} */ (
      /** @type {unknown} */ (reconnectingTcpConnect.bind(client))
    );

  try {
    await client.connect();
    assert.equal(client.connected, true, 'initially connected');

    // Wait for 'reconnected' event (with timeout guard).
    await new Promise((resolve, reject) => {
      const tid = setTimeout(
        () => reject(new Error('reconnected event not received within 5s')),
        5000
      );
      client.once('reconnected', () => {
        clearTimeout(tid);
        resolve(undefined);
      });
    });

    assert.equal(client.connected, true, 'connected again after reconnect');
    assert.ok(acceptCount >= 2, 'server should have accepted at least two connections');
  } finally {
    client.autoReconnect = false;
    await client.close().catch(() => {});
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test('BridgeClient _scheduleReconnect does not retry when autoReconnect is disabled', async (t) => {
  const client = new BridgeClient({ autoReconnect: false });
  let connectAttempts = 0;
  let reconnectedEvents = 0;

  t.mock.method(
    globalThis,
    'setTimeout',
    /** @type {typeof setTimeout} */ (
      /** @param {TimerHandler} callback */
      (callback) => {
        queueMicrotask(() => {
          if (typeof callback === 'function') {
            callback();
          }
        });
        return /** @type {any} */ (0);
      }
    )
  );

  client.connect = /** @type {typeof client.connect} */ (
    async () => {
      connectAttempts += 1;
      throw new Error('connect should not be called');
    }
  );
  client.on('reconnected', () => {
    reconnectedEvents += 1;
  });

  await client._scheduleReconnect();

  assert.equal(connectAttempts, 0);
  assert.equal(reconnectedEvents, 0);
  assert.equal(client._reconnecting, false);
});

test('BridgeClient _scheduleReconnect retries until connect succeeds and emits reconnected', async (t) => {
  const client = new BridgeClient({ autoReconnect: true });
  let connectAttempts = 0;
  let reconnectedEvents = 0;
  const clock = clockController();

  t.mock.method(globalThis, 'setTimeout', clock.setTimeout);

  client.connect = /** @type {typeof client.connect} */ (
    async () => {
      connectAttempts += 1;
      if (connectAttempts < 3) {
        throw new Error(`connect failed ${connectAttempts}`);
      }
      client.connected = true;
    }
  );
  client.on('reconnected', () => {
    reconnectedEvents += 1;
  });

  const reconnectPromise = client._scheduleReconnect();
  await clock.runAll();
  await reconnectPromise;

  assert.equal(connectAttempts, 3);
  assert.deepEqual(clock.delays, [1000, 2000, 4000]);
  assert.equal(reconnectedEvents, 1);
  assert.equal(client.connected, true);
  assert.equal(client._reconnecting, false);
});

test('BridgeClient.close() stops autoReconnect', async () => {
  let connectAttempts = 0;
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    connectAttempts += 1;
    socket.setEncoding('utf8');
    socket.write(
      `${JSON.stringify({ type: 'registered', role: 'agent', clientId: 'mock_client' })}\n`
    );
    setTimeout(() => socket.destroy(), 20);
  });
  await new Promise((resolve) =>
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve(undefined))
  );
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

  const client = new BridgeClient({
    defaultTimeoutMs: 3_000,
    autoReconnect: true,
  });
  /**
   * @this {BridgeClient}
   * @returns {Promise<void>}
   */
  async function reconnectingTcpConnect() {
    if (this.socket) throw new Error('BridgeClient is already connected.');
    const socket = net.createConnection({ host: '127.0.0.1', port });
    this.socket = socket;
    try {
      await new Promise((res, rej) => {
        socket.once('connect', res);
        socket.once('error', rej);
      });
    } catch (err) {
      socket.destroy();
      this.socket = null;
      throw err;
    }
    const { parseJsonLines } = await import('../../protocol/src/index.js');
    parseJsonLines(socket, (raw) => {
      const msg = /** @type {any} */ (raw);
      if (msg.type === 'registered') {
        const p = this.waiting.get('registered');
        if (p) {
          this.waiting.delete('registered');
          this.connected = true;
          clearTimeout(p.timeoutId);
          p.resolve(msg);
        }
      }
    });
    socket.on('close', () => {
      this.connected = false;
      this.socket = null;
      this.rejectAllPending(new Error('Bridge socket closed.'));
      if (this.autoReconnect && !this._reconnecting) void this._scheduleReconnect();
    });
    socket.on('error', (err) => this.rejectAllPending(err));
    socket.write(
      `${JSON.stringify({ type: 'register', role: 'agent', clientId: this.clientId })}\n`
    );
    await new Promise((res, rej) => {
      const tid = setTimeout(() => {
        this.waiting.delete('registered');
        rej(new Error('register timeout'));
      }, this.defaultTimeoutMs);
      this.waiting.set('registered', {
        resolve: res,
        reject: rej,
        timeoutId: tid,
      });
    });
  }
  client.connect =
    /** @type {typeof client.connect} */ (
      /** @type {unknown} */ (reconnectingTcpConnect.bind(client))
    );

  try {
    await client.connect();
    // Immediately close - should stop the reconnect loop even though the server
    // would drop the connection shortly.
    await client.close();
    assert.equal(client.autoReconnect, false, 'autoReconnect disabled after close');
    // Wait a bit to confirm no additional reconnect attempts happen.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(connectAttempts, 1, 'no reconnect attempts after close');
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test('BridgeClient uses BBX_TCP_PORT transport when configured', async () => {
  const { server, port } = await startMockDaemon(() => {});
  const previousPort = process.env.BBX_TCP_PORT;

  try {
    process.env.BBX_TCP_PORT = String(port);
    const client = new BridgeClient({ defaultTimeoutMs: 5_000 });
    await client.connect();
    assert.equal(client.transport.type, 'tcp');
    if (client.transport.type === 'tcp') {
      assert.equal(client.transport.port, port);
    }
    await client.close();
  } finally {
    if (previousPort === undefined) {
      delete process.env.BBX_TCP_PORT;
    } else {
      process.env.BBX_TCP_PORT = previousPort;
    }
    server.close();
  }
});

test('removeMcpConfig keeps Copilot mcpServers object after removing browser-bridge', async () => {
  const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-copilot-mcp-remove-'));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  try {
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    await installMcpConfig('copilot', {
      global: true,
      stdout: {
        write() {
          return true;
        },
      },
    });
    await removeMcpConfig('copilot', {
      global: true,
      stdout: {
        write() {
          return true;
        },
      },
    });

    const configPath = getMcpConfigPath('copilot', { global: true });
    const updated = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
    assert.deepEqual(updated, { mcpServers: {} });
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  }
});
