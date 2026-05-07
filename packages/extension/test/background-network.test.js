// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureNetworkInterceptor, readNetworkBuffer } from '../src/background-network.js';

/**
 * @typedef {{
 *   method: string,
 *   url: string,
 *   status: number,
 *   duration: number,
 *   type: string,
 *   ts: number,
 *   size: number,
 * }} NetworkEntry
 */

/** @typedef {chrome.scripting.ScriptInjection<any[], any> & { args?: unknown[] }} NetworkInjection */

/**
 * @returns {Record<string, PropertyDescriptor | undefined>}
 */
function snapshotGlobalDescriptors() {
  return {
    fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch'),
    Request: Object.getOwnPropertyDescriptor(globalThis, 'Request'),
    performance: Object.getOwnPropertyDescriptor(globalThis, 'performance'),
    XMLHttpRequest: Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest'),
    __bb_network_installed: Object.getOwnPropertyDescriptor(globalThis, '__bb_network_installed'),
    __bb_network_buffer: Object.getOwnPropertyDescriptor(globalThis, '__bb_network_buffer'),
    __bb_network_dropped: Object.getOwnPropertyDescriptor(globalThis, '__bb_network_dropped'),
  };
}

/**
 * @param {Record<string, PropertyDescriptor | undefined>} snapshot
 */
function restoreGlobalDescriptors(snapshot) {
  const mutableGlobal = /** @type {Record<string, unknown>} */ (globalThis);
  for (const [key, descriptor] of Object.entries(snapshot)) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
      continue;
    }
    delete mutableGlobal[key];
  }
}

/**
 * @param {string | null} contentLength
 */
function createHeaders(contentLength) {
  return {
    /** @param {string} name */
    get(name) {
      return name === 'content-length' ? contentLength : null;
    },
  };
}

/**
 * @returns {Promise<NetworkInjection>}
 */
async function captureInstallInjection() {
  /** @type {NetworkInjection[]} */
  const calls = [];
  await ensureNetworkInterceptor(17, {
    scripting: {
      /** @param {chrome.scripting.ScriptInjection<any[], any> & { args?: unknown[] }} details */
      async executeScript(details) {
        calls.push(details);
        return [];
      },
    },
  });
  assert.equal(calls.length, 1);
  return calls[0];
}

test('ensureNetworkInterceptor wraps fetch once and trims buffered entries', async () => {
  const snapshot = snapshotGlobalDescriptors();
  const originalDateNow = Date.now;
  let perfNow = 0;
  let wallClock = 1_000;
  let fetchCallCount = 0;

  Object.defineProperty(globalThis, 'Request', {
    configurable: true,
    writable: true,
    value: class FakeRequest {
      /**
       * @param {string | URL} input
       * @param {{ method?: string }} [init]
       */
      constructor(input, init = {}) {
        this.method = init.method ?? 'GET';
        this.url = String(input);
      }
    },
  });
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    writable: true,
    value: {
      now() {
        perfNow += 5;
        return perfNow;
      },
    },
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async () => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) {
        return {
          status: 201,
          headers: createHeaders('321'),
        };
      }
      if (fetchCallCount === 2) {
        throw new Error('fetch failed');
      }
      return {
        status: 204,
        headers: createHeaders(null),
      };
    },
  });
  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    configurable: true,
    writable: true,
    value: class FakeXMLHttpRequest {
      open() {}
      send() {}
    },
  });
  Date.now = () => {
    wallClock += 1;
    return wallClock;
  };

  try {
    const injection = await captureInstallInjection();
    assert.equal(injection.target.tabId, 17);
    assert.equal(injection.world, 'MAIN');
    assert.equal(typeof injection.func, 'function');
    const install = /** @type {() => void} */ (injection.func);

    install();
    const mutableGlobal = /** @type {Record<string, any>} */ (globalThis);
    const wrappedFetch = mutableGlobal.fetch;
    /** @type {NetworkEntry[]} */
    const installedBuffer = mutableGlobal.__bb_network_buffer;

    assert.equal(mutableGlobal.__bb_network_installed, true);
    assert.ok(Array.isArray(installedBuffer));

    install();
    assert.equal(mutableGlobal.fetch, wrappedFetch);
    assert.equal(mutableGlobal.__bb_network_buffer, installedBuffer);

    const successResponse = await mutableGlobal.fetch('https://example.com/users', {
      method: 'POST',
    });
    assert.equal(successResponse.status, 201);
    await assert.rejects(() => mutableGlobal.fetch('https://example.com/fail'), /fetch failed/);

    assert.equal(installedBuffer.length, 2);
    assert.deepEqual(
      installedBuffer.map((/** @type {NetworkEntry} */ entry) => ({
        method: entry.method,
        url: entry.url,
        status: entry.status,
        duration: entry.duration,
        type: entry.type,
        size: entry.size,
      })),
      [
        {
          method: 'POST',
          url: 'https://example.com/users',
          status: 201,
          duration: 5,
          type: 'fetch',
          size: 321,
        },
        {
          method: 'GET',
          url: 'https://example.com/fail',
          status: 0,
          duration: 5,
          type: 'fetch',
          size: 0,
        },
      ]
    );
    assert.equal(typeof installedBuffer[0].ts, 'number');
    assert.equal(typeof installedBuffer[1].ts, 'number');

    mutableGlobal.__bb_network_dropped = 'invalid';
    for (let index = 0; index < 200; index += 1) {
      await mutableGlobal.fetch(`https://example.com/request-${index}`);
    }

    assert.equal(installedBuffer.length, 200);
    assert.equal(mutableGlobal.__bb_network_dropped, 2);
    assert.equal(installedBuffer[0].url, 'https://example.com/request-0');
    assert.equal(installedBuffer.at(-1)?.url, 'https://example.com/request-199');
  } finally {
    Date.now = originalDateNow;
    restoreGlobalDescriptors(snapshot);
  }
});

