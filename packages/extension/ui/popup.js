// @ts-check

/**
 * @typedef {{
 *   tabId: number,
 *   windowId: number,
 *   title: string,
 *   url: string,
 *   enabled: boolean,
 *   accessRequested: boolean,
 *   restricted: boolean
 * }} PopupCurrentTab
 */

/**
 * @typedef {{
 *   type: 'state.sync',
 *   state: {
 *     nativeConnected: boolean,
 *     currentTab: PopupCurrentTab | null
 *   }
 * } | {
 *   type: 'toggle.error',
 *   error: string
 * }} PopupMessage
 */

const nativeIndicator =
  /** @type {HTMLSpanElement} */ (document.getElementById('native-indicator'));
const button = /** @type {HTMLButtonElement} */ (document.getElementById('communication-action'));
const accessEyebrow = /** @type {HTMLDivElement} */ (
  document.getElementById('popup-access-eyebrow')
);
const accessDetail = /** @type {HTMLParagraphElement} */ (
  document.getElementById('popup-access-detail')
);
const accessDisclosure =
  /** @type {HTMLParagraphElement} */ (document.getElementById('popup-disclosure'));
const controlCard = /** @type {HTMLElement | null} */ (
  document.querySelector('.popup-control-card')
);
const windowedPopup = isWindowedPopup();
const toggleErrorEl = document.createElement('p');
toggleErrorEl.className = 'toggle-error';
toggleErrorEl.hidden = true;
button.insertAdjacentElement('afterend', toggleErrorEl);
/** @type {number | null} */
let popupScopeTabId = null;
/** @type {boolean | null} */
let pendingEnabledState = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let pendingToggleTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let toggleErrorTimer = null;
const TOGGLE_PENDING_TIMEOUT_MS = 10_000;
const TOGGLE_ERROR_DISPLAY_MS = 6_000;

/** @param {PopupMessage} message */
function handlePopupMessage(message) {
  if (message.type === 'state.sync') {
    renderNativeStatus(message.state.nativeConnected);
    renderPopupState(message.state.currentTab);
    if (
      pendingEnabledState != null &&
      message.state.currentTab &&
      message.state.currentTab.enabled === pendingEnabledState
    ) {
      resetPendingToggle();
      if (windowedPopup) {
        window.close();
      }
    }
  }

  if (message.type === 'toggle.error') {
    renderToggleError(message.error);
  }
}

/** @type {chrome.runtime.Port} */
let port;

/**
 * @returns {Promise<number | null>}
 */
async function resolveInitialScopeTabId() {
  const explicitScopeTabId = readScopedTabId();
  if (explicitScopeTabId) {
    return explicitScopeTabId;
  }

  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return typeof activeTab?.id === 'number' ? activeTab.id : null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<void>}
 */
async function connectPopupPort() {
  popupScopeTabId = await resolveInitialScopeTabId();
  const nextPort = chrome.runtime.connect({ name: 'ui-popup' });
  nextPort.onMessage.addListener(handlePopupMessage);
  nextPort.postMessage({
    type: 'state.request',
    ...(popupScopeTabId ? { scopeTabId: popupScopeTabId } : {}),
  });
  port = nextPort;
}

void connectPopupPort();
/** @type {PopupCurrentTab | null} */
let currentTabState = null;
/** @type {number | null} */
let resizeFrameId = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let nativeDiagnosticTimer = null;
const NATIVE_DIAGNOSTIC_DELAY_MS = 10_000;
const PUBLISHED_EXTENSION_ID = 'jjjkmmcdkpcgamlopogicbnnhdgebhie';

if (windowedPopup) {
  document.documentElement.dataset.windowed = 'true';
  document.body.dataset.windowed = 'true';
  window.addEventListener('load', queueWindowResize);
}

button.addEventListener('click', () => {
  if (!currentTabState || button.dataset.pending === 'true') {
    return;
  }
  const pendingEnabled = !currentTabState.enabled;
  pendingEnabledState = pendingEnabled;
  button.dataset.pending = 'true';
  button.textContent = pendingEnabled ? 'Enabling\u2026' : 'Disabling\u2026';
  toggleErrorEl.hidden = true;

  if (pendingToggleTimer) {
    clearTimeout(pendingToggleTimer);
  }
  pendingToggleTimer = setTimeout(() => {
    resetPendingToggle();
    renderButtonState(currentTabState);
  }, TOGGLE_PENDING_TIMEOUT_MS);

  setCommunicationEnabled(pendingEnabled);
});

/**
 * @param {PopupCurrentTab | null} currentTab
 * @returns {void}
 */
