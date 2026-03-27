// @ts-check

import {
  getActivitySourceTag,
  getPromptExamplesMode,
  shouldAutoExpandHostSetup,
} from '../src/sidepanel-helpers.js';

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
 *   enabled: boolean,
 *   accessRequested: boolean
 * }} SidePanelCurrentTab
 */

/**
 * @typedef {{
 *   id: string,
 *   at: number,
 *   method: string,
 *   source: string,
 *   tabId: number | null,
 *   url: string,
 *   ok: boolean,
 *   summary: string,
 *   responseBytes: number,
 *   approxTokens: number,
 *   costClass: 'cheap' | 'moderate' | 'heavy' | 'extreme',
 *   debuggerBacked: boolean,
 *   overBudget: boolean,
 *   hasScreenshot: boolean,
 *   nodeCount: number | null,
 *   continuationHint: string | null
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
 * }} SidePanelMessage
 */

/**
 * @typedef {{
 *   kind: 'mcp' | 'skill',
 *   target: string,
 *   copyLabel: string,
 *   copyText: string,
 *   reinstallLabel?: string,
 *   uninstallLabel?: string
 * }} SetupContextAction
 */

const PUBLISHED_EXTENSION_ID = 'ahhmghheecmambjebhfjkngdggghbkno';
const SETUP_STATUS_POLL_MS = 15_000;
const SETUP_MATRIX_ORDER = /** @type {const} */ ([
  'codex',
  'claude',
  'cursor',
  'copilot',
  'opencode',
  'antigravity',
  'windsurf',
  'agents',
]);
/** @type {Map<string, number>} */
const SETUP_MATRIX_RANK = new Map(
  SETUP_MATRIX_ORDER.map((key, index) => [key, index]),
);

const nativeIndicator = /** @type {HTMLSpanElement} */ (
  document.getElementById('native-indicator')
);
const toggleButton = /** @type {HTMLButtonElement} */ (
  document.getElementById('bridge-toggle')
);
const actionLog = /** @type {HTMLDivElement} */ (
  document.getElementById('action-log')
);
const setupSection = /** @type {HTMLElement} */ (
  document.getElementById('native-setup')
);
const setupInstallCmd = /** @type {HTMLElement} */ (
  document.getElementById('setup-install-cmd')
);
const setupSkillCmd = /** @type {HTMLElement} */ (
  document.getElementById('setup-skill-cmd')
);
const setupMcpCmd = /** @type {HTMLElement} */ (
  document.getElementById('setup-mcp-cmd')
);
const controlSection = /** @type {HTMLElement} */ (
  document.getElementById('control-section')
);
const installationSection = /** @type {HTMLDetailsElement} */ (
  document.getElementById('installation-section')
);
const setupStatusNote = /** @type {HTMLParagraphElement} */ (
  document.getElementById('setup-status-note')
);
const setupStatusSummaryNote = /** @type {HTMLSpanElement} */ (
  document.getElementById('setup-status-summary-note')
);
const setupStatusMatrix = /** @type {HTMLDivElement} */ (
  document.getElementById('setup-status-matrix')
);
const activitySection = /** @type {HTMLElement} */ (
  document.getElementById('activity-section')
);
const examplesSection = /** @type {HTMLDetailsElement} */ (
  document.getElementById('examples-section')
);
const examplesContent = /** @type {HTMLDivElement} */ (
  document.getElementById('examples-content')
);
const port = chrome.runtime.connect({ name: 'ui-sidepanel' });
const requestedTabId = Number(
  new URLSearchParams(window.location.search).get('tabId'),
);
/** @type {SidePanelCurrentTab | null} */
let currentTabState = null;
/** @type {ReturnType<typeof setInterval> | null} */
let setupStatusPollTimer = null;
let hasAutoExpandedHostSetup = false;
const setupContextMenu = document.createElement('div');
setupContextMenu.className = 'setup-context-menu';
setupContextMenu.hidden = true;
document.body.append(setupContextMenu);

const CLI_PROMPT_EXAMPLES = Object.freeze([
  '$bbx check why the button looks broken',
  '$bbx inspect the layout and fix spacing issues',
  '$bbx verify the form validation works correctly',
  '$bbx check console errors on this page',
]);

const MCP_PROMPT_EXAMPLES = Object.freeze([
  'Use BB MCP to inspect why the button looks broken.',
  'Use BB MCP to compare the live layout to the design and fix spacing issues.',
  'Use BB MCP to verify the form validation flow works correctly.',
  'Use BB MCP to inspect console and network errors on this page.',
]);

