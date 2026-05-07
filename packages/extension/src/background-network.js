// @ts-check

/**
 * @typedef {{
 *   scripting: { executeScript: (config: any) => Promise<any[]> }
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
  await chromeObj.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      if (globalThis.__bb_network_installed) return;
      globalThis.__bb_network_installed = true;
      /** @type {Array<{method: string, url: string, status: number, duration: number, type: string, ts: number, size: number}>} */
      const buffer = [];
      globalThis.__bb_network_buffer = buffer;
      globalThis.__bb_network_dropped = 0;
      const MAX = 200;

      const origFetch = globalThis.fetch;
      globalThis.fetch = async function (...args) {
        const req = new Request(...args);
        const entry = {
          method: req.method,
          url: req.url,
          status: 0,
          duration: 0,
          type: 'fetch',
          ts: Date.now(),
          size: 0,
        };
        const startTime = performance.now();
        try {
          const resp = await origFetch.apply(globalThis, args);
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
          buffer.push(entry);
          if (buffer.length > MAX) {
            const dropped =
              /** @type {Record<string, unknown>} */ (globalThis).__bb_network_dropped;
            /** @type {Record<string, unknown>} */ (globalThis).__bb_network_dropped =
              (typeof dropped === 'number' ? dropped : 0) + (buffer.length - MAX);
            buffer.splice(0, buffer.length - MAX);
          }
        }
      };

      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      /**
       * @this {XMLHttpRequest & { __bb_method?: string, __bb_url?: string }}
       * @param {string} method
       * @param {string | URL} url
       * @param {...unknown} rest
       * @returns {unknown}
       */
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__bb_method = method;
        this.__bb_url = String(url);
        return /** @type {any} */ (origOpen).call(this, method, url, ...rest);
      };
      /**
       * @this {XMLHttpRequest & { __bb_method?: string, __bb_url?: string }}
       * @param {...unknown} args
       * @returns {unknown}
       */
      XMLHttpRequest.prototype.send = function (...args) {
        const entry = {
          method: this.__bb_method || 'GET',
          url: this.__bb_url || '',
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
          buffer.push(entry);
          if (buffer.length > MAX) {
            const dropped =
              /** @type {Record<string, unknown>} */ (globalThis).__bb_network_dropped;
            /** @type {Record<string, unknown>} */ (globalThis).__bb_network_dropped =
              (typeof dropped === 'number' ? dropped : 0) + (buffer.length - MAX);
            buffer.splice(0, buffer.length - MAX);
          }
        });
        return /** @type {any} */ (origSend).apply(this, args);
      };
    },
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
  const results = await chromeObj.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (/** @type {boolean} */ shouldClear) => {
      const buf = globalThis.__bb_network_buffer || [];
      const dropped = globalThis.__bb_network_dropped || 0;
      const copy = [...buf];
      if (shouldClear) {
        globalThis.__bb_network_buffer = [];
        globalThis.__bb_network_dropped = 0;
      }
      return { entries: copy, dropped };
    },
    args: [clear],
  });
  return /** @type {any} */ (results?.[0]?.result) || { entries: [], dropped: 0 };
}
