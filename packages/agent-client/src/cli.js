#!/usr/bin/env node
// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntimeContext, METHODS } from '../../protocol/src/index.js';
import { BridgeClient } from './client.js';
import { methodNeedsSession, parseCommaList, parseJsonObject, parsePropertyAssignments } from './cli-helpers.js';
import { installAgentFiles, parseInstallAgentArgs } from './install.js';
import { clearSession, loadSession, saveSession } from './session-store.js';
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

const client = new BridgeClient();

await main();

async function main() {
  try {
    await client.connect();

    if (command === 'status') {
      await printSummary(await client.request({ method: 'health.ping' }));
      return;
    }

    if (command === 'logs') {
      await printSummary(await client.request({ method: 'log.tail' }));
      return;
    }

    if (command === 'tabs') {
      await printSummary(await client.request({ method: 'tabs.list' }));
      return;
    }

    if (command === 'tab-create') {
      const [url] = rest;
      const response = await client.request({
        method: 'tabs.create',
        params: { url: url || undefined }
      });
      await printSummary(response);
      return;
    }

    if (command === 'tab-close') {
      const [tabId] = rest;
      if (!tabId) {
        throw new Error('Usage: tab-close <tabId>');
      }
      const response = await client.request({
        method: 'tabs.close',
        params: { tabId: Number(tabId) }
      });
      await printSummary(response);
      return;
    }

    if (command === 'call') {
      const { sessionId, method, params } = await parseCallCommand(rest);
      const response = await client.request({
        method,
        sessionId,
        params
      });
      printJson(response.ok ? response.result : response);
      return;
    }

    if (command === 'batch') {
      const input = rest[0];
      if (!input) {
        throw new Error('Usage: batch \'[{"method":"...","params":{...}}, ...]\'');
      }
      const calls = JSON.parse(input);
      if (!Array.isArray(calls)) {
        throw new Error('Batch input must be a JSON array.');
      }
      const needsSession = calls.some((c) => methodNeedsSession(c.method));
      const session = needsSession ? await requireSession() : null;
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
      const response = await client.request({
        method: 'session.request_access',
        params: {
          tabId: Number.isFinite(parsedTabId) && parsedTabId > 0 ? parsedTabId : undefined,
          origin: Number.isFinite(parsedTabId) && parsedTabId > 0 ? originArg : (tabIdOrOrigin || undefined)
        }
      });
      if (response.ok) {
        await saveSession(/** @type {SessionState} */ (response.result));
      }
      await printSummary(response);
      return;
    }

    if (command === 'session') {
      const session = await requireSession();
      printJson(session);
      return;
    }

    if (command === 'revoke') {
      const session = await requireSession();
      const response = await client.request({
        method: 'session.revoke',
        sessionId: session.sessionId
      });
      if (response.ok) {
        await clearSession();
      }
      await printSummary(response);
      return;
    }

    const session = await requireSession();

    if (command === 'dom-query') {
      const selector = rest[0] || 'body';
      const response = await client.request({
        method: 'dom.query',
        sessionId: session.sessionId,
        params: {
          selector
        }
      });
      await printSummary(response);
      return;
    }

    if (command === 'describe') {
      const elementRef = await resolveRef(rest[0], session.sessionId);
      const response = await client.request({
        method: 'dom.describe',
        sessionId: session.sessionId,
        params: {
          elementRef
        }
      });
      await printSummary(response, 'dom.describe');
      return;
    }

    if (command === 'text') {
      const [refOrSelector, textBudget] = rest;
      const elementRef = await resolveRef(refOrSelector, session.sessionId);
      const response = await client.request({
        method: 'dom.get_text',
        sessionId: session.sessionId,
        params: {
          elementRef,
          textBudget: textBudget ? Number(textBudget) : undefined
        }
      });
      await printSummary(response, 'dom.get_text');
      return;
    }

    if (command === 'styles') {
      const [refOrSelector, propertyList] = rest;
      const elementRef = await resolveRef(refOrSelector, session.sessionId);
      const response = await client.request({
        method: 'styles.get_computed',
        sessionId: session.sessionId,
        params: {
          elementRef,
          properties: parseCommaList(propertyList)
        }
      });
      await printSummary(response, 'styles.get_computed');
      return;
    }

    if (command === 'box') {
      const [refOrSelector] = rest;
      const elementRef = await resolveRef(refOrSelector, session.sessionId);
      const response = await client.request({
        method: 'layout.get_box_model',
        sessionId: session.sessionId,
        params: {
          elementRef
        }
      });
      await printSummary(response, 'layout.get_box_model');
      return;
    }

    if (command === 'click') {
      const [refOrSelector, button] = rest;
      const elementRef = await resolveRef(refOrSelector, session.sessionId);
      const response = await client.request({
        method: 'input.click',
        sessionId: session.sessionId,
        params: {
          target: {
            elementRef
          },
          button
        }
      });
      await printSummary(response);
      return;
    }

    if (command === 'focus') {
      const [refOrSelector] = rest;
      const elementRef = await resolveRef(refOrSelector, session.sessionId);
      const response = await client.request({
        method: 'input.focus',
        sessionId: session.sessionId,
        params: {
          target: {
            elementRef
          }
        }
      });
      await printSummary(response);
      return;
    }

    if (command === 'type') {
      const [refOrSelector, ...textParts] = rest;
      const elementRef = await resolveRef(refOrSelector, session.sessionId);
      const response = await client.request({
        method: 'input.type',
        sessionId: session.sessionId,
        params: {
          target: {
            elementRef
          },
          text: textParts.join(' ')
        }
      });
      await printSummary(response);
      return;
    }

    if (command === 'press-key') {
      const [key, refOrSelector] = rest;
      const elementRef = refOrSelector ? await resolveRef(refOrSelector, session.sessionId) : undefined;
      const response = await client.request({
        method: 'input.press_key',
        sessionId: session.sessionId,
        params: {
          key,
          target: elementRef
            ? {
              elementRef
            }
            : undefined
        }
      });
      await printSummary(response);
      return;
    }

    if (command === 'patch-style') {
      const [refOrSelector, ...assignments] = rest;
      const elementRef = await resolveRef(refOrSelector, session.sessionId);
      const response = await client.request({
        method: 'patch.apply_styles',
        sessionId: session.sessionId,
        params: {
          target: { elementRef },
          declarations: parsePropertyAssignments(assignments)
        }
      });
      await printSummary(response);
      return;
    }

    if (command === 'patch-text') {
      const [refOrSelector, ...textParts] = rest;
      const elementRef = await resolveRef(refOrSelector, session.sessionId);
      const response = await client.request({
        method: 'patch.apply_dom',
        sessionId: session.sessionId,
        params: {
          target: { elementRef },
          operation: 'set_text',
          value: textParts.join(' ')
        }
      });
      await printSummary(response);
      return;
    }

    if (command === 'patches') {
      const response = await client.request({
        method: 'patch.list',
        sessionId: session.sessionId
      });
      await printSummary(response);
      return;
    }

    if (command === 'rollback') {
      const [patchId] = rest;
      const response = await client.request({
        method: 'patch.rollback',
        sessionId: session.sessionId,
        params: {
          patchId
        }
      });
      await printSummary(response);
      return;
    }

    if (command === 'screenshot') {
      const [refOrSelector, outputPath] = rest;
      const elementRef = await resolveRef(refOrSelector, session.sessionId);
      const response = await client.request({
        method: 'screenshot.capture_element',
        sessionId: session.sessionId,
        params: {
          elementRef
        }
      });

      if (!response.ok) {
        await printSummary(response);
        return;
      }

      const screenshotResult = /** @type {ScreenshotResult} */ (response.result);
      const filePath = outputPath || path.join(os.tmpdir(), `browser-bridge-${Date.now()}.png`);
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
      // Support piped stdin: `echo 'expr' | bb eval -` or `bb eval -`
      if (!expression || expression === '-') {
        expression = await readStdin();
      }
      if (!expression) {
        throw new Error('Usage: eval <expression>  (or pipe via stdin: echo "expr" | bb eval -)');
      }
      const response = await client.request({
        method: 'page.evaluate',
        sessionId: session.sessionId,
        params: { expression, returnByValue: true }
      });
      await printSummary(response);
      return;
    }

    if (command === 'console') {
      const [level] = rest;
      const response = await client.request({
        method: 'page.get_console',
        sessionId: session.sessionId,
        params: { level: level || 'all', clear: false }
      });
      await printSummary(response, 'page.get_console');
      return;
    }

    if (command === 'wait') {
      const [selector, timeoutArg] = rest;
      if (!selector) {
        throw new Error('Usage: wait <selector> [timeoutMs]');
      }
      const response = await client.request({
        method: 'dom.wait_for',
        sessionId: session.sessionId,
        params: {
          selector,
          timeoutMs: timeoutArg ? Number(timeoutArg) : 5000
        }
      });
      await printSummary(response);
      return;
    }

    if (command === 'find') {
      const searchText = rest.join(' ');
      if (!searchText) {
        throw new Error('Usage: find <text>');
      }
      const response = await client.request({
        method: 'dom.find_by_text',
        sessionId: session.sessionId,
        params: { text: searchText }
      });
      await printSummary(response, 'dom.find_by_text');
      return;
    }

    if (command === 'find-role') {
      const [role, ...nameParts] = rest;
      if (!role) {
        throw new Error('Usage: find-role <role> [name]');
      }
      const response = await client.request({
        method: 'dom.find_by_role',
        sessionId: session.sessionId,
        params: { role, name: nameParts.join(' ') || undefined }
      });
      await printSummary(response, 'dom.find_by_role');
      return;
    }

    if (command === 'html') {
      const [refOrSelector, maxLengthArg] = rest;
      const elementRef = await resolveRef(refOrSelector, session.sessionId);
      const response = await client.request({
        method: 'dom.get_html',
        sessionId: session.sessionId,
        params: {
          elementRef,
          maxLength: maxLengthArg ? Number(maxLengthArg) : undefined
        }
      });
      await printSummary(response);
      return;
    }

    if (command === 'hover') {
      const [refOrSelector] = rest;
      const elementRef = await resolveRef(refOrSelector, session.sessionId);
      const response = await client.request({
        method: 'input.hover',
        sessionId: session.sessionId,
        params: {
          target: { elementRef }
        }
      });
      await printSummary(response);
      return;
    }

    if (command === 'navigate') {
      const [url] = rest;
      if (!url) {
        throw new Error('Usage: navigate <url>');
      }
      const response = await client.request({
        method: 'navigation.navigate',
        sessionId: session.sessionId,
        params: { url }
      });
      await printSummary(response);
      return;
    }

    if (command === 'storage') {
      const [storageType, ...keys] = rest;
      const response = await client.request({
        method: 'page.get_storage',
        sessionId: session.sessionId,
        params: {
          type: storageType === 'session' ? 'session' : 'local',
          keys: keys.length ? keys : undefined
        }
      });
      await printSummary(response);
      return;
    }

    if (command === 'page-text') {
      const [budgetArg] = rest;
      const response = await client.request({
        method: 'page.get_text',
        sessionId: session.sessionId,
        params: { textBudget: budgetArg ? Number(budgetArg) : undefined }
      });
      await printSummary(response, 'page.get_text');
      return;
    }

    if (command === 'network') {
      const [limitArg] = rest;
      const response = await client.request({
        method: 'page.get_network',
        sessionId: session.sessionId,
        params: { limit: limitArg ? Number(limitArg) : undefined }
      });
      await printSummary(response, 'page.get_network');
      return;
    }

    if (command === 'a11y-tree') {
      const [maxNodesArg, maxDepthArg] = rest;
      const response = await client.request({
        method: 'dom.get_accessibility_tree',
        sessionId: session.sessionId,
        params: {
          maxNodes: maxNodesArg ? Number(maxNodesArg) : undefined,
          maxDepth: maxDepthArg ? Number(maxDepthArg) : undefined
        }
      });
      await printSummary(response);
      return;
    }

    if (command === 'perf') {
      const response = await client.request({
        method: 'performance.get_metrics',
        sessionId: session.sessionId
      });
      await printSummary(response);
      return;
    }

    if (command === 'resize') {
      const [widthArg, heightArg] = rest;
      if (!widthArg || !heightArg) {
        throw new Error('Usage: resize <width> <height>');
      }
      const response = await client.request({
        method: 'viewport.resize',
        sessionId: session.sessionId,
        params: {
          width: Number(widthArg),
          height: Number(heightArg)
        }
      });
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
 * @returns {Promise<SessionState>}
 */
async function requireSession() {
  const session = await loadSession();
  if (!session?.sessionId) {
    throw new Error('No active saved session. Enable agent communication for the tab in the extension and run `request-access` first.');
  }

  const status = await client.request({
    method: 'session.get_status',
    sessionId: session.sessionId
  });
  if (status.ok) {
    const activeSession = /** @type {SessionState} */ (status.result);
    await saveSession(activeSession);
    return activeSession;
  }

  if (status.error.code !== 'SESSION_EXPIRED') {
    throw new Error(status.error.message);
  }

  const refreshed = await client.request({
    method: 'session.request_access',
    params: {
      tabId: session.tabId,
      origin: session.origin
    }
  });
  if (!refreshed.ok) {
    throw new Error(refreshed.error.message);
  }

  const renewedSession = /** @type {SessionState} */ (refreshed.result);
  await saveSession(renewedSession);
  return renewedSession;
}

/**
 * Resolve an argument that may be a CSS selector or an element reference.
 * If the argument starts with `el_`, it is treated as an element reference.
 * Otherwise, it is treated as a CSS selector and resolved via dom.query.
 *
 * @param {string} refOrSelector
 * @param {string} sessionId
 * @returns {Promise<string>}
 */
async function resolveRef(refOrSelector, sessionId) {
  if (refOrSelector.startsWith('el_')) {
    return refOrSelector;
  }
  const response = await client.request({
    method: 'dom.query',
    sessionId,
    params: { selector: refOrSelector }
  });
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  const result = /** @type {{ nodes: Array<{ elementRef: string }> }} */ (response.result);
  if (!result.nodes || result.nodes.length === 0) {
    throw new Error(`No element found for selector "${refOrSelector}".`);
  }
  return result.nodes[0].elementRef;
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
  process.stdout.write(`Usage: bb <command> [args]

Setup:
  bb install [extension-id]          Install native messaging manifest
  bb install-skill [targets|all] [--project <path>]
                                     Install/update Browser Bridge skill files in a repo
  bb status                          Check bridge connection
  bb logs                            Recent bridge logs
  bb tabs                            List available tabs
  bb tab-create [url]                Create a new tab
  bb tab-close <tabId>               Close a tab
  bb skill                           Runtime budget presets and method groups

Session:
  bb request-access [tabId] [origin] Create session for enabled tab
  bb session                         Show current session
  bb revoke                          End current session

Generic RPC:
  bb call <method> [paramsJson|-]    Call any bridge method (- reads JSON from stdin)
  bb call <sessionId> <method> [json] Call with explicit session
  bb batch '[{method,params},...]'   Parallel method calls

Inspect:
  bb dom-query [selector]            Query DOM subtree
  bb describe <ref|selector>         Describe one element
  bb text <ref|selector> [budget]    Get element text
  bb html <ref|selector> [maxLen]    Get element HTML
  bb styles <ref|selector> [props]   Get computed styles
  bb box <ref|selector>              Get box model
  bb a11y-tree [maxNodes] [maxDepth] Get accessibility tree

Find:
  bb find <text>                     Find elements by text content
  bb find-role <role> [name]         Find elements by ARIA role
  bb wait <selector> [timeoutMs]     Wait for DOM element

Page:
  bb eval <expression>               Evaluate JS in page context (use - for stdin)
  bb console [level]                 Get console output (log|warn|error|all)
  bb network [limit]                 Get network requests (fetch/XHR)
  bb page-text [textBudget]          Get full page text content
  bb storage [local|session] [keys]  Read browser storage
  bb navigate <url>                  Navigate to URL
  bb perf                            Get performance metrics
  bb resize <width> <height>         Resize viewport

Interact:
  bb click <ref|selector> [button]   Click element
  bb focus <ref|selector>            Focus element
  bb type <ref|selector> <text...>   Type into element
  bb press-key <key> [ref|selector]  Send key event
  bb hover <ref|selector>            Hover over element

Patch:
  bb patch-style <ref|sel> prop=val  Apply style patch
  bb patch-text <ref|sel> <text...>  Apply text patch
  bb patches                         List active patches
  bb rollback <patchId>              Rollback a patch

Capture:
  bb screenshot <ref|selector> [path] Capture element screenshot
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
      throw new Error(`Unknown method "${first}". Run bb skill to see available methods.`);
    }
    let rawParams = second;
    // Support piped stdin: `echo '{"key":"val"}' | bb call method -`
    if (rawParams === '-') {
      rawParams = await readStdin();
    }
    return {
      method,
      sessionId: methodNeedsSession(method) ? (await requireSession()).sessionId : null,
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
