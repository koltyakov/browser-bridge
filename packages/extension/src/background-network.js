// @ts-check

import { getMainWorldInstrumentationKey } from './background-main-world-instrumentation.js';
import { sanitizeIncidentalUrl } from '../../protocol/src/index.js';

/**
 * @typedef {{
 *   enabled: boolean,
 *   buffer: Array<{method: string, url: string, status: number, duration: number, type: string, ts: number, size: number}>,
 *   dropped: number,
 *   originalFetch: typeof globalThis.fetch,
 *   originalOpen: typeof XMLHttpRequest.prototype.open,
 *   originalSend: typeof XMLHttpRequest.prototype.send,
 *   wrappedFetch: typeof globalThis.fetch,
 *   wrappedOpen: typeof XMLHttpRequest.prototype.open,
 *   wrappedSend: typeof XMLHttpRequest.prototype.send,
 * }} NetworkInstrumentationRecord
 */

/**
 * @typedef {{
 *   scripting: { executeScript: (config: any) => Promise<any[]> },
 *   storage?: { session?: { get: (key: string) => Promise<Record<string, unknown>>, set: (value: Record<string, unknown>) => Promise<void> } },
 * }} ChromeWithScripting
 */

/**
 * Inject the network interceptor into the page's main world. Patches
 * fetch and XMLHttpRequest to capture request/response metadata.
 *
 * @param {number} tabId
 * @param {ChromeWithScripting} chromeObj
 * @returns {Promise<void>}
 */
export async function ensureNetworkInterceptor(tabId, chromeObj) {
  const instrumentationKey = await getMainWorldInstrumentationKey(chromeObj);
  await chromeObj.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (/** @type {string} */ recordKey = '__bbx_instrumentation_test') => {
      const page = /** @type {Record<string, unknown>} */ (globalThis);
      const root =
        page[recordKey] && typeof page[recordKey] === 'object'
          ? /** @type {Record<string, unknown>} */ (page[recordKey])
          : (page[recordKey] = {});
      const existing = root.network;
      if (existing && typeof existing === 'object') {
        const record = /** @type {NetworkInstrumentationRecord} */ (existing);
        if (!record.enabled) {
          record.buffer.length = 0;
          record.dropped = 0;
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

      /** @type {Array<{method: string, url: string, status: number, duration: number, type: string, ts: number, size: number}>} */
      const buffer = [];
      const originalFetch = globalThis.fetch;
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;
      const xhrMetadata = new WeakMap();
      const record = {
        enabled: false,
        buffer,
        dropped: 0,
        originalFetch,
        originalOpen,
        originalSend,
        /** @type {typeof globalThis.fetch} */
        wrappedFetch: originalFetch,
        /** @type {typeof XMLHttpRequest.prototype.open} */
        wrappedOpen: originalOpen,
        /** @type {typeof XMLHttpRequest.prototype.send} */
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
        const input = /** @type {unknown} */ (args[0]);
        const init = /** @type {{ method?: unknown } | undefined} */ (args[1]);
        const requestLike =
          input && typeof input === 'object' && 'url' in input && 'method' in input
            ? /** @type {{ url: unknown, method: unknown }} */ (input)
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
              buffer.splice(0, buffer.length - MAX);
            }
          }
        }
      };
      globalThis.fetch = record.wrappedFetch;

      /**
       * @this {XMLHttpRequest}
       * @param {string} method
       * @param {string | URL} url
       * @param {...unknown} rest
       * @returns {unknown}
       */
      record.wrappedOpen = function (method, url, ...rest) {
        xhrMetadata.set(this, { method, url: String(url) });
        return /** @type {any} */ (originalOpen).call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.open = record.wrappedOpen;
      /**
       * @this {XMLHttpRequest}
       * @param {...unknown} args
       * @returns {unknown}
       */
      record.wrappedSend = function (...args) {
        const metadata = xhrMetadata.get(this);
        const entry = {
          method: metadata?.method || 'GET',
          url: metadata?.url || '',
          status: 0,
          duration: 0,
          type: 'xhr',
          ts: Date.now(),
          size: 0,
        };
        const startTime = performance.now();
        this.addEventListener('loadend', () => {
          entry.status = this.status;
          entry.duration = Math.round(performance.now() - startTime);
          const cl = this.getResponseHeader('content-length');
          if (cl) entry.size = Number(cl);
          if (!record.enabled) return;
          buffer.push(entry);
          if (buffer.length > MAX) {
            record.dropped += buffer.length - MAX;
            globalThis.__bb_network_dropped = record.dropped;
            buffer.splice(0, buffer.length - MAX);
          }
        });
        return /** @type {any} */ (originalSend).apply(this, args);
      };
      XMLHttpRequest.prototype.send = record.wrappedSend;
      record.enabled = true;
    },
    args: [instrumentationKey],
  });
}

/**
 * Stop fetch/XHR collection, clear buffered data, and restore owned wrappers.
 *
 * @param {number} tabId
 * @param {ChromeWithScripting} chromeObj
 * @returns {Promise<void>}
 */
export async function disableNetworkInterceptor(tabId, chromeObj) {
  const instrumentationKey = await getMainWorldInstrumentationKey(chromeObj);
  await chromeObj.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (
      /** @type {boolean} */ _shouldClear,
      /** @type {string} */ recordKey = '__bbx_instrumentation_test'
    ) => {
      const root = /** @type {Record<string, unknown>} */ (globalThis)[recordKey];
      const record =
        root && typeof root === 'object'
          ? /** @type {{ network?: NetworkInstrumentationRecord }} */ (root).network
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

/**
 * Read and optionally clear the network buffer from the page's main world.
 *
 * @param {number} tabId
 * @param {boolean} clear
 * @param {ChromeWithScripting} chromeObj
 * @returns {Promise<{ entries: Array<{method: string, url: string, status: number, duration: number, type: string, ts: number, size: number}>, dropped: number }>}
 */
export async function readNetworkBuffer(tabId, clear, chromeObj) {
  const instrumentationKey = await getMainWorldInstrumentationKey(chromeObj);
  const results = await chromeObj.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (/** @type {boolean} */ shouldClear, /** @type {string} */ recordKey) => {
      const root = /** @type {Record<string, unknown>} */ (globalThis)[recordKey];
      const record =
        root && typeof root === 'object'
          ? /** @type {{ network?: NetworkInstrumentationRecord }} */ (root).network
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
      const copy = [...buf];
      if (shouldClear) {
        buf.length = 0;
        if (record) record.dropped = 0;
        globalThis.__bb_network_buffer = buf;
        globalThis.__bb_network_dropped = 0;
      }
      return { entries: copy, dropped };
    },
    args: [clear, instrumentationKey],
  });
  const result = /** @type {any} */ (results?.[0]?.result) || { entries: [], dropped: 0 };
  return {
    ...result,
    entries: Array.isArray(result.entries)
      ? result.entries.map((/** @type {{ url: unknown } & Record<string, unknown>} */ entry) => ({
          ...entry,
          url: sanitizeIncidentalUrl(entry.url),
        }))
      : [],
  };
}
