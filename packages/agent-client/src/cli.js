#!/usr/bin/env node
// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntimeContext, METHODS } from '../../protocol/src/index.js';
import { startBridgeMcpServer } from '../../mcp-server/src/server.js';
import { BridgeClient } from './client.js';
import { interactiveCheckbox, methodNeedsSession, parseCommaList, parseIntArg, parseJsonObject, parsePropertyAssignments } from './cli-helpers.js';
import { detectMcpClients, detectSkillTargets } from './detect.js';
import { installAgentFiles, parseInstallAgentArgs } from './install.js';
import { formatMcpConfig, installMcpConfig, isMcpClientName, MCP_CLIENT_NAMES } from './mcp-config.js';
import { getDoctorReport, requestBridge, requireSession, resolveRef } from './runtime.js';
import { summarizeBridgeResponse } from './subagent.js';

/** @typedef {import('../../protocol/src/types.js').SessionState} SessionState */
/** @typedef {import('../../protocol/src/types.js').BridgeMethod} BridgeMethod */
/** @typedef {{ image: string, rect: Record<string, unknown> }} ScreenshotResult */

/**
 * Read all of stdin as UTF-8 text. Resolves once stdin closes.
 *
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = /** @type {Buffer[]} */ ([]);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
    process.stdin.on('error', reject);
    // If stdin is a TTY and nothing is piped, read nothing
    if (process.stdin.isTTY) {
      resolve('');
    }
  });
}

const [, , command, ...rest] = process.argv;

if (!command || ['help', '--help', '-h'].includes(command)) {
  printUsage();
  process.exit(0);
}

if (command === 'skill') {
  process.stdout.write(`${JSON.stringify(createRuntimeContext(), null, process.stdout.isTTY ? 2 : undefined)}\n`);
  process.exit(0);
}

if (command === 'install') {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const installScript = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../native-host/bin/install-manifest.js'
  );
  execFileSync(process.execPath, [installScript, ...rest], { stdio: 'inherit' });
  process.exit(0);
}

if (command === 'install-skill') {
  // When no positional target is given, detect installed agents and prompt.
  const positional = rest.filter((a) => !a.startsWith('--'));

  if (positional.length === 0) {
    // Parse scope flags without going through parseInstallAgentArgs.
    let isGlobal = true;
    if (rest.includes('--local')) isGlobal = false;
    if (rest.includes('--global')) isGlobal = true;

    /** @type {import('./install.js').SupportedTarget[]} */
    const detected = detectSkillTargets();

    // 'openai' shares the same path as 'codex' - omit from interactive list.
    /** @type {Array<import('./install.js').SupportedTarget>} */
    const interactiveTargets = ['copilot', 'codex', 'claude', 'opencode', 'agents'];
    /** @type {Record<string, string>} */
    const targetLabels = {
      copilot: 'GitHub Copilot (VS Code)',
      codex: 'OpenAI Codex CLI',
      claude: 'Claude Code / Claude Desktop',
      opencode: 'OpenCode',
      agents: 'Generic agents  (.agents/skills/)'
    };
    const items = interactiveTargets.map((t) => ({
      value: t,
      label: `${t.padEnd(10)}  ${targetLabels[t]}`,
      hint: detected.includes(t) ? '● detected' : undefined,
      checked: detected.includes(t)
    }));

    const selected = await interactiveCheckbox(
      'Select agents to install skill for  (↑↓ move · space toggle · a all · enter confirm)',
      items
    );

    /** @type {import('./install.js').SupportedTarget[]} */
    let targets;
    if (selected === null) {
      // Non-TTY: fall back to detected targets (always includes 'agents').
      targets = detected;
    } else if (selected.length === 0) {
      process.stdout.write('No targets selected.\n');
      process.exit(0);
    } else {
      targets = /** @type {import('./install.js').SupportedTarget[]} */ (selected);
    }

    const projectPath = isGlobal ? os.homedir() : process.cwd();
    const installedPaths = await installAgentFiles({ targets, projectPath, global: isGlobal });
    for (const p of installedPaths) process.stdout.write(`Installed ${p}\n`);
    process.exit(0);
  }

  // Explicit targets or 'all' provided - use existing arg-parsing logic.
  const options = parseInstallAgentArgs(rest);
  const installedPaths = await installAgentFiles(options);
  for (const installedPath of installedPaths) {
    process.stdout.write(`Installed ${installedPath}\n`);
  }
  process.exit(0);
}

