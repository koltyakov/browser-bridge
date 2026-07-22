import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installIsolatedNavigationSignals,
  installMainNavigationSignals,
  uninstallIsolatedNavigationSignals,
  uninstallMainNavigationSignals,
} from '../src/background-content-script.js';

test('isolated navigation listeners are idempotent and uninstallable', async () => {
  const savedWindow = globalThis.window;
  const savedChrome = globalThis.chrome;
  const target = new EventTarget();
  const messages: unknown[] = [];
  Reflect.set(globalThis, 'window', target);
  Reflect.set(globalThis, 'chrome', {
    runtime: {
      async sendMessage(message: unknown) {
        messages.push(message);
      },
    },
  });
  try {
    installIsolatedNavigationSignals('isolated');
    installIsolatedNavigationSignals('isolated');
    target.dispatchEvent(new Event('bbx:navigation:isolated:pushState'));
    await Promise.resolve();
    assert.deepEqual(messages, [
      { type: 'bridge.navigation-signal', channel: 'isolated', kind: 'pushState' },
    ]);

    uninstallIsolatedNavigationSignals('isolated');
    target.dispatchEvent(new Event('bbx:navigation:isolated:pushState'));
    await Promise.resolve();
    assert.equal(messages.length, 1);
  } finally {
    Reflect.set(globalThis, 'window', savedWindow);
    Reflect.set(globalThis, 'chrome', savedChrome);
  }
});

test('MAIN-world navigation hooks are idempotent, reversible, and use no page marker', () => {
  const savedWindow = globalThis.window;
  const savedHistory = globalThis.history;
  const target = new EventTarget();
  const calls: string[] = [];
  const signals: string[] = [];
  const originalPushState = () => calls.push('pushState');
  const originalReplaceState = () => calls.push('replaceState');
  const historyMock = { pushState: originalPushState, replaceState: originalReplaceState };
  Reflect.set(globalThis, 'window', target);
  Reflect.set(globalThis, 'history', historyMock);
  try {
    for (const kind of ['pushState', 'replaceState', 'popstate', 'hashchange']) {
      target.addEventListener(`bbx:navigation:random:${kind}`, () => signals.push(kind));
    }
    installMainNavigationSignals('random');
    installMainNavigationSignals('random');

    historyMock.pushState();
    historyMock.replaceState();
    target.dispatchEvent(new Event('popstate'));
    target.dispatchEvent(new Event('hashchange'));

    assert.deepEqual(calls, ['pushState', 'replaceState']);
    assert.deepEqual(signals, ['pushState', 'replaceState', 'popstate', 'hashchange']);
    assert.equal(
      Object.keys(target).some((key) => key.includes('BBX')),
      false
    );

    uninstallMainNavigationSignals('random');
    assert.equal(historyMock.pushState, originalPushState);
    assert.equal(historyMock.replaceState, originalReplaceState);
    target.dispatchEvent(new Event('popstate'));
    assert.equal(signals.length, 4);
  } finally {
    Reflect.set(globalThis, 'window', savedWindow);
    Reflect.set(globalThis, 'history', savedHistory);
  }
});

test('MAIN-world installation rolls back a partial history hook failure', () => {
  const savedWindow = globalThis.window;
  const savedHistory = globalThis.history;
  const target = new EventTarget();
  const originalPushState = () => {};
  const originalReplaceState = () => {};
  const historyMock = { pushState: originalPushState } as {
    pushState: typeof originalPushState;
    replaceState: typeof originalReplaceState;
  };
  Object.defineProperty(historyMock, 'replaceState', {
    configurable: true,
    get: () => originalReplaceState,
    set: () => {
      throw new Error('replaceState locked');
    },
  });
  Reflect.set(globalThis, 'window', target);
  Reflect.set(globalThis, 'history', historyMock);
  try {
    assert.throws(() => installMainNavigationSignals('partial'), /replaceState locked/);
    assert.equal(historyMock.pushState, originalPushState);
  } finally {
    Reflect.set(globalThis, 'window', savedWindow);
    Reflect.set(globalThis, 'history', savedHistory);
  }
});
