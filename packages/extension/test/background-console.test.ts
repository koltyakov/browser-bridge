import test from 'node:test';
import assert from 'node:assert/strict';

import { ERROR_CODES } from '../../../protocol/src/index.js';
import {
  disableConsoleInterceptor,
  ensureConsoleInterceptor,
  isRecoverableInstrumentationError,
  primeTabConsoleCapture,
  primeWindowConsoleCapture,
  readConsoleBuffer,
  syncEarlyConsoleCapture,
} from '../src/background-console.js';
import { readFile } from 'node:fs/promises';
import { extensionFile } from '../../../tests/_helpers/extensionBuild.ts';

type ConsoleEntry = { level: string; args: string[]; ts: number; stack?: string };
type ExecuteScriptConfig = {
  target?: { tabId?: number };
  world?: string;
  args?: unknown[];
};
type ExecuteScriptResult = Array<{ result?: unknown }>;
type ConsoleChrome = Parameters<typeof ensureConsoleInterceptor>[1];
type PageGlobal = typeof globalThis & {
  __bb_console_installed?: boolean;
  __bb_console_buffer?: ConsoleEntry[];
  __bb_console_dropped?: number;
  addEventListener?: (type: string, listener: (event: Record<string, unknown>) => void) => void;
  removeEventListener?: (type: string, listener: (event: Record<string, unknown>) => void) => void;
};

const consoleLevels = ['log', 'warn', 'error', 'info', 'debug'] as const;

function pageGlobal(): PageGlobal {
  return globalThis as PageGlobal;
}

function clearInjectedConsoleState(): void {
  const page = pageGlobal();
  for (const key of Object.getOwnPropertyNames(page)) {
    if (key.startsWith('__bbx_instrumentation_')) Reflect.deleteProperty(page, key);
  }
  delete page.__bb_console_installed;
  delete page.__bb_console_buffer;
  delete page.__bb_console_dropped;
}

function getBuffer(): ConsoleEntry[] {
  const buffer = pageGlobal().__bb_console_buffer;
  assert.ok(Array.isArray(buffer));
  return buffer;
}

function createScriptExecutingChrome(
  onExecute?: <Args extends unknown[], Result>(
    config: chrome.scripting.ScriptInjection<Args, Result>
  ) => ExecuteScriptResult | Promise<ExecuteScriptResult>
): ConsoleChrome {
  return {
    scripting: {
      async executeScript<Args extends unknown[], Result>(
        config: chrome.scripting.ScriptInjection<Args, Result>
      ) {
        if (onExecute) {
          return onExecute(config);
        }
        return [{ result: executeInjected(config) }];
      },
    },
    tabs: {
      async query() {
        return [];
      },
    },
  };
}

function executeInjected<Args extends unknown[], Result>(
  config: chrome.scripting.ScriptInjection<Args, Result>
): Result | undefined {
  return config.func?.(...(('args' in config ? config.args : []) as Args));
}

