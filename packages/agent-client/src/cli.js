#!/usr/bin/env node
// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  applyWindowsTcpTransportDefaults,
  createTcpBridgeTransport,
  getProxyConfigPath,
  readProxyConfig,
  SUPPORTED_BROWSERS,
} from '../../native-host/src/config.js';
import { writeBridgeAuthToken } from '../../native-host/src/auth-token.js';
import { pingExistingDaemon } from '../../native-host/src/daemon.js';
import { restartBridgeDaemon } from '../../native-host/src/daemon-process.js';
import { uninstallNativeManifest } from '../../native-host/src/install-manifest.js';
import {
  createRuntimeContext,
  METHODS,
  summarizeBatchErrorItem,
  summarizeBatchResponseItem,
} from '../../protocol/src/index.js';
import { startBridgeMcpServer } from '../../mcp-server/src/server.js';
import { BridgeClient } from './client.js';
import { CLI_HELP_SECTIONS, SHORTCUT_COMMANDS } from './command-registry.js';
import {
  interactiveCheckbox,
  interactiveConfirm,
  methodNeedsTab,
  parseIntArg,
  parseJsonObject,
  sanitizeOutput,
} from './cli-helpers.js';
import {
  findInstalledManagedTargets,
  installAgentFiles,
  installMcpClientSetup,
  parseInstallAgentArgs,
  removeAgentFiles,
  SUPPORTED_TARGETS,
  TARGET_LABELS,
} from './install.js';
import {
  findConfiguredMcpClients,
  formatMcpConfig,
  isMcpClientName,
  MCP_CLIENT_LABELS,
  MCP_CLIENT_NAMES,
  removeMcpConfig,
} from './mcp-config.js';
import { getDoctorReport, requestBridge, resolveRef } from './runtime.js';
import {
  addRemoteDestination,
  createBridgeClientForDestination,
  listBridgeDestinations,
  normalizeDestinationId,
  parseRemoteEndpoint,
  readRemoteConfig,
  removeRemoteDestination,
} from './remotes.js';
import { collectSetupStatus } from './setup-status.js';
import { annotateBridgeSummary, summarizeBridgeResponse } from './subagent.js';

/** @typedef {import('./types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('./types.js').ScreenshotResult} ScreenshotResult */