for (const cmd of /** @type {NodeListOf<HTMLElement>} */ (
  document.querySelectorAll('.setup-cmd')
)) {
  if (cmd.classList.contains('example-cmd')) {
    continue;
  }
  cmd.addEventListener('click', () => {
    copySetupText(cmd, cmd.textContent?.trim() ?? '');
  });
}

/**
 * @param {HTMLElement} target
 * @param {string} text
 * @returns {void}
 */
function copySetupText(target, text) {
  if (!text) {
    return;
  }
  navigator.clipboard
    .writeText(text)
    .then(() => {
      target.classList.add('copied');
      const copyButton = target.querySelector('.example-copy-button');
      const resetLabel =
        copyButton instanceof HTMLButtonElement ? copyButton.textContent : null;
      if (copyButton instanceof HTMLButtonElement) {
        copyButton.textContent = '✓';
      }
      setTimeout(() => {
        target.classList.remove('copied');
        if (copyButton instanceof HTMLButtonElement) {
          copyButton.textContent = resetLabel || '⧉';
        }
      }, 1500);
    })
    .catch(() => {
      // Ignore clipboard failures; prompt chips expose a dedicated copy button.
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
});

port.postMessage({
  type: 'state.request',
  scopeTabId:
    Number.isFinite(requestedTabId) && requestedTabId > 0
      ? requestedTabId
      : undefined,
});

toggleButton.addEventListener('click', () => {
  if (!currentTabState) {
    return;
  }

  port.postMessage({
    type: 'scope.set_enabled',
    tabId:
      Number.isFinite(requestedTabId) && requestedTabId > 0
        ? requestedTabId
        : undefined,
    enabled: !currentTabState.enabled,
  });
});

installationSection.addEventListener('toggle', () => {
  syncExclusiveDetailsSections(installationSection, examplesSection);
  syncConnectedSectionsVisibility();
  syncSetupStatusPolling();
});

examplesSection.addEventListener('toggle', () => {
  syncExclusiveDetailsSections(examplesSection, installationSection);
  syncConnectedSectionsVisibility();
  syncSetupStatusPolling();
});

setupStatusMatrix.addEventListener('contextmenu', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const actionTarget = target.closest(
    '[data-context-kind][data-context-target]',
  );
  if (!(actionTarget instanceof HTMLElement)) {
    hideSetupContextMenu();
    return;
  }

  const kind = actionTarget.dataset.contextKind;
  const targetKey = actionTarget.dataset.contextTarget;
  const copyLabel = actionTarget.dataset.contextCopyLabel;
  const copyText = actionTarget.dataset.contextCopyText;
  const reinstallLabel = actionTarget.dataset.contextReinstallLabel;
  const uninstallLabel = actionTarget.dataset.contextUninstallLabel;
  if (
    (kind !== 'mcp' && kind !== 'skill') ||
    !targetKey ||
    !copyLabel ||
    !copyText
  ) {
    hideSetupContextMenu();
    return;
  }

  event.preventDefault();
  showSetupContextMenu(event.clientX, event.clientY, {
    kind,
    target: targetKey,
    copyLabel,
    copyText,
    reinstallLabel: reinstallLabel || undefined,
    uninstallLabel: uninstallLabel || undefined,
  });
});

document.addEventListener('click', () => {
  hideSetupContextMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    hideSetupContextMenu();
  }
});

/**
 * @param {UiSnapshot} state
 * @returns {void}
 */
function renderState(state) {
  hideSetupContextMenu();
  renderNativeStatus(state.nativeConnected);
  renderCurrentTab(state.currentTab);
  renderAgentStatus(state);
  renderPromptExamples(state.setupStatus);
  renderSetupStatus(
    state.setupStatus,
    state.setupStatusPending,
    state.setupStatusError,
    state.setupInstallPendingKey,
    state.setupInstallError,
  );

  actionLog.replaceChildren(
    ...state.actionLog.map((entry, index, entries) =>
      renderActionLogEntry(entry, state.setupStatus, entries, index),
    ),
  );

  if (!state.actionLog.length) {
    actionLog.textContent = 'No recent agent actions.';
  }

  // Auto-collapse examples when there is activity
  if (state.actionLog.length) {
    examplesSection.removeAttribute('open');
  }
  syncConnectedSectionsVisibility();
  syncSetupStatusPolling();
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
    controlSection.classList.remove('attention');
    return;
  }

  toggleButton.textContent = currentTab.enabled ? 'Disable' : 'Enable';
  toggleButton.disabled = !currentTab.url;
  toggleButton.dataset.enabled = String(currentTab.enabled);
  controlSection.classList.toggle('attention', currentTab.accessRequested && !currentTab.enabled);
}

