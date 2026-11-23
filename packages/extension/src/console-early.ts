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
  const levels = ['log', 'warn', 'error', 'info', 'debug'];
  const methods = console as unknown as Record<string, (...args: unknown[]) => void>;
  const buffer: Array<{ level: string; args: string[]; ts: number }> = [];
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

  const record = {
    buffer,
    dropped: 0,
    adopted: false,
    release: (): void => {},
  };
  const push = (level: string, args: string[]): void => {
    buffer.push({ level, args, ts: Date.now() });
    if (buffer.length > MAX_ENTRIES) {
      record.dropped += buffer.length - MAX_ENTRIES;
      buffer.splice(0, buffer.length - MAX_ENTRIES);
    }
  };
  const onError = (event: ErrorEvent): void => {
    push('exception', [
      event.message || 'Unknown error',
      event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : '',
    ]);
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    push('rejection', [String(event.reason).slice(0, MAX_ARG_CHARS)]);
  };

  for (const level of levels) {
    const original = methods[level];
    if (typeof original !== 'function') continue;
    originals[level] = original;
    wrappers[level] = (...args: unknown[]) => {
      push(level, args.map(serialize));
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
