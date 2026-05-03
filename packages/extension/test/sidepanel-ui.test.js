// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createChromeFake } from '../../../tests/_helpers/chromeFake.js';
import { withDocument } from '../../../tests/_helpers/dom.js';
import { createMessagePortPair } from '../../../tests/_helpers/messagePort.js';

const MISSING = Symbol('missing');
const SIDEPANEL_HTML_URL = new URL('../ui/sidepanel.html', import.meta.url);
const SIDEPANEL_SCRIPT_URL = new URL('../ui/sidepanel.js', import.meta.url);

/**
 * @returns {Promise<void>}
 */
async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * @returns {Promise<void>}
 */
async function importFreshSidepanelScript() {
  await import(`${SIDEPANEL_SCRIPT_URL.href}?case=${Date.now()}-${Math.random()}`);
}

/**
 * @param {string} key
 * @param {unknown} savedValue
 * @returns {void}
 */
function restoreGlobal(key, savedValue) {
  if (savedValue === MISSING) {
    Reflect.deleteProperty(globalThis, key);
    return;
  }

  Reflect.set(globalThis, key, savedValue);
}

/**
 * @param {boolean} enabled
 * @returns {{
 *   type: 'state.sync',
 *   state: {
 *     nativeConnected: true,
 *     currentTab: {
 *       tabId: number,
 *       windowId: number,
 *       title: string,
 *       url: string,
 *       enabled: boolean,
 *       accessRequested: false,
 *       restricted: false
 *     },
 *     setupStatus: null,
 *     setupStatusPending: false,
 *     setupStatusError: null,
 *     setupInstallPendingKey: null,
 *     setupInstallError: null,
 *     actionLog: []
 *   }
 * }}
 */
function createSidepanelStateSync(enabled) {
  return {
    type: 'state.sync',
    state: {
      nativeConnected: true,
      currentTab: {
        tabId: 41,
        windowId: 7,
        title: 'Example page',
        url: 'https://example.com/',
        enabled,
        accessRequested: false,
        restricted: false,
      },
      setupStatus: null,
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

  /** @type {Array<{ delay: number | undefined }>} */
  const intervalCalls = [];
  const portPair = createMessagePortPair();

  Reflect.set(
    globalThis,
    'setInterval',
    /** @type {typeof setInterval} */ (
      /** @type {unknown} */ (
        /** @param {TimerHandler} callback @param {number | undefined} delay */
        (callback, delay) => {
          intervalCalls.push({ delay });
          void callback;
          return /** @type {ReturnType<typeof setInterval>} */ (
            /** @type {unknown} */ ({
              id: 'sidepanel-interval',
            })
          );
        }
      )
    )
  );
  Reflect.set(globalThis, 'clearInterval', /** @type {typeof clearInterval} */ (() => {}));
  Reflect.set(
    globalThis,
    'chrome',
    /** @type {any} */ (
      createChromeFake({
        runtime: {
          /** @param {chrome.runtime.ConnectInfo} connectInfo */
          connect(connectInfo) {
            assert.deepEqual(connectInfo, { name: 'ui-sidepanel' });
            return /** @type {any} */ (portPair.left.port);
          },
        },
      })
    )
  );

  await withDocument(sidepanelHtml, async ({ window }) => {
    Reflect.set(window, 'location', new URL('https://example.com/sidepanel.html'));
    await importFreshSidepanelScript();
    await flushMicrotasks();

    assert.deepEqual(intervalCalls, [{ delay: 5_000 }]);
    assert.deepEqual(portPair.left.postedMessages, [{ type: 'state.request' }]);
    assert.equal(portPair.left.onMessageListeners.length, 1);

    const button = /** @type {HTMLButtonElement | null} */ (
      document.getElementById('bridge-toggle')
    );
    assert.ok(button, 'sidepanel toggle button should be present');

    portPair.left.dispatchMessage(createSidepanelStateSync(false));
    assert.equal(button.textContent, 'Enable Window Access');
    assert.equal(button.disabled, false);

    portPair.left.dispatchMessage(createSidepanelStateSync(true));
    assert.equal(button.textContent, 'Disable Window Access');
    assert.equal(button.disabled, false);
  });
});
