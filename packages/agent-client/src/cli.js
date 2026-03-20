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
  process.stdout.write(`${JSON.stringify(createRuntimeContext(), null, 2)}\n`);
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
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printUsage() {
  process.stdout.write(`Usage:
  node packages/agent-client/src/cli.js status
  node packages/agent-client/src/cli.js tabs
  node packages/agent-client/src/cli.js call <method> [paramsJson]
  node packages/agent-client/src/cli.js call <sessionId|null> <method> [paramsJson]
  # The target tab must already be enabled in the extension UI.
  node packages/agent-client/src/cli.js request-access [tabId] [origin]
  node packages/agent-client/src/cli.js request-access [origin]
  node packages/agent-client/src/cli.js session
  node packages/agent-client/src/cli.js dom-query [selector]
  node packages/agent-client/src/cli.js describe <elementRef>
  node packages/agent-client/src/cli.js text <elementRef> [textBudget]
  node packages/agent-client/src/cli.js styles <elementRef> [prop1,prop2]
  node packages/agent-client/src/cli.js box <elementRef>
  node packages/agent-client/src/cli.js click <elementRef> [left|middle|right]
  node packages/agent-client/src/cli.js focus <elementRef>
  node packages/agent-client/src/cli.js type <elementRef> <text...>
  node packages/agent-client/src/cli.js press-key <key> [elementRef]
  node packages/agent-client/src/cli.js patch-style <elementRef> prop=value [prop=value...]
  node packages/agent-client/src/cli.js patch-text <elementRef> <text...>
  node packages/agent-client/src/cli.js patches
  node packages/agent-client/src/cli.js rollback <patchId>
  node packages/agent-client/src/cli.js screenshot <elementRef> [outputPath]
  node packages/agent-client/src/cli.js revoke
  node packages/agent-client/src/cli.js skill
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
