// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSetupMatrixRows,
  createSetupInstallMessage,
  getActivitySourceTag,
  getInstallKey,
  getMcpSetupCellState,
  getPromptExamplesGroups,
  getPromptExamplesRenderGroups,
  getPromptExamplesMode,
  getSidepanelAgentStatusView,
  getSidepanelCurrentTabView,
  getSidepanelNativeStatusView,
  getSetupStatusView,
  getSkillSetupCellState,
  isSetupMatrixBetaKey,
  normalizeSidepanelToggleError,
  shouldPollSetupStatus,
  shouldAutoExpandHostSetup,
  syncSetupStatusPolling,
} from '../src/sidepanel-helpers.js';

test('getSetupStatusView renders loading and unavailable setup states', () => {
  assert.deepEqual(getSetupStatusView(null, true, null, null), {
    summaryNote: '',
    summaryHidden: true,
    note: 'Checking global host setup…',
    noteHidden: false,
    placeholder: 'Checking detected clients…',
    rows: [],
    autoExpandHostSetup: false,
  });

  assert.deepEqual(getSetupStatusView(null, false, 'native unavailable', 'install failed'), {
    summaryNote: '',
    summaryHidden: true,
    note: 'install failed',
    noteHidden: false,
    placeholder: 'No host setup status yet.',
    rows: [],
    autoExpandHostSetup: false,
  });
});

test('getSetupStatusView summarizes scope, install errors, and auto-expand state', () => {
  const setupStatus = {
    scope: /** @type {'local'} */ ('local'),
    mcpClients: [
      {
        key: 'cursor',
        label: 'Cursor',
        detected: true,
        configPath: '/configs/cursor.json',
        configured: false,
      },
    ],
    skillTargets: [
      {
        key: 'cursor',
        label: 'Cursor',
        detected: true,
        basePath: '/skills/cursor',
        installed: false,
        managed: false,
        installedVersion: null,
        currentVersion: null,
        updateAvailable: false,
        skills: [],
      },
    ],
  };

  assert.deepEqual(getSetupStatusView(setupStatus, false, 'ignored', 'permission denied'), {
    summaryNote: '* Project installs only',
    summaryHidden: false,
    note: 'Last install failed: permission denied',
    noteHidden: false,
    placeholder: null,
    rows: [
      {
        key: 'cursor',
        label: 'Cursor',
        mcpClient: setupStatus.mcpClients[0],
        skillTarget: setupStatus.skillTargets[0],
      },
    ],
    autoExpandHostSetup: true,
  });
});

test('buildSetupMatrixRows filters unsupported entries and preserves preferred order', () => {
  assert.deepEqual(
    buildSetupMatrixRows({
      mcpClients: [
        {
          key: 'zzz',
          label: 'ZZZ',
          detected: true,
          configPath: '/configs/zzz.json',
          configured: false,
        },
        {
          key: 'claude',
          label: 'Claude',
          detected: true,
          configPath: '/configs/claude.json',
          configured: true,
        },
        {
          key: 'hidden',
          label: 'Hidden',
          detected: false,
          configPath: '/configs/hidden.json',
          configured: false,
        },
      ],
      skillTargets: [
        {
          key: 'windsurf',
          label: 'Windsurf',
          detected: true,
          basePath: '/skills/windsurf',
          installed: false,
          managed: false,
          installedVersion: null,
          currentVersion: null,
          updateAvailable: false,
          skills: [],
        },
        {
          key: 'hidden-skill',
          label: 'Hidden Skill',
          detected: false,
          basePath: '/skills/hidden',
          installed: false,
          managed: false,
          installedVersion: null,
          currentVersion: null,
          updateAvailable: false,
          skills: [],
        },
      ],
    }).map((row) => row.key),
    ['claude', 'windsurf', 'zzz']
  );
});

