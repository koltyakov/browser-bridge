// @ts-check

import {
  getProtocolVersion,
  isBatchSafeBridgeCall,
  MAX_BATCH_CALLS,
  MAX_BATCH_CONCURRENCY,
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
 * @typedef {{ method: BridgeMethod, params: Record<string, unknown>, tabId: number | null }} PreparedBatchCall
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
 * Parse and execute `bbx batch '[...]'`: validate read-only calls, run them
 * with bounded concurrency, and return ordered per-call summary items.
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
  if (calls.length === 0 || calls.length > MAX_BATCH_CALLS) {
    throw new Error(`Batch input must contain between 1 and ${MAX_BATCH_CALLS} calls.`);
  }
  const prepared = calls.map((call) => prepareBatchCall(call));
  if (prepared.some((item) => 'error' in item)) {
    return prepared.map((item) =>
      'error' in item
        ? item.error
        : invalidBatchItem(
            item.value.method,
            'Batch was not executed because another call failed validation.'
          )
    );
  }
  const validPrepared = /** @type {Array<{ value: PreparedBatchCall }>} */ (prepared);
  if (!client.connected) await client.connect();
  return mapWithConcurrency(validPrepared, MAX_BATCH_CONCURRENCY, async (item) => {
    const { method, params, tabId } = item.value;
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
  });
}

/**
 * @param {unknown} call
 * @returns {{ value: PreparedBatchCall } | { error: InvalidBatchItem }}
 */
function prepareBatchCall(call) {
  if (!call || typeof call !== 'object' || Array.isArray(call)) {
    return { error: invalidBatchItem('', 'Each batch call needs a method.') };
  }
  const batchCall = /** @type {Record<string, unknown>} */ (call);
  if (typeof batchCall.method !== 'string') {
    return { error: invalidBatchItem('', 'Each batch call needs a method.') };
  }
  if (!METHODS.includes(/** @type {BridgeMethod} */ (batchCall.method))) {
    return {
      error: invalidBatchItem(batchCall.method, `Unknown bridge method "${batchCall.method}".`),
    };
  }
  const method = /** @type {BridgeMethod} */ (batchCall.method);
  if (method === 'sensitive.read') {
    return {
      error: invalidBatchItem(
        method,
        'sensitive.read is never allowed in batch execution. Call it sequentially.'
      ),
    };
  }
  if (
    batchCall.params !== undefined &&
    (!batchCall.params || typeof batchCall.params !== 'object' || Array.isArray(batchCall.params))
  ) {
    return { error: invalidBatchItem(method, 'Batch call params must be a JSON object.') };
  }
  const params =
    batchCall.params === undefined ? {} : /** @type {Record<string, unknown>} */ (batchCall.params);
  if (!isBatchSafeBridgeCall(method, params)) {
    return {
      error: invalidBatchItem(
        method,
        `${method} is not safe for batch execution. Call it sequentially.`
      ),
    };
  }
  const tabId =
    methodNeedsTab(method) &&
    typeof batchCall.tabId === 'number' &&
    Number.isInteger(batchCall.tabId) &&
    batchCall.tabId > 0
      ? batchCall.tabId
      : null;
  return { value: { method, params, tabId } };
}

/**
 * @template T, R
 * @param {T[]} values
 * @param {number} concurrency
 * @param {(value: T) => Promise<R>} callback
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(values, concurrency, callback) {
  /** @type {R[]} */
  const results = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
