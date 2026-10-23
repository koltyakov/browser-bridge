export type VersionMismatchView = { key: string; message: string };

export function getAgentTabsInlineHeight(
  availableHeight: number,
  contentHeight: number
): number | null {
  if (!Number.isFinite(availableHeight) || !Number.isFinite(contentHeight) || contentHeight <= 0)
    return null;
  // Keep at least two tab rows usable when the rest of the list needs scrolling.
  const minimumHeight = Math.min(contentHeight, 2 * 32 + 13);
  return availableHeight >= minimumHeight ? Math.min(availableHeight, contentHeight) : null;
}

export function formatTabActivityAge(lastActivityAt: number | undefined, now = Date.now()): string {
  if (
    lastActivityAt == null ||
    !Number.isFinite(lastActivityAt) ||
    lastActivityAt <= 0 ||
    !Number.isFinite(now)
  ) {
    return '';
  }
  const elapsedSeconds = Math.floor(Math.max(0, now - lastActivityAt) / 1000);
  if (elapsedSeconds < 60) return '<1m';
  return `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`;
}

export type IntervalScheduler = (
  handler: () => void,
  timeout?: number
) => ReturnType<typeof setInterval>;
export type SidepanelCurrentTab = {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  enabled: boolean;
  accessRequested: boolean;
  restricted: boolean;
  accessRequestContext?: import('./background-state.js').AccessRequestContext | null;
};

export type McpClientInstallState = {
  configured: boolean;
};

export type McpClientSetupState = {
  key: string;
  label: string;
  detected: boolean;
  configPath: string;
  configured: boolean;
};

export type SkillInstallState = {
  exists: boolean;
  managed?: boolean;
};

export type SkillTargetInstallState = {
  skills: SkillInstallState[];
};

export type SkillTargetSetupState = {
  key: string;
  label: string;
  detected: boolean;
  basePath: string;
  installed: boolean;
  managed: boolean;
  installedVersion: string | null;
  currentVersion: string | null;
  updateAvailable: boolean;
  skills: SkillInstallState[];
};

export type SetupStatusInstallState = {
  scope?: 'global' | 'local';
  mcpClients: Array<McpClientInstallState | McpClientSetupState>;
  skillTargets: Array<SkillTargetInstallState | SkillTargetSetupState>;
};

export type SetupMatrixRow = {
  key: string;
  label: string;
  mcpClient: McpClientSetupState | null;
  skillTarget: SkillTargetSetupState | null;
};

export type SetupContextAction = {
  kind: 'mcp' | 'skill';
  target: string;
  copyLabel: string;
  copyText: string;
  reinstallLabel?: string;
  uninstallLabel?: string;
};

export type SetupMatrixCellState =
  | {
      kind: 'muted';
      text: string;
    }
  | {
      kind: 'badge';
      label: string;
      ok: boolean;
      title: string;
      contextAction?: SetupContextAction;
    }
  | {
      kind: 'button';
      setupKind: 'mcp' | 'skill';
      target: string;
      pending: boolean;
      variant: 'install' | 'update';
      label: string;
      pendingLabel: string;
      title?: string;
      contextAction?: SetupContextAction;
    };

export type SetupStatusViewState = {
  summaryNote: string;
  summaryHidden: boolean;
  note: string;
  noteHidden: boolean;
  placeholder: string | null;
  rows: SetupMatrixRow[];
  autoExpandHostSetup: boolean;
};

export type SidepanelCurrentTabViewState = {
  buttonLabel: string;
  buttonDisabled: boolean;
  buttonEnabled: boolean;
  attention: boolean;
  errorMessage: string | null;
};

export type SidepanelAgentStatusViewState = {
  title: string;
  detail: string;
  disclosureHidden: boolean;
};

const MANAGED_CLIENT_PACKAGE = '@browserbridge/bbx';
import { PUBLISHED_EXTENSION_ID } from './install-targets.js';
export { PUBLISHED_EXTENSION_ID };

export function getNpmInstallCommand(version: string): string {
  const versionMatch = /^(\d+\.\d+)(?:\.|$)/u.exec(version);
  return `npm install -g ${MANAGED_CLIENT_PACKAGE}${versionMatch ? `@${versionMatch[1]}` : ''}`;
}

