// @ts-check

/**
 * @typedef {{
 *   key: string,
 *   label: string,
 *   detected: boolean,
 *   configPath: string,
 *   configExists: boolean,
 *   configured: boolean
 * }} McpClientStatus
 */

/**
 * @typedef {{
 *   name: string,
 *   path: string,
 *   exists: boolean,
 *   managed: boolean,
 *   version: string | null
 * }} SkillInstallationStatus
 */

/**
 * @typedef {{
 *   key: string,
 *   label: string,
 *   detected: boolean,
 *   basePath: string,
 *   installed: boolean,
 *   managed: boolean,
 *   installedVersion: string | null,
 *   currentVersion: string | null,
 *   updateAvailable: boolean,
 *   skills: SkillInstallationStatus[]
 * }} SkillTargetStatus
 */

/**
 * @typedef {{
 *   scope: 'global' | 'local',
 *   mcpClients: McpClientStatus[],
 *   skillTargets: SkillTargetStatus[]
 * }} SetupStatus
 */

/**
 * @typedef {{
 *   key: string,
 *   label: string,
 *   mcpClient: McpClientStatus | null,
 *   skillTarget: SkillTargetStatus | null
 * }} SetupMatrixRow
 */

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
 *   setupStatus: SetupStatus | null,
 *   setupStatusPending: boolean,
 *   setupStatusError: string | null,
 *   setupInstallPendingKey: string | null,
 *   setupInstallError: string | null,
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

const PUBLISHED_EXTENSION_ID = 'ahhmghheecmambjebhfjkngdggghbkno';

const nativeIndicator = /** @type {HTMLSpanElement} */ (document.getElementById('native-indicator'));
const toggleButton = /** @type {HTMLButtonElement} */ (document.getElementById('bridge-toggle'));
const actionLog = /** @type {HTMLDivElement} */ (document.getElementById('action-log'));
const setupSection = /** @type {HTMLElement} */ (document.getElementById('native-setup'));
const setupInstallCmd = /** @type {HTMLElement} */ (document.getElementById('setup-install-cmd'));
const setupSkillCmd = /** @type {HTMLElement} */ (document.getElementById('setup-skill-cmd'));
const setupMcpCmd = /** @type {HTMLElement} */ (document.getElementById('setup-mcp-cmd'));
const controlSection = /** @type {HTMLElement} */ (document.getElementById('control-section'));
const installationSection = /** @type {HTMLDetailsElement} */ (document.getElementById('installation-section'));
const setupStatusNote = /** @type {HTMLParagraphElement} */ (document.getElementById('setup-status-note'));
const setupStatusSummaryNote = /** @type {HTMLSpanElement} */ (document.getElementById('setup-status-summary-note'));
const setupStatusMatrix = /** @type {HTMLDivElement} */ (document.getElementById('setup-status-matrix'));
const activitySection = /** @type {HTMLElement} */ (document.getElementById('activity-section'));
const examplesSection = /** @type {HTMLDetailsElement} */ (document.getElementById('examples-section'));
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

installationSection.addEventListener('toggle', () => {
  syncExclusiveDetailsSections(installationSection, examplesSection);
  syncConnectedSectionsVisibility();
});

examplesSection.addEventListener('toggle', () => {
  syncExclusiveDetailsSections(examplesSection, installationSection);
  syncConnectedSectionsVisibility();
});

installationSection.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || target.dataset.action !== 'setup-install') {
    return;
  }
  port.postMessage({
    type: 'setup.install',
    kind: target.dataset.kind,
    target: target.dataset.target
  });
});

/**
 * @param {UiSnapshot} state
 * @returns {void}
 */
function renderState(state) {
  renderNativeStatus(state.nativeConnected);
  renderCurrentTab(state.currentTab);
  renderSetupStatus(
    state.setupStatus,
    state.setupStatusPending,
    state.setupStatusError,
    state.setupInstallPendingKey,
    state.setupInstallError
  );

  actionLog.replaceChildren(...state.actionLog.map((entry) => renderActionLogEntry(entry)));

  if (!state.actionLog.length) {
    actionLog.textContent = 'No recent agent actions.';
  }

  // Auto-collapse examples when there is activity
  if (state.actionLog.length) {
    examplesSection.removeAttribute('open');
  }
  syncConnectedSectionsVisibility();
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
  installationSection.hidden = !connected;
  if (!connected) {
    const extId = chrome.runtime.id;
    setupInstallCmd.textContent = extId === PUBLISHED_EXTENSION_ID
      ? 'bbx install'
      : `bbx install ${extId}`;
    setupSkillCmd.textContent = 'bbx install-skill';
    setupMcpCmd.textContent = 'bbx install-mcp';
  }
  syncConnectedSectionsVisibility();
}

