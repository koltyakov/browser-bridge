import { sanitizeIncidentalText, sanitizeIncidentalUrl } from '../../../protocol/src/index.js';

export type HarEvidenceEntry = import('../../../protocol/src/types.js').HarEvidenceEntry;

/** Build a truthful HAR 1.2 document from the metadata-only CDP evidence. The
size bound removes complete oldest entries; fields are never string-truncated
to make a malformed or misleading document fit. */
export function buildHar(
  evidence: HarEvidenceEntry[],
  options: { limit: number; urlPattern: string | null; creatorVersion: string; maxBytes?: number }
) {
  const limit = Math.max(0, Math.trunc(options.limit));
  const matching = evidence.filter((entry) => {
    const url = sanitizeHarUrl(entry.url);
    return options.urlPattern === null || url.includes(options.urlPattern);
  });
  const limited = matching.slice(-limit).map(toHarEntry);
  const omittedByLimit = Math.max(0, matching.length - limited.length);
  const maxBytes =
    typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes)
      ? Math.max(0, Math.trunc(options.maxBytes))
      : Number.POSITIVE_INFINITY;
  let omittedBySize = 0;
  let har = createDocument(limited, options.creatorVersion);
  let json = JSON.stringify(har);
  let byteLength = utf8ByteLength(json);

  while (byteLength > maxBytes && har.log.entries.length > 0) {
    har.log.entries.shift();
    omittedBySize += 1;
    json = JSON.stringify(har);
    byteLength = utf8ByteLength(json);
  }

  return {
    har,
    json,
    bytes: new TextEncoder().encode(json),
    byteLength,
    limit,
    count: har.log.entries.length,
    total: evidence.length,
    filteredTotal: matching.length,
    omittedByLimit,
    omittedBySize,
    truncated: omittedByLimit > 0 || omittedBySize > 0,
    fits: byteLength <= maxBytes,
  };
}

function toHarEntry(evidence: HarEvidenceEntry) {
  const protocol = sanitizeHarText(evidence.protocol, 64);
  const duration =
    typeof evidence.duration === 'number' && Number.isFinite(evidence.duration)
      ? Math.max(0, evidence.duration)
      : 0;
  const failureReason = sanitizeHarText(sanitizeIncidentalText(evidence.failureReason, 256), 256);
  return {
    startedDateTime: toIsoDate(evidence.startedAt),
    time: duration,
    request: {
      method: sanitizeHarText(evidence.method, 32),
      url: sanitizeHarUrl(evidence.url),
      httpVersion: protocol,
      cookies: [],
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: -1,
    },
    response: {
      status:
        typeof evidence.status === 'number' && Number.isFinite(evidence.status)
          ? evidence.status
          : 0,
      statusText: '',
      httpVersion: protocol,
      cookies: [],
      headers: [],
      content: {
        size: -1,
        mimeType: sanitizeHarText(evidence.mimeType, 256),
      },
      redirectURL: sanitizeHarUrl(evidence.redirectURL),
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: {
      send: -1,
      wait: -1,
      receive: -1,
    },
    _bbx: {
      resourceType: sanitizeHarText(evidence.resourceType, 64),
      fromCache: evidence.fromCache === true,
      fromDiskCache: evidence.fromDiskCache === true,
      fromServiceWorker: evidence.fromServiceWorker === true,
      fromPrefetchCache: evidence.fromPrefetchCache === true,
      failed: failureReason.length > 0,
      failureReason,
    },
  };
}

function createDocument(entries: Array<ReturnType<typeof toHarEntry>>, creatorVersion: string) {
  return {
    log: {
      version: '1.2',
      creator: {
        name: 'Browser Bridge',
        version: sanitizeHarText(creatorVersion, 64) || 'unknown',
      },
      entries,
    },
  };
}

function toIsoDate(value: number) {
  const timestamp = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function sanitizeHarText(value: unknown, maxLength: number) {
  return typeof value === 'string'
    ? replaceControlCharacters(value, ' ').trim().slice(0, maxLength)
    : '';
}

function sanitizeHarUrl(value: unknown) {
  const withoutControls =
    typeof value === 'string' ? replaceControlCharacters(value, '').trim() : value;
  return sanitizeIncidentalUrl(withoutControls);
}

function replaceControlCharacters(value: string, replacement: string) {
  let result = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    result += code <= 31 || (code >= 127 && code <= 159) ? replacement : character;
  }
  return result;
}
