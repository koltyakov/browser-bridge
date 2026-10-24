import { getMainWorldInstrumentationKey } from './background-main-world-instrumentation.js';
import { sanitizeIncidentalUrl } from '../../../protocol/src/index.js';

export type NetworkInstrumentationRecord = {
  enabled: boolean;
  epoch: string;
  nextSequence: number;
  generation: number;
  /** Highest sequence evicted from the bounded buffer, or -1. Evicting older
   * entries is routine; only evicting one at or after a cursor loses evidence. */
  evictedThrough: number;
  buffer: Array<{
    method: string;
    url: string;
    status: number;
    duration: number;
    type: string;
    ts: number;
    size: number;
    sequence: number;
  }>;
  dropped: number;
  originalFetch: typeof globalThis.fetch;
  originalOpen: typeof XMLHttpRequest.prototype.open;
  originalSend: typeof XMLHttpRequest.prototype.send;
  wrappedFetch: typeof globalThis.fetch;
  wrappedOpen: typeof XMLHttpRequest.prototype.open;
  wrappedSend: typeof XMLHttpRequest.prototype.send;
};

export type NetworkCaptureCursor = {
  epoch: string;
  nextSequence: number;
  generation: number;
  evictedThrough?: number;
};

export type ChromeWithScripting = {
  scripting: {
    executeScript: <Args extends unknown[], Result>(
      config: chrome.scripting.ScriptInjection<Args, Result>
    ) => Promise<unknown[]>;
  };
  storage?: {
    session?: {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (value: Record<string, unknown>) => Promise<void>;
    };
  };
};