/**
 * @returns {void}
 */
function syncConnectedSectionsVisibility() {
  const connected = nativeIndicator.dataset.connected === 'true';
  if (!connected) {
    examplesSection.hidden = true;
    activitySection.hidden = true;
    return;
  }
  examplesSection.hidden = false;
  activitySection.hidden = false;
}

/**
 * @param {HTMLDetailsElement} source
 * @param {HTMLDetailsElement} other
 * @returns {void}
 */
function syncExclusiveDetailsSections(source, other) {
  if (!source.open || !other.open) {
    return;
  }
  other.open = false;
}

/**
 * @param {SetupStatus | null} setupStatus
 * @param {boolean} pending
 * @param {string | null} error
 * @param {string | null} installPendingKey
 * @param {string | null} installError
 * @returns {void}
 */
function renderSetupStatus(setupStatus, pending, error, installPendingKey, installError) {
  if (!setupStatus && pending) {
    setupStatusSummaryNote.hidden = true;
    setupStatusSummaryNote.textContent = '';
    setupStatusNote.textContent = 'Checking global host setup…';
    setupStatusNote.hidden = false;
    setupStatusMatrix.replaceChildren(createStatusPlaceholder('Checking detected clients…'));
    return;
  }

  if (!setupStatus) {
    setupStatusSummaryNote.hidden = true;
    setupStatusSummaryNote.textContent = '';
    setupStatusNote.textContent = installError || error || 'Global host setup is unavailable.';
    setupStatusNote.hidden = false;
    setupStatusMatrix.replaceChildren(createStatusPlaceholder('No host setup status yet.'));
    return;
  }

  const scopeNote = setupStatus.scope === 'global'
    ? 'Global installs only'
    : 'Project installs only';
  setupStatusSummaryNote.textContent = `* ${scopeNote}`;
  setupStatusSummaryNote.hidden = false;

  const noteParts = [];
  if (installError) {
    noteParts.push(`Last install failed: ${installError}`);
  } else if (error) {
    noteParts.push(error);
  }
  setupStatusNote.textContent = noteParts.join(' ');
  setupStatusNote.hidden = noteParts.length === 0;

  const rows = buildSetupMatrixRows(setupStatus);
  if (!rows.length) {
    setupStatusMatrix.replaceChildren(createStatusPlaceholder('No supported clients or agents were detected.'));
    return;
  }
  setupStatusMatrix.replaceChildren(renderSetupMatrix(rows, installPendingKey));
}

/**
 * @param {SetupStatus} setupStatus
 * @returns {SetupMatrixRow[]}
 */
function buildSetupMatrixRows(setupStatus) {
  /** @type {Map<string, SetupMatrixRow>} */
  const rowsByKey = new Map();
  /** @type {string[]} */
  const order = [];

  for (const entry of setupStatus.mcpClients) {
    if (!entry.detected) {
      continue;
    }
    if (!rowsByKey.has(entry.key)) {
      rowsByKey.set(entry.key, {
        key: entry.key,
        label: entry.label,
        mcpClient: entry,
        skillTarget: null
      });
      order.push(entry.key);
    } else {
      rowsByKey.get(entry.key).mcpClient = entry;
    }
  }

  for (const entry of setupStatus.skillTargets) {
    if (!entry.detected) {
      continue;
    }
    if (!rowsByKey.has(entry.key)) {
      rowsByKey.set(entry.key, {
        key: entry.key,
        label: entry.label,
        mcpClient: null,
        skillTarget: entry
      });
      order.push(entry.key);
    } else {
      rowsByKey.get(entry.key).skillTarget = entry;
    }
  }

  return order.map((key) => rowsByKey.get(key)).filter(Boolean);
}

/**
 * @param {SetupMatrixRow[]} rows
 * @param {string | null} installPendingKey
 * @returns {HTMLElement}
 */