function renderPopupState(currentTab) {
  currentTabState = currentTab;
  renderButtonState(currentTab);

  if (toggleErrorTimer) {
    clearTimeout(toggleErrorTimer);
    toggleErrorTimer = null;
  }
  toggleErrorEl.hidden = true;

  if (!currentTab) {
    accessEyebrow.textContent = 'Window access unavailable';
    accessDetail.textContent =
      'Open a normal web page to manage Browser Bridge for this Chrome window.';
    accessDisclosure.hidden = false;
    controlCard?.classList.remove('attention');
    return;
  }

  accessDisclosure.hidden = currentTab.enabled;

  if (currentTab.enabled && currentTab.restricted) {
    accessEyebrow.textContent = 'Window access enabled';
    accessDetail.textContent =
      'This page cannot be interacted with. Switch to a normal web page to use Browser Bridge.';
    accessDisclosure.hidden = false;
  } else if (currentTab.enabled) {
    accessEyebrow.textContent = 'Window access enabled';
    accessDetail.textContent =
      'Your connected agent can inspect and interact with pages in this Chrome window.';
  } else if (currentTab.accessRequested) {
    accessEyebrow.textContent = 'Window access requested';
    accessDetail.textContent =
      'An agent requested access for this Chrome window. Enable it to allow page inspection and interaction.';
  } else {
    accessEyebrow.textContent = 'Window access';
    accessDetail.textContent =
      'Enable Browser Bridge to let your connected agent inspect and interact with pages in this Chrome window.';
  }

  controlCard?.classList.toggle('attention', currentTab.accessRequested && !currentTab.enabled);
  queueWindowResize();
}

/**
 * @param {PopupCurrentTab | null} currentTab
 * @returns {void}
 */
function renderButtonState(currentTab) {
  button.dataset.pending = 'false';

  if (!currentTab) {
    button.textContent = 'Enable Window Access';
    button.disabled = true;
    return;
  }

  button.textContent = currentTab.enabled ? 'Disable Window Access' : 'Enable Window Access';
  button.disabled = !currentTab.url;
}

/**
 * @returns {void}
 */
function resetPendingToggle() {
  pendingEnabledState = null;
  button.dataset.pending = 'false';
  if (pendingToggleTimer) {
    clearTimeout(pendingToggleTimer);
    pendingToggleTimer = null;
  }
}

/**
 * @param {string} errorMessage
 * @returns {void}
 */
function renderToggleError(errorMessage) {
  resetPendingToggle();
  renderButtonState(currentTabState);
  const friendly = errorMessage.replace(/^CONTENT_SCRIPT_UNAVAILABLE:\s*/i, '');
  toggleErrorEl.textContent = friendly;
  toggleErrorEl.hidden = false;

  if (toggleErrorTimer) {
    clearTimeout(toggleErrorTimer);
  }
  toggleErrorTimer = setTimeout(() => {
    toggleErrorEl.hidden = true;
    toggleErrorTimer = null;
  }, TOGGLE_ERROR_DISPLAY_MS);
}

/**
 * @param {boolean} connected
 * @returns {void}
 */
function renderNativeStatus(connected) {
  if (!nativeIndicator) return;
  const label = connected ? 'Native host connected' : 'Native host disconnected';
  nativeIndicator.dataset.connected = String(connected);
  nativeIndicator.title = label;
  nativeIndicator.setAttribute('aria-label', label);

  if (connected) {
    if (nativeDiagnosticTimer) {
      clearTimeout(nativeDiagnosticTimer);
      nativeDiagnosticTimer = null;
    }
    hideDiagnostic();
  } else if (!nativeDiagnosticTimer) {
    nativeDiagnosticTimer = setTimeout(() => {
      nativeDiagnosticTimer = null;
      showDiagnostic(
        `Native host unreachable. Run: npm install -g @browserbridge/bbx && ${getInstallCommand()}`
      );
    }, NATIVE_DIAGNOSTIC_DELAY_MS);
  }
}

/**
 * @param {string} message
 * @returns {void}
 */
function showDiagnostic(message) {
  let el = document.getElementById('native-diagnostic');
  if (!el) {
    el = document.createElement('div');
    el.id = 'native-diagnostic';
    el.style.cssText =
      'padding:8px 12px;margin:8px 0;background:var(--status-badge-bg,#fef3cd);color:var(--text-primary,#856404);border-radius:6px;font-size:12px;line-height:1.4';
    const container = document.querySelector('.popup-content') || document.body;
    container.prepend(el);
  }
  el.textContent = message;
  el.hidden = false;
  queueWindowResize();
}

function hideDiagnostic() {
  const el = document.getElementById('native-diagnostic');
  if (el) {
    el.hidden = true;
    queueWindowResize();
  }
}

/**
 * @param {boolean} enabled
 * @returns {void}
 */
function setCommunicationEnabled(enabled) {
  const scopedTabId = currentTabState?.tabId ?? popupScopeTabId;
  port.postMessage({
    type: 'scope.set_enabled',
    enabled,
    ...(scopedTabId ? { tabId: scopedTabId } : {}),
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
 * @returns {string}
 */
function getInstallCommand() {
  return chrome.runtime.id === PUBLISHED_EXTENSION_ID
    ? 'bbx install'
    : `bbx install ${chrome.runtime.id}`;
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
  const contentHeight = Math.ceil(
    panelRect?.height ?? document.body.getBoundingClientRect().height
  );
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
    height: targetHeight,
  };

  if (typeof currentWindow.left === 'number' && typeof currentWindow.width === 'number') {
    updateInfo.left = currentWindow.left + currentWindow.width - targetWidth;
  }

  await chrome.windows.update(currentWindow.id, updateInfo);
}
