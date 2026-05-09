import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createChromeFake } from '../../../tests/_helpers/chromeFake.ts';
import { withDocument } from '../../../tests/_helpers/dom.ts';
import { createMessagePortPair } from '../../../tests/_helpers/messagePort.ts';
import type { SetupStatus } from '../../protocol/src/types.js';

const MISSING = Symbol('missing');
const SIDEPANEL_HTML_URL = new URL('../ui/sidepanel.html', import.meta.url);
const SIDEPANEL_SCRIPT_URL = new URL('../ui/sidepanel.js', import.meta.url);

type SidepanelStateSync = {
  type: 'state.sync';
  state: {
    nativeConnected: true;
    nativeHostVersion: string | null;
    currentTab: {
      tabId: number;
      windowId: number;
      title: string;
      url: string;
      enabled: boolean;
      accessRequested: false;
      restricted: false;
    };
    setupStatus: SetupStatus | null;
    setupStatusPending: false;
    setupStatusError: null;
    setupInstallPendingKey: null;
    setupInstallError: null;
    actionLog: [];
  };
};

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function importFreshSidepanelScript(): Promise<void> {
  await import(`${SIDEPANEL_SCRIPT_URL.href}?case=${Date.now()}-${Math.random()}`);
}

function restoreGlobal(key: string, savedValue: unknown): void {
  if (savedValue === MISSING) {
    Reflect.deleteProperty(globalThis, key);
    return;
  }

  Reflect.set(globalThis, key, savedValue);
}

function createSidepanelStateSync(
  enabled: boolean,
  setupStatus: SetupStatus | null = null,
  nativeHostVersion: string | null = null
): SidepanelStateSync {
  return {
    type: 'state.sync',
    state: {
      nativeConnected: true,
      nativeHostVersion,
      currentTab: {
        tabId: 41,
        windowId: 7,
        title: 'Example page',
        url: 'https://example.com/',
        enabled,
        accessRequested: false,
        restricted: false,
      },
      setupStatus,
      setupStatusPending: false,
      setupStatusError: null,
      setupInstallPendingKey: null,
      setupInstallError: null,
      actionLog: [],
    },
  };
}

test('sidepanel UI smoke test flips the action label between enable and disable states', async (t) => {
  const sidepanelHtml = await readFile(SIDEPANEL_HTML_URL, 'utf8');
  const savedChrome = Object.prototype.hasOwnProperty.call(globalThis, 'chrome')
    ? globalThis.chrome
    : MISSING;
  const savedSetInterval = globalThis.setInterval;
  const savedClearInterval = globalThis.clearInterval;
  t.after(() => {
    restoreGlobal('chrome', savedChrome);
    restoreGlobal('setInterval', savedSetInterval);
    restoreGlobal('clearInterval', savedClearInterval);
  });

  const intervalCalls: Array<{ delay: number | undefined }> = [];
  const portPair = createMessagePortPair();

  Reflect.set(globalThis, 'setInterval', ((callback: TimerHandler, delay?: number) => {
    intervalCalls.push({ delay });
    void callback;
    return { id: 'sidepanel-interval' } as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval);
  Reflect.set(globalThis, 'clearInterval', (() => {}) as typeof clearInterval);
  Reflect.set(
    globalThis,
    'chrome',
    createChromeFake({
      runtime: {
        connect(connectInfo: chrome.runtime.ConnectInfo) {
          assert.deepEqual(connectInfo, { name: 'ui-sidepanel' });
          return portPair.left.port as unknown as chrome.runtime.Port;
        },
      },
    })
  );

  await withDocument(sidepanelHtml, async ({ window }) => {
    Reflect.set(window, 'location', new URL('https://example.com/sidepanel.html'));
    await importFreshSidepanelScript();
    await flushMicrotasks();

    assert.deepEqual(intervalCalls, [{ delay: 5_000 }]);
    assert.deepEqual(portPair.left.postedMessages, [{ type: 'state.request' }]);
    assert.equal(portPair.left.onMessageListeners.length, 1);

    const button = document.getElementById('bridge-toggle') as HTMLButtonElement | null;
    assert.ok(button, 'sidepanel toggle button should be present');

    portPair.left.dispatchMessage(createSidepanelStateSync(false));
    assert.equal(button.textContent, 'Enable Window Access');
    assert.equal(button.disabled, false);

    portPair.left.dispatchMessage(createSidepanelStateSync(true));
    assert.equal(button.textContent, 'Disable Window Access');
    assert.equal(button.disabled, false);
  });
});

test('sidepanel UI shows the global host CLI and daemon version', async (t) => {
  const sidepanelHtml = await readFile(SIDEPANEL_HTML_URL, 'utf8');
  const savedChrome = Object.prototype.hasOwnProperty.call(globalThis, 'chrome')
    ? globalThis.chrome
    : MISSING;
  const savedSetInterval = globalThis.setInterval;
  const savedClearInterval = globalThis.clearInterval;
  t.after(() => {
    restoreGlobal('chrome', savedChrome);
    restoreGlobal('setInterval', savedSetInterval);
    restoreGlobal('clearInterval', savedClearInterval);
  });

  const portPair = createMessagePortPair();

  Reflect.set(globalThis, 'setInterval', (() => {
    return { id: 'sidepanel-version-interval' } as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval);
  Reflect.set(globalThis, 'clearInterval', (() => {}) as typeof clearInterval);
  Reflect.set(
    globalThis,
    'chrome',
    createChromeFake({
      runtime: {
        connect(connectInfo: chrome.runtime.ConnectInfo) {
          assert.deepEqual(connectInfo, { name: 'ui-sidepanel' });
          return portPair.left.port as unknown as chrome.runtime.Port;
        },
      },
    })
  );

  await withDocument(sidepanelHtml, async ({ window }) => {
    Reflect.set(window, 'location', new URL('https://example.com/sidepanel.html'));
    await importFreshSidepanelScript();
    await flushMicrotasks();

    portPair.left.dispatchMessage(createSidepanelStateSync(true, null, '1.2.0'));

    const hostVersion = document.getElementById('setup-host-version');
    assert.ok(hostVersion instanceof HTMLElement);
    assert.equal(hostVersion.textContent, 'Daemon version: v1.2.0');
    assert.equal(hostVersion.hidden, false);
  });
});
