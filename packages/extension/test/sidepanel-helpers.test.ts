import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSetupMatrixRows,
  createSetupInstallMessage,
  formatTabActivityAge,
  getAgentTabsInlineHeight,
  getActivitySourcePills,
  getActivitySourceTag,
  getInstallKey,
  getMcpSetupCellState,
  getNpmInstallCommand,
  getPromptExamplesGroups,
  getPromptExamplesRenderGroups,
  getPromptExamplesMode,
  getSidepanelAgentStatusView,
  getSidepanelCurrentTabView,
  getSidepanelNativeStatusView,
  getSetupStatusView,
  getSkillSetupCellState,
  getStandaloneInstallView,
  getVersionMismatchView,
  normalizeSidepanelToggleError,
  shouldPollSetupStatus,
  shouldAutoExpandHostSetup,
  syncSetupStatusPolling,
} from '../src/sidepanel-helpers.js';

type SetupStatus = NonNullable<Parameters<typeof getSetupStatusView>[0]>;

test('npm setup targets the extension major-minor release line', () => {
  assert.equal(getNpmInstallCommand('2.3.4'), 'npm install -g @browserbridge/bbx@2.3');
  assert.equal(getNpmInstallCommand('2.3'), 'npm install -g @browserbridge/bbx@2.3');
  assert.equal(getNpmInstallCommand('0.8.1.4'), 'npm install -g @browserbridge/bbx@0.8');
  assert.equal(getNpmInstallCommand('invalid'), 'npm install -g @browserbridge/bbx');
});

test('standalone setup selects the GitHub installer and passes the version and extension ID', () => {
  const runtimeId = 'a'.repeat(32);
  for (const [os, arch, label] of [
    ['mac', 'arm64', 'macOS arm64 · Run in Terminal'],
    ['mac', 'arm', 'macOS arm64 · Run in Terminal'],
    ['mac', 'x86-64', 'macOS x64 · Run in Terminal'],
    ['linux', 'arm', 'Linux arm64 · Run in Terminal'],
    ['linux', 'arm64', 'Linux arm64 · Run in Terminal'],
    ['linux', 'x86-64', 'Linux x64 · Run in Terminal'],
    ['win', 'x86-64', 'Windows x64 · Run in PowerShell'],
  ]) {
    const view = getStandaloneInstallView('2.3.4', { os, arch }, runtimeId);
    assert.ok(view);
    assert.equal(view.label, label);
    if (os === 'win') {
      assert.equal(
        view.command,
        `& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/koltyakov/browser-bridge/main/scripts/install.ps1'))) -Version '2.3.4' -ExtensionId '${runtimeId}'`
      );
    } else {
      assert.equal(
        view.command,
        `curl -fsSL https://raw.githubusercontent.com/koltyakov/browser-bridge/main/scripts/install.sh | BBX_VERSION=2.3.4 BBX_EXTENSION_ID=${runtimeId} sh`
      );
    }
  }
});

test('standalone setup falls back to links for unsupported or invalid inputs', () => {
  const id = 'b'.repeat(32);
  for (const platform of [
    { os: 'win', arch: 'arm64' },
    { os: 'linux', arch: 'x86-32' },
    { os: 'cros', arch: 'x86-64' },
  ]) {
    assert.equal(getStandaloneInstallView('2.3.4', platform, id), null);
  }
  assert.equal(getStandaloneInstallView('invalid', { os: 'mac', arch: 'arm64' }, id), null);
  assert.equal(getStandaloneInstallView('2.3.4', { os: 'mac', arch: 'arm64' }, "';bad"), null);
});

test('standalone setup omits the extension override for the Chrome Web Store installation', () => {
  const publishedId = 'jjjkmmcdkpcgamlopogicbnnhdgebhie';
  for (const os of ['mac', 'linux']) {
    const view = getStandaloneInstallView('2.3.4', { os, arch: 'x86-64' }, publishedId);
    assert.equal(
      view?.command,
      'curl -fsSL https://raw.githubusercontent.com/koltyakov/browser-bridge/main/scripts/install.sh | BBX_VERSION=2.3.4 sh'
    );
  }
  const windows = getStandaloneInstallView('2.3.4', { os: 'win', arch: 'x86-64' }, publishedId);
  assert.equal(
    windows?.command,
    "& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/koltyakov/browser-bridge/main/scripts/install.ps1'))) -Version '2.3.4'"
  );
});