test('ensureNetworkInterceptor records xhr entries with captured and default metadata', async () => {
  const snapshot = snapshotGlobalDescriptors();
  const originalDateNow = Date.now;
  let perfNow = 0;
  let wallClock = 2_000;

  class FakeXMLHttpRequest {
    constructor() {
      /** @type {Map<string, () => void>} */
      this.listeners = new Map();
      /** @type {number} */
      this.status = 0;
      /** @type {string | null} */
      this.responseHeaderValue = null;
    }

    /**
     * @param {string} type
     * @param {() => void} listener
     */
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    /**
     * @param {string} method
     * @param {string | URL} url
     * @param {...unknown} rest
     */
    open(method, url, ...rest) {
      this.openArgs = [method, String(url), ...rest];
      return 'opened';
    }

    /**
     * @param {...unknown} args
     */
    send(...args) {
      this.sendArgs = args;
      return 'sent';
    }

    /** @param {string} name */
    getResponseHeader(name) {
      return name === 'content-length' ? this.responseHeaderValue : null;
    }

    /** @param {string} type */
    dispatch(type) {
      this.listeners.get(type)?.();
    }
  }

  Object.defineProperty(globalThis, 'Request', {
    configurable: true,
    writable: true,
    value: class FakeRequest {
      /**
       * @param {string | URL} input
       * @param {{ method?: string }} [init]
       */
      constructor(input, init = {}) {
        this.method = init.method ?? 'GET';
        this.url = String(input);
      }
    },
  });
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    writable: true,
    value: {
      now() {
        perfNow += 7;
        return perfNow;
      },
    },
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async () => ({ status: 200, headers: createHeaders(null) }),
  });
  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    configurable: true,
    writable: true,
    value: FakeXMLHttpRequest,
  });
  Date.now = () => {
    wallClock += 1;
    return wallClock;
  };

  try {
    const injection = await captureInstallInjection();
    assert.equal(typeof injection.func, 'function');
    const install = /** @type {() => void} */ (injection.func);
    install();

    const mutableGlobal = /** @type {Record<string, any>} */ (globalThis);
    const xhr = new mutableGlobal.XMLHttpRequest();
    xhr.status = 204;
    xhr.responseHeaderValue = '88';

    assert.equal(xhr.open('PATCH', 'https://example.com/upload', true), 'opened');
    assert.equal(xhr.send('payload'), 'sent');
    xhr.dispatch('loadend');

    const defaultXhr = new mutableGlobal.XMLHttpRequest();
    defaultXhr.status = 503;
    assert.equal(defaultXhr.send(), 'sent');
    defaultXhr.dispatch('loadend');

    mutableGlobal.__bb_network_dropped = 'invalid';
    for (let index = 0; index < 200; index += 1) {
      const overflowXhr = new mutableGlobal.XMLHttpRequest();
      overflowXhr.status = 200;
      overflowXhr.open('GET', `https://example.com/xhr-${index}`);
      overflowXhr.send();
      overflowXhr.dispatch('loadend');
    }

    assert.deepEqual(
      /** @type {NetworkEntry[]} */ (mutableGlobal.__bb_network_buffer).map(
        (/** @type {NetworkEntry} */ entry) => ({
          method: entry.method,
          url: entry.url,
          status: entry.status,
          duration: entry.duration,
          type: entry.type,
          size: entry.size,
        })
      ),
      [
        ...Array.from({ length: 200 }, (_, index) => ({
          method: 'GET',
          url: `https://example.com/xhr-${index}`,
          status: 200,
          duration: 7,
          type: 'xhr',
          size: 0,
        })),
      ]
    );
    assert.equal(mutableGlobal.__bb_network_dropped, 2);
  } finally {
    Date.now = originalDateNow;
    restoreGlobalDescriptors(snapshot);
  }
});

