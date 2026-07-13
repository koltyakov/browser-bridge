// @ts-check

import {
  BridgeError,
  ERROR_CODES,
  createFailure,
  createSuccess,
  normalizeAccessibilityTreeParams,
  normalizeConsoleParams,
  normalizeNetworkParams,
  normalizeViewportResizeParams,
  normalizeWaitForLoadStateParams,
} from '../../protocol/src/index.js';
import {
  createCdpKeyPressEventPair,
  matchesConsoleLevel,
  simplifyAXNode,
  summarizeTabResult,
} from './background-helpers.js';
import { resolveWindowScopedTab, selectRequestTabCandidate } from './background-routing.js';
import {
  ACCESS_DENIED_REASON_WINDOW_GONE,
  ACCESS_DENIED_REASON_WINDOW_OFF,
} from './background-state.js';

/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */
/** @typedef {import('./background-state.js').ExtensionState} ExtensionState */
/** @typedef {import('./background-state.js').ResolvedTabTarget} ResolvedTabTarget */
/** @typedef {import('./background-state.js').TabChangeInfo} TabChangeInfo */

/**
 * @typedef {{
 *   clearEnabledWindowIfGone: () => Promise<boolean>,
 *   primeTabConsoleCapture: (tabId: number) => Promise<void>,
 *   readConsoleBuffer: (tabId: number, clear: boolean) => Promise<{ entries: Array<{ level: string } & Record<string, unknown>>, dropped: number }>,
 *   ensureNetworkInterceptor: (tabId: number) => Promise<void>,
 *   readNetworkBuffer: (tabId: number, clear: boolean) => Promise<{ entries: Array<{ url: string } & Record<string, unknown>>, dropped: number }>,
 *   runWithDebugger: (tabId: number, operation: (debugTarget: chrome.debugger.Debuggee) => Promise<BridgeResponse>) => Promise<BridgeResponse>,
 *   sendCommand: (target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown>) => Promise<unknown>,
 * }} PageRequestControllerDependencies
 */

/**
 * Bind page-target resolution plus debugger-backed request handlers to the
 * worker's shared state and Chrome APIs.
 *
 * @param {ExtensionState} state
 * @param {typeof globalThis.chrome} chromeObj
 * @param {PageRequestControllerDependencies} dependencies
 * @returns {{
 *   resolveRequestTarget: (request: BridgeRequest, options?: { requireScriptable?: boolean }) => Promise<ResolvedTabTarget>,
 *   waitForTabComplete: (tabId: number, timeoutMs: number) => Promise<chrome.tabs.Tab>,
 *   handlePageGetConsole: (request: BridgeRequest) => Promise<BridgeResponse>,
 *   handleAccessibilityTree: (request: BridgeRequest) => Promise<BridgeResponse>,
 *   handleGetNetwork: (request: BridgeRequest) => Promise<BridgeResponse>,
 *   handleViewportResize: (request: BridgeRequest) => Promise<BridgeResponse>,
 *   handlePerformanceMetrics: (request: BridgeRequest) => Promise<BridgeResponse>,
 *   handleWaitForLoadState: (request: BridgeRequest) => Promise<BridgeResponse>,
 *   handleCdpRequest: (request: BridgeRequest) => Promise<BridgeResponse>,
 * }}
 */
