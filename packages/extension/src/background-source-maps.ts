import {
  FlattenMap,
  decodedMappings,
  originalPositionFor,
  type SectionedSourceMapInput,
  type TraceMap,
} from '@jridgewell/trace-mapping';
import { sanitizeIncidentalUrl } from '../../../protocol/src/index.js';
import { boundUntrustedText } from './console-stack.js';

export type ConsoleEntry = import('../../../protocol/src/types.js').ConsoleEntry;
export type ConsoleStackFrame = import('../../../protocol/src/types.js').ConsoleStackFrame;
export type ConsoleFrameSource = import('../../../protocol/src/types.js').ConsoleFrameSource;
export type SourceUnavailableReason =
  import('../../../protocol/src/types.js').ConsoleSourceUnavailableReason;

/** Scripts the tab actually loaded, read in the isolated world. */
export type LoadedScripts = { documentUrl: string; scripts: string[] };

export type SourceResolverLimits = {
  /** Distinct scripts resolved per read. */
  maxScripts: number;
  /** Wall-clock budget for one read, including every fetch. */
  totalBudgetMs: number;
  /** Timeout for one script or map fetch. */
  fetchTimeoutMs: number;
  maxScriptBytes: number;
  maxMapBytes: number;
  /** Cached results are reused without a request for this long. */
  freshMs: number;
  maxCacheEntries: number;
  /** Estimated decoded-map memory the cache may hold. */
  maxCacheCost: number;
};

export const DEFAULT_SOURCE_RESOLVER_LIMITS: Readonly<SourceResolverLimits> = Object.freeze({
  maxScripts: 8,
  totalBudgetMs: 8_000,
  fetchTimeoutMs: 5_000,
  maxScriptBytes: 10 * 1024 * 1024,
  maxMapBytes: 20 * 1024 * 1024,
  freshMs: 60_000,
  maxCacheEntries: 16,
  maxCacheCost: 96 * 1024 * 1024,
});

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type SourceResolverDependencies = {
  fetch: FetchLike;
  /** Resolves null when the list cannot be read; resolution then fails closed. */
  readLoadedScripts: (tabId: number) => Promise<LoadedScripts | null>;
  now?: () => number;
  limits?: Partial<SourceResolverLimits>;
};

const MAX_LOADED_SCRIPTS = 2_000;
const MAX_LOADED_URL_CHARS = 4_096;
const MAX_FRAME_URL_CHARS = 2_048;
const MAX_SOURCE_FILE_CHARS = 512;
const MAX_SOURCE_NAME_CHARS = 200;
const MAX_MAP_SECTIONS = 1_000;
const MAX_MAP_DEPTH = 4;
// Rough decoded size per map text character, so a few large maps fill the cache.
const DECODED_COST_PER_CHAR = 8;

type ScriptResolution =
  | { kind: 'map'; map: TraceMap }
  | { kind: 'unavailable'; reason: SourceUnavailableReason };

type CacheEntry = {
  validator: string | null;
  storedAt: number;
  cost: number;
  resolution: ScriptResolution;
};

class ResolutionFailure extends Error {
  reason: SourceUnavailableReason;
  constructor(reason: SourceUnavailableReason) {
    super(reason);
    this.reason = reason;
  }
}

/** Reasons worth remembering: they describe the bytes, not the network. */
const CACHEABLE_REASONS = new Set<SourceUnavailableReason>([
  'no_source_map',
  'invalid_map_url',
  'unsupported_map_url',
  'cross_origin_map',
  'script_too_large',
  'map_too_large',
  'malformed_map',
]);

function isHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function parseUrl(value: string, base?: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function isLocalIpv4(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Expand a bracketless IPv6 literal, as URL serializes it, to eight hextets. */
function expandIpv6(address: string): number[] | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] =>
    part ? part.split(':').map((hextet) => Number.parseInt(hextet, 16)) : [];
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const hextets = [...head, ...Array.from({ length: Math.max(0, fill) }, () => 0), ...tail];
  return hextets.length === 8 && hextets.every((hextet) => hextet >= 0 && hextet <= 0xffff)
    ? hextets
    : null;
}

const LOCAL_NAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.corp',
  '.home.arpa',
];

