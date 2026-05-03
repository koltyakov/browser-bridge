// @ts-check

import {
  createSetupInstallMessage,
  getActivitySourceTag,
  getPromptExamplesRenderGroups,
  getSidepanelAgentStatusView,
  getSidepanelCurrentTabView,
  getSidepanelNativeStatusView,
  getMcpSetupCellState,
  getSetupStatusView,
  getSkillSetupCellState,
  isSetupMatrixBetaKey,
  normalizeSidepanelToggleError,
  syncSetupStatusPolling as syncSetupStatusPollingState,
} from '../src/sidepanel-helpers.js';
import {
  connectSidepanelPort as connectSidepanelRuntimePort,
  createSidepanelMessageHandler,
  readRequestedTabId,
  renderSidepanelState,
} from '../src/sidepanel-runtime.js';

/** @typedef {import('../../protocol/src/types.js').McpClientStatus} McpClientStatus */
/** @typedef {import('../../protocol/src/types.js').SkillInstallationStatus} SkillInstallationStatus */
/** @typedef {import('../../protocol/src/types.js').SkillTargetStatus} SkillTargetStatus */
/** @typedef {import('../../protocol/src/types.js').SetupStatus} SetupStatus */
/** @typedef {import('../src/sidepanel-helpers.js').SetupContextAction} SetupContextAction */
/** @typedef {import('../src/sidepanel-helpers.js').SetupMatrixCellState} SetupMatrixCellState */
/** @typedef {import('../src/sidepanel-helpers.js').SetupMatrixRow} SetupMatrixRow */

/**
 * @typedef {{
 *   tabId: number,
 *   windowId: number,
 *   title: string,
 *   url: string,
 *   enabled: boolean,
 *   accessRequested: boolean,
 *   restricted: boolean
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
 *   imageApproxTokens: number,
 *   costClass: 'cheap' | 'moderate' | 'heavy' | 'extreme',
 *   imageBytes: number,
 *   summaryBytes: number,
 *   summaryTokens: number,
 *   summaryCostClass: 'cheap' | 'moderate' | 'heavy' | 'extreme',
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
 * } | {
 *   type: 'toggle.error',
 *   error: string
 * }} SidePanelMessage
 */

const PUBLISHED_EXTENSION_ID = 'jjjkmmcdkpcgamlopogicbnnhdgebhie';
const SETUP_STATUS_POLL_MS = 15_000;
const nativeIndicator =
  /** @type {HTMLSpanElement} */ (document.getElementById('native-indicator'));
const toggleButton = /** @type {HTMLButtonElement} */ (document.getElementById('bridge-toggle'));
const actionLog = /** @type {HTMLDivElement} */ (document.getElementById('action-log'));
const setupSection = /** @type {HTMLElement} */ (document.getElementById('native-setup'));
const setupInstallCmd = /** @type {HTMLElement} */ (document.getElementById('setup-install-cmd'));
const setupSkillCmd = /** @type {HTMLElement} */ (document.getElementById('setup-skill-cmd'));
const setupMcpCmd = /** @type {HTMLElement} */ (document.getElementById('setup-mcp-cmd'));
const controlSection = /** @type {HTMLElement} */ (document.getElementById('control-section'));
const installationSection = /** @type {HTMLDetailsElement} */ (
  document.getElementById('installation-section')
);
const setupStatusNote =
  /** @type {HTMLParagraphElement} */ (document.getElementById('setup-status-note'));
const setupStatusSummaryNote = /** @type {HTMLSpanElement} */ (
  document.getElementById('setup-status-summary-note')
);
const setupStatusMatrix = /** @type {HTMLDivElement} */ (
  document.getElementById('setup-status-matrix')
);
const activitySection = /** @type {HTMLElement} */ (document.getElementById('activity-section'));
const activityHistogram =
  /** @type {HTMLDivElement} */ (document.getElementById('activity-histogram'));