if (command === 'install-mcp') {
  const argsLeft = [...rest];
  let isGlobal = true;

  const localIdx = argsLeft.indexOf('--local');
  if (localIdx !== -1) { isGlobal = false; argsLeft.splice(localIdx, 1); }
  const globalIdx = argsLeft.indexOf('--global');
  if (globalIdx !== -1) { argsLeft.splice(globalIdx, 1); }

  const clientArg = argsLeft[0];

  /** @type {import('./mcp-config.js').McpClientName[]} */
  let clients;

  if (!clientArg) {
    // No client specified: detect installed clients and prompt interactively.
    const detected = detectMcpClients();
    /** @type {Record<string, string>} */
    const clientLabels = {
      copilot: 'GitHub Copilot (VS Code)',
      codex: 'OpenAI Codex CLI',
      cursor: 'Cursor',
      claude: 'Claude Desktop / Claude Code'
    };
    const items = MCP_CLIENT_NAMES.map((c) => ({
      value: c,
      label: `${c.padEnd(10)}  ${clientLabels[c]}`,
      hint: detected.includes(c) ? '● detected' : undefined,
      checked: detected.includes(c)
    }));

    const selected = await interactiveCheckbox(
      'Select clients to configure  (↑↓ move · space toggle · a all · enter confirm)',
      items
    );

    if (selected === null) {
      // Non-TTY: fall back to detected clients, or all if nothing detected.
      clients = detected.length > 0 ? detected : [...MCP_CLIENT_NAMES];
    } else if (selected.length === 0) {
      process.stdout.write('No clients selected.\n');
      process.exit(0);
    } else {
      clients = /** @type {import('./mcp-config.js').McpClientName[]} */ (selected);
    }
  } else if (clientArg === 'all') {
    clients = [...MCP_CLIENT_NAMES];
  } else {
    const parts = clientArg.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (parts.includes('all')) {
      clients = [...MCP_CLIENT_NAMES];
    } else {
      clients = [];
      for (const part of parts) {
        if (!isMcpClientName(part)) {
          process.stderr.write(`Unknown client "${part}". Supported: ${MCP_CLIENT_NAMES.join(', ')}, all\n`);
          process.exit(1);
        }
        clients.push(part);
      }
    }
  }

  for (const clientName of clients) {
    await installMcpConfig(clientName, { global: isGlobal, cwd: process.cwd() });
  }
  process.exit(0);
}

if (command === 'mcp') {
  const [subcommand, clientName] = rest;
  if (subcommand === 'serve') {
    await startBridgeMcpServer();
    await new Promise(() => {});
  }
  if (subcommand === 'config') {
    if (!clientName || !isMcpClientName(clientName)) {
      process.stderr.write('Usage: bbx mcp config <claude|cursor|copilot|codex>\n');
      process.exit(1);
    }
    process.stdout.write(formatMcpConfig(clientName));
    process.exit(0);
  }
  process.stderr.write('Usage: bbx mcp <serve|config>\n');
  process.exit(1);
}

const client = new BridgeClient();

await main();