test('getMcpSetupCellState covers agents fallback, installed badges, and pending installs', () => {
  assert.deepEqual(
    getMcpSetupCellState(
      {
        key: 'agents',
        label: 'Generic Agents',
        mcpClient: null,
        skillTarget: null,
      },
      getInstallKey('mcp', 'agents')
    ),
    {
      kind: 'button',
      setupKind: 'mcp',
      target: 'agents',
      pending: true,
      variant: 'install',
      label: 'Install',
      pendingLabel: '...',
      title: 'Install Browser Bridge MCP for generic agents',
    }
  );

  assert.deepEqual(
    getMcpSetupCellState(
      {
        key: 'cursor',
        label: 'Cursor',
        mcpClient: {
          key: 'cursor',
          label: 'Cursor',
          detected: true,
          configPath: '/configs/cursor.json',
          configured: true,
        },
        skillTarget: null,
      },
      null
    ),
    {
      kind: 'badge',
      label: 'Installed',
      ok: true,
      title: '/configs/cursor.json',
      contextAction: {
        kind: 'mcp',
        target: 'cursor',
        copyLabel: 'Copy MCP config path',
        copyText: '/configs/cursor.json',
        reinstallLabel: 'Re-install MCP',
        uninstallLabel: 'Uninstall MCP',
      },
    }
  );
});

test('getSkillSetupCellState covers custom, installed, update, and install variants', () => {
  const baseRow = {
    key: 'cursor',
    label: 'Cursor',
    mcpClient: null,
  };

  assert.deepEqual(
    getSkillSetupCellState(
      {
        ...baseRow,
        skillTarget: {
          key: 'cursor',
          label: 'Cursor',
          detected: true,
          basePath: '/skills/custom',
          installed: true,
          managed: false,
          installedVersion: null,
          currentVersion: null,
          updateAvailable: false,
          skills: [{ exists: true, managed: false }],
        },
      },
      null
    ),
    {
      kind: 'badge',
      label: 'Custom',
      ok: false,
      title: '/skills/custom',
      contextAction: {
        kind: 'skill',
        target: 'cursor',
        copyLabel: 'Copy CLI skill folder path',
        copyText: '/skills/custom',
      },
    }
  );

  assert.deepEqual(
    getSkillSetupCellState(
      {
        ...baseRow,
        skillTarget: {
          key: 'cursor',
          label: 'Cursor',
          detected: true,
          basePath: '/skills/cursor',
          installed: true,
          managed: true,
          installedVersion: '1.0.0',
          currentVersion: '1.0.0',
          updateAvailable: false,
          skills: [{ exists: true, managed: true }],
        },
      },
      null
    ),
    {
      kind: 'badge',
      label: 'Installed',
      ok: true,
      title: '/skills/cursor\nInstalled with bbx 1.0.0\nCurrent bbx 1.0.0',
      contextAction: {
        kind: 'skill',
        target: 'cursor',
        copyLabel: 'Copy CLI skill folder path',
        copyText: '/skills/cursor',
        reinstallLabel: 'Re-install CLI skill',
        uninstallLabel: 'Uninstall CLI skill',
      },
    }
  );

  assert.deepEqual(
    getSkillSetupCellState(
      {
        ...baseRow,
        skillTarget: {
          key: 'cursor',
          label: 'Cursor',
          detected: true,
          basePath: '/skills/cursor',
          installed: true,
          managed: true,
          installedVersion: '1.0.0',
          currentVersion: '1.2.0',
          updateAvailable: true,
          skills: [{ exists: true, managed: true }],
        },
      },
      getInstallKey('skill', 'cursor')
    ),
    {
      kind: 'button',
      setupKind: 'skill',
      target: 'cursor',
      pending: true,
      variant: 'update',
      label: 'Update',
      pendingLabel: 'Updating…',
      title: '/skills/cursor\nInstalled with bbx 1.0.0\nCurrent bbx 1.2.0',
      contextAction: {
        kind: 'skill',
        target: 'cursor',
        copyLabel: 'Copy CLI skill folder path',
        copyText: '/skills/cursor',
        reinstallLabel: 'Re-install CLI skill',
        uninstallLabel: 'Uninstall CLI skill',
      },
    }
  );

  assert.deepEqual(
    getSkillSetupCellState(
      {
        ...baseRow,
        skillTarget: {
          key: 'cursor',
          label: 'Cursor',
          detected: true,
          basePath: '/skills/cursor',
          installed: false,
          managed: false,
          installedVersion: null,
          currentVersion: null,
          updateAvailable: false,
          skills: [],
        },
      },
      null
    ),
    {
      kind: 'button',
      setupKind: 'skill',
      target: 'cursor',
      pending: false,
      variant: 'install',
      label: 'Install',
      pendingLabel: '...',
      title: '/skills/cursor',
    }
  );
});