/** Whether a URL hostname names this machine or the user's own network:
loopback, private, link-local and carrier-grade NAT addresses, single-label
names, and the usual private suffixes. A public name that resolves to a
private address cannot be detected here. An unparsable host counts as local. */
export function isLocalNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '');
  if (!host) return true;
  if (host.startsWith('[')) {
    const hextets = expandIpv6(host.replace(/^\[|\]$/gu, ''));
    if (!hextets) return true;
    const [first] = hextets;
    if (hextets.slice(0, 7).every((hextet) => hextet === 0)) return true; // :: and ::1
    if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return true;
    // IPv4-mapped ::ffff:a.b.c.d
    if (hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff) {
      return isLocalIpv4(hextets[6] >> 8, hextets[6] & 0xff);
    }
    return false;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/u.exec(host);
  if (ipv4) return isLocalIpv4(Number(ipv4[1]), Number(ipv4[2]));
  if (!host.includes('.')) return true;
  return LOCAL_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** The key a loaded script shares with a parsed frame URL. Frames are
sanitized before they leave the page boundary, so match on the same form. */
function frameUrlKey(rawUrl: string): string {
  return sanitizeIncidentalUrl(
    boundUntrustedText(rawUrl, MAX_FRAME_URL_CHARS),
    MAX_FRAME_URL_CHARS
  );
}

/** Index the isolated-world script list by frame key. A key two different
scripts share is ambiguous and maps to null, so neither is fetched. */
function indexLoadedScripts(loaded: LoadedScripts): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const raw of loaded.scripts.slice(0, MAX_LOADED_SCRIPTS)) {
    if (typeof raw !== 'string' || !raw || raw.length > MAX_LOADED_URL_CHARS) continue;
    const parsed = parseUrl(raw);
    if (!parsed || !isHttpUrl(parsed)) continue;
    const key = frameUrlKey(parsed.href);
    if (!key) continue;
    const existing = index.get(key);
    if (existing === undefined) index.set(key, parsed.href);
    else if (existing !== parsed.href) index.set(key, null);
  }
  return index;
}

function responseValidator(response: Response): string | null {
  const etag = response.headers.get('etag');
  if (etag) return `etag:${etag}`;
  const modified = response.headers.get('last-modified');
  if (modified) return `modified:${modified}`;
  const length = response.headers.get('content-length');
  return length ? `length:${length}` : null;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The stream may already be closed or errored.
  }
}

/** Read a response body as UTF-8, refusing it as soon as it exceeds maxBytes.
Content-Length is checked first so an honest oversize body is never read. */
async function readBoundedText(
  response: Response,
  maxBytes: number,
  tooLarge: SourceUnavailableReason
): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelBody(response);
    throw new ResolutionFailure(tooLarge);
  }
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // Cancellation is best effort.
      }
      throw new ResolutionFailure(tooLarge);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** Find the last sourceMappingURL comment. Bundlers append it at the end. */
