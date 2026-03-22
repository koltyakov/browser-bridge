#!/usr/bin/env node
// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntimeContext, METHODS } from '../../protocol/src/index.js';
import { startBridgeMcpServer } from '../../mcp-server/src/server.js';
import { BridgeClient } from './client.js';
import { methodNeedsSession, parseCommaList, parseIntArg, parseJsonObject, parsePropertyAssignments } from './cli-helpers.js';
import { installAgentFiles, parseInstallAgentArgs } from './install.js';
import { formatMcpConfig, isMcpClientName } from './mcp-config.js';
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
  const options = parseInstallAgentArgs(rest);
  const installedPaths = await installAgentFiles(options);
  for (const installedPath of installedPaths) {
    process.stdout.write(`Installed ${installedPath}\n`);
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
      process.stderr.write('Usage: bbx mcp config <claude|cursor|vscode>\n');
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

    const session = await requireSession(client);

    if (command === 'dom-query') {
      const selector = rest[0] || 'body';
      const response = await requestBridge(client, 'dom.query', { selector }, {
        sessionId: session.sessionId
      });
      await printSummary(response);
      return;
    }

    if (command === 'describe') {
      const [refOrSelector] = rest;
      if (!refOrSelector) {
        throw new Error('Usage: describe <ref|selector>');
      }
      const elementRef = await resolveRef(client, refOrSelector, session.sessionId);
      const response = await requestBridge(client, 'dom.describe', { elementRef }, {
        sessionId: session.sessionId
      });
      await printSummary(response, 'dom.describe');
      return;
    }

    if (command === 'text') {
      const [refOrSelector, textBudget] = rest;
      if (!refOrSelector) {
        throw new Error('Usage: text <ref|selector> [budget]');
      }
      const elementRef = await resolveRef(client, refOrSelector, session.sessionId);
      const response = await requestBridge(client, 'dom.get_text', {
        elementRef,
        textBudget: textBudget ? parseIntArg(textBudget, 'budget') : undefined
      }, { sessionId: session.sessionId });
      await printSummary(response, 'dom.get_text');
      return;
    }

    if (command === 'styles') {
      const [refOrSelector, propertyList] = rest;
      if (!refOrSelector) {
        throw new Error('Usage: styles <ref|selector> [prop1,prop2,...]');
      }
      const elementRef = await resolveRef(client, refOrSelector, session.sessionId);
      const response = await requestBridge(client, 'styles.get_computed', {
        elementRef,
        properties: parseCommaList(propertyList)
      }, { sessionId: session.sessionId });
      await printSummary(response, 'styles.get_computed');
      return;
    }

    if (command === 'box') {
      const [refOrSelector] = rest;
      if (!refOrSelector) {
        throw new Error('Usage: box <ref|selector>');
      }
      const elementRef = await resolveRef(client, refOrSelector, session.sessionId);
      const response = await requestBridge(client, 'layout.get_box_model', {
        elementRef
      }, { sessionId: session.sessionId });
      await printSummary(response, 'layout.get_box_model');
      return;
    }

    if (command === 'click') {
      const [refOrSelector, button] = rest;
      if (!refOrSelector) {
        throw new Error('Usage: click <ref|selector> [left|middle|right]');
      }
      const elementRef = await resolveRef(client, refOrSelector, session.sessionId);
      const response = await requestBridge(client, 'input.click', {
        target: { elementRef },
        button
      }, { sessionId: session.sessionId });
      await printSummary(response);
      return;
    }

    if (command === 'focus') {
      const [refOrSelector] = rest;
      const elementRef = await resolveRef(client, refOrSelector, session.sessionId);
      const response = await requestBridge(client, 'input.focus', {
        target: { elementRef }
      }, { sessionId: session.sessionId });
      await printSummary(response);
      return;
    }

    if (command === 'type') {
      const [refOrSelector, ...textParts] = rest;
      const elementRef = await resolveRef(client, refOrSelector, session.sessionId);
      const response = await requestBridge(client, 'input.type', {
        target: { elementRef },
        text: textParts.join(' ')
      }, { sessionId: session.sessionId });
      await printSummary(response);
      return;
    }

    if (command === 'press-key') {
      const [key, refOrSelector] = rest;
      if (!key) {
        throw new Error('Usage: press-key <key> [ref|selector]');
      }
      const elementRef = refOrSelector ? await resolveRef(client, refOrSelector, session.sessionId) : undefined;
      const response = await requestBridge(client, 'input.press_key', {
        key,
        target: elementRef
          ? { elementRef }
          : undefined
      }, { sessionId: session.sessionId });
      await printSummary(response);
      return;
    }

    if (command === 'patch-style') {
      const [refOrSelector, ...assignments] = rest;
      const elementRef = await resolveRef(client, refOrSelector, session.sessionId);
      const response = await requestBridge(client, 'patch.apply_styles', {
        target: { elementRef },
        declarations: parsePropertyAssignments(assignments)
      }, { sessionId: session.sessionId });
      await printSummary(response);
      return;
    }

    if (command === 'patch-text') {
      const [refOrSelector, ...textParts] = rest;
      const elementRef = await resolveRef(client, refOrSelector, session.sessionId);
      const response = await requestBridge(client, 'patch.apply_dom', {
        target: { elementRef },
        operation: 'set_text',
        value: textParts.join(' ')
      }, { sessionId: session.sessionId });
      await printSummary(response);
      return;
    }

    if (command === 'patches') {
      const response = await requestBridge(client, 'patch.list', {}, {
        sessionId: session.sessionId
      });
      await printSummary(response);
      return;
    }

    if (command === 'rollback') {
      const [patchId] = rest;
      if (!patchId) {
        throw new Error('Usage: rollback <patchId>');
      }
      const response = await requestBridge(client, 'patch.rollback', {
        patchId
      }, { sessionId: session.sessionId });
      await printSummary(response);
      return;
    }

    if (command === 'screenshot') {
      const [refOrSelector, outputPath] = rest;
      const elementRef = await resolveRef(client, refOrSelector, session.sessionId);
      const response = await requestBridge(client, 'screenshot.capture_element', {
        elementRef
      }, { sessionId: session.sessionId });

      if (!response.ok) {
        await printSummary(response);
        return;
      }

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
      // Support piped stdin: `echo 'expr' | bbx eval -` or `bbx eval -`
      if (!expression || expression === '-') {
        expression = await readStdin();
      }
      if (!expression) {
        throw new Error('Usage: eval <expression>  (or pipe via stdin: echo "expr" | bbx eval -)');
      }
      const response = await requestBridge(client, 'page.evaluate', {
        expression,
        returnByValue: true
      }, { sessionId: session.sessionId });
      await printSummary(response);
      return;
    }

    if (command === 'console') {
      const [level] = rest;
      const response = await requestBridge(client, 'page.get_console', {
        level: level || 'all',
        clear: false
      }, { sessionId: session.sessionId });
      await printSummary(response, 'page.get_console');
      return;
    }

    if (command === 'wait') {
      const [selector, timeoutArg] = rest;
      if (!selector) {
        throw new Error('Usage: wait <selector> [timeoutMs]');
      }
      const response = await requestBridge(client, 'dom.wait_for', {
        selector,
        timeoutMs: timeoutArg ? parseIntArg(timeoutArg, 'timeoutMs') : 5000
      }, { sessionId: session.sessionId });
      await printSummary(response);
      return;
    }

    if (command === 'find') {
      const searchText = rest.join(' ');
      if (!searchText) {
        throw new Error('Usage: find <text>');
      }
      const response = await requestBridge(client, 'dom.find_by_text', {
        text: searchText
      }, { sessionId: session.sessionId });
      await printSummary(response, 'dom.find_by_text');
      return;
    }

    if (command === 'find-role') {
      const [role, ...nameParts] = rest;
      if (!role) {
        throw new Error('Usage: find-role <role> [name]');
      }
      const response = await requestBridge(client, 'dom.find_by_role', {
        role,
        name: nameParts.join(' ') || undefined
      }, { sessionId: session.sessionId });
      await printSummary(response, 'dom.find_by_role');
      return;
    }

    if (command === 'html') {
      const [refOrSelector, maxLengthArg] = rest;
      const elementRef = await resolveRef(client, refOrSelector, session.sessionId);
      const response = await requestBridge(client, 'dom.get_html', {
        elementRef,
        maxLength: maxLengthArg ? parseIntArg(maxLengthArg, 'maxLen') : undefined
      }, { sessionId: session.sessionId });
      await printSummary(response);
      return;
    }

    if (command === 'hover') {
      const [refOrSelector] = rest;
      const elementRef = await resolveRef(client, refOrSelector, session.sessionId);
      const response = await requestBridge(client, 'input.hover', {
        target: { elementRef }
      }, { sessionId: session.sessionId });
      await printSummary(response);
      return;
    }

    if (command === 'navigate') {
      const [url] = rest;
      if (!url) {
        throw new Error('Usage: navigate <url>');
      }
      const response = await requestBridge(client, 'navigation.navigate', {
        url
      }, { sessionId: session.sessionId });
      await printSummary(response);
      return;
    }

    if (command === 'storage') {
      const [storageType, ...keys] = rest;
      const response = await requestBridge(client, 'page.get_storage', {
        type: storageType === 'session' ? 'session' : 'local',
        keys: keys.length ? keys : undefined
      }, { sessionId: session.sessionId });
      await printSummary(response);
      return;
    }

    if (command === 'page-text') {
      const [budgetArg] = rest;
      const response = await requestBridge(client, 'page.get_text', {
        textBudget: budgetArg ? parseIntArg(budgetArg, 'textBudget') : undefined
      }, { sessionId: session.sessionId });
      await printSummary(response, 'page.get_text');
      return;
    }

    if (command === 'network') {
      const [limitArg] = rest;
      const response = await requestBridge(client, 'page.get_network', {
        limit: limitArg ? parseIntArg(limitArg, 'limit') : undefined
      }, { sessionId: session.sessionId });
      await printSummary(response, 'page.get_network');
      return;
    }

    if (command === 'a11y-tree') {
      const [maxNodesArg, maxDepthArg] = rest;
      const response = await requestBridge(client, 'dom.get_accessibility_tree', {
        maxNodes: maxNodesArg ? parseIntArg(maxNodesArg, 'maxNodes') : undefined,
        maxDepth: maxDepthArg ? parseIntArg(maxDepthArg, 'maxDepth') : undefined
      }, { sessionId: session.sessionId });
      await printSummary(response);
      return;
    }

    if (command === 'perf') {
      const response = await requestBridge(client, 'performance.get_metrics', {}, {
        sessionId: session.sessionId
      });
      await printSummary(response);
      return;
    }

    if (command === 'scroll') {
      const [topArg, leftArg] = rest;
      if (!topArg && !leftArg) {
        throw new Error('Usage: scroll <top> [left]');
      }
      const response = await requestBridge(client, 'viewport.scroll', {
        top: topArg ? parseIntArg(topArg, 'top') : undefined,
        left: leftArg ? parseIntArg(leftArg, 'left') : undefined
      }, { sessionId: session.sessionId });
      await printSummary(response);
      return;
    }

    if (command === 'resize') {
      const [widthArg, heightArg] = rest;
      if (!widthArg || !heightArg) {
        throw new Error('Usage: resize <width> <height>');
      }
      const response = await requestBridge(client, 'viewport.resize', {
        width: parseIntArg(widthArg, 'width'),
        height: parseIntArg(heightArg, 'height')
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
  bbx install-skill [targets|all] [--project <path>]
                                     Install/update managed Browser Bridge skills in a repo
  bbx status                          Check bridge connection
  bbx doctor                          Diagnose install, daemon, extension, and session readiness
  bbx logs                            Recent bridge logs
  bbx tabs                            List available tabs
  bbx tab-create [url]                Create a new tab
  bbx tab-close <tabId>               Close a tab
  bbx skill                           Runtime budget presets and method groups
  bbx mcp serve                       Start Browser Bridge as an MCP stdio server
  bbx mcp config <client>             Print MCP config for claude|cursor|vscode

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
