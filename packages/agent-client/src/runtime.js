// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  APP_NAME,
  getBridgeDir,
  getDaemonLogPath,
  getDaemonPidPath,
  getBridgeTransport,
  getManifestInstallDir,
  getSocketPath,
  readProxyConfig,
  SUPPORTED_BROWSERS,
} from '../../native-host/src/config.js';
import {
  readDaemonStartHistory,
  summarizeDaemonRestarts,
} from '../../native-host/src/daemon-process.js';
import { resolveDefaultExtensionId } from '../../native-host/src/install-manifest.js';
import {
  BridgeError,
  BRIDGE_METHOD_REGISTRY,
  CLIENT_REQUEST_TIMEOUT_MARGIN_MS,
  DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
  getBridgeOperationTimeoutMs,
  getProtocolVersion,
  MAX_CLIENT_REQUEST_TIMEOUT_MS,
  sanitizeIncidentalPath,
  sanitizeIncidentalText,
} from '../../protocol/src/index.js';
import { methodNeedsTab } from './cli-helpers.js';
import { BridgeClient } from './client.js';
import { applyConfiguredAutoUpdate } from './config.js';
import { readRemoteConfig } from './remotes.js';
import { collectSetupStatus } from './setup-status.js';

/** @typedef {import('./types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('./types.js').BridgeMeta} BridgeMeta */
/** @typedef {import('./types.js').BridgeRequestSource} BridgeRequestSource */
/** @typedef {import('./types.js').BridgeResponse} BridgeResponse */
/** @typedef {import('./types.js').BridgeClientOptions} BridgeClientOptions */
/** @typedef {import('../../native-host/src/config.js').SupportedBrowser} SupportedBrowser */
/** @typedef {import('./types.js').BrowserManifestStatus} BrowserManifestStatus */
/** @typedef {import('./types.js').NativeHostManifestIssue} NativeHostManifestIssue */
/** @typedef {import('./types.js').DoctorReport} DoctorReport */
/** @typedef {import('./types.js').DoctorReportOptions} DoctorReportOptions */
/** @typedef {import('./types.js').DoctorRecentEvent} DoctorRecentEvent */

const CHROMIUM_SANDBOXED_MANIFEST_RE =
  /(?:^|[/\\])(?:snap[/\\]chromium|\.var[/\\]app[/\\]org\.chromium\.Chromium)[/\\]/;
const DOCTOR_LOG_LIMIT = 12;
const DOCTOR_RECENT_EVENT_LIMIT = 10;
const DOCTOR_SETUP_ENTRY_LIMIT = 100;
const MAX_DOCTOR_COUNT = 1_000_000_000;
const SAFE_VERSION_RE = /^\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/u;
const CHROME_EXTENSION_ID_RE = /^[a-p]{32}$/u;
const SAFE_DEBUGGER_STATES = new Set(['idle', 'active', 'conflict', 'detached']);
const SAFE_ROUTE_REASONS = new Set([
  'enabled',
  'access_disabled',
  'enabled_window_missing',
  'no_routable_active_tab',
  'reconnected',
  'restricted_page',
]);
const SAFE_CAPTURE_STATES = new Set([
  'idle',
  'stopped',
  'armed',
  'active',
  'capturing',
  'stop_failed',
  'unavailable',
]);
const BRIDGE_METHOD_SET = new Set(Object.keys(BRIDGE_METHOD_REGISTRY));
const DOCTOR_DIAGNOSTIC_METHODS = new Set([
  'health.ping',
  'setup.get_status',
  'log.tail',
  'daemon.metrics',
]);
const SAFE_DEBUGGER_REASONS = new Set([
  'debugger_conflict',
  'debugger_detached',
  'debugger_replaced',
  'debugger_canceled',
  'target_closed',
]);

/**
 * @param {BridgeClient} client
 * @returns {Promise<void>}
 */
export async function ensureClientConnected(client) {
  if (!client.connected) {
    await client.connect();
  }
}

/**
 * @param {BridgeClient} client
 * @param {BridgeMethod} method
 * @param {Record<string, unknown>} [params={}]
 * @param {{ tabId?: number | null, source?: BridgeRequestSource, tokenBudget?: number | null }} [options]
 * @returns {Promise<BridgeResponse>}
 */