export function findSourceMappingUrl(text: string): string | null {
  const marker = 'sourceMappingURL=';
  let index = text.lastIndexOf(marker);
  while (index >= 0) {
    const prefix = text.slice(Math.max(0, index - 4), index);
    if (/(?:\/\/|\/\*)[#@]\s?$/u.test(prefix)) {
      // Unbounded on purpose: inline data: maps are long, and the script
      // itself is already capped.
      const value = /^[^\s'"`*]+/u.exec(text.slice(index + marker.length));
      return value ? value[0] : null;
    }
    index = index > 0 ? text.lastIndexOf(marker, index - 1) : -1;
  }
  return null;
}

/** Decode a data: URL holding a source map without any network request. */
function decodeDataUrl(url: string, maxBytes: number): string {
  const comma = url.indexOf(',');
  if (comma < 0) throw new ResolutionFailure('malformed_map');
  const meta = url.slice(5, comma).toLowerCase();
  const payload = url.slice(comma + 1);
  if (meta.endsWith(';base64')) {
    if (Math.floor((payload.length * 3) / 4) > maxBytes) {
      throw new ResolutionFailure('map_too_large');
    }
    try {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      throw new ResolutionFailure('malformed_map');
    }
  }
  if (payload.length > maxBytes) throw new ResolutionFailure('map_too_large');
  try {
    return decodeURIComponent(payload);
  } catch {
    throw new ResolutionFailure('malformed_map');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Validate the map shape and drop sourcesContent before decoding, so source
text is neither retained nor returned. Sections may nest a few levels deep. */
function prepareMap(value: unknown, depth: number = 0): Record<string, unknown> {
  if (!isRecord(value) || value.version !== 3 || depth > MAX_MAP_DEPTH) {
    throw new ResolutionFailure('malformed_map');
  }
  const prepared: Record<string, unknown> = { ...value };
  delete prepared.sourcesContent;
  if (Array.isArray(value.sections)) {
    if (value.sections.length > MAX_MAP_SECTIONS) throw new ResolutionFailure('malformed_map');
    prepared.sections = value.sections.map((section: unknown) => {
      if (!isRecord(section) || !isRecord(section.offset) || !isRecord(section.map)) {
        // Sections that point at a url would need another fetch; refuse them.
        throw new ResolutionFailure('malformed_map');
      }
      return { offset: section.offset, map: prepareMap(section.map, depth + 1) };
    });
    return prepared;
  }
  // The VLQ decoder is lenient, so reject characters it would misread.
  if (
    typeof value.mappings !== 'string' ||
    !/^[A-Za-z0-9+/,;]*$/u.test(value.mappings) ||
    !Array.isArray(value.sources)
  ) {
    throw new ResolutionFailure('malformed_map');
  }
  return prepared;
}

function decodeMap(text: string, baseUrl: string): TraceMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ResolutionFailure('malformed_map');
  }
  const prepared = prepareMap(parsed);
  try {
    const map = FlattenMap(prepared as SectionedSourceMapInput, baseUrl);
    // Decode now so malformed mappings fail here, not on a later lookup.
    decodedMappings(map);
    return map;
  } catch {
    throw new ResolutionFailure('malformed_map');
  }
}

/** Strip the scheme, a bundler namespace before "/./", and leading "./" or
"/", so webpack://app/./src/a.ts and https://host/src/a.ts become src/a.ts. */
export function sourcePathFromFile(file: string): string {
  let path = file;
  const http = /^https?:\/\/[^/]*(\/[^?#]*)?/iu.exec(path);
  if (http) {
    path = http[1] ?? '';
  } else if (/^file:\/\//iu.test(path)) {
    return path.slice(7);
  } else {
    const scheme = /^[a-z][a-z0-9+.-]*:(?:\/\/)?/iu.exec(path);
    if (scheme) {
      path = path.slice(scheme[0].length);
      path = path.replace(/^[^/]*\/\.\//u, '');
    }
  }
  path = path.replace(/^(?:\.?\/)+/u, '').replaceAll('/./', '/');
  return path;
}

function lookupFrame(
  map: TraceMap,
  frame: ConsoleStackFrame
): ConsoleFrameSource | SourceUnavailableReason {
  let original: ReturnType<typeof originalPositionFor>;
  try {
    original = originalPositionFor(map, { line: frame.line, column: frame.column - 1 });
  } catch {
    return 'malformed_map';
  }
  // Segments can name a source index the map does not have; treat any
  // non-string or non-positive result as unmapped.
  if (
    typeof original.source !== 'string' ||
    !original.source ||
    !Number.isSafeInteger(original.line) ||
    !Number.isSafeInteger(original.column) ||
    original.line < 1 ||
    original.column < 0
  ) {
    return 'no_mapping';
  }
  // Keep bundler URLs such as webpack:// as the map wrote them. Relative
  // sources are only meaningful resolved against the map URL.
  const index = map.resolvedSources.indexOf(original.source);
  const raw = index >= 0 ? map.sources[index] : null;
  const file = boundUntrustedText(
    typeof raw === 'string' && /^[a-z][a-z0-9+.-]*:/iu.test(raw) && !/^https?:/iu.test(raw)
      ? raw
      : original.source,
    MAX_SOURCE_FILE_CHARS
  );
  const source: ConsoleFrameSource = {
    file,
    path: boundUntrustedText(sourcePathFromFile(file), MAX_SOURCE_FILE_CHARS),
    line: original.line,
    column: original.column + 1,
  };
  if (typeof original.name === 'string' && original.name) {
    const name = boundUntrustedText(original.name, MAX_SOURCE_NAME_CHARS);
    if (name) source.name = name;
  }
  return source;
}

/** Resolve console stack frames through the source maps of scripts the tab
loaded. Requests are GET only, bounded in size and time, never follow a
redirect, and send credentials only for scripts on the document's origin. */
export function createSourceResolver(dependencies: SourceResolverDependencies) {
  const limits: SourceResolverLimits = {
    ...DEFAULT_SOURCE_RESOLVER_LIMITS,
    ...dependencies.limits,
  };
  const now = dependencies.now ?? (() => Date.now());
  // Best effort: the worker can stop at any time and take this with it.
  const cache = new Map<string, CacheEntry>();
  let cacheCost = 0;
  let generation = 0;

  function cacheGet(key: string): CacheEntry | undefined {
    const entry = cache.get(key);
    if (entry) {
      cache.delete(key);
      cache.set(key, entry);
    }
    return entry;
  }

  function cacheDelete(key: string): void {
    const entry = cache.get(key);
    if (!entry) return;
    cacheCost -= entry.cost;
    cache.delete(key);
  }

  function cacheSet(key: string, entry: CacheEntry): void {
    cacheDelete(key);
    if (entry.cost > limits.maxCacheCost) return;
    cache.set(key, entry);
    cacheCost += entry.cost;
    for (const oldest of cache.keys()) {
      if (cache.size <= limits.maxCacheEntries && cacheCost <= limits.maxCacheCost) break;
      cacheDelete(oldest);
    }
  }

  async function boundedFetch(
    url: string,
    credentials: RequestCredentials,
    deadline: number
  ): Promise<{ response: Response; signal: AbortSignal; done: () => void }> {
    const remaining = Math.min(limits.fetchTimeoutMs, deadline - now());
    if (remaining <= 0) throw new ResolutionFailure('budget_exhausted');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    const done = () => clearTimeout(timer);
    try {
      const response = await dependencies.fetch(url, {
        method: 'GET',
        credentials,
        // A redirect could point anywhere, including another origin. Refuse
        // all of them rather than follow one.
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        cache: 'default',
        signal: controller.signal,
      });
      return { response, signal: controller.signal, done };
    } catch (error) {
      done();
      throw controller.signal.aborted ? new ResolutionFailure('fetch_timeout') : error;
    }
  }

  async function fetchText(
    url: string,
    credentials: RequestCredentials,
    deadline: number,
    maxBytes: number,
    failed: SourceUnavailableReason,
    tooLarge: SourceUnavailableReason
  ): Promise<{ text: string; response: Response }> {
    let request: Awaited<ReturnType<typeof boundedFetch>>;
    try {
      request = await boundedFetch(url, credentials, deadline);
    } catch (error) {
      if (error instanceof ResolutionFailure) throw error;
      throw new ResolutionFailure(failed);
    }
    try {
      if (!request.response.ok) {
        await cancelBody(request.response);
        throw new ResolutionFailure(failed);
      }
      const text = await readBoundedText(request.response, maxBytes, tooLarge);
      return { text, response: request.response };
    } catch (error) {
      if (error instanceof ResolutionFailure) throw error;
      throw new ResolutionFailure(request.signal.aborted ? 'fetch_timeout' : failed);
    } finally {
      request.done();
    }
  }

  async function resolveScript(
    scriptUrl: string,
    credentials: RequestCredentials,
    deadline: number
  ): Promise<ScriptResolution> {
    const key = `${credentials}|${scriptUrl}`;
    const cached = cacheGet(key);
    if (cached && now() - cached.storedAt < limits.freshMs) return cached.resolution;
    const startGeneration = generation;
    try {
      const { text, response } = await fetchText(
        scriptUrl,
        credentials,
        deadline,
        limits.maxScriptBytes,
        'script_fetch_failed',
        'script_too_large'
      );
      const validator = responseValidator(response);
      if (cached && validator !== null && cached.validator === validator) {
        // Unchanged script: keep the decoded map and skip the map request.
        cached.storedAt = now();
        return cached.resolution;
      }
      const header = response.headers.get('sourcemap') ?? response.headers.get('x-sourcemap');
      const reference = header?.trim() || findSourceMappingUrl(text);
      if (!reference) throw new ResolutionFailure('no_source_map');
      let mapText: string;
      let baseUrl = scriptUrl;
      const isDataUrl = /^data:/iu.test(reference);
      const mapUrl = isDataUrl ? null : parseUrl(reference, scriptUrl);
      if (isDataUrl) {
        // Relative sources in an inline map resolve against the script.
        mapText = decodeDataUrl(reference, limits.maxMapBytes);
      } else if (!mapUrl) {
        throw new ResolutionFailure('invalid_map_url');
      } else if (!isHttpUrl(mapUrl)) {
        throw new ResolutionFailure('unsupported_map_url');
      } else if (mapUrl.origin !== new URL(scriptUrl).origin) {
        throw new ResolutionFailure('cross_origin_map');
      } else {
        baseUrl = mapUrl.href;
        mapText = (
          await fetchText(
            mapUrl.href,
            credentials,
            deadline,
            limits.maxMapBytes,
            'map_fetch_failed',
            'map_too_large'
          )
        ).text;
      }
      const map = decodeMap(mapText, baseUrl);
      const resolution: ScriptResolution = { kind: 'map', map };
      if (startGeneration === generation) {
        cacheSet(key, {
          validator,
          storedAt: now(),
          cost: mapText.length * DECODED_COST_PER_CHAR,
          resolution,
        });
      }
      return resolution;
    } catch (error) {
      const reason = error instanceof ResolutionFailure ? error.reason : 'resolution_failed';
      const resolution: ScriptResolution = { kind: 'unavailable', reason };
      if (CACHEABLE_REASONS.has(reason) && startGeneration === generation) {
        cacheSet(key, { validator: null, storedAt: now(), cost: 1, resolution });
      }
      return resolution;
    }
  }

  async function readLoaded(tabId: number): Promise<LoadedScripts | null> {
    try {
      const loaded = await dependencies.readLoadedScripts(tabId);
      if (
        !loaded ||
        typeof loaded.documentUrl !== 'string' ||
        !Array.isArray(loaded.scripts) ||
        !loaded.scripts.every((script) => typeof script === 'string')
      ) {
        return null;
      }
      return loaded;
    } catch {
      return null;
    }
  }

  /** Add source or sourceUnavailable to every frame. Never throws for a
resolution problem; frames always keep their generated position. */
  async function resolve(tabId: number, entries: ConsoleEntry[]): Promise<ConsoleEntry[]> {
    if (!entries.some((entry) => entry.stack?.length)) return entries;
    const deadline = now() + limits.totalBudgetMs;
    const loaded = await readLoaded(tabId);
    const index = loaded ? indexLoadedScripts(loaded) : null;
    const documentUrl = loaded ? parseUrl(loaded.documentUrl) : null;
    const pending = new Map<string, Promise<ScriptResolution>>();
    type Plan = { frame: ConsoleStackFrame; script?: string; reason?: SourceUnavailableReason };
    const plans: Plan[][] = entries.map((entry) =>
      (entry.stack ?? []).map((frame): Plan => {
        const parsed = parseUrl(frame.url);
        if (!parsed || !isHttpUrl(parsed)) return { frame, reason: 'unsupported_scheme' };
        if (!index) return { frame, reason: 'loaded_scripts_unavailable' };
        const script = index.get(frame.url);
        if (script === undefined) return { frame, reason: 'not_a_loaded_script' };
        if (script === null) return { frame, reason: 'ambiguous_script' };
        const scriptUrl = new URL(script);
        const sameOrigin = documentUrl !== null && scriptUrl.origin === documentUrl.origin;
        // The page chooses its own <script src> values, and the browser may
        // have refused to load one that this worker could still reach. A page
        // on the public web must not steer a request at the user's machine or
        // network; a local page may name its local dev server.
        if (
          !sameOrigin &&
          isLocalNetworkHost(scriptUrl.hostname) &&
          !(
            documentUrl !== null &&
            isHttpUrl(documentUrl) &&
            isLocalNetworkHost(documentUrl.hostname)
          )
        ) {
          return { frame, reason: 'local_network_script' };
        }
        if (!pending.has(script)) {
          if (pending.size >= limits.maxScripts) return { frame, reason: 'budget_exhausted' };
          pending.set(script, resolveScript(script, sameOrigin ? 'include' : 'omit', deadline));
        }
        return { frame, script };
      })
    );
    const resolved = new Map<string, ScriptResolution>();
    await Promise.all(
      [...pending].map(async ([script, promise]) => {
        resolved.set(script, await promise);
      })
    );
    return entries.map((entry, entryIndex) => {
      if (!entry.stack?.length) return entry;
      const stack = plans[entryIndex].map(({ frame, script, reason }): ConsoleStackFrame => {
        const resolution = script ? resolved.get(script) : undefined;
        let outcome: ConsoleFrameSource | SourceUnavailableReason = reason ?? 'resolution_failed';
        if (resolution?.kind === 'map') outcome = lookupFrame(resolution.map, frame);
        else if (resolution) outcome = resolution.reason;
        return typeof outcome === 'string'
          ? { ...frame, sourceUnavailable: outcome }
          : { ...frame, source: outcome };
      });
      return { ...entry, stack };
    });
  }

  return {
    resolve,
    /** Drop every cached map, for example when window access ends. */
    clear(): void {
      generation += 1;
      cache.clear();
      cacheCost = 0;
    },
    /** Test and diagnostics view of the cache. */
    get cacheSize(): number {
      return cache.size;
    },
  };
}

export type SourceResolver = ReturnType<typeof createSourceResolver>;

type ChromeWithIsolatedScripting = {
  scripting: {
    executeScript: <Args extends unknown[], Result>(
      config: chrome.scripting.ScriptInjection<Args, Result>
    ) => Promise<unknown[]>;
  };
};

/** Read the scripts the top frame loaded from the isolated world, where page
code cannot replace document.scripts or the performance timeline. Resolves
null when the list cannot be read, so callers fail closed. */
export async function readTabLoadedScripts(
  tabId: number,
  chromeObj: ChromeWithIsolatedScripting
): Promise<LoadedScripts | null> {
  try {
    const results = await chromeObj.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'ISOLATED',
      func: () => {
        const scripts: string[] = [];
        const add = (value: unknown): void => {
          if (typeof value === 'string' && value && scripts.length < 2_000) {
            scripts.push(value.slice(0, 4_096));
          }
        };
        // Only types the browser executes, so an inert <script type="text/x">
        // cannot nominate a URL the tab never requested.
        const executable = new Set([
          '',
          'module',
          'text/javascript',
          'application/javascript',
          'text/ecmascript',
          'application/ecmascript',
          'application/x-javascript',
          'text/x-javascript',
        ]);
        try {
          for (const script of Array.from(document.scripts).slice(0, 1_000)) {
            const type = (script.getAttribute('type') ?? '').trim().toLowerCase();
            if (script.src && !script.noModule && executable.has(type)) add(script.src);
          }
        } catch {
          // A detached or unusual document leaves the timeline as the source.
        }
        try {
          for (const entry of performance.getEntriesByType('resource').slice(0, 1_000)) {
            if ((entry as PerformanceResourceTiming).initiatorType === 'script') add(entry.name);
          }
        } catch {
          // Resource timing can be unavailable; the DOM list still applies.
        }
        return { documentUrl: String(document.URL), scripts };
      },
    });
    const result = (results?.[0] as { result?: unknown } | undefined)?.result;
    if (!result || typeof result !== 'object') return null;
    const record = result as { documentUrl?: unknown; scripts?: unknown };
    if (typeof record.documentUrl !== 'string' || !Array.isArray(record.scripts)) return null;
    return {
      documentUrl: record.documentUrl.slice(0, MAX_LOADED_URL_CHARS),
      scripts: record.scripts
        .slice(0, MAX_LOADED_SCRIPTS)
        .filter((script): script is string => typeof script === 'string'),
    };
  } catch {
    return null;
  }
}
