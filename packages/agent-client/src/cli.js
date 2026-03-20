#!/usr/bin/env node
// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntimeContext } from '../../protocol/src/index.js';
import { BridgeClient } from './client.js';
import { methodNeedsSession, parseCommaList, parseJsonObject, parsePropertyAssignments } from './cli-helpers.js';
import { clearSession, loadSession, saveSession } from './session-store.js';
import { summarizeBridgeResponse } from './subagent.js';

/** @typedef {import('../../protocol/src/types.js').SessionState} SessionState */
/** @typedef {import('../../protocol/src/types.js').BridgeMethod} BridgeMethod */
/** @typedef {{ image: string, rect: Record<string, unknown> }} ScreenshotResult */

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
      /** @type {unknown[]} */
      const results = [];
      for (const call of calls) {
        try {
          const response = await client.request({
            method: /** @type {BridgeMethod} */ (call.method),
            sessionId: methodNeedsSession(call.method) ? session?.sessionId ?? null : null,
            params: call.params || {}
          });
          results.push(summarizeBridgeResponse(response));
        } catch (err) {
          results.push({ ok: false, summary: `${call.method}: ${err.message}`, evidence: null });
        }
      }
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
      const elementRef = rest[0];
      const response = await client.request({
        method: 'dom.describe',
        sessionId: session.sessionId,
        params: {
          elementRef
        }
      });
      printJson(response.ok ? response.result : response);
      return;
    }

    if (command === 'text') {
      const [elementRef, textBudget] = rest;
      const response = await client.request({
        method: 'dom.get_text',
        sessionId: session.sessionId,
        params: {
          elementRef,
          textBudget: textBudget ? Number(textBudget) : undefined
        }
      });
      printJson(response.ok ? response.result : response);
      return;
    }

    if (command === 'styles') {
      const [elementRef, propertyList] = rest;
      const response = await client.request({
        method: 'styles.get_computed',
        sessionId: session.sessionId,
        params: {
          elementRef,
          properties: parseCommaList(propertyList)
        }
      });
      printJson(response.ok ? response.result : response);
      return;
    }

    if (command === 'box') {
      const [elementRef] = rest;
      const response = await client.request({
        method: 'layout.get_box_model',
        sessionId: session.sessionId,
        params: {
          elementRef
        }
      });
      printJson(response.ok ? response.result : response);
      return;
    }

    if (command === 'click') {
      const [elementRef, button] = rest;
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
      printJson(response.ok ? response.result : response);
      return;
    }

    if (command === 'focus') {
      const [elementRef] = rest;
      const response = await client.request({
        method: 'input.focus',
        sessionId: session.sessionId,
        params: {
          target: {
            elementRef
          }
        }
      });
      printJson(response.ok ? response.result : response);
      return;
    }

    if (command === 'type') {
      const [elementRef, ...textParts] = rest;
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
      printJson(response.ok ? response.result : response);
      return;
    }

    if (command === 'press-key') {
      const [key, elementRef] = rest;
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
      printJson(response.ok ? response.result : response);
      return;
    }

    if (command === 'patch-style') {
      const [elementRef, ...assignments] = rest;
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
      const [elementRef, ...textParts] = rest;
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
      printJson(response.ok ? response.result : response);
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
      printJson(response.ok ? response.result : response);
      return;
    }

    if (command === 'screenshot') {
      const [elementRef, outputPath] = rest;
      const response = await client.request({
        method: 'screenshot.capture_element',
        sessionId: session.sessionId,
        params: {
          elementRef
        }
      });

      if (!response.ok) {
        printJson(response);
        return;
      }

      const screenshotResult = /** @type {ScreenshotResult} */ (response.result);
      const filePath = outputPath || path.join(os.tmpdir(), `browser-bridge-${Date.now()}.png`);
      const data = screenshotResult.image.replace(/^data:image\/png;base64,/, '');
      await fs.promises.writeFile(filePath, Buffer.from(data, 'base64'));
      printJson({
        savedTo: filePath,
        rect: screenshotResult.rect
      });
      return;
    }

    process.stderr.write(`Unknown command: ${command}\n`);
    printUsage();
    process.exitCode = 1;
  } catch (error) {
    printJson({
      ok: false,
      summary: `Bridge unavailable: ${error.code ?? 'ERROR'}`,
      evidence: error.message
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
 * @param {import('../../protocol/src/types.js').BridgeResponse} response
 * @returns {Promise<void>}
 */
async function printSummary(response) {
  printJson(summarizeBridgeResponse(response));
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
  bb status                          Check bridge connection
  bb logs                            Recent bridge logs
  bb tabs                            List available tabs
  bb skill                           Runtime budget presets and method groups

Session:
  bb request-access [tabId] [origin] Create session for enabled tab
  bb session                         Show current session
  bb revoke                          End current session

Generic RPC:
  bb call <method> [paramsJson]      Call any bridge method
  bb call <sessionId> <method> [json] Call with explicit session
  bb batch '[{method,params},...]'   Parallel method calls

Inspect:
  bb dom-query [selector]            Query DOM subtree
  bb describe <elementRef>           Describe one element
  bb text <elementRef> [textBudget]  Get element text
  bb styles <ref> [prop1,prop2]      Get computed styles
  bb box <elementRef>                Get box model

Interact:
  bb click <elementRef> [button]     Click element
  bb focus <elementRef>              Focus element
  bb type <elementRef> <text...>     Type into element
  bb press-key <key> [elementRef]    Send key event

Patch:
  bb patch-style <ref> prop=val...   Apply style patch
  bb patch-text <ref> <text...>      Apply text patch
  bb patches                         List active patches
  bb rollback <patchId>              Rollback a patch

Capture:
  bb screenshot <ref> [outputPath]   Capture element screenshot
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
    return {
      method,
      sessionId: methodNeedsSession(method) ? (await requireSession()).sessionId : null,
      params: parseJsonObject(second)
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
