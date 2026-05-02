// @ts-check

import { createChromeEvent, createChromeFake } from './chromeFake.js';

const MISSING = Symbol('missing');
const BACKGROUND_MODULE_URL = new URL(
  '../../packages/extension/src/background.js',
  import.meta.url
);

/** @typedef {{ postMessage: (message: unknown) => void, disconnect?: () => void, onMessage: ReturnType<typeof createChromeEvent>, onDisconnect: ReturnType<typeof createChromeEvent>, name?: string }} FakeRuntimePort */

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
 *   module: Record<string, any>
 * }} LoadedBackground
 */

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

  const chrome =
    options.chrome ??
    createChromeFake({
      runtime: {
        connectNative() {
          return /** @type {any} */ (createNativePortStub());
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
    };
  } finally {
    restoreTimers(savedSetTimeout, savedClearTimeout);
    restoreChrome(savedChrome);
  }
}