export function getStandaloneInstallView(
  version: string,
  platform: { os: string; arch: string },
  runtimeId: string
): { label: string; command: string } | null {
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/u.test(version) || !/^[a-z]{32}$/u.test(runtimeId)) {
    return null;
  }
  const arch =
    platform.arch === 'arm' || platform.arch === 'arm64'
      ? 'arm64'
      : platform.arch === 'x86-64'
        ? 'x64'
        : null;
  if (!arch) return null;
  const releaseLine = version.split('.').slice(0, 2).join('.');
  const scriptsUrl = 'https://raw.githubusercontent.com/koltyakov/browser-bridge/main/scripts';
  const customExtension = runtimeId !== PUBLISHED_EXTENSION_ID;
  if (platform.os === 'win' && arch === 'x64') {
    const extensionOption = customExtension ? ` -ExtensionId '${runtimeId}'` : '';
    return {
      label: 'Windows x64 · Run in PowerShell',
      command: `& ([scriptblock]::Create((irm '${scriptsUrl}/install.ps1'))) -Version '${releaseLine}'${extensionOption}`,
    };
  }
  if (platform.os !== 'mac' && platform.os !== 'linux') return null;
  const extensionOption = customExtension ? ` BBX_EXTENSION_ID=${runtimeId}` : '';
  return {
    label: `${platform.os === 'mac' ? 'macOS' : 'Linux'} ${arch} · Run in Terminal`,
    command: `curl -fsSL ${scriptsUrl}/install.sh | BBX_VERSION=${releaseLine}${extensionOption} sh`,
  };
}

/** Match the protocol's major-version compatibility contract. Independent
minor and patch releases do not require users to reinstall anything. */
export function getVersionMismatchView(
  extensionVersion: string | null | undefined,
  cliVersion: string | null | undefined
): VersionMismatchView | null {
  const extensionMajor = getMajorVersion(extensionVersion);
  const cliMajor = getMajorVersion(cliVersion);
  if (!extensionMajor || !cliMajor || extensionMajor === cliMajor) {
    return null;
  }

  return {
    key: `${extensionVersion}:${cliVersion}`,
    message: `CLI v${cliVersion} and extension v${extensionVersion} use different protocol versions. Update the CLI and extension to compatible releases.`,
  };
}

function getMajorVersion(version: string | null | undefined): string | null {
  const match = typeof version === 'string' ? /^(\d+)\.(\d+)(?:\.|$)/u.exec(version) : null;
  return match ? match[1] : null;
}

function getSetupInstallState(setupStatus: SetupStatusInstallState): {
  hasConfiguredMcp: boolean;
  hasInstalledCliSkill: boolean;
} {
  const hasConfiguredMcp = setupStatus.mcpClients.some((client) => client.configured);
  const hasInstalledCliSkill = setupStatus.skillTargets.some((target) =>
    target.skills.some((skill) => skill.exists)
  );
  return { hasConfiguredMcp, hasInstalledCliSkill };
}

/** Auto-expand Host Setup when the panel opens into a completely unconfigured
machine: no MCP clients configured and no CLI skill present anywhere. */
export function shouldAutoExpandHostSetup(setupStatus: SetupStatusInstallState | null): boolean {
  if (!setupStatus) {
    return false;
  }

  const { hasConfiguredMcp, hasInstalledCliSkill } = getSetupInstallState(setupStatus);
  if (hasConfiguredMcp) {
    return false;
  }
  return !hasInstalledCliSkill;
}

