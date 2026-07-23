// @ts-check

/** @typedef {import('./types.js').ErrorCode} ErrorCode */

export const ERROR_CODES = Object.freeze({
  ACCESS_DENIED: 'ACCESS_DENIED',
  TAB_MISMATCH: 'TAB_MISMATCH',
  ELEMENT_STALE: 'ELEMENT_STALE',
  ELEMENT_AMBIGUOUS: 'ELEMENT_AMBIGUOUS',
  ELEMENT_NOT_ACTIONABLE: 'ELEMENT_NOT_ACTIONABLE',
  ELEMENT_OBSCURED: 'ELEMENT_OBSCURED',
  ELEMENT_NOT_FOUND: 'ELEMENT_NOT_FOUND',
  INPUT_UNSUPPORTED: 'INPUT_UNSUPPORTED',
  INPUT_INVALID_TARGET: 'INPUT_INVALID_TARGET',
  INPUT_FOCUS_CHANGED: 'INPUT_FOCUS_CHANGED',
  DIALOG_NOT_OPEN: 'DIALOG_NOT_OPEN',
  DIALOG_ACTION_CONFLICT: 'DIALOG_ACTION_CONFLICT',
  RESULT_TRUNCATED: 'RESULT_TRUNCATED',
  RESULT_TOO_LARGE: 'RESULT_TOO_LARGE',
  SENSITIVE_TARGET_NOT_FOUND: 'SENSITIVE_TARGET_NOT_FOUND',
  CONTENT_SCRIPT_UNAVAILABLE: 'CONTENT_SCRIPT_UNAVAILABLE',
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
  [ERROR_CODES.RESULT_TOO_LARGE]: {
    retry: false,
    hint: 'The exact value exceeds the atomic sensitive-read limit. Use a narrower exact target; partial sensitive values are never returned.',
  },
  [ERROR_CODES.SENSITIVE_TARGET_NOT_FOUND]: {
    retry: false,
    alternativeMethod: 'page.get_storage',
    hint: 'The exact storage key does not exist. Use page.get_storage to inspect metadata before another deliberate sensitive read.',
  },
  [ERROR_CODES.ELEMENT_STALE]: {
    retry: false,
    alternativeMethod: 'dom.query',
    hint: 'Element was removed from the DOM. Re-query for a fresh elementRef, or retry an input once with recoverStale=true when the same page and a strong unique descriptor still apply.',
  },
  [ERROR_CODES.ELEMENT_AMBIGUOUS]: {
    retry: false,
    alternativeMethod: 'dom.query',
    hint: 'Multiple candidates matched, candidates tied, or a bounded stale-recovery scan could not prove uniqueness. Re-query and use a more specific selector or fresh elementRef.',
  },
  [ERROR_CODES.ELEMENT_NOT_ACTIONABLE]: {
    retry: false,
    alternativeMethod: 'dom.describe',
    hint: 'The target is hidden, disabled, inert, or has no rendered area. Inspect it and choose an actionable target.',
  },
  [ERROR_CODES.ELEMENT_OBSCURED]: {
    retry: false,
    alternativeMethod: 'layout.hit_test',
    hint: 'Another element blocks the target point. Inspect the blocker or wait for the overlay to close.',
  },
  [ERROR_CODES.ELEMENT_NOT_FOUND]: {
    retry: false,
    alternativeMethod: 'dom.query',
    hint: 'No element matched the target selector. Check or narrow the selector with dom.query.',
  },
  [ERROR_CODES.INPUT_UNSUPPORTED]: {
    retry: false,
    hint: 'The requested execution mode does not support this input operation. Use executionMode=dom or choose a CDP-supported input method.',
  },
  [ERROR_CODES.INPUT_INVALID_TARGET]: {
    retry: false,
    alternativeMethod: 'dom.describe',
    hint: 'The target is not compatible with this input operation or the requested option does not exist. Inspect the target and choose the appropriate control.',
  },
  [ERROR_CODES.INPUT_FOCUS_CHANGED]: {
    retry: false,
    alternativeMethod: 'dom.describe',
    hint: 'Focus moved away from the resolved editable target before native text dispatch. Inspect focus handlers or target the control that retained focus.',
  },
  [ERROR_CODES.DIALOG_NOT_OPEN]: {
    retry: false,
    alternativeMethod: 'page.handle_dialog',
    hint: 'No JavaScript dialog is currently observable. Inspect or trigger the dialog before trying another explicit action.',
  },
  [ERROR_CODES.DIALOG_ACTION_CONFLICT]: {
    retry: false,
    alternativeMethod: 'page.handle_dialog',
    hint: 'The observed dialog changed before or during CDP dispatch. Do not repeat the action automatically; inspect the current dialog state first.',
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
  [ERROR_CODES.CONTENT_SCRIPT_UNAVAILABLE]: {
    retry: false,
    hint: 'The page cannot host the Browser Bridge content script. Switch to a normal http(s) page in the enabled window.',
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
