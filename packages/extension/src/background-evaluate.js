// @ts-check

import {
  createFailure,
  createSuccess,
  ERROR_CODES,
  normalizeEvaluateParams,
} from '../../protocol/src/index.js';

/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */

/**
 * @typedef {{
 *   tabId: number,
 *   windowId: number,
 *   title: string,
 *   url: string,
 * }} ResolvedTabTarget
 */

/**
 * @typedef {{
 *   resolveRequestTarget: (request: BridgeRequest, options?: { requireScriptable?: boolean }) => Promise<ResolvedTabTarget>,
 *   runWithDebugger: (tabId: number, operation: (debugTarget: chrome.debugger.Debuggee) => Promise<BridgeResponse>) => Promise<BridgeResponse>,
 *   sendCommand: (target: chrome.debugger.Debuggee, method: string, params: {
 *     expression: string,
 *     returnByValue: boolean,
 *     awaitPromise: boolean,
 *     timeout: number,
 *     userGesture: boolean,
 *     generatePreview: boolean,
 *     replMode: boolean,
 *   }) => Promise<unknown>,
 * }} PageEvaluateDependencies
 */

/**
 * Evaluate a JavaScript expression in the page's main context using the
 * Chrome DevTools Protocol, avoiding content-script CSP restrictions.
 *
 * @param {BridgeRequest} request
 * @param {PageEvaluateDependencies} dependencies
 * @returns {Promise<BridgeResponse>}
 */
export async function handlePageEvaluate(request, dependencies) {
  const target = await dependencies.resolveRequestTarget(request);
  const params = normalizeEvaluateParams(request.params);
  if (!params.expression) {
    return createFailure(request.id, ERROR_CODES.INVALID_REQUEST, 'expression is required.', null, {
      method: request.method,
    });
  }
  return dependencies.runWithDebugger(target.tabId, async (debugTarget) => {
    const result = await dependencies.sendCommand(debugTarget, 'Runtime.evaluate', {
      expression: params.expression,
      returnByValue: params.returnByValue,
      awaitPromise: params.awaitPromise,
      timeout: params.timeoutMs,
      userGesture: true,
      generatePreview: false,
      replMode: true,
    });
    const cdpResult =
      /** @type {{ result?: { type?: string, value?: unknown }, exceptionDetails?: { text?: string, exception?: { description?: string } } }} */ (
        result
      );
    if (cdpResult.exceptionDetails) {
      const errText =
        cdpResult.exceptionDetails.exception?.description ||
        cdpResult.exceptionDetails.text ||
        'Evaluation failed.';
      return createFailure(request.id, ERROR_CODES.INTERNAL_ERROR, errText, null, {
        method: request.method,
      });
    }
    return createSuccess(
      request.id,
      {
        value: cdpResult.result?.value ?? null,
        type: cdpResult.result?.type ?? 'undefined',
      },
      { method: request.method }
    );
  });
}
