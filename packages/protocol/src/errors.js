// @ts-check

/** @typedef {import('./types.js').ErrorCode} ErrorCode */

export const ERROR_CODES = Object.freeze({
  ACCESS_DENIED: 'ACCESS_DENIED',
  TAB_MISMATCH: 'TAB_MISMATCH',
  ELEMENT_STALE: 'ELEMENT_STALE',
  RESULT_TRUNCATED: 'RESULT_TRUNCATED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  INVALID_REQUEST: 'INVALID_REQUEST',
  NATIVE_HOST_UNAVAILABLE: 'NATIVE_HOST_UNAVAILABLE',
  EXTENSION_DISCONNECTED: 'EXTENSION_DISCONNECTED',
  TIMEOUT: 'TIMEOUT',
});

/**
 * Machine-actionable recovery hints keyed by error code.
 *
 * @type {Readonly<Record<string, { retry: boolean, retryAfterMs?: number, alternativeMethod?: string, hint: string }>>}
 */
export const ERROR_RECOVERY = Object.freeze({
  [ERROR_CODES.ACCESS_DENIED]: {
    retry: false,
    hint: 'Access is off for this window. Ask the user to click Enable in the Browser Bridge popup or side panel. Do not request access again until that window is enabled.',
  },
  [ERROR_CODES.RESULT_TRUNCATED]: {
    retry: false,
    hint: 'Result was truncated to fit the response budget. Narrow the query or raise the relevant budget if more detail is required.',
  },
  [ERROR_CODES.ELEMENT_STALE]: {
    retry: false,
    alternativeMethod: 'dom.query',
    hint: 'Element was removed from the DOM. Re-query with the same selector to get a fresh elementRef.',
  },
  [ERROR_CODES.TAB_MISMATCH]: {
    retry: false,
    alternativeMethod: 'tabs.list',
    hint: 'Tab was closed or not found. Use tabs.list to find an available tab.',
  },
  [ERROR_CODES.TIMEOUT]: {
    retry: true,
    retryAfterMs: 1000,
    hint: 'Operation exceeded the time limit. Retry once, or simplify the request (smaller maxNodes, narrower selector).',
  },
  [ERROR_CODES.RATE_LIMITED]: {
    retry: true,
    retryAfterMs: 2000,
    hint: 'Too many requests. Back off and retry after a short delay.',
  },
  [ERROR_CODES.EXTENSION_DISCONNECTED]: {
    retry: true,
    retryAfterMs: 3000,
    alternativeMethod: 'health.ping',
    hint: 'Extension not connected. Check Chrome is running, then retry. Use health.ping to verify connectivity.',
  },
  [ERROR_CODES.NATIVE_HOST_UNAVAILABLE]: {
    retry: false,
    hint: 'Native host not reachable. Run `bbx doctor` to diagnose the installation.',
  },
  [ERROR_CODES.INVALID_REQUEST]: {
    retry: false,
    hint: 'Malformed method or params. Check the method name and parameter types.',
  },
  [ERROR_CODES.INTERNAL_ERROR]: {
    retry: true,
    retryAfterMs: 1000,
    hint: 'Unexpected extension error. Retry once; if persistent, check page.get_console for details.',
  },
});

/**
 * Get recovery hints for a given error code.
 *
 * @param {string} code
 * @returns {{ retry: boolean, retryAfterMs?: number, alternativeMethod?: string, hint: string } | null}
 */
export function getErrorRecovery(code) {
  return ERROR_RECOVERY[code] ?? null;
}

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