test('active tabs use inline space only when enough tab rows remain usable', () => {
  assert.equal(getAgentTabsInlineHeight(500, 174), 174);
  assert.equal(getAgentTabsInlineHeight(150, 500), 150);
  assert.equal(getAgentTabsInlineHeight(100, 500), 100);
  assert.equal(getAgentTabsInlineHeight(60, 500), null);
  assert.equal(getAgentTabsInlineHeight(50, 45), 45);
  assert.equal(getAgentTabsInlineHeight(-1, 174), null);
  assert.equal(getAgentTabsInlineHeight(500, 0), null);
  assert.equal(getAgentTabsInlineHeight(Number.NaN, 174), null);
  assert.equal(getAgentTabsInlineHeight(500, Number.NaN), null);
});

test('tab activity age uses compact minute/second labels and handles missing timestamps', () => {
  const at = 1_000_000;
  assert.equal(formatTabActivityAge(at, at), '<1m');
  assert.equal(formatTabActivityAge(at, at + 1_999), '<1m');
  assert.equal(formatTabActivityAge(at, at + 59_999), '<1m');
  assert.equal(formatTabActivityAge(at, at + 60_000), '1m 0s');
  assert.equal(formatTabActivityAge(at, at + 61_000), '1m 1s');
  assert.equal(formatTabActivityAge(at, at + 3_661_000), '61m 1s');
  assert.equal(formatTabActivityAge(at, at - 1_000), '<1m');
  assert.equal(formatTabActivityAge(undefined, at), '');
  assert.equal(formatTabActivityAge(0, at), '');
  assert.equal(formatTabActivityAge(Number.NaN, at), '');
  assert.equal(formatTabActivityAge(at, Number.NaN), '');
  assert.equal(formatTabActivityAge(Date.now()), '<1m');
});

