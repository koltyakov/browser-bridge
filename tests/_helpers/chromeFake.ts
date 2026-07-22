export type FakeChromeListener = (...args: unknown[]) => unknown;

export type FakeChromeEvent = {
  addListener: (listener: FakeChromeListener) => void;
  removeListener: (listener: FakeChromeListener) => void;
  hasListener: (listener: FakeChromeListener) => boolean;
  dispatch: (...args: unknown[]) => unknown[];
  readonly listeners: FakeChromeListener[];
};

export type FakeStorageArea = {
  get: (
    keys?: string | string[] | Record<string, unknown> | null
  ) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (keys: string | string[]) => Promise<void>;
  clear: () => Promise<void>;
  snapshot: () => Record<string, unknown>;
};

export type ChromeFakeOverrides = {
  runtime?: Record<string, unknown>;
  tabs?: Record<string, unknown>;
  windows?: Record<string, unknown>;
  action?: Record<string, unknown>;
  storage?: Record<string, unknown>;
  debugger?: Record<string, unknown>;
  scripting?: Record<string, unknown>;
  alarms?: Record<string, unknown>;
  sidePanel?: Record<string, unknown>;
};

export type ChromeFake = Record<string, unknown> & {
  runtime: Record<string, unknown> & {
    connectNative: (...args: unknown[]) => unknown;
  };
  tabs: Record<string, unknown>;
};

export function createChromeEvent(): FakeChromeEvent {
  const listeners: FakeChromeListener[] = [];

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

export function createStorageArea(initialState: Record<string, unknown> = {}): FakeStorageArea {
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

      const result: Record<string, unknown> = {};
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function mergePlainObjects(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>
): Record<string, unknown> {
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
 */
export function createChromeFake(overrides: ChromeFakeOverrides = {}): ChromeFake {
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
      async get(tabId: number) {
        return { id: tabId };
      },
      async create(createProperties: Record<string, unknown> = {}) {
        return { id: 1, ...createProperties };
      },
      async update(tabId: number, updateProperties: Record<string, unknown> = {}) {
        return { id: tabId, ...updateProperties };
      },
      async remove() {},
      onUpdated: createChromeEvent(),
      onActivated: createChromeEvent(),
      onDetached: createChromeEvent(),
      onAttached: createChromeEvent(),
      onRemoved: createChromeEvent(),
    },
    windows: {
      async get(windowId: number) {
        return { id: windowId };
      },
      async getCurrent() {
        return { id: 1, focused: true };
      },
      async getLastFocused() {
        return { id: 1, focused: true };
      },
      async create(createData: Record<string, unknown> = {}) {
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

  return mergePlainObjects(chrome, overrides) as ChromeFake;
}
