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
 * }} SidepanelCurrentTab
 */

/**
 * @typedef {{
 *   configured: boolean
 * }} McpClientInstallState
 */

/**
 * @typedef {{
 *   key: string,
 *   label: string,
 *   detected: boolean,
 *   configPath: string,
 *   configured: boolean
 * }} McpClientSetupState
 */

/**
 * @typedef {{
 *   exists: boolean,
 *   managed?: boolean
 * }} SkillInstallState
 */

/**
 * @typedef {{
 *   skills: SkillInstallState[]
 * }} SkillTargetInstallState
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
 *   skills: SkillInstallState[]
 * }} SkillTargetSetupState
 */

/**
 * @typedef {{
 *   scope?: 'global' | 'local',
 *   mcpClients: Array<McpClientInstallState | McpClientSetupState>,
 *   skillTargets: Array<SkillTargetInstallState | SkillTargetSetupState>
 * }} SetupStatusInstallState
 */

/**
 * @typedef {{
 *   key: string,
 *   label: string,
 *   mcpClient: McpClientSetupState | null,
 *   skillTarget: SkillTargetSetupState | null
 * }} SetupMatrixRow
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

/**
 * @typedef {{
 *   kind: 'muted',
 *   text: string
 * } | {
 *   kind: 'badge',
 *   label: string,
 *   ok: boolean,
 *   title: string,
 *   contextAction?: SetupContextAction
 * } | {
 *   kind: 'button',
 *   setupKind: 'mcp' | 'skill',
 *   target: string,
 *   pending: boolean,
 *   variant: 'install' | 'update',
 *   label: string,
 *   pendingLabel: string,
 *   title?: string,
 *   contextAction?: SetupContextAction
 * }} SetupMatrixCellState
 */

/**
 * @typedef {{
 *   summaryNote: string,
 *   summaryHidden: boolean,
 *   note: string,
 *   noteHidden: boolean,
 *   placeholder: string | null,
 *   rows: SetupMatrixRow[],
 *   autoExpandHostSetup: boolean
 * }} SetupStatusViewState
 */

/**
 * @typedef {{
 *   buttonLabel: string,
 *   buttonDisabled: boolean,
 *   buttonEnabled: boolean,
 *   attention: boolean,
 *   errorMessage: string | null
 * }} SidepanelCurrentTabViewState
 */

/**
 * @typedef {{
 *   title: string,
 *   detail: string,
 *   disclosureHidden: boolean
 * }} SidepanelAgentStatusViewState
 */

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
const SETUP_MATRIX_RANK = new Map(SETUP_MATRIX_ORDER.map((key, index) => [key, index]));

const SETUP_MATRIX_BETA_KEYS = new Set(['antigravity', 'windsurf', 'agents']);

/**
 * @param {SetupStatusInstallState} setupStatus
 * @returns {{ hasConfiguredMcp: boolean, hasInstalledCliSkill: boolean }}
 */
function getSetupInstallState(setupStatus) {
  const hasConfiguredMcp = setupStatus.mcpClients.some((client) => client.configured);
  const hasInstalledCliSkill = setupStatus.skillTargets.some((target) =>
    target.skills.some((skill) => skill.exists)
  );
  return { hasConfiguredMcp, hasInstalledCliSkill };
}

/**
 * Auto-expand Host Setup when the panel opens into a completely unconfigured
 * machine: no MCP clients configured and no CLI skill present anywhere.
 *
 * @param {SetupStatusInstallState | null} setupStatus
 * @returns {boolean}
 */
export function shouldAutoExpandHostSetup(setupStatus) {
  if (!setupStatus) {
    return false;
  }

  const { hasConfiguredMcp, hasInstalledCliSkill } = getSetupInstallState(setupStatus);
  if (hasConfiguredMcp) {
    return false;
  }
  return !hasInstalledCliSkill;
}

/**
 * Pick which prompt-example set to show in the side panel.
 *
 * - `mcp`: MCP is installed, CLI skill is not.
 * - `cli`: CLI skill is installed, MCP is not.
 * - `grouped`: neither is installed, or both are installed.
 *
 * @param {SetupStatusInstallState | null} setupStatus
 * @returns {'mcp' | 'cli' | 'grouped'}
 */
