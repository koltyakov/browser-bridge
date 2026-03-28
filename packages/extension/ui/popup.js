// @ts-check

/**
 * @typedef {{
 *   tabId: number,
 *   windowId: number,
 *   title: string,
 *   url: string,
 *   enabled: boolean,
 *   accessRequested: boolean
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
const accessEyebrow = /** @type {HTMLDivElement} */ (document.getElementById('popup-access-eyebrow'));
const accessDetail = /** @type {HTMLParagraphElement} */ (document.getElementById('popup-access-detail'));
const accessDisclosure = /** @type {HTMLParagraphElement} */ (document.getElementById('popup-disclosure'));
const controlCard = /** @type {HTMLElement | null} */ (document.querySelector('.popup-control-card'));
const port = chrome.runtime.connect({ name: 'ui-popup' });
const initialScopeTabId = readScopedTabId();
const windowedPopup = isWindowedPopup();
/** @type {PopupCurrentTab | null} */
let currentTabState = null;
/** @type {number | null} */
let resizeFrameId = null;

if (windowedPopup) {
  document.documentElement.dataset.windowed = 'true';
  document.body.dataset.windowed = 'true';
  window.addEventListener('load', queueWindowResize);
}

/** @param {PopupStateMessage} message */
port.onMessage.addListener((message) => {
  if (message.type === 'state.sync') {
    renderNativeStatus(message.state.nativeConnected);
    renderPopupState(message.state.currentTab);
  }
});

port.postMessage({
  type: 'state.request',
  ...(initialScopeTabId ? { scopeTabId: initialScopeTabId } : {})
});

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
    accessEyebrow.textContent = 'Window access unavailable';
    accessDetail.textContent = 'Open a normal web page to manage Browser Bridge for this Chrome window.';
    accessDisclosure.hidden = false;
    button.textContent = 'Enable Window Access';
    button.disabled = true;
    controlCard?.classList.remove('attention');
    return;
  }

  accessDisclosure.hidden = currentTab.enabled;

  if (currentTab.enabled) {
    accessEyebrow.textContent = 'Window access enabled';
    accessDetail.textContent = 'Your connected agent can inspect and interact with pages in this Chrome window.';
  } else if (currentTab.accessRequested) {
    accessEyebrow.textContent = 'Window access requested';
    accessDetail.textContent = 'An agent requested access for this Chrome window. Enable it to allow page inspection and interaction.';
  } else {
    accessEyebrow.textContent = 'Window access';
    accessDetail.textContent = 'Enable Browser Bridge to let your connected agent inspect and interact with pages in this Chrome window.';
  }

  button.textContent = currentTab.enabled ? 'Disable Window Access' : 'Enable Window Access';
  button.disabled = !currentTab.url;
  controlCard?.classList.toggle('attention', currentTab.accessRequested && !currentTab.enabled);
  queueWindowResize();
}

/**
 * @param {boolean} connected
 * @returns {void}
 */
function renderNativeStatus(connected) {
  if (!nativeIndicator) return;
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
  const scopedTabId = currentTabState?.tabId ?? initialScopeTabId;
  port.postMessage({
    type: 'scope.set_enabled',
    enabled,
    ...(scopedTabId ? { tabId: scopedTabId } : {})
  });
}

/**
 * @returns {number | null}
 */
function readScopedTabId() {
  const value = new URLSearchParams(window.location.search).get('tabId');
  const tabId = Number(value);
  return Number.isFinite(tabId) && tabId > 0 ? tabId : null;
}

/**
 * @returns {boolean}
 */
function isWindowedPopup() {
  return new URLSearchParams(window.location.search).get('windowed') === '1';
}

/**
 * @returns {void}
 */
function queueWindowResize() {
  if (!windowedPopup || resizeFrameId != null) {
    return;
  }
  resizeFrameId = window.requestAnimationFrame(() => {
    resizeFrameId = null;
    void resizeWindowToContent();
  });
}

/**
 * @returns {Promise<void>}
 */
async function resizeWindowToContent() {
  if (!windowedPopup) {
    return;
  }

  const panel = /** @type {HTMLElement | null} */ (document.querySelector('.panel-popup'));
  const panelRect = panel?.getBoundingClientRect();
  const contentWidth = Math.ceil(panelRect?.width ?? document.body.getBoundingClientRect().width);
  const contentHeight = Math.ceil(panelRect?.height ?? document.body.getBoundingClientRect().height);
  const frameWidth = Math.max(window.outerWidth - window.innerWidth, 0);
  const frameHeight = Math.max(window.outerHeight - window.innerHeight, 0);
  const targetWidth = Math.min(Math.max(contentWidth + frameWidth + 2, 420), 560);
  const targetHeight = Math.min(Math.max(contentHeight + frameHeight + 2, 180), 520);
  const currentWindow = await chrome.windows.getCurrent();
  if (currentWindow.id == null) {
    return;
  }

  /** @type {chrome.windows.UpdateInfo} */
  const updateInfo = {
    width: targetWidth,
    height: targetHeight
  };

  if (typeof currentWindow.left === 'number' && typeof currentWindow.width === 'number') {
    updateInfo.left = currentWindow.left + currentWindow.width - targetWidth;
  }

  await chrome.windows.update(currentWindow.id, updateInfo);
}
