// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { methodNeedsSession, parseCommaList, parseJsonObject, parsePropertyAssignments } from '../src/cli-helpers.js';
import { installAgentFiles, parseInstallAgentArgs } from '../src/install.js';
import { buildMcpConfig, formatMcpConfig, getMcpConfigPath, isMcpClientName } from '../src/mcp-config.js';
import { summarizeBridgeResponse } from '../src/subagent.js';

/** Ensure failures stay compact for parent-agent reporting. */
test('summarizeBridgeResponse condenses failures', () => {
  const summary = summarizeBridgeResponse({
    id: 'req_fail',
    ok: false,
    result: null,
    error: {
      code: 'ACCESS_DENIED',
      message: 'Denied',
      details: { scope: 'tab' }
    },
    meta: { protocol_version: '1.0' }
  });

  assert.equal(summary.ok, false);
  assert.match(summary.summary, /ACCESS_DENIED/);
});

/** Ensure generic successes return compact evidence. */
test('summarizeBridgeResponse condenses success payloads', () => {
  const summary = summarizeBridgeResponse({
    id: 'req_ok',
    ok: true,
    result: {
      a: 1,
      b: 2
    },
    error: null,
    meta: { protocol_version: '1.0' }
  });

  assert.equal(summary.ok, true);
  assert.deepEqual(summary.evidence, ['a', 'b']);
});

/** Ensure CSS assignment parsing ignores malformed entries. */
test('parsePropertyAssignments handles css style pairs', () => {
  assert.deepEqual(
    parsePropertyAssignments(['display=flex', 'gap=8px', 'broken']),
    { display: 'flex', gap: '8px' }
  );
});

/** Ensure property lists split cleanly for style queries. */
test('parseCommaList splits and trims values', () => {
  assert.deepEqual(parseCommaList('display, color, width'), ['display', 'color', 'width']);
});

/** Ensure JSON object parsing rejects non-object shapes. */
test('parseJsonObject parses objects and rejects arrays', () => {
  assert.deepEqual(parseJsonObject('{"selector":"body"}'), { selector: 'body' });
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
        { type: 'fetch', method: 'GET', url: '/api/data', status: 200, duration: 50 },
        { type: 'xhr', method: 'POST', url: '/api/save', status: 201, duration: 120 }
      ],
      count: 2,
      total: 2
    },
    error: null,
    meta: { protocol_version: '1.0' }
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
      entries: [
        { level: 'warn', args: ['test'], ts: 123 }
      ],
      count: 1,
      total: 1
    },
    error: null,
    meta: { protocol_version: '1.0' }
  });

  assert.equal(summary.ok, true);
  assert.match(summary.summary, /Console/);
});

/** Ensure health.ping responses show daemon/extension status. */
test('summarizeBridgeResponse formats health ping correctly', () => {
  const connected = summarizeBridgeResponse({
    id: 'req_health',
    ok: true,
    result: { daemon: 'ok', extensionConnected: true, socketPath: '/tmp/test.sock' },
    error: null,
    meta: { protocol_version: '1.0' }
  });
  assert.equal(connected.ok, true);
  assert.match(connected.summary, /Daemon: ok/);
  assert.match(connected.summary, /Extension: connected/);

  const disconnected = summarizeBridgeResponse({
    id: 'req_health2',
    ok: true,
    result: { daemon: 'ok', extensionConnected: false, socketPath: '/tmp/test.sock' },
    error: null,
    meta: { protocol_version: '1.0' }
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
      hints: { tailwind: true, react: false }
    },
    error: null,
    meta: { protocol_version: '1.0' }
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
    meta: { protocol_version: '1.0' }
  });
  assert.equal(summary.ok, true);
  assert.match(summary.summary, /Page text: 22 chars/);
});