test('sidepanel install and polling helpers normalize action messages and refresh conditions', () => {
  assert.equal(isSetupMatrixBetaKey('agents'), true);
  assert.equal(isSetupMatrixBetaKey('cursor'), false);

  assert.equal(shouldPollSetupStatus(true, false, true), true);
  assert.equal(shouldPollSetupStatus(false, false, true), false);
  assert.equal(shouldPollSetupStatus(true, true, true), false);
  assert.equal(shouldPollSetupStatus(true, false, false), false);

  assert.equal(getInstallKey('mcp', 'cursor'), 'mcp:cursor');
  assert.deepEqual(createSetupInstallMessage('skill', 'cursor'), {
    type: 'setup.install',
    action: 'install',
    kind: 'skill',
    target: 'cursor',
  });
  assert.deepEqual(createSetupInstallMessage('mcp', 'cursor', 'uninstall'), {
    type: 'setup.install',
    action: 'uninstall',
    kind: 'mcp',
    target: 'cursor',
  });
});

test('shouldAutoExpandHostSetup returns true when no MCP or CLI skill is installed', () => {
  assert.equal(
    shouldAutoExpandHostSetup({
      mcpClients: [{ configured: false }, { configured: false }],
      skillTargets: [{ skills: [{ exists: false }, { exists: false }] }, { skills: [] }],
    }),
    true
  );
});

test('shouldAutoExpandHostSetup returns false when any MCP client is configured', () => {
  assert.equal(
    shouldAutoExpandHostSetup({
      mcpClients: [{ configured: false }, { configured: true }],
      skillTargets: [{ skills: [{ exists: false }] }],
    }),
    false
  );
});

test('shouldAutoExpandHostSetup returns false when any CLI skill exists', () => {
  assert.equal(
    shouldAutoExpandHostSetup({
      mcpClients: [{ configured: false }],
      skillTargets: [{ skills: [{ exists: false }] }, { skills: [{ exists: true }] }],
    }),
    false
  );
});

test('getPromptExamplesMode returns grouped when setup status is unavailable', () => {
  assert.equal(getPromptExamplesMode(null), 'grouped');
});

test('getPromptExamplesMode returns mcp when only MCP is configured', () => {
  assert.equal(
    getPromptExamplesMode({
      mcpClients: [{ configured: true }],
      skillTargets: [{ skills: [{ exists: false }] }],
    }),
    'mcp'
  );
});

test('getPromptExamplesMode returns cli when only CLI skill exists', () => {
  assert.equal(
    getPromptExamplesMode({
      mcpClients: [{ configured: false }],
      skillTargets: [{ skills: [{ exists: true }] }],
    }),
    'cli'
  );
});

test('getPromptExamplesMode returns grouped when both MCP and CLI skill exist', () => {
  assert.equal(
    getPromptExamplesMode({
      mcpClients: [{ configured: true }],
      skillTargets: [{ skills: [{ exists: true }] }],
    }),
    'grouped'
  );
});

test('getActivitySourceTag prefers explicit source metadata', () => {
  assert.equal(getActivitySourceTag('mcp', null), 'mcp');
  assert.equal(
    getActivitySourceTag('cli', {
      mcpClients: [{ configured: true }],
      skillTargets: [{ skills: [{ exists: true }] }],
    }),
    'cli'
  );
});

test('getActivitySourceTag infers MCP when only MCP is configured', () => {
  assert.equal(
    getActivitySourceTag('', {
      mcpClients: [{ configured: true }],
      skillTargets: [{ skills: [{ exists: false }] }],
    }),
    'mcp'
  );
});

test('getActivitySourceTag infers CLI when only CLI skill is installed', () => {
  assert.equal(
    getActivitySourceTag('', {
      mcpClients: [{ configured: false }],
      skillTargets: [{ skills: [{ exists: true }] }],
    }),
    'cli'
  );
});

test('getActivitySourceTag does not guess when setup is ambiguous', () => {
  assert.equal(getActivitySourceTag('', null), '');
  assert.equal(
    getActivitySourceTag('', {
      mcpClients: [{ configured: true }],
      skillTargets: [{ skills: [{ exists: true }] }],
    }),
    ''
  );
});

test('normalizeSidepanelToggleError maps known toggle failures to user-visible messages', () => {
  assert.equal(
    normalizeSidepanelToggleError(
      'CONTENT_SCRIPT_UNAVAILABLE: Content script not available on this page'
    ),
    'Content script not available on this page'
  );
  assert.equal(
    normalizeSidepanelToggleError('TAB_MISMATCH'),
    'This tab is no longer available. Switch to an open tab and try again.'
  );
  assert.equal(
    normalizeSidepanelToggleError('ACCESS_DENIED'),
    'Browser Bridge is off for this window.'
  );
  assert.equal(normalizeSidepanelToggleError('Something went wrong.'), 'Something went wrong.');
});