/**
 * @param {UiSnapshot} state
 * @returns {void}
 */
function renderAgentStatus(state) {
  void state;
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
    setupInstallCmd.textContent =
      extId === PUBLISHED_EXTENSION_ID ? 'bbx install' : `bbx install ${extId}`;
    setupSkillCmd.textContent = 'bbx install-skill';
    setupMcpCmd.textContent = 'bbx install-mcp';
    hideSetupContextMenu();
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
 * @returns {void}
 */
function syncSetupStatusPolling() {
  const shouldPoll =
    nativeIndicator.dataset.connected === 'true' &&
    !installationSection.hidden &&
    installationSection.open;

  if (!shouldPoll) {
    stopSetupStatusPolling();
    return;
  }

  if (setupStatusPollTimer) {
    return;
  }

  // Only kick off an immediate refresh when polling starts. Doing this on every
  // render causes a state.sync -> refresh -> state.sync loop that can peg the
  // extension renderer while Host Setup is open.
  requestSetupStatusRefresh();
  setupStatusPollTimer = setInterval(() => {
    requestSetupStatusRefresh();
  }, SETUP_STATUS_POLL_MS);
}

/**
 * @returns {void}
 */
function stopSetupStatusPolling() {
  if (!setupStatusPollTimer) {
    return;
  }
  clearInterval(setupStatusPollTimer);
  setupStatusPollTimer = null;
}

/**
 * @returns {void}
 */
function requestSetupStatusRefresh() {
  port.postMessage({ type: 'setup.status.refresh' });
}

/**
 * @param {SetupStatus | null} setupStatus
 * @returns {void}
 */
function renderPromptExamples(setupStatus) {
  const mode = getPromptExamplesMode(setupStatus);
  if (mode === 'cli') {
    examplesContent.replaceChildren(createExamplesList(CLI_PROMPT_EXAMPLES));
    return;
  }
  if (mode === 'mcp') {
    examplesContent.replaceChildren(createExamplesList(MCP_PROMPT_EXAMPLES));
    return;
  }

  examplesContent.replaceChildren(
    createExamplesGroup('CLI skill', CLI_PROMPT_EXAMPLES),
    createExamplesGroup('MCP', MCP_PROMPT_EXAMPLES),
  );
}

/**
 * @param {string} title
 * @param {readonly string[]} prompts
 * @returns {HTMLElement}
 */
function createExamplesGroup(title, prompts) {
  const section = document.createElement('section');
  section.className = 'examples-group';

  const heading = document.createElement('h3');
  heading.className = 'examples-group-title';
  heading.textContent = title;

  section.append(heading, createExamplesList(prompts));
  return section;
}

/**
 * @param {readonly string[]} prompts
 * @returns {HTMLElement}
 */
function createExamplesList(prompts) {
  const list = document.createElement('div');
  list.className = 'examples-list';

  for (const prompt of prompts) {
    const row = document.createElement('div');
    row.className = 'setup-cmd example-cmd';

    const text = document.createElement('code');
    text.className = 'example-cmd-text';
    text.textContent = prompt;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'example-copy-button';
    button.setAttribute('aria-label', `Copy prompt: ${prompt}`);
    button.title = 'Copy prompt';
    button.textContent = '⧉';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      copySetupText(row, prompt);
    });

    row.append(text, button);
    list.append(row);
  }

  return list;
}

