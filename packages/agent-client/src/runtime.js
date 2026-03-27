// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import { APP_NAME, getManifestInstallDir } from '../../native-host/src/config.js';
import { resolveDefaultExtensionId } from '../../native-host/src/install-manifest.js';
import { methodNeedsSession } from './cli-helpers.js';
import { BridgeClient } from './client.js';
import { clearSession, loadSession, saveSession } from './session-store.js';

/** @typedef {import('../../protocol/src/types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('../../protocol/src/types.js').BridgeMeta} BridgeMeta */
/** @typedef {import('../../protocol/src/types.js').BridgeRequestSource} BridgeRequestSource */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */
/** @typedef {import('../../protocol/src/types.js').SessionState} SessionState */

/**
 * @typedef {{
 *   manifestInstalled: boolean,
 *   manifestPath: string,
 *   allowedOrigins: string[],
 *   defaultExtensionId: string | null,
 *   defaultExtensionIdSource: string,
 *   daemonReachable: boolean,
 *   extensionConnected: boolean,
 *   savedSession: SessionState | null,
 *   activeSession: SessionState | null,
 *   issues: string[],
 *   nextSteps: string[]
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
 * @param {{ source?: BridgeRequestSource }} [options]
 * @returns {Promise<SessionState>}
 */
export async function requireSession(client, options = {}) {
  await ensureClientConnected(client);

  const session = await loadSession();
  if (!session?.sessionId) {
    throw new Error('No active saved session. Enable agent communication for the tab in the extension and run `request-access` first.');
  }

  const status = await client.request({
    method: 'session.get_status',
    sessionId: session.sessionId,
    meta: withRequestMeta(options.source, null)
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
    },
    meta: withRequestMeta(options.source, null)
  });
  if (!refreshed.ok) {
    throw new Error(refreshed.error.message);
  }

  const renewedSession = /** @type {SessionState} */ (refreshed.result);
  await saveSession(renewedSession);
  return renewedSession;
}

/**
 * @param {BridgeClient} client
 * @param {BridgeMethod} method
 * @param {Record<string, unknown>} [params={}]
 * @param {{ sessionId?: string | null, source?: BridgeRequestSource, tokenBudget?: number | null }} [options]
 * @returns {Promise<BridgeResponse>}
 */
export async function requestBridge(client, method, params = {}, options = {}) {
  await ensureClientConnected(client);
  let sessionId = options.sessionId ?? null;

  if (sessionId == null && methodNeedsSession(method)) {
    sessionId = (await requireSession(client, { source: options.source })).sessionId;
  }

  const response = await client.request({
    method,
    params,
    sessionId,
    meta: withRequestMeta(options.source, options.tokenBudget)
  });

  if (method === 'session.request_access' && response.ok) {
    await saveSession(/** @type {SessionState} */ (response.result));
  }
  if (method === 'session.revoke' && response.ok) {
    await clearSession();
  }

  return response;
}

/**
 * @param {BridgeClient} client
 * @param {string} refOrSelector
 * @param {string | null} [sessionId=null]
 * @param {BridgeRequestSource} [source]
 * @returns {Promise<string>}
 */
export async function resolveRef(client, refOrSelector, sessionId = null, source) {
  if (refOrSelector.startsWith('el_')) {
    return refOrSelector;
  }

  const response = await requestBridge(client, 'dom.query', {
    selector: refOrSelector
  }, { sessionId, source });

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
 * @returns {string}
 */
export function getManifestPath() {
  return path.join(getManifestInstallDir(), `${APP_NAME}.json`);
}

/**
 * @returns {Promise<{allowed_origins?: string[]} | null>}
 */
export async function loadInstalledManifest() {
  try {
    const raw = await fs.promises.readFile(getManifestPath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @typedef {{
 *   loadManifest?: () => Promise<{allowed_origins?: string[]} | null>,
 *   manifestPath?: string,
 *   defaultExtensionIdInfo?: { extensionId: string | null, source: string },
 *   loadSavedSession?: () => Promise<SessionState | null>,
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
  const savedSession = await (options.loadSavedSession || loadSession)();

  /** @type {DoctorReport} */
  const report = {
    manifestInstalled,
    manifestPath: options.manifestPath || getManifestPath(),
    allowedOrigins,
    defaultExtensionId: defaultExtensionId.extensionId,
    defaultExtensionIdSource: defaultExtensionId.source,
    daemonReachable: false,
    extensionConnected: false,
    savedSession,
    activeSession: null,
    issues: [],
    nextSteps: []
  };

  try {
    await (options.bridgeClientRunner || withBridgeClient)(async (client) => {
      const response = await client.request({ method: 'health.ping' });
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      const result = /** @type {{ daemon?: string, extensionConnected?: boolean }} */ (response.result);
      report.daemonReachable = result.daemon === 'ok';
      report.extensionConnected = result.extensionConnected === true;

      if (savedSession?.sessionId) {
        const sessionStatus = await client.request({
          method: 'session.get_status',
          sessionId: savedSession.sessionId
        });
        if (sessionStatus.ok) {
          report.activeSession = /** @type {SessionState} */ (sessionStatus.result);
        }
      }
    });
  } catch {
    report.daemonReachable = false;
    report.extensionConnected = false;
  }

  if (!report.manifestInstalled) {
    report.issues.push('native_host_manifest_missing');
    report.nextSteps.push(defaultExtensionId.extensionId
      ? 'Run `bbx install` to install the native host manifest for the official extension.'
      : 'Run `bbx install <extension-id>` to install the native host manifest.');
  }
  if (!report.daemonReachable) {
    report.issues.push('daemon_offline');
    report.nextSteps.push('Run `bbx-daemon` and retry `bbx status` or `bbx doctor`.');
  }
  if (report.daemonReachable && !report.extensionConnected) {
    report.issues.push('extension_disconnected');
    report.nextSteps.push('Open Chrome and make sure the Browser Bridge extension is installed and active.');
  }
  if (report.daemonReachable && report.extensionConnected && !report.activeSession) {
    report.issues.push('session_not_ready');
    report.nextSteps.push('Enable agent communication for the target tab in the extension UI, then run `bbx request-access`.');
  }

  return report;
}