test('ensureConsoleInterceptor installs, records, bounds, and avoids duplicate hooks', async (t) => {
  clearInjectedConsoleState();
  for (const level of consoleLevels) {
    t.mock.method(console, level, () => {});
  }

  const addEventListenerDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'addEventListener'
  );
  const removeEventListenerDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'removeEventListener'
  );
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  let listenerInstallCount = 0;
  Object.defineProperty(globalThis, 'addEventListener', {
    configurable: true,
    value(type: string, listener: (event: Record<string, unknown>) => void): void {
      listenerInstallCount += 1;
      listeners.set(type, listener);
    },
  });
  Object.defineProperty(globalThis, 'removeEventListener', {
    configurable: true,
    value(type: string, listener: (event: Record<string, unknown>) => void): void {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  });
  t.after(() => {
    clearInjectedConsoleState();
    if (addEventListenerDescriptor) {
      Object.defineProperty(globalThis, 'addEventListener', addEventListenerDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'addEventListener');
    }
    if (removeEventListenerDescriptor) {
      Object.defineProperty(globalThis, 'removeEventListener', removeEventListenerDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'removeEventListener');
    }
  });

  const executeScriptCalls: ExecuteScriptConfig[] = [];
  const chromeObj = createScriptExecutingChrome((config) => {
    executeScriptCalls.push(config);
    return [{ result: executeInjected(config) }];
  });

  await ensureConsoleInterceptor(42, chromeObj);

  assert.deepEqual(
    executeScriptCalls.map((call) => ({ target: call.target, world: call.world })),
    [{ target: { tabId: 42 }, world: 'MAIN' }]
  );
  assert.equal(pageGlobal().__bb_console_installed, true);
  assert.equal(listenerInstallCount, 2);

  console.log('ready', { ok: true });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  console.error(circular);
  console.error(new Error('boom'), { cause: new TypeError('bad input') });
  listeners.get('error')?.({
    message: 'Kaboom',
    filename: 'https://example.test/app.js',
    lineno: 7,
    colno: 11,
  });
  listeners.get('unhandledrejection')?.({ reason: 'Promise exploded' });

  assert.deepEqual(
    getBuffer().map((entry) => ({ level: entry.level, args: entry.args })),
    [
      { level: 'log', args: ['ready', '{"ok":true}'] },
      { level: 'error', args: ['{"self":"[Circular]"}'] },
      {
        level: 'error',
        args: ['Error: boom', '{"cause":"TypeError: bad input"}'],
      },
      {
        level: 'exception',
        args: ['Kaboom', 'https://example.test/app.js:7:11'],
      },
      { level: 'rejection', args: ['Promise exploded'] },
    ]
  );

  const hugeState = {
    items: Array.from({ length: 5_000 }, (_, index) => ({
      id: index,
      label: `item-${index}`,
    })),
  };
  console.log(hugeState);
  const hugeEntry = getBuffer().at(-1);
  assert.ok(hugeEntry);
  assert.equal(hugeEntry.args.length, 1);
  assert.ok(hugeEntry.args[0].length <= 500);
  assert.ok(hugeEntry.args[0].startsWith('{"items":'));

  const buffer = getBuffer();
  buffer.length = 0;
  pageGlobal().__bb_console_dropped = 0;
  for (let index = 0; index < 201; index += 1) {
    console.warn(`warn-${index}`);
  }
  assert.equal(buffer.length, 200);
  assert.equal(buffer[0].args[0], 'warn-1');
  assert.equal(pageGlobal().__bb_console_dropped, 1);

  buffer.length = 0;
  pageGlobal().__bb_console_dropped = 0;
  for (let index = 0; index < 201; index += 1) {
    listeners.get('error')?.({ message: `error-${index}` });
  }
  assert.equal(buffer.length, 200);
  assert.equal(buffer[0].args[0], 'error-1');
  assert.equal(pageGlobal().__bb_console_dropped, 1);

  buffer.length = 0;
  pageGlobal().__bb_console_dropped = 0;
  for (let index = 0; index < 201; index += 1) {
    listeners.get('unhandledrejection')?.({ reason: `rejection-${index}` });
  }
  assert.equal(buffer.length, 200);
  assert.equal(buffer[0].args[0], 'rejection-1');
  assert.equal(pageGlobal().__bb_console_dropped, 1);

  const installedBuffer = getBuffer();
  await readConsoleBuffer(42, true, chromeObj);
  assert.strictEqual(pageGlobal().__bb_console_buffer, installedBuffer);
  assert.equal(installedBuffer.length, 0);
  assert.equal(pageGlobal().__bb_console_dropped, 0);
  console.info('after-clear');
  assert.strictEqual(getBuffer(), installedBuffer);
  assert.deepEqual(
    installedBuffer.map((entry) => entry.args),
    [['after-clear']]
  );

  await ensureConsoleInterceptor(42, chromeObj);
  assert.equal(executeScriptCalls.length, 3);
  assert.equal(listenerInstallCount, 2);

  const wrappedLog = console.log;
  await disableConsoleInterceptor(42, chromeObj);
  assert.equal(listeners.size, 0);
  wrappedLog('disabled-period');
  assert.deepEqual(getBuffer(), []);

  await ensureConsoleInterceptor(42, chromeObj);
  assert.equal(listenerInstallCount, 4);
  assert.deepEqual(getBuffer(), []);
  console.log('re-enabled');
  assert.deepEqual(
    getBuffer().map((entry) => entry.args),
    [['re-enabled']]
  );

  const pageReplacement = () => {};
  console.log = pageReplacement;
  await disableConsoleInterceptor(42, chromeObj);
  await disableConsoleInterceptor(42, chromeObj);
  assert.strictEqual(console.log, pageReplacement);
});