test('readNetworkBuffer returns copied entries and clears the page state on request', async () => {
  const snapshot = snapshotGlobalDescriptors();
  /** @type {Array<{ target: chrome.scripting.InjectionTarget | undefined, world: string | undefined, args: unknown[] | undefined }>} */
  const executeScriptCalls = [];
  const entry = {
    method: 'GET',
    url: 'https://example.com/api',
    status: 200,
    duration: 9,
    type: 'fetch',
    ts: 123,
    size: 456,
  };

  Object.defineProperty(globalThis, '__bb_network_buffer', {
    configurable: true,
    writable: true,
    value: [entry],
  });
  Object.defineProperty(globalThis, '__bb_network_dropped', {
    configurable: true,
    writable: true,
    value: 3,
  });

  try {
    const chrome = {
      scripting: {
        /** @param {chrome.scripting.ScriptInjection<any[], any> & { args?: unknown[] }} details */
        async executeScript(details) {
          executeScriptCalls.push({
            target: details.target,
            world: details.world,
            args: details.args,
          });
          assert.equal(typeof details.func, 'function');
          const readBuffer = /** @type {(shouldClear: boolean) => unknown} */ (details.func);
          return [{ result: readBuffer(details.args?.[0] === true) }];
        },
      },
    };

    const firstRead = await readNetworkBuffer(29, false, chrome);
    assert.deepEqual(firstRead, {
      entries: [entry],
      dropped: 3,
    });
    assert.notEqual(
      firstRead.entries,
      /** @type {Record<string, any>} */ (globalThis).__bb_network_buffer
    );
    firstRead.entries.push({
      method: 'POST',
      url: 'https://example.com/mutated',
      status: 201,
      duration: 4,
      type: 'xhr',
      ts: 124,
      size: 10,
    });
    assert.deepEqual(/** @type {Record<string, any>} */ (globalThis).__bb_network_buffer, [entry]);
    assert.equal(/** @type {Record<string, any>} */ (globalThis).__bb_network_dropped, 3);

    const secondRead = await readNetworkBuffer(29, true, chrome);
    assert.deepEqual(secondRead, {
      entries: [entry],
      dropped: 3,
    });
    assert.deepEqual(/** @type {Record<string, any>} */ (globalThis).__bb_network_buffer, []);
    assert.equal(/** @type {Record<string, any>} */ (globalThis).__bb_network_dropped, 0);
    assert.deepEqual(executeScriptCalls, [
      {
        target: { tabId: 29 },
        world: 'MAIN',
        args: [false],
      },
      {
        target: { tabId: 29 },
        world: 'MAIN',
        args: [true],
      },
    ]);
  } finally {
    restoreGlobalDescriptors(snapshot);
  }
});

test('readNetworkBuffer falls back to empty state when page globals are absent', async () => {
  const snapshot = snapshotGlobalDescriptors();
  const mutableGlobal = /** @type {Record<string, unknown>} */ (globalThis);
  delete mutableGlobal.__bb_network_buffer;
  delete mutableGlobal.__bb_network_dropped;

  try {
    const result = await readNetworkBuffer(31, false, {
      scripting: {
        /** @param {NetworkInjection} details */
        async executeScript(details) {
          assert.equal(typeof details.func, 'function');
          const readBuffer = /** @type {(shouldClear: boolean) => unknown} */ (details.func);
          return [{ result: readBuffer(false) }];
        },
      },
    });

    assert.deepEqual(result, {
      entries: [],
      dropped: 0,
    });
  } finally {
    restoreGlobalDescriptors(snapshot);
  }
});
