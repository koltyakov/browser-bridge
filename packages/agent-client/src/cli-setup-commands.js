// @ts-check

import os from 'node:os';

import { SUPPORTED_BROWSERS } from '../../native-host/src/config.js';
import { uninstallNativeManifest } from '../../native-host/src/install-manifest.js';
import { interactiveCheckbox, interactiveConfirm } from './cli-helpers.js';
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
  isMcpClientName,
  MCP_CLIENT_LABELS,
  MCP_CLIENT_NAMES,
  removeMcpConfig,
} from './mcp-config.js';
import { collectSetupStatus } from './setup-status.js';

const TEST_DETECTED_MCP_CLIENTS_ENV = 'BBX_TEST_DETECTED_MCP_CLIENTS';
const TEST_DETECTED_SKILL_TARGETS_ENV = 'BBX_TEST_DETECTED_SKILL_TARGETS';

/**
 * Handle `bbx install-skill [targets] [--global|--project <path>]`.
 * Exits the process when finished.
 *
 * @param {string[]} args
 * @returns {Promise<never>}
 */
export async function runInstallSkillCommand(args) {
  // When no positional target is given, detect installed agents and prompt.
  if (!hasExplicitInstallSkillTarget(args)) {
    let scopeOptions;
    try {
      scopeOptions = parseInstallAgentArgs(args);
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
    const installedManagedTargetList = /** @type {import('./types.js').SupportedTarget[]} */ ([
      ...installedManagedTargets,
    ]);

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
      const deselectedTargets = /** @type {import('./types.js').SupportedTarget[]} */ (
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
  const options = parseInstallAgentArgs(args);
  const installedPaths = await installAgentFiles(options);
  for (const installedPath of installedPaths) {
    process.stdout.write(`Installed ${installedPath}\n`);
  }
  process.exit(0);
}

/**
 * Handle `bbx install-mcp [client] [--global|--local]`.
 * Exits the process when finished.
 *
 * @param {string[]} args
 * @returns {Promise<never>}
 */
export async function runInstallMcpCommand(args) {
  let isGlobal = true;
  /** @type {string[]} */
  const positionals = [];

  for (const arg of args) {
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
    const configuredClientList = /** @type {import('./types.js').McpClientName[]} */ ([
      ...configuredClients,
    ]);
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
      const deselectedClients = /** @type {import('./types.js').McpClientName[]} */ (
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

/**
 * Remove all Browser Bridge MCP configs, skills, and native manifests.
 *
 * @returns {Promise<void>}
 */
export async function uninstallBrowserBridge() {
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
 * Determine whether install-skill includes an explicit target without treating
 * option values such as `--project <path>` as positional targets.
 *
 * @param {string[]} args
 * @returns {boolean}
 */
function hasExplicitInstallSkillTarget(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--project') {
      index += 1;
      continue;
    }
    if (arg === '--agents' || arg === '--agent') {
      return true;
    }
    if (arg.startsWith('--agents=') || arg.startsWith('--agent=')) {
      return true;
    }
    if (!arg.startsWith('--')) {
      return true;
    }
  }
  return false;
}

/**
 * Allow CLI tests to provide deterministic MCP client detection without relying
 * on whatever tools happen to be installed on the host machine.
 *
 * @returns {{
 *   mcpDetectors?: Record<string, () => boolean>,
 *   skillDetectors?: Record<string, () => boolean>,
 * }}
 */
function getSetupStatusTestOverrides() {
  /** @type {{ mcpDetectors?: Record<string, () => boolean>, skillDetectors?: Record<string, () => boolean> }} */
  const overrides = {};
  if (TEST_DETECTED_MCP_CLIENTS_ENV in process.env) {
    const detectedClients = new Set(
      (process.env[TEST_DETECTED_MCP_CLIENTS_ENV] || '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    );
    overrides.mcpDetectors = Object.fromEntries(
      MCP_CLIENT_NAMES.map((clientName) => [clientName, () => detectedClients.has(clientName)])
    );
  }

  if (TEST_DETECTED_SKILL_TARGETS_ENV in process.env) {
    const detectedTargets = new Set(
      (process.env[TEST_DETECTED_SKILL_TARGETS_ENV] || '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    );
    overrides.skillDetectors = Object.fromEntries(
      SUPPORTED_TARGETS.map((target) => [target, () => detectedTargets.has(target)])
    );
  }
  return overrides;
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