test('readConsoleBuffer reads, clears, and falls back when no result is returned', async (t) => {
  clearInjectedConsoleState();
  t.after(clearInjectedConsoleState);
  const entry = { level: 'log', args: ['hello'], ts: 1 };
  const pageBuffer = [entry];
  pageGlobal().__bb_console_buffer = pageBuffer;
  pageGlobal().__bb_console_dropped = 2;

  const executeScriptCalls: ExecuteScriptConfig[] = [];
  const chromeObj = createScriptExecutingChrome((config) => {
    executeScriptCalls.push(config);
    return [{ result: executeInjected(config) }];
  });

  assert.deepEqual(await readConsoleBuffer(8, false, chromeObj), {
    entries: [entry],
    dropped: 2,
    provenance: 'page_main_world',
    integrity: 'untrusted',
  });
  assert.strictEqual(pageGlobal().__bb_console_buffer, pageBuffer);
  assert.deepEqual(pageGlobal().__bb_console_buffer, [entry]);

  assert.deepEqual(await readConsoleBuffer(8, true, chromeObj), {
    entries: [entry],
    dropped: 2,
    provenance: 'page_main_world',
    integrity: 'untrusted',
  });
  assert.strictEqual(pageGlobal().__bb_console_buffer, pageBuffer);
  assert.deepEqual(pageBuffer, []);
  assert.equal(pageGlobal().__bb_console_dropped, 0);
  assert.deepEqual(
    executeScriptCalls.map((call) => ({ target: call.target, world: call.world, args: call.args })),
    [
      {
        target: { tabId: 8 },
        world: 'MAIN',
        args: [false, executeScriptCalls[0].args?.[1]],
      },
      { target: { tabId: 8 }, world: 'MAIN', args: [true, executeScriptCalls[0].args?.[1]] },
    ]
  );

  const fallbackChrome = createScriptExecutingChrome(() => []);
  assert.deepEqual(await readConsoleBuffer(8, false, fallbackChrome), {
    entries: [],
    dropped: 0,
    provenance: 'page_main_world',
    integrity: 'untrusted',
  });
});

test('readConsoleBuffer sanitizes structured secrets and incidental text', async (t) => {
  clearInjectedConsoleState();
  t.after(clearInjectedConsoleState);
  pageGlobal().__bb_console_buffer = [
    {
      level: 'error',
      args: [
        '{"authorization":"Bearer secret","tokenCount":3}',
        'failed at /Users/alice/project/config.json',
      ],
      ts: 1,
    },
  ];

  const result = await readConsoleBuffer(8, false, createScriptExecutingChrome());
  assert.deepEqual(result.entries[0].args, [
    '{"authorization":"[redacted]","tokenCount":3}',
    'failed at [redacted-path]/config.json',
  ]);
});

