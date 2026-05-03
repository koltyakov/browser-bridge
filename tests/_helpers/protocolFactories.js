// @ts-check

import {
  PROTOCOL_VERSION,
  createFailure as createBridgeFailure,
  createRequest as createBridgeRequest,
  createSuccess as createBridgeSuccess,
} from '../../packages/protocol/src/index.js';

/**
 * @typedef {import('../../packages/protocol/src/types.js').BridgeMeta} BridgeMeta
 * @typedef {import('../../packages/protocol/src/types.js').BridgeMethod} BridgeMethod
 * @typedef {import('../../packages/protocol/src/types.js').ErrorCode} ErrorCode
 * @typedef {import('../../packages/protocol/src/types.js').BridgeRequest} BridgeRequest
 * @typedef {import('../../packages/protocol/src/types.js').BridgeSuccessResponse} BridgeSuccessResponse
 * @typedef {import('../../packages/protocol/src/types.js').BridgeFailureResponse} BridgeFailureResponse
 */

/**
 * Build the shared protocol metadata envelope used across bridge fixtures.
 *
 * @param {BridgeMeta} [overrides={}]
 * @returns {{ protocol_version: string } & Record<string, unknown>}
 */
export function makeMeta(overrides = {}) {
  return {
    protocol_version: PROTOCOL_VERSION,
    ...overrides,
  };
}

/**
 * @param {BridgeMethod} method
 * @param {{
 *   id?: string,
 *   tabId?: number | null,
 *   params?: Record<string, unknown>,
 *   meta?: BridgeMeta,
 * }} [options={}]
 * @returns {BridgeRequest}
 */
export function makeRequest(method, options = {}) {
  const { id = 'req_test', tabId = null, params = {}, meta = {} } = options;
  return createBridgeRequest({
    id,
    method,
    tabId,
    params,
    meta,
  });
}

/**
 * @param {unknown} result
 * @param {{ id?: string, meta?: BridgeMeta }} [options={}]
 * @returns {BridgeSuccessResponse}
 */
export function makeSuccess(result, options = {}) {
  const { id = 'req_test', meta = {} } = options;
  return createBridgeSuccess(id, result, meta);
}

/**
 * @param {ErrorCode} code
 * @param {string} message
 * @param {{ id?: string, details?: unknown, meta?: BridgeMeta }} [options={}]
 * @returns {BridgeFailureResponse}
 */
export function makeFailure(code, message, options = {}) {
  const { id = 'req_test', details = null, meta = {} } = options;
  return createBridgeFailure(id, code, message, details, meta);
}
