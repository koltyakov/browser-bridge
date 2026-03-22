#!/usr/bin/env node
// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntimeContext, METHODS } from '../../protocol/src/index.js';
import { startBridgeMcpServer } from '../../mcp-server/src/server.js';
import { BridgeClient } from './client.js';
import { CLI_HELP_SECTIONS, SESSION_COMMANDS } from './command-registry.js';
import { interactiveCheckbox, methodNeedsSession, parseIntArg, parseJsonObject } from './cli-helpers.js';
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

    const sessionCmd = SESSION_COMMANDS[command];
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
  const blocks = ['Usage: bbx <command> [args]'];
  for (const section of CLI_HELP_SECTIONS) {
    blocks.push('', `${section.title}:`);
    blocks.push(...section.lines.map((line) => `  ${line}`));
  }
  process.stdout.write(`${blocks.join('\n')}\n`);
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