export async function requestBridge(client, method, params = {}, options = {}) {
  await ensureClientConnected(client);
  const operationTimeoutMs = getBridgeOperationTimeoutMs(method, params);
  const clientDefaultTimeoutMs =
    typeof client.defaultTimeoutMs === 'number'
      ? client.defaultTimeoutMs
      : DEFAULT_CLIENT_REQUEST_TIMEOUT_MS;
  const timeoutMs =
    operationTimeoutMs === null
      ? undefined
      : Math.min(
          MAX_CLIENT_REQUEST_TIMEOUT_MS,
          Math.max(clientDefaultTimeoutMs, operationTimeoutMs + CLIENT_REQUEST_TIMEOUT_MARGIN_MS)
        );
  return client.request({
    method,
    params,
    tabId: methodNeedsTab(method) ? (options.tabId ?? null) : null,
    meta: withRequestMeta(options.source, options.tokenBudget),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/**
 * @param {BridgeClient} client
 * @param {string} refOrSelector
 * @param {number | null} [tabId=null]
 * @param {BridgeRequestSource} [source]
 * @returns {Promise<string>}
 */
export async function resolveRef(client, refOrSelector, tabId = null, source) {
  if (refOrSelector.startsWith('el_')) {
    return refOrSelector;
  }

  const response = await requestBridge(
    client,
    'dom.query',
    {
      selector: refOrSelector,
    },
    { tabId, source }
  );

  if (!response.ok) {
    throw new BridgeError(response.error.code, response.error.message, response.error.details);
  }

  const result = /** @type {{ nodes: Array<{ elementRef: string }> }} */ (response.result);
  if (!result.nodes || result.nodes.length === 0) {
    throw new BridgeError('INVALID_REQUEST', `No element found for selector "${refOrSelector}".`, {
      selector: refOrSelector,
    });
  }
  return result.nodes[0].elementRef;
}

/**
 * @param {BridgeRequestSource | undefined} source
 * @param {number | null | undefined} tokenBudget
 * @returns {BridgeMeta}
 */
function withRequestMeta(source, tokenBudget) {
  /** @type {BridgeMeta} */
  const meta = {};
  if (source) {
    meta.source = source;
  }
  if (typeof tokenBudget === 'number' && Number.isFinite(tokenBudget)) {
    meta.token_budget = tokenBudget;
  }
  return meta;
}

/**
 * @template T
 * @param {(client: BridgeClient) => Promise<T>} callback
 * @param {BridgeClientOptions} [options]
 * @returns {Promise<T>}
 */
export async function withBridgeClient(callback, options) {
  const client = new BridgeClient(await applyConfiguredAutoUpdate(options));
  await ensureClientConnected(client);
  try {
    return await callback(client);
  } finally {
    await client.close();
  }
}

/**
 * @param {SupportedBrowser} [browser]
 * @returns {string}
 */
export function getManifestPath(browser) {
  return path.join(getManifestInstallDir(browser), `${APP_NAME}.json`);
}

/**
 * @param {SupportedBrowser} [browser]
 * @returns {Promise<{allowed_origins?: string[]} | null>}
 */
export async function loadInstalledManifest(browser) {
  try {
    const raw = await fs.promises.readFile(getManifestPath(browser), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Check the native messaging manifest status for every supported browser on
 * the current platform.
 *
 * @returns {Promise<BrowserManifestStatus[]>}
 */
export async function checkBrowserManifests() {
  return Promise.all(
    SUPPORTED_BROWSERS.map(async (browser) => {
      const manifestPath = getManifestPath(browser);
      try {
        await fs.promises.access(manifestPath);
        return { browser, manifestPath, installed: true };
      } catch {
        return { browser, manifestPath, installed: false };
      }
    })
  );
}

/**
 * Read the allowlisted extension IDs from every installed browser manifest.
 * Invalid manifests are already reported by the native-host health check and
 * do not prevent the remaining browsers from contributing identity data.
 *
 * @param {BrowserManifestStatus[]} browserManifests
 * @param {typeof fs.promises.readFile} [readFile]
 * @returns {Promise<string[]>}
 */
export async function readInstalledExtensionIds(
  browserManifests,
  readFile = fs.promises.readFile.bind(fs.promises)
) {
  /** @type {Set<string>} */
  const extensionIds = new Set();
  for (const entry of browserManifests.slice(0, DOCTOR_SETUP_ENTRY_LIMIT)) {
    if (!entry.installed || extensionIds.size >= DOCTOR_SETUP_ENTRY_LIMIT) {
      continue;
    }
    try {
      const parsed = JSON.parse(await readFile(entry.manifestPath, 'utf8'));
      const origins = Array.isArray(parsed?.allowed_origins) ? parsed.allowed_origins : [];
      for (const origin of origins.slice(0, DOCTOR_SETUP_ENTRY_LIMIT)) {
        const match =
          typeof origin === 'string'
            ? /^chrome-extension:\/\/([a-p]{32})\/(?:\*)?$/u.exec(origin)
            : null;
        if (match?.[1]) {
          extensionIds.add(match[1]);
        }
      }
    } catch {
      // The native-host manifest health collector reports malformed files.
    }
  }
  return [...extensionIds];
}

/**
 * @param {string} line
 * @param {number} startIndex
 * @returns {{ value: string, nextIndex: number } | null}
 */
function readShellSingleQuotedToken(line, startIndex) {
  let index = startIndex;
  while (line[index] === ' ') {
    index += 1;
  }
  if (line[index] !== "'") {
    return null;
  }
  index += 1;

  let value = '';
  while (index < line.length) {
    const endIndex = line.indexOf("'", index);
    if (endIndex === -1) {
      return null;
    }
    value += line.slice(index, endIndex);
    index = endIndex + 1;
    if (line.startsWith("\\''", index)) {
      value += "'";
      index += 3;
      continue;
    }
    return { value, nextIndex: index };
  }

  return null;
}

/**
 * @param {string} launcher
 * @returns {{ nodePath: string, hostPath: string } | null}
 */
function parseNativeHostLauncherTargets(launcher) {
  const windowsMatch = /"([^"\r\n]+)"\s+"([^"\r\n]+)"\s+%\*/u.exec(launcher);
  if (windowsMatch?.[1] && windowsMatch[2]) {
    return {
      nodePath: windowsMatch[1],
      hostPath: windowsMatch[2],
    };
  }

  const execLine = launcher
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith('exec '));
  if (!execLine) {
    return null;
  }
  const nodeToken = readShellSingleQuotedToken(execLine, 'exec '.length);
  if (!nodeToken) {
    return null;
  }
  const hostToken = readShellSingleQuotedToken(execLine, nodeToken.nextIndex);
  if (!hostToken) {
    return null;
  }
  return {
    nodePath: nodeToken.value,
    hostPath: hostToken.value,
  };
}

/**
 * Validate installed native messaging manifests and the launcher they point to.
 * This catches stale sudo/global Node installs where the manifest exists but
 * Chrome launches a missing or non-executable script/Node binary.
 *
 * @param {BrowserManifestStatus[]} browserManifests
 * @returns {Promise<NativeHostManifestIssue[]>}
 */
export async function checkNativeHostManifestHealth(browserManifests) {
  /** @type {NativeHostManifestIssue[]} */
  const issues = [];
  const executableAccessMode = os.platform() === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
  for (const entry of browserManifests) {
    if (!entry.installed) {
      continue;
    }

    /** @type {Record<string, unknown>} */
    let manifest;
    try {
      const rawManifest = await fs.promises.readFile(entry.manifestPath, 'utf8');
      const parsed = JSON.parse(rawManifest);
      manifest = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      issues.push({
        browser: entry.browser,
        manifestPath: entry.manifestPath,
        message: `Native host manifest is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const launcherPath = typeof manifest.path === 'string' ? manifest.path : '';
    if (!launcherPath) {
      issues.push({
        browser: entry.browser,
        manifestPath: entry.manifestPath,
        message: 'Native host manifest does not specify a launcher path.',
      });
      continue;
    }

    let launcherRaw = '';
    try {
      await fs.promises.access(launcherPath, executableAccessMode);
      launcherRaw = await fs.promises.readFile(launcherPath, 'utf8');
    } catch (error) {
      issues.push({
        browser: entry.browser,
        manifestPath: entry.manifestPath,
        message: `Native host launcher is not executable or readable at ${launcherPath}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const launcherTargets = parseNativeHostLauncherTargets(launcherRaw);
    if (!launcherTargets) {
      issues.push({
        browser: entry.browser,
        manifestPath: entry.manifestPath,
        message: `Native host launcher has an unrecognized format at ${launcherPath}. Run \`bbx install --browser ${entry.browser}\` to regenerate it.`,
      });
      continue;
    }

    try {
      await fs.promises.access(launcherTargets.nodePath, executableAccessMode);
    } catch (error) {
      issues.push({
        browser: entry.browser,
        manifestPath: entry.manifestPath,
        message: `Node executable referenced by the native host launcher is not usable at ${launcherTargets.nodePath}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    try {
      await fs.promises.access(launcherTargets.hostPath, fs.constants.F_OK);
    } catch (error) {
      issues.push({
        browser: entry.browser,
        manifestPath: entry.manifestPath,
        message: `Native host script referenced by the launcher is missing at ${launcherTargets.hostPath}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return issues;
}

/**
 * Check the bridge home dir and the daemon files inside it for writability.
 * Root-owned files (typically left behind by a sudo install or a sudo `bbx`
 * run) make the daemon crash-loop, so doctor must call them out explicitly.
 *
 * @returns {Promise<string[]>} paths that exist but are not writable
 */
export async function checkUnwritableBridgePaths() {
  // The root-owned-files scenario comes from sudo installs, which do not exist
  // on Windows - and fs.access(W_OK) there only reflects the read-only file
  // attribute, so it would produce false positives.
  if (os.platform() === 'win32') {
    return [];
  }

  const candidates = [getBridgeDir(), getDaemonPidPath(), getDaemonLogPath()];
  candidates.push(getSocketPath());

  /** @type {string[]} */
  const unwritable = [];
  for (const candidate of candidates) {
    try {
      await fs.promises.access(candidate, fs.constants.W_OK);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') {
        unwritable.push(candidate);
      }
    }
  }
  return unwritable;
}

/**
 * Doctor must never restart a daemon while it is inspecting version drift.
 *
 * @template T
 * @param {(client: BridgeClient) => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function withDoctorBridgeClient(callback) {
  const client = new BridgeClient({ restartDaemonOnVersionMismatch: false });
  try {
    await ensureClientConnected(client);
    return await callback(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function boundedCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(MAX_DOCTOR_COUNT, Math.trunc(value))
    : 0;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function safeVersion(value) {
  return typeof value === 'string' && value.length <= 32 && SAFE_VERSION_RE.test(value)
    ? value
    : null;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function safeVersions(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  /** @type {Set<string>} */
  const versions = new Set();
  for (const candidate of value) {
    const version = safeVersion(candidate);
    if (version) {
      versions.add(version);
    }
    if (versions.size === 10) {
      break;
    }
  }
  return [...versions];
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareVersions(left, right) {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) {
      return difference > 0 ? 1 : -1;
    }
  }
  return 0;
}

/**
 * Convert untrusted daemon log entries into a fixed allowlisted shape. Raw
 * messages are inspected only to derive known cause categories and are never
 * returned.
 *
 * @param {unknown} value
 * @returns {DoctorRecentEvent['cause'] | undefined}
 */
function classifyRecentCause(value) {
  const entry = asRecord(value);
  if (!entry) {
    return undefined;
  }
  const error = asRecord(entry.error);
  const candidates = [
    entry.cause,
    entry.reason,
    entry.errorCode,
    entry.code,
    entry.message,
    entry.summary,
    error?.code,
    error?.message,
  ]
    .filter((candidate) => typeof candidate === 'string')
    .map((candidate) => candidate.slice(0, 200))
    .join(' ')
    .slice(0, 1000);
  if (/another debugger|debugger.{0,40}(?:already attached|conflict|in use)/iu.test(candidates)) {
    return 'debugger_conflict';
  }
  if (/debugger.{0,40}detach|detach.{0,40}debugger/iu.test(candidates)) {
    return 'debugger_detached';
  }
  if (/DIALOG_ACTION_CONFLICT/iu.test(candidates)) {
    return 'dialog_conflict';
  }
  if (/EXTENSION_DISCONNECTED|extension.{0,40}disconnect/iu.test(candidates)) {
    return 'extension_disconnected';
  }
  if (/TAB_MISMATCH|wrong.{0,20}window|enabled window.{0,30}mismatch/iu.test(candidates)) {
    return 'wrong_window';
  }
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {DoctorRecentEvent[]}
 */
function summarizeRecentEvents(value) {
  const result = asRecord(value);
  const entries = Array.isArray(result?.entries)
    ? result.entries
        .slice(-DOCTOR_LOG_LIMIT)
        .filter((candidate) => {
          const entry = asRecord(candidate);
          return !DOCTOR_DIAGNOSTIC_METHODS.has(
            typeof entry?.method === 'string' ? entry.method : ''
          );
        })
        .slice(-DOCTOR_RECENT_EVENT_LIMIT)
    : [];
  /** @type {DoctorRecentEvent[]} */
  const events = [];
  for (const candidate of entries) {
    const entry = asRecord(candidate);
    if (!entry) {
      continue;
    }
    /** @type {DoctorRecentEvent} */
    const event = {};
    if (typeof entry.at === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(entry.at)) {
      const timestamp = Date.parse(entry.at);
      if (Number.isFinite(timestamp)) {
        event.at = new Date(timestamp).toISOString();
      }
    }
    if (typeof entry.method === 'string' && BRIDGE_METHOD_SET.has(entry.method)) {
      event.method = /** @type {BridgeMethod} */ (entry.method);
    }
    if (typeof entry.ok === 'boolean') {
      event.ok = entry.ok;
    }
    if (entry.source === 'cli' || entry.source === 'mcp') {
      event.source = entry.source;
    }
    event.cause = classifyRecentCause(entry);
    if (Object.values(event).some((field) => field !== undefined)) {
      events.push(event);
    }
  }
  return events;
}

/**
 * @param {unknown} value
 * @returns {import('./types.js').DoctorDaemonMetrics | null}
 */
function summarizeMetrics(value) {
  const metrics = asRecord(value);
  if (!metrics) {
    return null;
  }
  return {
    uptimeMs: boundedCount(metrics.uptimeMs),
    activeAgents: boundedCount(metrics.activeAgents),
    activeExtensions: boundedCount(metrics.activeExtensions),
    pendingRequests: boundedCount(metrics.pendingRequests),
    requestsProcessed: boundedCount(metrics.requestsProcessed),
    requestsFailed: boundedCount(metrics.requestsFailed),
    avgResponseTimeMs: boundedCount(metrics.avgResponseTimeMs),
  };
}

/**
 * @param {unknown} value
 * @param {'daemon' | 'direct'} source
 * @returns {import('./types.js').DoctorSetupSummary | null}
 */
function summarizeSetupStatus(value, source) {
  const status = asRecord(value);
  if (
    (status?.scope !== 'global' && status?.scope !== 'local') ||
    !Array.isArray(status.mcpClients) ||
    !Array.isArray(status.skillTargets)
  ) {
    return null;
  }
  const mcpClients = status.mcpClients.slice(0, DOCTOR_SETUP_ENTRY_LIMIT).map(asRecord);
  const skillTargets = status.skillTargets.slice(0, DOCTOR_SETUP_ENTRY_LIMIT).map(asRecord);
  return {
    source,
    scope: status.scope,
    mcp: {
      detected: boundedCount(mcpClients.filter((client) => client?.detected === true).length),
      configured: boundedCount(mcpClients.filter((client) => client?.configured === true).length),
    },
    skills: {
      detected: boundedCount(skillTargets.filter((target) => target?.detected === true).length),
      installed: boundedCount(skillTargets.filter((target) => target?.installed === true).length),
      managed: boundedCount(skillTargets.filter((target) => target?.managed === true).length),
      updatesAvailable: boundedCount(
        skillTargets.filter((target) => target?.updateAvailable === true).length
      ),
    },
  };
}

/**
 * @param {Record<string, unknown> | null} health
 * @returns {import('./types.js').DoctorDebuggerDiagnostics}
 */
function summarizeDebugger(health) {
  const debuggerHealth = asRecord(health?.debugger);
  const captureHealth = asRecord(health?.capture);
  const rawState = debuggerHealth?.state ?? debuggerHealth?.status ?? health?.debuggerState;
  /** @type {import('./types.js').DoctorDebuggerDiagnostics['state']} */
  let state =
    typeof rawState === 'string' && SAFE_DEBUGGER_STATES.has(rawState)
      ? /** @type {'idle' | 'active' | 'conflict' | 'detached'} */ (rawState)
      : 'unknown';
  if (debuggerHealth?.conflict === true) {
    state = 'conflict';
  }

  const attachedTabs = debuggerHealth?.attachedTabs;
  const attachedTabCount = Array.isArray(attachedTabs)
    ? boundedCount(attachedTabs.length)
    : typeof debuggerHealth?.attachedTabCount === 'number'
      ? boundedCount(debuggerHealth.attachedTabCount)
      : null;
  const heldTabCount =
    typeof debuggerHealth?.heldTabCount === 'number'
      ? boundedCount(debuggerHealth.heldTabCount)
      : null;
  const pendingTabCount =
    typeof debuggerHealth?.pendingTabCount === 'number'
      ? boundedCount(debuggerHealth.pendingTabCount)
      : null;
  const recentReason =
    typeof debuggerHealth?.recentReason === 'string' &&
    SAFE_DEBUGGER_REASONS.has(debuggerHealth.recentReason)
      ? /** @type {import('./types.js').DoctorDebuggerDiagnostics['recentReason']} */ (
          debuggerHealth.recentReason
        )
      : null;
  const rawCaptureState =
    captureHealth?.state ?? debuggerHealth?.captureState ?? health?.captureState;
  const captureState =
    typeof rawCaptureState === 'string' && SAFE_CAPTURE_STATES.has(rawCaptureState)
      ? /** @type {import('./types.js').DoctorDebuggerDiagnostics['captureState']} */ (
          rawCaptureState
        )
      : 'unknown';
  const captureActiveTabCount =
    typeof captureHealth?.activeTabCount === 'number'
      ? boundedCount(captureHealth.activeTabCount)
      : null;
  const captureOwnershipCount =
    typeof captureHealth?.ownershipCount === 'number'
      ? boundedCount(captureHealth.ownershipCount)
      : null;
  const captureInflightCount =
    typeof captureHealth?.inflightCount === 'number'
      ? boundedCount(captureHealth.inflightCount)
      : null;
  const interceptionActiveTabCount =
    typeof captureHealth?.interceptionActiveTabCount === 'number'
      ? boundedCount(captureHealth.interceptionActiveTabCount)
      : null;
  const interceptionRuleCount =
    typeof captureHealth?.interceptionRuleCount === 'number'
      ? boundedCount(captureHealth.interceptionRuleCount)
      : null;
  return {
    state,
    attachedTabCount,
    heldTabCount,
    pendingTabCount,
    recentReason,
    captureState,
    captureActiveTabCount,
    captureOwnershipCount,
    captureInflightCount,
    interceptionActiveTabCount,
    interceptionRuleCount,
  };
}

/**
 * @param {Record<string, unknown> | null} health
 * @param {boolean} extensionConnected
 * @returns {import('./types.js').DoctorProtocolDiagnostics}
 */
function summarizeProtocol(health, extensionConnected) {
  const clientVersion = getProtocolVersion();
  const advertisedDaemonVersions = safeVersions(health?.daemon_supported_versions);
  const daemonSupportedVersions =
    advertisedDaemonVersions.length > 0 || extensionConnected
      ? advertisedDaemonVersions
      : safeVersions(health?.supported_versions);
  const extensionSupportedVersions = extensionConnected
    ? Array.isArray(health?.extension_supported_versions)
      ? safeVersions(health.extension_supported_versions)
      : safeVersions(health?.supported_versions)
    : [];
  const daemonCompatible = daemonSupportedVersions.length
    ? daemonSupportedVersions.includes(clientVersion)
    : null;
  const extensionCompatible = extensionConnected
    ? extensionSupportedVersions.length
      ? extensionSupportedVersions.includes(clientVersion)
      : null
    : null;
  const knownCompatibility = [daemonCompatible, extensionCompatible].filter(
    (value) => value !== null
  );
  const compatible = knownCompatibility.includes(false)
    ? false
    : knownCompatibility.length
      ? true
      : null;

  /** @type {import('./types.js').DoctorProtocolDiagnostics['migration']} */
  let migration = compatible === true ? 'none' : 'unknown';
  const latestExtension = extensionSupportedVersions[0];
  const latestDaemon = daemonSupportedVersions[0];
  if (extensionCompatible === false && latestExtension) {
    migration =
      compareVersions(latestExtension, clientVersion) > 0 ? 'update_client' : 'update_extension';
  } else if (daemonCompatible === false && latestDaemon) {
    migration =
      compareVersions(latestDaemon, clientVersion) > 0 ? 'update_client' : 'restart_daemon';
  }

  return {
    clientVersion,
    daemonVersion: safeVersion(health?.daemonVersion),
    daemonSupportedVersions,
    extensionSupportedVersions,
    daemonCompatible,
    extensionCompatible,
    compatible,
    migration,
  };
}

/**
 * @param {DoctorReportOptions} [options={}]
 * @returns {Promise<DoctorReport>}
 */
export async function getDoctorReport(options = {}) {
  const manifest = await (options.loadManifest || loadInstalledManifest)();
  const allowedOrigins = Array.isArray(manifest?.allowed_origins) ? manifest.allowed_origins : [];
  const defaultExtensionId = options.defaultExtensionIdInfo || resolveDefaultExtensionId();

  const browserManifests = await (options.checkBrowserManifests || checkBrowserManifests)();
  const nativeHostManifestIssues = await (
    options.checkNativeHostManifestHealth || checkNativeHostManifestHealth
  )(browserManifests);
  const daemonRestarts = summarizeDaemonRestarts(
    await (options.readDaemonStartHistory || readDaemonStartHistory)()
  );
  const unwritableBridgePaths = await (
    options.checkUnwritableBridgePaths || checkUnwritableBridgePaths
  )();
  const manifestInstalled = Boolean(manifest) || browserManifests.some((b) => b.installed);
  const chromiumSandboxedManifestInstalled = browserManifests.some(
    (entry) =>
      entry.installed &&
      entry.browser === 'chromium' &&
      CHROMIUM_SANDBOXED_MANIFEST_RE.test(entry.manifestPath)
  );

  /** @type {'socket' | 'tcp' | 'unknown'} */
  let transportKind = 'unknown';
  let proxyConfigured = false;
  /** @type {string[]} */
  const diagnosticFailures = [];
  /** @type {string[]} */
  let installedExtensionIds = [];
  try {
    installedExtensionIds = await (options.readInstalledExtensionIds || readInstalledExtensionIds)(
      browserManifests
    );
    installedExtensionIds = installedExtensionIds
      .filter((extensionId) => CHROME_EXTENSION_ID_RE.test(extensionId))
      .slice(0, DOCTOR_SETUP_ENTRY_LIMIT);
  } catch {
    diagnosticFailures.push('manifest_identity_unavailable');
  }
  try {
    transportKind = (options.getLocalTransport || getBridgeTransport)().type;
  } catch {
    diagnosticFailures.push('transport_config_unavailable');
  }
  try {
    proxyConfigured = Boolean((options.readProxyConfig || readProxyConfig)());
  } catch {
    diagnosticFailures.push('proxy_config_unavailable');
  }

  /** @type {import('./types.js').DoctorRemoteDiagnostics} */
  let remoteDestinations = {
    configuredCount: 0,
    status: 'not_configured',
    credentials: 'not_configured',
  };
  try {
    const remoteConfig = await (options.readRemoteConfig || readRemoteConfig)();
    const configuredCount = remoteConfig.remotes.length;
    remoteDestinations = {
      configuredCount,
      status: configuredCount > 0 ? 'not_probed_local_only' : 'not_configured',
      credentials: configuredCount > 0 ? 'unverified' : 'not_configured',
    };
  } catch {
    diagnosticFailures.push('remote_config_unavailable');
    remoteDestinations.status = 'config_unavailable';
  }

  /** @type {DoctorReport} */
  const report = {
    manifestInstalled,
    manifestPath: options.manifestPath || getManifestPath(),
    allowedOrigins,
    defaultExtensionId: defaultExtensionId.extensionId,
    defaultExtensionIdSource: defaultExtensionId.source,
    daemonReachable: false,
    healthAvailable: false,
    extensionConnected: false,
    accessEnabled: false,
    enabledWindowId: null,
    routeTabId: null,
    routeReady: false,
    routeReason: 'access_disabled',
    daemonRestarts,
    daemonLogPath: getDaemonLogPath(),
    unwritableBridgePaths,
    nativeHostManifestIssues,
    issues: [],
    nextSteps: [],
    browserManifests,
    transport: {
      kind: transportKind,
      local: true,
      status: 'offline',
      proxyConfigured,
      proxyExposed: null,
      credentials: transportKind === 'socket' ? 'not_required' : 'unknown',
    },
    connections: {
      extensionCount: 0,
      profileCount: 0,
    },
    protocol: summarizeProtocol(null, false),
    debugger: summarizeDebugger(null),
    metrics: null,
    recentEvents: [],
    recentCauses: [],
    setup: null,
    remoteDestinations,
    diagnosticFailures,
  };

  /** @type {Record<string, unknown> | null} */
  let healthResult = null;
  /** @type {unknown} */
  let setupStatus = null;
  /** @type {Record<string, unknown> | null} */
  let metricsResult = null;
  /** @type {Record<string, unknown> | null} */
  let logsResult = null;
  /** @type {unknown} */
  let connectionError = null;

  try {
    await (options.bridgeClientRunner || withDoctorBridgeClient)(async (client) => {
      report.daemonReachable = true;
      /**
       * @param {BridgeMethod} method
       * @param {Record<string, unknown>} [params]
       * @returns {Promise<Record<string, unknown> | null>}
       */
      async function requestDiagnostic(method, params = {}) {
        try {
          const response = await client.request({ method, params });
          if (!response.ok) {
            diagnosticFailures.push(`${method}_failed`);
            return null;
          }
          report.daemonReachable = true;
          return asRecord(response.result);
        } catch {
          diagnosticFailures.push(`${method}_failed`);
          return null;
        }
      }

      healthResult = await requestDiagnostic('health.ping');
      if (options.includeSetupStatus !== false) {
        const setupResult = await requestDiagnostic('setup.get_status');
        if (setupResult) {
          setupStatus = setupResult;
        }
      }
      logsResult = await requestDiagnostic('log.tail', { limit: DOCTOR_LOG_LIMIT });
      metricsResult = await requestDiagnostic('daemon.metrics');
    });
  } catch (error) {
    connectionError = error;
    diagnosticFailures.push('daemon_connection_failed');
  }

  if (!report.daemonReachable && options.includeSetupStatus !== false) {
    try {
      setupStatus = await (options.collectSetupStatus || collectSetupStatus)();
      const summary = summarizeSetupStatus(setupStatus, 'direct');
      if (summary) {
        report.setup = summary;
      } else {
        diagnosticFailures.push('setup_status_invalid');
      }
    } catch {
      diagnosticFailures.push('setup_direct_failed');
    }
  } else if (setupStatus) {
    const summary = summarizeSetupStatus(setupStatus, 'daemon');
    if (summary) {
      report.setup = summary;
    } else {
      diagnosticFailures.push('setup_status_invalid');
    }
  }

  const connectionMessage =
    connectionError instanceof Error ? connectionError.message.slice(0, 200) : '';
  const authenticationFailed = /authentication failed|access denied|invalid.{0,20}token/iu.test(
    connectionMessage
  );
  report.transport.status = authenticationFailed
    ? 'authentication_failed'
    : report.daemonReachable
      ? 'reachable'
      : 'offline';
  report.transport.credentials =
    transportKind === 'socket'
      ? 'not_required'
      : authenticationFailed
        ? 'rejected'
        : report.daemonReachable
          ? 'accepted'
          : 'unknown';

  const resolvedHealth = /** @type {Record<string, unknown> | null} */ (
    /** @type {unknown} */ (healthResult)
  );
  report.healthAvailable = resolvedHealth?.daemon === 'ok';
  if (
    report.daemonReachable &&
    !report.healthAvailable &&
    !diagnosticFailures.includes('health.ping_failed')
  ) {
    diagnosticFailures.push('health.ping_invalid');
  }
  const healthAccess = report.healthAvailable ? asRecord(resolvedHealth?.access) : null;
  if (report.healthAvailable) {
    report.extensionConnected = resolvedHealth?.extensionConnected === true;
    report.accessEnabled = healthAccess?.enabled === true;
    report.enabledWindowId =
      typeof healthAccess?.windowId === 'number' ? boundedCount(healthAccess.windowId) : null;
    report.routeTabId =
      typeof healthAccess?.routeTabId === 'number' ? boundedCount(healthAccess.routeTabId) : null;
    report.routeReady = healthAccess?.routeReady === true;
    report.routeReason =
      typeof healthAccess?.reason === 'string' && SAFE_ROUTE_REASONS.has(healthAccess.reason)
        ? healthAccess.reason
        : 'access_disabled';
  }

  const connectedExtensions =
    report.healthAvailable && Array.isArray(resolvedHealth?.connectedExtensions)
      ? resolvedHealth.connectedExtensions.slice(0, 100)
      : [];
  let profileCount = 0;
  for (const extension of connectedExtensions) {
    const extensionRecord = asRecord(extension);
    if (typeof extensionRecord?.profileLabel === 'string' && extensionRecord.profileLabel) {
      profileCount += 1;
    }
  }
  report.metrics = summarizeMetrics(metricsResult);
  report.connections.extensionCount = connectedExtensions.length
    ? connectedExtensions.length
    : report.metrics?.activeExtensions || (report.extensionConnected ? 1 : 0);
  report.connections.profileCount = profileCount;
  if (report.healthAvailable && report.connections.extensionCount > 0) {
    report.extensionConnected = true;
  }

  const proxyHealth = report.healthAvailable ? asRecord(resolvedHealth?.proxy) : null;
  report.transport.proxyConfigured = proxyConfigured;
  report.transport.proxyExposed =
    typeof proxyHealth?.enabled === 'boolean' ? proxyHealth.enabled : null;
  report.protocol = summarizeProtocol(
    report.healthAvailable ? resolvedHealth : null,
    report.extensionConnected
  );
  report.recentEvents = summarizeRecentEvents(logsResult);
  report.recentCauses = [
    ...new Set(
      report.recentEvents.map((event) => event.cause).filter((cause) => cause !== undefined)
    ),
  ];
  report.debugger = summarizeDebugger(report.healthAvailable ? resolvedHealth : null);
  if (report.debugger.recentReason && !report.recentCauses.includes(report.debugger.recentReason)) {
    report.recentCauses.push(report.debugger.recentReason);
  }

  // Keep optional diagnostics deterministic even if several RPCs fail.
  report.diagnosticFailures = [...new Set(diagnosticFailures)].slice(0, 12);

  const connectedBrowserExtensionIds = connectedExtensions
    .map((extension) => asRecord(extension)?.browserExtensionId)
    .filter(
      (extensionId) => typeof extensionId === 'string' && CHROME_EXTENSION_ID_RE.test(extensionId)
    );
  const extensionIdentityMismatch =
    connectedBrowserExtensionIds.length > 0 &&
    installedExtensionIds.length > 0 &&
    connectedBrowserExtensionIds.some(
      (extensionId) => !installedExtensionIds.includes(/** @type {string} */ (extensionId))
    );

  if (authenticationFailed) {
    report.issues.push('proxy_credentials_stale');
    report.nextSteps.push(
      'Local TCP authentication failed. Run `bbx proxy enable --rotate-token`, restart the daemon, and update configured remote clients with `bbx remote add`.'
    );
  }

  if (unwritableBridgePaths.length > 0) {
    report.issues.push('bridge_files_not_writable');
    report.nextSteps.push(
      `These Browser Bridge files are not writable by the current user (usually caused by installing or running bbx with sudo): ${unwritableBridgePaths.join(', ')}. Fix ownership with: sudo chown -R "$USER" "${getBridgeDir()}"`
    );
  }
  if (nativeHostManifestIssues.length > 0) {
    report.issues.push('native_host_manifest_invalid');
    report.nextSteps.push(
      `The native host manifest or launcher is broken: ${nativeHostManifestIssues.map((issue) => issue.message).join(' ')} Reinstall the native host with \`bbx install --browser <browser>\` or \`bbx install --all\`.`
    );
  }
  if (daemonRestarts.restartLoop) {
    report.issues.push('daemon_restart_loop');
    report.nextSteps.push(
      `The bridge daemon started ${daemonRestarts.startsInWindow} times in the last ${Math.round(daemonRestarts.windowMs / 1000)}s, which means it keeps crashing shortly after startup. Check the daemon log for the underlying error: ${report.daemonLogPath}`
    );
  }
  if (!report.manifestInstalled) {
    report.issues.push('native_host_manifest_missing');
    report.nextSteps.push(
      defaultExtensionId.extensionId
        ? 'Run `bbx install` (or `bbx install --all` for all browsers) to install the native host manifest.'
        : 'Run `bbx install <extension-id>` (or `bbx install --all`) to install the native host manifest.'
    );
  }
  if (!report.daemonReachable && !authenticationFailed) {
    report.issues.push('daemon_offline');
    report.nextSteps.push('Run `bbx-daemon` and retry `bbx status` or `bbx doctor`.');
  }
  if (report.daemonReachable && !report.healthAvailable) {
    report.issues.push('health_unavailable');
    report.nextSteps.push(
      'The daemon is reachable but `health.ping` did not return valid core health. Run `bbx restart`, then update the Browser Bridge CLI and extension if the health check still fails.'
    );
  }
  if (report.healthAvailable && extensionIdentityMismatch) {
    report.issues.push('extension_id_mismatch');
    report.nextSteps.push(
      'A connected Chrome extension ID is not allowed by any installed native host manifest. Reinstall the matching browser manifest with `bbx install --browser <browser>` and reload that extension.'
    );
  }
  if (report.healthAvailable && !report.extensionConnected) {
    report.issues.push('extension_disconnected');
    if (chromiumSandboxedManifestInstalled) {
      report.issues.push('chromium_sandboxed_native_host_limited');
      report.nextSteps.push(
        "Detected a sandboxed Chromium native host manifest for snap or Flatpak. Sandboxed Chromium may not be able to launch Browser Bridge's Node-based native host; use Google Chrome, Brave, or Edge from a non-sandboxed package and run `bbx install --browser <browser>`."
      );
    }
    report.nextSteps.push(
      'Open Chrome and make sure the Browser Bridge extension is installed and active. If Chrome reports a missing native host, run `bbx install --all` and reload the extension.'
    );
  }
  if (report.healthAvailable && report.extensionConnected && !report.accessEnabled) {
    if (report.routeReason === 'enabled_window_missing') {
      report.issues.push('enabled_window_missing');
      report.nextSteps.push(
        'The previously enabled window no longer exists. Focus the intended Chrome window and click Enable in the Browser Bridge popup or side panel.'
      );
    } else {
      report.issues.push('access_disabled');
      report.nextSteps.push(
        'If a Browser Bridge call returns ACCESS_DENIED, stop requesting access. Ask the user to focus the needed Chrome window and click Enable for the needed window, then tell you when that window is ready.'
      );
    }
  } else if (report.healthAvailable && report.extensionConnected && !report.routeReady) {
    report.issues.push(report.routeReason || 'no_routable_active_tab');
    report.nextSteps.push(
      'Switch to a supported page in the enabled window, or use an explicit tabId override.'
    );
  }

  if (report.protocol.compatible === false) {
    report.issues.push('protocol_mismatch');
    if (report.protocol.migration === 'update_extension') {
      report.nextSteps.push(
        'Update or reload the Browser Bridge extension so it supports the client protocol, then retry `bbx doctor`.'
      );
    } else if (report.protocol.migration === 'restart_daemon') {
      report.nextSteps.push(
        'Run `bbx restart` to replace the stale daemon with this installed CLI version, then retry `bbx doctor`.'
      );
    } else {
      report.nextSteps.push(
        'Update the Browser Bridge CLI/npm package, run `bbx restart`, and retry `bbx doctor`.'
      );
    }
  }

  if (report.debugger.state === 'conflict') {
    report.issues.push('debugger_conflict');
  }
  if (report.debugger.state === 'conflict' || report.recentCauses.includes('debugger_conflict')) {
    report.nextSteps.push(
      'Close DevTools or any other debugger attached to the target tab, then retry the debugger-backed Browser Bridge operation.'
    );
  } else if (
    report.debugger.state === 'detached' ||
    report.recentCauses.includes('debugger_detached')
  ) {
    report.nextSteps.push(
      'A recent debugger session detached. Keep the target tab open and retry the debugger-backed operation; close competing debuggers if detaches continue.'
    );
  }

  if (report.recentCauses.includes('wrong_window')) {
    report.nextSteps.push(
      'A recent request targeted the wrong window. Focus the intended Chrome window, click Enable there, and retry without reusing a tabId from another window.'
    );
  }

  return {
    ...report,
    manifestPath: sanitizeDoctorPath(report.manifestPath),
    daemonLogPath: sanitizeDoctorPath(report.daemonLogPath),
    unwritableBridgePaths: report.unwritableBridgePaths.map(sanitizeDoctorPath),
    nativeHostManifestIssues: report.nativeHostManifestIssues.map((issue) => ({
      ...issue,
      manifestPath: sanitizeDoctorPath(issue.manifestPath),
      message: sanitizeIncidentalText(issue.message),
    })),
    browserManifests: report.browserManifests.map((browser) => ({
      ...browser,
      manifestPath: sanitizeDoctorPath(browser.manifestPath),
    })),
    nextSteps: report.nextSteps.map((step) => sanitizeIncidentalText(step)),
  };
}

/** @param {string} value */
function sanitizeDoctorPath(value) {
  return value ? sanitizeIncidentalPath(value) : '';
}
