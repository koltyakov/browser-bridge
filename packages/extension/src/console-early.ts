// Registered with world MAIN at document_start only while window access is
// on, so console output and errors from page load are kept until the regular
// interceptor adopts them once the tab finishes loading. In tabs that are
// never inspected the hook removes itself after a short window.
// Classic script: no imports or exports.
(() => {
  const KEY = '__bbx_console_early__';
  const page = globalThis as unknown as Record<string, unknown>;
  if (page[KEY]) return;
  const RELEASE_AFTER_MS = 15_000;
  const MAX_ENTRIES = 200;
  const MAX_ARG_CHARS = 500;
  const MAX_STACK_CHARS = 1_500;
  const levels = ['log', 'warn', 'error', 'info', 'debug'];
  const methods = console as unknown as Record<string, (...args: unknown[]) => void>;
  const buffer: Array<{ level: string; args: string[]; ts: number; stack?: string }> = [];
  const originals: Record<string, (...args: unknown[]) => void> = {};
  const wrappers: Record<string, (...args: unknown[]) => void> = {};

  const serialize = (value: unknown): string => {
    try {
      if (typeof value !== 'object' || value === null || value instanceof Error) {
        return String(value).slice(0, MAX_ARG_CHARS);
      }
      let budget = MAX_ARG_CHARS;
      const seen = new WeakSet<object>();
      const json = JSON.stringify(value, (_key, entry: unknown) => {
        if (budget <= 0) return undefined;
        if (typeof entry === 'object' && entry !== null) {
          if (seen.has(entry)) return '[Circular]';
          seen.add(entry);
          return entry;
        }
        budget -= typeof entry === 'string' ? Math.min(entry.length, MAX_ARG_CHARS) + 2 : 8;
        return typeof entry === 'string' ? entry.slice(0, MAX_ARG_CHARS) : entry;
      });
      return String(json).slice(0, MAX_ARG_CHARS);
    } catch {
      return '[unserializable]';
    }
  };

  let readingStack = false;
  // The page owns thrown values; a throwing or re-entrant stack getter yields
  // no stack rather than an error inside page code.
  const readStack = (value: unknown): string | undefined => {
    if (readingStack || !value || typeof value !== 'object') return undefined;
    readingStack = true;
    try {
      const stack = (value as { stack?: unknown }).stack;
      return typeof stack === 'string' && stack ? stack.slice(0, MAX_STACK_CHARS) : undefined;
    } catch {
      return undefined;
    } finally {
      readingStack = false;
    }
  };
  const isErrorLike = (value: unknown): boolean => {
    try {
      return value instanceof Error || Object.prototype.toString.call(value) === '[object Error]';
    } catch {
      return false;
    }
  };

  const record = {
    buffer,
    dropped: 0,
    adopted: false,
    release: (): void => {},
  };
  const push = (level: string, args: string[], stack?: string): void => {
    const entry: { level: string; args: string[]; ts: number; stack?: string } = {
      level,
      args,
      ts: Date.now(),
    };
    if (stack) entry.stack = stack;
    buffer.push(entry);
    if (buffer.length > MAX_ENTRIES) {
      record.dropped += buffer.length - MAX_ENTRIES;
      buffer.splice(0, buffer.length - MAX_ENTRIES);
    }
  };
  const onError = (event: ErrorEvent): void => {
    push(
      'exception',
      [
        event.message || 'Unknown error',
        event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : '',
      ],
      readStack(event.error)
    );
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    push('rejection', [String(event.reason).slice(0, MAX_ARG_CHARS)], readStack(event.reason));
  };

  for (const level of levels) {
    const original = methods[level];
    if (typeof original !== 'function') continue;
    originals[level] = original;
    const keepsStack = level === 'error' || level === 'warn';
    wrappers[level] = (...args: unknown[]) => {
      const error = keepsStack ? args.find(isErrorLike) : undefined;
      push(level, args.map(serialize), error === undefined ? undefined : readStack(error));
      original.apply(console, args);
    };
    methods[level] = wrappers[level];
  }
  globalThis.addEventListener('error', onError);
  globalThis.addEventListener('unhandledrejection', onRejection);

  record.release = () => {
    for (const level of Object.keys(wrappers)) {
      // Leave methods the page replaced since; restoring would undo its hook.
      if (methods[level] === wrappers[level]) methods[level] = originals[level];
    }
    globalThis.removeEventListener('error', onError);
    globalThis.removeEventListener('unhandledrejection', onRejection);
    if (page[KEY] === record) delete page[KEY];
  };
  page[KEY] = record;
  setTimeout(() => {
    if (!record.adopted) record.release();
  }, RELEASE_AFTER_MS);
})();