test('readConsoleBuffer treats main-world records as untrusted input', async (t) => {
  clearInjectedConsoleState();
  t.after(clearInjectedConsoleState);
  pageGlobal().__bb_console_buffer = [
    {
      level: 'forged',
      args: Array.from({ length: 25 }, (_, index) => `arg-${index}`),
      ts: 1_700_000_000_000,
      transport: 'extension',
    },
  ] as unknown as ConsoleEntry[];
  pageGlobal().__bb_console_dropped = 9_999_999;

  const result = await readConsoleBuffer(8, false, createScriptExecutingChrome());
  assert.deepEqual(result.entries, [
    {
      level: 'log',
      args: Array.from({ length: 20 }, (_, index) => `arg-${index}`),
      ts: 1_700_000_000_000,
    },
  ]);
  assert.equal(result.dropped, 1_000_000);
  assert.equal('transport' in result.entries[0], false);
  assert.equal(result.integrity, 'untrusted');
});

test('readConsoleBuffer bounds page-replaced buffers before returning them', async (t) => {
  clearInjectedConsoleState();
  t.after(clearInjectedConsoleState);
  pageGlobal().__bb_console_buffer = Array.from({ length: 205 }, (_, index) => ({
    level: 'log',
    args: [`entry-${index}`],
    ts: index,
  }));

  const result = await readConsoleBuffer(8, false, createScriptExecutingChrome());
  assert.equal(result.entries.length, 200);
  assert.equal(result.dropped, 5);
  assert.deepEqual(result.entries[0].args, ['entry-5']);
});

test('console instrumentation errors are classified for best-effort priming', () => {
  const recoverableMessages = [
    ERROR_CODES.TAB_MISMATCH,
    'Cannot access contents of the page',
    'The extensions gallery cannot be scripted',
    'Cannot access a chrome:// URL',
    'Cannot script this page',
    'CONTENT_SCRIPT_UNAVAILABLE: no script',
    'No tab with id: 9',
    'Cannot attach to this target',
    'Another debugger is already attached',
    'Frame with ID 0 is showing error page',
    'Frame with ID 8 was removed.',
    'No frame with id 8 in tab 41',
    'The tab was closed.',
  ];

  for (const message of recoverableMessages) {
    assert.equal(isRecoverableInstrumentationError(new Error(message)), true, message);
  }
  assert.equal(isRecoverableInstrumentationError(new Error('Unexpected failure')), false);
});

test('primeTabConsoleCapture clears on reset and only swallows recoverable failures', async () => {
  const executeScriptCalls: ExecuteScriptConfig[] = [];
  const chromeObj = createScriptExecutingChrome((config) => {
    executeScriptCalls.push(config);
    const tabId = config.target?.tabId;
    if (tabId === 2) {
      throw new Error('No tab with id: 2');
    }
    if (tabId === 3) {
      throw new Error('boom');
    }
    return [{ result: { entries: [], dropped: 0 } }];
  });

  await primeTabConsoleCapture(1, chromeObj, true);
  await primeTabConsoleCapture(2, chromeObj);
  await assert.rejects(() => primeTabConsoleCapture(3, chromeObj), /boom/);

  assert.deepEqual(
    executeScriptCalls.map((call) => ({ target: call.target, args: call.args ?? null })),
    [
      { target: { tabId: 1 }, args: [executeScriptCalls[0].args?.[0]] },
      { target: { tabId: 1 }, args: [true, executeScriptCalls[0].args?.[0]] },
      { target: { tabId: 2 }, args: [executeScriptCalls[0].args?.[0]] },
      { target: { tabId: 3 }, args: [executeScriptCalls[0].args?.[0]] },
    ]
  );
});

test('primeWindowConsoleCapture primes numeric tab ids and settles individual failures', async () => {
  const executeScriptCalls: ExecuteScriptConfig[] = [];
  const chromeObj: ConsoleChrome = {
    scripting: {
      async executeScript(config: ExecuteScriptConfig) {
        executeScriptCalls.push(config);
        if (config.target?.tabId === 12 && !config.args) {
          throw new Error('No tab with id: 12');
        }
        return [{ result: { entries: [], dropped: 0 } }];
      },
    },
    tabs: {
      async query(queryInfo: Record<string, unknown>) {
        assert.deepEqual(queryInfo, { windowId: 7 });
        return [{ id: 11 }, { id: 'ignored' }, { title: 'missing id' }, { id: 12 }];
      },
    },
  };

  await primeWindowConsoleCapture(7, chromeObj, true);

  assert.deepEqual(
    executeScriptCalls.map((call) => ({ target: call.target, args: call.args ?? null })),
    [
      { target: { tabId: 11 }, args: [executeScriptCalls[0].args?.[0]] },
      { target: { tabId: 12 }, args: [executeScriptCalls[0].args?.[0]] },
      { target: { tabId: 11 }, args: [true, executeScriptCalls[0].args?.[0]] },
      { target: { tabId: 12 }, args: [true, executeScriptCalls[0].args?.[0]] },
    ]
  );
});

