import {
  createChromeEvent,
  createChromeFake,
  type ChromeFake,
  type FakeChromeEvent,
} from './chromeFake.ts';
import { webcrypto } from 'node:crypto';
import type { BridgeRequest, BridgeResponse } from '../../packages/protocol/src/types.js';

const MISSING = Symbol('missing');
const BACKGROUND_MODULE_URL = new URL(
  '../../packages/extension/src/background.js',
  import.meta.url
);

if (!globalThis.crypto) {
  Reflect.set(globalThis, 'crypto', webcrypto);
}

export type FakeRuntimePort = {
  postMessage: (message: unknown) => void;
  disconnect?: () => void;
  onMessage: FakeChromeEvent;
  onDisconnect: FakeChromeEvent;
  name?: string;
};

export type LoadBackgroundOptions = {
  chrome?: ChromeFake;
  query?: string;
  flushMicrotasks?: boolean;
};

export type LoadedBackgroundModule = Record<string, unknown> & {
  getStateForTest: () => {
    nativePort?: FakeRuntimePort | null;
  };
};

export type LoadedBackground = {
  chrome: ChromeFake;
  module: LoadedBackgroundModule;
  dispatch: (request: BridgeRequest) => Promise<BridgeResponse>;
};

type TestTimerHandle = ReturnType<typeof setTimeout> & { cleared?: boolean };

function restoreChrome(savedChrome: unknown): void {
  if (savedChrome === MISSING) {
    Reflect.deleteProperty(globalThis, 'chrome');
    return;
  }

  Reflect.set(globalThis, 'chrome', savedChrome);
}

function restoreTimers(savedTimeout: unknown, savedClearTimeout: unknown): void {
  Reflect.set(globalThis, 'setTimeout', savedTimeout);
  Reflect.set(globalThis, 'clearTimeout', savedClearTimeout);
}

function installTestTimers(): void {
  Reflect.set(globalThis, 'setTimeout', ((
    callback: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ) => {
    const handle = { cleared: false } as TestTimerHandle;
    const normalizedDelay = Number(delay ?? 0);
    if (normalizedDelay <= 500) {
      queueMicrotask(() => {
        if (handle.cleared) {
          return;
        }
        if (typeof callback === 'function') {
          callback(...args);
        }
      });
    }
    return handle;
  }) as unknown as typeof setTimeout);
  Reflect.set(globalThis, 'clearTimeout', ((handle?: ReturnType<typeof setTimeout>) => {
    if (handle && typeof handle === 'object' && 'cleared' in handle) {
      Reflect.set(handle, 'cleared', true);
    }
  }) as typeof clearTimeout);
}

function createNativePortStub(): FakeRuntimePort {
  const onMessage = createChromeEvent();
  return {
    postMessage(message: unknown) {
      const candidate =
        message && typeof message === 'object'
          ? (message as { type?: string; request?: { id?: string; method?: string } })
          : {};
      const request = candidate.request;
      if (
        candidate.type === 'host.bridge_request' &&
        request &&
        request.method === 'setup.get_status' &&
        typeof request.id === 'string'
      ) {
        queueMicrotask(() => {
          onMessage.dispatch({
            type: 'host.setup_status.response',
            requestId: request.id,
            status: {
              mcpClients: [],
              skillTargets: [],
            },
          });
        });
      }
    },
    disconnect() {},
    onMessage,
    onDisconnect: createChromeEvent(),
    name: 'native',
  };
}

function dispatchBridgeRequestForTest(
  port: FakeRuntimePort | null | undefined,
  request: BridgeRequest
): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    if (!port) {
      reject(new Error('Background native port was not initialized for this test.'));
      return;
    }
    const originalPostMessage = port.postMessage.bind(port);
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      port.postMessage = originalPostMessage;
      reject(new Error(`No bridge response was posted for request ${request.id}.`));
    }, 1000);

    port.postMessage = (message) => {
      if (
        !settled &&
        message &&
        typeof message === 'object' &&
        'id' in message &&
        'ok' in message
      ) {
        const candidate = message as BridgeResponse;
        if (candidate.id === request.id) {
          settled = true;
          clearTimeout(timeoutId);
          port.postMessage = originalPostMessage;
          resolve(candidate);
          return;
        }
      }
      originalPostMessage(message);
    };

    try {
      port.onMessage.dispatch(request);
    } catch (error) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      port.postMessage = originalPostMessage;
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// Assign a fake `chrome` to `globalThis`, then import a fresh copy of the
// background entrypoint so its top-level listeners register against that fake.
export async function loadBackground(
  options: LoadBackgroundOptions = {}
): Promise<LoadedBackground> {
  const savedChrome = Object.prototype.hasOwnProperty.call(globalThis, 'chrome')
    ? globalThis.chrome
    : MISSING;
  const savedSetTimeout = globalThis.setTimeout;
  const savedClearTimeout = globalThis.clearTimeout;

  const defaultNativePort = createNativePortStub();
  const chrome =
    options.chrome ??
    createChromeFake({
      runtime: {
        connectNative() {
          return defaultNativePort;
        },
      },
      tabs: {
        async query(queryInfo: chrome.tabs.QueryInfo = {}) {
          if (queryInfo.active && queryInfo.lastFocusedWindow) {
            return [];
          }
          return [];
        },
      },
    });

  if (chrome.runtime && typeof chrome.runtime.connectNative === 'function') {
    const originalConnectNative = chrome.runtime.connectNative.bind(chrome.runtime);
    chrome.runtime.connectNative = function (...args: unknown[]): unknown {
      try {
        return originalConnectNative(...args);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'chrome.runtime.connectNative was not stubbed for this test'
        ) {
          return defaultNativePort;
        }
        throw error;
      }
    };
  }

  Reflect.set(globalThis, 'chrome', chrome);
  installTestTimers();

  try {
    const query =
      typeof options.query === 'string' && options.query.length > 0
        ? options.query
        : `case=${Date.now()}-${Math.random()}`;
    const module = (await import(
      `${BACKGROUND_MODULE_URL.href}?${query}`
    )) as LoadedBackgroundModule;
    if (options.flushMicrotasks !== false) {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return {
      chrome,
      module,
      dispatch(request) {
        return dispatchBridgeRequestForTest(module.getStateForTest().nativePort, request);
      },
    };
  } finally {
    restoreTimers(savedSetTimeout, savedClearTimeout);
    restoreChrome(savedChrome);
  }
}