const activityHistogramBars = /** @type {HTMLDivElement} */ (
  document.getElementById('activity-histogram-bars')
);
const activityHistogramRange = /** @type {HTMLSpanElement} */ (
  document.getElementById('activity-histogram-range')
);
const activitySummaryTokens = /** @type {HTMLSpanElement} */ (
  document.getElementById('activity-summary-tokens')
);
const agentStatus = /** @type {HTMLDivElement} */ (document.getElementById('agent-status'));
const agentStatusDetail = /** @type {HTMLParagraphElement} */ (
  document.getElementById('agent-status-detail')
);
const agentDisclosure =
  /** @type {HTMLParagraphElement} */ (document.getElementById('agent-disclosure'));
const examplesSection =
  /** @type {HTMLDetailsElement} */ (document.getElementById('examples-section'));
const examplesContent = /** @type {HTMLDivElement} */ (document.getElementById('examples-content'));
/** @type {SidePanelCurrentTab | null} */
let currentTabState = null;
/** @type {ActionLogEntry[]} */
let currentActionLog = [];
/** @type {ReturnType<typeof setInterval> | null} */
let setupStatusPollTimer = null;
let hasAutoExpandedHostSetup = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let nativeDiagnosticTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let pendingToggleTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let toggleErrorTimer = null;
const NATIVE_DIAGNOSTIC_DELAY_MS = 10_000;
const TOGGLE_PENDING_TIMEOUT_MS = 10_000;
const TOGGLE_ERROR_DISPLAY_MS = 6_000;