window.addEventListener('beforeunload', () => {
  stopSetupStatusPolling();
  hideSetupContextMenu();
});

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
function renderSetupStatus(
  setupStatus,
  pending,
  error,
  installPendingKey,
  installError,
) {
  if (!setupStatus && pending) {
    setupStatusSummaryNote.hidden = true;
    setupStatusSummaryNote.textContent = '';
    setupStatusNote.textContent = 'Checking global host setup…';
    setupStatusNote.hidden = false;
    setupStatusMatrix.replaceChildren(
      createStatusPlaceholder('Checking detected clients…'),
    );
    return;
  }

  if (!setupStatus) {
    setupStatusSummaryNote.hidden = true;
    setupStatusSummaryNote.textContent = '';
    setupStatusNote.textContent =
      installError || error || 'Global host setup is unavailable.';
    setupStatusNote.hidden = false;
    setupStatusMatrix.replaceChildren(
      createStatusPlaceholder('No host setup status yet.'),
    );
    return;
  }

  const scopeNote =
    setupStatus.scope === 'global'
      ? 'Global installs only'
      : 'Project installs only';
  setupStatusSummaryNote.textContent = `* ${scopeNote}`;
  setupStatusSummaryNote.hidden = false;

  if (!hasAutoExpandedHostSetup) {
    hasAutoExpandedHostSetup = true;
    installationSection.open = shouldAutoExpandHostSetup(setupStatus);
  }

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
    setupStatusMatrix.replaceChildren(
      createStatusPlaceholder('No supported clients or agents were detected.'),
    );
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

  for (const entry of setupStatus.mcpClients) {
    if (!shouldRenderMcpClientRow(entry)) {
      continue;
    }
    if (!rowsByKey.has(entry.key)) {
      rowsByKey.set(entry.key, {
        key: entry.key,
        label: entry.label,
        mcpClient: entry,
        skillTarget: null,
      });
    } else {
      rowsByKey.get(entry.key).mcpClient = entry;
    }
  }

  for (const entry of setupStatus.skillTargets) {
    if (!shouldRenderSkillTargetRow(entry)) {
      continue;
    }
    if (!rowsByKey.has(entry.key)) {
      rowsByKey.set(entry.key, {
        key: entry.key,
        label: entry.label,
        mcpClient: null,
        skillTarget: entry,
      });
    } else {
      rowsByKey.get(entry.key).skillTarget = entry;
    }
  }

  return [...rowsByKey.entries()]
    .sort(([leftKey], [rightKey]) => compareSetupMatrixKeys(leftKey, rightKey))
    .map(([, row]) => row);
}

/**
 * @param {string} leftKey
 * @param {string} rightKey
 * @returns {number}
 */
function compareSetupMatrixKeys(leftKey, rightKey) {
  const leftRank = SETUP_MATRIX_RANK.get(leftKey);
  const rightRank = SETUP_MATRIX_RANK.get(rightKey);

  if (leftRank !== undefined && rightRank !== undefined) {
    return leftRank - rightRank;
  }
  if (leftRank !== undefined) {
    return -1;
  }
  if (rightRank !== undefined) {
    return 1;
  }
  return leftKey.localeCompare(rightKey);
}

/**
 * @param {McpClientStatus} entry
 * @returns {boolean}
 */
function shouldRenderMcpClientRow(entry) {
  return entry.detected || entry.configured;
}

/**
 * @param {SkillTargetStatus} entry
 * @returns {boolean}
 */
