#!/usr/bin/env node
// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyWindowsTcpTransportDefaults } from '../../native-host/src/config.js';
import { restartBridgeDaemon } from '../../native-host/src/daemon-process.js';
import { createRuntimeContext, METHODS } from '../../protocol/src/index.js';
import {
  restartRegisteredMcpProcesses,
  tryStartMcpProcessControl,
} from '../../mcp-server/src/lifecycle.js';
import { startBridgeMcpServer } from '../../mcp-server/src/server.js';
import {
  extractRemoteFlag,
  extractTabFlag,
  parseCallCommand,
  parseInterceptAddArgs,
  readStdin,
} from './cli-args.js';
import { runBatchCalls } from './cli-batch.js';
import { parseIntArg } from './cli-helpers.js';
import { printCallResponse, printJson, printSummary, printUsage } from './cli-output.js';
import { handleProxyCommand, handleRemoteCommand } from './cli-proxy-remote.js';
import {
  runInstallMcpCommand,
  runInstallSkillCommand,
  uninstallBrowserBridge,
} from './cli-setup-commands.js';
import { SHORTCUT_COMMANDS } from './command-registry.js';
import { formatMcpConfig, isMcpClientName, MCP_CLIENT_NAMES } from './mcp-config.js';
import { getDoctorReport, requestBridge, resolveRef } from './runtime.js';
import { createBridgeClientForDestination } from './remotes.js';

/** @typedef {import('./types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('./types.js').ScreenshotResult} ScreenshotResult */

const REQUEST_SOURCE = 'cli';
const TEST_TIMEOUT_ENV = 'BBX_CLIENT_REQUEST_TIMEOUT_MS';
const REMOTE_ENV = 'BBX_REMOTE';

/**
 * Commands that only make sense against the local machine (setup, daemon
 * lifecycle, and config management). The explicit --remote flag is rejected
 * for these; the ambient BBX_REMOTE env var is ignored.
 *
 * @type {ReadonlySet<string>}
 */
const LOCAL_ONLY_COMMANDS = new Set([
  'help',
  '--help',
  '-h',
  '--version',
  '-v',
  'skill',
  'install',
  'uninstall',
  'install-skill',
  'install-mcp',
  'mcp',
  'proxy',
  'remote',
  'doctor',
  'restart',
]);

const remoteFlag = extractRemoteFlag(process.argv.slice(2));
const [command, ...rest] = remoteFlag.rest;

if (remoteFlag.explicit && command && LOCAL_ONLY_COMMANDS.has(command)) {
  process.stderr.write(`The --remote flag is not supported with "${command}".\n`);
  process.exit(1);
}

const remoteDestinationId =
  command && LOCAL_ONLY_COMMANDS.has(command)
    ? null
    : (remoteFlag.remoteId ?? process.env[REMOTE_ENV] ?? null);

if (!command || ['help', '--help', '-h'].includes(command)) {
  printUsage();
  process.exit(0);
}

if (['--version', '-v'].includes(command)) {
  const pkgPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../package.json'
  );
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

if (command === 'skill') {
  process.stdout.write(
    `${JSON.stringify(createRuntimeContext(), null, process.stdout.isTTY ? 2 : undefined)}\n`
  );
  process.exit(0);
}

if (command === 'install') {
  const { execFileSync } = await import('node:child_process');
  const installScript = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../native-host/bin/install-manifest.js'
  );
  execFileSync(process.execPath, [installScript, ...rest], {
    stdio: 'inherit',
  });
  process.exit(0);
}

if (command === 'uninstall') {
  if (rest.length > 0) {
    process.stderr.write('Usage: bbx uninstall\n');
    process.exit(1);
  }

  await uninstallBrowserBridge();
  process.exit(0);
}

if (command === 'install-skill') {
  await runInstallSkillCommand(rest);
}

if (command === 'install-mcp') {
  await runInstallMcpCommand(rest);
}

