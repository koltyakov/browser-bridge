// @ts-check

import { createChromeEvent, createChromeFake } from './chromeFake.js';

const MISSING = Symbol('missing');
const BACKGROUND_MODULE_URL = new URL(
  '../../packages/extension/src/background.js',
  import.meta.url
);

/** @typedef {{ postMessage: (message: unknown) => void, disconnect?: () => void, onMessage: ReturnType<typeof createChromeEvent>, onDisconnect: ReturnType<typeof createChromeEvent>, name?: string }} FakeRuntimePort */

/** @typedef {import('../../packages/protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../../packages/protocol/src/types.js').BridgeResponse} BridgeResponse */

/**
 * @param {unknown} savedChrome
 * @returns {void}
 */
function restoreChrome(savedChrome) {
  if (savedChrome === MISSING) {
    Reflect.deleteProperty(globalThis, 'chrome');
    return;
  }

  Reflect.set(globalThis, 'chrome', savedChrome);
}

/**
 * @param {unknown} savedTimeout
 * @param {unknown} savedClearTimeout
 * @returns {void}
 */
function restoreTimers(savedTimeout, savedClearTimeout) {
  Reflect.set(globalThis, 'setTimeout', savedTimeout);
  Reflect.set(globalThis, 'clearTimeout', savedClearTimeout);
}

/**
 * @returns {void}
 */
function installTestTimers() {
  Reflect.set(
    globalThis,
    'setTimeout',
    /** @type {typeof setTimeout} */ (
      /** @type {unknown} */ (
        /** @param {TimerHandler} callback @param {number | undefined} delay @param {unknown[]} args */
        (callback, delay, ...args) => {
          const handle = { cleared: false };
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
          return /** @type {ReturnType<typeof setTimeout>} */ (/** @type {unknown} */ (handle));
        }
      )
    )
  );
  Reflect.set(
    globalThis,
    'clearTimeout',
    /** @type {typeof clearTimeout} */ (
      /** @param {ReturnType<typeof setTimeout> | undefined} handle */
      (handle) => {
        if (handle && typeof handle === 'object' && 'cleared' in handle) {
          Reflect.set(handle, 'cleared', true);
        }
      }
    )
  );
}

/**
 * @returns {FakeRuntimePort}
 */
function createNativePortStub() {
  const onMessage = createChromeEvent();
  return {
    /** @param {unknown} message */
    postMessage(message) {
      const candidate =
        /** @type {{ type?: string, request?: { id?: string, method?: string } }} */ (message);
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

/**
 * @typedef {{
 *   chrome?: Record<string, any>,
 *   query?: string,
 *   flushMicrotasks?: boolean
 * }} LoadBackgroundOptions
 */

/**
 * @typedef {{
 *   chrome: Record<string, any>,
 *   module: Record<string, any>,
 *   dispatch: (request: BridgeRequest) => Promise<BridgeResponse>
 * }} LoadedBackground
 */

/**
 * @param {FakeRuntimePort | null | undefined} port
 * @param {BridgeRequest} request
 * @returns {Promise<BridgeResponse>}
 */
function dispatchBridgeRequestForTest(port, request) {
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
        const candidate = /** @type {BridgeResponse} */ (message);
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

/**
 * Assign a fake `chrome` to `globalThis`, then import a fresh copy of the
 * background entrypoint so its top-level listeners register against that fake.
 *
 * @param {LoadBackgroundOptions} [options]
 * @returns {Promise<LoadedBackground>}
 */
export async function loadBackground(options = {}) {
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
          return /** @type {any} */ (defaultNativePort);
        },
      },
      tabs: {
        /** @param {chrome.tabs.QueryInfo} [queryInfo] */
        async query(queryInfo = /** @type {chrome.tabs.QueryInfo} */ ({})) {
          if (queryInfo.active && queryInfo.lastFocusedWindow) {
            return [];
          }
          return [];
        },
      },
    });

  if (chrome.runtime && typeof chrome.runtime.connectNative === 'function') {
    const originalConnectNative = chrome.runtime.connectNative.bind(chrome.runtime);
    chrome.runtime.connectNative = /** @type {typeof chrome.runtime.connectNative} */ (
      /**
       * @param {...unknown} args
       */
      function (...args) {
        try {
          return originalConnectNative(...args);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === 'chrome.runtime.connectNative was not stubbed for this test'
          ) {
            return /** @type {any} */ (defaultNativePort);
          }
          throw error;
        }
      }
    );
  }

  Reflect.set(globalThis, 'chrome', chrome);
  installTestTimers();

  try {
    const query =
      typeof options.query === 'string' && options.query.length > 0
        ? options.query
        : `case=${Date.now()}-${Math.random()}`;
    const module = await import(`${BACKGROUND_MODULE_URL.href}?${query}`);
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