export function getPromptExamplesMode(setupStatus) {
  if (!setupStatus) {
    return 'grouped';
  }

  const { hasConfiguredMcp, hasInstalledCliSkill } = getSetupInstallState(setupStatus);
  if (hasConfiguredMcp && !hasInstalledCliSkill) {
    return 'mcp';
  }
  if (hasInstalledCliSkill && !hasConfiguredMcp) {
    return 'cli';
  }
  return 'grouped';
}

/**
 * Pick the activity source tag to display in the side panel. Prefer explicit
 * request metadata, but fall back to setup state when only one host path is
 * configured so older log entries stay understandable.
 *
 * @param {string | null | undefined} source
 * @param {SetupStatusInstallState | null} setupStatus
 * @returns {'' | 'cli' | 'mcp'}
 */
export function getActivitySourceTag(source, setupStatus) {
  if (source === 'cli' || source === 'mcp') {
    return source;
  }

  const promptMode = getPromptExamplesMode(setupStatus);
  if (promptMode === 'cli' || promptMode === 'mcp') {
    return promptMode;
  }

  return '';
}

/**
 * @param {SetupStatusInstallState | null} setupStatus
 * @param {boolean} pending
 * @param {string | null} error
 * @param {string | null} installError
 * @returns {SetupStatusViewState}
 */
export function getSetupStatusView(setupStatus, pending, error, installError) {
  if (!setupStatus && pending) {
    return {
      summaryNote: '',
      summaryHidden: true,
      note: 'Checking global host setup…',
      noteHidden: false,
      placeholder: 'Checking detected clients…',
      rows: [],
      autoExpandHostSetup: false,
    };
  }

  if (!setupStatus) {
    return {
      summaryNote: '',
      summaryHidden: true,
      note: installError || error || 'Global host setup is unavailable.',
      noteHidden: false,
      placeholder: 'No host setup status yet.',
      rows: [],
      autoExpandHostSetup: false,
    };
  }

  /** @type {string[]} */
  const noteParts = [];
  if (installError) {
    noteParts.push(`Last install failed: ${installError}`);
  } else if (error) {
    noteParts.push(error);
  }

  const rows = buildSetupMatrixRows(setupStatus);
  return {
    summaryNote:
      setupStatus.scope === 'local' ? '* Project installs only' : '* Global installs only',
    summaryHidden: false,
    note: noteParts.join(' '),
    noteHidden: noteParts.length === 0,
    placeholder: rows.length ? null : 'No supported clients or agents were detected.',
    rows,
    autoExpandHostSetup: shouldAutoExpandHostSetup(setupStatus),
  };
}

/**
 * @param {SetupStatusInstallState} setupStatus
 * @returns {SetupMatrixRow[]}
 */
export function buildSetupMatrixRows(setupStatus) {
  /** @type {Map<string, SetupMatrixRow>} */
  const rowsByKey = new Map();

  for (const entry of setupStatus.mcpClients) {
    if (!isMcpClientSetupState(entry) || !shouldRenderMcpClientRow(entry)) {
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
      const row = rowsByKey.get(entry.key);
      if (row) {
        row.mcpClient = entry;
      }
    }
  }

  for (const entry of setupStatus.skillTargets) {
    if (!isSkillTargetSetupState(entry) || !shouldRenderSkillTargetRow(entry)) {
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
      const row = rowsByKey.get(entry.key);
      if (row) {
        row.skillTarget = entry;
      }
    }
  }

  return [...rowsByKey.entries()]
    .sort(([leftKey], [rightKey]) => compareSetupMatrixKeys(leftKey, rightKey))
    .map(([, row]) => row);
}

/**
 * @param {string} key
 * @returns {boolean}
 */
export function isSetupMatrixBetaKey(key) {
  return SETUP_MATRIX_BETA_KEYS.has(key);
}

/**
 * @param {SetupMatrixRow} row
 * @param {string | null} installPendingKey
 * @returns {SetupMatrixCellState}
 */