/** Pick which prompt-example set to show in the side panel.

- `mcp`: MCP is installed, CLI skill is not.
- `cli`: CLI skill is installed, MCP is not.
- `grouped`: neither is installed, or both are installed. */
export function getPromptExamplesMode(
  setupStatus: SetupStatusInstallState | null
): 'mcp' | 'cli' | 'grouped' {
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

/** Pick the explicit activity source tag to display in the side panel. */
export function getActivitySourceTag(
  source: string | null | undefined,
  mcpEra: string | null | undefined
): '' | 'CLI' | 'MCP' | 'MCP Legacy' | 'MCP Modern' {
  if (source === 'cli') return 'CLI';
  if (source !== 'mcp') return '';
  if (mcpEra === 'legacy') return 'MCP Legacy';
  if (mcpEra === 'modern') return 'MCP Modern';
  return 'MCP';
}

/** Split MCP activity metadata into compact source and version pills. */
export function getActivitySourcePills(
  source: string | null | undefined,
  mcpEra: string | null | undefined
): { source: '' | 'CLI' | 'MCP'; version: '' | 'v1' | 'v2' } {
  if (source === 'cli') return { source: 'CLI', version: '' };
  if (source !== 'mcp') return { source: '', version: '' };
  if (mcpEra === 'legacy') return { source: 'MCP', version: 'v1' };
  if (mcpEra === 'modern') return { source: 'MCP', version: 'v2' };
  return { source: 'MCP', version: '' };
}

export function getSetupStatusView(
  setupStatus: SetupStatusInstallState | null,
  pending: boolean,
  error: string | null,
  installError: string | null
): SetupStatusViewState {
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

  const noteParts: string[] = [];
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

export function buildSetupMatrixRows(setupStatus: SetupStatusInstallState): SetupMatrixRow[] {
  const rowsByKey: Map<string, SetupMatrixRow> = new Map();
  // The native agent registry owns ordering. Include hidden entries when
  // ranking so a skill-only row keeps its registry position after filtering.
  const rank = new Map<string, number>();
  for (const entry of [...setupStatus.mcpClients, ...setupStatus.skillTargets]) {
    if ('key' in entry && typeof entry.key === 'string' && !rank.has(entry.key)) {
      rank.set(entry.key, rank.size);
    }
  }

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
    .sort(([leftKey], [rightKey]) => (rank.get(leftKey) ?? 0) - (rank.get(rightKey) ?? 0))
    .map(([, row]) => row);
}

export function getMcpSetupCellState(
  row: SetupMatrixRow,
  installPendingKey: string | null
): SetupMatrixCellState {
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
    return { kind: 'muted', text: '-' };
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

export function getSkillSetupCellState(
  row: SetupMatrixRow,
  installPendingKey: string | null
): SetupMatrixCellState {
  const entry = row.skillTarget;
  if (!entry) {
    return { kind: 'muted', text: '-' };
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

  const contextAction: SetupContextAction = {
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

export function shouldPollSetupStatus(
  connected: boolean,
  installationHidden: boolean,
  installationOpen: boolean
): boolean {
  return connected && !installationHidden && installationOpen;
}

export type PromptExamplesGroup = {
  title: string | null;
  prompts: readonly string[];
};

export type PromptExampleItem = {
  copyPrompt: string;
  copyLabel: string;
};

export type PromptExamplesRenderGroup = {
  title: string | null;
  prompts: PromptExampleItem[];
};

export type SidepanelNativeStatusView = {
  hidden: boolean;
  installCommand: string;
  skillCommand: string;
  mcpCommand: string;
  label: string;
  diagnosticCommand: string;
  diagnosticMessage: string;
};

function getNativeDiagnosticMessage(error: string | undefined, installCommand: string): string {
  const normalizedError = typeof error === 'string' ? error.trim() : '';
  if (!normalizedError) {
    return `Native host not connected. Install Browser Bridge with npm or a standalone binary, then run ${installCommand} to register this browser.`;
  }

  if (
    /native messaging host not found|specified native messaging host not found|forbidden/i.test(
      normalizedError
    )
  ) {
    return `Native host not connected. Run ${installCommand} to register this browser. Details: ${normalizedError}`;
  }

  if (
    /bridge\.sock|ENOENT|ECONNREFUSED|daemon|native host has exited|host exited/i.test(
      normalizedError
    )
  ) {
    return `Native host unreachable for 10s. Last error: ${normalizedError} Run: bbx-daemon or bbx doctor`;
  }

  return `Native host unreachable for 10s. Last error: ${normalizedError} Run: bbx doctor`;
}

export function normalizeSidepanelToggleError(errorMessage: string): string {
  const friendly = errorMessage.replace(/^CONTENT_SCRIPT_UNAVAILABLE:\s*/i, '');
  if (friendly === 'TAB_MISMATCH') {
    return 'This tab is no longer available. Switch to an open tab and try again.';
  }
  if (friendly === 'ACCESS_DENIED') {
    return 'Browser Bridge is off for this window.';
  }
  return friendly;
}

export function getSidepanelCurrentTabView(
  currentTab: SidepanelCurrentTab | null
): SidepanelCurrentTabViewState {
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

export function getSidepanelAgentStatusView(
  currentTab: SidepanelCurrentTab | null
): SidepanelAgentStatusViewState {
  if (!currentTab) {
    return {
      title: 'Window access unavailable',
      detail: 'Open a normal web page in this browser window to enable Browser Bridge.',
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
      detail: 'Agents can access every tab in this window.',
      disclosureHidden: true,
    };
  }

  if (currentTab.accessRequested) {
    const context = currentTab.accessRequestContext;
    const source = getActivitySourceTag(context?.source, context?.mcpEra) || 'A connected agent';
    const intent = context?.intent === 'general' || !context?.intent ? 'use' : context.intent;
    return {
      title: 'Window access requested',
      detail: `${source} requested access to ${intent} pages in this browser window.`,
      disclosureHidden: false,
    };
  }

  return {
    title: 'Window access',
    detail: 'Allow agents to inspect and interact with the tabs.',
    disclosureHidden: true,
  };
}

export function getPromptExamplesGroups(
  setupStatus: SetupStatusInstallState | null,
  cliPromptExamples: readonly string[],
  mcpPromptExamples: readonly string[]
): PromptExamplesGroup[] {
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

export function getPromptExamplesRenderGroups(
  setupStatus: SetupStatusInstallState | null,
  cliPromptExamples: readonly string[],
  mcpPromptExamples: readonly string[]
): PromptExamplesRenderGroup[] {
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

/** Diagnostic shown when the native host connection keeps dropping and
reconnecting (crash-looping daemon) instead of being merely offline. */
export function getUnstableConnectionDiagnostic(): string {
  return 'Connection to the local host keeps dropping - the bridge daemon appears to be restarting repeatedly. Run `bbx doctor` in a terminal for the cause and fix steps.';
}

export function getSidepanelNativeStatusView({
  connected,
  error,
  runtimeId,
  publishedExtensionId,
  fallbackInstallCommand = 'bbx install',
}: {
  connected: boolean;
  error?: string;
  runtimeId: string;
  publishedExtensionId: string;
  fallbackInstallCommand?: string;
}): SidepanelNativeStatusView {
  const installCommand =
    runtimeId === publishedExtensionId ? 'bbx install' : `bbx install ${runtimeId}`;
  return {
    hidden: connected,
    installCommand,
    skillCommand: 'bbx install-skill',
    mcpCommand: 'bbx install-mcp',
    label: connected ? 'Native host connected' : error || 'Native host disconnected',
    diagnosticCommand: connected ? installCommand : installCommand || fallbackInstallCommand,
    diagnosticMessage: getNativeDiagnosticMessage(
      connected ? undefined : error,
      connected ? installCommand : installCommand || fallbackInstallCommand
    ),
  };
}

export function syncSetupStatusPolling({
  connected,
  installationHidden,
  installationOpen,
  currentTimer,
  pollMs,
  refresh,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}: {
  connected: boolean;
  installationHidden: boolean;
  installationOpen: boolean;
  currentTimer: ReturnType<typeof setInterval> | null;
  pollMs: number;
  refresh: () => void;
  setIntervalFn?: IntervalScheduler;
  clearIntervalFn?: typeof clearInterval;
}): ReturnType<typeof setInterval> | null {
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

export function getInstallKey(kind: 'mcp' | 'skill', target: string): string {
  return `${kind}:${target}`;
}

export function createSetupInstallMessage(
  kind: 'mcp' | 'skill',
  target: string,
  action: 'install' | 'uninstall' = 'install'
): {
  type: 'setup.install';
  action: 'install' | 'uninstall';
  kind: 'mcp' | 'skill';
  target: string;
} {
  return {
    type: 'setup.install',
    action,
    kind,
    target,
  };
}

function isMcpClientSetupState(
  entry: McpClientInstallState | McpClientSetupState
): entry is McpClientSetupState {
  return 'key' in entry;
}

function shouldRenderMcpClientRow(entry: McpClientSetupState): boolean {
  return entry.detected || entry.configured || entry.key === 'agents';
}

function isSkillTargetSetupState(
  entry: SkillTargetInstallState | SkillTargetSetupState
): entry is SkillTargetSetupState {
  return 'key' in entry;
}

function shouldRenderSkillTargetRow(entry: SkillTargetSetupState): boolean {
  return entry.detected || entry.installed || entry.skills.some((skill) => skill.exists);
}

function createSkillCellTitle(entry: SkillTargetSetupState): string {
  if (entry.installedVersion && entry.currentVersion) {
    return `${entry.basePath}\nInstalled with ${MANAGED_CLIENT_PACKAGE} ${entry.installedVersion}\nCurrent ${MANAGED_CLIENT_PACKAGE} ${entry.currentVersion}`;
  }
  if (entry.currentVersion) {
    return `${entry.basePath}\nCurrent ${MANAGED_CLIENT_PACKAGE} ${entry.currentVersion}`;
  }
  return entry.basePath;
}

function getSkillUninstallLabel(_entry: SkillTargetSetupState): string {
  return 'Uninstall CLI skill';
}

function getSkillReinstallLabel(_entry: SkillTargetSetupState): string {
  return 'Re-install CLI skill';
}
