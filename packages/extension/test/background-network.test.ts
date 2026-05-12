import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureNetworkInterceptor, readNetworkBuffer } from '../src/background-network.js';

type NetworkEntry = {
  method: string;
  url: string;
  status: number;
  duration: number;
  type: string;
  ts: number;
  size: number;
};
type NetworkInjection = chrome.scripting.ScriptInjection<unknown[], unknown> & { args?: unknown[] };
type NetworkGlobalKey =
  | 'fetch'
  | 'Request'
  | 'performance'
  | 'XMLHttpRequest'
  | '__bb_network_installed'
  | '__bb_network_buffer'
  | '__bb_network_dropped';
type GlobalDescriptorSnapshot = Partial<Record<NetworkGlobalKey, PropertyDescriptor>>;
type HeaderStub = { get: (name: string) => string | null };
type FetchStub = (
  input: string | URL,
  init?: { method?: string }
) => Promise<{ status: number; headers: HeaderStub }>;
type InstalledNetworkGlobal = Record<string, unknown> & {
  fetch: FetchStub;
  XMLHttpRequest: new () => FakeXMLHttpRequest;
  __bb_network_installed?: unknown;
  __bb_network_buffer?: unknown;
  __bb_network_dropped?: unknown;
};
type ExecuteScriptCall = {
  target: chrome.scripting.InjectionTarget | undefined;
  world: string | undefined;
  args: unknown[] | undefined;
};

class FakeRequest {
  method: string;
  url: string;

  constructor(input: string | URL, init: { method?: string } = {}) {
    this.method = init.method ?? 'GET';
    this.url = String(input);
  }
}

class FakeXMLHttpRequest {
  listeners: Map<string, () => void>;
  status: number;
  responseHeaderValue: string | null;
  openArgs: unknown[] | null;
  sendArgs: unknown[] | null;

  constructor() {
    this.listeners = new Map();
    this.status = 0;
    this.responseHeaderValue = null;
    this.openArgs = null;
    this.sendArgs = null;
  }

  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }

  open(method: string, url: string | URL, ...rest: unknown[]) {
    this.openArgs = [method, String(url), ...rest];
    return 'opened';
  }

  send(...args: unknown[]) {
    this.sendArgs = args;
    return 'sent';
  }

  getResponseHeader(name: string) {
    return name === 'content-length' ? this.responseHeaderValue : null;
  }

  dispatch(type: string) {
    this.listeners.get(type)?.();
  }
}

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

function restoreGlobalDescriptors(snapshot: GlobalDescriptorSnapshot) {
  for (const [key, descriptor] of Object.entries(snapshot)) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
      continue;
    }
    Reflect.deleteProperty(globalThis, key);
  }
}

function createHeaders(contentLength: string | null): HeaderStub {
  return {
    get(name: string) {
      return name === 'content-length' ? contentLength : null;
    },
  };
}

async function captureInstallInjection() {
  const calls: NetworkInjection[] = [];
  await ensureNetworkInterceptor(17, {
    scripting: {
      async executeScript(details: NetworkInjection) {
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
    value: FakeRequest,
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
    const install = injection.func as () => void;

    install();
    const mutableGlobal = globalThis as unknown as InstalledNetworkGlobal;
    const wrappedFetch = mutableGlobal.fetch;
    const installedBuffer = mutableGlobal.__bb_network_buffer as NetworkEntry[];

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
      installedBuffer.map((entry) => ({
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

  Object.defineProperty(globalThis, 'Request', {
    configurable: true,
    writable: true,
    value: FakeRequest,
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
    const install = injection.func as () => void;
    install();

    const mutableGlobal = globalThis as unknown as InstalledNetworkGlobal;
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
      (mutableGlobal.__bb_network_buffer as NetworkEntry[]).map((entry) => ({
        method: entry.method,
        url: entry.url,
        status: entry.status,
        duration: entry.duration,
        type: entry.type,
        size: entry.size,
      })),
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
  const executeScriptCalls: ExecuteScriptCall[] = [];
  const entry: NetworkEntry = {
    method: 'GET',
    url: 'https://example.com/api',
    status: 200,
    duration: 9,
    type: 'fetch',
    ts: 123,
    size: 456,
  };

  const pageBuffer = [entry];
  Object.defineProperty(globalThis, '__bb_network_buffer', {
    configurable: true,
    writable: true,
    value: pageBuffer,
  });
  Object.defineProperty(globalThis, '__bb_network_dropped', {
    configurable: true,
    writable: true,
    value: 3,
  });

  try {
    const chrome = {
      scripting: {
        async executeScript(details: NetworkInjection) {
          executeScriptCalls.push({
            target: details.target,
            world: details.world,
            args: details.args,
          });
          assert.equal(typeof details.func, 'function');
          const readBuffer = details.func as (shouldClear: boolean) => unknown;
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
      (globalThis as unknown as InstalledNetworkGlobal).__bb_network_buffer
    );
    assert.strictEqual(
      (globalThis as unknown as InstalledNetworkGlobal).__bb_network_buffer,
      pageBuffer
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
    assert.deepEqual((globalThis as unknown as InstalledNetworkGlobal).__bb_network_buffer, [
      entry,
    ]);
    assert.equal((globalThis as unknown as InstalledNetworkGlobal).__bb_network_dropped, 3);

    const secondRead = await readNetworkBuffer(29, true, chrome);
    assert.deepEqual(secondRead, {
      entries: [entry],
      dropped: 3,
    });
    assert.strictEqual(
      (globalThis as unknown as InstalledNetworkGlobal).__bb_network_buffer,
      pageBuffer
    );
    assert.deepEqual(pageBuffer, []);
    assert.equal((globalThis as unknown as InstalledNetworkGlobal).__bb_network_dropped, 0);
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
  Reflect.deleteProperty(globalThis, '__bb_network_buffer');
  Reflect.deleteProperty(globalThis, '__bb_network_dropped');

  try {
    const result = await readNetworkBuffer(31, false, {
      scripting: {
        async executeScript(details: NetworkInjection) {
          assert.equal(typeof details.func, 'function');
          const readBuffer = details.func as (shouldClear: boolean) => unknown;
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
