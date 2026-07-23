// @ts-check

import { ERROR_CODES } from '../../protocol/src/index.js';
import { getErrorMessage, normalizeRuntimeErrorMessage } from './background-helpers.js';
import { getMainWorldInstrumentationKey } from './background-main-world-instrumentation.js';
import { isNumber } from './background-state.js';

/**
 * @typedef {{
 *   enabled: boolean,
 *   buffer: Array<{level: string, args: string[], ts: number}>,
 *   dropped: number,
 *   levels: string[],
 *   originals: Record<string, (...args: unknown[]) => void>,
 *   wrappers: Record<string, (...args: unknown[]) => void>,
 *   onError: (event: ErrorEvent) => void,
 *   onRejection: (event: PromiseRejectionEvent) => void,
 *   listenersAttached: boolean,
 * }} ConsoleInstrumentationRecord
 */

/**
 * @typedef {{
 *   scripting: { executeScript: (config: any) => Promise<any[]> },
 *   storage?: { session?: { get: (key: string) => Promise<Record<string, unknown>>, set: (value: Record<string, unknown>) => Promise<void> } },
 *   tabs: { query: (info: any) => Promise<any[]> }
 * }} ChromeWithScripting
 */

/**
 * Inject the console interceptor into the page's main world if not already
 * present. The interceptor patches console methods and captures unhandled
 * errors into a bounded in-page buffer.
 *
 * @param {number} tabId
 * @param {ChromeWithScripting} chromeObj
 * @returns {Promise<void>}
 */
export async function ensureConsoleInterceptor(tabId, chromeObj) {
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
      const consoleMethods = /** @type {Record<string, (...args: unknown[]) => void>} */ (
        /** @type {unknown} */ (console)
      );
      const existing = root.console;
      if (existing && typeof existing === 'object') {
        const record = /** @type {ConsoleInstrumentationRecord} */ (existing);
        if (!record.enabled) {
          record.buffer.length = 0;
          record.dropped = 0;
        }
        record.enabled = true;
        for (const level of record.levels) {
          if (consoleMethods[level] === record.originals[level]) {
            consoleMethods[level] = record.wrappers[level];
          }
        }
        if (!record.listenersAttached) {
          globalThis.addEventListener('error', record.onError);
          globalThis.addEventListener('unhandledrejection', record.onRejection);
          record.listenersAttached = true;
        }
        globalThis.__bb_console_installed = true;
        globalThis.__bb_console_buffer = record.buffer;
        globalThis.__bb_console_dropped = record.dropped;
        return;
      }

      /** @type {Array<{level: string, args: string[], ts: number}>} */
      const buffer = [];
      const levels = ['log', 'warn', 'error', 'info', 'debug'];
      const record = {
        enabled: false,
        buffer,
        dropped: 0,
        levels,
        /** @type {Record<string, (...args: unknown[]) => void>} */
        originals: {},
        /** @type {Record<string, (...args: unknown[]) => void>} */
        wrappers: {},
        /** @type {(event: ErrorEvent) => void} */
        onError: () => {},
        /** @type {(event: PromiseRejectionEvent) => void} */
        onRejection: () => {},
        listenersAttached: false,
      };
      root.console = record;
      globalThis.__bb_console_installed = true;
      globalThis.__bb_console_buffer = buffer;
      globalThis.__bb_console_dropped = 0;
      const MAX = 200;
      const MAX_ARG_CHARS = 500;

      /**
       * Serialize one console argument into a bounded string. Uses a budgeted
       * JSON walk that prunes subtrees once the budget is spent, so logging a
       * huge state tree stays cheap for the page. Errors keep their message
       * (their fields are non-enumerable, so plain stringify yields "{}").
       *
       * @param {unknown} value
       * @returns {string}
       */
      const serializeArg = (value) => {
        try {
          if (value instanceof Error) {
            return String(value).slice(0, MAX_ARG_CHARS);
          }
          if (typeof value !== 'object' || value === null) {
            return String(value).slice(0, MAX_ARG_CHARS);
          }
          let budget = MAX_ARG_CHARS;
          const seen = new WeakSet();
          const json = JSON.stringify(value, (_key, val) => {
            if (budget <= 0) {
              return undefined;
            }
            if (val instanceof Error) {
              const text = String(val).slice(0, MAX_ARG_CHARS);
              budget -= text.length + 2;
              return text;
            }
            if (typeof val === 'object' && val !== null) {
              if (seen.has(val)) {
                return '[Circular]';
              }
              seen.add(val);
              return val;
            }
            if (typeof val === 'string') {
              const text = val.length > MAX_ARG_CHARS ? val.slice(0, MAX_ARG_CHARS) : val;
              budget -= text.length + 2;
              return text;
            }
            budget -= 8;
            return val;
          });
          return String(json).slice(0, MAX_ARG_CHARS);
        } catch {
          try {
            return String(value).slice(0, MAX_ARG_CHARS);
          } catch {
            return '[unserializable]';
          }
        }
      };

      /**
       * @param {string} level
       * @param {string[]} args
       * @returns {void}
       */
      const pushEntry = (level, args) => {
        if (!record.enabled) return;
        buffer.push({ level, args, ts: Date.now() });
        if (buffer.length > MAX) {
          record.dropped =
            (typeof globalThis.__bb_console_dropped === 'number'
              ? globalThis.__bb_console_dropped
              : record.dropped) +
            (buffer.length - MAX);
          globalThis.__bb_console_dropped = record.dropped;
          buffer.splice(0, buffer.length - MAX);
        }
      };

      for (const level of levels) {
        record.originals[level] = consoleMethods[level];
        record.wrappers[level] = (...args) => {
          pushEntry(
            level,
            args.map((a) => serializeArg(a))
          );
          record.originals[level].apply(console, args);
        };
        consoleMethods[level] = record.wrappers[level];
      }
      record.onError = (e) => {
        pushEntry('exception', [
          e.message || 'Unknown error',
          e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '',
        ]);
      };
      record.onRejection = (e) => {
        pushEntry('rejection', [String(e.reason).slice(0, MAX_ARG_CHARS)]);
      };
      globalThis.addEventListener('error', record.onError);
      globalThis.addEventListener('unhandledrejection', record.onRejection);
      record.listenersAttached = true;
      record.enabled = true;
    },
    args: [instrumentationKey],
  });
}

