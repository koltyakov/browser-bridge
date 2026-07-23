import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  BRIDGE_METHOD_REGISTRY,
  getProtocolVersion,
  PROTOCOL_VERSION,
} from '../../protocol/src/index.js';
import { CLI_METHOD_BINDINGS } from '../src/command-registry.js';
import { detectMcpClients, detectSkillTargets } from '../src/detect.js';
import { findConfiguredMcpClients, installMcpConfig, removeMcpConfig } from '../src/mcp-config.js';
import os from 'node:os';
import path from 'node:path';

import { BridgeClient } from '../src/client.js';
import { getDoctorReport, requestBridge, resolveRef, withBridgeClient } from '../src/runtime.js';
import type { BridgeResponse, SetupStatus } from '../../protocol/src/types.js';
import type { BrowserManifestStatus } from '../src/types.js';

const expectedMcpCommand = 'bbx';

type DetectorMap = Record<string, () => boolean>;
type RequestCall = {
  method: string;
  tabId?: number | null;
  params?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  timeoutMs?: number;
};
type FakeBridgeClient = Pick<BridgeClient, 'connected' | 'connect' | 'request'>;
type BridgeClientRunner = <T>(callback: (client: BridgeClient) => Promise<T>) => Promise<T>;

function successResponse(id: string, result: unknown): BridgeResponse {
  return {
    id,
    ok: true,
    result,
    error: null,
    meta: { protocol_version: PROTOCOL_VERSION },
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

function createDiagnosticRunner(
  results: Record<string, unknown>,
  failingMethods: string[] = [],
  calls: string[] = []
): BridgeClientRunner {
  return async (callback) =>
    callback({
      request: async ({ method }: { method: string }) => {
        calls.push(method);
        if (failingMethods.includes(method) || !(method in results)) {
          throw new Error(`Diagnostic unavailable: ${method}`);
        }
        return successResponse(`req-${method}`, results[method]);
      },
    } as BridgeClient);
}

function setupStatusFixture(): SetupStatus {
  return {
    scope: 'global',
    mcpClients: [
      {
        key: 'codex',
        label: 'Sensitive profile label',
        detected: true,
        configPath: '/Users/private/.codex/config.toml',
        configExists: true,
        configured: true,
      },
      {
        key: 'cursor',
        label: 'Cursor',
        detected: false,
        configPath: '/Users/private/.cursor/mcp.json',
        configExists: false,
        configured: false,
      },
    ],
    skillTargets: [
      {
        key: 'codex',
        label: 'Sensitive skill label',
        detected: true,
        basePath: '/Users/private/.codex/skills',
        installed: true,
        managed: true,
        installedVersion: '1.0.0',
        currentVersion: '1.1.0',
        updateAvailable: true,
        skills: [],
      },
    ],
  };
}

function healthyDiagnosticResult(): Record<string, unknown> {
  return {
    daemon: 'ok',
    daemonVersion: '1.7.8',
    extensionConnected: true,
    connectedExtensions: [
      { extensionId: 'ext-1', profileLabel: 'Private profile one' },
      { extensionId: 'ext-2', profileLabel: 'Private profile two' },
    ],
    daemon_supported_versions: [getProtocolVersion()],
    supported_versions: [getProtocolVersion()],
    proxy: { enabled: false, endpoint: null },
    access: {
      enabled: true,
      windowId: 12,
      routeTabId: 34,
      routeReady: true,
      reason: 'enabled',
      routeUrl: 'https://private.example/account?token=secret',
    },
  };
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
    assert.ok(JSON.parse(userConfig).mcpServers['browser-bridge']);
    assert.ok(JSON.parse(defaultConfig).servers['browser-bridge']);
    assert.ok(JSON.parse(profileConfig).servers['browser-bridge']);
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

test('requestBridge keeps transport timeout beyond normalized operation timeout', async () => {
  const calls: RequestCall[] = [];
  const client: FakeBridgeClient = {
    connected: true,
    async connect() {},
    async request(options: RequestCall) {
      calls.push(options);
      return successResponse('req_wait', { loaded: true });
    },
  };

  await requestBridge(client as BridgeClient, 'navigation.navigate', {
    url: 'https://example.com',
  });
  await requestBridge(client as BridgeClient, 'page.evaluate', {
    expression: 'Promise.resolve(true)',
    timeoutMs: 20_000,
  });

  assert.equal(calls[0].timeoutMs, 19_000);
  assert.equal(calls[1].timeoutMs, 24_000);
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
        meta: { protocol_version: PROTOCOL_VERSION },
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
  assert.equal(report.daemonLogPath, '[redacted-path]/daemon.log');
  assert.ok(report.nextSteps.some((step) => step.includes('daemon.log')));
  assert.doesNotMatch(report.nextSteps.join('\n'), /\/Users\/|\/home\//);
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

  assert.deepEqual(report.unwritableBridgePaths, ['[redacted-path]/daemon.pid']);
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
          meta: { protocol_version: PROTOCOL_VERSION },
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

test('getDoctorReport consolidates healthy local runtime diagnostics', async () => {
  const health = {
    ...healthyDiagnosticResult(),
    debugger: { state: 'active', attachedTabs: [34] },
    capture: { state: 'armed' },
  };
  const report = await getDoctorReport({
    loadManifest: async () => null,
    checkBrowserManifests: async () => browserManifestStatuses(['edge']),
    checkNativeHostManifestHealth: async () => [],
    readDaemonStartHistory: async () => [],
    checkUnwritableBridgePaths: async () => [],
    getLocalTransport: () => ({ type: 'socket', socketPath: '/private/bridge.sock', label: '' }),
    readProxyConfig: () => null,
    readRemoteConfig: async () => ({ remotes: [] }),
    bridgeClientRunner: createDiagnosticRunner({
      'health.ping': health,
      'setup.get_status': setupStatusFixture(),
      'log.tail': { entries: [] },
      'daemon.metrics': {
        uptimeMs: 5000,
        activeAgents: 1,
        activeExtensions: 2,
        pendingRequests: 0,
        requestsProcessed: 20,
        requestsFailed: 1,
        avgResponseTimeMs: 12,
      },
    }),
  });

  assert.deepEqual(report.issues, []);
  assert.deepEqual(report.transport, {
    kind: 'socket',
    local: true,
    status: 'reachable',
    proxyConfigured: false,
    proxyExposed: false,
    credentials: 'not_required',
  });
  assert.deepEqual(report.connections, { extensionCount: 2, profileCount: 2 });
  assert.equal(report.protocol.compatible, true);
  assert.equal(report.protocol.migration, 'none');
  assert.deepEqual(report.debugger, {
    state: 'active',
    attachedTabCount: 1,
    heldTabCount: null,
    pendingTabCount: null,
    recentReason: null,
    captureState: 'armed',
    captureActiveTabCount: null,
    captureOwnershipCount: null,
    captureInflightCount: null,
    interceptionActiveTabCount: null,
    interceptionRuleCount: null,
  });
  assert.equal(report.metrics?.pendingRequests, 0);
  assert.deepEqual(report.setup, {
    source: 'daemon',
    scope: 'global',
    mcp: { detected: 1, configured: 1 },
    skills: { detected: 1, installed: 1, managed: 1, updatesAvailable: 1 },
  });
});

test('getDoctorReport keeps daemon diagnostics when the extension is disconnected', async () => {
  const report = await getDoctorReport({
    loadManifest: async () => ({
      allowed_origins: ['chrome-extension://different-extension-id/'],
    }),
    checkBrowserManifests: async () => browserManifestStatuses(['chrome']),
    checkNativeHostManifestHealth: async () => [],
    readDaemonStartHistory: async () => [],
    checkUnwritableBridgePaths: async () => [],
    readRemoteConfig: async () => ({ remotes: [] }),
    collectSetupStatus: async () => setupStatusFixture(),
    bridgeClientRunner: createDiagnosticRunner({
      'health.ping': {
        daemon: 'ok',
        extensionConnected: false,
        connectedExtensions: [],
        daemon_supported_versions: [getProtocolVersion()],
      },
      'setup.get_status': setupStatusFixture(),
      'log.tail': { entries: [] },
      'daemon.metrics': {
        activeExtensions: 0,
        pendingRequests: 3,
      },
    }),
  });

  assert.equal(report.daemonReachable, true);
  assert.equal(report.healthAvailable, true);
  assert.equal(report.extensionConnected, false);
  assert.equal(report.metrics?.pendingRequests, 3);
  assert.ok(report.issues.includes('extension_disconnected'));
  assert.ok(!report.issues.includes('extension_id_mismatch'));
  assert.ok(!report.issues.includes('daemon_offline'));
});

test('getDoctorReport uses legacy supported_versions for a disconnected daemon mismatch', async () => {
  const report = await getDoctorReport({
    loadManifest: async () => null,
    checkBrowserManifests: async () => browserManifestStatuses(['edge']),
    checkNativeHostManifestHealth: async () => [],
    readDaemonStartHistory: async () => [],
    checkUnwritableBridgePaths: async () => [],
    readInstalledExtensionIds: async () => [],
    readRemoteConfig: async () => ({ remotes: [] }),
    bridgeClientRunner: createDiagnosticRunner({
      'health.ping': {
        daemon: 'ok',
        extensionConnected: false,
        supported_versions: ['0.1'],
      },
      'setup.get_status': setupStatusFixture(),
      'log.tail': { entries: [] },
      'daemon.metrics': { activeExtensions: 0 },
    }),
  });

  assert.deepEqual(report.protocol.daemonSupportedVersions, ['0.1']);
  assert.equal(report.protocol.daemonCompatible, false);
  assert.equal(report.protocol.extensionCompatible, null);
  assert.ok(report.issues.includes('protocol_mismatch'));
});

test('getDoctorReport collects setup directly while the daemon is offline', async () => {
  const report = await getDoctorReport({
    loadManifest: async () => null,
    checkBrowserManifests: async () => browserManifestStatuses([]),
    checkNativeHostManifestHealth: async () => [],
    readDaemonStartHistory: async () => [],
    checkUnwritableBridgePaths: async () => [],
    readRemoteConfig: async () => ({ remotes: [] }),
    collectSetupStatus: async () => setupStatusFixture(),
    bridgeClientRunner: async () => {
      throw new Error('ECONNREFUSED /Users/private/bridge.sock');
    },
  });

  assert.equal(report.transport.status, 'offline');
  assert.equal(report.setup?.source, 'direct');
  assert.equal(report.setup?.mcp.configured, 1);
  assert.ok(report.issues.includes('daemon_offline'));
  assert.ok(report.diagnosticFailures.includes('daemon_connection_failed'));
  assert.doesNotMatch(JSON.stringify(report.setup), /Users\/private/u);
});

test('getDoctorReport closes the doctor client after registration fails', async () => {
  const originalConnect = BridgeClient.prototype.connect;
  const originalClose = BridgeClient.prototype.close;
  let closeCalls = 0;
  BridgeClient.prototype.connect = async function () {
    throw new Error('Bridge daemon registration failed.');
  };
  BridgeClient.prototype.close = async function () {
    closeCalls += 1;
    this.connected = false;
    this.socket = null;
  };

  try {
    const report = await getDoctorReport({
      loadManifest: async () => null,
      checkBrowserManifests: async () => browserManifestStatuses([]),
      checkNativeHostManifestHealth: async () => [],
      readDaemonStartHistory: async () => [],
      checkUnwritableBridgePaths: async () => [],
      readInstalledExtensionIds: async () => [],
      readRemoteConfig: async () => ({ remotes: [] }),
      collectSetupStatus: async () => setupStatusFixture(),
    });

    assert.equal(closeCalls, 1);
    assert.equal(report.daemonReachable, false);
    assert.ok(report.issues.includes('daemon_offline'));
  } finally {
    BridgeClient.prototype.connect = originalConnect;
    BridgeClient.prototype.close = originalClose;
  }
});

test('getDoctorReport treats failed health as core health unavailable', async () => {
  const report = await getDoctorReport({
    loadManifest: async () => null,
    checkBrowserManifests: async () => browserManifestStatuses(['edge']),
    checkNativeHostManifestHealth: async () => [],
    readDaemonStartHistory: async () => [],
    checkUnwritableBridgePaths: async () => [],
    readInstalledExtensionIds: async () => [],
    readRemoteConfig: async () => ({ remotes: [] }),
    bridgeClientRunner: async (callback) =>
      callback({
        request: async ({ method }: { method: string }) => {
          if (method === 'health.ping') {
            return {
              id: 'req-health-failed',
              ok: false,
              result: null,
              error: {
                code: 'INTERNAL_ERROR',
                message: 'health failed with private payload',
                details: null,
              },
              meta: { protocol_version: getProtocolVersion() },
            } as BridgeResponse;
          }
          if (method === 'setup.get_status') {
            return successResponse('req-setup', setupStatusFixture());
          }
          if (method === 'log.tail') {
            return successResponse('req-logs', { entries: [] });
          }
          return successResponse('req-metrics', { activeExtensions: 1, pendingRequests: 0 });
        },
      } as BridgeClient),
  });

  assert.equal(report.daemonReachable, true);
  assert.equal(report.healthAvailable, false);
  assert.equal(report.extensionConnected, false);
  assert.equal(report.accessEnabled, false);
  assert.ok(report.issues.includes('health_unavailable'));
  assert.ok(!report.issues.includes('extension_disconnected'));
  assert.ok(!report.issues.includes('access_disabled'));
  assert.ok(report.nextSteps.some((step) => step.includes('health.ping')));
  assert.doesNotMatch(JSON.stringify(report), /private payload/u);
});

test('getDoctorReport gives bounded recovery guidance for stale local proxy credentials', async () => {
  const report = await getDoctorReport({
    loadManifest: async () => null,
    checkBrowserManifests: async () => browserManifestStatuses(['edge']),
    checkNativeHostManifestHealth: async () => [],
    readDaemonStartHistory: async () => [],
    checkUnwritableBridgePaths: async () => [],
    readRemoteConfig: async () => ({ remotes: [] }),
    collectSetupStatus: async () => setupStatusFixture(),
    getLocalTransport: () => ({
      type: 'tcp',
      host: '127.0.0.1',
      port: 9223,
      label: '127.0.0.1:9223',
    }),
    readProxyConfig: () => ({ enabled: true }),
    bridgeClientRunner: async () => {
      throw new Error('Bridge daemon authentication failed for token super-secret');
    },
  });

  assert.equal(report.transport.status, 'authentication_failed');
  assert.equal(report.transport.credentials, 'rejected');
  assert.ok(report.issues.includes('proxy_credentials_stale'));
  assert.ok(!report.issues.includes('daemon_offline'));
  assert.ok(report.nextSteps.some((step) => step.includes('--rotate-token')));
  assert.doesNotMatch(JSON.stringify(report), /super-secret/u);
});

test('getDoctorReport reports protocol mismatch and deterministic migration guidance', async () => {
  const report = await getDoctorReport({
    loadManifest: async () => null,
    checkBrowserManifests: async () => browserManifestStatuses(['edge']),
    checkNativeHostManifestHealth: async () => [],
    readDaemonStartHistory: async () => [],
    checkUnwritableBridgePaths: async () => [],
    readRemoteConfig: async () => ({ remotes: [] }),
    bridgeClientRunner: createDiagnosticRunner({
      'health.ping': {
        ...healthyDiagnosticResult(),
        supported_versions: ['0.1'],
      },
      'setup.get_status': setupStatusFixture(),
      'log.tail': { entries: [] },
      'daemon.metrics': { activeExtensions: 1 },
    }),
  });

  assert.equal(report.protocol.compatible, false);
  assert.equal(report.protocol.extensionCompatible, false);
  assert.equal(report.protocol.migration, 'update_extension');
  assert.ok(report.issues.includes('protocol_mismatch'));
  assert.ok(report.nextSteps.some((step) => step.includes('Update or reload')));
});

test('getDoctorReport preserves core health across partial diagnostic failures', async () => {
  const report = await getDoctorReport({
    loadManifest: async () => null,
    checkBrowserManifests: async () => browserManifestStatuses(['edge']),
    checkNativeHostManifestHealth: async () => [],
    readDaemonStartHistory: async () => [],
    checkUnwritableBridgePaths: async () => [],
    readRemoteConfig: async () => ({ remotes: [] }),
    bridgeClientRunner: createDiagnosticRunner(
      {
        'health.ping': healthyDiagnosticResult(),
        'daemon.metrics': { activeExtensions: 2, pendingRequests: 4 },
      },
      ['setup.get_status', 'log.tail']
    ),
  });

  assert.deepEqual(report.issues, []);
  assert.equal(report.routeReady, true);
  assert.equal(report.metrics?.pendingRequests, 4);
  assert.equal(report.setup, null);
  assert.deepEqual(report.diagnosticFailures, ['setup.get_status_failed', 'log.tail_failed']);
});

test('getDoctorReport validates and bounds malicious setup status fields', async () => {
  const maliciousSetup = {
    scope: 'global',
    mcpClients: Array.from({ length: 150 }, (_, index) => ({
      detected: index % 2 === 0 ? true : 'true',
      configured: index < 100,
      configPath: `/private/${index}`,
      token: `secret-${index}`,
    })),
    skillTargets: Array.from({ length: 150 }, (_, index) => ({
      detected: true,
      installed: index % 2 === 0,
      managed: 'true',
      updateAvailable: index < 10,
      basePath: `/private/skills/${index}`,
    })),
  };
  const baseResults = {
    'health.ping': healthyDiagnosticResult(),
    'log.tail': { entries: [] },
    'daemon.metrics': { activeExtensions: 2 },
  };
  const commonOptions = {
    loadManifest: async () => null,
    checkBrowserManifests: async () => browserManifestStatuses(['edge']),
    checkNativeHostManifestHealth: async () => [],
    readDaemonStartHistory: async () => [],
    checkUnwritableBridgePaths: async () => [],
    readInstalledExtensionIds: async () => [],
    readRemoteConfig: async () => ({ remotes: [] }),
  };
  const bounded = await getDoctorReport({
    ...commonOptions,
    bridgeClientRunner: createDiagnosticRunner({
      ...baseResults,
      'setup.get_status': maliciousSetup,
    }),
  });
  const invalidScope = await getDoctorReport({
    ...commonOptions,
    bridgeClientRunner: createDiagnosticRunner({
      ...baseResults,
      'setup.get_status': { ...maliciousSetup, scope: '/Users/private' },
    }),
  });

  assert.deepEqual(bounded.setup, {
    source: 'daemon',
    scope: 'global',
    mcp: { detected: 50, configured: 100 },
    skills: { detected: 100, installed: 50, managed: 0, updatesAvailable: 10 },
  });
  assert.doesNotMatch(JSON.stringify(bounded.setup), /private|secret/u);
  assert.equal(invalidScope.setup, null);
  assert.ok(invalidScope.diagnosticFailures.includes('setup_status_invalid'));
  assert.doesNotMatch(JSON.stringify(invalidScope), /Users\/private/u);
});

test('getDoctorReport checks connected extension IDs against every installed browser manifest', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-doctor-manifests-'));
  const chromeManifestPath = path.join(tempDir, 'chrome.json');
  const edgeManifestPath = path.join(tempDir, 'edge.json');
  const connectedExtensionId = 'jjjkmmcdkpcgamlopogicbnnhdgebhie';
  const otherExtensionId = 'a'.repeat(32);
  await fs.promises.writeFile(
    chromeManifestPath,
    JSON.stringify({ allowed_origins: [`chrome-extension://${otherExtensionId}/`] }),
    'utf8'
  );
  await fs.promises.writeFile(
    edgeManifestPath,
    JSON.stringify({ allowed_origins: [`chrome-extension://${connectedExtensionId}/`] }),
    'utf8'
  );
  const browserManifests = [
    { browser: 'chrome', manifestPath: chromeManifestPath, installed: true },
    { browser: 'edge', manifestPath: edgeManifestPath, installed: true },
  ];
  const bridgeClientRunner = createDiagnosticRunner({
    'health.ping': {
      ...healthyDiagnosticResult(),
      connectedExtensions: [{ browserExtensionId: connectedExtensionId, profileLabel: 'private' }],
    },
    'setup.get_status': setupStatusFixture(),
    'log.tail': { entries: [] },
    'daemon.metrics': { activeExtensions: 1 },
  });

  try {
    const matching = await getDoctorReport({
      loadManifest: async () => ({
        allowed_origins: [`chrome-extension://${otherExtensionId}/`],
      }),
      checkBrowserManifests: async () => browserManifests,
      checkNativeHostManifestHealth: async () => [],
      readDaemonStartHistory: async () => [],
      checkUnwritableBridgePaths: async () => [],
      readRemoteConfig: async () => ({ remotes: [] }),
      bridgeClientRunner,
    });
    assert.ok(!matching.issues.includes('extension_id_mismatch'));

    await fs.promises.writeFile(
      edgeManifestPath,
      JSON.stringify({ allowed_origins: [`chrome-extension://${otherExtensionId}/`] }),
      'utf8'
    );
    const mismatching = await getDoctorReport({
      loadManifest: async () => ({
        allowed_origins: [`chrome-extension://${otherExtensionId}/`],
      }),
      checkBrowserManifests: async () => browserManifests,
      checkNativeHostManifestHealth: async () => [],
      readDaemonStartHistory: async () => [],
      checkUnwritableBridgePaths: async () => [],
      readRemoteConfig: async () => ({ remotes: [] }),
      bridgeClientRunner,
    });
    assert.ok(mismatching.issues.includes('extension_id_mismatch'));
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('getDoctorReport turns real health debugger conflict categories into recovery guidance', async () => {
  const report = await getDoctorReport({
    loadManifest: async () => null,
    checkBrowserManifests: async () => browserManifestStatuses(['edge']),
    checkNativeHostManifestHealth: async () => [],
    readDaemonStartHistory: async () => [],
    checkUnwritableBridgePaths: async () => [],
    readRemoteConfig: async () => ({ remotes: [] }),
    bridgeClientRunner: createDiagnosticRunner({
      'health.ping': {
        ...healthyDiagnosticResult(),
        debugger: {
          status: 'idle',
          attachedTabCount: 0,
          heldTabCount: 0,
          pendingTabCount: 0,
          recentReason: 'debugger_conflict',
        },
        capture: {
          state: 'stopped',
          activeTabCount: 0,
          ownershipCount: 0,
          inflightCount: 0,
          interceptionActiveTabCount: 0,
          interceptionRuleCount: 0,
        },
      },
      'setup.get_status': setupStatusFixture(),
      'log.tail': {
        entries: [
          {
            at: '2026-07-22T11:59:59.000Z',
            method: 'health.ping',
            ok: true,
            source: 'cli',
          },
          {
            at: '2026-07-22T12:00:00.000Z',
            method: 'screenshot.capture_element',
            ok: false,
            source: 'mcp',
            message: 'Another debugger is already attached at https://private.example/secret',
            request: { params: { token: 'raw-secret' } },
          },
        ],
      },
      'daemon.metrics': { activeExtensions: 2 },
    }),
  });

  assert.equal(report.debugger.state, 'idle');
  assert.equal(report.debugger.recentReason, 'debugger_conflict');
  assert.equal(report.debugger.captureOwnershipCount, 0);
  assert.equal(report.debugger.interceptionRuleCount, 0);
  assert.deepEqual(report.recentCauses, ['debugger_conflict']);
  assert.equal(report.recentEvents.length, 1);
  assert.ok(!report.issues.includes('debugger_conflict'));
  assert.ok(report.nextSteps.some((step) => step.includes('Close DevTools')));
  assert.doesNotMatch(JSON.stringify(report.recentEvents), /private|raw-secret|request|params/u);
});

test('getDoctorReport summarizes remote config without probing or exposing destinations', async () => {
  const calls: string[] = [];
  const report = await getDoctorReport({
    loadManifest: async () => null,
    checkBrowserManifests: async () => browserManifestStatuses(['edge']),
    checkNativeHostManifestHealth: async () => [],
    readDaemonStartHistory: async () => [],
    checkUnwritableBridgePaths: async () => [],
    readRemoteConfig: async () => ({
      remotes: [
        {
          id: 'private-vm',
          host: 'secret.internal',
          port: 9443,
          token: 'a'.repeat(32),
        },
      ],
    }),
    bridgeClientRunner: createDiagnosticRunner(
      {
        'health.ping': healthyDiagnosticResult(),
        'setup.get_status': setupStatusFixture(),
        'log.tail': { entries: [] },
        'daemon.metrics': { activeExtensions: 2 },
      },
      [],
      calls
    ),
  });

  assert.deepEqual(report.remoteDestinations, {
    configuredCount: 1,
    status: 'not_probed_local_only',
    credentials: 'unverified',
  });
  assert.deepEqual(calls, ['health.ping', 'setup.get_status', 'log.tail', 'daemon.metrics']);
  assert.doesNotMatch(
    JSON.stringify(report.remoteDestinations),
    /private-vm|secret\.internal|9443/u
  );
});

test('getDoctorReport redacts newly consolidated URL, value, token, label, and path fields', async () => {
  const report = await getDoctorReport({
    loadManifest: async () => null,
    checkBrowserManifests: async () => browserManifestStatuses(['edge']),
    checkNativeHostManifestHealth: async () => [],
    readDaemonStartHistory: async () => [],
    checkUnwritableBridgePaths: async () => [],
    readRemoteConfig: async () => ({ remotes: [] }),
    getLocalTransport: () => ({
      type: 'socket',
      socketPath: '/Users/private/bridge.sock',
      label: '/Users/private/bridge.sock',
    }),
    bridgeClientRunner: createDiagnosticRunner({
      'health.ping': {
        ...healthyDiagnosticResult(),
        socketPath: '/Users/private/bridge.sock',
        transport: '/Users/private/bridge.sock',
      },
      'setup.get_status': setupStatusFixture(),
      'log.tail': {
        entries: [
          {
            method: 'page.evaluate',
            ok: false,
            url: 'https://private.example/secret',
            expression: 'document.querySelector("#password").value',
            storage: { token: 'storage-secret' },
            headers: { authorization: 'Bearer secret' },
            body: 'form-secret',
            profileLabel: 'Private profile one',
          },
        ],
      },
      'daemon.metrics': { activeExtensions: 2 },
    }),
  });

  const consolidated = JSON.stringify({
    transport: report.transport,
    connections: report.connections,
    protocol: report.protocol,
    debugger: report.debugger,
    metrics: report.metrics,
    recentEvents: report.recentEvents,
    setup: report.setup,
    remoteDestinations: report.remoteDestinations,
  });
  assert.doesNotMatch(
    consolidated,
    /private\.example|password|storage-secret|Bearer secret|form-secret|Private profile|Users\/private/u
  );
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