async function main() {
  try {
    if (command === 'status') {
      await printSummary(await requestBridge(client, 'health.ping'));
      return;
    }

    if (command === 'doctor') {
      const report = await getDoctorReport();
      printJson({
        ok: report.issues.length === 0,
        summary: report.issues.length === 0
          ? 'Browser Bridge is ready.'
          : `Browser Bridge has ${report.issues.length} setup issue(s).`,
        evidence: report
      });
      return;
    }

    if (command === 'logs') {
      await printSummary(await requestBridge(client, 'log.tail'));
      return;
    }

    if (command === 'tabs') {
      await printSummary(await requestBridge(client, 'tabs.list'));
      return;
    }

    if (command === 'tab-create') {
      const [url] = rest;
      const response = await requestBridge(client, 'tabs.create', {
        url: url || undefined
      });
      await printSummary(response);
      return;
    }

    if (command === 'tab-close') {
      const [tabId] = rest;
      if (!tabId) {
        throw new Error('Usage: tab-close <tabId>');
      }
      const response = await requestBridge(client, 'tabs.close', {
        tabId: parseIntArg(tabId, 'tabId')
      });
      await printSummary(response);
      return;
    }

    if (command === 'call') {
      const { sessionId, method, params } = await parseCallCommand(rest);
      const response = await requestBridge(client, method, params, { sessionId });
      printJson(response.ok ? response.result : response);
      return;
    }

    if (command === 'batch') {
      await ensureClientConnection();
      const input = rest[0];
      if (!input) {
        throw new Error('Usage: batch \'[{"method":"...","params":{...}}, ...]\'');
      }
      const calls = JSON.parse(input);
      if (!Array.isArray(calls)) {
        throw new Error('Batch input must be a JSON array.');
      }
      const needsSession = calls.some((c) => methodNeedsSession(c.method));
      const session = needsSession ? await requireSession(client) : null;
      const results = await Promise.all(calls.map(async (call) => {
        try {
          const response = await client.request({
            method: /** @type {BridgeMethod} */ (call.method),
            sessionId: methodNeedsSession(call.method) ? session?.sessionId ?? null : null,
            params: call.params || {}
          });
          return summarizeBridgeResponse(response, call.method);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false, summary: `${call.method}: ${message}`, evidence: null };
        }
      }));
      printJson(results);
      return;
    }

    if (command === 'request-access') {
      const [tabIdOrOrigin, originArg] = rest;
      const parsedTabId = Number(tabIdOrOrigin);
      const response = await requestBridge(client, 'session.request_access', {
        tabId: Number.isFinite(parsedTabId) && parsedTabId > 0 ? parsedTabId : undefined,
        origin: Number.isFinite(parsedTabId) && parsedTabId > 0 ? originArg : (tabIdOrOrigin || undefined)
      });
      await printSummary(response);
      return;
    }

    if (command === 'session') {
      const session = await requireSession(client);
      printJson(session);
      return;
    }

    if (command === 'revoke') {
      const session = await requireSession(client);
      const response = await requestBridge(client, 'session.revoke', {}, {
        sessionId: session.sessionId
      });
      await printSummary(response);
      return;
    }

    // ── Session command dispatch table ──────────────────────────────

    /**
     * @typedef {{
     *   method: BridgeMethod,
     *   resolve?: boolean,
     *   printMethod?: string,
     *   build: (r: string[], ref?: string) => Record<string, unknown>
     * }} SessionCommand
     */

    /** @type {Record<string, SessionCommand>} */
    const sessionCommands = {
      'dom-query': {
        method: 'dom.query',
        build: (r) => ({ selector: r[0] || 'body' })
      },
      'describe': {
        method: 'dom.describe', resolve: true, printMethod: 'dom.describe',
        build: (_r, ref) => ({ elementRef: ref })
      },
      'text': {
        method: 'dom.get_text', resolve: true, printMethod: 'dom.get_text',
        build: (r, ref) => ({ elementRef: ref, textBudget: r[1] ? parseIntArg(r[1], 'budget') : undefined })
      },
      'styles': {
        method: 'styles.get_computed', resolve: true, printMethod: 'styles.get_computed',
        build: (r, ref) => ({ elementRef: ref, properties: parseCommaList(r[1]) })
      },
      'box': {
        method: 'layout.get_box_model', resolve: true, printMethod: 'layout.get_box_model',
        build: (_r, ref) => ({ elementRef: ref })
      },
      'click': {
        method: 'input.click', resolve: true,
        build: (r, ref) => ({ target: { elementRef: ref }, button: r[1] })
      },
      'focus': {
        method: 'input.focus', resolve: true,
        build: (_r, ref) => ({ target: { elementRef: ref } })
      },
      'type': {
        method: 'input.type', resolve: true,
        build: (r, ref) => ({ target: { elementRef: ref }, text: r.slice(1).join(' ') })
      },
      'hover': {
        method: 'input.hover', resolve: true,
        build: (_r, ref) => ({ target: { elementRef: ref } })
      },
      'html': {
        method: 'dom.get_html', resolve: true,
        build: (r, ref) => ({ elementRef: ref, maxLength: r[1] ? parseIntArg(r[1], 'maxLen') : undefined })
      },
      'patch-style': {
        method: 'patch.apply_styles', resolve: true,
        build: (r, ref) => ({ target: { elementRef: ref }, declarations: parsePropertyAssignments(r.slice(1)) })
      },
      'patch-text': {
        method: 'patch.apply_dom', resolve: true,
        build: (r, ref) => ({ target: { elementRef: ref }, operation: 'set_text', value: r.slice(1).join(' ') })
      },
      'patches': {
        method: 'patch.list',
        build: () => ({})
      },
      'rollback': {
        method: 'patch.rollback',
        build: (r) => { if (!r[0]) throw new Error('Usage: rollback <patchId>'); return { patchId: r[0] }; }
      },
      'console': {
        method: 'page.get_console', printMethod: 'page.get_console',
        build: (r) => ({ level: r[0] || 'all', clear: false })
      },
      'wait': {
        method: 'dom.wait_for',
        build: (r) => { if (!r[0]) throw new Error('Usage: wait <selector> [timeoutMs]'); return { selector: r[0], timeoutMs: r[1] ? parseIntArg(r[1], 'timeoutMs') : 5000 }; }
      },
      'find': {
        method: 'dom.find_by_text', printMethod: 'dom.find_by_text',
        build: (r) => { const t = r.join(' '); if (!t) throw new Error('Usage: find <text>'); return { text: t }; }
      },
      'find-role': {
        method: 'dom.find_by_role', printMethod: 'dom.find_by_role',
        build: (r) => { if (!r[0]) throw new Error('Usage: find-role <role> [name]'); return { role: r[0], name: r.slice(1).join(' ') || undefined }; }
      },
      'navigate': {
        method: 'navigation.navigate',
        build: (r) => { if (!r[0]) throw new Error('Usage: navigate <url>'); return { url: r[0] }; }
      },
      'storage': {
        method: 'page.get_storage',
        build: (r) => ({ type: r[0] === 'session' ? 'session' : 'local', keys: r.slice(1).length ? r.slice(1) : undefined })
      },
      'page-text': {
        method: 'page.get_text', printMethod: 'page.get_text',
        build: (r) => ({ textBudget: r[0] ? parseIntArg(r[0], 'textBudget') : undefined })
      },
      'network': {
        method: 'page.get_network', printMethod: 'page.get_network',
        build: (r) => ({ limit: r[0] ? parseIntArg(r[0], 'limit') : undefined })
      },
      'a11y-tree': {
        method: 'dom.get_accessibility_tree',
        build: (r) => ({ maxNodes: r[0] ? parseIntArg(r[0], 'maxNodes') : undefined, maxDepth: r[1] ? parseIntArg(r[1], 'maxDepth') : undefined })
      },
      'perf': {
        method: 'performance.get_metrics',
        build: () => ({})
      },
      'scroll': {
        method: 'viewport.scroll',
        build: (r) => { if (!r[0] && !r[1]) throw new Error('Usage: scroll <top> [left]'); return { top: r[0] ? parseIntArg(r[0], 'top') : undefined, left: r[1] ? parseIntArg(r[1], 'left') : undefined }; }
      },
      'resize': {
        method: 'viewport.resize',
        build: (r) => { if (!r[0] || !r[1]) throw new Error('Usage: resize <width> <height>'); return { width: parseIntArg(r[0], 'width'), height: parseIntArg(r[1], 'height') }; }
      }
    };

    const sessionCmd = sessionCommands[command];
    if (sessionCmd) {
      const session = await requireSession(client);
      let elementRef;
      if (sessionCmd.resolve) {
        if (!rest[0]) throw new Error(`Usage: ${command} <ref|selector>`);
        elementRef = await resolveRef(client, rest[0], session.sessionId);
      }
      const response = await requestBridge(client, sessionCmd.method,
        sessionCmd.build(rest, elementRef), { sessionId: session.sessionId });
      await printSummary(response, sessionCmd.printMethod);
      return;
    }

    // Special session commands requiring custom control flow
    if (command === 'press-key') {
      const [key, refOrSelector] = rest;
      if (!key) throw new Error('Usage: press-key <key> [ref|selector]');
      const session = await requireSession(client);
      const elementRef = refOrSelector ? await resolveRef(client, refOrSelector, session.sessionId) : undefined;
      const response = await requestBridge(client, 'input.press_key', {
        key, target: elementRef ? { elementRef } : undefined
      }, { sessionId: session.sessionId });
      await printSummary(response);
      return;
    }

    if (command === 'screenshot') {
      const [refOrSelector, outputPath] = rest;
      const session = await requireSession(client);
      const elementRef = await resolveRef(client, refOrSelector, session.sessionId);
      const response = await requestBridge(client, 'screenshot.capture_element', {
        elementRef
      }, { sessionId: session.sessionId });
      if (!response.ok) { await printSummary(response); return; }
      const screenshotResult = /** @type {ScreenshotResult} */ (response.result);
      const filePath = outputPath || path.join(os.tmpdir(), `bbx-${Date.now()}.png`);
      const data = screenshotResult.image.replace(/^data:image\/png;base64,/, '');
      await fs.promises.writeFile(filePath, Buffer.from(data, 'base64'));
      printJson({
        ok: true,
        summary: `Screenshot saved to ${filePath}.`,
        evidence: { savedTo: filePath, rect: screenshotResult.rect }
      });
      return;
    }

    if (command === 'eval') {
      let expression = rest.join(' ');
      if (!expression || expression === '-') expression = await readStdin();
      if (!expression) throw new Error('Usage: eval <expression>  (or pipe via stdin: echo "expr" | bbx eval -)');
      const session = await requireSession(client);
      const response = await requestBridge(client, 'page.evaluate', {
        expression, returnByValue: true
      }, { sessionId: session.sessionId });
      await printSummary(response);
      return;
    }

    process.stderr.write(`Unknown command: ${command}\n`);
    printUsage();
    process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const raw = error instanceof Error && 'code' in error ? /** @type {any} */ (error).code : '';
    let code = 'ERROR';
    if (raw === 'ENOENT' || raw === 'ECONNREFUSED') {
      code = 'DAEMON_OFFLINE';
    } else if (raw === 'BRIDGE_TIMEOUT') {
      code = 'BRIDGE_TIMEOUT';
    } else if (/socket closed/i.test(message)) {
      code = 'CONNECTION_LOST';
    } else if (raw) {
      code = String(raw);
    }
    printJson({
      ok: false,
      summary: `${code}: ${message}`,
      evidence: null
    });
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

/**
 * @returns {Promise<void>}
 */
async function ensureClientConnection() {
  if (!client.connected) {
    await client.connect();
  }
}

/**
 * @param {import('../../protocol/src/types.js').BridgeResponse} response
 * @param {string} [method] - Optional method name for disambiguation
 * @returns {Promise<void>}
 */
async function printSummary(response, method) {
  printJson(summarizeBridgeResponse(response, method));
}

/**
 * @param {unknown} value
 * @returns {void}
 */
function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, process.stdout.isTTY ? 2 : undefined)}\n`);
}

function printUsage() {
  process.stdout.write(`Usage: bbx <command> [args]

