// @ts-check

/**
 * @typedef {{
 *   tabId: number,
 *   windowId: number,
 *   title: string,
 *   url: string,
 *   enabled: boolean
 * }} SidePanelCurrentTab
 */

/**
 * @typedef {{
 *   id: string,
 *   at: number,
 *   method: string,
 *   tabId: number | null,
 *   url: string,
 *   ok: boolean,
 *   summary: string
 * }} ActionLogEntry
 */

/**
 * @typedef {{
 *   nativeConnected: boolean,
 *   currentTab: SidePanelCurrentTab | null,
 *   actionLog: ActionLogEntry[]
 * }} UiSnapshot
 */

/**
 * @typedef {{
 *   type: 'native.status',
 *   connected: boolean,
 *   error?: string
 * } | {
 *   type: 'state.sync',
 *   state: UiSnapshot
 * }} SidePanelMessage
 */

const nativeIndicator = /** @type {HTMLSpanElement} */ (document.getElementById('native-indicator'));
const toggleButton = /** @type {HTMLButtonElement} */ (document.getElementById('bridge-toggle'));
const actionLog = /** @type {HTMLDivElement} */ (document.getElementById('action-log'));
const port = chrome.runtime.connect({ name: 'ui' });
const requestedTabId = Number(new URLSearchParams(window.location.search).get('tabId'));
/** @type {SidePanelCurrentTab | null} */
let currentTabState = null;

/** @param {SidePanelMessage} message */
port.onMessage.addListener((message) => {
  if (message.type === 'native.status') {
    renderNativeStatus(message.connected, message.error);
  }

  if (message.type === 'state.sync') {
    renderState(message.state);
  }
});

port.postMessage({
  type: 'state.request',
  scopeTabId: Number.isFinite(requestedTabId) && requestedTabId > 0 ? requestedTabId : undefined
});

toggleButton.addEventListener('click', () => {
  if (!currentTabState) {
    return;
  }

  port.postMessage({
    type: 'scope.set_enabled',
    tabId: Number.isFinite(requestedTabId) && requestedTabId > 0 ? requestedTabId : undefined,
    enabled: !currentTabState.enabled
  });
});

/**
 * @param {UiSnapshot} state
 * @returns {void}
 */
function renderState(state) {
  renderNativeStatus(state.nativeConnected);
  renderCurrentTab(state.currentTab);

  actionLog.replaceChildren(...state.actionLog.map((entry) => renderActionLogEntry(entry)));

  if (!state.actionLog.length) {
    actionLog.textContent = 'No recent agent actions.';
  }
}

/**
 * @param {SidePanelCurrentTab | null} currentTab
 * @returns {void}
 */
function renderCurrentTab(currentTab) {
  currentTabState = currentTab;

  if (!currentTab) {
    toggleButton.textContent = 'Unavailable';
    toggleButton.disabled = true;
    return;
  }

  toggleButton.textContent = currentTab.enabled ? 'Disable' : 'Enable';
  toggleButton.disabled = !currentTab.url;
  toggleButton.dataset.enabled = String(currentTab.enabled);
}

/**
 * @param {boolean} connected
 * @param {string | undefined} [error]
 * @returns {void}
 */
function renderNativeStatus(connected, error) {
  const label = connected
    ? 'Native host connected'
    : error || 'Native host disconnected';
  nativeIndicator.dataset.connected = String(connected);
  nativeIndicator.title = label;
  nativeIndicator.setAttribute('aria-label', label);
}

/**
 * @param {ActionLogEntry} entry
 * @returns {HTMLElement}
 */
function renderActionLogEntry(entry) {
  const container = document.createElement('article');
  container.className = 'card activity-card';

  const title = document.createElement('h3');
  title.className = 'card-title';
  title.textContent = entry.method;

  const details = document.createElement('div');
  details.className = 'activity-meta';

  const timestamp = document.createElement('div');
  timestamp.className = 'muted activity-time';
  timestamp.textContent = new Date(entry.at).toLocaleTimeString();

  const summary = document.createElement('div');
  summary.textContent = `${entry.ok ? 'OK' : 'Error'}: ${entry.summary}`;

  details.append(timestamp);
  if (!(Number.isFinite(requestedTabId) && requestedTabId > 0) && entry.url) {
    const scopeLine = document.createElement('div');
    scopeLine.className = 'muted activity-scope';
    scopeLine.textContent = entry.url;
    details.append(scopeLine);
  }
  container.append(title, details, summary);
  return container;
}