if (command === 'mcp') {
  const [subcommand, clientName] = rest;
  if (subcommand === 'serve') {
    const control = await tryStartMcpProcessControl();
    try {
      await startBridgeMcpServer();
    } catch (error) {
      await control?.dispose();
      throw error;
    }
    await new Promise(() => {});
  }
  if (subcommand === 'config') {
    if (!clientName || !isMcpClientName(clientName)) {
      process.stderr.write(`Usage: bbx mcp config <${MCP_CLIENT_NAMES.join('|')}>\n`);
      process.exit(1);
    }
    process.stdout.write(formatMcpConfig(clientName));
    process.exit(0);
  }
  process.stderr.write('Usage: bbx mcp <serve|config>\n');
  process.exit(1);
}

if (command === 'proxy') {
  await runLocalCommand(() => handleProxyCommand(rest));
  process.exit();
}

if (command === 'remote') {
  await runLocalCommand(() => handleRemoteCommand(rest));
  process.exit();
}

const clientTimeoutMs = getClientTimeoutOverride();
applyWindowsTcpTransportDefaults();
const client = await createCliClient();

await main();

/**
 * Run a local (pre-main) command, converting thrown errors into a friendly
 * one-line message instead of an unhandled stack trace.
 *
 * @param {() => Promise<void>} run
 * @returns {Promise<void>}
 */