/**
 * Stop console collection, clear buffered data, and restore BBX-owned hooks.
 * Repeated calls are safe, including after partial restoration failures.
 *
 * @param {number} tabId
 * @param {ChromeWithScripting} chromeObj
 * @returns {Promise<void>}
 */
export async function disableConsoleInterceptor(tabId, chromeObj) {
  const instrumentationKey = await getMainWorldInstrumentationKey(chromeObj);
  await chromeObj.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (
      /** @type {boolean} */ _shouldClear,
      /** @type {string} */ recordKey = '__bbx_instrumentation_test'
    ) => {
      const page = /** @type {Record<string, unknown>} */ (globalThis);
      const root = page[recordKey];
      const consoleRecord =
        root && typeof root === 'object'
          ? /** @type {{ console?: ConsoleInstrumentationRecord }} */ (root).console
          : null;
      if (consoleRecord && typeof consoleRecord === 'object') {
        const consoleMethods = /** @type {Record<string, (...args: unknown[]) => void>} */ (
          /** @type {unknown} */ (console)
        );
        consoleRecord.enabled = false;
        consoleRecord.buffer.length = 0;
        consoleRecord.dropped = 0;
        if (consoleRecord.listenersAttached) {
          globalThis.removeEventListener('error', consoleRecord.onError);
          globalThis.removeEventListener('unhandledrejection', consoleRecord.onRejection);
          consoleRecord.listenersAttached = false;
        }
        for (const level of consoleRecord.levels) {
          if (consoleMethods[level] === consoleRecord.wrappers[level]) {
            consoleMethods[level] = consoleRecord.originals[level];
          }
        }
      }
      if (Array.isArray(globalThis.__bb_console_buffer)) {
        globalThis.__bb_console_buffer.length = 0;
      }
      globalThis.__bb_console_dropped = 0;
      globalThis.__bb_console_installed = false;
    },
    args: [true, instrumentationKey],
  });
}

