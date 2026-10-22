import {
  createPopupToggleMessage,
  getUnstableConnectionDiagnostic,
  normalizePopupToggleError,
  renderPopupButtonState,
  renderPopupNativeIndicator,
  renderPopupViewState,
  shouldResetPendingToggleOnSync,
} from '../src/popup-helpers.js';
import {
  connectPopupPort as connectPopupRuntimePort,
  createPopupMessageHandler,
  isWindowedPopup,
} from '../src/popup-runtime.js';

export type PopupCurrentTab = {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  enabled: boolean;
  accessRequested: boolean;
  restricted: boolean;
  accessRequestContext?: import('../src/background-state.js').AccessRequestContext | null;
};

export type PopupMessage =
  | {
      type: 'state.sync';
      state: {
        nativeConnected: boolean;
        nativeUnstable?: boolean;
        nativeHostVersion?: string | null;
        currentTab: PopupCurrentTab | null;
      };
    }
  | {
      type: 'toggle.error';
      error: string;
    };

const nativeIndicator = document.getElementById('native-indicator') as HTMLSpanElement;
const extensionVersion = document.getElementById('extension-version') as HTMLSpanElement;
const manifest = chrome.runtime.getManifest();
extensionVersion.textContent = `Extension: v${manifest.version_name ?? manifest.version}\nDaemon: disconnected`;
const button = document.getElementById('communication-action') as HTMLButtonElement;
const accessEyebrow = document.getElementById('popup-access-eyebrow') as HTMLDivElement;
const accessDetail = document.getElementById('popup-access-detail') as HTMLParagraphElement;
const accessDisclosure = document.getElementById('popup-disclosure') as HTMLParagraphElement;
const controlCard = document.querySelector('.popup-control-card') as HTMLElement | null;
const windowedPopup = isWindowedPopup(window.location.search);
const toggleErrorEl = document.createElement('p');
toggleErrorEl.className = 'toggle-error';
toggleErrorEl.hidden = true;
button.insertAdjacentElement('afterend', toggleErrorEl);

let popupScopeTabId: number | null = null;

let pendingEnabledState: boolean | null = null;

let pendingToggleTimer: ReturnType<typeof setTimeout> | null = null;

let toggleErrorTimer: ReturnType<typeof setTimeout> | null = null;
const TOGGLE_PENDING_TIMEOUT_MS = 10_000;
const TOGGLE_ERROR_DISPLAY_MS = 6_000;

let port: chrome.runtime.Port;

const handlePopupMessage = createPopupMessageHandler({
  renderNativeStatus,
  renderHostVersion(hostVersion) {
    extensionVersion.textContent = `Extension: v${manifest.version_name ?? manifest.version}\nDaemon: ${hostVersion ? `v${hostVersion}` : 'disconnected'}`;
  },
  renderPopupState,
  shouldResetPendingToggleOnSync,
  getPendingEnabledState: () => pendingEnabledState,
  resetPendingToggle,
  renderToggleError,
  windowedPopup,
  closeWindow: () => window.close(),
});

async function connectPopupPort(): Promise<void> {
  const connection = await connectPopupRuntimePort({
    search: window.location.search,
    queryTabs: (queryInfo) => chrome.tabs.query(queryInfo),
    connect: (connectInfo) => chrome.runtime.connect(connectInfo),
    onMessage: handlePopupMessage,
  });
  popupScopeTabId = connection.popupScopeTabId;
  port = connection.port as chrome.runtime.Port;
}

void connectPopupPort();

let currentTabState: PopupCurrentTab | null = null;

let resizeFrameId: number | null = null;

let nativeDiagnosticTimer: ReturnType<typeof setTimeout> | null = null;
const NATIVE_DIAGNOSTIC_DELAY_MS = 10_000;

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

function renderPopupState(currentTab: PopupCurrentTab | null): void {
  currentTabState = currentTab;
  renderPopupViewState(currentTab, {
    accessEyebrow,
    accessDetail,
    accessDisclosure,
    controlCard,
    button,
  });

  if (toggleErrorTimer) {
    clearTimeout(toggleErrorTimer);
    toggleErrorTimer = null;
  }
  toggleErrorEl.hidden = true;

  if (!currentTab) {
    return;
  }
  queueWindowResize();
}

function renderButtonState(currentTab: PopupCurrentTab | null): void {
  renderPopupButtonState(currentTab, button);
}

function resetPendingToggle(): void {
  pendingEnabledState = null;
  button.dataset.pending = 'false';
  if (pendingToggleTimer) {
    clearTimeout(pendingToggleTimer);
    pendingToggleTimer = null;
  }
}

function renderToggleError(errorMessage: string): void {
  resetPendingToggle();
  renderButtonState(currentTabState);
  const friendly = normalizePopupToggleError(errorMessage);
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

function renderNativeStatus(connected: boolean, unstable: boolean = false): void {
  renderPopupNativeIndicator(nativeIndicator, connected);

  if (unstable) {
    // A flapping connection reconnects before the offline diagnostic delay
    // elapses, so surface the crash-loop hint immediately and keep it visible
    // across the connected/disconnected flips.
    if (nativeDiagnosticTimer) {
      clearTimeout(nativeDiagnosticTimer);
      nativeDiagnosticTimer = null;
    }
    showDiagnostic(getUnstableConnectionDiagnostic());
    return;
  }

  if (connected) {
    if (nativeDiagnosticTimer) {
      clearTimeout(nativeDiagnosticTimer);
      nativeDiagnosticTimer = null;
    }
    hideDiagnostic();
  } else if (!nativeDiagnosticTimer) {
    nativeDiagnosticTimer = setTimeout(() => {
      nativeDiagnosticTimer = null;
      showDiagnostic('CLI not connected. Open the side panel to install or repair Browser Bridge.');
    }, NATIVE_DIAGNOSTIC_DELAY_MS);
  }
}

function showDiagnostic(message: string): void {
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

function setCommunicationEnabled(enabled: boolean): void {
  port.postMessage(createPopupToggleMessage(enabled, currentTabState, popupScopeTabId));
}

function queueWindowResize(): void {
  if (!windowedPopup || resizeFrameId != null) {
    return;
  }
  resizeFrameId = window.requestAnimationFrame(() => {
    resizeFrameId = null;
    void resizeWindowToContent();
  });
}

async function resizeWindowToContent(): Promise<void> {
  if (!windowedPopup) {
    return;
  }

  const panel = document.querySelector('.panel-popup') as HTMLElement | null;
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

  const updateInfo: chrome.windows.UpdateInfo = {
    width: targetWidth,
    height: targetHeight,
  };

  if (typeof currentWindow.left === 'number' && typeof currentWindow.width === 'number') {
    updateInfo.left = currentWindow.left + currentWindow.width - targetWidth;
  }

  await chrome.windows.update(currentWindow.id, updateInfo);
}