function renderSetupMatrix(rows, installPendingKey) {
  const table = document.createElement('table');
  table.className = 'setup-status-matrix';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const heading of ['Client', 'MCP', 'Skills']) {
    const th = document.createElement('th');
    th.textContent = heading;
    headerRow.append(th);
  }
  thead.append(headerRow);

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');

    const labelCell = document.createElement('td');
    labelCell.className = 'setup-matrix-client';
    labelCell.textContent = row.label;

    const mcpCell = document.createElement('td');
    mcpCell.append(renderMcpMatrixCell(row, installPendingKey));

    const skillCell = document.createElement('td');
    skillCell.append(renderSkillMatrixCell(row, installPendingKey));

    tr.append(labelCell, mcpCell, skillCell);
    tbody.append(tr);
  }

  table.append(thead, tbody);
  return table;
}

/**
 * @param {SetupMatrixRow} row
 * @param {string | null} installPendingKey
 * @returns {HTMLElement}
 */
function renderMcpMatrixCell(row, installPendingKey) {
  const entry = row.mcpClient;
  if (!entry) {
    return createMatrixMutedValue('\u2014');
  }
  if (entry.configured) {
    return createMatrixBadge('Installed', true, entry.configPath);
  }
  const button = createSetupActionButton(
    'mcp',
    row.key,
    installPendingKey === getInstallKey('mcp', row.key),
    'install',
    'Install',
    'Installing…'
  );
  button.title = entry.configPath;
  return button;
}

/**
 * @param {SetupMatrixRow} row
 * @param {string | null} installPendingKey
 * @returns {HTMLElement}
 */
function renderSkillMatrixCell(row, installPendingKey) {
  const entry = row.skillTarget;
  if (!entry) {
    return createMatrixMutedValue('\u2014');
  }

  const installable = entry.skills.every((skill) => !skill.exists || skill.managed);
  if (entry.installed && entry.managed && !entry.updateAvailable) {
    return createMatrixBadge('Installed', true, createSkillCellTitle(entry));
  }
  if (entry.installed && entry.managed && entry.updateAvailable) {
    const button = createSetupActionButton(
      'skill',
      row.key,
      installPendingKey === getInstallKey('skill', row.key),
      'update',
      'Update',
      'Updating…'
    );
    button.title = createSkillCellTitle(entry);
    return button;
  }
  if (!installable) {
    return createMatrixBadge('Custom', false, entry.basePath);
  }

  const button = createSetupActionButton(
    'skill',
    row.key,
    installPendingKey === getInstallKey('skill', row.key),
    'install',
    'Install',
    'Installing…'
  );
  button.title = entry.basePath;
  return button;
}

/**
 * @param {'mcp' | 'skill'} kind
 * @param {string} target
 * @param {boolean} pending
 * @param {'install' | 'update'} variant
 * @param {string} label
 * @param {string} pendingLabel
 * @returns {HTMLButtonElement}
 */
function createSetupActionButton(kind, target, pending, variant, label, pendingLabel) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'setup-install-button';
  button.dataset.action = 'setup-install';
  button.dataset.kind = kind;
  button.dataset.target = target;
  button.dataset.variant = variant;
  button.disabled = pending;
  button.textContent = pending ? pendingLabel : label;
  return button;
}

/**
 * @param {SkillTargetStatus} entry
 * @returns {string}
 */
function createSkillCellTitle(entry) {
  if (entry.installedVersion && entry.currentVersion) {
    return `${entry.basePath}\nInstalled with bbx ${entry.installedVersion}\nCurrent bbx ${entry.currentVersion}`;
  }
  if (entry.currentVersion) {
    return `${entry.basePath}\nCurrent bbx ${entry.currentVersion}`;
  }
  return entry.basePath;
}

/**
 * @param {string} label
 * @param {boolean} ok
 * @param {string} title
 * @returns {HTMLElement}
 */
function createMatrixBadge(label, ok, title) {
  const badge = document.createElement('span');
  badge.className = 'setup-status-badge';
  badge.dataset.ok = String(ok);
  badge.textContent = label;
  badge.title = title;
  return badge;
}

/**
 * @param {string} text
 * @returns {HTMLElement}
 */
function createMatrixMutedValue(text) {
  const value = document.createElement('span');
  value.className = 'setup-matrix-muted';
  value.textContent = text;
  return value;
}

/**
 * @param {'mcp' | 'skill'} kind
 * @param {string} target
 * @returns {string}
 */
function getInstallKey(kind, target) {
  return `${kind}:${target}`;
}

/**
 * @param {string} text
 * @returns {HTMLElement}
 */
function createStatusPlaceholder(text) {
  const row = document.createElement('div');
  row.className = 'setup-status-placeholder';
  row.textContent = text;
  return row;
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
