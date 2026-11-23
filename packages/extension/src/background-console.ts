import {
  ERROR_CODES,
  sanitizeIncidentalText,
  sanitizeIncidentalValue,
} from '../../../protocol/src/index.js';
import {
  getErrorMessage,
  isUnavailableDocumentError,
  normalizeRuntimeErrorMessage,
} from './background-helpers.js';
import { getMainWorldInstrumentationKey } from './background-main-world-instrumentation.js';
import { isNumber } from './background-state.js';

export type ConsoleInstrumentationRecord = {
  enabled: boolean;
  buffer: Array<{ level: string; args: string[]; ts: number }>;
  dropped: number;
  levels: string[];
  originals: Record<string, (...args: unknown[]) => void>;
  wrappers: Record<string, (...args: unknown[]) => void>;
  onError: (event: ErrorEvent) => void;
  onRejection: (event: PromiseRejectionEvent) => void;
  listenersAttached: boolean;
};

export type ChromeWithScripting = {
  scripting: {
    executeScript: <Args extends unknown[], Result>(
      config: chrome.scripting.ScriptInjection<Args, Result>
    ) => Promise<unknown[]>;
  };
  storage?: {
    session?: {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (value: Record<string, unknown>) => Promise<void>;
    };
  };
  tabs: { query: (info: { windowId: number }) => Promise<Array<{ id?: unknown }>> };
};

/** Inject the console interceptor into the page's main world if not already
present. The interceptor patches console methods and captures unhandled
errors into a bounded in-page buffer. */
export async function ensureConsoleInterceptor(
  tabId: number,
  chromeObj: ChromeWithScripting
): Promise<void> {
  const instrumentationKey = await getMainWorldInstrumentationKey(chromeObj);
  await chromeObj.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (recordKey: string = '__bbx_instrumentation_test') => {
      const page = globalThis as Record<string, unknown>;
      const root =
        page[recordKey] && typeof page[recordKey] === 'object'
          ? (page[recordKey] as Record<string, unknown>)
          : (page[recordKey] = {});
      const consoleMethods = console as unknown as Record<string, (...args: unknown[]) => void>;
      // Adopt what the document_start hook captured during page load, and
      // unhook it first so the regular wrappers wrap the real methods.
      const early = page.__bbx_console_early__ as
        | {
            buffer?: unknown;
            dropped?: unknown;
            adopted?: boolean;
            release?: () => void;
          }
        | undefined;
      const earlyEntries: Array<{ level: string; args: string[]; ts: number }> = [];
      let earlyDropped = 0;
      if (early && typeof early === 'object' && Array.isArray(early.buffer)) {
        early.adopted = true;
        for (const entry of early.buffer.slice(-200)) {
          if (
            entry &&
            typeof entry === 'object' &&
            typeof (entry as { level?: unknown }).level === 'string' &&
            Array.isArray((entry as { args?: unknown }).args)
          ) {
            const typed = entry as { level: string; args: unknown[]; ts?: unknown };
            earlyEntries.push({
              level: typed.level.slice(0, 20),
              args: typed.args.slice(0, 20).map((arg) => String(arg).slice(0, 500)),
              ts: typeof typed.ts === 'number' ? typed.ts : Date.now(),
            });
          }
        }
        earlyDropped = typeof early.dropped === 'number' ? early.dropped : 0;
        try {
          early.release?.();
        } catch {
          // A page that tampered with the hook keeps its own state.
        }
      }
      const adoptEarly = (record: ConsoleInstrumentationRecord): void => {
        if (!earlyEntries.length && !earlyDropped) return;
        record.buffer.unshift(...earlyEntries);
        const excess = Math.max(0, record.buffer.length - 200);
        if (excess) record.buffer.splice(0, excess);
        record.dropped += earlyDropped + excess;
        globalThis.__bb_console_dropped = record.dropped;
      };
      const existing = root.console;
      if (existing && typeof existing === 'object') {
        const record = existing as ConsoleInstrumentationRecord;
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
        adoptEarly(record);
        return;
      }

      const buffer: Array<{ level: string; args: string[]; ts: number }> = [];
      const levels = ['log', 'warn', 'error', 'info', 'debug'];
      const record: ConsoleInstrumentationRecord = {
        enabled: false,
        buffer,
        dropped: 0,
        levels,

        originals: {},

        wrappers: {},

        onError: (): void => {},

        onRejection: (): void => {},
        listenersAttached: false,
      };
      root.console = record;
      globalThis.__bb_console_installed = true;
      globalThis.__bb_console_buffer = buffer;
      globalThis.__bb_console_dropped = 0;
      const MAX = 200;
      const MAX_ARG_CHARS = 500;

      /** Serialize one console argument into a bounded string. Uses a budgeted
JSON walk that prunes subtrees once the budget is spent, so logging a
huge state tree stays cheap for the page. Errors keep their message
(their fields are non-enumerable, so plain stringify yields "{}"). */
      const serializeArg = (value: unknown): string => {
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

      const pushEntry = (level: string, args: string[]): void => {
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
      adoptEarly(record);
    },
    args: [instrumentationKey],
  });
}