export function getMcpSetupCellState(row, installPendingKey) {
  const entry = row.mcpClient;
  if (!entry) {
    if (row.key === 'agents') {
      return {
        kind: 'button',
        setupKind: 'mcp',
        target: row.key,
        pending: installPendingKey === getInstallKey('mcp', row.key),
        variant: 'install',
        label: 'Install',
        pendingLabel: '...',
        title: 'Install Browser Bridge MCP for generic agents',
      };
    }
    return { kind: 'muted', text: '—' };
  }

  if (entry.configured) {
    return {
      kind: 'badge',
      label: 'Installed',
      ok: true,
      title: entry.configPath,
      contextAction: {
        kind: 'mcp',
        target: row.key,
        copyLabel: 'Copy MCP config path',
        copyText: entry.configPath,
        reinstallLabel: 'Re-install MCP',
        uninstallLabel: 'Uninstall MCP',
      },
    };
  }

  return {
    kind: 'button',
    setupKind: 'mcp',
    target: row.key,
    pending: installPendingKey === getInstallKey('mcp', row.key),
    variant: 'install',
    label: 'Install',
    pendingLabel: '...',
    title: entry.configPath,
  };
}

/**
 * @param {SetupMatrixRow} row
 * @param {string | null} installPendingKey
 * @returns {SetupMatrixCellState}
 */
export function getSkillSetupCellState(row, installPendingKey) {
  const entry = row.skillTarget;
  if (!entry) {
    return { kind: 'muted', text: '—' };
  }

  const reinstallLabel = getSkillReinstallLabel(entry);
  const uninstallLabel = getSkillUninstallLabel(entry);

  const installable = entry.skills.every((skill) => !skill.exists || skill.managed);
  if (!installable) {
    return {
      kind: 'badge',
      label: 'Custom',
      ok: false,
      title: entry.basePath,
      contextAction: {
        kind: 'skill',
        target: row.key,
        copyLabel: 'Copy CLI skill folder path',
        copyText: entry.basePath,
      },
    };
  }

  /** @type {SetupContextAction} */
  const contextAction = {
    kind: 'skill',
    target: row.key,
    copyLabel: 'Copy CLI skill folder path',
    copyText: entry.basePath,
    reinstallLabel,
    uninstallLabel,
  };

  if (entry.installed && entry.managed && !entry.updateAvailable) {
    return {
      kind: 'badge',
      label: 'Installed',
      ok: true,
      title: createSkillCellTitle(entry),
      contextAction,
    };
  }

  if (entry.installed && entry.managed && entry.updateAvailable) {
    return {
      kind: 'button',
      setupKind: 'skill',
      target: row.key,
      pending: installPendingKey === getInstallKey('skill', row.key),
      variant: 'update',
      label: 'Update',
      pendingLabel: 'Updating…',
      title: createSkillCellTitle(entry),
      contextAction,
    };
  }

  return {
    kind: 'button',
    setupKind: 'skill',
    target: row.key,
    pending: installPendingKey === getInstallKey('skill', row.key),
    variant: 'install',
    label: 'Install',
    pendingLabel: '...',
    title: entry.basePath,
  };
}

/**
 * @param {boolean} connected
 * @param {boolean} installationHidden
 * @param {boolean} installationOpen
 * @returns {boolean}
 */
export function shouldPollSetupStatus(connected, installationHidden, installationOpen) {
  return connected && !installationHidden && installationOpen;
}

/**
 * @typedef {{
 *   title: string | null,
 *   prompts: readonly string[]
 * }} PromptExamplesGroup
 */

/**
 * @typedef {{
 *   copyPrompt: string,
 *   copyLabel: string
 * }} PromptExampleItem
 */

/**
 * @typedef {{
 *   title: string | null,
 *   prompts: PromptExampleItem[]
 * }} PromptExamplesRenderGroup
 */

/**
 * @typedef {{
 *   hidden: boolean,
 *   installCommand: string,
 *   skillCommand: string,
 *   mcpCommand: string,
 *   label: string,
 *   diagnosticCommand: string
 * }} SidepanelNativeStatusView
 */