/** Inject the network interceptor into the page's main world. Patches
fetch and XMLHttpRequest to capture request/response metadata. */
export async function ensureNetworkInterceptor(
  tabId: number,
  chromeObj: ChromeWithScripting
): Promise<void> {
  const instrumentationKey = await getMainWorldInstrumentationKey(chromeObj);
  await chromeObj.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (
      recordKey: string = '__bbx_instrumentation_test',
      captureEpoch: string = 'test_epoch'
    ) => {
      const page = globalThis as Record<string, unknown>;
      const root =
        page[recordKey] && typeof page[recordKey] === 'object'
          ? (page[recordKey] as Record<string, unknown>)
          : (page[recordKey] = {});
      const existing = root.network;
      if (existing && typeof existing === 'object') {
        const record = existing as NetworkInstrumentationRecord;
        if (typeof record.epoch !== 'string' || !Number.isSafeInteger(record.nextSequence)) {
          record.enabled = false;
          if (globalThis.fetch === record.wrappedFetch) globalThis.fetch = record.originalFetch;
          if (XMLHttpRequest.prototype.open === record.wrappedOpen)
            XMLHttpRequest.prototype.open = record.originalOpen;
          if (XMLHttpRequest.prototype.send === record.wrappedSend)
            XMLHttpRequest.prototype.send = record.originalSend;
          delete root.network;
        } else {
          // Records from an older build do not track evictions. Every entry they
          // could have evicted predates the next cursor taken from them.
          if (!Number.isSafeInteger(record.evictedThrough))
            record.evictedThrough = record.nextSequence - 1;
          if (!record.enabled) {
            record.buffer.length = 0;
            record.dropped = 0;
            record.generation += 1;
          }
          record.enabled = true;
          if (globalThis.fetch === record.originalFetch) globalThis.fetch = record.wrappedFetch;
          if (XMLHttpRequest.prototype.open === record.originalOpen) {
            XMLHttpRequest.prototype.open = record.wrappedOpen;
          }
          if (XMLHttpRequest.prototype.send === record.originalSend) {
            XMLHttpRequest.prototype.send = record.wrappedSend;
          }
          globalThis.__bb_network_installed = true;
          globalThis.__bb_network_buffer = record.buffer;
          globalThis.__bb_network_dropped = record.dropped;
          return;
        }
      }

      const buffer: Array<{
        method: string;
        url: string;
        status: number;
        duration: number;
        type: string;
        ts: number;
        size: number;
        sequence: number;
      }> = [];
      const originalFetch = globalThis.fetch;
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;
      const xhrMetadata = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
      const record: NetworkInstrumentationRecord = {
        enabled: false,
        epoch: captureEpoch,
        nextSequence: 0,
        generation: 0,
        evictedThrough: -1,
        buffer,
        dropped: 0,
        originalFetch,
        originalOpen,
        originalSend,

        wrappedFetch: originalFetch,

        wrappedOpen: originalOpen,

        wrappedSend: originalSend,
      };
      root.network = record;
      globalThis.__bb_network_installed = true;
      globalThis.__bb_network_buffer = buffer;
      globalThis.__bb_network_dropped = 0;
      const MAX = 200;

      record.wrappedFetch = async function (...args) {
        // Read metadata without constructing a Request: building a Request
        // from a Request input disturbs its body and would make the page's
        // own fetch call fail with "body already used".
        const input = args[0] as unknown;
        const init = args[1] as { method?: unknown } | undefined;
        const requestLike =
          input && typeof input === 'object' && 'url' in input && 'method' in input
            ? (input as { url: unknown; method: unknown })
            : null;
        let url = requestLike ? String(requestLike.url) : String(input);
        try {
          url = new URL(url, globalThis.location?.href).href;
        } catch {
          /* keep the raw value when it cannot be resolved */
        }
        const method = String(init?.method || requestLike?.method || 'GET').toUpperCase();
        const entry = {
          method,
          url,
          status: 0,
          duration: 0,
          type: 'fetch',
          ts: Date.now(),
          size: 0,
          sequence: record.nextSequence++,
        };
        const startTime = performance.now();
        try {
          const resp = await originalFetch.apply(globalThis, args);
          entry.status = resp.status;
          entry.duration = Math.round(performance.now() - startTime);
          const cl = resp.headers.get('content-length');
          if (cl) entry.size = Number(cl);
          return resp;
        } catch (err) {
          entry.status = 0;
          entry.duration = Math.round(performance.now() - startTime);
          throw err;
        } finally {
          if (record.enabled) {
            buffer.push(entry);
            if (buffer.length > MAX) {
              record.dropped += buffer.length - MAX;
              globalThis.__bb_network_dropped = record.dropped;
              for (const evicted of buffer.splice(0, buffer.length - MAX))
                record.evictedThrough = Math.max(record.evictedThrough, evicted.sequence);
            }
          }
        }
      };
      globalThis.fetch = record.wrappedFetch;

      record.wrappedOpen = function (
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
        ...rest: [async?: boolean, username?: string | null, password?: string | null]
      ): void {
        xhrMetadata.set(this, { method, url: String(url) });
        return Reflect.apply(originalOpen, this, [method, url, ...rest]);
      };
      XMLHttpRequest.prototype.open = record.wrappedOpen;
      record.wrappedSend = function (
        this: XMLHttpRequest,
        ...args: Parameters<XMLHttpRequest['send']>
      ): void {
        const metadata = xhrMetadata.get(this);
        const entry = {
          method: metadata?.method || 'GET',
          url: metadata?.url || '',
          status: 0,
          duration: 0,
          type: 'xhr',
          ts: Date.now(),
          size: 0,
          sequence: record.nextSequence++,
        };
        const startTime = performance.now();
        const onLoadEnd = () => {
          entry.status = this.status;
          entry.duration = Math.round(performance.now() - startTime);
          const cl = this.getResponseHeader('content-length');
          if (cl) entry.size = Number(cl);
          if (!record.enabled) return;
          buffer.push(entry);
          if (buffer.length > MAX) {
            record.dropped += buffer.length - MAX;
            globalThis.__bb_network_dropped = record.dropped;
            for (const evicted of buffer.splice(0, buffer.length - MAX))
              record.evictedThrough = Math.max(record.evictedThrough, evicted.sequence);
          }
        };
        this.addEventListener('loadend', onLoadEnd, { once: true });
        try {
          return originalSend.apply(this, args);
        } catch (error) {
          this.removeEventListener('loadend', onLoadEnd);
          throw error;
        }
      };
      XMLHttpRequest.prototype.send = record.wrappedSend;
      record.enabled = true;
    },
    args: [instrumentationKey, crypto.randomUUID()],
  });
}

/** Stop fetch/XHR collection, clear buffered data, and restore owned wrappers. */
export async function disableNetworkInterceptor(
  tabId: number,
  chromeObj: ChromeWithScripting
): Promise<void> {
  const instrumentationKey = await getMainWorldInstrumentationKey(chromeObj);
  await chromeObj.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (_shouldClear: boolean, recordKey: string = '__bbx_instrumentation_test') => {
      const root = (globalThis as Record<string, unknown>)[recordKey];
      const record =
        root && typeof root === 'object'
          ? (root as { network?: NetworkInstrumentationRecord }).network
          : null;
      if (record && typeof record === 'object') {
        record.enabled = false;
        record.buffer.length = 0;
        record.dropped = 0;
        if (globalThis.fetch === record.wrappedFetch) globalThis.fetch = record.originalFetch;
        if (XMLHttpRequest.prototype.open === record.wrappedOpen) {
          XMLHttpRequest.prototype.open = record.originalOpen;
        }
        if (XMLHttpRequest.prototype.send === record.wrappedSend) {
          XMLHttpRequest.prototype.send = record.originalSend;
        }
      }
      if (Array.isArray(globalThis.__bb_network_buffer)) {
        globalThis.__bb_network_buffer.length = 0;
      }
      globalThis.__bb_network_dropped = 0;
      globalThis.__bb_network_installed = false;
    },
    args: [true, instrumentationKey],
  });
}

