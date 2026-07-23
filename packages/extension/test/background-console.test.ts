import test from 'node:test';
import assert from 'node:assert/strict';

import { ERROR_CODES } from '../../protocol/src/index.js';
import {
  disableConsoleInterceptor,
  ensureConsoleInterceptor,
  isRecoverableInstrumentationError,
  primeTabConsoleCapture,
  primeWindowConsoleCapture,
  readConsoleBuffer,
} from '../src/background-console.js';

type ConsoleEntry = { level: string; args: string[]; ts: number };
type ExecuteScriptConfig = {
  target?: { tabId?: number };
  world?: string;
  func?: (...args: unknown[]) => unknown;
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
  onExecute?: (config: ExecuteScriptConfig) => ExecuteScriptResult | Promise<ExecuteScriptResult>
): ConsoleChrome {
  return {
    scripting: {
      async executeScript(config: ExecuteScriptConfig) {
        if (onExecute) {
          return onExecute(config);
        }
        return [{ result: config.func?.(...(config.args ?? [])) }];
      },
    },
    tabs: {
      async query() {
        return [];
      },
    },
  };
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
    return [{ result: config.func?.(...(config.args ?? [])) }];
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
    return [{ result: config.func?.(...(config.args ?? [])) }];
  });

  assert.deepEqual(await readConsoleBuffer(8, false, chromeObj), {
    entries: [entry],
    dropped: 2,
  });
  assert.strictEqual(pageGlobal().__bb_console_buffer, pageBuffer);
  assert.deepEqual(pageGlobal().__bb_console_buffer, [entry]);

  assert.deepEqual(await readConsoleBuffer(8, true, chromeObj), {
    entries: [entry],
    dropped: 2,
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
