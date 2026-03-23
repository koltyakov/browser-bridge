// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { interactiveConfirm, methodNeedsSession, parseCommaList, parseJsonObject, parsePropertyAssignments } from '../src/cli-helpers.js';
import { findInstalledManagedTargets, getManagedSkillSentinelFilename, getSkillBasePath, installAgentFiles, parseInstallAgentArgs, removeAgentFiles } from '../src/install.js';
import { buildMcpConfig, formatMcpConfig, getMcpConfigPath, getMcpConfigPaths, installMcpConfig, isMcpClientName } from '../src/mcp-config.js';
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
  assert.deepEqual(options.targets, ['copilot', 'claude', 'cursor', 'windsurf', 'opencode', 'antigravity', 'agents', 'codex']);
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

  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

  try {
    const result = await interactiveConfirm('Remove skills?');
    assert.equal(result, null);
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIn, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: originalOut, configurable: true });
  }
});

test('installAgentFiles writes managed files for supported runtimes', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bb-install-agent-'));
  await installMcpConfig('copilot', {
    global: false,
    cwd: tempDir,
    stdout: { write() { return true; } }
  });
  await installMcpConfig('cursor', {
    global: false,
    cwd: tempDir,
    stdout: { write() { return true; } }
  });
  await installMcpConfig('codex', {
    global: false,
    cwd: tempDir,
    stdout: { write() { return true; } }
  });
  const installed = await installAgentFiles({
    targets: ['copilot', 'claude', 'cursor', 'windsurf', 'opencode', 'antigravity', 'agents', 'codex'],
    projectPath: tempDir,
    global: false
  });

  assert.ok(installed.some((entry) => entry.endsWith(path.join('.github', 'skills', 'browser-bridge'))));
  assert.ok(installed.some((entry) => entry.endsWith(path.join('.github', 'skills', 'browser-bridge-mcp'))));
  assert.ok(installed.some((entry) => entry.endsWith(path.join('.claude', 'skills', 'browser-bridge'))));
  assert.ok(!installed.some((entry) => entry.endsWith(path.join('.claude', 'skills', 'browser-bridge-mcp'))));
  assert.ok(installed.some((entry) => entry.endsWith(path.join('.cursor', 'skills', 'browser-bridge'))));
  assert.ok(installed.some((entry) => entry.endsWith(path.join('.cursor', 'skills', 'browser-bridge-mcp'))));
  assert.ok(installed.some((entry) => entry.endsWith(path.join('.windsurf', 'skills', 'browser-bridge'))));
  assert.ok(!installed.some((entry) => entry.endsWith(path.join('.windsurf', 'skills', 'browser-bridge-mcp'))));
  assert.ok(installed.some((entry) => entry.endsWith(path.join('.opencode', 'skills', 'browser-bridge'))));
  assert.ok(!installed.some((entry) => entry.endsWith(path.join('.opencode', 'skills', 'browser-bridge-mcp'))));
  assert.ok(installed.some((entry) => entry.endsWith(path.join('.agents', 'skills', 'browser-bridge'))));
  assert.ok(!installed.some((entry) => entry.endsWith(path.join('.agents', 'skills', 'browser-bridge-mcp'))));
  assert.ok(installed.some((entry) => entry.endsWith(path.join('.codex', 'skills', 'browser-bridge'))));
  assert.ok(installed.some((entry) => entry.endsWith(path.join('.codex', 'skills', 'browser-bridge-mcp'))));

  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.github', 'skills', 'browser-bridge', 'SKILL.md')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.github', 'skills', 'browser-bridge-mcp', 'SKILL.md')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.claude', 'skills', 'browser-bridge', 'SKILL.md')));
  await assert.rejects(fs.promises.access(path.join(tempDir, '.claude', 'skills', 'browser-bridge-mcp', 'SKILL.md')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.cursor', 'skills', 'browser-bridge', 'SKILL.md')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.cursor', 'skills', 'browser-bridge-mcp', 'SKILL.md')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.windsurf', 'skills', 'browser-bridge', 'SKILL.md')));
  await assert.rejects(fs.promises.access(path.join(tempDir, '.windsurf', 'skills', 'browser-bridge-mcp', 'SKILL.md')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.opencode', 'skills', 'browser-bridge', 'SKILL.md')));
  await assert.rejects(fs.promises.access(path.join(tempDir, '.opencode', 'skills', 'browser-bridge-mcp', 'SKILL.md')));
  await assert.doesNotReject(fs.promises.access(path.join(tempDir, '.agents', 'skills', 'browser-bridge', 'SKILL.md')));
  await assert.rejects(fs.promises.access(path.join(tempDir, '.agents', 'skills', 'browser-bridge-mcp', 'SKILL.md')));
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
    assert.ok(!installed.some((entry) => entry.endsWith(path.join('.copilot', 'skills', 'browser-bridge-mcp'))));
    await assert.doesNotReject(fs.promises.access(path.join(tempHome, '.copilot', 'skills', 'browser-bridge', 'SKILL.md')));
    await assert.rejects(fs.promises.access(path.join(tempHome, '.copilot', 'skills', 'browser-bridge-mcp', 'SKILL.md')));
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  }
});