/** Stop console collection, clear buffered data, and restore BBX-owned hooks.
Repeated calls are safe, including after partial restoration failures. */
export async function disableConsoleInterceptor(
  tabId: number,
  chromeObj: ChromeWithScripting
): Promise<void> {
  const instrumentationKey = await getMainWorldInstrumentationKey(chromeObj);
  await chromeObj.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (_shouldClear: boolean, recordKey: string = '__bbx_instrumentation_test') => {
      const page = globalThis as Record<string, unknown>;
      const root = page[recordKey];
      const consoleRecord =
        root && typeof root === 'object'
          ? (root as { console?: ConsoleInstrumentationRecord }).console
          : null;
      if (consoleRecord && typeof consoleRecord === 'object') {
        const consoleMethods = console as unknown as Record<string, (...args: unknown[]) => void>;
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

/** Read and optionally clear the console buffer from the page's main world. */
export async function readConsoleBuffer(
  tabId: number,
  clear: boolean,
  chromeObj: ChromeWithScripting
): Promise<{
  entries: Array<{ level: string; args: string[]; ts: number }>;
  dropped: number;
  provenance: 'page_main_world';
  integrity: 'untrusted';
}> {
  const instrumentationKey = await getMainWorldInstrumentationKey(chromeObj);
  const results = await chromeObj.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (shouldClear: boolean, recordKey: string) => {
      const root = (globalThis as Record<string, unknown>)[recordKey];
      const record =
        root && typeof root === 'object'
          ? (root as { console?: ConsoleInstrumentationRecord }).console
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
      // The page can replace this buffer. Bound the cross-world clone before
      // Chrome serializes it back to the extension.
      const copy = buf.slice(-200);
      const boundedDropped =
        (typeof dropped === 'number' && Number.isFinite(dropped) && dropped >= 0 ? dropped : 0) +
        Math.max(0, buf.length - copy.length);
      if (shouldClear) {
        buf.length = 0;
        if (record) record.dropped = 0;
        globalThis.__bb_console_buffer = buf;
        globalThis.__bb_console_dropped = 0;
      }
      return { entries: copy, dropped: boundedDropped };
    },
    args: [clear, instrumentationKey],
  });
  const result = (results?.[0] as { result?: { entries?: unknown; dropped?: unknown } } | undefined)
    ?.result || { entries: [], dropped: 0 };
  return {
    entries: Array.isArray(result.entries)
      ? result.entries
          .slice(-200)
          .map(normalizeConsoleEntry)
          .filter((entry) => entry !== null)
      : [],
    dropped: normalizeConsoleCount(result.dropped),
    provenance: 'page_main_world',
    integrity: 'untrusted',
  };
}

const CONSOLE_LEVELS = new Set(['log', 'warn', 'error', 'info', 'debug', 'exception', 'rejection']);

function normalizeConsoleCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(1_000_000, Math.trunc(value))
    : 0;
}

function normalizeConsoleTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value))
    : 0;
}

function normalizeConsoleEntry(
  value: unknown
): { level: string; args: string[]; ts: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const args = Array.isArray(entry.args)
    ? entry.args.slice(0, 20).map((argument) => sanitizeConsoleArgument(argument))
    : [];
  return {
    level: typeof entry.level === 'string' && CONSOLE_LEVELS.has(entry.level) ? entry.level : 'log',
    args,
    ts: normalizeConsoleTimestamp(entry.ts),
  };
}

function sanitizeConsoleArgument(value: unknown) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
    try {
      return JSON.stringify(sanitizeIncidentalValue(JSON.parse(text)));
    } catch {
      // Fall through to text sanitization for malformed JSON-looking values.
    }
  }
  return sanitizeIncidentalText(text, 500);
}

export function isRecoverableInstrumentationError(error: unknown): boolean {
  if (
    error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === ERROR_CODES.CONTENT_SCRIPT_UNAVAILABLE
  ) {
    return true;
  }
  const message = normalizeRuntimeErrorMessage(getErrorMessage(error));
  return (
    message === ERROR_CODES.TAB_MISMATCH ||
    isUnavailableDocumentError(message) ||
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

const EARLY_CONSOLE_SCRIPT_ID = 'bbx-console-early';

type ChromeWithContentScriptRegistration = {
  scripting?: {
    registerContentScripts?: (scripts: chrome.scripting.RegisteredContentScript[]) => Promise<void>;
    unregisterContentScripts?: (filter?: { ids?: string[] }) => Promise<void>;
    getRegisteredContentScripts?: (filter?: {
      ids?: string[];
    }) => Promise<chrome.scripting.RegisteredContentScript[]>;
  };
};

/** Register the document_start console hook while access is on, so output
from page load is not lost before the tab finishes loading; unregister it
when access is off. Best effort: older engines keep load-time capture off. */
export async function syncEarlyConsoleCapture(
  enabled: boolean,
  chromeObj: ChromeWithContentScriptRegistration
): Promise<void> {
  const scripting = chromeObj.scripting;
  if (
    typeof scripting?.registerContentScripts !== 'function' ||
    typeof scripting.unregisterContentScripts !== 'function' ||
    typeof scripting.getRegisteredContentScripts !== 'function'
  ) {
    return;
  }
  try {
    const registered = await scripting.getRegisteredContentScripts({
      ids: [EARLY_CONSOLE_SCRIPT_ID],
    });
    if (enabled && !registered.length) {
      await scripting.registerContentScripts([
        {
          id: EARLY_CONSOLE_SCRIPT_ID,
          js: ['src/console-early.js'],
          matches: ['<all_urls>'],
          runAt: 'document_start',
          world: 'MAIN',
          allFrames: false,
          persistAcrossSessions: false,
        },
      ]);
    } else if (!enabled && registered.length) {
      await scripting.unregisterContentScripts({ ids: [EARLY_CONSOLE_SCRIPT_ID] });
    }
  } catch {
    // Registration is an optimization; regular capture still starts on load.
  }
}

/** Best-effort console capture installation for enabled tabs. Some URLs cannot
be scripted; those failures should not block enablement or navigation. */
export async function primeTabConsoleCapture(
  tabId: number,
  chromeObj: ChromeWithScripting,
  resetBuffer: boolean = false
): Promise<void> {
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

/** Prime console capture for every tab in one window. */
export async function primeWindowConsoleCapture(
  windowId: number,
  chromeObj: ChromeWithScripting,
  resetBuffer: boolean = false
): Promise<void> {
  const tabs = await chromeObj.tabs.query({ windowId });
  const tabIds = tabs
    .map((tab) => (isNumber(tab.id) ? tab.id : null))
    .filter((tabId) => tabId !== null);
  await Promise.allSettled(
    tabIds.map((tabId) => primeTabConsoleCapture(tabId, chromeObj, resetBuffer))
  );
}
