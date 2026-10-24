// @ts-check

/**
 * Retain only bounded, display-safe caller metadata, including from stored history.
 * @param {unknown} value
 * @returns {import('./types.js').BridgeCaller | undefined}
 */
export function normalizeBridgeCaller(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = /** @type {Record<string, unknown>} */ (value);
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,127}$/.test(name)) return undefined;
  const source = candidate.source;
  if (source !== 'mcp' && source !== 'environment' && source !== 'explicit') return undefined;
  /** @type {import('./types.js').BridgeCaller} */
  const caller = { name, source };
  const version = typeof candidate.version === 'string' ? candidate.version.trim() : '';
  if (/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version)) caller.version = version;
  if (
    source === 'environment' &&
    typeof candidate.signal === 'string' &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate.signal)
  ) {
    caller.signal = candidate.signal;
  }
  return caller;
}
