// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import { APP_NAME, getManifestInstallDir, SUPPORTED_BROWSERS } from '../../native-host/src/config.js';
import { resolveDefaultExtensionId } from '../../native-host/src/install-manifest.js';
import { methodNeedsTab } from './cli-helpers.js';
import { BridgeClient } from './client.js';

/** @typedef {import('../../protocol/src/types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('../../protocol/src/types.js').BridgeMeta} BridgeMeta */
/** @typedef {import('../../protocol/src/types.js').BridgeRequestSource} BridgeRequestSource */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */
/** @typedef {import('../../native-host/src/config.js').SupportedBrowser} SupportedBrowser */

/**
 * @typedef {{
 *   browser: string,
 *   manifestPath: string,
 *   installed: boolean
 * }} BrowserManifestStatus
 */

/**
 * @typedef {{
 *   manifestInstalled: boolean,
 *   manifestPath: string,
 *   allowedOrigins: string[],
 *   defaultExtensionId: string | null,
 *   defaultExtensionIdSource: string,
 *   daemonReachable: boolean,
 *   extensionConnected: boolean,
 *   accessEnabled: boolean,
 *   enabledWindowId: number | null,
 *   routeTabId: number | null,
 *   routeReady: boolean,
 *   routeReason: string,
 *   issues: string[],
 *   nextSteps: string[],
 *   browserManifests: BrowserManifestStatus[]
 * }} DoctorReport
 */

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
    meta: withRequestMeta(options.source, options.tokenBudget)
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

  const response = await requestBridge(client, 'dom.query', {
    selector: refOrSelector
  }, { tabId, source });

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
 * @param {SupportedBrowser} [browser='chrome']
 * @returns {string}
 */
export function getManifestPath(browser) {
  return path.join(getManifestInstallDir(browser), `${APP_NAME}.json`);
}

/**
 * @param {SupportedBrowser} [browser='chrome']
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
 * @typedef {{
 *   loadManifest?: () => Promise<{allowed_origins?: string[]} | null>,
 *   manifestPath?: string,
 *   defaultExtensionIdInfo?: { extensionId: string | null, source: string },
 *   bridgeClientRunner?: <T>(callback: (client: BridgeClient) => Promise<T>) => Promise<T>
 * }} DoctorReportOptions
 */

/**
 * @param {DoctorReportOptions} [options={}]
 * @returns {Promise<DoctorReport>}
 */
export async function getDoctorReport(options = {}) {
  const manifest = await (options.loadManifest || loadInstalledManifest)();
  const allowedOrigins = Array.isArray(manifest?.allowed_origins)
    ? manifest.allowed_origins
    : [];
  const manifestInstalled = Boolean(manifest);
  const defaultExtensionId = options.defaultExtensionIdInfo || resolveDefaultExtensionId();

  const browserManifests = await checkBrowserManifests();

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
    issues: [],
    nextSteps: [],
    browserManifests
  };

  try {
    await (options.bridgeClientRunner || withBridgeClient)(async (client) => {
      const response = await client.request({ method: 'health.ping' });
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      const result = /** @type {{ daemon?: string, extensionConnected?: boolean, access?: {
        enabled?: boolean,
        windowId?: number | null,
        routeTabId?: number | null,
        routeReady?: boolean,
        reason?: string
      } }} */ (response.result);
      report.daemonReachable = result.daemon === 'ok';
      report.extensionConnected = result.extensionConnected === true;
      report.accessEnabled = result.access?.enabled === true;
      report.enabledWindowId = typeof result.access?.windowId === 'number' ? result.access.windowId : null;
      report.routeTabId = typeof result.access?.routeTabId === 'number' ? result.access.routeTabId : null;
      report.routeReady = result.access?.routeReady === true;
      report.routeReason = typeof result.access?.reason === 'string' ? result.access.reason : 'access_disabled';
    });
  } catch {
    report.daemonReachable = false;
    report.extensionConnected = false;
  }

  const browsersWithoutManifest = browserManifests.filter((b) => !b.installed);

  if (!report.manifestInstalled) {
    report.issues.push('native_host_manifest_missing');
    report.nextSteps.push(defaultExtensionId.extensionId
      ? 'Run `bbx install` (or `bbx install --all` for all browsers) to install the native host manifest.'
      : 'Run `bbx install <extension-id>` (or `bbx install --all`) to install the native host manifest.');
  } else if (browsersWithoutManifest.length > 0) {
    report.issues.push('native_host_manifest_partial');
    const missing = browsersWithoutManifest.map((b) => b.browser).join(', ');
    report.nextSteps.push(`Manifests missing for: ${missing}. Run \`bbx install --all\` to install for all supported browsers.`);
  }
  if (!report.daemonReachable) {
    report.issues.push('daemon_offline');
    report.nextSteps.push('Run `bbx-daemon` and retry `bbx status` or `bbx doctor`.');
  }
  if (report.daemonReachable && !report.extensionConnected) {
    report.issues.push('extension_disconnected');
    report.nextSteps.push('Open Chrome and make sure the Browser Bridge extension is installed and active.');
  }
  if (report.daemonReachable && report.extensionConnected && !report.accessEnabled) {
    report.issues.push('access_disabled');
    report.nextSteps.push('If a Browser Bridge call returns ACCESS_DENIED, stop requesting access. Ask the user to click Enable for the needed window, then tell you when that window is ready.');
  } else if (report.daemonReachable && report.extensionConnected && !report.routeReady) {
    report.issues.push(report.routeReason || 'no_routable_active_tab');
    report.nextSteps.push('Switch to a supported page in the enabled window, or use an explicit tabId override.');
  }

  return report;
}
