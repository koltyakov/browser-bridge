#!/usr/bin/env node
// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
  extractScreenshotFlags,
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
import { getAutoUpdatePolicy, parseAutoUpdatePolicy, setAutoUpdatePolicy } from './config.js';
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
  'config',
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

if (command === 'config') {
  await runLocalCommand(() => handleConfigCommand(rest));
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
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function handleConfigCommand(args) {
  const [action, key, value] = args;
  if (action === 'get' && key === 'auto-update' && value === undefined) {
    process.stdout.write(`${await getAutoUpdatePolicy()}\n`);
    return;
  }
  if (action === 'set' && key === 'auto-update' && value !== undefined && args.length === 3) {
    const policy = parseAutoUpdatePolicy(value);
    const configPath = await setAutoUpdatePolicy(policy);
    process.stdout.write(`Browser Bridge auto-update policy set to "${policy}".\n`);
    process.stdout.write(`Config: ${configPath}\n`);
    return;
  }
  throw new Error('Usage: bbx config <get auto-update|set auto-update off|compatible>');
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
    return await createBridgeClientForDestination(remoteDestinationId, {
      checkProtocolOnConnect: false,
      ...(clientTimeoutMs ? { defaultTimeoutMs: clientTimeoutMs } : {}),
    });
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
  let relaunchAfterUpdate = false;
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
      printCallResponse(response, method);
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
      printCallResponse(response, method);
      return;
    }

    const shortcutCmd = SHORTCUT_COMMANDS[command];
    if (shortcutCmd) {
      const { tabId, rest: shortcutArgs } = extractTabFlag(rest);
      const response = await requestBridge(
        client,
        shortcutCmd.method,
        shortcutCmd.build(shortcutArgs),
        { source: REQUEST_SOURCE, tabId }
      );
      await printSummary(response, shortcutCmd.printMethod);
      return;
    }

    if (command === 'press-key') {
      const [key, refOrSelector] = rest;
      if (!key) throw new Error('Usage: press-key <key> [ref|selector]');
      const target = refOrSelector
        ? refOrSelector.startsWith('el_')
          ? { elementRef: refOrSelector }
          : { selector: refOrSelector }
        : undefined;
      const response = await requestBridge(
        client,
        'input.press_key',
        {
          key,
          target,
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
      const screenshotOptions = extractScreenshotFlags(parsed.rest);
      const [refOrSelector, outputPath] = screenshotOptions.rest;
      if (!refOrSelector)
        throw new Error(
          'Usage: screenshot [--tab <tabId>] [--format png|jpeg|webp] [--quality 0-100] <ref|selector> [path]'
        );
      const elementRef = await resolveRef(client, refOrSelector, parsed.tabId, REQUEST_SOURCE);
      const response = await requestBridge(
        client,
        'screenshot.capture_element',
        {
          elementRef,
          format: screenshotOptions.format,
          quality: screenshotOptions.quality,
        },
        { tabId: parsed.tabId, source: REQUEST_SOURCE }
      );
      if (!response.ok) {
        await printSummary(response);
        return;
      }
      const screenshotResult = /** @type {ScreenshotResult} */ (response.result);
      const extension = screenshotOptions.format === 'jpeg' ? 'jpg' : screenshotOptions.format;
      const acceptedExtensions =
        screenshotOptions.format === 'jpeg'
          ? new Set(['.jpg', '.jpeg'])
          : new Set([`.${extension}`]);
      let filePath = outputPath || path.join(os.tmpdir(), `bbx-${Date.now()}.${extension}`);
      if (outputPath && !path.extname(outputPath)) filePath = `${outputPath}.${extension}`;
      if (
        outputPath &&
        path.extname(outputPath) &&
        !acceptedExtensions.has(path.extname(outputPath))
      ) {
        throw new Error(`Screenshot path extension must match ${screenshotOptions.format} format.`);
      }
      const data = screenshotResult.image.replace(/^data:image\/(?:png|jpeg|webp);base64,/, '');
      await fs.promises.writeFile(filePath, Buffer.from(data, 'base64'));
      printJson({
        ok: true,
        summary: `Screenshot saved to ${filePath}.`,
        evidence: {
          savedTo: filePath,
          rect: screenshotResult.rect,
          format: screenshotResult.format,
          complete: screenshotResult.complete,
          clipped: screenshotResult.clipped,
        },
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
    if (raw === 'BBX_NPM_UPDATED') {
      relaunchAfterUpdate = true;
    } else {
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
    }
  } finally {
    await client.close();
  }
  if (relaunchAfterUpdate) {
    relaunchCli();
  }
}

/**
 * Replace this invocation with a fresh Node process after npm has replaced the
 * package on disk. Child stdio is inherited so command output remains stable.
 *
 * @returns {void}
 */
function relaunchCli() {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: process.env,
    }
  );
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
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