function shouldRenderSkillTargetRow(entry) {
  return (
    entry.detected ||
    entry.installed ||
    entry.skills.some((skill) => skill.exists)
  );
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
  for (const heading of ['Client', 'MCP', 'CLI']) {
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
    return createMatrixBadge('Installed', true, entry.configPath, {
      kind: 'mcp',
      target: row.key,
      copyLabel: 'Copy MCP config path',
      copyText: entry.configPath,
      reinstallLabel: 'Re-install MCP',
      uninstallLabel: 'Uninstall MCP',
    });
  }
  const button = createSetupActionButton(
    'mcp',
    row.key,
    installPendingKey === getInstallKey('mcp', row.key),
    'install',
    'Install',
    '...',
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
  const reinstallLabel = getSkillReinstallLabel(entry);
  const uninstallLabel = getSkillUninstallLabel(entry);

  const installable = entry.skills.every(
    (skill) => !skill.exists || skill.managed,
  );
  if (!installable) {
    return createMatrixBadge('Custom', false, entry.basePath, {
      kind: 'skill',
      target: row.key,
      copyLabel: 'Copy CLI skill folder path',
      copyText: entry.basePath,
    });
  }
  if (entry.installed && entry.managed && !entry.updateAvailable) {
    return createMatrixBadge('Installed', true, createSkillCellTitle(entry), {
      kind: 'skill',
      target: row.key,
      copyLabel: 'Copy CLI skill folder path',
      copyText: entry.basePath,
      reinstallLabel,
      uninstallLabel,
    });
  }
  if (entry.installed && entry.managed && entry.updateAvailable) {
    const button = createSetupActionButton(
      'skill',
      row.key,
      installPendingKey === getInstallKey('skill', row.key),
      'update',
      'Update',
      'Updating…',
    );
    button.title = createSkillCellTitle(entry);
    assignSetupContext(button, {
      kind: 'skill',
      target: row.key,
      copyLabel: 'Copy CLI skill folder path',
      copyText: entry.basePath,
      reinstallLabel,
      uninstallLabel,
    });
    return button;
  }

  const button = createSetupActionButton(
    'skill',
    row.key,
    installPendingKey === getInstallKey('skill', row.key),
    'install',
    'Install',
    '...',
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
function createSetupActionButton(
  kind,
  target,
  pending,
  variant,
  label,
  pendingLabel,
) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'setup-install-button';
  button.dataset.action = 'setup-install';
  button.dataset.kind = kind;
  button.dataset.target = target;
  button.dataset.variant = variant;
  button.disabled = pending;
  button.textContent = pending ? pendingLabel : label;
  button.addEventListener('click', () => {
    if (button.disabled) {
      return;
    }
    hideSetupContextMenu();
    button.disabled = true;
    button.textContent = pendingLabel;
    port.postMessage({
      type: 'setup.install',
      action: 'install',
      kind,
      target,
    });
  });
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
 * @param {SkillTargetStatus} _entry
 * @returns {string}
 */
function getSkillUninstallLabel(_entry) {
  return 'Uninstall CLI skill';
}

/**
 * @param {SkillTargetStatus} _entry
 * @returns {string}
 */
function getSkillReinstallLabel(_entry) {
  return 'Re-install CLI skill';
}

/**
 * @param {string} label
 * @param {boolean} ok
 * @param {string} title
 * @param {SetupContextAction | null} [contextAction=null]
 * @returns {HTMLElement}
 */
function createMatrixBadge(label, ok, title, contextAction = null) {
  const badge = document.createElement('span');
  badge.className = 'setup-status-badge';
  badge.dataset.ok = String(ok);
  badge.textContent = label;
  badge.title = title;
  if (contextAction) {
    assignSetupContext(badge, contextAction);
  }
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
 * @param {HTMLElement} element
 * @param {SetupContextAction} contextAction
 * @returns {void}
 */
function assignSetupContext(element, contextAction) {
  element.dataset.contextKind = contextAction.kind;
  element.dataset.contextTarget = contextAction.target;
  element.dataset.contextCopyLabel = contextAction.copyLabel;
  element.dataset.contextCopyText = contextAction.copyText;
  if (contextAction.reinstallLabel) {
    element.dataset.contextReinstallLabel = contextAction.reinstallLabel;
  } else {
    delete element.dataset.contextReinstallLabel;
  }
  if (contextAction.uninstallLabel) {
    element.dataset.contextUninstallLabel = contextAction.uninstallLabel;
  } else {
    delete element.dataset.contextUninstallLabel;
  }
}

/**
 * @param {number} clientX
 * @param {number} clientY
 * @param {SetupContextAction} contextAction
 * @returns {void}
 */
function showSetupContextMenu(clientX, clientY, contextAction) {
  setupContextMenu.replaceChildren();

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'setup-context-menu-item';
  copyButton.textContent = contextAction.copyLabel;
  copyButton.addEventListener(
    'click',
    () => {
      navigator.clipboard.writeText(contextAction.copyText).catch(() => {
        // Ignore clipboard failures; the menu still exposes the path in the title.
      });
      hideSetupContextMenu();
    },
    { once: true },
  );
  setupContextMenu.append(copyButton);

  if (contextAction.reinstallLabel) {
    const reinstallButton = document.createElement('button');
    reinstallButton.type = 'button';
    reinstallButton.className = 'setup-context-menu-item';
    reinstallButton.textContent = contextAction.reinstallLabel;
    reinstallButton.addEventListener(
      'click',
      () => {
        port.postMessage({
          type: 'setup.install',
          action: 'install',
          kind: contextAction.kind,
          target: contextAction.target,
        });
        hideSetupContextMenu();
      },
      { once: true },
    );
    setupContextMenu.append(reinstallButton);
  }

  if (contextAction.uninstallLabel) {
    const uninstallButton = document.createElement('button');
    uninstallButton.type = 'button';
    uninstallButton.className = 'setup-context-menu-item';
    uninstallButton.textContent = contextAction.uninstallLabel;
    uninstallButton.addEventListener(
      'click',
      () => {
        port.postMessage({
          type: 'setup.install',
          action: 'uninstall',
          kind: contextAction.kind,
          target: contextAction.target,
        });
        hideSetupContextMenu();
      },
      { once: true },
    );
    setupContextMenu.append(uninstallButton);
  }

  setupContextMenu.hidden = false;
  setupContextMenu.style.left = `${clientX}px`;
  setupContextMenu.style.top = `${clientY}px`;

  const rect = setupContextMenu.getBoundingClientRect();
  const left = Math.min(clientX, window.innerWidth - rect.width - 12);
  const top = Math.min(clientY, window.innerHeight - rect.height - 12);
  setupContextMenu.style.left = `${Math.max(8, left)}px`;
  setupContextMenu.style.top = `${Math.max(8, top)}px`;
}

/**
 * @returns {void}
 */
function hideSetupContextMenu() {
  setupContextMenu.hidden = true;
  setupContextMenu.replaceChildren();
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
 * @param {ActionLogEntry} entry
 * @param {SetupStatus | null} setupStatus
 * @param {ActionLogEntry[]} entries
 * @param {number} index
 * @returns {HTMLElement}
 */
function renderActionLogEntry(entry, setupStatus, entries, index) {
  const container = document.createElement('article');
  container.className = 'card activity-card';

  const header = document.createElement('div');
  header.className = 'activity-header';

  const title = document.createElement('h3');
  title.className = 'card-title activity-title';
  const methodLabel = document.createElement('span');
  methodLabel.className = 'activity-method';
  methodLabel.textContent = entry.method;
  title.append(methodLabel);
  const activitySourceTag = getActivitySourceTag(entry.source, setupStatus);
  if (activitySourceTag) {
    const sourceTag = document.createElement('span');
    sourceTag.className = 'activity-source-tag';
    sourceTag.textContent = activitySourceTag.toUpperCase();
    title.append(sourceTag);
  }

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

  const showScope =
    !(Number.isFinite(requestedTabId) && requestedTabId > 0) && entry.url;
  if (showScope) {
    const scopeLink = document.createElement('a');
    scopeLink.className = 'activity-scope-link';
    scopeLink.href = entry.url;
    scopeLink.target = '_blank';
    scopeLink.rel = 'noopener';
    scopeLink.title = entry.url;
    scopeLink.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4.5 1.5H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8"/><path d="M7 1h4v4"/><path d="M5 7L11 1"/></svg>';
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
    if (entry.debuggerBacked) {
      parts.push('cdp');
    }
    tokenLine.textContent = parts.join(' \u00b7 ');
    tokenLine.dataset.costClass = entry.costClass;
    badges.append(tokenLine);
  }

  if (entry.debuggerBacked) {
    badges.append(createActivityBadge('Debugger', 'activity-badge-warn'));
  }

  if (entry.overBudget) {
    badges.append(createActivityBadge('Truncated', 'activity-badge-warn'));
  }

  if (entry.hasScreenshot) {
    badges.append(createActivityBadge('Image', 'activity-badge-neutral'));
  }

  if (countRecentExpensiveRepeats(entries, index) >= 2) {
    badges.append(createActivityBadge('Repeat', 'activity-badge-warn'));
  }

  if (badges.childElementCount) footer.append(badges);

  if (entry.continuationHint) {
    const hint = document.createElement('p');
    hint.className = 'muted activity-hint';
    hint.textContent = entry.continuationHint;
    container.append(header, footer, hint);
    return container;
  }

  container.append(header, footer);
  return container;
}

/**
 * @param {string} label
 * @param {string} className
 * @returns {HTMLElement}
 */
function createActivityBadge(label, className) {
  const badge = document.createElement('span');
  badge.className = `activity-badge ${className}`;
  badge.textContent = label;
  return badge;
}

/**
 * @param {ActionLogEntry[]} entries
 * @param {number} index
 * @returns {number}
 */
function countRecentExpensiveRepeats(entries, index) {
  const current = entries[index];
  if (!current || (!current.debuggerBacked && current.costClass !== 'heavy' && current.costClass !== 'extreme')) {
    return 0;
  }

  let count = 0;
  for (let cursor = index + 1; cursor < Math.min(entries.length, index + 4); cursor += 1) {
    const candidate = entries[cursor];
    if (!candidate || candidate.method !== current.method) {
      break;
    }
    if (candidate.debuggerBacked || candidate.costClass === 'heavy' || candidate.costClass === 'extreme') {
      count += 1;
    }
  }
  return count;
}