const toggleErrorEl = document.createElement('p');
toggleErrorEl.className = 'toggle-error';
toggleErrorEl.hidden = true;
toggleButton.insertAdjacentElement('afterend', toggleErrorEl);
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
const ACTIVITY_HISTOGRAM_WINDOW_MS = 10 * 60 * 1000;
const ACTIVITY_HISTOGRAM_BUCKET_MS = 30 * 1000;
const ACTIVITY_HISTOGRAM_BARS = Math.floor(
  ACTIVITY_HISTOGRAM_WINDOW_MS / ACTIVITY_HISTOGRAM_BUCKET_MS
);
const ACTIVITY_HISTOGRAM_TICK_MS = 5 * 1000;
const HISTOGRAM_METHOD_FAMILIES = /** @type {const} */ ([
  'dom',
  'page',
  'layout',
  'style',
  'input',
  'patch',
  'capture',
  'other',
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
      const resetLabel = copyButton instanceof HTMLButtonElement ? copyButton.textContent : null;
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

/** @type {chrome.runtime.Port} */
let port;

const handleSidepanelMessage = createSidepanelMessageHandler({
  renderNativeStatus,
  renderState,
  renderToggleError,
});

/** @type {number | null} */
const requestedTabId = readRequestedTabId(window.location.search);

/**
 * @returns {Promise<void>}
 */
async function connectSidepanelPort() {
  port = /** @type {chrome.runtime.Port} */ (
    connectSidepanelRuntimePort({
      connect: (connectInfo) => chrome.runtime.connect(connectInfo),
      onMessage: handleSidepanelMessage,
      scheduleReconnect: (callback, delayMs) => {
        setTimeout(callback, delayMs);
      },
      onReconnect: () => {
        void connectSidepanelPort();
      },
    })
  );
}

void connectSidepanelPort();
const activityHistogramTimer = setInterval(() => {
  updateActivityVisualizations();
}, ACTIVITY_HISTOGRAM_TICK_MS);

toggleButton.addEventListener('click', () => {
  if (!currentTabState || toggleButton.dataset.pending === 'true') {
    return;
  }

  const pendingEnabled = !currentTabState.enabled;
  toggleButton.dataset.pending = 'true';
  toggleButton.textContent = pendingEnabled ? 'Enabling\u2026' : 'Disabling\u2026';

  if (pendingToggleTimer) {
    clearTimeout(pendingToggleTimer);
  }
  pendingToggleTimer = setTimeout(() => {
    toggleButton.dataset.pending = 'false';
    if (currentTabState) {
      toggleButton.textContent = currentTabState.enabled
        ? 'Disable Window Access'
        : 'Enable Window Access';
    }
    pendingToggleTimer = null;
  }, TOGGLE_PENDING_TIMEOUT_MS);

  port.postMessage({
    type: 'scope.set_enabled',
    enabled: pendingEnabled,
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
  const actionTarget = target.closest('[data-context-kind][data-context-target]');
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
  if ((kind !== 'mcp' && kind !== 'skill') || !targetKey || !copyLabel || !copyText) {
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

window.addEventListener('beforeunload', () => {
  clearInterval(activityHistogramTimer);
});

/**
 * @param {UiSnapshot} state
 * @returns {void}
 */
function renderState(state) {
  renderSidepanelState(state, {
    hideSetupContextMenu,
    renderNativeStatus,
    renderCurrentTab,
    renderAgentStatus,
    renderPromptExamples,
    renderSetupStatus,
    renderActionLogEntry,
    replaceActionLogChildren(children) {
      actionLog.replaceChildren(...children);
    },
    setCurrentActionLog(entries) {
      currentActionLog = entries;
    },
    updateActivityVisualizations,
    showEmptyActionLog() {
      actionLog.textContent = 'No recent agent actions.';
    },
    collapseExamples() {
      examplesSection.removeAttribute('open');
    },
    syncConnectedSectionsVisibility,
    syncSetupStatusPolling,
  });
}

/**
 * @returns {void}
 */
function updateActivityVisualizations() {
  const histogram = buildActivityHistogram(currentActionLog);
  renderActivityHistogram(histogram);
  renderActivitySummary(histogram.totalTokens);
}

/**
 * @param {SidePanelCurrentTab | null} currentTab
 * @returns {void}
 */
function renderCurrentTab(currentTab) {
  currentTabState = currentTab;
  toggleButton.dataset.pending = 'false';
  toggleErrorEl.hidden = true;

  if (pendingToggleTimer) {
    clearTimeout(pendingToggleTimer);
    pendingToggleTimer = null;
  }

  if (toggleErrorTimer) {
    clearTimeout(toggleErrorTimer);
    toggleErrorTimer = null;
  }

  const view = getSidepanelCurrentTabView(currentTab);
  toggleButton.textContent = view.buttonLabel;
  toggleButton.disabled = view.buttonDisabled;
  toggleButton.dataset.enabled = String(view.buttonEnabled);
  toggleErrorEl.textContent = view.errorMessage ?? '';
  toggleErrorEl.hidden = view.errorMessage == null;
  controlSection.classList.toggle('attention', view.attention);
}

/**
 * @param {string} errorMessage
 * @returns {void}
 */
function renderToggleError(errorMessage) {
  toggleButton.dataset.pending = 'false';

  if (pendingToggleTimer) {
    clearTimeout(pendingToggleTimer);
    pendingToggleTimer = null;
  }

  if (currentTabState) {
    toggleButton.textContent = currentTabState.enabled
      ? 'Disable Window Access'
      : 'Enable Window Access';
  }

  const friendly = normalizeSidepanelToggleError(errorMessage);
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
 * @param {UiSnapshot} state
 * @returns {void}
 */
function renderAgentStatus(state) {
  const view = getSidepanelAgentStatusView(state.currentTab);
  agentStatus.textContent = view.title;
  agentStatusDetail.textContent = view.detail;
  agentDisclosure.hidden = view.disclosureHidden;
}

/**
 * @param {boolean} connected
 * @param {string | undefined} [error]
 * @returns {void}
 */
function renderNativeStatus(connected, error) {
  const view = getSidepanelNativeStatusView({
    connected,
    error,
    runtimeId: chrome.runtime.id,
    publishedExtensionId: PUBLISHED_EXTENSION_ID,
    fallbackInstallCommand: setupInstallCmd.textContent || 'bbx install',
  });
  nativeIndicator.dataset.connected = String(connected);
  nativeIndicator.title = view.label;
  nativeIndicator.setAttribute('aria-label', view.label);

  setupSection.hidden = view.hidden;
  controlSection.hidden = !connected;
  installationSection.hidden = !connected;
  if (!connected) {
    setupInstallCmd.textContent = view.installCommand;
    setupSkillCmd.textContent = view.skillCommand;
    setupMcpCmd.textContent = view.mcpCommand;
    hideSetupContextMenu();
  }
  syncConnectedSectionsVisibility();

  if (connected) {
    if (nativeDiagnosticTimer) {
      clearTimeout(nativeDiagnosticTimer);
      nativeDiagnosticTimer = null;
    }
    hideSidepanelDiagnostic();
  } else if (!nativeDiagnosticTimer) {
    nativeDiagnosticTimer = setTimeout(() => {
      nativeDiagnosticTimer = null;
      showSidepanelDiagnostic(view.diagnosticMessage);
    }, NATIVE_DIAGNOSTIC_DELAY_MS);
  }
}

/**
 * @param {string} message
 * @returns {void}
 */
function showSidepanelDiagnostic(message) {
  let el = document.getElementById('native-diagnostic');
  if (!el) {
    el = document.createElement('div');
    el.id = 'native-diagnostic';
    el.style.cssText =
      'padding:8px 12px;margin:8px 0;background:var(--status-badge-bg,#fef3cd);color:var(--text-primary,#856404);border-radius:6px;font-size:12px;line-height:1.4';
    setupSection.after(el);
  }
  el.textContent = message;
  el.hidden = false;
}

function hideSidepanelDiagnostic() {
  const el = document.getElementById('native-diagnostic');
  if (el) {
    el.remove();
  }
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
  setupStatusPollTimer = syncSetupStatusPollingState({
    connected: nativeIndicator.dataset.connected === 'true',
    installationHidden: Boolean(installationSection.hidden),
    installationOpen: installationSection.open,
    currentTimer: setupStatusPollTimer,
    pollMs: SETUP_STATUS_POLL_MS,
    refresh: requestSetupStatusRefresh,
  });
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
  const groups = getPromptExamplesRenderGroups(
    setupStatus,
    CLI_PROMPT_EXAMPLES,
    MCP_PROMPT_EXAMPLES
  );
  examplesContent.replaceChildren(
    ...groups.map((group) =>
      group.title
        ? createExamplesGroup(group.title, group.prompts)
        : createExamplesList(group.prompts)
    )
  );
}

/**
 * @param {string} title
 * @param {import('../src/sidepanel-helpers.js').PromptExampleItem[]} prompts
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
 * @param {import('../src/sidepanel-helpers.js').PromptExampleItem[]} prompts
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
    text.textContent = prompt.copyPrompt;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'example-copy-button';
    button.setAttribute('aria-label', prompt.copyLabel);
    button.title = 'Copy prompt';
    button.textContent = '⧉';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      copySetupText(row, prompt.copyPrompt);
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
function renderSetupStatus(setupStatus, pending, error, installPendingKey, installError) {
  const view = getSetupStatusView(setupStatus, pending, error, installError);
  setupStatusSummaryNote.textContent = view.summaryNote;
  setupStatusSummaryNote.hidden = view.summaryHidden;
  setupStatusNote.textContent = view.note;
  setupStatusNote.hidden = view.noteHidden;

  if (!hasAutoExpandedHostSetup && setupStatus) {
    hasAutoExpandedHostSetup = true;
    installationSection.open = view.autoExpandHostSetup;
    if (view.autoExpandHostSetup) {
      examplesSection.open = false;
    }
  }

  if (view.placeholder) {
    setupStatusMatrix.replaceChildren(createStatusPlaceholder(view.placeholder));
    return;
  }

  setupStatusMatrix.replaceChildren(renderSetupMatrix(view.rows, installPendingKey));
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
    labelCell.append(createSetupMatrixClientLabel(row));

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
 * @returns {DocumentFragment}
 */
function createSetupMatrixClientLabel(row) {
  const fragment = document.createDocumentFragment();
  fragment.append(row.label);

  if (isSetupMatrixBetaKey(row.key)) {
    const beta = document.createElement('span');
    beta.className = 'setup-matrix-beta';
    beta.textContent = ' (beta)';
    fragment.append(beta);
  }

  return fragment;
}

/**
 * @param {SetupMatrixRow} row
 * @param {string | null} installPendingKey
 * @returns {HTMLElement}
 */
function renderMcpMatrixCell(row, installPendingKey) {
  return renderSetupMatrixCell(getMcpSetupCellState(row, installPendingKey));
}

/**
 * @param {SetupMatrixRow} row
 * @param {string | null} installPendingKey
 * @returns {HTMLElement}
 */
function renderSkillMatrixCell(row, installPendingKey) {
  return renderSetupMatrixCell(getSkillSetupCellState(row, installPendingKey));
}

/**
 * @param {SetupMatrixCellState} cellState
 * @returns {HTMLElement}
 */
function renderSetupMatrixCell(cellState) {
  if (cellState.kind === 'muted') {
    return createMatrixMutedValue(cellState.text);
  }

  if (cellState.kind === 'badge') {
    return createMatrixBadge(
      cellState.label,
      cellState.ok,
      cellState.title,
      cellState.contextAction ?? null
    );
  }

  const button = createSetupActionButton(
    cellState.setupKind,
    cellState.target,
    cellState.pending,
    cellState.variant,
    cellState.label,
    cellState.pendingLabel
  );
  if (cellState.title) {
    button.title = cellState.title;
  }
  if (cellState.contextAction) {
    assignSetupContext(button, cellState.contextAction);
  }
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
  button.addEventListener('click', () => {
    if (button.disabled) {
      return;
    }
    hideSetupContextMenu();
    button.disabled = true;
    button.textContent = pendingLabel;
    port.postMessage(createSetupInstallMessage(kind, target));
  });
  return button;
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
    { once: true }
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
        port.postMessage(createSetupInstallMessage(contextAction.kind, contextAction.target));
        hideSetupContextMenu();
      },
      { once: true }
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
        port.postMessage(
          createSetupInstallMessage(contextAction.kind, contextAction.target, 'uninstall')
        );
        hideSetupContextMenu();
      },
      { once: true }
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
  methodLabel.title = entry.method;
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

  const showScope = !(requestedTabId != null && requestedTabId > 0) && entry.url;
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

  const transportTokens = getEntryTransportTokens(entry);
  if (transportTokens > 0 || entry.imageBytes > 0) {
    const tokenLine = document.createElement('span');
    tokenLine.className = 'muted activity-tokens';
    /** @type {string[]} */
    const parts = [];
    if (transportTokens > 0) {
      parts.push(`\u2248${transportTokens.toLocaleString()} tok`);
    }
    if (entry.nodeCount != null) {
      parts.push(`${entry.nodeCount}n`);
    }
    if (entry.imageBytes > 0) {
      parts.push(`${formatByteCount(entry.imageBytes)} img`);
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
 * @param {number} totalTokens
 * @returns {void}
 */
function renderActivitySummary(totalTokens) {
  if (totalTokens <= 0) {
    activitySummaryTokens.hidden = true;
    activitySummaryTokens.textContent = '';
    activitySummaryTokens.removeAttribute('data-cost-class');
    return;
  }

  activitySummaryTokens.hidden = false;
  activitySummaryTokens.textContent = `≈${formatCompactCount(totalTokens)} tok`;
  activitySummaryTokens.dataset.costClass = getAggregateCostClass(totalTokens);
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatByteCount(value) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 10 * 1024) {
    return `${Math.round((value / 1024) * 10) / 10} KB`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${Math.round((value / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * @param {ActionLogEntry} entry
 * @returns {number}
 */
function getEntryTransportTokens(entry) {
  return Math.max(0, entry.approxTokens + entry.imageApproxTokens);
}

/**
 * Snap the histogram window to the active bucket boundary so bars only shift
 * when the 30s bin rolls over instead of drifting on every refresh tick.
 *
 * @param {number} value
 * @returns {number}
 */
function alignHistogramEndAt(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return ACTIVITY_HISTOGRAM_BUCKET_MS;
  }
  return Math.ceil(value / ACTIVITY_HISTOGRAM_BUCKET_MS) * ACTIVITY_HISTOGRAM_BUCKET_MS;
}

/**
 * @typedef {{
 *   startAt: number,
 *   endAt: number,
 *   totalTokens: number,
 *   buckets: Array<{
 *     bucketStart: number,
 *     totalTokens: number,
 *     segments: Array<{ family: string, tokens: number }>
 *   }>
 * }} ActivityHistogramModel
 */

/**
 * @param {ActionLogEntry[]} entries
 * @returns {ActivityHistogramModel}
 */
function buildActivityHistogram(entries) {
  const latestAt = entries.reduce(
    (maxAt, entry) => Math.max(maxAt, Number.isFinite(entry.at) ? entry.at : 0),
    0
  );
  const endAt = alignHistogramEndAt(Math.max(Date.now(), latestAt));
  const startAt = endAt - ACTIVITY_HISTOGRAM_WINDOW_MS;
  const buckets = Array.from({ length: ACTIVITY_HISTOGRAM_BARS }, (_, index) => ({
    bucketStart: startAt + index * ACTIVITY_HISTOGRAM_BUCKET_MS,
    totalTokens: 0,
    segments: [],
  }));

  /** @type {Map<number, Map<string, number>>} */
  const bucketFamilies = new Map(buckets.map((_, index) => [index, new Map()]));
  let totalTokens = 0;

  for (const entry of entries) {
    const transportTokens = getEntryTransportTokens(entry);
    if (!Number.isFinite(transportTokens) || transportTokens <= 0) {
      continue;
    }
    if (!Number.isFinite(entry.at) || entry.at < startAt || entry.at > endAt) {
      continue;
    }

    const offset = Math.min(
      ACTIVITY_HISTOGRAM_BARS - 1,
      Math.max(0, Math.floor((entry.at - startAt) / ACTIVITY_HISTOGRAM_BUCKET_MS))
    );
    const family = getHistogramMethodFamily(entry.method);
    const familyTotals = /** @type {Map<string, number>} */ (bucketFamilies.get(offset));
    familyTotals.set(family, (familyTotals.get(family) ?? 0) + transportTokens);
    buckets[offset].totalTokens += transportTokens;
    totalTokens += transportTokens;
  }

  for (let index = 0; index < buckets.length; index += 1) {
    const familyTotals = /** @type {Map<string, number>} */ (bucketFamilies.get(index));
    buckets[index].segments =
      /** @type {typeof buckets[number]['segments']} */ (
        HISTOGRAM_METHOD_FAMILIES.map((family) => ({
          family,
          tokens: familyTotals.get(family) ?? 0,
        })).filter((segment) => segment.tokens > 0)
      );
  }

  return {
    startAt,
    endAt,
    totalTokens,
    buckets,
  };
}

/**
 * @param {ActivityHistogramModel} histogram
 * @returns {void}
 */
function renderActivityHistogram(histogram) {
  const activeBuckets = histogram.buckets.filter((bucket) => bucket.totalTokens > 0);
  if (!activeBuckets.length) {
    activityHistogram.hidden = true;
    activityHistogramBars.replaceChildren();
    activityHistogramRange.textContent = '';
    return;
  }

  const maxTokens = Math.max(...histogram.buckets.map((bucket) => bucket.totalTokens), 1);
  activityHistogram.hidden = false;
  activityHistogramRange.textContent = '10m window · 30s bins';
  activityHistogramBars.replaceChildren(
    ...histogram.buckets.map((bucket) => createHistogramBar(bucket, maxTokens))
  );
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatCompactCount(value) {
  if (value >= 1000) {
    const compact = value >= 10000 ? Math.round(value / 1000) : Math.round(value / 100) / 10;
    return `${compact}k`;
  }
  return String(value);
}

/**
 * @param {number} approxTokens
 * @returns {'cheap' | 'moderate' | 'heavy' | 'extreme'}
 */
function getAggregateCostClass(approxTokens) {
  if (approxTokens <= 250) {
    return 'cheap';
  }
  if (approxTokens <= 1000) {
    return 'moderate';
  }
  if (approxTokens <= 3000) {
    return 'heavy';
  }
  return 'extreme';
}

/**
 * @param {ActivityHistogramModel['buckets'][number]} bucket
 * @param {number} maxTokens
 * @returns {HTMLElement}
 */
function createHistogramBar(bucket, maxTokens) {
  const bar = document.createElement('span');
  const ratio = Math.log1p(bucket.totalTokens) / Math.log1p(maxTokens);
  const height = bucket.totalTokens > 0 ? Math.max(14, Math.round(ratio * 100)) : 6;
  bar.className = 'activity-histogram-bar';
  bar.style.height = `${height}%`;

  if (!bucket.totalTokens) {
    bar.dataset.empty = 'true';
    bar.title = `${new Date(bucket.bucketStart).toLocaleTimeString()} · no activity`;
    bar.setAttribute(
      'aria-label',
      `${new Date(bucket.bucketStart).toLocaleTimeString()}, no token activity`
    );
    return bar;
  }

  const tooltipParts = bucket.segments.map(
    (segment) => `${segment.family}: ${segment.tokens.toLocaleString()} tok`
  );
  bar.title = `${new Date(bucket.bucketStart).toLocaleTimeString()} · ${bucket.totalTokens.toLocaleString()} tok\n${tooltipParts.join('\n')}`;
  bar.setAttribute(
    'aria-label',
    `${new Date(bucket.bucketStart).toLocaleTimeString()}, approximately ${bucket.totalTokens.toLocaleString()} tokens`
  );
  bar.append(
    ...bucket.segments.map((segment) => createHistogramSegment(segment, bucket.totalTokens))
  );
  return bar;
}

/**
 * @param {{ family: string, tokens: number }} segment
 * @param {number} totalTokens
 * @returns {HTMLElement}
 */
function createHistogramSegment(segment, totalTokens) {
  const el = document.createElement('span');
  el.className = 'activity-histogram-segment';
  el.dataset.family = segment.family;
  el.style.height = `${(segment.tokens / totalTokens) * 100}%`;
  return el;
}

/**
 * @param {string} method
 * @returns {string}
 */
function getHistogramMethodFamily(method) {
  if (method.startsWith('dom.')) {
    return 'dom';
  }
  if (method.startsWith('page.')) {
    return 'page';
  }
  if (method.startsWith('layout.')) {
    return 'layout';
  }
  if (method.startsWith('styles.')) {
    return 'style';
  }
  if (
    method.startsWith('input.') ||
    method.startsWith('navigation.') ||
    method.startsWith('viewport.')
  ) {
    return 'input';
  }
  if (method.startsWith('patch.')) {
    return 'patch';
  }
  if (
    method.startsWith('screenshot.') ||
    method.startsWith('cdp.') ||
    method.startsWith('performance.')
  ) {
    return 'capture';
  }
  return 'other';
}

/**
 * @param {ActionLogEntry[]} entries
 * @param {number} index
 * @returns {number}
 */
function countRecentExpensiveRepeats(entries, index) {
  const current = entries[index];
  const currentCostClass =
    current?.summaryTokens > 0 ? current.summaryCostClass : current?.costClass;
  if (
    !current ||
    (!current.debuggerBacked && currentCostClass !== 'heavy' && currentCostClass !== 'extreme')
  ) {
    return 0;
  }

  let count = 0;
  for (let cursor = index + 1; cursor < Math.min(entries.length, index + 4); cursor += 1) {
    const candidate = entries[cursor];
    if (!candidate || candidate.method !== current.method) {
      break;
    }
    const candidateCostClass =
      candidate.summaryTokens > 0 ? candidate.summaryCostClass : candidate.costClass;
    if (
      candidate.debuggerBacked ||
      candidateCostClass === 'heavy' ||
      candidateCostClass === 'extreme'
    ) {
      count += 1;
    }
  }
  return count;
}
