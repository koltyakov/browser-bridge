import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createChromeFake } from '../../../tests/_helpers/chromeFake.ts';
import { withDocument } from '../../../tests/_helpers/dom.ts';
import { createMessagePortPair } from '../../../tests/_helpers/messagePort.ts';

const MISSING = Symbol('missing');
const POPUP_HTML_URL = new URL('../ui/popup.html', import.meta.url);
const POPUP_SCRIPT_URL = new URL('../ui/popup.js', import.meta.url);

type PopupStateSync = {
  type: 'state.sync';
  state: {
    nativeConnected: boolean;
    currentTab: {
      tabId: number;
      windowId: number;
      title: string;
      url: string;
      enabled: boolean;
      accessRequested: false;
      restricted: false;
    };
  };
};
type TimeoutCall = {
  callback: () => void;
  delay: number | undefined;
};

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function importFreshPopupScript(): Promise<void> {
  await import(`${POPUP_SCRIPT_URL.href}?case=${Date.now()}-${Math.random()}`);
}

function restoreChrome(savedChrome: unknown): void {
  if (savedChrome === MISSING) {
    Reflect.deleteProperty(globalThis, 'chrome');
    return;
  }

  Reflect.set(globalThis, 'chrome', savedChrome);
}

function createPopupStateSync(enabled: boolean, nativeConnected = true): PopupStateSync {
  return {
    type: 'state.sync',
    state: {
      nativeConnected,
      currentTab: {
        tabId: 41,
        windowId: 7,
        title: 'Example page',
        url: 'https://example.com/',
        enabled,
        accessRequested: false,
        restricted: false,
      },
    },
  };
}

test('popup UI smoke test flips the action label between enable and disable states', async (t) => {
  const popupHtml = await readFile(POPUP_HTML_URL, 'utf8');
  const savedChrome = Object.prototype.hasOwnProperty.call(globalThis, 'chrome')
    ? globalThis.chrome
    : MISSING;
  t.after(() => restoreChrome(savedChrome));

  const portPair = createMessagePortPair();

  Reflect.set(
    globalThis,
    'chrome',
    createChromeFake({
      tabs: {
        async query() {
          return [{ id: 41 } as chrome.tabs.Tab];
        },
      },
      runtime: {
        id: 'test-extension-id',
        connect(connectInfo: chrome.runtime.ConnectInfo) {
          assert.deepEqual(connectInfo, { name: 'ui-popup' });
          return portPair.left.port as unknown as chrome.runtime.Port;
        },
      },
    })
  );

  await withDocument(popupHtml, async ({ window }) => {
    Reflect.set(window, 'location', new URL('https://example.com/popup.html?tabId=41'));
    await importFreshPopupScript();
    await flushMicrotasks();

    assert.deepEqual(portPair.left.postedMessages, [{ type: 'state.request', scopeTabId: 41 }]);
    assert.equal(portPair.left.onMessageListeners.length, 1);

    const button = document.getElementById('communication-action') as HTMLButtonElement | null;
    assert.ok(button, 'popup action button should be present');

    portPair.left.dispatchMessage(createPopupStateSync(false));
    assert.equal(button.textContent, 'Enable Window Access');
    assert.equal(button.disabled, false);

    portPair.left.dispatchMessage(createPopupStateSync(true));
    assert.equal(button.textContent, 'Disable Window Access');
    assert.equal(button.disabled, false);
  });
});