/** Ensure page.get_text (value field) also matches page text summarizer. */
test('summarizeBridgeResponse formats page.get_text value field', () => {
  const summary = summarizeBridgeResponse({
    id: 'req_text_val',
    ok: true,
    result: { value: 'Some page content...', length: 5000, truncated: true, omitted: 3000 },
    error: null,
    meta: { protocol_version: '1.0' }
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
        { at: '2026-01-01T00:00:00Z', method: 'dom.query', ok: true, id: 'req_1' },
        { at: '2026-01-01T00:00:01Z', method: 'page.evaluate', ok: false, id: 'req_2' }
      ]
    },
    error: null,
    meta: { protocol_version: '1.0' }
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
        { nodeId: 2, role: 'heading', name: 'Title', interactive: false }
      ],
      total: 2,
      count: 2,
      truncated: false
    },
    error: null,
    meta: { protocol_version: '1.0' }
  });
  assert.equal(summary.ok, true);
  assert.match(summary.summary, /Accessibility tree/);
  assert.match(summary.summary, /1 interactive/);
});

/** @param {unknown} result */
function ok(result) {
  return /** @type {import('../../protocol/src/types.js').BridgeResponse} */ ({
    id: 'req_test', ok: true, result, error: null, meta: { protocol_version: '1.0' }
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

test('summarizer: element describe', () => {
  const s = summarizeBridgeResponse(ok({
    tag: 'button', elementRef: 'el_xyz', id: 'submit',
    text: 'Save', bbox: { x: 10, y: 20, width: 80, height: 30 }, role: 'button'
  }));
  assert.match(s.summary, /Element button#submit, Save, 80\u00d730/);
});

test('summarizer: element describe with object text', () => {
  const s = summarizeBridgeResponse(ok({
    tag: 'h1', elementRef: 'el_h1',
    text: { value: 'Page Title', truncated: false, omitted: 0 },
    bbox: { x: 0, y: 0, width: 400, height: 30 }
  }));
  assert.match(s.summary, /Element h1, Page Title, 400\u00d730/);
  assert.equal(/** @type {any} */ (s.evidence).text, 'Page Title');
});

test('summarizer: computed styles', () => {
  const s = summarizeBridgeResponse(ok({
    elementRef: 'el_css', properties: { display: 'flex', color: 'red', gap: '8px' }
  }));
  assert.match(s.summary, /Computed 3 style\(s\) for el_css/);
});

test('summarizer: flat computed styles via method hint', () => {
  const s = summarizeBridgeResponse(ok({
    color: 'rgb(0,0,0)', display: 'block', 'font-size': '16px'
  }), 'styles.get_computed');
  assert.match(s.summary, /Computed 3 style\(s\)/);
  assert.deepEqual(s.evidence, { color: 'rgb(0,0,0)', display: 'block', 'font-size': '16px' });
});

test('summarizer: box model', () => {
  const s = summarizeBridgeResponse(ok({
    content: { x: 10, y: 20, width: 200, height: 100 },
    padding: { top: 5 }, border: { top: 1 }, margin: { top: 0 }
  }));
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

test('summarizer: session revoked', () => {
  const s = summarizeBridgeResponse(ok({ revoked: true }));
  assert.match(s.summary, /Session revoked/);
});

test('summarizer: storage truncates long values', () => {
  const longValue = 'x'.repeat(200);
  const s = summarizeBridgeResponse(ok({
    type: 'local', count: 2,
    entries: { key1: 'short', key2: longValue }
  }));
  assert.match(s.summary, /Storage \(local\): 2 entries/);
  const evidence = /** @type {Record<string, string>} */ (s.evidence);
  assert.equal(evidence.key1, 'short');
  assert.ok(evidence.key2.length <= 80);
  assert.ok(evidence.key2.endsWith('\u2026'));
});

test('summarizer: empty network uses method hint', () => {
  const s = summarizeBridgeResponse(ok({
    entries: [], count: 0, total: 0
  }), 'page.get_network');
  assert.match(s.summary, /Network: 0 requests/);
});

test('summarizer: empty console without method hint', () => {
  const s = summarizeBridgeResponse(ok({
    entries: [], count: 0, total: 0
  }));
  assert.match(s.summary, /Console: 0 entries/);
});

test('summarizer: find by text uses specific label', () => {
  const s = summarizeBridgeResponse(ok({
    nodes: [
      { elementRef: 'el_a', tag: 'button', textExcerpt: 'Submit', attrs: {}, bbox: {} }
    ]
  }), 'dom.find_by_text');
  assert.match(s.summary, /Found 1 element/);
});

test('summarizer: find by role uses specific label', () => {
  const s = summarizeBridgeResponse(ok({
    nodes: [], count: 0
  }), 'dom.find_by_role');
  assert.match(s.summary, /Found 0 element/);
});

test('summarizer: DOM query evidence includes textExcerpt and attrs', () => {
  const s = summarizeBridgeResponse(ok({
    nodes: [
      { elementRef: 'el_1', tag: 'div', textExcerpt: 'Hello', attrs: { id: 'main', class: 'container wide' }, bbox: {} }
    ]
  }));
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
  const s = summarizeBridgeResponse(ok({
    entries: [{ type: 'fetch', method: 'GET', url: longUrl, status: 200, duration: 50 }],
    count: 1, total: 1
  }));
  const evidence = /** @type {Array<Record<string, unknown>>} */ (s.evidence);
  assert.ok(/** @type {string} */ (evidence[0].url).length <= 130);
});

test('summarizer: a11y tree shows non-interactive nodes when no interactive found', () => {
  const s = summarizeBridgeResponse(ok({
    nodes: [
      { nodeId: '1', role: 'heading', name: 'Title', interactive: false },
      { nodeId: '2', role: 'generic', name: '', interactive: false }
    ],
    total: 2, count: 2, truncated: false
  }));
  const evidence = /** @type {Array<Record<string, unknown>>} */ (s.evidence);
  assert.ok(evidence.length > 0, 'should show non-interactive nodes');
  assert.equal(evidence[0].role, 'heading');
});

test('summarizer: dom.get_text uses Element text label', () => {
  const s = summarizeBridgeResponse(ok({
    text: 'Hello world', truncated: false, length: 11
  }), 'dom.get_text');
  assert.match(s.summary, /Element text/);
});

test('summarizer: page.get_text still uses Page text label', () => {
  const s = summarizeBridgeResponse(ok({
    text: 'Hello world', truncated: false, length: 11
  }), 'page.get_text');
  assert.match(s.summary, /Page text/);
});

test('summarizer: DOM query evidence includes role and label', () => {
  const s = summarizeBridgeResponse(ok({
    nodes: [
      { elementRef: 'el_1', tag: 'button', role: 'button', name: 'Submit', attrs: { role: 'button', 'aria-label': 'Submit form' }, bbox: {} }
    ]
  }));
  const evidence = /** @type {Array<Record<string, unknown>>} */ (s.evidence);
  assert.equal(evidence[0].role, 'button');
  assert.equal(evidence[0].label, 'Submit form');
});

test('parseInstallAgentArgs defaults to all supported targets', () => {
  const options = parseInstallAgentArgs([], '/tmp/example');
  assert.deepEqual(options.targets, ['copilot', 'claude', 'cursor', 'opencode', 'agents', 'codex']);
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

test('installAgentFiles writes managed files for supported runtimes', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bb-install-agent-'));
  const installed = await installAgentFiles({
    targets: ['copilot', 'claude', 'cursor', 'opencode', 'agents', 'codex'],
    projectPath: tempDir,
    global: false
  });

  assert.ok(installed.some((entry) => entry.endsWith(path.join('.github', 'skills', 'browser-bridge'))));
  assert.ok(installed.some((entry) => entry.endsWith(path.join('.github', 'skills', 'browser-bridge-mcp'))));
  assert.ok(installed.some((entry) => entry.endsWith(path.join('.claude', 'skills', 'browser-bridge'))));
  assert.ok(installed.some((entry) => entry.endsWith(path.join('.claude', 'skills', 'browser-bridge-mcp'))));
  assert.ok(installed.some((entry) => entry.endsWith(path.join('.cursor', 'skills', 'browser-bridge'))));
  assert.ok(installed.some((entry) => entry.endsWith(path.join('.cursor', 'skills', 'browser-bridge-mcp'))));
  assert.ok(installed.some((entry) => entry.endsWith(path.join('.opencode', 'skills', 'browser-bridge'))));
  assert.ok(installed.some((entry) => entry.endsWith(path.join('.opencode', 'skills', 'browser-bridge-mcp'))));
  assert.ok(installed.some((entry) => entry.endsWith(path.join('.agents', 'skills', 'browser-bridge'))));
  assert.ok(installed.some((entry) => entry.endsWith(path.join('.agents', 'skills', 'browser-bridge-mcp'))));
  assert.ok(installed.some((entry) => entry.endsWith(path.join('.codex', 'skills', 'browser-bridge'))));
  assert.ok(installed.some((entry) => entry.endsWith(path.join('.codex', 'skills', 'browser-bridge-mcp'))));

  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.github', 'skills', 'browser-bridge', 'SKILL.md')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.github', 'skills', 'browser-bridge-mcp', 'SKILL.md')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.claude', 'skills', 'browser-bridge', 'SKILL.md')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.claude', 'skills', 'browser-bridge-mcp', 'SKILL.md')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.cursor', 'skills', 'browser-bridge', 'SKILL.md')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.cursor', 'skills', 'browser-bridge-mcp', 'SKILL.md')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.opencode', 'skills', 'browser-bridge', 'SKILL.md')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.opencode', 'skills', 'browser-bridge-mcp', 'SKILL.md')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.agents', 'skills', 'browser-bridge', 'SKILL.md')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.agents', 'skills', 'browser-bridge-mcp', 'SKILL.md')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.codex', 'skills', 'browser-bridge', 'SKILL.md')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.codex', 'skills', 'browser-bridge-mcp', 'SKILL.md')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.codex', 'skills', 'browser-bridge', 'agents', 'openai.yaml')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.codex', 'skills', 'browser-bridge-mcp', 'agents', 'openai.yaml')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.agents', 'skills', 'browser-bridge', 'references', 'protocol.md')));
});

