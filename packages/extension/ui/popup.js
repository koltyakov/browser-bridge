// @ts-check

/**
 * @typedef {{
 *   tabId: number,
 *   windowId: number,
 *   title: string,
 *   url: string,
 *   enabled: boolean
 * }} PopupCurrentTab
 */

/**
 * @typedef {{
 *   type: 'state.sync',
 *   state: {
 *     nativeConnected: boolean,
 *     currentTab: PopupCurrentTab | null
 *   }
 * }} PopupStateMessage
 */

const nativeIndicator = /** @type {HTMLSpanElement} */ (document.getElementById('native-indicator'));
const button = /** @type {HTMLButtonElement} */ (document.getElementById('communication-action'));
const port = chrome.runtime.connect({ name: 'ui' });
/** @type {PopupCurrentTab | null} */
let currentTabState = null;

/** @param {PopupStateMessage} message */
port.onMessage.addListener((message) => {
  if (message.type === 'state.sync') {
    renderNativeStatus(message.state.nativeConnected);
    renderPopupState(message.state.currentTab);
  }
});

port.postMessage({ type: 'state.request' });

button.addEventListener('click', () => {
  if (!currentTabState) {
    return;
  }
  setCommunicationEnabled(!currentTabState.enabled);
  window.close();
});

/**
 * @param {PopupCurrentTab | null} currentTab
 * @returns {void}
 */
function renderPopupState(currentTab) {
  currentTabState = currentTab;

  if (!currentTab) {
    button.textContent = 'Enable';
    button.disabled = true;
    return;
  }

  button.textContent = currentTab.enabled ? 'Disable' : 'Enable';
  button.disabled = !currentTab.url;
}

/**
 * @param {boolean} connected
 * @returns {void}
 */
function renderNativeStatus(connected) {
  const label = connected
    ? 'Native host connected'
    : 'Native host disconnected';
  nativeIndicator.dataset.connected = String(connected);
  nativeIndicator.title = label;
  nativeIndicator.setAttribute('aria-label', label);
}

/**
 * @param {boolean} enabled
 * @returns {void}
 */
function setCommunicationEnabled(enabled) {
  port.postMessage({
    type: 'scope.set_enabled',
    enabled
  });
}