/**
 * @param {string} errorMessage
 * @returns {string}
 */
export function normalizeSidepanelToggleError(errorMessage) {
  const friendly = errorMessage.replace(/^CONTENT_SCRIPT_UNAVAILABLE:\s*/i, '');
  if (friendly === 'TAB_MISMATCH') {
    return 'This tab is no longer available. Switch to an open tab and try again.';
  }
  if (friendly === 'ACCESS_DENIED') {
    return 'Browser Bridge is off for this window.';
  }
  return friendly;
}

/**
 * @param {SidepanelCurrentTab | null} currentTab
 * @returns {SidepanelCurrentTabViewState}
 */
export function getSidepanelCurrentTabView(currentTab) {
  if (!currentTab) {
    return {
      buttonLabel: 'Window Access Unavailable',
      buttonDisabled: true,
      buttonEnabled: false,
      attention: false,
      errorMessage: null,
    };
  }

  if (currentTab.restricted && currentTab.enabled) {
    return {
      buttonLabel: 'Disable Window Access',
      buttonDisabled: false,
      buttonEnabled: true,
      attention: false,
      errorMessage:
        'This page cannot be interacted with. Switch to a normal web page to inspect and interact.',
    };
  }

  return {
    buttonLabel: currentTab.enabled ? 'Disable Window Access' : 'Enable Window Access',
    buttonDisabled: !currentTab.url,
    buttonEnabled: currentTab.enabled,
    attention: currentTab.accessRequested && !currentTab.enabled,
    errorMessage: null,
  };
}

/**
 * @param {SidepanelCurrentTab | null} currentTab
 * @returns {SidepanelAgentStatusViewState}
 */
export function getSidepanelAgentStatusView(currentTab) {
  if (!currentTab) {
    return {
      title: 'Window access unavailable',
      detail: 'Open a normal web page in this Chrome window to enable Browser Bridge.',
      disclosureHidden: false,
    };
  }

  if (currentTab.enabled && currentTab.restricted) {
    return {
      title: 'Window access enabled',
      detail:
        'This page cannot be interacted with. Switch to a normal web page to use Browser Bridge.',
      disclosureHidden: false,
    };
  }

  if (currentTab.enabled) {
    return {
      title: 'Window access enabled',
      detail:
        'Browser Bridge is enabled for this Chrome window. Requests default to the active tab, or can target another tab in this window explicitly.',
      disclosureHidden: true,
    };
  }

  if (currentTab.accessRequested) {
    return {
      title: 'Window access requested',
      detail:
        'An agent requested access for this Chrome window. Enable it to allow page inspection and interaction.',
      disclosureHidden: false,
    };
  }

  return {
    title: 'Window access',
    detail:
      'Enable Browser Bridge to let your connected agent inspect and interact with pages in this Chrome window.',
    disclosureHidden: false,
  };
}

/**
 * @param {SetupStatusInstallState | null} setupStatus
 * @param {readonly string[]} cliPromptExamples
 * @param {readonly string[]} mcpPromptExamples
 * @returns {PromptExamplesGroup[]}
 */
export function getPromptExamplesGroups(setupStatus, cliPromptExamples, mcpPromptExamples) {
  const mode = getPromptExamplesMode(setupStatus);
  if (mode === 'cli') {
    return [{ title: null, prompts: cliPromptExamples }];
  }
  if (mode === 'mcp') {
    return [{ title: null, prompts: mcpPromptExamples }];
  }
  return [
    { title: 'CLI skill', prompts: cliPromptExamples },
    { title: 'MCP', prompts: mcpPromptExamples },
  ];
}

/**
 * @param {SetupStatusInstallState | null} setupStatus
 * @param {readonly string[]} cliPromptExamples
 * @param {readonly string[]} mcpPromptExamples
 * @returns {PromptExamplesRenderGroup[]}
 */
export function getPromptExamplesRenderGroups(setupStatus, cliPromptExamples, mcpPromptExamples) {
  return getPromptExamplesGroups(setupStatus, cliPromptExamples, mcpPromptExamples).map(
    (group) => ({
      title: group.title,
      prompts: group.prompts.map((prompt) => ({
        copyPrompt: prompt,
        copyLabel: `Copy prompt: ${prompt}`,
      })),
    })
  );
}

