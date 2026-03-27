// @ts-check

import { getCostClass } from './defaults.js';

const textEncoder = new TextEncoder();

/**
 * @typedef {{
 *   bytes: number,
 *   approxTokens: number,
 *   costClass: 'cheap' | 'moderate' | 'heavy' | 'extreme'
 * }} PayloadCost
 */

/**
 * Measure UTF-8 byte length in both Node and extension runtimes.
 *
 * @param {string} value
 * @returns {number}
 */
export function getUtf8ByteLength(value) {
  if (!value) {
    return 0;
  }
  return textEncoder.encode(value).length;
}

/**
 * Estimate cost for an already-serialized payload.
 *
 * This remains intentionally approximate because Browser Bridge must stay
 * model-agnostic across MCP and CLI clients.
 *
 * @param {string} serialized
 * @returns {PayloadCost}
 */
export function estimateSerializedPayloadCost(serialized) {
  const bytes = getUtf8ByteLength(serialized);
  const approxTokens = bytes === 0 ? 0 : Math.ceil(bytes / 4);
  return {
    bytes,
    approxTokens,
    costClass: getCostClass(approxTokens),
  };
}

/**
 * Estimate cost for a JSON-serializable payload.
 *
 * @param {unknown} value
 * @returns {PayloadCost}
 */
export function estimateJsonPayloadCost(value) {
  if (typeof value === 'undefined') {
    return estimateSerializedPayloadCost('');
  }
  return estimateSerializedPayloadCost(JSON.stringify(value) ?? '');
}
