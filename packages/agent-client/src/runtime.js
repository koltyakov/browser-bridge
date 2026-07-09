// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  APP_NAME,
  getBridgeDir,
  getDaemonLogPath,
  getDaemonPidPath,
  getManifestInstallDir,
  getSocketPath,
  SUPPORTED_BROWSERS,
} from '../../native-host/src/config.js';
import {
  readDaemonStartHistory,
  summarizeDaemonRestarts,
} from '../../native-host/src/daemon-process.js';
import { resolveDefaultExtensionId } from '../../native-host/src/install-manifest.js';
import { methodNeedsTab } from './cli-helpers.js';
import { BridgeClient } from './client.js';

/** @typedef {import('./types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('./types.js').BridgeMeta} BridgeMeta */
/** @typedef {import('./types.js').BridgeRequestSource} BridgeRequestSource */
/** @typedef {import('./types.js').BridgeResponse} BridgeResponse */
/** @typedef {import('../../native-host/src/config.js').SupportedBrowser} SupportedBrowser */
/** @typedef {import('./types.js').BrowserManifestStatus} BrowserManifestStatus */
/** @typedef {import('./types.js').DoctorReport} DoctorReport */
/** @typedef {import('./types.js').DoctorReportOptions} DoctorReportOptions */

const CHROMIUM_SANDBOXED_MANIFEST_RE =
  /(?:^|[/\\])(?:snap[/\\]chromium|\.var[/\\]app[/\\]org\.chromium\.Chromium)[/\\]/;

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
  return client.request({
    method,
    params,
    tabId: methodNeedsTab(method) ? (options.tabId ?? null) : null,
    meta: withRequestMeta(options.source, options.tokenBudget),
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
    throw new Error(response.error.message);
  }

  const result = /** @type {{ nodes: Array<{ elementRef: string }> }} */ (response.result);
  if (!result.nodes || result.nodes.length === 0) {
    throw new Error(`No element found for selector "${refOrSelector}".`);
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
 * @returns {Promise<T>}
 */
export async function withBridgeClient(callback) {
  const client = new BridgeClient();
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
 * Check the bridge home dir and the daemon files inside it for writability.
 * Root-owned files (typically left behind by a sudo install or a sudo `bbx`
 * run) make the daemon crash-loop, so doctor must call them out explicitly.
 *
 * @returns {Promise<string[]>} paths that exist but are not writable
 */
export async function checkUnwritableBridgePaths() {
  // The root-owned-files scenario comes from sudo installs, which do not exist
  // on Windows — and fs.access(W_OK) there only reflects the read-only file
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
 * @param {DoctorReportOptions} [options={}]
 * @returns {Promise<DoctorReport>}
 */
export async function getDoctorReport(options = {}) {
  const manifest = await (options.loadManifest || loadInstalledManifest)();
  const allowedOrigins = Array.isArray(manifest?.allowed_origins) ? manifest.allowed_origins : [];
  const defaultExtensionId = options.defaultExtensionIdInfo || resolveDefaultExtensionId();

  const browserManifests = await (options.checkBrowserManifests || checkBrowserManifests)();
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

  /** @type {DoctorReport} */
  const report = {
    manifestInstalled,
    manifestPath: options.manifestPath || getManifestPath(),
    allowedOrigins,
    defaultExtensionId: defaultExtensionId.extensionId,
    defaultExtensionIdSource: defaultExtensionId.source,
    daemonReachable: false,
    extensionConnected: false,
    accessEnabled: false,
    enabledWindowId: null,
    routeTabId: null,
    routeReady: false,
    routeReason: 'access_disabled',
    daemonRestarts,
    daemonLogPath: getDaemonLogPath(),
    unwritableBridgePaths,
    issues: [],
    nextSteps: [],
    browserManifests,
  };

  try {
    await (options.bridgeClientRunner || withBridgeClient)(async (client) => {
      const response = await client.request({ method: 'health.ping' });
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      const result =
        /** @type {{ daemon?: string, extensionConnected?: boolean, access?: {
        enabled?: boolean,
        windowId?: number | null,
        routeTabId?: number | null,
        routeReady?: boolean,
        reason?: string
      } }} */ (response.result);
      report.daemonReachable = result.daemon === 'ok';
      report.extensionConnected = result.extensionConnected === true;
      report.accessEnabled = result.access?.enabled === true;
      report.enabledWindowId =
        typeof result.access?.windowId === 'number' ? result.access.windowId : null;
      report.routeTabId =
        typeof result.access?.routeTabId === 'number' ? result.access.routeTabId : null;
      report.routeReady = result.access?.routeReady === true;
      report.routeReason =
        typeof result.access?.reason === 'string' ? result.access.reason : 'access_disabled';
    });
  } catch {
    report.daemonReachable = false;
    report.extensionConnected = false;
  }

  if (unwritableBridgePaths.length > 0) {
    report.issues.push('bridge_files_not_writable');
    report.nextSteps.push(
      `These Browser Bridge files are not writable by the current user (usually caused by installing or running bbx with sudo): ${unwritableBridgePaths.join(', ')}. Fix ownership with: sudo chown -R "$USER" "${getBridgeDir()}"`
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
  if (!report.daemonReachable) {
    report.issues.push('daemon_offline');
    report.nextSteps.push('Run `bbx-daemon` and retry `bbx status` or `bbx doctor`.');
  }
  if (report.daemonReachable && !report.extensionConnected) {
    report.issues.push('extension_disconnected');
    if (chromiumSandboxedManifestInstalled) {
      report.issues.push('chromium_sandboxed_native_host_limited');
      report.nextSteps.push(
        "Detected a sandboxed Chromium native host manifest for snap or Flatpak. Sandboxed Chromium may not be able to launch Browser Bridge's Node-based native host; use Google Chrome, Brave, or Edge from a non-sandboxed package and run `bbx install --browser <browser>`."
      );
    }
    report.nextSteps.push(
      'Open Chrome and make sure the Browser Bridge extension is installed and active.'
    );
  }
  if (report.daemonReachable && report.extensionConnected && !report.accessEnabled) {
    report.issues.push('access_disabled');
    report.nextSteps.push(
      'If a Browser Bridge call returns ACCESS_DENIED, stop requesting access. Ask the user to click Enable for the needed window, then tell you when that window is ready.'
    );
  } else if (report.daemonReachable && report.extensionConnected && !report.routeReady) {
    report.issues.push(report.routeReason || 'no_routable_active_tab');
    report.nextSteps.push(
      'Switch to a supported page in the enabled window, or use an explicit tabId override.'
    );
  }

  return report;
}
