// @ts-check

import {
  getProtocolVersion,
  METHODS,
  summarizeBatchErrorItem,
  summarizeBatchResponseItem,
} from '../../protocol/src/index.js';
import { methodNeedsTab } from './cli-helpers.js';
import { requestBridge } from './runtime.js';

/** @typedef {import('./types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('./types.js').BridgeRequestSource} BridgeRequestSource */

/**
 * @typedef {{
 *   method: string,
 *   tabId: null,
 *   ok: false,
 *   summary: string,
 *   evidence: null,
 *   durationMs: 0,
 *   approxTokens: 0,
 *   meta: { protocol_version: string },
 *   error: { code: 'INVALID_REQUEST', message: string },
 *   response: null,
 * }} InvalidBatchItem
 */

/**
 * @typedef {ReturnType<typeof summarizeBatchResponseItem>
 *   | ReturnType<typeof summarizeBatchErrorItem>
 *   | InvalidBatchItem} BatchResultItem
 */

/**
 * Build the standard invalid-request batch item.
 *
 * @param {string} method
 * @param {string} message
 * @returns {InvalidBatchItem}
 */
function invalidBatchItem(method, message) {
  return {
    method,
    tabId: null,
    ok: false,
    summary: `INVALID_REQUEST: ${message}`,
    evidence: null,
    durationMs: 0,
    approxTokens: 0,
    meta: { protocol_version: getProtocolVersion() },
    error: {
      code: 'INVALID_REQUEST',
      message,
    },
    response: null,
  };
}

/**
 * Parse and execute `bbx batch '[...]'`: validate each call, run them in
 * parallel against the bridge, and return per-call summary items.
 *
 * @param {import('./client.js').BridgeClient} client
 * @param {string | undefined} input - Raw JSON array argument
 * @param {BridgeRequestSource} source - Request source tag (e.g. 'cli')
 * @returns {Promise<BatchResultItem[]>}
 */
export async function runBatchCalls(client, input, source) {
  if (!input) {
    throw new Error('Usage: batch \'[{"method":"...","params":{...}}, ...]\'');
  }
  let calls;
  try {
    calls = JSON.parse(input);
  } catch {
    throw new Error('Invalid JSON syntax. Expected a JSON array of bridge calls.');
  }
  if (!Array.isArray(calls)) {
    throw new Error('Batch input must be a JSON array.');
  }
  if (!client.connected) {
    await client.connect();
  }
  return Promise.all(
    calls.map(async (call) => {
      if (!call || typeof call !== 'object' || Array.isArray(call)) {
        return invalidBatchItem('', 'Each batch call needs a method.');
      }
      const batchCall = /** @type {Record<string, unknown>} */ (call);
      if (typeof batchCall.method !== 'string') {
        return invalidBatchItem('', 'Each batch call needs a method.');
      }
      if (!METHODS.includes(/** @type {BridgeMethod} */ (batchCall.method))) {
        return invalidBatchItem(batchCall.method, `Unknown bridge method "${batchCall.method}".`);
      }
      const method = /** @type {BridgeMethod} */ (batchCall.method);
      if (
        batchCall.params !== undefined &&
        (!batchCall.params ||
          typeof batchCall.params !== 'object' ||
          Array.isArray(batchCall.params))
      ) {
        return invalidBatchItem(method, 'Batch call params must be a JSON object.');
      }
      const params =
        batchCall.params === undefined
          ? {}
          : /** @type {Record<string, unknown>} */ (batchCall.params);
      const tabId =
        methodNeedsTab(method) &&
        typeof batchCall.tabId === 'number' &&
        Number.isInteger(batchCall.tabId) &&
        batchCall.tabId > 0
          ? batchCall.tabId
          : null;
      const startTime = Date.now();
      try {
        const response = await requestBridge(client, method, params, {
          tabId,
          source,
        });
        return summarizeBatchResponseItem({
          method,
          tabId,
          response,
          durationMs: Date.now() - startTime,
        });
      } catch (err) {
        return summarizeBatchErrorItem({
          method,
          tabId,
          error: err,
          durationMs: Date.now() - startTime,
        });
      }
    })
  );
}
