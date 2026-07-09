import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { BRIDGE_METHOD_REGISTRY } from '../../protocol/src/index.js';
import { CLI_METHOD_BINDINGS } from '../src/command-registry.js';
import { detectMcpClients, detectSkillTargets } from '../src/detect.js';
import { findConfiguredMcpClients, installMcpConfig, removeMcpConfig } from '../src/mcp-config.js';
import os from 'node:os';
import path from 'node:path';

import { BridgeClient } from '../src/client.js';
import { getDoctorReport, requestBridge, resolveRef, withBridgeClient } from '../src/runtime.js';
import type { BridgeResponse } from '../../protocol/src/types.js';
import type { BrowserManifestStatus } from '../src/types.js';

const expectedMcpCommand = process.execPath;

type DetectorMap = Record<string, () => boolean>;
type RequestCall = {
  method: string;
  tabId?: number | null;
  params?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};
type FakeBridgeClient = Pick<BridgeClient, 'connected' | 'connect' | 'request'>;
type BridgeClientRunner = <T>(callback: (client: BridgeClient) => Promise<T>) => Promise<T>;

function successResponse(id: string, result: unknown): BridgeResponse {
  return {
    id,
    ok: true,
    result,
    error: null,
    meta: { protocol_version: '1.0' },
  };
}

function createHealthPingRunner(result: Record<string, unknown>): BridgeClientRunner {
  return async (callback) =>
    callback({
      request: async ({ method }: { method: string }) => {
        if (method !== 'health.ping') {
          throw new Error(`Unexpected method: ${method}`);
        }
        return successResponse('req-health', result);
      },
    } as BridgeClient);
}

function browserManifestStatuses(installedBrowsers: string[]): BrowserManifestStatus[] {
  return ['chrome', 'edge', 'brave'].map((browser) => ({
    browser,
    manifestPath: `/tmp/${browser}/com.browserbridge.browser_bridge.json`,
    installed: installedBrowsers.includes(browser),
  }));
}

test('detectMcpClients and detectSkillTargets use injected detectors', async () => {
  const detectors: DetectorMap = {
    copilot: () => true,
    cursor: () => false,
    windsurf: () => true,
    claude: () => true,
    codex: () => true,
    opencode: () => false,
    antigravity: () => true,
  };

  assert.deepEqual(await detectMcpClients(detectors), [
    'codex',
    'claude',
    'copilot',
    'antigravity',
    'windsurf',
  ]);
  assert.deepEqual(await detectSkillTargets(detectors), [
    'codex',
    'claude',
    'copilot',
    'antigravity',
    'windsurf',
    'agents',
  ]);
});

test('detectSkillTargets includes cursor when detected', async () => {
  const detectors: DetectorMap = {
    copilot: () => false,
    cursor: () => true,
    windsurf: () => false,
    claude: () => false,
    codex: () => false,
    opencode: () => false,
    antigravity: () => false,
  };

  assert.deepEqual(await detectSkillTargets(detectors), ['cursor', 'agents']);
});

