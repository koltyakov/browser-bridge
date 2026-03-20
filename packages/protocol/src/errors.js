// @ts-check

/** @typedef {import('./types.js').ErrorCode} ErrorCode */

export const ERROR_CODES = Object.freeze({
  ACCESS_DENIED: 'ACCESS_DENIED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  TAB_MISMATCH: 'TAB_MISMATCH',
  ORIGIN_MISMATCH: 'ORIGIN_MISMATCH',
  CAPABILITY_MISSING: 'CAPABILITY_MISSING',
  ELEMENT_STALE: 'ELEMENT_STALE',
  RESULT_TRUNCATED: 'RESULT_TRUNCATED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  INVALID_REQUEST: 'INVALID_REQUEST',
  NATIVE_HOST_UNAVAILABLE: 'NATIVE_HOST_UNAVAILABLE',
  APPROVAL_PENDING: 'APPROVAL_PENDING'
});

/** @extends {Error} */
export class BridgeError extends Error {
  /**
   * @param {ErrorCode} code
   * @param {string} message
   * @param {unknown} [details=null]
   */
  constructor(code, message, details = null) {
    super(message);
    this.name = 'BridgeError';
    /** @type {ErrorCode} */
    this.code = code;
    /** @type {unknown} */
    this.details = details;
  }
}
