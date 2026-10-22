// @ts-check

/**
 * Minimal structural validation for HAR 1.2 documents shared by the CLI and
 * the MCP server. Only the envelope is validated (`log.version` and the
 * `entries` array); deeper field checks are left to HAR consumers.
 */

/**
 * @param {unknown} value
 * @returns {value is import('./types.js').HarLog}
 */
export function isHarLog(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Reflect.get(value, 'version') === '1.2' &&
    Array.isArray(Reflect.get(value, 'entries'))
  );
}

/**
 * @param {unknown} value
 * @returns {value is import('./types.js').HarDocument}
 */
export function isHarDocument(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    isHarLog(Reflect.get(value, 'log'))
  );
}