test('installAgentFiles writes GitHub Copilot global skills to ~/.copilot/skills', async () => {
  const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bb-install-agent-home-'));
  const originalHome = process.env.HOME;

  try {
    process.env.HOME = tempHome;
    const installed = await installAgentFiles({
      targets: ['copilot'],
      projectPath: '/tmp/unused',
      global: true
    });

    assert.ok(installed.some((entry) => entry.endsWith(path.join('.copilot', 'skills', 'browser-bridge'))));
    assert.ok(installed.some((entry) => entry.endsWith(path.join('.copilot', 'skills', 'browser-bridge-mcp'))));
    await assert.doesNotReject(fs.promises.access(path.join(tempHome, '.copilot', 'skills', 'browser-bridge', 'SKILL.md')));
    await assert.doesNotReject(fs.promises.access(path.join(tempHome, '.copilot', 'skills', 'browser-bridge-mcp', 'SKILL.md')));
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  }
});

test('isMcpClientName recognizes supported clients', () => {
  assert.equal(isMcpClientName('claude'), true);
  assert.equal(isMcpClientName('cursor'), true);
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
        command: 'bbx',
        args: ['mcp', 'serve'],
        env: {}
      }
    }
  });

  assert.deepEqual(buildMcpConfig('claude'), {
    mcpServers: {
      'browser-bridge': {
        type: 'stdio',
        command: 'bbx',
        args: ['mcp', 'serve'],
        env: {}
      }
    }
  });

  assert.deepEqual(buildMcpConfig('copilot'), {
    servers: {
      'browser-bridge': {
        type: 'stdio',
        command: 'bbx',
        args: ['mcp', 'serve'],
        env: {}
      }
    }
  });

  assert.deepEqual(buildMcpConfig('opencode'), {
    mcp: {
      'browser-bridge': {
        type: 'local',
        command: ['bbx', 'mcp', 'serve']
      }
    }
  });
});

test('formatMcpConfig returns pretty JSON with newline', () => {
  const formatted = formatMcpConfig('cursor');
  assert.match(formatted, /"browser-bridge"/);
  assert.ok(formatted.endsWith('\n'));
});

test('getMcpConfigPath supports OpenCode global and local locations', () => {
  const home = os.homedir();
  assert.equal(
    getMcpConfigPath('opencode', { global: false, cwd: '/tmp/demo' }),
    path.join('/tmp/demo', 'opencode.json')
  );
  assert.equal(
    getMcpConfigPath('opencode', { global: true }),
    path.join(home, '.config', 'opencode', 'opencode.json')
  );
});
