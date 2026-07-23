// @ts-check

import {
  BridgeError,
  ERROR_CODES,
  MAX_ARTIFACT_BYTES,
  MAX_NATIVE_MESSAGE_BYTES,
  createFailure,
  createSuccess,
  estimateJsonPayloadCost,
  normalizeAccessibilityTreeParams,
  normalizeConsoleParams,
  normalizeHandleDialogParams,
  normalizeNetworkParams,
  normalizeViewportResizeParams,
  normalizeWaitForLoadStateParams,
} from '../../protocol/src/index.js';
import * as protocolConstants from '../../protocol/src/index.js';
import {
  createCdpKeyPressEventPair,
  matchesConsoleLevel,
  summarizeTabResult,
} from './background-helpers.js';
import { buildAccessibilityTree, scopeAccessibilityNodes } from './background-accessibility.js';
import { buildHar } from './background-har.js';
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
/** @typedef {import('../../protocol/src/types.js').HarEvidenceEntry} HarEvidenceEntry */
/** @typedef {import('../../protocol/src/types.js').CdpPerformanceMetric} CdpPerformanceMetric */

/**
 * @typedef {{
 *   clearEnabledWindowIfGone: () => Promise<boolean>,
 *   primeTabConsoleCapture: (tabId: number) => Promise<void>,
 *   readConsoleBuffer: (tabId: number, clear: boolean) => Promise<{ entries: Array<{ level: string } & Record<string, unknown>>, dropped: number }>,
 *   ensureNetworkInterceptor: (tabId: number) => Promise<void>,
 *   readNetworkBuffer: (tabId: number, clear: boolean) => Promise<{ entries: Array<{ url: string } & Record<string, unknown>>, dropped: number }>,
 *   startCdpNetworkCapture: (tabId: number) => Promise<Record<string, unknown>>,
 *   clearCdpNetworkCapture: (tabId: number) => Promise<Record<string, unknown>>,
 *   readCdpNetworkCapture: (tabId: number, clear: boolean) => Promise<Record<string, unknown>>,
 *   stopCdpNetworkCapture: (tabId: number) => Promise<Record<string, unknown>>,
 *   readCdpHarEvidence: (tabId: number) => Promise<Record<string, unknown>>,
 *   storeHarArtifact: (requestId: string, bytes: Uint8Array) => Promise<import('../../protocol/src/types.js').ArtifactDescriptor<'har'>>,
 *   runWithDebugger: (tabId: number, operation: (debugTarget: chrome.debugger.Debuggee) => Promise<BridgeResponse>, options?: { retryDetached?: boolean }) => Promise<BridgeResponse>,
 *   runForDialog: (tabId: number, operation: (debugTarget: chrome.debugger.Debuggee) => Promise<BridgeResponse>, options?: { retryDetached?: boolean }) => Promise<BridgeResponse>,
 *   sendCommand: (target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown>) => Promise<unknown>,
 *   ensureContentScript: (tabId: number) => Promise<void>,
 *   sendTabMessage: (tabId: number, message: Record<string, unknown>, timeoutMs: number) => Promise<unknown>,
 *   contentScriptTimeoutMs: number,
 *   waitForDialog: (tabId: number, timeoutMs?: number) => Promise<{ dialogId: string, type: string, message: string, defaultPrompt: string, messageTruncated: boolean, defaultPromptTruncated: boolean, openedAt: number } | null>,
 *   getDialogObservation: (tabId: number) => { dialog: { dialogId: string, type: string, message: string, defaultPrompt: string, messageTruncated: boolean, defaultPromptTruncated: boolean, openedAt: number } | null, eventSequence: number, lastOpenedDialogId: string | null },
 *   getDialogStatus: (tabId: number) => Record<string, unknown>,
 *   clearDialog: (tabId: number, dialogId: string) => boolean,
 *   waitForUrl: (tabId: number, windowId: number, params: import('../../protocol/src/types.js').NormalizedWaitForLoadStateParams) => Promise<{ tab: chrome.tabs.Tab, elapsedMs: number, observedNavigationKind: string }>,
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
 *   handlePageGetState: (request: BridgeRequest) => Promise<BridgeResponse>,
 *   handlePageDialog: (request: BridgeRequest) => Promise<BridgeResponse>,
 *   handleAccessibilityTree: (request: BridgeRequest) => Promise<BridgeResponse>,
 *   handleGetNetwork: (request: BridgeRequest) => Promise<BridgeResponse>,
 *   handleExportHar: (request: BridgeRequest) => Promise<BridgeResponse>,
 *   handleViewportResize: (request: BridgeRequest) => Promise<BridgeResponse>,
 *   handlePerformanceMetrics: (request: BridgeRequest) => Promise<BridgeResponse>,
 *   handleWaitForLoadState: (request: BridgeRequest) => Promise<BridgeResponse>,
 *   handleCdpRequest: (request: BridgeRequest) => Promise<BridgeResponse>,
 * }}
 */
