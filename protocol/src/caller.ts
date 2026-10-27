/** Retain only bounded, display-safe caller metadata, including from stored history. */
export function normalizeBridgeCaller(
  value: unknown
): import('./types.js').BridgeCaller | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,127}$/.test(name)) return undefined;
  const source = candidate.source;
  if (source !== 'mcp' && source !== 'environment' && source !== 'explicit') return undefined;

  const caller: import('./types.js').BridgeCaller = { name, source };
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