export function createPageRequestController(state, chromeObj, dependencies) {
  /**
   * Resolve the tab a request should operate on. Requests may explicitly target
   * one tab via `tab_id`; otherwise they follow the active tab in the enabled
   * window.
   *
   * @param {BridgeRequest} request
   * @param {{ requireScriptable?: boolean }} [options]
   * @returns {Promise<ResolvedTabTarget>}
   */
  async function resolveRequestTarget(request, options = {}) {
    const requireScriptable = options.requireScriptable !== false;
    if (!state.enabledWindow) {
      throw new BridgeError(
        ERROR_CODES.ACCESS_DENIED,
        'No window is currently enabled for bridge access',
        { reason: ACCESS_DENIED_REASON_WINDOW_OFF }
      );
    }

    try {
      await chromeObj.windows.get(state.enabledWindow.windowId);
    } catch {
      const cleared = await dependencies.clearEnabledWindowIfGone();
      if (cleared) {
        throw new BridgeError(ERROR_CODES.ACCESS_DENIED, 'Enabled window no longer exists', {
          reason: ACCESS_DENIED_REASON_WINDOW_GONE,
        });
      }
    }

    /** @type {chrome.tabs.Tab | null} */
    let explicitTab = null;
    if (typeof request.tab_id === 'number' && Number.isFinite(request.tab_id)) {
      explicitTab = await chromeObj.tabs.get(request.tab_id);
    }
    const [activeTab] = await chromeObj.tabs.query({
      active: true,
      windowId: state.enabledWindow.windowId,
    });
    const tab = selectRequestTabCandidate(request.tab_id, explicitTab, activeTab ?? null);

    return resolveWindowScopedTab(tab, state.enabledWindow.windowId, {
      requireScriptable,
    });
  }

  /**
   * Wait for a tab to reach the `complete` status after a navigation-like action.
   *
   * @param {number} tabId
   * @param {number} timeoutMs
   * @returns {Promise<chrome.tabs.Tab>}
   */
  async function waitForTabComplete(tabId, timeoutMs) {
    return new Promise((resolve, reject) => {
      let finished = false;
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(
          new BridgeError(
            ERROR_CODES.TIMEOUT,
            `Timed out waiting for tab ${tabId} to finish loading after ${timeoutMs}ms.`
          )
        );
      }, timeoutMs);

      /**
       * @returns {void}
       */
      function cleanup() {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timeoutId);
        chromeObj.tabs.onUpdated.removeListener(onUpdated);
        chromeObj.tabs.onRemoved.removeListener(onRemoved);
      }

      /**
       * @param {number} updatedTabId
       * @param {TabChangeInfo} changeInfo
       * @param {chrome.tabs.Tab} tab
       * @returns {void}
       */
      function onUpdated(updatedTabId, changeInfo, tab) {
        if (updatedTabId !== tabId || changeInfo.status !== 'complete') {
          return;
        }
        cleanup();
        resolve(tab);
      }

      /**
       * @param {number} removedTabId
       * @returns {void}
       */
      function onRemoved(removedTabId) {
        if (removedTabId !== tabId) {
          return;
        }
        cleanup();
        reject(new BridgeError(ERROR_CODES.TAB_MISMATCH, 'Tab was closed while waiting for load'));
      }

      chromeObj.tabs.onUpdated.addListener(onUpdated);
      chromeObj.tabs.onRemoved.addListener(onRemoved);

      void chromeObj.tabs.get(tabId).then(
        (tab) => {
          if (finished || tab.status !== 'complete') {
            return;
          }
          cleanup();
          resolve(tab);
        },
        (error) => {
          if (finished) {
            return;
          }
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
    });
  }

  /**
   * Install a console interceptor on the page and retrieve buffered messages.
   * Uses chrome.scripting.executeScript in the MAIN world.
   *
   * @param {BridgeRequest} request
   * @returns {Promise<BridgeResponse>}
   */
  async function handlePageGetConsole(request) {
    const target = await resolveRequestTarget(request);
    const params = normalizeConsoleParams(request.params);

    await dependencies.primeTabConsoleCapture(target.tabId);
    const { entries, dropped } = await dependencies.readConsoleBuffer(target.tabId, params.clear);
    const filtered =
      params.level === 'all'
        ? entries
        : entries.filter((entry) => matchesConsoleLevel(params.level, entry.level));
    const limited = filtered.slice(-params.limit);

    return createSuccess(
      request.id,
      { entries: limited, count: limited.length, total: entries.length, dropped },
      { method: request.method }
    );
  }

  /**
   * Return the full accessibility tree for the target tab via CDP
   * Accessibility.getFullAXTree. Returns a pruned, token-efficient tree with
   * roles, names, descriptions, and interactive states.
   *
   * @param {BridgeRequest} request
   * @returns {Promise<BridgeResponse>}
   */
  async function handleAccessibilityTree(request) {
    const target = await resolveRequestTarget(request);
    const params = normalizeAccessibilityTreeParams(request.params);
    return dependencies.runWithDebugger(target.tabId, async (debugTarget) => {
      await dependencies.sendCommand(debugTarget, 'Accessibility.enable', {});
      try {
        const result = await dependencies.sendCommand(debugTarget, 'Accessibility.getFullAXTree', {
          depth: params.maxDepth,
        });
        const cdpResult = /** @type {{ nodes?: Array<Record<string, unknown>> }} */ (result);
        const rawNodes = cdpResult.nodes || [];
        const pruned = rawNodes.slice(0, params.maxNodes).map(simplifyAXNode);
        return createSuccess(
          request.id,
          {
            nodes: pruned,
            count: pruned.length,
            total: rawNodes.length,
            truncated: rawNodes.length > params.maxNodes,
          },
          { method: request.method }
        );
      } finally {
        await dependencies.sendCommand(debugTarget, 'Accessibility.disable', {}).catch(() => {});
      }
    });
  }

  /**
   * Install a network interceptor and retrieve buffered request/response entries
   * via chrome.scripting.executeScript in the MAIN world, capturing fetch/XHR.
   *
   * @param {BridgeRequest} request
   * @returns {Promise<BridgeResponse>}
   */
  async function handleGetNetwork(request) {
    const target = await resolveRequestTarget(request);
    const params = normalizeNetworkParams(request.params);

    await dependencies.ensureNetworkInterceptor(target.tabId);
    const { entries, dropped } = await dependencies.readNetworkBuffer(target.tabId, params.clear);
    const urlPattern = typeof params.urlPattern === 'string' ? params.urlPattern : null;
    const filtered = urlPattern
      ? entries.filter((entry) => entry.url.includes(urlPattern))
      : entries;
    const limited = filtered.slice(-params.limit);

    return createSuccess(
      request.id,
      { entries: limited, count: limited.length, total: entries.length, dropped },
      { method: request.method }
    );
  }

  /**
   * Resize the browser viewport via CDP Emulation.setDeviceMetricsOverride
   * or reset to natural size when width/height are 0.
   *
   * @param {BridgeRequest} request
   * @returns {Promise<BridgeResponse>}
   */
  async function handleViewportResize(request) {
    const target = await resolveRequestTarget(request);
    const params = normalizeViewportResizeParams(request.params);
    return dependencies.runWithDebugger(target.tabId, async (debugTarget) => {
      if (params.reset || (params.width === 0 && params.height === 0)) {
        await dependencies.sendCommand(debugTarget, 'Emulation.clearDeviceMetricsOverride', {});
      } else {
        await dependencies.sendCommand(debugTarget, 'Emulation.setDeviceMetricsOverride', {
          width: params.width,
          height: params.height,
          deviceScaleFactor: params.deviceScaleFactor,
          mobile: params.width < 768,
        });
      }
      return createSuccess(
        request.id,
        {
          resized: true,
          width: params.width,
          height: params.height,
          deviceScaleFactor: params.deviceScaleFactor,
          reset: params.reset,
        },
        { method: request.method }
      );
    });
  }

  /**
   * Return browser performance metrics via CDP Performance.getMetrics.
   *
   * @param {BridgeRequest} request
   * @returns {Promise<BridgeResponse>}
   */
  async function handlePerformanceMetrics(request) {
    const target = await resolveRequestTarget(request);
    return dependencies.runWithDebugger(target.tabId, async (debugTarget) => {
      await dependencies.sendCommand(debugTarget, 'Performance.enable', {
        timeDomain: 'timeTicks',
      });
      try {
        const result = await dependencies.sendCommand(debugTarget, 'Performance.getMetrics', {});
        const cdpResult = /** @type {{ metrics?: Array<{ name: string, value: number }> }} */ (
          result
        );
        const metrics = (cdpResult.metrics || []).reduce((acc, metric) => {
          acc[metric.name] = metric.value;
          return acc;
        }, /** @type {Record<string, number>} */ ({}));
        return createSuccess(request.id, { metrics }, { method: request.method });
      } finally {
        await dependencies.sendCommand(debugTarget, 'Performance.disable', {}).catch(() => {});
      }
    });
  }

  /**
   * Wait for the tab to reach the 'complete' load state.
   *
   * @param {BridgeRequest} request
   * @returns {Promise<BridgeResponse>}
   */
  async function handleWaitForLoadState(request) {
    const target = await resolveRequestTarget(request);
    const params = normalizeWaitForLoadStateParams(request.params);
    const tab = params.waitForLoad
      ? await waitForTabComplete(target.tabId, params.timeoutMs)
      : await chromeObj.tabs.get(target.tabId);
    return createSuccess(request.id, summarizeTabResult(tab, request.method), {
      method: request.method,
    });
  }

  /**
   * Execute a restricted Chrome DevTools Protocol request against the enabled
   * tab.
   *
   * @param {BridgeRequest} request
   * @returns {Promise<BridgeResponse>}
   */
  async function handleCdpRequest(request) {
    if (
      request.method === 'cdp.get_box_model' ||
      request.method === 'cdp.get_computed_styles_for_node'
    ) {
      const nodeId = request.params?.nodeId;
      if (typeof nodeId !== 'number' || !Number.isFinite(nodeId)) {
        return createFailure(
          request.id,
          ERROR_CODES.INVALID_REQUEST,
          'nodeId must be a finite number.',
          null,
          { method: request.method }
        );
      }
    }

    const target = await resolveRequestTarget(request);
    return dependencies.runWithDebugger(target.tabId, async (debugTarget) => {
      if (request.method === 'cdp.dispatch_key_event') {
        const events = createCdpKeyPressEventPair(request.params ?? {});
        for (const event of events) {
          await dependencies.sendCommand(debugTarget, 'Input.dispatchKeyEvent', event);
        }
        return createSuccess(
          request.id,
          {
            method: 'Input.dispatchKeyEvent',
            pressed: true,
            key: events[0]?.key ?? '',
            code: events[0]?.code ?? '',
            dispatched: events.map((event) => event.type),
          },
          { method: request.method }
        );
      }

      let command;
      /** @type {Record<string, unknown>} */
      let params = {};
      if (request.method === 'cdp.get_document') {
        command = 'DOM.getDocument';
        params = { depth: 2, pierce: false };
      } else if (request.method === 'cdp.get_dom_snapshot') {
        command = 'DOMSnapshot.captureSnapshot';
        params = { computedStyles: request.params?.computedStyles ?? [] };
      } else if (request.method === 'cdp.get_box_model') {
        const nodeId = request.params?.nodeId;
        if (typeof nodeId !== 'number' || !Number.isFinite(nodeId)) {
          return createFailure(
            request.id,
            ERROR_CODES.INVALID_REQUEST,
            'nodeId must be a finite number.',
            null,
            { method: request.method }
          );
        }
        command = 'DOM.getBoxModel';
        params = { nodeId };
      } else {
        const nodeId = request.params?.nodeId;
        if (typeof nodeId !== 'number' || !Number.isFinite(nodeId)) {
          return createFailure(
            request.id,
            ERROR_CODES.INVALID_REQUEST,
            'nodeId must be a finite number.',
            null,
            { method: request.method }
          );
        }
        command = 'CSS.getComputedStyleForNode';
        params = { nodeId };
      }

      const result = await dependencies.sendCommand(debugTarget, command, params);
      return createSuccess(request.id, result, { method: request.method });
    });
  }

  return {
    resolveRequestTarget,
    waitForTabComplete,
    handlePageGetConsole,
    handleAccessibilityTree,
    handleGetNetwork,
    handleViewportResize,
    handlePerformanceMetrics,
    handleWaitForLoadState,
    handleCdpRequest,
  };
}