test('getSidepanelCurrentTabView returns unavailable, restricted, and attention states', () => {
  assert.deepEqual(getSidepanelCurrentTabView(null), {
    buttonLabel: 'Window Access Unavailable',
    buttonDisabled: true,
    buttonEnabled: false,
    attention: false,
    errorMessage: null,
  });

  assert.deepEqual(
    getSidepanelCurrentTabView({
      tabId: 10,
      windowId: 2,
      title: 'Chrome Web Store',
      url: 'https://chromewebstore.google.com',
      enabled: true,
      accessRequested: false,
      restricted: true,
    }),
    {
      buttonLabel: 'Disable Window Access',
      buttonDisabled: false,
      buttonEnabled: true,
      attention: false,
      errorMessage:
        'This page cannot be interacted with. Switch to a normal web page to inspect and interact.',
    }
  );

  assert.deepEqual(
    getSidepanelCurrentTabView({
      tabId: 11,
      windowId: 3,
      title: 'Example',
      url: 'https://example.com',
      enabled: false,
      accessRequested: true,
      restricted: false,
    }),
    {
      buttonLabel: 'Enable Window Access',
      buttonDisabled: false,
      buttonEnabled: false,
      attention: true,
      errorMessage: null,
    }
  );
});

test('getSidepanelAgentStatusView covers unavailable, enabled, requested, and default states', () => {
  assert.deepEqual(getSidepanelAgentStatusView(null), {
    title: 'Window access unavailable',
    detail: 'Open a normal web page in this Chrome window to enable Browser Bridge.',
    disclosureHidden: false,
  });

  assert.deepEqual(
    getSidepanelAgentStatusView({
      tabId: 12,
      windowId: 4,
      title: 'Example',
      url: 'https://example.com',
      enabled: true,
      accessRequested: false,
      restricted: false,
    }),
    {
      title: 'Window access enabled',
      detail:
        'Browser Bridge is enabled for this Chrome window. Requests default to the active tab, or can target another tab in this window explicitly.',
      disclosureHidden: true,
    }
  );

  assert.deepEqual(
    getSidepanelAgentStatusView({
      tabId: 13,
      windowId: 5,
      title: 'Pending',
      url: 'https://example.com',
      enabled: false,
      accessRequested: true,
      restricted: false,
    }),
    {
      title: 'Window access requested',
      detail:
        'An agent requested access for this Chrome window. Enable it to allow page inspection and interaction.',
      disclosureHidden: false,
    }
  );

  assert.deepEqual(
    getSidepanelAgentStatusView({
      tabId: 14,
      windowId: 6,
      title: 'Disabled',
      url: 'https://example.com',
      enabled: false,
      accessRequested: false,
      restricted: false,
    }),
    {
      title: 'Window access',
      detail:
        'Enable Browser Bridge to let your connected agent inspect and interact with pages in this Chrome window.',
      disclosureHidden: false,
    }
  );
});

test('getPromptExamplesGroups handles empty setup status gracefully', () => {
  assert.deepEqual(getPromptExamplesGroups(null, ['cli one'], ['mcp one']), [
    { title: 'CLI skill', prompts: ['cli one'] },
    { title: 'MCP', prompts: ['mcp one'] },
  ]);
});

test('getPromptExamplesRenderGroups expands prompt metadata for UI copy buttons', () => {
  assert.deepEqual(getPromptExamplesRenderGroups(null, ['cli one'], ['mcp one']), [
    {
      title: 'CLI skill',
      prompts: [{ copyPrompt: 'cli one', copyLabel: 'Copy prompt: cli one' }],
    },
    {
      title: 'MCP',
      prompts: [{ copyPrompt: 'mcp one', copyLabel: 'Copy prompt: mcp one' }],
    },
  ]);
});