test('installAgentFiles applies the GitHub Copilot-specific CLI skill note', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bb-install-agent-copilot-note-'));

  try {
    await installAgentFiles({
      targets: ['copilot', 'cursor'],
      projectPath: tempDir,
      global: false
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
    assert.match(copilotSkill, /switch to `\/browser-bridge-mcp`/);
    assert.doesNotMatch(cursorSkill, /## GitHub Copilot Note/);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('installAgentFiles adds the GitHub Copilot MCP companion when global MCP is configured', async () => {
  const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bb-install-agent-copilot-mcp-home-'));
  const originalHome = process.env.HOME;
  const originalAppData = process.env.APPDATA;

  try {
    process.env.HOME = tempHome;
    if (process.platform === 'win32') {
      process.env.APPDATA = path.join(tempHome, 'AppData', 'Roaming');
    }
    await installMcpConfig('copilot', {
      global: true,
      stdout: { write() { return true; } }
    });

    const installed = await installAgentFiles({
      targets: ['copilot'],
      projectPath: '/tmp/unused',
      global: true
    });

    assert.ok(installed.some((entry) => entry.endsWith(path.join('.copilot', 'skills', 'browser-bridge-mcp'))));
    await assert.doesNotReject(fs.promises.access(path.join(tempHome, '.copilot', 'skills', 'browser-bridge-mcp', 'SKILL.md')));
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  }
});

test('findInstalledManagedTargets reports targets with managed skill installs', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bb-find-managed-targets-'));

  try {
    await installMcpConfig('cursor', {
      global: false,
      cwd: tempDir,
      stdout: { write() { return true; } }
    });
    await installAgentFiles({
      targets: ['cursor'],
      projectPath: tempDir,
      global: false
    });

    const installed = await findInstalledManagedTargets({
      targets: ['cursor', 'copilot'],
      projectPath: tempDir,
      global: false
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
      stdout: { write() { return true; } }
    });
    await installAgentFiles({
      targets: ['cursor'],
      projectPath: tempDir,
      global: false
    });

    const skillBasePath = getSkillBasePath('cursor', {
      projectPath: tempDir,
      global: false
    });
    const unmanagedSkillPath = path.join(skillBasePath, 'custom-skill');
    const managedSentinel = getManagedSkillSentinelFilename();
    await fs.promises.mkdir(unmanagedSkillPath, { recursive: true });
    await fs.promises.writeFile(path.join(unmanagedSkillPath, 'SKILL.md'), '# Custom\n', 'utf8');
    await fs.promises.mkdir(path.join(skillBasePath, 'browser-bridge-extra'), { recursive: true });
    await fs.promises.writeFile(path.join(skillBasePath, 'browser-bridge-extra', 'SKILL.md'), '# Extra\n', 'utf8');
    await fs.promises.writeFile(path.join(skillBasePath, 'browser-bridge-extra', managedSentinel), 'managed\n', 'utf8');

    const removed = await removeAgentFiles({
      targets: ['cursor'],
      projectPath: tempDir,
      global: false
    });

    assert.ok(removed.some((entry) => entry.endsWith(path.join('.cursor', 'skills', 'browser-bridge'))));
    assert.ok(removed.some((entry) => entry.endsWith(path.join('.cursor', 'skills', 'browser-bridge-mcp'))));
    assert.equal(await fs.promises.access(unmanagedSkillPath).then(() => true, () => false), true);
    assert.equal(
      await fs.promises.access(path.join(skillBasePath, 'browser-bridge-extra')).then(() => true, () => false),
      true
    );
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('installAgentFiles writes Windsurf and Antigravity global skills to their documented locations', async () => {
  const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bb-install-agent-home-'));
  const originalHome = process.env.HOME;

  try {
    process.env.HOME = tempHome;
    await installMcpConfig('windsurf', {
      global: true,
      stdout: { write() { return true; } }
    });
    const installed = await installAgentFiles({
      targets: ['windsurf', 'antigravity'],
      projectPath: '/tmp/unused',
      global: true
    });

    assert.ok(installed.some((entry) => entry.endsWith(path.join('.codeium', 'windsurf', 'skills', 'browser-bridge'))));
    assert.ok(installed.some((entry) => entry.endsWith(path.join('.codeium', 'windsurf', 'skills', 'browser-bridge-mcp'))));
    assert.ok(installed.some((entry) => entry.endsWith(path.join('.gemini', 'antigravity', 'skills', 'browser-bridge'))));
    assert.ok(!installed.some((entry) => entry.endsWith(path.join('.gemini', 'antigravity', 'skills', 'browser-bridge-mcp'))));
    await assert.doesNotReject(fs.promises.access(path.join(tempHome, '.codeium', 'windsurf', 'skills', 'browser-bridge', 'SKILL.md')));
    await assert.doesNotReject(fs.promises.access(path.join(tempHome, '.codeium', 'windsurf', 'skills', 'browser-bridge-mcp', 'SKILL.md')));
    await assert.doesNotReject(fs.promises.access(path.join(tempHome, '.gemini', 'antigravity', 'skills', 'browser-bridge', 'SKILL.md')));
    await assert.rejects(fs.promises.access(path.join(tempHome, '.gemini', 'antigravity', 'skills', 'browser-bridge-mcp', 'SKILL.md')));
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
        command: 'bbx',
        args: ['mcp', 'serve'],
        env: {}
      }
    }
  });

  assert.deepEqual(buildMcpConfig('windsurf'), {
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

  assert.deepEqual(buildMcpConfig('codex'), {
    mcp_servers: {
      'browser-bridge': {
        command: 'bbx',
        args: ['mcp', 'serve']
      }
    }
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
  assert.match(formatted, /command = "bbx"/);
  assert.ok(formatted.endsWith('\n'));
});

test('getMcpConfigPath supports Copilot global and local locations', () => {
  const home = os.homedir();
  const expectedGlobal = path.join(home, '.copilot', 'mcp-config.json');

  assert.equal(
    getMcpConfigPath('copilot', { global: false, cwd: '/tmp/demo' }),
    path.join('/tmp/demo', '.vscode', 'mcp.json')
  );
  assert.equal(
    getMcpConfigPath('copilot', { global: true }),
    expectedGlobal
  );
});

test('getMcpConfigPath supports Claude Code global and local locations', () => {
  const home = os.homedir();
  assert.equal(
    getMcpConfigPath('claude', { global: false, cwd: '/tmp/demo' }),
    path.join('/tmp/demo', '.mcp.json')
  );
  assert.equal(
    getMcpConfigPath('claude', { global: true }),
    path.join(home, '.claude.json')
  );
});

test('getMcpConfigPath supports Codex global and local locations', () => {
  const home = os.homedir();
  assert.equal(
    getMcpConfigPath('codex', { global: false, cwd: '/tmp/demo' }),
    path.join('/tmp/demo', '.codex', 'config.toml')
  );
  assert.equal(
    getMcpConfigPath('codex', { global: true }),
    path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml')
  );
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

test('getMcpConfigPath supports Windsurf global and local locations', () => {
  const home = os.homedir();
  assert.equal(
    getMcpConfigPath('windsurf', { global: false, cwd: '/tmp/demo' }),
    path.join('/tmp/demo', '.windsurf', 'mcp_config.json')
  );
  assert.equal(
    getMcpConfigPath('windsurf', { global: true }),
    path.join(home, '.codeium', 'windsurf', 'mcp_config.json')
  );
});

test('getMcpConfigPaths includes existing Copilot profile configs for global installs', async () => {
  const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-copilot-mcp-paths-'));
  const originalHome = process.env.HOME;
  const originalAppData = process.env.APPDATA;

  try {
    process.env.HOME = tempHome;
    if (process.platform === 'win32') {
      process.env.APPDATA = path.join(tempHome, 'AppData', 'Roaming');
    }
    const profileDir = process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(tempHome, 'AppData', 'Roaming'), 'Code', 'User', 'profiles', 'profile-a')
      : process.platform === 'linux'
        ? path.join(tempHome, '.config', 'Code', 'User', 'profiles', 'profile-a')
        : path.join(tempHome, 'Library', 'Application Support', 'Code', 'User', 'profiles', 'profile-a');
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
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  }
});