const REQUEST_SOURCE = 'cli';
const TEST_TIMEOUT_ENV = 'BBX_CLIENT_REQUEST_TIMEOUT_MS';
const TEST_DETECTED_MCP_CLIENTS_ENV = 'BBX_TEST_DETECTED_MCP_CLIENTS';

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
  const { fileURLToPath } = await import('node:url');
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
  // When no positional target is given, detect installed agents and prompt.
  const positional = rest.filter((a) => !a.startsWith('--'));

  if (positional.length === 0) {
    let scopeOptions;
    try {
      scopeOptions = parseInstallAgentArgs(rest);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }

    const isGlobal = scopeOptions.global !== false;
    const projectPath = isGlobal ? os.homedir() : scopeOptions.projectPath;

    const setupStatus = await collectSetupStatus({
      global: isGlobal,
      cwd: process.cwd(),
      projectPath,
      ...getSetupStatusTestOverrides(),
    });
    /** @type {import('./types.js').SupportedTarget[]} */
    const detected = /** @type {import('./types.js').SupportedTarget[]} */ (
      setupStatus.skillTargets.filter((entry) => entry.detected).map((entry) => entry.key)
    );
    const installedManagedTargets = new Set(
      setupStatus.skillTargets
        .filter((entry) => entry.installed && entry.managed)
        .map((entry) => entry.key)
    );
    const installedManagedTargetList =
      /** @type {import('./types.js').SupportedTarget[]} */ ([...installedManagedTargets]);

    // Aliases like 'openai' and 'google' map to canonical targets and stay omitted.
    const items = SUPPORTED_TARGETS.map((t) => ({
      value: t,
      label: `${t.padEnd(10)}  ${TARGET_LABELS[t]}`,
      hint: formatSelectionHint({
        detected: detected.includes(t),
        installed: installedManagedTargets.has(t),
      }),
      checked: installedManagedTargets.has(t),
    }));

    const selected = await interactiveCheckbox(
      'Select agents to install skill for  (↑↓ move · space toggle · a all · enter confirm)',
      items
    );

    /** @type {import('./types.js').SupportedTarget[]} */
    let targets;
    if (selected === null) {
      // Non-TTY: prefer managed installs, then detected targets (always includes 'agents').
      targets = installedManagedTargets.size > 0 ? installedManagedTargetList : detected;
    } else {
      targets = /** @type {import('./types.js').SupportedTarget[]} */ (selected);
    }

    if (selected !== null) {
      const deselectedTargets =
        /** @type {import('./types.js').SupportedTarget[]} */ (
          installedManagedTargetList.filter((target) => !targets.includes(target))
        );
      const removableTargets = await findInstalledManagedTargets({
        targets: deselectedTargets,
        projectPath,
        global: isGlobal,
      });
      if (removableTargets.length > 0) {
        const confirmed = await interactiveConfirm(
          `Remove Browser Bridge skill from deselected targets: ${removableTargets.join(', ')}?`
        );
        if (confirmed) {
          const removedPaths = await removeAgentFiles({
            targets: removableTargets,
            projectPath,
            global: isGlobal,
          });
          for (const p of removedPaths) process.stdout.write(`Removed ${p}\n`);
        }
      }
    }

    if (targets.length === 0) {
      process.stdout.write('No targets selected.\n');
      process.exit(0);
    }

    const installedPaths = await installAgentFiles({
      targets,
      projectPath,
      global: isGlobal,
    });
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
  let isGlobal = true;
  /** @type {string[]} */
  const positionals = [];

  for (const arg of rest) {
    if (arg === '--local') {
      isGlobal = false;
      continue;
    }
    if (arg === '--global') {
      isGlobal = true;
      continue;
    }
    if (arg.startsWith('--')) {
      process.stderr.write(`Unknown install-mcp option "${arg}".\n`);
      process.exit(1);
    }
    positionals.push(arg);
  }

  if (positionals.length > 1) {
    process.stderr.write(`Unexpected extra argument "${positionals[1]}".\n`);
    process.exit(1);
  }

  const clientArg = positionals[0];

  /** @type {import('./types.js').McpClientName[]} */
  let clients;

  if (!clientArg) {
    // No client specified: inspect current MCP config and prompt interactively.
    const setupStatus = await collectSetupStatus({
      global: isGlobal,
      cwd: process.cwd(),
      projectPath: process.cwd(),
      ...getSetupStatusTestOverrides(),
    });
    const detected = /** @type {import('./types.js').McpClientName[]} */ (
      setupStatus.mcpClients.filter((entry) => entry.detected).map((entry) => entry.key)
    );
    const configuredClients = new Set(
      setupStatus.mcpClients.filter((entry) => entry.configured).map((entry) => entry.key)
    );
    const configuredClientList =
      /** @type {import('./types.js').McpClientName[]} */ ([...configuredClients]);
    const items = MCP_CLIENT_NAMES.map((c) => ({
      value: c,
      label: `${c.padEnd(10)}  ${MCP_CLIENT_LABELS[c]}`,
      hint: formatSelectionHint({
        detected: detected.includes(c),
        installed: configuredClients.has(c),
      }),
      checked: configuredClients.has(c),
    }));

    const selected = await interactiveCheckbox(
      'Select clients to configure  (↑↓ move · space toggle · a all · enter confirm)',
      items
    );

    if (selected === null) {
      // Non-TTY: prefer configured clients, then detected clients, then all.
      clients =
        configuredClients.size > 0
          ? configuredClientList
          : detected.length > 0
            ? detected
            : [...MCP_CLIENT_NAMES];
    } else {
      clients = /** @type {import('./types.js').McpClientName[]} */ (selected);
    }

    if (selected !== null) {
      const deselectedClients =
        /** @type {import('./types.js').McpClientName[]} */ (
          configuredClientList.filter((clientName) => !clients.includes(clientName))
        );
      const removableClients = await findConfiguredMcpClients({
        clients: deselectedClients,
        global: isGlobal,
        cwd: process.cwd(),
      });
      if (removableClients.length > 0) {
        const confirmed = await interactiveConfirm(
          `Remove Browser Bridge MCP config from deselected clients: ${removableClients.join(', ')}?`
        );
        if (confirmed) {
          for (const clientName of removableClients) {
            await removeMcpConfig(clientName, {
              global: isGlobal,
              cwd: process.cwd(),
            });
          }
        }
      }
    }

    if (clients.length === 0) {
      process.stdout.write('No clients selected.\n');
      process.exit(0);
    }
  } else if (clientArg === 'all') {
    clients = [...MCP_CLIENT_NAMES];
  } else {
    const parts = clientArg
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (parts.includes('all')) {
      clients = [...MCP_CLIENT_NAMES];
    } else {
      clients = [];
      for (const part of parts) {
        if (!isMcpClientName(part)) {
          process.stderr.write(
            `Unknown client "${part}". Supported: ${MCP_CLIENT_NAMES.join(', ')}, all\n`
          );
          process.exit(1);
        }
        clients.push(part);
      }
    }
  }

  await installMcpClientSetup(clients, {
    global: isGlobal,
    projectPath: process.cwd(),
    stdout: process.stdout,
  });
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
  await handleProxyCommand(rest);
  process.exit(0);
}

