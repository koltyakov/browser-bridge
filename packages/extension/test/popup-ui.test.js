// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createChromeFake } from '../../../tests/_helpers/chromeFake.js';
import { withDocument } from '../../../tests/_helpers/dom.js';
import { createMessagePortPair } from '../../../tests/_helpers/messagePort.js';

const MISSING = Symbol('missing');
const POPUP_HTML_URL = new URL('../ui/popup.html', import.meta.url);
const POPUP_SCRIPT_URL = new URL('../ui/popup.js', import.meta.url);

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
async function importFreshPopupScript() {
  await import(`${POPUP_SCRIPT_URL.href}?case=${Date.now()}-${Math.random()}`);
}

/**
 * @param {unknown} savedChrome
 * @returns {void}
 */
function restoreChrome(savedChrome) {
  if (savedChrome === MISSING) {
    Reflect.deleteProperty(globalThis, 'chrome');
    return;
  }

  Reflect.set(globalThis, 'chrome', savedChrome);
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
 *     }
 *   }
 * }}
 */
function createPopupStateSync(enabled) {
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
    /** @type {any} */ (
      createChromeFake({
        tabs: {
          async query() {
            return [/** @type {chrome.tabs.Tab} */ ({ id: 41 })];
          },
        },
        runtime: {
          id: 'test-extension-id',
          /** @param {chrome.runtime.ConnectInfo} connectInfo */
          connect(connectInfo) {
            assert.deepEqual(connectInfo, { name: 'ui-popup' });
            return /** @type {any} */ (portPair.left.port);
          },
        },
      })
    )
  );

  await withDocument(popupHtml, async ({ window }) => {
    Reflect.set(window, 'location', new URL('https://example.com/popup.html?tabId=41'));
    await importFreshPopupScript();
    await flushMicrotasks();

    assert.deepEqual(portPair.left.postedMessages, [{ type: 'state.request', scopeTabId: 41 }]);
    assert.equal(portPair.left.onMessageListeners.length, 1);

    const button = /** @type {HTMLButtonElement | null} */ (
      document.getElementById('communication-action')
    );
    assert.ok(button, 'popup action button should be present');

    portPair.left.dispatchMessage(createPopupStateSync(false));
    assert.equal(button.textContent, 'Enable Window Access');
    assert.equal(button.disabled, false);

    portPair.left.dispatchMessage(createPopupStateSync(true));
    assert.equal(button.textContent, 'Disable Window Access');
    assert.equal(button.disabled, false);
  });
});