/**
 * @param {{
 *   connected: boolean,
 *   error?: string,
 *   runtimeId: string,
 *   publishedExtensionId: string,
 *   fallbackInstallCommand?: string
 * }} options
 * @returns {SidepanelNativeStatusView}
 */
export function getSidepanelNativeStatusView({
  connected,
  error,
  runtimeId,
  publishedExtensionId,
  fallbackInstallCommand = 'bbx install',
}) {
  const installCommand =
    runtimeId === publishedExtensionId ? 'bbx install' : `bbx install ${runtimeId}`;
  return {
    hidden: connected,
    installCommand,
    skillCommand: 'bbx install-skill',
    mcpCommand: 'bbx install-mcp',
    label: connected ? 'Native host connected' : error || 'Native host disconnected',
    diagnosticCommand: connected ? installCommand : installCommand || fallbackInstallCommand,
  };
}

/**
 * @typedef {(handler: () => void, timeout?: number) => ReturnType<typeof setInterval>} IntervalScheduler
 */

/**
 * @param {{
 *   connected: boolean,
 *   installationHidden: boolean,
 *   installationOpen: boolean,
 *   currentTimer: ReturnType<typeof setInterval> | null,
 *   pollMs: number,
 *   refresh: () => void,
 *   setIntervalFn?: IntervalScheduler,
 *   clearIntervalFn?: typeof clearInterval
 * }} options
 * @returns {ReturnType<typeof setInterval> | null}
 */
export function syncSetupStatusPolling({
  connected,
  installationHidden,
  installationOpen,
  currentTimer,
  pollMs,
  refresh,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  const shouldPoll = shouldPollSetupStatus(connected, installationHidden, installationOpen);

  if (!shouldPoll) {
    if (currentTimer) {
      clearIntervalFn(currentTimer);
    }
    return null;
  }

  if (currentTimer) {
    return currentTimer;
  }

  // Only refresh immediately when polling first starts to avoid sync loops.
  refresh();
  return setIntervalFn(() => {
    refresh();
  }, pollMs);
}

/**
 * @param {'mcp' | 'skill'} kind
 * @param {string} target
 * @returns {string}
 */
export function getInstallKey(kind, target) {
  return `${kind}:${target}`;
}

/**
 * @param {'mcp' | 'skill'} kind
 * @param {string} target
 * @param {'install' | 'uninstall'} [action='install']
 * @returns {{ type: 'setup.install', action: 'install' | 'uninstall', kind: 'mcp' | 'skill', target: string }}
 */
export function createSetupInstallMessage(kind, target, action = 'install') {
  return {
    type: 'setup.install',
    action,
    kind,
    target,
  };
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
 * @param {McpClientInstallState | McpClientSetupState} entry
 * @returns {entry is McpClientSetupState}
 */
function isMcpClientSetupState(entry) {
  return 'key' in entry;
}

/**
 * @param {McpClientSetupState} entry
 * @returns {boolean}
 */
function shouldRenderMcpClientRow(entry) {
  return entry.detected || entry.configured || entry.key === 'agents';
}

/**
 * @param {SkillTargetInstallState | SkillTargetSetupState} entry
 * @returns {entry is SkillTargetSetupState}
 */
function isSkillTargetSetupState(entry) {
  return 'key' in entry;
}

/**
 * @param {SkillTargetSetupState} entry
 * @returns {boolean}
 */
function shouldRenderSkillTargetRow(entry) {
  return entry.detected || entry.installed || entry.skills.some((skill) => skill.exists);
}

/**
 * @param {SkillTargetSetupState} entry
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
 * @param {SkillTargetSetupState} _entry
 * @returns {string}
 */
function getSkillUninstallLabel(_entry) {
  return 'Uninstall CLI skill';
}

/**
 * @param {SkillTargetSetupState} _entry
 * @returns {string}
 */
function getSkillReinstallLabel(_entry) {
  return 'Re-install CLI skill';
}