if (command === 'remote') {
  await handleRemoteCommand(rest);
  process.exit(0);
}

const clientTimeoutMs = getClientTimeoutOverride();
applyWindowsTcpTransportDefaults();
const client = new BridgeClient(
  clientTimeoutMs ? { defaultTimeoutMs: clientTimeoutMs } : undefined
);

await main();

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
      printJson({
        ok: true,
        summary: result.previouslyRunning
          ? 'Browser Bridge daemon restarted.'
          : 'Browser Bridge daemon started.',
        evidence: result,
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
      const input = rest[0];
      if (!input) {
        throw new Error('Usage: batch \'[{"method":"...","params":{...}}, ...]\'');
      }
      let calls;
      try {
        calls = JSON.parse(input);
      } catch {
        throw new Error('Invalid JSON syntax. Expected a JSON array of bridge calls.');
      }
      if (!Array.isArray(calls)) {
        throw new Error('Batch input must be a JSON array.');
      }
      await ensureClientConnection();
      const results = await Promise.all(
        calls.map(async (call) => {
          if (!call || typeof call !== 'object' || typeof call.method !== 'string') {
            return {
              method: '',
              tabId: null,
              ok: false,
              summary: 'INVALID_REQUEST: Each batch call needs a method.',
              evidence: null,
              durationMs: 0,
              approxTokens: 0,
              meta: { protocol_version: '1.0' },
              error: {
                code: 'INVALID_REQUEST',
                message: 'Each batch call needs a method.',
              },
              response: null,
            };
          }
          if (!METHODS.includes(/** @type {BridgeMethod} */ (call.method))) {
            return {
              method: call.method,
              tabId: null,
              ok: false,
              summary: `INVALID_REQUEST: Unknown bridge method "${call.method}".`,
              evidence: null,
              durationMs: 0,
              approxTokens: 0,
              meta: { protocol_version: '1.0' },
              error: {
                code: 'INVALID_REQUEST',
                message: `Unknown bridge method "${call.method}".`,
              },
              response: null,
            };
          }
          const method = /** @type {BridgeMethod} */ (call.method);
          const tabId =
            methodNeedsTab(call.method) && typeof call.tabId === 'number' ? call.tabId : null;
          const startTime = Date.now();
          try {
            const response = await client.request({
              method,
              tabId,
              params: call.params || {},
              meta: { source: REQUEST_SOURCE },
            });
            return summarizeBatchResponseItem({
              method,
              tabId,
              response,
              durationMs: Date.now() - startTime,
            });
          } catch (err) {
            return summarizeBatchErrorItem({
              method,
              tabId,
              error: err,
              durationMs: Date.now() - startTime,
            });
          }
        })
      );
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
        const pattern = iArgs[1];
        if (!pattern)
          throw new Error(
            'Usage: intercept add <urlPattern> [--respond <body>] [--status <code>] [--block]'
          );
        const isBlock = iArgs.includes('--block');
        const statusIdx = iArgs.indexOf('--status');
        const statusCode = statusIdx !== -1 ? parseIntArg(iArgs[statusIdx + 1], 'status') : 200;
        const respondIdx = iArgs.indexOf('--respond');
        const body =
          respondIdx !== -1
            ? iArgs
                .slice(respondIdx + 1)
                .filter((a) => !a.startsWith('--'))
                .join(' ')
            : undefined;
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
        if (!ruleId) throw new Error('Usage: intercept remove <ruleId>');
        const response = await requestBridge(
          client,
          'network.intercept.remove',
          { ruleId },
          { source: REQUEST_SOURCE, tabId }
        );
        await printSummary(response);
      } else if (sub === 'list') {
        const response = await requestBridge(
          client,
          'network.intercept.list',
          {},
          { source: REQUEST_SOURCE, tabId }
        );
        await printSummary(response);
      } else if (sub === 'clear') {
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
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function handleProxyCommand(args) {
  const [subcommand, ...restArgs] = args;
  if (subcommand === 'enable') {
    const options = parseProxyEnableArgs(restArgs);
    const token = options.token ?? randomUUID();
    await writeBridgeAuthToken(token);
    const configPath = getProxyConfigPath();
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(
      configPath,
      `${JSON.stringify(
        {
          enabled: true,
          port: options.port,
          bindHost: options.bindHost,
          token,
        },
        null,
        2
      )}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    const result = await restartBridgeDaemon();
    const exampleHost = getProxyExampleHost(options.bindHost);
    process.stdout.write(
      [
        `Browser Bridge proxy enabled on ${options.bindHost}:${options.port}.`,
        '',
        `Token: ${token}`,
        `Config: ${configPath}`,
        `Daemon: ${result.previouslyRunning ? 'restarted' : 'started'} (pid ${result.pid})`,
        '',
        'On your dev machine, add this remote:',
        '',
        `bbx remote add <name> <host:port> --token ${token}`,
        '',
        'Example:',
        '',
        `bbx remote add remote-bbx ${exampleHost}:${options.port} --token ${token}`,
        '',
      ].join('\n')
    );
    return;
  }

  if (subcommand === 'disable') {
    const configPath = getProxyConfigPath();
    await fs.promises.rm(configPath, { force: true });
    const result = await restartBridgeDaemon();
    process.stdout.write(
      `Browser Bridge proxy disabled. Daemon ${result.previouslyRunning ? 'restarted' : 'started'}.\n`
    );
    return;
  }

  if (subcommand === 'status') {
    const config = readProxyConfig();
    if (!config) {
      process.stdout.write('Browser Bridge proxy is disabled.\n');
      return;
    }
    const reachable = await pingExistingDaemon(createTcpBridgeTransport(config.port, '127.0.0.1'));
    process.stdout.write(
      [
        `Browser Bridge proxy is enabled on ${config.bindHost}:${config.port}.`,
        `Config: ${getProxyConfigPath()}`,
        `Daemon: ${reachable ? 'reachable' : 'not reachable'} on 127.0.0.1:${config.port}`,
        '',
      ].join('\n')
    );
    return;
  }

  throw new Error('Usage: bbx proxy <enable|disable|status>');
}

/**
 * @param {string[]} args
 * @returns {{ port: number, bindHost: string, token?: string }}
 */
function parseProxyEnableArgs(args) {
  /** @type {{ port: number, bindHost: string, token?: string }} */
  const options = { port: 9223, bindHost: '0.0.0.0' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--port') {
      options.port = parseIntArg(args[++index] || '', 'port');
      continue;
    }
    if (arg === '--bind-host') {
      options.bindHost = args[++index] || '';
      if (!options.bindHost.trim()) {
        throw new Error('--bind-host requires a value.');
      }
      continue;
    }
    if (arg === '--token') {
      options.token = args[++index] || '';
      if (!options.token.trim()) {
        throw new Error('--token requires a value.');
      }
      continue;
    }
    throw new Error(`Unknown proxy enable option "${arg}".`);
  }
  if (options.port < 1 || options.port > 65535) {
    throw new Error('port must be an integer between 1 and 65535.');
  }
  return options;
}

/**
 * @param {string} bindHost
 * @returns {string}
 */
function getProxyExampleHost(bindHost) {
  if (bindHost !== '0.0.0.0' && bindHost !== '::') {
    return bindHost;
  }

  /** @type {string | null} */
  let firstIpv4 = null;
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.family === 'IPv4') {
        if (name.toLowerCase() === 'ethernet 0') {
          return entry.address;
        }
        firstIpv4 ??= entry.address;
      }
    }
  }

  return firstIpv4 ?? '<host>';
}

/**
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function handleRemoteCommand(args) {
  const [subcommand, ...restArgs] = args;
  if (subcommand === 'add') {
    const [name, endpoint, ...optionArgs] = restArgs;
    if (!name || !endpoint) {
      throw new Error('Usage: bbx remote add <name> <host:port> --token <token>');
    }
    const token = parseRemoteTokenOption(optionArgs);
    const { host, port } = parseRemoteEndpoint(endpoint);
    const remote = await addRemoteDestination({
      id: normalizeDestinationId(name),
      host,
      port,
      token,
    });
    process.stdout.write(
      `Remote destination "${remote.id}" saved (${remote.host}:${remote.port}).\n`
    );
    return;
  }

  if (subcommand === 'remove') {
    const [name] = restArgs;
    if (!name) {
      throw new Error('Usage: bbx remote remove <name>');
    }
    const removed = await removeRemoteDestination(name);
    process.stdout.write(
      removed
        ? `Remote destination "${name}" removed.\n`
        : `Remote destination "${name}" was not configured.\n`
    );
    return;
  }

  if (subcommand === 'list') {
    const config = await readRemoteConfig();
    if (config.remotes.length === 0) {
      process.stdout.write('No remote destinations configured.\n');
      return;
    }
    process.stdout.write(
      `${config.remotes.map((remote) => `${remote.id}\t${remote.host}:${remote.port}`).join('\n')}\n`
    );
    return;
  }

  if (subcommand === 'test') {
    const [name] = restArgs;
    if (!name) {
      throw new Error('Usage: bbx remote test <name>');
    }
    const remoteClient = await createBridgeClientForDestination(name);
    try {
      await remoteClient.connect();
      const response = await remoteClient.request({ method: 'health.ping' });
      process.stdout.write(
        response.ok
          ? `Remote destination "${name}" is reachable.\n`
          : `Remote destination "${name}" failed: ${response.error.message}\n`
      );
    } finally {
      await remoteClient.close();
    }
    return;
  }

  if (subcommand === 'destinations') {
    const destinations = await listBridgeDestinations();
    process.stdout.write(
      `${destinations
        .map((destination) =>
          destination.local
            ? `${destination.id}\tlocal`
            : `${destination.id}\t${destination.host}:${destination.port}`
        )
        .join('\n')}\n`
    );
    return;
  }

  throw new Error('Usage: bbx remote <add|remove|list|test|destinations>');
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function parseRemoteTokenOption(args) {
  let token = '';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--token') {
      token = args[++index] || '';
      continue;
    }
    throw new Error(`Unknown remote add option "${arg}".`);
  }
  if (!token.trim()) {
    throw new Error('Usage: bbx remote add <name> <host:port> --token <token>');
  }
  return token.trim();
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

/**
 * Allow CLI tests to provide deterministic MCP client detection without relying
 * on whatever tools happen to be installed on the host machine.
 *
 * @returns {{
 *   mcpDetectors?: Record<string, () => boolean>,
 * }}
 */
function getSetupStatusTestOverrides() {
  if (!(TEST_DETECTED_MCP_CLIENTS_ENV in process.env)) {
    return {};
  }

  const detectedClients = new Set(
    (process.env[TEST_DETECTED_MCP_CLIENTS_ENV] || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );

  return {
    mcpDetectors: Object.fromEntries(
      MCP_CLIENT_NAMES.map((clientName) => [clientName, () => detectedClients.has(clientName)])
    ),
  };
}

/**
 * @param {{ detected: boolean, installed: boolean }} options
 * @returns {string | undefined}
 */
function formatSelectionHint(options) {
  /** @type {string[]} */
  const parts = [];
  if (options.detected) {
    parts.push('● detected');
  }
  if (options.installed) {
    parts.push('installed');
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
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
  printJson(annotateBridgeSummary(summarizeBridgeResponse(response, method), response));
}

/**
 * @param {unknown} value
 * @returns {void}
 */
function printJson(value) {
  process.stdout.write(
    `${JSON.stringify(sanitizeOutput(value), null, process.stdout.isTTY ? 2 : undefined)}\n`
  );
}

/**
 * @param {import('../../protocol/src/types.js').BridgeResponse} response
 * @returns {void}
 */
function printCallResponse(response) {
  if (response.ok) {
    printJson(response.result);
    return;
  }

  process.exitCode = 1;
  const errorText = `${response.error.code}: ${response.error.message}`;
  process.stderr.write(
    `${process.stderr.isTTY ? `\u001b[31m${sanitizeOutput(errorText)}\u001b[0m` : sanitizeOutput(errorText)}\n`
  );
  printJson(response);
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
 * @returns {Promise<void>}
 */
async function uninstallBrowserBridge() {
  const cwd = process.cwd();
  const globalProjectPath = os.homedir();

  for (const clientName of MCP_CLIENT_NAMES) {
    await removeMcpConfig(clientName, { global: true, cwd });
  }

  const removedGlobalSkillPaths = await removeAgentFiles({
    targets: SUPPORTED_TARGETS,
    projectPath: globalProjectPath,
    global: true,
  });
  for (const removedPath of removedGlobalSkillPaths) {
    process.stdout.write(`Removed ${removedPath}\n`);
  }

  for (const clientName of MCP_CLIENT_NAMES) {
    await removeMcpConfig(clientName, { global: false, cwd });
  }

  const removedLocalSkillPaths = await removeAgentFiles({
    targets: SUPPORTED_TARGETS,
    projectPath: cwd,
    global: false,
  });
  for (const removedPath of removedLocalSkillPaths) {
    process.stdout.write(`Removed ${removedPath}\n`);
  }

  for (const [index, browser] of SUPPORTED_BROWSERS.entries()) {
    await uninstallNativeManifest({
      browser,
      removeBridgeDir: index === SUPPORTED_BROWSERS.length - 1,
    });
  }
}

/**
 * @param {string[]} args
 * @returns {Promise<{ tabId: number | null, method: BridgeMethod, params: Record<string, unknown> }>}
 */
async function parseCallCommand(args) {
  const parsed = extractTabFlag(args);
  const [first, second, ...extra] = parsed.rest;
  if (!first) {
    throw new Error('Usage: call [--tab <tabId>] <method> [paramsJson]');
  }
  if (extra.length > 0) {
    throw new Error('Usage: call [--tab <tabId>] <method> [paramsJson]');
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
      tabId: methodNeedsTab(method) ? parsed.tabId : null,
      params: parseJsonObject(rawParams),
    };
  }

  throw new Error('Usage: call [--tab <tabId>] <method> [paramsJson]');
}

/**
 * @param {string[]} args
 * @returns {{ tabId: number | null, rest: string[] }}
 */
function extractTabFlag(args) {
  const rest = [...args];
  let tabId = null;
  const tabIndex = rest.indexOf('--tab');
  if (tabIndex !== -1) {
    tabId = parseIntArg(rest[tabIndex + 1], 'tabId');
    rest.splice(tabIndex, 2);
  }
  return { tabId, rest };
}