/**
 * Read and optionally clear the console buffer from the page's main world.
 *
 * @param {number} tabId
 * @param {boolean} clear
 * @param {ChromeWithScripting} chromeObj
 * @returns {Promise<{ entries: Array<{level: string, args: string[], ts: number}>, dropped: number }>}
 */
export async function readConsoleBuffer(tabId, clear, chromeObj) {
  const instrumentationKey = await getMainWorldInstrumentationKey(chromeObj);
  const results = await chromeObj.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (/** @type {boolean} */ shouldClear, /** @type {string} */ recordKey) => {
      const root = /** @type {Record<string, unknown>} */ (globalThis)[recordKey];
      const record =
        root && typeof root === 'object'
          ? /** @type {{ console?: ConsoleInstrumentationRecord }} */ (root).console
          : null;
      const buf = Array.isArray(record?.buffer)
        ? record.buffer
        : Array.isArray(globalThis.__bb_console_buffer)
          ? globalThis.__bb_console_buffer
          : [];
      const dropped =
        typeof record?.dropped === 'number'
          ? record.dropped
          : typeof globalThis.__bb_console_dropped === 'number'
            ? globalThis.__bb_console_dropped
            : 0;
      const copy = [...buf];
      if (shouldClear) {
        buf.length = 0;
        if (record) record.dropped = 0;
        globalThis.__bb_console_buffer = buf;
        globalThis.__bb_console_dropped = 0;
      }
      return { entries: copy, dropped };
    },
    args: [clear, instrumentationKey],
  });
  return /** @type {any} */ (results?.[0]?.result) || { entries: [], dropped: 0 };
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRecoverableInstrumentationError(error) {
  const message = normalizeRuntimeErrorMessage(getErrorMessage(error));
  return (
    message === ERROR_CODES.TAB_MISMATCH ||
    /Cannot access contents of/i.test(message) ||
    /The extensions gallery cannot be scripted/i.test(message) ||
    /Cannot access a chrome:\/\//i.test(message) ||
    /Cannot script/i.test(message) ||
    /CONTENT_SCRIPT_UNAVAILABLE/i.test(message) ||
    /No tab with id/i.test(message) ||
    /Cannot attach to this target/i.test(message) ||
    /Another debugger is already attached/i.test(message)
  );
}

/**
 * Best-effort console capture installation for enabled tabs. Some URLs cannot
 * be scripted; those failures should not block enablement or navigation.
 *
 * @param {number} tabId
 * @param {ChromeWithScripting} chromeObj
 * @param {boolean} [resetBuffer=false]
 * @returns {Promise<void>}
 */
export async function primeTabConsoleCapture(tabId, chromeObj, resetBuffer = false) {
  try {
    await ensureConsoleInterceptor(tabId, chromeObj);
    if (resetBuffer) {
      await readConsoleBuffer(tabId, true, chromeObj);
    }
  } catch (error) {
    if (isRecoverableInstrumentationError(error)) {
      return;
    }
    throw error;
  }
}

/**
 * Prime console capture for every tab in one window.
 *
 * @param {number} windowId
 * @param {ChromeWithScripting} chromeObj
 * @param {boolean} [resetBuffer=false]
 * @returns {Promise<void>}
 */
export async function primeWindowConsoleCapture(windowId, chromeObj, resetBuffer = false) {
  const tabs = await chromeObj.tabs.query({ windowId });
  const tabIds = tabs
    .map((tab) => (isNumber(tab.id) ? tab.id : null))
    .filter((tabId) => tabId !== null);
  await Promise.allSettled(
    tabIds.map((tabId) => primeTabConsoleCapture(tabId, chromeObj, resetBuffer))
  );
}