test('the document_start hook keeps load-time output for the interceptor to adopt', async (t) => {
  clearInjectedConsoleState();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originals = new Map<string, (...args: unknown[]) => void>();
  for (const level of consoleLevels) {
    t.mock.method(console, level, () => {});
    originals.set(level, console[level]);
  }
  const listeners = new Set<string>();
  const page = globalThis as unknown as Record<string, unknown>;
  const savedAdd = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
  const savedRemove = Object.getOwnPropertyDescriptor(globalThis, 'removeEventListener');
  Object.defineProperty(globalThis, 'addEventListener', {
    configurable: true,
    value: (type: string) => listeners.add(type),
  });
  Object.defineProperty(globalThis, 'removeEventListener', {
    configurable: true,
    value: (type: string) => listeners.delete(type),
  });
  t.after(() => {
    clearInjectedConsoleState();
    delete page.__bbx_console_early__;
    for (const [name, descriptor] of [
      ['addEventListener', savedAdd],
      ['removeEventListener', savedRemove],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  const source = await readFile(extensionFile('src/console-early.js'), 'utf8');
  new Function(source)();
  assert.ok(page.__bbx_console_early__, 'hook installed');
  console.warn('booting', { step: 1 });

  await ensureConsoleInterceptor(7, createScriptExecutingChrome());
  assert.equal(page.__bbx_console_early__, undefined, 'early hook released after adoption');
  console.log('after load');
  assert.deepEqual(
    getBuffer().map((entry) => [entry.level, entry.args]),
    [
      ['warn', ['booting', '{"step":1}']],
      ['log', ['after load']],
    ]
  );
});

test('an unadopted document_start hook removes itself', async (t) => {
  clearInjectedConsoleState();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'log', () => {});
  const before = console.log;
  const page = globalThis as unknown as Record<string, unknown>;
  const savedAdd = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
  const savedRemove = Object.getOwnPropertyDescriptor(globalThis, 'removeEventListener');
  Object.defineProperty(globalThis, 'addEventListener', { configurable: true, value: () => {} });
  Object.defineProperty(globalThis, 'removeEventListener', { configurable: true, value: () => {} });
  t.after(() => {
    delete page.__bbx_console_early__;
    for (const [name, descriptor] of [
      ['addEventListener', savedAdd],
      ['removeEventListener', savedRemove],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  new Function(await readFile(extensionFile('src/console-early.js'), 'utf8'))();
  assert.notEqual(console.log, before, 'console wrapped');
  t.mock.timers.tick(15_000);
  assert.equal(console.log, before, 'console restored');
  assert.equal(page.__bbx_console_early__, undefined);
});

test('syncEarlyConsoleCapture registers once while enabled and unregisters when disabled', async () => {
  const registered: string[] = [];
  const calls: string[] = [];
  const chromeObj = {
    scripting: {
      async registerContentScripts(scripts: chrome.scripting.RegisteredContentScript[]) {
        calls.push('register');
        for (const script of scripts) {
          assert.equal(script.world, 'MAIN');
          assert.equal(script.runAt, 'document_start');
          registered.push(script.id);
        }
      },
      async unregisterContentScripts(filter?: { ids?: string[] }) {
        calls.push('unregister');
        for (const id of filter?.ids ?? []) registered.splice(registered.indexOf(id), 1);
      },
      async getRegisteredContentScripts(filter?: { ids?: string[] }) {
        return registered
          .filter((id) => !filter?.ids || filter.ids.includes(id))
          .map((id) => ({ id }) as chrome.scripting.RegisteredContentScript);
      },
    },
  };
  await syncEarlyConsoleCapture(true, chromeObj);
  await syncEarlyConsoleCapture(true, chromeObj);
  await syncEarlyConsoleCapture(false, chromeObj);
  await syncEarlyConsoleCapture(false, chromeObj);
  assert.deepEqual(calls, ['register', 'unregister']);
  await syncEarlyConsoleCapture(true, {});
});

type Listener = (event: Record<string, unknown>) => void;

/** Capture window listeners so tests can fire error and rejection events. */
function captureWindowListeners(t: { after: (fn: () => void) => void }): Map<string, Listener> {
  const listeners = new Map<string, Listener>();
  const savedAdd = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
  const savedRemove = Object.getOwnPropertyDescriptor(globalThis, 'removeEventListener');
  Object.defineProperty(globalThis, 'addEventListener', {
    configurable: true,
    value: (type: string, listener: Listener) => listeners.set(type, listener),
  });
  Object.defineProperty(globalThis, 'removeEventListener', {
    configurable: true,
    value: (type: string, listener: Listener) => {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  });
  t.after(() => {
    for (const [name, descriptor] of [
      ['addEventListener', savedAdd],
      ['removeEventListener', savedRemove],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  return listeners;
}

function errorWithStack(message: string, ...frames: string[]): Error {
  const error = new Error(message);
  error.stack = [`Error: ${message}`, ...frames.map((frame) => `    at ${frame}`)].join('\n');
  return error;
}

test('the interceptor records stacks for exceptions, rejections, and logged errors', async (t) => {
  clearInjectedConsoleState();
  t.after(clearInjectedConsoleState);
  for (const level of consoleLevels) t.mock.method(console, level, () => {});
  const listeners = captureWindowListeners(t);
  const chromeObj = createScriptExecutingChrome();
  await ensureConsoleInterceptor(4, chromeObj);

  listeners.get('error')?.({
    message: 'Uncaught Error: thrown',
    filename: 'https://app.test/app.js',
    lineno: 1,
    colno: 40,
    error: errorWithStack('thrown', 'validate (https://app.test/app.js:1:40)'),
  });
  listeners.get('unhandledrejection')?.({
    reason: errorWithStack('rejected', 'async load (https://app.test/app.js:2:7)'),
  });
  listeners.get('unhandledrejection')?.({ reason: 'plain string reason' });
  console.error('wrapped', errorWithStack('logged', 'render (https://app.test/app.js:3:9)'));
  console.warn(errorWithStack('warned', 'https://app.test/app.js:4:1'));
  console.log(errorWithStack('log level keeps no stack', 'x (https://app.test/app.js:5:1)'));
  const hostile = {
    get stack(): string {
      throw new Error('page getter');
    },
  };
  listeners.get('error')?.({ message: 'hostile', error: hostile });
  listeners.get('unhandledrejection')?.({ reason: { stack: 42 } });

  const raw = getBuffer();
  assert.deepEqual(
    raw.map((entry) => [entry.level, typeof entry.stack]),
    [
      ['exception', 'string'],
      ['rejection', 'string'],
      ['rejection', 'undefined'],
      ['error', 'string'],
      ['warn', 'string'],
      ['log', 'undefined'],
      ['exception', 'undefined'],
      ['rejection', 'undefined'],
    ]
  );

  const { entries } = await readConsoleBuffer(4, false, chromeObj);
  assert.deepEqual(
    entries.map((entry) => entry.stack ?? null),
    [
      [{ function: 'validate', url: 'https://app.test/app.js', line: 1, column: 40 }],
      [{ function: 'load', url: 'https://app.test/app.js', line: 2, column: 7 }],
      null,
      [{ function: 'render', url: 'https://app.test/app.js', line: 3, column: 9 }],
      [{ url: 'https://app.test/app.js', line: 4, column: 1 }],
      null,
      null,
      null,
    ]
  );
  assert.deepEqual(entries[2].args, ['plain string reason']);
});

test('the interceptor bounds captured stack text in the page', async (t) => {
  clearInjectedConsoleState();
  t.after(clearInjectedConsoleState);
  for (const level of consoleLevels) t.mock.method(console, level, () => {});
  const listeners = captureWindowListeners(t);
  await ensureConsoleInterceptor(4, createScriptExecutingChrome());
  const frames = Array.from(
    { length: 10_000 },
    (_, index) => `f${index} (https://a.test/a.js:1:1)`
  );
  listeners.get('error')?.({ message: 'deep', error: errorWithStack('deep', ...frames) });
  const [entry] = getBuffer();
  assert.ok(entry.stack);
  assert.equal(entry.stack.length, 1_500);
});

test('readConsoleBuffer parses raw stacks and drops malformed page-supplied stacks', async (t) => {
  clearInjectedConsoleState();
  t.after(clearInjectedConsoleState);
  pageGlobal().__bb_console_buffer = [
    {
      level: 'exception',
      args: ['boom'],
      ts: 1,
      stack: 'Error: boom\n    at run (https://app.test/app.js?token=secret:1:2)',
    },
    { level: 'exception', args: ['forged'], ts: 2, stack: [{ url: 'http://192.168.1.1/x.js' }] },
    { level: 'exception', args: ['object'], ts: 3, stack: { url: 'x' } },
    { level: 'exception', args: ['number'], ts: 4, stack: 7 },
    { level: 'exception', args: ['garbage'], ts: 5, stack: 'no frames here' },
    {
      level: 'exception',
      args: ['long'],
      ts: 6,
      stack: `Error\n${'    at f (https://app.test/a.js:1:1)\n'.repeat(5_000)}`,
    },
  ] as unknown as ConsoleEntry[];
  const { entries } = await readConsoleBuffer(4, false, createScriptExecutingChrome());
  assert.deepEqual(entries[0].stack, [
    { function: 'run', url: 'https://app.test/app.js?token=%5Bredacted%5D', line: 1, column: 2 },
  ]);
  for (const entry of entries.slice(1, 5)) assert.equal('stack' in entry, false, entry.args[0]);
  assert.equal(entries[5].stack?.length, 8);
});

test('document_start stacks survive adoption into the interceptor buffer', async (t) => {
  clearInjectedConsoleState();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const level of consoleLevels) t.mock.method(console, level, () => {});
  const page = globalThis as unknown as Record<string, unknown>;
  t.after(() => {
    clearInjectedConsoleState();
    delete page.__bbx_console_early__;
  });
  const listeners = captureWindowListeners(t);
  new Function(await readFile(extensionFile('src/console-early.js'), 'utf8'))();
  listeners.get('error')?.({
    message: 'early failure',
    error: errorWithStack('early failure', 'boot (https://app.test/boot.js:1:5)'),
  });
  listeners.get('unhandledrejection')?.({
    reason: errorWithStack('early rejection', 'init (https://app.test/boot.js:2:3)'),
  });
  console.error(errorWithStack('early log', 'mount (https://app.test/boot.js:3:1)'));
  listeners.get('error')?.({
    message: 'hostile early',
    error: {
      get stack(): string {
        throw new Error('page getter');
      },
    },
  });

  const chromeObj = createScriptExecutingChrome();
  await ensureConsoleInterceptor(7, chromeObj);
  assert.equal(page.__bbx_console_early__, undefined);
  const { entries } = await readConsoleBuffer(7, false, chromeObj);
  assert.deepEqual(
    entries.map((entry) => [entry.level, entry.stack?.[0]?.function ?? null]),
    [
      ['exception', 'boot'],
      ['rejection', 'init'],
      ['error', 'mount'],
      ['exception', null],
    ]
  );
});