async function runLocalCommand(run) {
  try {
    await run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

/**
 * Create the bridge client for this invocation, honoring the --remote flag
 * and BBX_REMOTE env var. Exits with a friendly error when the destination
 * is not configured.
 *
 * @returns {Promise<import('./client.js').BridgeClient>}
 */
async function createCliClient() {
  try {
    return await createBridgeClientForDestination(
      remoteDestinationId,
      clientTimeoutMs ? { defaultTimeoutMs: clientTimeoutMs } : {}
    );
  } catch (error) {
    printJson({
      ok: false,
      summary: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
      evidence: null,
    });
    process.exit(1);
  }
}

async function main() {
  try {
    if (command === 'status') {
      const healthResponse = await requestBridge(
        client,
        'health.ping',
        {},
        { source: REQUEST_SOURCE }
      );
      await printSummary(healthResponse);
      return;
    }

    if (command === 'access-request') {
      await printSummary(
        await requestBridge(client, 'access.request', {}, { source: REQUEST_SOURCE })
      );
      return;
    }

    if (command === 'doctor') {
      const report = await getDoctorReport();
      if (report.issues.length > 0) {
        process.exitCode = 1;
      }
      printJson({
        ok: report.issues.length === 0,
        summary:
          report.issues.length === 0
            ? 'Browser Bridge is ready.'
            : `Browser Bridge has ${report.issues.length} readiness issue(s).`,
        evidence: report,
      });
      return;
    }

    if (command === 'restart') {
      const result = await restartBridgeDaemon();
      const mcpProcesses = await restartRegisteredMcpProcesses();
      if (mcpProcesses.restartFailed > 0) {
        process.exitCode = 1;
      }
      printJson({
        ok: mcpProcesses.restartFailed === 0,
        summary: `${
          result.previouslyRunning
            ? 'Browser Bridge daemon restarted.'
            : 'Browser Bridge daemon started.'
        }${
          mcpProcesses.restartRequested > 0
            ? ` Restart requested for ${mcpProcesses.restartRequested} MCP server(s).`
            : ''
        }${
          mcpProcesses.restartFailed > 0
            ? ` Could not contact ${mcpProcesses.restartFailed} MCP server(s).`
            : ''
        }`,
        evidence: { ...result, mcpProcesses },
      });
      return;
    }

    if (command === 'logs') {
      await printSummary(await requestBridge(client, 'log.tail', {}, { source: REQUEST_SOURCE }));
      return;
    }

    if (command === 'tabs') {
      await printSummary(await requestBridge(client, 'tabs.list', {}, { source: REQUEST_SOURCE }));
      return;
    }

    if (command === 'tab-create') {
      const [url] = rest;
      const response = await requestBridge(
        client,
        'tabs.create',
        {
          url: url || undefined,
        },
        { source: REQUEST_SOURCE }
      );
      await printSummary(response);
      return;
    }

    if (command === 'tab-close') {
      const [tabId] = rest;
      if (!tabId) {
        throw new Error('Usage: tab-close <tabId>');
      }
      const response = await requestBridge(
        client,
        'tabs.close',
        {
          tabId: parseIntArg(tabId, 'tabId'),
        },
        { source: REQUEST_SOURCE }
      );
      await printSummary(response);
      return;
    }

    if (command === 'tab-activate') {
      const [tabId] = rest;
      if (!tabId) {
        throw new Error('Usage: tab-activate <tabId>');
      }
      const response = await requestBridge(
        client,
        'tabs.activate',
        {
          tabId: parseIntArg(tabId, 'tabId'),
        },
        { source: REQUEST_SOURCE }
      );
      await printSummary(response);
      return;
    }

    if (command === 'call') {
      const { tabId, method, params } = await parseCallCommand(rest);
      const response = await requestBridge(client, method, params, {
        tabId,
        source: REQUEST_SOURCE,
      });
      printCallResponse(response);
      return;
    }

    if (command === 'batch') {
      const results = await runBatchCalls(client, rest[0], REQUEST_SOURCE);
      if (results.some((result) => !result.ok)) {
        process.exitCode = 1;
      }
      printJson(results);
      return;
    }

    if (command.includes('.') && METHODS.includes(/** @type {BridgeMethod} */ (command))) {
      const { tabId, method, params } = await parseCallCommand([command, ...rest]);
      const response = await requestBridge(client, method, params, {
        tabId,
        source: REQUEST_SOURCE,
      });
      printCallResponse(response);
      return;
    }

    const shortcutCmd = SHORTCUT_COMMANDS[command];
    if (shortcutCmd) {
      // Allow `bbx <shortcut> --tab <id> ...` to target a specific tab.
      // Without this, --tab gets eaten as a positional argument and the
      // request hits whatever tab the bridge route happens to be pointing
      // at (typically the active tab). For element-resolving shortcuts
      // the ref must be resolved against the SAME tab the action targets,
      // so we pass tabId to both resolveRef and the subsequent request.
      const { tabId, rest: shortcutArgs } = extractTabFlag(rest);
      const selectorInput = shortcutCmd.resolve ? shortcutArgs[0] : null;
      if (shortcutCmd.resolve && !selectorInput) {
        throw new Error(`Usage: ${command} <ref|selector>`);
      }

      // Retry-on-stale: if the action fails with ELEMENT_STALE and the
      // original input was a selector (not an el_xxx ref), re-resolve the
      // selector and retry once. This handles the common case where the
      // agent resolved an element, then the page re-rendered (React
      // reconciliation, SPA navigation) before the action was dispatched.
      const canRetry = typeof selectorInput === 'string' && !selectorInput.startsWith('el_');
      const maxAttempts = canRetry ? 2 : 1;
      /** @type {import('./runtime.js').BridgeResponse | undefined} */
      let response;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let elementRef;
        if (shortcutCmd.resolve && selectorInput) {
          elementRef = await resolveRef(client, selectorInput, tabId, REQUEST_SOURCE);
        }
        response = await requestBridge(
          client,
          shortcutCmd.method,
          shortcutCmd.build(shortcutArgs, elementRef),
          { source: REQUEST_SOURCE, tabId }
        );
        const isStale = !response.ok && response.error?.code === 'ELEMENT_STALE';
        if (isStale && attempt < maxAttempts) {
          process.stderr.write(
            `bbx: ELEMENT_STALE on "${selectorInput}", re-resolving and retrying...\n`
          );
        }
        if (!isStale || attempt >= maxAttempts) break;
      }
      if (response) await printSummary(response, shortcutCmd.printMethod);
      return;
    }

    if (command === 'press-key') {
      const [key, refOrSelector] = rest;
      if (!key) throw new Error('Usage: press-key <key> [ref|selector]');
      const elementRef = refOrSelector
        ? await resolveRef(client, refOrSelector, null, REQUEST_SOURCE)
        : undefined;
      const response = await requestBridge(
        client,
        'input.press_key',
        {
          key,
          target: elementRef ? { elementRef } : undefined,
        },
        { source: REQUEST_SOURCE }
      );
      await printSummary(response);
      return;
    }

    if (command === 'cdp-press-key') {
      const parsed = extractTabFlag(rest);
      const [key, code] = parsed.rest;
      if (!key) throw new Error('Usage: cdp-press-key [--tab <tabId>] <key> [code]');
      const response = await requestBridge(
        client,
        'cdp.dispatch_key_event',
        {
          key,
          code,
        },
        {
          tabId: parsed.tabId,
          source: REQUEST_SOURCE,
        }
      );
      await printSummary(response, 'cdp.dispatch_key_event');
      return;
    }

    if (command === 'screenshot') {
      const parsed = extractTabFlag(rest);
      const [refOrSelector, outputPath] = parsed.rest;
      if (!refOrSelector)
        throw new Error('Usage: screenshot [--tab <tabId>] <ref|selector> [path]');
      const elementRef = await resolveRef(client, refOrSelector, parsed.tabId, REQUEST_SOURCE);
      const response = await requestBridge(
        client,
        'screenshot.capture_element',
        {
          elementRef,
        },
        { tabId: parsed.tabId, source: REQUEST_SOURCE }
      );
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
        evidence: { savedTo: filePath, rect: screenshotResult.rect },
      });
      return;
    }

    if (command === 'intercept') {
      const { tabId, rest: iArgs } = extractTabFlag(rest);
      const sub = iArgs[0];
      if (sub === 'add') {
        const { pattern, isBlock, statusCode, body } = parseInterceptAddArgs(iArgs.slice(1));
        const response = await requestBridge(
          client,
          'network.intercept.add',
          {
            urlPattern: pattern,
            action: isBlock ? 'block' : body != null ? 'fulfill' : 'continue',
            statusCode,
            body,
          },
          { source: REQUEST_SOURCE, tabId }
        );
        await printSummary(response);
      } else if (sub === 'remove') {
        const ruleId = iArgs[1];
        if (!ruleId || iArgs.length !== 2) {
          throw new Error('Usage: intercept remove <ruleId>');
        }
        const response = await requestBridge(
          client,
          'network.intercept.remove',
          { ruleId },
          { source: REQUEST_SOURCE, tabId }
        );
        await printSummary(response);
      } else if (sub === 'list') {
        if (iArgs.length !== 1) {
          throw new Error('Usage: intercept list');
        }
        const response = await requestBridge(
          client,
          'network.intercept.list',
          {},
          { source: REQUEST_SOURCE, tabId }
        );
        await printSummary(response);
      } else if (sub === 'clear') {
        if (iArgs.length !== 1) {
          throw new Error('Usage: intercept clear');
        }
        const response = await requestBridge(
          client,
          'network.intercept.clear',
          {},
          { source: REQUEST_SOURCE, tabId }
        );
        await printSummary(response);
      } else {
        throw new Error('Usage: intercept <add|remove|list|clear> [args]');
      }
      return;
    }

    if (command === 'eval') {
      const { tabId, rest: evalArgs } = extractTabFlag(rest);
      // --await: wait for the result if the expression returns a Promise
      const awaitIndex = evalArgs.indexOf('--await');
      const awaitPromise = awaitIndex !== -1;
      if (awaitIndex !== -1) evalArgs.splice(awaitIndex, 1);

      let expression = evalArgs.join(' ');
      if (!expression || expression === '-') expression = await readStdin();
      if (!expression)
        throw new Error(
          'Usage: eval [--tab <id>] [--await] <expression>  (or pipe via stdin: echo "expr" | bbx eval -)'
        );
      const response = await requestBridge(
        client,
        'page.evaluate',
        {
          expression,
          returnByValue: true,
          ...(awaitPromise ? { awaitPromise: true } : {}),
        },
        { source: REQUEST_SOURCE, tabId }
      );
      await printSummary(response);
      return;
    }

    process.stderr.write(`Unknown command: ${command}\n`);
    printUsage();
    process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const raw = getErrorCode(error);
    let code = 'ERROR';
    if (raw === 'ENOENT' || raw === 'ECONNREFUSED' || raw === 'EINVAL') {
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
      evidence: null,
    });
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorCode(error) {
  if (!(error instanceof Error) || !('code' in error)) {
    return '';
  }
  const code = /** @type {{ code?: unknown }} */ (error).code;
  return typeof code === 'string' ? code : '';
}

/**
 * Allow tests to shrink request timeouts without changing the shared default.
 *
 * @returns {number | undefined}
 */
function getClientTimeoutOverride() {
  const raw = process.env[TEST_TIMEOUT_ENV];
  if (!raw) {
    return undefined;
  }

  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
