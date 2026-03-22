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
 *   summary: string,
 *   responseBytes: number,
 *   approxTokens: number,
 *   hasScreenshot: boolean,
 *   nodeCount: number | null
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
 * } | {
 *   type: 'attention.request',
 *   tabId: number
 * }} SidePanelMessage
 */

const PUBLISHED_EXTENSION_ID = 'niaidbpnkbfbjgdfieabpmlomilpdipn';

const nativeIndicator = /** @type {HTMLSpanElement} */ (document.getElementById('native-indicator'));
const toggleButton = /** @type {HTMLButtonElement} */ (document.getElementById('bridge-toggle'));
const actionLog = /** @type {HTMLDivElement} */ (document.getElementById('action-log'));
const setupSection = /** @type {HTMLElement} */ (document.getElementById('native-setup'));
const setupInstallCmd = /** @type {HTMLElement} */ (document.getElementById('setup-install-cmd'));
const setupSkillCmd = /** @type {HTMLElement} */ (document.getElementById('setup-skill-cmd'));
const setupMcpCmd = /** @type {HTMLElement} */ (document.getElementById('setup-mcp-cmd'));
const controlSection = /** @type {HTMLElement} */ (document.getElementById('control-section'));
const activitySection = /** @type {HTMLElement} */ (document.getElementById('activity-section'));
const examplesSection = /** @type {HTMLElement} */ (document.getElementById('examples-section'));
const port = chrome.runtime.connect({ name: 'ui' });
const requestedTabId = Number(new URLSearchParams(window.location.search).get('tabId'));
/** @type {SidePanelCurrentTab | null} */
let currentTabState = null;

for (const cmd of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.setup-cmd'))) {
  cmd.addEventListener('click', () => {
    const text = cmd.textContent?.trim() ?? '';
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      cmd.classList.add('copied');
      setTimeout(() => { cmd.classList.remove('copied'); }, 1500);
    }).catch(() => { /* clipboard unavailable, user-select:all allows manual copy */ });
  });
}

/** @param {SidePanelMessage} message */
port.onMessage.addListener((message) => {
  if (message.type === 'native.status') {
    renderNativeStatus(message.connected, message.error);
  }

  if (message.type === 'state.sync') {
    renderState(message.state);
  }

  if (message.type === 'attention.request') {
    pulseAttention();
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

  // Auto-collapse examples when there is activity
  if (state.actionLog.length) {
    examplesSection.removeAttribute('open');
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

  setupSection.hidden = connected;
  controlSection.hidden = !connected;
  examplesSection.hidden = !connected;
  activitySection.hidden = !connected;
  if (!connected) {
    const extId = chrome.runtime.id;
    setupInstallCmd.textContent = extId === PUBLISHED_EXTENSION_ID
      ? 'bbx install'
      : `bbx install ${extId}`;
    setupSkillCmd.textContent = 'bbx install-skill';
    setupMcpCmd.textContent = 'bbx install-mcp';
  }
}

/**
 * Briefly highlight the control card to draw attention when an agent is waiting
 * for permission and the side panel is already visible.
 *
 * @returns {void}
 */
function pulseAttention() {
  controlSection.classList.remove('attention');
  // Force a reflow so re-adding the class restarts the animation.
  void controlSection.offsetWidth;
  controlSection.classList.add('attention');
  controlSection.addEventListener('animationend', () => {
    controlSection.classList.remove('attention');
  }, { once: true });
}

/**
 * @param {ActionLogEntry} entry
 * @returns {HTMLElement}
 */
function renderActionLogEntry(entry) {
  const container = document.createElement('article');
  container.className = 'card activity-card';

  const header = document.createElement('div');
  header.className = 'activity-header';

  const title = document.createElement('h3');
  title.className = 'card-title';
  title.textContent = entry.method;

  const timestamp = document.createElement('span');
  timestamp.className = 'muted activity-time';
  timestamp.textContent = new Date(entry.at).toLocaleTimeString();

  header.append(title, timestamp);

  const footer = document.createElement('div');
  footer.className = 'activity-footer';

  const summary = document.createElement('span');
  summary.className = 'activity-summary';
  if (!entry.ok) summary.classList.add('activity-summary-error');
  const dot = document.createElement('span');
  dot.className = 'activity-status-dot';
  dot.dataset.ok = String(entry.ok);
  const summaryText = document.createElement('span');
  summaryText.textContent = entry.summary;
  summary.append(dot, summaryText);
  footer.append(summary);

  const badges = document.createElement('span');
  badges.className = 'activity-badges';

  const showScope = !(Number.isFinite(requestedTabId) && requestedTabId > 0) && entry.url;
  if (showScope) {
    const scopeLink = document.createElement('a');
    scopeLink.className = 'activity-scope-link';
    scopeLink.href = entry.url;
    scopeLink.target = '_blank';
    scopeLink.rel = 'noopener';
    scopeLink.title = entry.url;
    scopeLink.innerHTML = '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4.5 1.5H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8"/><path d="M7 1h4v4"/><path d="M5 7L11 1"/></svg>';
    badges.append(scopeLink);
  }

  if (entry.approxTokens > 0) {
    const tokenLine = document.createElement('span');
    tokenLine.className = 'muted activity-tokens';
    const parts = [`\u2248${entry.approxTokens.toLocaleString()} tok`];
    if (entry.nodeCount != null) {
      parts.push(`${entry.nodeCount}n`);
    }
    if (entry.hasScreenshot) {
      parts.push('img');
    }
    tokenLine.textContent = parts.join(' \u00b7 ');
    badges.append(tokenLine);
  }

  if (badges.childElementCount) footer.append(badges);

  container.append(header, footer);
  return container;
}