Setup:
  bbx install [--browser chrome|edge|brave|chromium] [extension-id]
                                     Install native messaging manifest
  bbx install-skill [targets|all] [--global] [--project <path>]
                                     Install/update managed Browser Bridge skills (global by default)
  bbx install-mcp [client|all] [--local]
                                     Write MCP config for vscode|codex|cursor|claude (global by default)
  bbx status                          Check bridge connection
  bbx doctor                          Diagnose install, daemon, extension, and session readiness
  bbx logs                            Recent bridge logs
  bbx tabs                            List available tabs
  bbx tab-create [url]                Create a new tab
  bbx tab-close <tabId>               Close a tab
  bbx skill                           Runtime budget presets and method groups
  bbx mcp serve                       Start Browser Bridge as an MCP stdio server

Session:
  bbx request-access [tabId] [origin] Create session for enabled tab
  bbx session                         Show current session
  bbx revoke                          End current session

Generic RPC:
  bbx call <method> [paramsJson|-]    Call any bridge method (- reads JSON from stdin)
  bbx call <sessionId> <method> [json] Call with explicit session
  bbx batch '[{method,params},...]'   Parallel method calls

Inspect:
  bbx dom-query [selector]            Query DOM subtree
  bbx describe <ref|selector>         Describe one element
  bbx text <ref|selector> [budget]    Get element text
  bbx html <ref|selector> [maxLen]    Get element HTML
  bbx styles <ref|selector> [props]   Get computed styles
  bbx box <ref|selector>              Get box model
  bbx a11y-tree [maxNodes] [maxDepth] Get accessibility tree

