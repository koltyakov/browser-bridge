// @ts-check

import { createFailure, ERROR_CODES, validateBridgeRequest } from '../../protocol/src/index.js';

/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */

/**
 * @typedef {{
 *   handleHostStatusMessage: (message: unknown) => boolean,
 *   handleBridgeRequest: (request: BridgeRequest) => Promise<void>,
 *   reply: (response: BridgeResponse) => void,
 *   reportAsyncError: (error: unknown) => void,
 * }} NativePortMessageListenerOptions
 */

/**
 * @param {unknown} message
 * @returns {string}
 */
function getRequestIdForFailure(message) {
  if (!message || typeof message !== 'object') {
    return 'invalid_request';
  }
  const candidate = /** @type {Record<string, unknown>} */ (message);
  return typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id : 'invalid_request';
}

/**
 * @param {unknown} message
 * @returns {Record<string, unknown>}
 */
function getFailureMeta(message) {
  if (!message || typeof message !== 'object') {
    return {};
  }
  const candidate = /** @type {Record<string, unknown>} */ (message);
  return typeof candidate.method === 'string' ? { method: candidate.method } : {};
}

/**
 * Create the native-port ingress listener used by the background worker so the
 * request validation boundary can be tested without importing the whole worker.
 *
 * @param {NativePortMessageListenerOptions} options
 * @returns {(message: unknown) => void}
 */
export function createNativePortMessageListener(options) {
  return (message) => {
    if (options.handleHostStatusMessage(message)) {
      return;
    }

    let request;
    try {
      request = validateBridgeRequest(message);
    } catch (error) {
      options.reply(
        createFailure(
          getRequestIdForFailure(message),
          ERROR_CODES.INVALID_REQUEST,
          error instanceof Error ? error.message : String(error),
          null,
          getFailureMeta(message)
        )
      );
      return;
    }

    void options.handleBridgeRequest(request).catch(options.reportAsyncError);
  };
}
