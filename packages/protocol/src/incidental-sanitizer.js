// @ts-check

const DEFAULT_MAX_STRING_LENGTH = 4_096;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_NODES = 1_000;
const REDACTED = '[redacted]';
const REDACTED_PATH = '[redacted-path]';

const SENSITIVE_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'password',
  'passphrase',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'apikey',
  'credential',
  'credentials',
]);

/** @param {string} key */
export function isSensitiveIncidentalKey(key) {
  return SENSITIVE_KEYS.has(key.toLowerCase().replaceAll(/[^a-z0-9]/gu, ''));
}

/**
 * Sanitize a URL that appears incidentally in logs, activity, or diagnostics.
 * Query-key context is retained while credentials, values, and fragments are
 * discarded.
 *
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeIncidentalUrl(value, maxLength = DEFAULT_MAX_STRING_LENGTH) {
  const raw = typeof value === 'string' ? value.slice(0, maxLength) : String(value ?? '');
  if (!raw) return '';
  if (/^data:/iu.test(raw)) {
    const mime = raw
      .slice(5)
      .split(/[;,]/u, 1)[0]
      .replace(/[^a-z0-9./+-]/giu, '')
      .slice(0, 100);
    return mime ? `data:${mime};${REDACTED}` : `data:${REDACTED}`;
  }
  if (/^blob:/iu.test(raw)) {
    try {
      return `blob:${new URL(raw.slice(5)).origin}/${REDACTED}`.slice(0, maxLength);
    } catch {
      return `blob:${REDACTED}`;
    }
  }
  if (/^file:/iu.test(raw)) {
    try {
      return `file:${sanitizeIncidentalPath(decodeURIComponent(new URL(raw).pathname))}`;
    } catch {
      return `file:${REDACTED_PATH}`;
    }
  }
  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    for (const key of new Set(parsed.searchParams.keys())) {
      parsed.searchParams.set(key, REDACTED);
    }
    return parsed.href.slice(0, maxLength);
  } catch {
    const withoutCredentials = raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/iu, '$1');
    const summary = withoutCredentials.split(/[?#]/u, 1)[0];
    return summary ? summary.slice(0, maxLength) : '[redacted-url]';
  }
}

/**
 * Reduce a local path to a basename-only marker.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeIncidentalPath(value) {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  const basename = raw.split(/[\\/]/u).filter(Boolean).at(-1)?.slice(0, 160);
  return basename ? `${REDACTED_PATH}/${basename}` : REDACTED_PATH;
}

/**
 * Sanitize secrets, URLs, and paths embedded in an incidental text message.
 *
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeIncidentalText(value, maxLength = DEFAULT_MAX_STRING_LENGTH) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  text = text.replace(
    /\b(authorization|proxy-authorization)\s*:\s*[^\r\n,;]+/giu,
    (_match, name) => `${name}: ${REDACTED}`
  );
  text = text.replace(/\b(set-cookie|cookie)\s*:\s*[^\r\n]+/giu, (_match, name) => {
    return `${name}: ${REDACTED}`;
  });
  text = text.replace(
    /\b(?:https?|file|blob|chrome|chrome-extension|edge|devtools):[^\s"'<>]+/giu,
    (url) => sanitizeIncidentalUrl(url, maxLength)
  );
  text = text.replace(/\bdata:[^\s"'<>]+/giu, (url) => sanitizeIncidentalUrl(url, maxLength));
  text = text.replace(/(?:^|[\s"'(])([a-z]:\\[^\s"')]+|\\\\[^\s"')]+)/giu, (match, path) =>
    match.replace(path, sanitizeIncidentalPath(path))
  );
  text = text.replace(
    /(?:^|[\s"'(])(\/(?:Users|home|private|var|tmp|opt|etc|root|usr|srv|mnt|Volumes|Library|Applications)\/[^\s"')]+)/gu,
    (match, path) => match.replace(path, sanitizeIncidentalPath(path))
  );
  return text.slice(0, maxLength);
}

/**
 * Recursively sanitize incidental structured data while bounding traversal.
 * Explicit sensitive-read values must never pass through this helper.
 *
 * @param {unknown} value
 * @param {{ maxDepth?: number, maxNodes?: number, maxStringLength?: number }} [options]
 * @returns {unknown}
 */
export function sanitizeIncidentalValue(value, options = {}) {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  const seen = new WeakSet();
  let nodes = 0;

  /** @param {unknown} current @param {number} depth @param {string | null} key @returns {unknown} */
  const visit = (current, depth, key) => {
    nodes += 1;
    if (nodes > maxNodes) return '[truncated]';
    if (key !== null && isSensitiveIncidentalKey(key)) return REDACTED;
    if (typeof current === 'string') {
      if (key && /url|uri|href|endpoint/iu.test(key)) {
        return sanitizeIncidentalUrl(current, maxStringLength);
      }
      if (key && /path|directory|filename/iu.test(key) && isAbsolutePath(current)) {
        return sanitizeIncidentalPath(current);
      }
      return sanitizeIncidentalText(current, maxStringLength);
    }
    if (
      current === null ||
      typeof current === 'number' ||
      typeof current === 'boolean' ||
      typeof current === 'undefined'
    ) {
      return current;
    }
    if (
      typeof current === 'bigint' ||
      typeof current === 'symbol' ||
      typeof current === 'function'
    ) {
      return sanitizeIncidentalText(current, maxStringLength);
    }
    if (current instanceof Error) {
      return {
        name: sanitizeIncidentalText(current.name, maxStringLength),
        message: sanitizeIncidentalText(current.message, maxStringLength),
      };
    }
    if (depth >= maxDepth) return '[truncated]';
    if (seen.has(current)) return '[circular]';
    seen.add(current);
    if (Array.isArray(current)) {
      return current.map((item) => visit(item, depth + 1, null));
    }
    const result = /** @type {Record<string, unknown>} */ ({});
    for (const [childKey, childValue] of Object.entries(current)) {
      result[sanitizeIncidentalText(childKey, 160)] = visit(childValue, depth + 1, childKey);
    }
    return result;
  };

  return visit(value, 0, null);
}

/** @param {string} value */
function isAbsolutePath(value) {
  return /^(?:[a-z]:\\|\\\\|\/(?:Users|home|private|var|tmp|opt|etc|root|usr|srv|mnt|Volumes|Library|Applications)\/)/iu.test(
    value
  );
}