test('popup UI handles windowed diagnostics, toggles, and resize', async (t) => {
  const popupHtml = await readFile(POPUP_HTML_URL, 'utf8');
  const savedChrome = Object.prototype.hasOwnProperty.call(globalThis, 'chrome')
    ? globalThis.chrome
    : MISSING;
  const savedSetTimeout = globalThis.setTimeout;
  const savedClearTimeout = globalThis.clearTimeout;
  t.after(() => {
    restoreChrome(savedChrome);
    Reflect.set(globalThis, 'setTimeout', savedSetTimeout);
    Reflect.set(globalThis, 'clearTimeout', savedClearTimeout);
  });

  const timeoutCalls: TimeoutCall[] = [];
  const clearedTimers: unknown[] = [];
  const windowUpdates: Array<{ windowId: number; updateInfo: chrome.windows.UpdateInfo }> = [];
  const portPair = createMessagePortPair();

  Reflect.set(globalThis, 'setTimeout', ((callback: TimerHandler, delay?: number) => {
    const call = {
      callback: () => {
        if (typeof callback === 'function') {
          callback();
        }
      },
      delay,
    };
    timeoutCalls.push(call);
    return call as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
  Reflect.set(globalThis, 'clearTimeout', ((timer: unknown) => {
    clearedTimers.push(timer);
  }) as typeof clearTimeout);
  Reflect.set(
    globalThis,
    'chrome',
    createChromeFake({
      tabs: {
        async query() {
          return [{ id: 41 } as chrome.tabs.Tab];
        },
      },
      runtime: {
        id: 'test-extension-id',
        connect(connectInfo: chrome.runtime.ConnectInfo) {
          assert.deepEqual(connectInfo, { name: 'ui-popup' });
          return portPair.left.port as unknown as chrome.runtime.Port;
        },
      },
      windows: {
        async getCurrent() {
          return { id: 5, left: 100, width: 900 } as chrome.windows.Window;
        },
        async update(windowId: number, updateInfo: chrome.windows.UpdateInfo) {
          windowUpdates.push({ windowId, updateInfo });
          return { id: windowId, ...updateInfo } as chrome.windows.Window;
        },
      },
    })
  );

  await withDocument(popupHtml, async ({ window }) => {
    Reflect.set(window, 'location', new URL('https://example.com/popup.html?tabId=41&windowed=1'));
    Reflect.set(window, 'outerWidth', 460);
    Reflect.set(window, 'innerWidth', 420);
    Reflect.set(window, 'outerHeight', 260);
    Reflect.set(window, 'innerHeight', 220);
    Reflect.set(window, 'requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const panel = document.querySelector('.panel-popup') as HTMLElement | null;
    assert.ok(panel);
    Reflect.set(panel, 'getBoundingClientRect', () => ({ width: 430, height: 280 }));

    await importFreshPopupScript();
    await flushMicrotasks();

    assert.equal(document.documentElement.dataset.windowed, 'true');
    assert.equal(document.body.dataset.windowed, 'true');
    assert.deepEqual(portPair.left.postedMessages, [{ type: 'state.request', scopeTabId: 41 }]);

    const button = document.getElementById('communication-action') as HTMLButtonElement | null;
    assert.ok(button);

    portPair.left.dispatchMessage(createPopupStateSync(false, false));
    await flushMicrotasks();
    assert.equal(timeoutCalls[0].delay, 10_000);
    timeoutCalls[0].callback();

    const diagnostic = document.getElementById('native-diagnostic');
    assert.ok(diagnostic);
    assert.match(diagnostic.textContent ?? '', /Native host unreachable/);
    assert.match(diagnostic.textContent ?? '', /bbx install test-extension-id/);
    assert.equal(diagnostic.hidden, false);

    button.click();
    assert.equal(button.dataset.pending, 'true');
    assert.equal(button.textContent, 'Enabling…');
    assert.deepEqual(portPair.left.postedMessages.at(-1), {
      type: 'scope.set_enabled',
      enabled: true,
      tabId: 41,
    });
    assert.equal(timeoutCalls.at(-1)?.delay, 10_000);
    timeoutCalls.at(-1)?.callback();
    assert.equal(button.dataset.pending, 'false');
    assert.equal(button.textContent, 'Enable Window Access');

    portPair.left.dispatchMessage(createPopupStateSync(true, true));
    assert.equal(diagnostic.hidden, true);
    assert.equal(clearedTimers.length >= 1, true);
    await flushMicrotasks();

    assert.equal(windowUpdates.length > 0, true);
    assert.deepEqual(windowUpdates.at(-1), {
      windowId: 5,
      updateInfo: {
        width: 472,
        height: 322,
        left: 528,
      },
    });
  });
});
