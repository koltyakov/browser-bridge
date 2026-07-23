// @ts-check

const STORAGE_KEY = 'mainWorldInstrumentationKey';
const KEY_PREFIX = '__bbx_instrumentation_';

/** @type {Promise<string> | null} */
let instrumentationKeyPromise = null;

/**
 * Keep one opaque page-world record key across service-worker restarts. The
 * fixed storage key is extension-owned; only the randomized value reaches the
 * inspected page.
 *
 * @param {{ storage?: { session?: { get: (key: string) => Promise<Record<string, unknown>>, set: (value: Record<string, unknown>) => Promise<void> } } }} chromeObj
 * @returns {Promise<string>}
 */
export function getMainWorldInstrumentationKey(chromeObj) {
  if (instrumentationKeyPromise) return instrumentationKeyPromise;

  instrumentationKeyPromise = (async () => {
    const storage = chromeObj.storage?.session;
    if (storage) {
      const stored = await storage.get(STORAGE_KEY);
      const value = stored[STORAGE_KEY];
      if (typeof value === 'string' && value.startsWith(KEY_PREFIX)) {
        return value;
      }
    }

    const suffix =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID().replaceAll('-', '')
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const key = `${KEY_PREFIX}${suffix}`;
    await storage?.set({ [STORAGE_KEY]: key });
    return key;
  })().catch((error) => {
    instrumentationKeyPromise = null;
    throw error;
  });

  return instrumentationKeyPromise;
}

/** Reset module state for isolated tests. */
export function resetMainWorldInstrumentationKeyForTest() {
  instrumentationKeyPromise = null;
}