export function createPageRequestController(state, chromeObj, dependencies) {
  const harAutoInlineConstant = Reflect.get(protocolConstants, 'HAR_AUTO_INLINE_BYTES');
  const HAR_AUTO_INLINE_BYTES_FALLBACK = 262_144;
  const harAutoInlineBytes =
    typeof harAutoInlineConstant === 'number' && Number.isFinite(harAutoInlineConstant)
      ? harAutoInlineConstant
      : HAR_AUTO_INLINE_BYTES_FALLBACK;
  const harMaxInlineResponseBytes = MAX_NATIVE_MESSAGE_BYTES - 4_096;
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
   * Read detailed state from the content script when possible, while retaining
   * a tabs-backed fallback for restricted or temporarily unscriptable pages.
   * Dialog state never includes message or prompt text.
   *
   * @param {BridgeRequest} request
   * @returns {Promise<BridgeResponse>}
   */
  async function handlePageGetState(request) {
    const target = await resolveRequestTarget(request, { requireScriptable: false });
    const dialog = dependencies.getDialogStatus(target.tabId);
    try {
      await dependencies.ensureContentScript(target.tabId);
      const result = await dependencies.sendTabMessage(
        target.tabId,
        { type: 'bridge.execute', method: request.method, params: {} },
        dependencies.contentScriptTimeoutMs
      );
      const pageState =
        result && typeof result === 'object' ? /** @type {Record<string, unknown>} */ (result) : {};
      if (pageState.error) throw new Error(String(pageState.error));
      return createSuccess(request.id, { ...pageState, dialog }, { method: request.method });
    } catch {
      // Restricted pages, document replacement, and modal dialogs can all make
      // the content script unavailable. Tab metadata remains safe and useful.
      const tab = await chromeObj.tabs.get(target.tabId);
      return createSuccess(
        request.id,
        {
          url: tab.url ?? target.url,
          origin: getUrlOrigin(tab.url ?? target.url),
          title: tab.title ?? target.title,
          readyState: tab.status === 'complete' ? 'complete' : 'loading',
          contentAvailable: false,
          dialog,
        },
        { method: request.method, background_fallback: true }
      );
    }
  }

  /**
   * Inspect or explicitly handle a dialog observed through Page domain events.
   * Mutating actions disable detached-session replay.
   *
   * @param {BridgeRequest} request
   * @returns {Promise<BridgeResponse>}
   */
  async function handlePageDialog(request) {
    const target = await resolveRequestTarget(request, { requireScriptable: false });
    const params = normalizeHandleDialogParams(request.params);
    return dependencies.runForDialog(
      target.tabId,
      async (debugTarget) => {
        const dialog = await dependencies.waitForDialog(target.tabId);
        if (!dialog) {
          throw new BridgeError(
            ERROR_CODES.DIALOG_NOT_OPEN,
            'No observable JavaScript dialog is open in the target tab.'
          );
        }
        if (params.action === 'inspect') {
          return createSuccess(
            request.id,
            {
              open: true,
              dialogId: dialog.dialogId,
              type: dialog.type,
              message: dialog.message,
              defaultPrompt: dialog.defaultPrompt,
              messageTruncated: dialog.messageTruncated,
              defaultPromptTruncated: dialog.defaultPromptTruncated,
              openedAt: dialog.openedAt,
            },
            { method: request.method, debugger_backed: true }
          );
        }
        const preDispatch = dependencies.getDialogObservation(target.tabId);
        const currentDialog = preDispatch.dialog;
        if (!currentDialog) {
          throw new BridgeError(
            ERROR_CODES.DIALOG_NOT_OPEN,
            'No observable JavaScript dialog is open in the target tab.'
          );
        }
        if (
          params.expectedDialogId !== null &&
          currentDialog.dialogId !== params.expectedDialogId
        ) {
          throw new BridgeError(
            ERROR_CODES.DIALOG_ACTION_CONFLICT,
            'The current dialog no longer matches the optional pre-dispatch observation check.',
            { phase: 'before_dispatch', commandDispatched: false }
          );
        }

        /** @type {Record<string, unknown>} */
        const commandParams = { accept: params.action === 'accept' };
        if (params.action === 'accept' && params.promptText !== null) {
          commandParams.promptText = params.promptText;
        }
        try {
          await dependencies.sendCommand(debugTarget, 'Page.handleJavaScriptDialog', commandParams);
        } catch (error) {
          await drainDialogEvents();
          const afterFailure = dependencies.getDialogObservation(target.tabId);
          if (dialogObservationChanged(preDispatch, currentDialog.dialogId, afterFailure)) {
            throw createDialogActionConflict();
          }
          const message = error instanceof Error ? error.message : String(error);
          if (/no (?:javascript )?dialog|no dialog is showing/i.test(message)) {
            dependencies.clearDialog(target.tabId, currentDialog.dialogId);
            throw new BridgeError(
              ERROR_CODES.DIALOG_NOT_OPEN,
              'No observable JavaScript dialog is open in the target tab.'
            );
          }
          throw error;
        }
        await drainDialogEvents();
        const afterDispatch = dependencies.getDialogObservation(target.tabId);
        if (dialogObservationChanged(preDispatch, currentDialog.dialogId, afterDispatch)) {
          throw createDialogActionConflict();
        }
        dependencies.clearDialog(target.tabId, currentDialog.dialogId);
        return createSuccess(
          request.id,
          {
            commandDispatched: true,
            action: params.action,
            type: currentDialog.type,
            dialogId: currentDialog.dialogId,
            expectedDialogIdChecked: params.expectedDialogId !== null,
            atomicDialogBinding: false,
            replacementObserved: false,
          },
          { method: request.method, debugger_backed: true }
        );
      },
      { retryDetached: params.action === 'inspect' }
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
    return dependencies.runWithDebugger(
      target.tabId,
      async (debugTarget) => {
        await dependencies.sendCommand(debugTarget, 'Accessibility.enable', {});
        try {
          let result;
          if (params.selector) {
            const documentResult = /** @type {{ root?: { nodeId?: number } }} */ (
              await dependencies.sendCommand(debugTarget, 'DOM.getDocument', {
                depth: 0,
                pierce: false,
              })
            );
            const rootNodeId = Number(documentResult.root?.nodeId);
            if (!Number.isFinite(rootNodeId) || rootNodeId <= 0) {
              throw new BridgeError(
                ERROR_CODES.INTERNAL_ERROR,
                'CDP did not return a DOM root node.'
              );
            }
            let queryResult;
            try {
              queryResult = /** @type {{ nodeIds?: number[] }} */ (
                await dependencies.sendCommand(debugTarget, 'DOM.querySelectorAll', {
                  nodeId: rootNodeId,
                  selector: params.selector,
                })
              );
            } catch (error) {
              throw new BridgeError(
                ERROR_CODES.INVALID_REQUEST,
                'Accessibility tree selector is invalid.',
                {
                  selector: params.selector,
                  reason:
                    error instanceof Error
                      ? error.message.slice(0, 300)
                      : String(error).slice(0, 300),
                }
              );
            }
            const nodeIds = Array.isArray(queryResult.nodeIds) ? queryResult.nodeIds : [];
            if (nodeIds.length === 0) {
              throw new BridgeError(
                ERROR_CODES.ELEMENT_NOT_FOUND,
                'Accessibility tree selector did not match an element.',
                { selector: params.selector, candidateCount: 0 }
              );
            }
            if (nodeIds.length > 1) {
              throw new BridgeError(
                ERROR_CODES.ELEMENT_AMBIGUOUS,
                'Accessibility tree selector matched multiple elements.',
                { selector: params.selector, candidateCount: nodeIds.length }
              );
            }
            const described = /** @type {{ node?: { backendNodeId?: number } }} */ (
              await dependencies.sendCommand(debugTarget, 'DOM.describeNode', {
                nodeId: nodeIds[0],
                depth: 0,
              })
            );
            const backendNodeId = Number(described.node?.backendNodeId);
            if (!Number.isFinite(backendNodeId) || backendNodeId <= 0) {
              throw new BridgeError(
                ERROR_CODES.INTERNAL_ERROR,
                'CDP did not resolve the accessibility target backend node.'
              );
            }
            const partialResult = await dependencies.sendCommand(
              debugTarget,
              'Accessibility.getPartialAXTree',
              { backendNodeId, fetchRelatives: true }
            );
            const partial = /** @type {{ nodes?: Array<Record<string, unknown>> }} */ (
              partialResult
            );
            result = {
              nodes: scopeAccessibilityNodes(partial.nodes ?? [], backendNodeId, params.maxDepth),
            };
          } else {
            result = await dependencies.sendCommand(debugTarget, 'Accessibility.getFullAXTree', {
              depth: params.maxDepth,
            });
          }
          const cdpResult = /** @type {{ nodes?: Array<Record<string, unknown>> }} */ (result);
          const rawNodes = cdpResult.nodes || [];
          const tree = buildAccessibilityTree(rawNodes, params);
          const continuationHint = tree.truncated
            ? `The AX result reached maxNodes ${params.maxNodes} and was depth-limited to ${params.maxDepth}; retry with larger maxNodes and maxDepth values.`
            : `The AX source was depth-limited to ${params.maxDepth}; retry with a larger maxDepth to inspect potentially omitted descendants.`;
          return createSuccess(
            request.id,
            {
              nodes: tree.nodes,
              rootIds: tree.rootIds,
              count: tree.nodes.length,
              total: tree.filteredCount,
              rawTotal: tree.rawCount,
              source: 'cdp-accessibility',
              compact: params.compact,
              interactiveOnly: params.interactiveOnly,
              truncated: true,
              truncation: {
                reason: tree.truncated ? 'maxNodes' : 'maxDepth',
                reasons: [...(tree.truncated ? ['maxNodes'] : []), 'maxDepth'],
                maxNodes: params.maxNodes,
                maxDepth: params.maxDepth,
                omitted: tree.omitted,
                missingChildCount: tree.missingChildCount,
                partialTopology: true,
              },
              continuationHint,
            },
            {
              method: request.method,
              debugger_backed: true,
              result_truncated: true,
              continuation_hint: continuationHint,
            }
          );
        } finally {
          await dependencies.sendCommand(debugTarget, 'Accessibility.disable', {}).catch(() => {});
        }
      },
      { retryDetached: true }
    );
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

    if (params.source === 'fetch-xhr') {
      await dependencies.ensureNetworkInterceptor(target.tabId);
    }
    const captureResult =
      params.source === 'fetch-xhr'
        ? await dependencies.readNetworkBuffer(target.tabId, params.clear)
        : params.capture === 'start'
          ? await dependencies.startCdpNetworkCapture(target.tabId)
          : params.capture === 'clear'
            ? await dependencies.clearCdpNetworkCapture(target.tabId)
            : params.capture === 'stop'
              ? await dependencies.stopCdpNetworkCapture(target.tabId)
              : await dependencies.readCdpNetworkCapture(target.tabId, params.clear);
    const capture =
      /** @type {{ entries?: Array<{ url: string } & Record<string, unknown>>, dropped?: number, abandoned?: number, armed?: boolean, armedDuringCapture?: boolean, ownershipHeld?: boolean, captureState?: string, startedAt?: number | null, inflight?: number }} */ (
        captureResult
      );
    const entries = capture.entries ?? [];
    const dropped = capture.dropped ?? 0;
    const urlPattern = typeof params.urlPattern === 'string' ? params.urlPattern : null;
    const filtered = urlPattern
      ? entries.filter((entry) => entry.url.includes(urlPattern))
      : entries;
    const limited = filtered.slice(-params.limit);

    return createSuccess(
      request.id,
      {
        entries: limited,
        count: limited.length,
        total: entries.length,
        filteredTotal: filtered.length,
        dropped,
        abandoned: capture.abandoned ?? 0,
        source: params.source,
        capture: params.source === 'cdp' ? params.capture : null,
        armed: params.source === 'cdp' ? capture.armed === true : true,
        armedDuringCapture: params.source === 'cdp' ? capture.armedDuringCapture === true : true,
        captureState:
          params.source === 'cdp' ? (capture.captureState ?? 'stopped') : 'instrumented',
        startedAt: params.source === 'cdp' ? (capture.startedAt ?? null) : null,
        inflight: params.source === 'cdp' ? (capture.inflight ?? 0) : 0,
        ownershipHeld: params.source === 'cdp' ? capture.ownershipHeld === true : false,
        truncated: filtered.length > limited.length,
        truncation: {
          reason: filtered.length > limited.length ? 'limit' : null,
          limit: params.limit,
          omitted: Math.max(0, filtered.length - limited.length),
        },
      },
      {
        method: request.method,
        debugger_backed:
          params.source === 'cdp' &&
          (capture.armed === true || capture.armedDuringCapture === true),
      }
    );
  }

  /**
   * Export metadata-only evidence from an explicitly armed CDP capture. Export
   * is a read: it never changes debugger ownership or Network domain state.
   *
   * @param {BridgeRequest} request
   * @returns {Promise<BridgeResponse>}
   */
  async function handleExportHar(request) {
    const target = await resolveRequestTarget(request, { requireScriptable: false });
    const params = /** @type {import('../../protocol/src/types.js').NormalizedHarExportParams} */ (
      request.params
    );
    const capture =
      /** @type {{ entries?: HarEvidenceEntry[], dropped?: number, abandoned?: number, armed?: boolean, captureState?: string, startedAt?: number | null, inflight?: number }} */ (
        await dependencies.readCdpHarEvidence(target.tabId)
      );
    if (capture.armed !== true) {
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        'HAR export requires an armed explicit CDP network capture.',
        {
          guidance:
            'Start CDP capture, reproduce the network activity, export the HAR, then stop capture.',
          steps: ['start', 'reproduce', 'export', 'stop'],
        }
      );
    }

    const evidence = capture.entries ?? [];
    const buildOptions = {
      limit: params.limit,
      urlPattern: params.urlPattern,
      creatorVersion: chromeObj.runtime.getManifest().version,
    };
    const artifactBuild = buildHar(evidence, {
      ...buildOptions,
      maxBytes: MAX_ARTIFACT_BYTES,
    });
    if (!artifactBuild.fits) {
      throw createHarTooLargeError(artifactBuild.byteLength, MAX_ARTIFACT_BYTES);
    }
    const useArtifact =
      params.delivery === 'artifact' ||
      (params.delivery === 'auto' && artifactBuild.byteLength > harAutoInlineBytes);
    if (useArtifact) {
      const artifact = await dependencies.storeHarArtifact(request.id, artifactBuild.bytes);
      return createSuccess(
        request.id,
        createHarResult(artifactBuild, capture, 'artifact', artifact),
        { method: request.method, debugger_backed: true }
      );
    }

    const requestedBudget = request.meta?.token_budget;
    const responseLimit =
      typeof requestedBudget === 'number' && Number.isFinite(requestedBudget) && requestedBudget > 0
        ? Math.min(harMaxInlineResponseBytes, Math.max(128, Math.floor(requestedBudget * 4)))
        : harMaxInlineResponseBytes;
    let inlineBuild = buildHar(evidence, { ...buildOptions, maxBytes: responseLimit });
    let inlineResult = createHarResult(inlineBuild, capture, 'inline');
    let resultBytes = estimateJsonPayloadCost(inlineResult).bytes;
    while (resultBytes > responseLimit && inlineBuild.count > 0) {
      const overflow = resultBytes - responseLimit;
      inlineBuild = buildHar(evidence, {
        ...buildOptions,
        maxBytes: Math.max(0, inlineBuild.byteLength - overflow - 1),
      });
      inlineResult = createHarResult(inlineBuild, capture, 'inline');
      resultBytes = estimateJsonPayloadCost(inlineResult).bytes;
    }
    if (!inlineBuild.fits || resultBytes > responseLimit) {
      throw createHarTooLargeError(resultBytes, responseLimit);
    }
    return createSuccess(request.id, inlineResult, {
      method: request.method,
      debugger_backed: true,
    });
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
   * Return a raw point sample of Chrome-maintained CDP performance counters.
   *
   * @param {BridgeRequest} request
   * @returns {Promise<BridgeResponse>}
   */
  async function handlePerformanceMetrics(request) {
    const target = await resolveRequestTarget(request);
    return dependencies.runWithDebugger(
      target.tabId,
      async (debugTarget) => {
        await dependencies.sendCommand(debugTarget, 'Performance.enable', {
          timeDomain: 'timeTicks',
        });
        try {
          const result = await dependencies.sendCommand(debugTarget, 'Performance.getMetrics', {});
          const cdpResult = /** @type {{ metrics?: CdpPerformanceMetric[] }} */ (result);
          const metrics = (cdpResult.metrics || []).reduce((acc, metric) => {
            acc[metric.name] = metric.value;
            return acc;
          }, /** @type {Record<string, number>} */ ({}));
          /** @type {import('../../protocol/src/types.js').PerformanceMetricsResult} */
          const performanceResult = {
            metrics,
            measurement: {
              source: 'cdp.Performance.getMetrics',
              kind: 'raw_cdp_counters',
              sampledAt: new Date().toISOString(),
              timeDomain: 'timeTicks',
              observation: 'browser_maintained_point_sample',
              webVitals: 'not_measured',
            },
          };
          return createSuccess(request.id, performanceResult, { method: request.method });
        } finally {
          await dependencies.sendCommand(debugTarget, 'Performance.disable', {}).catch(() => {});
        }
      },
      { retryDetached: true }
    );
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
    if (params.url && params.urlMatch) {
      const matched = await dependencies.waitForUrl(target.tabId, target.windowId, params);
      return createSuccess(
        request.id,
        {
          ...summarizeTabResult(matched.tab, request.method),
          finalUrl: matched.tab.url ?? '',
          urlMatch: params.urlMatch,
          elapsedMs: matched.elapsedMs,
          observedNavigationKind: matched.observedNavigationKind,
        },
        { method: request.method }
      );
    }
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
    const retryDetached = request.method !== 'cdp.dispatch_key_event';
    return dependencies.runWithDebugger(
      target.tabId,
      async (debugTarget) => {
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
      },
      retryDetached ? { retryDetached: true } : undefined
    );
  }

  return {
    resolveRequestTarget,
    waitForTabComplete,
    handlePageGetConsole,
    handlePageGetState,
    handlePageDialog,
    handleAccessibilityTree,
    handleGetNetwork,
    handleExportHar,
    handleViewportResize,
    handlePerformanceMetrics,
    handleWaitForLoadState,
    handleCdpRequest,
  };
}

/**
 * Give debugger event delivery one task turn to preserve ordering around the
 * command response before deciding whether a replacement was observed.
 *
 * @returns {Promise<void>}
 */
function drainDialogEvents() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * @param {{ eventSequence: number, lastOpenedDialogId: string | null }} before
 * @param {string} dispatchedDialogId
 * @param {{ eventSequence: number, lastOpenedDialogId: string | null }} after
 * @returns {boolean}
 */
function dialogObservationChanged(before, dispatchedDialogId, after) {
  return (
    after.eventSequence < before.eventSequence ||
    (after.lastOpenedDialogId !== null && after.lastOpenedDialogId !== dispatchedDialogId)
  );
}

/** @returns {BridgeError} */
function createDialogActionConflict() {
  return new BridgeError(
    ERROR_CODES.DIALOG_ACTION_CONFLICT,
    'A replacement dialog was observed during CDP dispatch, so the action outcome is uncertain.',
    { phase: 'during_dispatch', commandDispatched: true, actionOutcome: 'uncertain' }
  );
}

/**
 * @param {string} url
 * @returns {string}
 */
function getUrlOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * @param {ReturnType<typeof buildHar>} build
 * @param {{ dropped?: number, abandoned?: number, captureState?: string, startedAt?: number | null, inflight?: number }} capture
 * @param {'inline' | 'artifact'} delivery
 * @param {import('../../protocol/src/types.js').ArtifactDescriptor<'har'>} [artifact]
 */
function createHarResult(build, capture, delivery, artifact) {
  const omitted = build.omittedByLimit + build.omittedBySize;
  const base = {
    delivery,
    format: /** @type {'har'} */ ('har'),
    harVersion: /** @type {'1.2'} */ ('1.2'),
    mimeType: 'application/json',
    byteLength: build.byteLength,
    entryCount: build.count,
    totalEntries: build.filteredTotal,
    dropped: capture.dropped ?? 0,
    abandoned: capture.abandoned ?? 0,
    inflight: capture.inflight ?? 0,
    startedAt: capture.startedAt ?? null,
    captureState: capture.captureState ?? 'armed',
    truncated: build.truncated,
    truncation: {
      reason: build.omittedBySize > 0 ? 'inline_bytes' : build.omittedByLimit > 0 ? 'limit' : null,
      limit: build.limit,
      omitted,
      omittedByLimit: build.omittedByLimit,
      omittedBySize: build.omittedBySize,
    },
  };
  return delivery === 'inline' ? { ...base, har: build.har } : { ...base, artifact };
}

/** @param {number} byteLength @param {number} maxBytes */
function createHarTooLargeError(byteLength, maxBytes) {
  return new BridgeError(
    ERROR_CODES.RESULT_TOO_LARGE,
    `HAR export is too large to return without truncating fields (${byteLength} bytes).`,
    {
      byteLength,
      maxBytes,
      guidance: 'Use a smaller limit or a narrower urlPattern.',
    }
  );
}