test('getVersionMismatchView accepts independent minor releases and warns on major drift', () => {
  assert.equal(getVersionMismatchView('1.8.1', '1.8.9'), null);
  assert.equal(getVersionMismatchView('1.8', '1.8.0'), null);
  assert.equal(getVersionMismatchView('invalid', '1.8.0'), null);
  assert.equal(getVersionMismatchView('1.8.1', '1.7.9'), null);
  assert.deepEqual(getVersionMismatchView('2.0.0', '1.8.1'), {
    key: '2.0.0:1.8.1',
    message:
      'CLI v1.8.1 and extension v2.0.0 use different protocol versions. Update the CLI and extension to compatible releases.',
  });
});

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
  const setupStatus: SetupStatus = {
    scope: 'local',
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
      title:
        '/skills/cursor\nInstalled with @browserbridge/bbx 1.0.0\nCurrent @browserbridge/bbx 1.0.0',
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
      title:
        '/skills/cursor\nInstalled with @browserbridge/bbx 1.0.0\nCurrent @browserbridge/bbx 1.2.0',
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

test('shouldAutoExpandHostSetup returns false when unknown MCP client is configured', () => {
  assert.equal(
    shouldAutoExpandHostSetup({
      mcpClients: [{ configured: false }, { configured: true }],
      skillTargets: [{ skills: [{ exists: false }] }],
    }),
    false
  );
});

test('shouldAutoExpandHostSetup returns false when unknown CLI skill exists', () => {
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
  assert.equal(getActivitySourceTag('mcp', null), 'MCP');
  assert.equal(getActivitySourceTag('mcp', 'legacy'), 'MCP Legacy');
  assert.equal(getActivitySourceTag('mcp', 'modern'), 'MCP Modern');
  assert.equal(getActivitySourceTag('cli', 'modern'), 'CLI');
});

test('getActivitySourcePills splits MCP source and protocol version', () => {
  assert.deepEqual(getActivitySourcePills('mcp', null), { source: 'MCP', version: '' });
  assert.deepEqual(getActivitySourcePills('mcp', 'legacy'), { source: 'MCP', version: 'v1' });
  assert.deepEqual(getActivitySourcePills('mcp', 'modern'), { source: 'MCP', version: 'v2' });
  assert.deepEqual(getActivitySourcePills('cli', 'modern'), { source: 'CLI', version: '' });
  assert.deepEqual(getActivitySourcePills('other', 'modern'), { source: '', version: '' });
});

test('getActivitySourceTag leaves missing source metadata unlabelled', () => {
  assert.equal(getActivitySourceTag('', null), '');
});

test('getActivitySourceTag ignores an era without an MCP source', () => {
  assert.equal(getActivitySourceTag('other', 'modern'), '');
});

test('getActivitySourceTag does not guess unknown source values', () => {
  assert.equal(getActivitySourceTag('', null), '');
  assert.equal(getActivitySourceTag('', 'modern'), '');
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
      accessRequestContext: {
        windowId: 5,
        tabId: 13,
        source: 'cli',
        intent: 'capture',
        title: 'Pending',
        origin: 'https://example.com',
      },
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
    detail: 'Open a normal web page in this browser window to enable Browser Bridge.',
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
      detail: 'Agents can access every tab in this window.',
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
      accessRequestContext: {
        windowId: 5,
        tabId: 13,
        source: 'cli',
        intent: 'capture',
        title: 'Pending',
        origin: 'https://example.com',
      },
    }),
    {
      title: 'Window access requested',
      detail: 'CLI requested access to capture pages in this browser window.',
      disclosureHidden: false,
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
      accessRequestContext: {
        windowId: 5,
        tabId: 13,
        source: 'mcp',
        mcpEra: 'legacy',
        intent: 'inspect',
        title: 'Pending',
        origin: 'https://example.com',
      },
    }),
    {
      title: 'Window access requested',
      detail: 'MCP Legacy requested access to inspect pages in this browser window.',
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
      detail: 'Allow agents to inspect and interact with the tabs.',
      disclosureHidden: true,
    }
  );
});

test('access-request notices omit page metadata and unavailable-tab fallback text', () => {
  for (const context of [
    undefined,
    { title: '', origin: '' },
    { title: 'Private page', origin: 'https://private.example' },
  ]) {
    const view = getSidepanelAgentStatusView({
      tabId: 13,
      windowId: 5,
      title: 'Private page',
      url: 'https://private.example/path',
      enabled: false,
      accessRequested: true,
      restricted: false,
      ...(context
        ? {
            accessRequestContext: {
              windowId: 5,
              tabId: 13,
              source: 'cli',
              intent: 'general',
              ...context,
            },
          }
        : {}),
    });
    assert.equal(
      view.detail,
      context
        ? 'CLI requested access to use pages in this browser window.'
        : 'A connected agent requested access to use pages in this browser window.'
    );
    assert.equal(view.disclosureHidden, false);
  }
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
        'Native host not connected. Install Browser Bridge with npm or a standalone binary, then run bbx install to register this browser.',
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
  const cleared: Array<Parameters<typeof clearInterval>[0]> = [];
  const existingTimer = { id: 'timer-1' } as unknown as ReturnType<typeof setInterval>;

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
  const refreshCalls: string[] = [];
  const scheduled: { callback: (() => void) | null; delay: number | null } = {
    callback: null,
    delay: null,
  };
  const createdTimer = { id: 'timer-2' } as unknown as ReturnType<typeof setInterval>;

  const firstTimer = syncSetupStatusPolling({
    connected: true,
    installationHidden: false,
    installationOpen: true,
    currentTimer: null,
    pollMs: 15_000,
    refresh: () => {
      refreshCalls.push('refresh');
    },
    setIntervalFn: (callback: () => void, delay?: number) => {
      scheduled.callback = callback;
      scheduled.delay = delay ?? null;
      return createdTimer;
    },
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