test('installMcpConfig preserves unrelated config entries when merging', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-mcp-config-'));
  const configPath = path.join(tempDir, '.cursor', 'mcp.json');
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(
    configPath,
    `${JSON.stringify(
      {
        mcpServers: {
          existing: {
            command: 'other-server',
          },
        },
        theme: 'dark',
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  try {
    await installMcpConfig('cursor', {
      global: false,
      cwd: tempDir,
      stdout: {
        write() {
          return true;
        },
      },
    });

    const merged = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
    assert.equal(merged.theme, 'dark');
    assert.equal(merged.mcpServers.existing.command, 'other-server');
    assert.equal(merged.mcpServers['browser-bridge'].command, expectedMcpCommand);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('installMcpConfig upserts Codex TOML config without dropping other sections', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-codex-mcp-config-'));
  const configPath = path.join(tempDir, '.codex', 'config.toml');
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(
    configPath,
    ['model = "gpt-5"', '', '[sandbox_workspace_write]', 'network_access = true', ''].join('\n'),
    'utf8'
  );

  try {
    await installMcpConfig('codex', {
      global: false,
      cwd: tempDir,
      stdout: {
        write() {
          return true;
        },
      },
    });

    const merged = await fs.promises.readFile(configPath, 'utf8');
    assert.match(merged, /model = "gpt-5"/);
    assert.match(merged, /\[sandbox_workspace_write\]/);
    assert.match(merged, /\[mcp_servers\."browser-bridge"\]/);
    assert.match(
      merged,
      new RegExp(
        `command = ${JSON.stringify(expectedMcpCommand).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
      )
    );
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('findConfiguredMcpClients reports configured MCP clients', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-find-mcp-configured-'));

  try {
    await installMcpConfig('cursor', {
      global: false,
      cwd: tempDir,
      stdout: {
        write() {
          return true;
        },
      },
    });

    const configured = await findConfiguredMcpClients({
      clients: ['cursor', 'claude'],
      global: false,
      cwd: tempDir,
    });

    assert.deepEqual(configured, ['cursor']);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('removeMcpConfig removes only Browser Bridge from JSON MCP config', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-remove-json-mcp-config-'));
  const configPath = path.join(tempDir, '.cursor', 'mcp.json');
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(
    configPath,
    `${JSON.stringify(
      {
        mcpServers: {
          existing: {
            command: 'other-server',
          },
          'browser-bridge': {
            command: 'bbx',
            args: ['mcp', 'serve'],
          },
        },
        theme: 'dark',
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  try {
    const removed = await removeMcpConfig('cursor', {
      global: false,
      cwd: tempDir,
      stdout: {
        write() {
          return true;
        },
      },
    });

    const merged = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
    assert.deepEqual(removed, [configPath]);
    assert.equal(merged.theme, 'dark');
    assert.equal(merged.mcpServers.existing.command, 'other-server');
    assert.equal(Object.hasOwn(merged.mcpServers, 'browser-bridge'), false);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('removeMcpConfig removes Browser Bridge from Codex TOML without dropping other sections', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-remove-codex-mcp-config-'));
  const configPath = path.join(tempDir, '.codex', 'config.toml');
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(
    configPath,
    [
      'model = "gpt-5"',
      '',
      '[mcp_servers."browser-bridge"]',
      'command = "bbx"',
      'args = ["mcp", "serve"]',
      '',
      '[sandbox_workspace_write]',
      'network_access = true',
      '',
    ].join('\n'),
    'utf8'
  );

  try {
    const removed = await removeMcpConfig('codex', {
      global: false,
      cwd: tempDir,
      stdout: {
        write() {
          return true;
        },
      },
    });

    const merged = await fs.promises.readFile(configPath, 'utf8');
    assert.deepEqual(removed, [configPath]);
    assert.match(merged, /model = "gpt-5"/);
    assert.match(merged, /\[sandbox_workspace_write\]/);
    assert.doesNotMatch(merged, /\[mcp_servers\."browser-bridge"\]/);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('installMcpConfig writes Copilot global config to default and existing profile files', async () => {
  const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-copilot-mcp-config-'));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalAppData = process.env.APPDATA;

  try {
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    if (process.platform === 'win32') {
      process.env.APPDATA = path.join(tempHome, 'AppData', 'Roaming');
    }

    const userDir =
      process.platform === 'win32'
        ? path.join(
            process.env.APPDATA || path.join(tempHome, 'AppData', 'Roaming'),
            'Code',
            'User'
          )
        : process.platform === 'linux'
          ? path.join(tempHome, '.config', 'Code', 'User')
          : path.join(tempHome, 'Library', 'Application Support', 'Code', 'User');
    const userConfigPath = path.join(tempHome, '.copilot', 'mcp-config.json');
    const profileConfigPath = path.join(userDir, 'profiles', 'profile-a', 'mcp.json');
    await fs.promises.mkdir(path.dirname(profileConfigPath), {
      recursive: true,
    });

    await installMcpConfig('copilot', {
      global: true,
      stdout: {
        write() {
          return true;
        },
      },
    });

    const userConfig = await fs.promises.readFile(userConfigPath, 'utf8');
    const defaultConfig = await fs.promises.readFile(path.join(userDir, 'mcp.json'), 'utf8');
    const profileConfig = await fs.promises.readFile(profileConfigPath, 'utf8');
    assert.match(userConfig, /"browser-bridge"/);
    assert.match(defaultConfig, /"browser-bridge"/);
    assert.match(profileConfig, /"browser-bridge"/);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  }
});

test('requestBridge forwards request source metadata', async () => {
  const calls: RequestCall[] = [];
  const client: FakeBridgeClient = {
    connected: true,
    async connect() {},
    async request({ method, params = {}, tabId = null, meta = {} }: RequestCall) {
      calls.push({ method, params, tabId, meta });
      return successResponse('req_1', { daemon: 'ok', extensionConnected: true });
    },
  };

  await requestBridge(client as BridgeClient, 'health.ping', {}, { source: 'cli' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].meta?.source, 'cli');
  assert.equal(calls[0].tabId, null);
});

test('requestBridge forwards explicit tabId for tab-bound methods', async () => {
  const calls: RequestCall[] = [];
  const client: FakeBridgeClient = {
    connected: true,
    async connect() {},
    async request({ method, params = {}, tabId = null, meta = {} }: RequestCall) {
      calls.push({ method, params, tabId, meta });
      return successResponse('req_2', { nodes: [] });
    },
  };

  await requestBridge(
    client as BridgeClient,
    'dom.query',
    { selector: 'main' },
    { source: 'cli', tabId: 77 }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tabId, 77);
});

test('resolveRef returns the first matching elementRef', async () => {
  const client: FakeBridgeClient = {
    connected: true,
    async connect() {},
    async request() {
      return successResponse('req_1', { nodes: [{ elementRef: 'el_main' }] });
    },
  };

  const ref = await resolveRef(client as BridgeClient, 'main', 42);
  assert.equal(ref, 'el_main');
});

test('resolveRef propagates upstream bridge error messages', async () => {
  const client: FakeBridgeClient = {
    connected: true,
    async connect() {},
    async request() {
      return {
        id: 'req_err',
        ok: false,
        result: null,
        error: {
          code: 'ACCESS_DENIED',
          message: 'Denied by page policy.',
          details: null,
        },
        meta: { protocol_version: '1.0' },
      };
    },
  };

  await assert.rejects(resolveRef(client as BridgeClient, 'main', 42), /Denied by page policy\./);
});

test('resolveRef throws when selector returns no matching nodes', async () => {
  const client: FakeBridgeClient = {
    connected: true,
    async connect() {},
    async request() {
      return successResponse('req_empty', { nodes: [] });
    },
  };

  await assert.rejects(
    resolveRef(client as BridgeClient, '.missing', 42),
    /No element found for selector "\.missing"\./
  );
});

test('requestBridge strips non-finite token budgets from request metadata', async () => {
  const metas: Record<string, unknown>[] = [];
  const client: FakeBridgeClient = {
    connected: true,
    async connect() {},
    async request({ meta = {} }: { meta?: Record<string, unknown> }) {
      metas.push(meta);
      return successResponse('req_meta', { daemon: 'ok', extensionConnected: true });
    },
  };

  for (const tokenBudget of [Infinity, NaN]) {
    await requestBridge(client as BridgeClient, 'health.ping', {}, { source: 'cli', tokenBudget });
  }

  assert.deepEqual(metas, [{ source: 'cli' }, { source: 'cli' }]);
});

test('withBridgeClient always closes the client when the callback throws', async () => {
  const originalConnect = BridgeClient.prototype.connect;
  const originalClose = BridgeClient.prototype.close;
  const lifecycle: string[] = [];

  BridgeClient.prototype.connect = async function () {
    lifecycle.push('connect');
    this.connected = true;
  };
  BridgeClient.prototype.close = async function () {
    lifecycle.push('close');
    this.connected = false;
  };

  try {
    await assert.rejects(
      withBridgeClient(async (client) => {
        lifecycle.push('callback');
        assert.equal(client instanceof BridgeClient, true);
        assert.equal(client.connected, true);
        throw new Error('callback failed');
      }),
      /callback failed/
    );

    assert.deepEqual(lifecycle, ['connect', 'callback', 'close']);
  } finally {
    BridgeClient.prototype.connect = originalConnect;
    BridgeClient.prototype.close = originalClose;
  }
});

test('getDoctorReport exposes extension id source and next steps without a live daemon', async () => {
  const report = await getDoctorReport({
    manifestPath: '/tmp/browser-bridge.json',
    defaultExtensionIdInfo: {
      extensionId: 'jjjkmmcdkpcgamlopogicbnnhdgebhie',
      source: 'built_in',
    },
    loadManifest: async () => null,
    checkBrowserManifests: async () => browserManifestStatuses([]),
    checkNativeHostManifestHealth: async () => [],
    bridgeClientRunner: async () => {
      throw new Error('offline');
    },
  });

  assert.equal(report.defaultExtensionIdSource, 'built_in');
  assert.equal(report.manifestInstalled, false);
  assert.ok(report.issues.includes('daemon_offline'));
  assert.ok(report.issues.includes('native_host_manifest_missing'));
  assert.ok(report.nextSteps.some((step) => step.includes('bbx-daemon')));
  assert.ok(report.nextSteps.some((step) => step.includes('bbx install')));
});

test('getDoctorReport treats one installed browser manifest as native host ready', async () => {
  const report = await getDoctorReport({
    loadManifest: async () => null,
    checkBrowserManifests: async () => browserManifestStatuses(['edge']),
    checkNativeHostManifestHealth: async () => [],
    readDaemonStartHistory: async () => [],
    checkUnwritableBridgePaths: async () => [],
    bridgeClientRunner: createHealthPingRunner({
      daemon: 'ok',
      extensionConnected: true,
      access: {
        enabled: true,
        windowId: 12,
        routeTabId: 34,
        routeReady: true,
        reason: 'enabled',
      },
    }),
  });

  assert.equal(report.manifestInstalled, true);
  assert.deepEqual(report.issues, []);
  assert.deepEqual(report.nextSteps, []);
});

test('getDoctorReport flags a crash-looping daemon and points at the daemon log', async () => {
  const now = Date.now();
  const report = await getDoctorReport({
    loadManifest: async () => ({
      allowed_origins: ['chrome-extension://example/*'],
    }),
    readDaemonStartHistory: async () => [now - 40_000, now - 25_000, now - 5_000],
    checkUnwritableBridgePaths: async () => [],
    checkNativeHostManifestHealth: async () => [],
    bridgeClientRunner: async () => {
      throw new Error('offline');
    },
  });

  assert.equal(report.daemonRestarts.restartLoop, true);
  assert.equal(report.daemonRestarts.startsInWindow, 3);
  assert.ok(report.issues.includes('daemon_restart_loop'));
  assert.ok(report.nextSteps.some((step) => step.includes(report.daemonLogPath)));
});

test('getDoctorReport flags unwritable bridge files with an ownership fix', async () => {
  const report = await getDoctorReport({
    loadManifest: async () => ({
      allowed_origins: ['chrome-extension://example/*'],
    }),
    readDaemonStartHistory: async () => [],
    checkUnwritableBridgePaths: async () => ['/home/user/.local/share/browser-bridge/daemon.pid'],
    checkNativeHostManifestHealth: async () => [],
    bridgeClientRunner: async () => {
      throw new Error('offline');
    },
  });

  assert.deepEqual(report.unwritableBridgePaths, [
    '/home/user/.local/share/browser-bridge/daemon.pid',
  ]);
  assert.ok(report.issues.includes('bridge_files_not_writable'));
  assert.ok(report.nextSteps.some((step) => step.includes('sudo chown')));
  assert.ok(report.nextSteps.some((step) => step.includes('daemon.pid')));
});

test('getDoctorReport tells the agent to wait for the user when access is disabled', async () => {
  const report = await getDoctorReport({
    loadManifest: async () => ({
      allowed_origins: ['chrome-extension://example/*'],
    }),
    checkNativeHostManifestHealth: async () => [],
    bridgeClientRunner: createHealthPingRunner({
      daemon: 'ok',
      extensionConnected: true,
      access: {
        enabled: false,
        windowId: 12,
        routeReady: false,
        reason: 'access_disabled',
      },
    }),
  });

  assert.ok(report.issues.includes('access_disabled'));
  assert.ok(report.nextSteps.some((step) => step.includes('stop requesting access')));
  assert.ok(report.nextSteps.some((step) => step.includes('click Enable for the needed window')));
});

test('getDoctorReport flags an installed but disconnected extension separately from daemon issues', async () => {
  const report = await getDoctorReport({
    loadManifest: async () => ({
      allowed_origins: ['chrome-extension://example/*'],
    }),
    checkNativeHostManifestHealth: async () => [],
    bridgeClientRunner: createHealthPingRunner({
      daemon: 'ok',
      extensionConnected: false,
    }),
  });

  assert.equal(report.daemonReachable, true);
  assert.equal(report.extensionConnected, false);
  assert.ok(report.issues.includes('extension_disconnected'));
  assert.ok(!report.issues.includes('daemon_offline'));
  assert.ok(report.nextSteps.some((step) => step.includes('Browser Bridge extension')));
});

test('getDoctorReport calls out Chromium snap native host limitations', async () => {
  const report = await getDoctorReport({
    loadManifest: async () => null,
    checkBrowserManifests: async () => [
      {
        browser: 'chromium',
        manifestPath:
          '/home/tester/snap/chromium/common/chromium/NativeMessagingHosts/com.browserbridge.browser_bridge.json',
        installed: true,
      },
    ],
    checkNativeHostManifestHealth: async () => [],
    bridgeClientRunner: createHealthPingRunner({
      daemon: 'ok',
      extensionConnected: false,
    }),
  });

  assert.equal(report.manifestInstalled, true);
  assert.ok(report.issues.includes('extension_disconnected'));
  assert.ok(report.issues.includes('chromium_sandboxed_native_host_limited'));
  assert.ok(report.nextSteps.some((step) => step.includes('snap or Flatpak')));
});

test('getDoctorReport calls out Chromium Flatpak native host limitations', async () => {
  const report = await getDoctorReport({
    loadManifest: async () => null,
    checkBrowserManifests: async () => [
      {
        browser: 'chromium',
        manifestPath:
          '/home/tester/.var/app/org.chromium.Chromium/config/chromium/NativeMessagingHosts/com.browserbridge.browser_bridge.json',
        installed: true,
      },
    ],
    checkNativeHostManifestHealth: async () => [],
    bridgeClientRunner: createHealthPingRunner({
      daemon: 'ok',
      extensionConnected: false,
    }),
  });

  assert.equal(report.manifestInstalled, true);
  assert.ok(report.issues.includes('extension_disconnected'));
  assert.ok(report.issues.includes('chromium_sandboxed_native_host_limited'));
  assert.ok(report.nextSteps.some((step) => step.includes('non-sandboxed package')));
});

test('getDoctorReport flags a broken native host launcher path', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-broken-launcher-'));
  const manifestPath = path.join(tempDir, 'com.browserbridge.browser_bridge.json');
  const launcherPath = path.join(tempDir, 'missing-native-host-launcher.sh');
  await fs.promises.writeFile(
    manifestPath,
    `${JSON.stringify({
      name: 'com.browserbridge.browser_bridge',
      type: 'stdio',
      path: launcherPath,
      allowed_origins: ['chrome-extension://example/'],
    })}\n`,
    'utf8'
  );

  try {
    const report = await getDoctorReport({
      loadManifest: async () => null,
      checkBrowserManifests: async () => [
        {
          browser: 'chrome',
          manifestPath,
          installed: true,
        },
      ],
      readDaemonStartHistory: async () => [],
      checkUnwritableBridgePaths: async () => [],
      bridgeClientRunner: async () => {
        throw new Error('offline');
      },
    });

    assert.ok(report.issues.includes('native_host_manifest_invalid'));
    assert.equal(report.nativeHostManifestIssues.length, 1);
    assert.match(report.nativeHostManifestIssues[0]?.message ?? '', /launcher/);
    assert.ok(report.nextSteps.some((step) => step.includes('bbx install --browser')));
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('getDoctorReport clears readiness issues after the bridge recovers on a later retry', async () => {
  let offline = true;

  const bridgeClientRunner: BridgeClientRunner = async (callback) => {
    if (offline) {
      offline = false;
      throw new Error('offline');
    }
    return callback({
      request: async ({ method }: { method: string }) => {
        if (method !== 'health.ping') {
          throw new Error(`Unexpected method: ${method}`);
        }
        return {
          id: 'req-health-recovered',
          ok: true,
          result: {
            daemon: 'ok',
            extensionConnected: true,
            access: {
              enabled: true,
              windowId: 22,
              routeTabId: 81,
              routeReady: true,
              reason: 'reconnected',
            },
          },
          error: null,
          meta: { protocol_version: '1.0' },
        } as BridgeResponse;
      },
    } as BridgeClient);
  };

  const offlineReport = await getDoctorReport({
    loadManifest: async () => ({
      allowed_origins: ['chrome-extension://example/*'],
    }),
    checkNativeHostManifestHealth: async () => [],
    bridgeClientRunner,
  });
  const recoveredReport = await getDoctorReport({
    loadManifest: async () => ({
      allowed_origins: ['chrome-extension://example/*'],
    }),
    checkNativeHostManifestHealth: async () => [],
    bridgeClientRunner,
  });

  assert.ok(offlineReport.issues.includes('daemon_offline'));
  assert.equal(recoveredReport.daemonReachable, true);
  assert.equal(recoveredReport.extensionConnected, true);
  assert.equal(recoveredReport.accessEnabled, true);
  assert.equal(recoveredReport.enabledWindowId, 22);
  assert.equal(recoveredReport.routeTabId, 81);
  assert.equal(recoveredReport.routeReady, true);
  assert.equal(recoveredReport.routeReason, 'reconnected');
  assert.ok(!recoveredReport.issues.includes('daemon_offline'));
  assert.ok(!recoveredReport.issues.includes('extension_disconnected'));
  assert.ok(!recoveredReport.issues.includes('access_disabled'));
  assert.ok(!recoveredReport.issues.includes('no_routable_active_tab'));
});

test('CLI bridge method bindings stay aligned with the protocol registry', () => {
  for (const [command, method] of Object.entries(CLI_METHOD_BINDINGS)) {
    assert.ok(
      BRIDGE_METHOD_REGISTRY[method],
      `${command} should map to a registered bridge method`
    );
  }
});

test('every bridge method keeps a direct CLI alias binding', () => {
  for (const method of Object.keys(BRIDGE_METHOD_REGISTRY)) {
    assert.equal(CLI_METHOD_BINDINGS[method], method, `${method} should keep a direct CLI alias`);
  }
});