/** Read and optionally clear the network buffer from the page's main world. */
export async function readNetworkBuffer(
  tabId: number,
  clear: boolean,
  chromeObj: ChromeWithScripting,
  includeCursor = false
): Promise<{
  entries: Array<{
    method: string;
    url: string;
    status: number;
    duration: number;
    type: string;
    ts: number;
    size: number;
    sequence?: number;
  }>;
  dropped: number;
  provenance: 'page_main_world';
  integrity: 'untrusted';
  cursor?: NetworkCaptureCursor;
}> {
  const instrumentationKey = await getMainWorldInstrumentationKey(chromeObj);
  const results = await chromeObj.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (shouldClear: boolean, recordKey: string, withCursor: boolean) => {
      const root = (globalThis as Record<string, unknown>)[recordKey];
      const record =
        root && typeof root === 'object'
          ? (root as { network?: NetworkInstrumentationRecord }).network
          : null;
      const buf = Array.isArray(record?.buffer)
        ? record.buffer
        : Array.isArray(globalThis.__bb_network_buffer)
          ? globalThis.__bb_network_buffer
          : [];
      const dropped =
        typeof record?.dropped === 'number'
          ? record.dropped
          : typeof globalThis.__bb_network_dropped === 'number'
            ? globalThis.__bb_network_dropped
            : 0;
      // The page can replace this buffer. Bound the cross-world clone before
      // Chrome serializes it back to the extension.
      const copy = buf.slice(-200);
      const boundedDropped =
        (typeof dropped === 'number' && Number.isFinite(dropped) && dropped >= 0 ? dropped : 0) +
        Math.max(0, buf.length - copy.length);
      if (shouldClear) {
        buf.length = 0;
        if (record) record.dropped = 0;
        if (record) record.generation += 1;
        globalThis.__bb_network_buffer = buf;
        globalThis.__bb_network_dropped = 0;
      }
      return {
        entries: copy,
        dropped: boundedDropped,
        ...(withCursor && record
          ? {
              cursor: {
                epoch: typeof record.epoch === 'string' ? record.epoch.slice(0, 64) : '',
                nextSequence: Number.isSafeInteger(record.nextSequence) ? record.nextSequence : -1,
                generation: Number.isSafeInteger(record.generation) ? record.generation : -1,
                ...(Number.isSafeInteger(record.evictedThrough)
                  ? { evictedThrough: record.evictedThrough }
                  : {}),
              },
            }
          : {}),
      };
    },
    args: [clear, instrumentationKey, includeCursor],
  });
  const result = (
    results?.[0] as
      | {
          result?: {
            entries?: unknown;
            dropped?: unknown;
            cursor?: NetworkCaptureCursor;
          };
        }
      | undefined
  )?.result || { entries: [], dropped: 0 };
  return {
    entries: Array.isArray(result.entries)
      ? result.entries
          .slice(-200)
          .map((entry) => normalizeNetworkEntry(entry, includeCursor))
          .filter((entry) => entry !== null)
      : [],
    dropped: normalizeNonNegativeInteger(result.dropped, 1_000_000),
    provenance: 'page_main_world',
    integrity: 'untrusted',
    ...(includeCursor && result.cursor ? { cursor: result.cursor } : {}),
  };
}

function normalizeNonNegativeInteger(
  value: unknown,
  maximum: number = Number.MAX_SAFE_INTEGER
): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(maximum, Math.trunc(value))
    : 0;
}

/** MAIN-world state is controlled by the inspected page. Copy only the bounded
fields this feature owns before returning evidence to an agent. */
function normalizeNetworkEntry(
  value: unknown,
  includeCursor = false
): {
  method: string;
  url: string;
  status: number;
  duration: number;
  type: string;
  ts: number;
  size: number;
  sequence?: number;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  return {
    method: typeof entry.method === 'string' ? entry.method.slice(0, 32) : '',
    url: sanitizeIncidentalUrl(entry.url),
    status: normalizeNonNegativeInteger(entry.status, 999),
    duration: normalizeNonNegativeInteger(entry.duration),
    type: entry.type === 'xhr' ? 'xhr' : 'fetch',
    ts: normalizeNonNegativeInteger(entry.ts),
    size: normalizeNonNegativeInteger(entry.size),
    ...(includeCursor &&
    typeof entry.sequence === 'number' &&
    Number.isSafeInteger(entry.sequence) &&
    entry.sequence >= 0
      ? { sequence: entry.sequence }
      : {}),
  };
}
