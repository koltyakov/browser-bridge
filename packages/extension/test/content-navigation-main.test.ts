import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installIsolatedNavigationSignals,
  installMainActivitySignals,
  installMainNavigationSignals,
  uninstallIsolatedNavigationSignals,
  uninstallMainActivitySignals,
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

test('MAIN-world activity hooks count fetch and XHR requests and restore the originals', async () => {
  const savedWindow = globalThis.window;
  const savedXhr = globalThis.XMLHttpRequest;
  const sent: unknown[] = [];
  class FakeXhr extends EventTarget {
    send(body?: unknown) {
      sent.push(body);
    }
  }
  const originalSend = FakeXhr.prototype.send;
  let releaseFetch = () => {};
  const originalFetch = (_input?: unknown) =>
    new Promise<Response>((resolve) => {
      releaseFetch = () => resolve(new Response('ok'));
    });
  const target = Object.assign(new EventTarget(), { fetch: originalFetch });
  Reflect.set(globalThis, 'window', target);
  Reflect.set(globalThis, 'XMLHttpRequest', FakeXhr);
  const events: string[] = [];
  try {
    for (const kind of ['start', 'end', 'pong']) {
      target.addEventListener(`bbx:activity:ch:${kind}`, () => events.push(kind));
    }
    installMainActivitySignals('ch');
    installMainActivitySignals('ch');
    target.dispatchEvent(new Event('bbx:activity:ch:ping'));
    assert.deepEqual(events, ['pong'], 'reinstalling keeps one hook');

    const response = target.fetch('/api');
    assert.deepEqual(events, ['pong', 'start']);
    releaseFetch();
    assert.equal(await (await response).text(), 'ok');
    await Promise.resolve();
    assert.deepEqual(events, ['pong', 'start', 'end']);

    const xhr = new FakeXhr();
    xhr.send('body');
    assert.deepEqual(sent, ['body']);
    xhr.dispatchEvent(new Event('loadend'));
    xhr.dispatchEvent(new Event('loadend'));
    assert.deepEqual(events, ['pong', 'start', 'end', 'start', 'end']);

    uninstallMainActivitySignals('ch');
    assert.equal(target.fetch, originalFetch);
    assert.equal(FakeXhr.prototype.send, originalSend);
    target.dispatchEvent(new Event('bbx:activity:ch:ping'));
    assert.equal(events.filter((event) => event === 'pong').length, 1);
  } finally {
    Reflect.set(globalThis, 'window', savedWindow);
    Reflect.set(globalThis, 'XMLHttpRequest', savedXhr);
  }
});
