// @ts-check

/**
 * @typedef {{
 *   addListener: (listener: (...args: any[]) => unknown) => void,
 *   removeListener: (listener: (...args: any[]) => unknown) => void,
 *   hasListener: (listener: (...args: any[]) => unknown) => boolean,
 *   dispatch: (...args: any[]) => unknown[],
 *   readonly listeners: Array<(...args: any[]) => unknown>
 * }} FakeChromeEvent
 */

/**
 * @typedef {{
 *   get: (keys?: string | string[] | Record<string, unknown> | null) => Promise<Record<string, unknown>>,
 *   set: (items: Record<string, unknown>) => Promise<void>,
 *   remove: (keys: string | string[]) => Promise<void>,
 *   clear: () => Promise<void>,
 *   snapshot: () => Record<string, unknown>
 * }} FakeStorageArea
 */

/**
 * @typedef {{
 *   runtime?: Record<string, any>,
 *   tabs?: Record<string, any>,
 *   windows?: Record<string, any>,
 *   action?: Record<string, any>,
 *   storage?: Record<string, any>,
 *   debugger?: Record<string, any>,
 *   scripting?: Record<string, any>,
 *   alarms?: Record<string, any>,
 *   sidePanel?: Record<string, any>
 * }} ChromeFakeOverrides
 */

/**
 * @returns {FakeChromeEvent}
 */
export function createChromeEvent() {
  /** @type {Array<(...args: any[]) => unknown>} */
  const listeners = [];

  return {
    addListener(listener) {
      listeners.push(listener);
    },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    },
    hasListener(listener) {
      return listeners.includes(listener);
    },
    dispatch(...args) {
      return listeners.map((listener) => listener(...args));
    },
    get listeners() {
      return [...listeners];
    },
  };
}

/**
 * @param {Record<string, unknown>} [initialState]
 * @returns {FakeStorageArea}
 */
export function createStorageArea(initialState = {}) {
  /** @type {Record<string, unknown>} */
  const state = { ...initialState };

  return {
    async get(keys = null) {
      if (keys == null) {
        return { ...state };
      }

      if (typeof keys === 'string') {
        return { [keys]: state[keys] };
      }

      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, state[key]]));
      }

      /** @type {Record<string, unknown>} */
      const result = {};
      for (const [key, fallback] of Object.entries(keys)) {
        result[key] = Object.prototype.hasOwnProperty.call(state, key) ? state[key] : fallback;
      }
      return result;
    },
    async set(items) {
      Object.assign(state, items);
    },
    async remove(keys) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) {
        delete state[key];
      }
    },
    async clear() {
      for (const key of Object.keys(state)) {
        delete state[key];
      }
    },
    snapshot() {
      return { ...state };
    },
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * @param {Record<string, any>} base
 * @param {Record<string, any>} overrides
 * @returns {Record<string, any>}
 */
function mergePlainObjects(base, overrides) {
  const merged = { ...base };

  for (const [key, value] of Object.entries(overrides)) {
    const current = merged[key];
    merged[key] =
      isPlainObject(current) && isPlainObject(value) ? mergePlainObjects(current, value) : value;
  }

  return merged;
}

/**
 * Create a shared minimal Chrome extension API fake for tests.
 *
 * The returned event objects intentionally expose a non-Chrome `dispatch()` helper
 * so tests can fire listeners without reaching into hidden state.
 *
 * @param {ChromeFakeOverrides} [overrides]
 * @returns {Record<string, any>}
 */
export function createChromeFake(overrides = {}) {
  const chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      connectNative() {
        throw new Error('chrome.runtime.connectNative was not stubbed for this test');
      },
      connect() {
        throw new Error('chrome.runtime.connect was not stubbed for this test');
      },
      sendMessage() {
        throw new Error('chrome.runtime.sendMessage was not stubbed for this test');
      },
      onInstalled: createChromeEvent(),
      onMessage: createChromeEvent(),
      onConnect: createChromeEvent(),
    },
    tabs: {
      async query() {
        return [];
      },
      /** @param {number} tabId */
      async get(tabId) {
        return { id: tabId };
      },
      async create(createProperties = {}) {
        return { id: 1, ...createProperties };
      },
      /** @param {number} tabId @param {Record<string, unknown>} [updateProperties] */
      async update(tabId, updateProperties = {}) {
        return { id: tabId, ...updateProperties };
      },
      async remove() {},
      onUpdated: createChromeEvent(),
      onActivated: createChromeEvent(),
      onRemoved: createChromeEvent(),
    },
    windows: {
      /** @param {number} windowId */
      async get(windowId) {
        return { id: windowId };
      },
      async getCurrent() {
        return { id: 1, focused: true };
      },
      async create(createData = {}) {
        return { id: 1, ...createData };
      },
      onFocusChanged: createChromeEvent(),
      onRemoved: createChromeEvent(),
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
      async setBadgeTextColor() {},
      async setTitle() {},
      onClicked: createChromeEvent(),
    },
    alarms: {
      async create() {},
      async clear() {
        return true;
      },
      onAlarm: createChromeEvent(),
    },
    storage: {
      local: createStorageArea(),
      session: createStorageArea(),
      sync: createStorageArea(),
    },
    debugger: {
      async attach() {},
      async detach() {},
      async sendCommand() {
        return {};
      },
      onEvent: createChromeEvent(),
      onDetach: createChromeEvent(),
    },
    scripting: {
      async executeScript() {
        return [];
      },
    },
    sidePanel: {
      async open() {},
      async setPanelBehavior() {},
      async setOptions() {},
    },
  };

  return mergePlainObjects(chrome, overrides);
}