test('getSidepanelNativeStatusView derives install commands and disconnected labels', () => {
  assert.deepEqual(
    getSidepanelNativeStatusView({
      connected: false,
      error: 'bridge down',
      runtimeId: 'dev-extension-id',
      publishedExtensionId: 'jjjkmmcdkpcgamlopogicbnnhdgebhie',
      fallbackInstallCommand: 'bbx install',
    }),
    {
      hidden: false,
      installCommand: 'bbx install dev-extension-id',
      skillCommand: 'bbx install-skill',
      mcpCommand: 'bbx install-mcp',
      label: 'bridge down',
      diagnosticCommand: 'bbx install dev-extension-id',
      diagnosticMessage: 'Native host unreachable for 10s. Last error: bridge down Run: bbx doctor',
    }
  );

  assert.deepEqual(
    getSidepanelNativeStatusView({
      connected: true,
      runtimeId: 'jjjkmmcdkpcgamlopogicbnnhdgebhie',
      publishedExtensionId: 'jjjkmmcdkpcgamlopogicbnnhdgebhie',
    }),
    {
      hidden: true,
      installCommand: 'bbx install',
      skillCommand: 'bbx install-skill',
      mcpCommand: 'bbx install-mcp',
      label: 'Native host connected',
      diagnosticCommand: 'bbx install',
      diagnosticMessage:
        'Native host unreachable for 10s. Run: npm install -g @browserbridge/bbx && bbx install',
    }
  );
});

test('getSidepanelNativeStatusView points daemon failures at bbx-daemon', () => {
  assert.equal(
    getSidepanelNativeStatusView({
      connected: false,
      error: 'connect ENOENT C:\\Users\\andrew\\AppData\\Local\\Browser Bridge\\bridge.sock',
      runtimeId: 'dev-extension-id',
      publishedExtensionId: 'jjjkmmcdkpcgamlopogicbnnhdgebhie',
    }).diagnosticMessage,
    'Native host unreachable for 10s. Last error: connect ENOENT C:\\Users\\andrew\\AppData\\Local\\Browser Bridge\\bridge.sock Run: bbx-daemon or bbx doctor'
  );
});

test('syncSetupStatusPolling cancels prior interval when polling should stop', () => {
  /** @type {Array<Parameters<typeof clearInterval>[0]>} */
  const cleared = [];
  const existingTimer = /** @type {ReturnType<typeof setInterval>} */ (
    /** @type {unknown} */ ({ id: 'timer-1' })
  );

  const nextTimer = syncSetupStatusPolling({
    connected: false,
    installationHidden: false,
    installationOpen: true,
    currentTimer: existingTimer,
    pollMs: 15_000,
    refresh: () => {
      throw new Error('refresh should not run');
    },
    clearIntervalFn: (timer) => {
      cleared.push(timer);
    },
  });

  assert.equal(nextTimer, null);
  assert.deepEqual(cleared, [existingTimer]);
});

test('syncSetupStatusPolling starts polling once and reuses an existing interval', () => {
  /** @type {string[]} */
  const refreshCalls = [];
  /** @type {{ callback: (() => void) | null, delay: number | null }} */
  const scheduled = { callback: null, delay: null };
  const createdTimer = /** @type {ReturnType<typeof setInterval>} */ (
    /** @type {unknown} */ ({ id: 'timer-2' })
  );

  const firstTimer = syncSetupStatusPolling({
    connected: true,
    installationHidden: false,
    installationOpen: true,
    currentTimer: null,
    pollMs: 15_000,
    refresh: () => {
      refreshCalls.push('refresh');
    },
    setIntervalFn:
      /** @type {(callback: () => void, delay?: number) => ReturnType<typeof setInterval>} */ (
        (callback, delay) => {
          scheduled.callback = callback;
          scheduled.delay = delay ?? null;
          return createdTimer;
        }
      ),
  });

  assert.equal(firstTimer, createdTimer);
  assert.deepEqual(refreshCalls, ['refresh']);
  assert.equal(scheduled.delay, 15_000);
  assert.ok(typeof scheduled.callback === 'function');

  scheduled.callback?.();
  assert.deepEqual(refreshCalls, ['refresh', 'refresh']);

  const reusedTimer = syncSetupStatusPolling({
    connected: true,
    installationHidden: false,
    installationOpen: true,
    currentTimer: createdTimer,
    pollMs: 15_000,
    refresh: () => {
      refreshCalls.push('unexpected');
    },
    setIntervalFn: () => {
      throw new Error('should not create a second interval');
    },
  });

  assert.equal(reusedTimer, createdTimer);
  assert.deepEqual(refreshCalls, ['refresh', 'refresh']);
});