Find:
  bbx find <text>                     Find elements by text content
  bbx find-role <role> [name]         Find elements by ARIA role
  bbx wait <selector> [timeoutMs]     Wait for DOM element

Page:
  bbx eval <expression>               Evaluate JS in page context (use - for stdin)
  bbx console [level]                 Get console output (log|warn|error|all)
  bbx network [limit]                 Get network requests (fetch/XHR)
  bbx page-text [textBudget]          Get full page text content
  bbx storage [local|session] [keys]  Read browser storage
  bbx navigate <url>                  Navigate to URL
  bbx perf                            Get performance metrics
  bbx scroll <top> [left]             Scroll viewport
  bbx resize <width> <height>         Resize viewport

Interact:
  bbx click <ref|selector> [button]   Click element
  bbx focus <ref|selector>            Focus element
  bbx type <ref|selector> <text...>   Type into element
  bbx press-key <key> [ref|selector]  Send key event
  bbx hover <ref|selector>            Hover over element

Patch:
  bbx patch-style <ref|sel> prop=val  Apply style patch
  bbx patch-text <ref|sel> <text...>  Apply text patch
  bbx patches                         List active patches
  bbx rollback <patchId>              Rollback a patch

Capture:
  bbx screenshot <ref|selector> [path] Capture element screenshot
`);
}

/**
 * @param {string[]} args
 * @returns {Promise<{ sessionId: string | null, method: BridgeMethod, params: Record<string, unknown> }>}
 */
async function parseCallCommand(args) {
  const [first, second, third] = args;
  if (!first) {
    throw new Error('Usage: call <method> [paramsJson] or call <sessionId|null> <method> [paramsJson]');
  }

  if (first.includes('.')) {
    const method = /** @type {BridgeMethod} */ (first);
    if (!METHODS.includes(method)) {
      throw new Error(`Unknown method "${first}". Run bbx skill to see available methods.`);
    }
    let rawParams = second;
    // Support piped stdin: `echo '{"key":"val"}' | bbx call method -`
    if (rawParams === '-') {
      rawParams = await readStdin();
    }
    return {
      method,
      sessionId: methodNeedsSession(method) ? (await requireSession(client)).sessionId : null,
      params: parseJsonObject(rawParams)
    };
  }

  if (!second) {
    throw new Error('Usage: call <sessionId|null> <method> [paramsJson]');
  }

  return {
    sessionId: first === 'null' ? null : first,
    method: /** @type {BridgeMethod} */ (second),
    params: parseJsonObject(third)
  };
}
