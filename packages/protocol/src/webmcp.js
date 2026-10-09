// @ts-check

import { BridgeError, ERROR_CODES } from './errors.js';

export const MAX_WEBMCP_BYTES = 65_536;
export const MAX_WEBMCP_ARGUMENT_BYTES = 16_384;

/**
 * Reject coercion and non-JSON arguments before any browser work or approval.
 * @param {Record<string, unknown>} params
 * @returns {import('./types.js').WebMcpParams}
 */
export function normalizeWebMcpParams(params = {}) {
  /** @param {string} key @param {number} fallback @param {number} min @param {number} max */
  const integer = (key, fallback, min, max) => {
    const value = params[key] === undefined ? fallback : params[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        `${key} must be an integer in ${min}..${max}.`
      );
    }
    return value;
  };
  if (
    params.toolRef !== undefined &&
    (typeof params.toolRef !== 'string' || !/^wm_[0-9a-f-]{36}$/.test(params.toolRef))
  ) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'toolRef must be a reference returned by webmcp.list_tools.'
    );
  }
  if (
    params.query !== undefined &&
    (typeof params.query !== 'string' || params.query.length > 200)
  ) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'query must be a string of at most 200 characters.'
    );
  }
  if (params.includeDebugging !== undefined && typeof params.includeDebugging !== 'boolean') {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'includeDebugging must be boolean.');
  }
  const input = params.arguments === undefined ? {} : params.arguments;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'arguments must be a JSON object.');
  }
  let nodes = 0;
  /** @param {unknown} value @param {number} depth */
  const validate = (value, depth) => {
    if (++nodes > 5000 || depth > 32)
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        'arguments exceed JSON complexity limits.'
      );
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (
      typeof value !== 'object' ||
      !value ||
      (!Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    ) {
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        'arguments must contain only JSON values.'
      );
    }
    for (const entry of Object.values(value)) validate(entry, depth + 1);
  };
  validate(input, 0);
  const json = JSON.stringify(input);
  if (new TextEncoder().encode(json).byteLength > MAX_WEBMCP_ARGUMENT_BYTES) {
    throw new BridgeError(ERROR_CODES.INVALID_REQUEST, 'arguments exceed 16384 UTF-8 bytes.');
  }
  return {
    ...(typeof params.toolRef === 'string' ? { toolRef: params.toolRef } : {}),
    arguments: /** @type {Record<string, unknown>} */ (JSON.parse(json)),
    limit: integer('limit', 20, 1, 100),
    offset: integer('offset', 0, 0, 1000),
    query: typeof params.query === 'string' ? params.query : '',
    includeDebugging: params.includeDebugging === true,
    maxBytes: integer('maxBytes', MAX_WEBMCP_BYTES, 1024, MAX_WEBMCP_BYTES),
    timeoutMs: integer('timeoutMs', 10_000, 100, 30_000),
    approvalTimeoutMs: integer('approvalTimeoutMs', 60_000, 1000, 60_000),
  };
}
