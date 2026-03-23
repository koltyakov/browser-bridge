// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BRIDGE_METHOD_REGISTRY } from '../../protocol/src/index.js';
import { CLI_METHOD_BINDINGS } from '../src/command-registry.js';
import { detectMcpClients, detectSkillTargets } from '../src/detect.js';
import { findConfiguredMcpClients, installMcpConfig, removeMcpConfig } from '../src/mcp-config.js';
import { clearSession, loadSession, saveSession } from '../src/session-store.js';
import { getDoctorReport, requireSession, resolveRef } from '../src/runtime.js';

/**
 * @param {() => Promise<void>} callback
 * @returns {Promise<void>}
 */
async function withTempCodexHome(callback) {
  const previous = process.env.CODEX_HOME;
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-agent-runtime-'));
  process.env.CODEX_HOME = tempDir;

  try {
    await callback();
  } finally {
    await clearSession();
    if (previous === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previous;
    }
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

test('detectMcpClients and detectSkillTargets use injected detectors', () => {
  /** @type {Record<string, () => boolean>} */
  const detectors = {
    copilot: () => true,
    cursor: () => false,
    windsurf: () => true,
    claude: () => true,
    codex: () => true,
    opencode: () => false,
    antigravity: () => true
  };

  assert.deepEqual(detectMcpClients(detectors), ['copilot', 'codex', 'windsurf', 'claude']);
  assert.deepEqual(detectSkillTargets(detectors), ['copilot', 'codex', 'windsurf', 'claude', 'antigravity', 'agents']);
});

test('detectSkillTargets includes cursor when detected', () => {
  /** @type {Record<string, () => boolean>} */
  const detectors = {
    copilot: () => false,
    cursor: () => true,
    windsurf: () => false,
    claude: () => false,
    codex: () => false,
    opencode: () => false,
    antigravity: () => false
  };

  assert.deepEqual(detectSkillTargets(detectors), ['cursor', 'agents']);
});

test('installMcpConfig preserves unrelated config entries when merging', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-mcp-config-'));
  const configPath = path.join(tempDir, '.cursor', 'mcp.json');
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(configPath, `${JSON.stringify({
    mcpServers: {
      existing: {
        command: 'other-server'
      }
    },
    theme: 'dark'
  }, null, 2)}\n`, 'utf8');

  try {
    await installMcpConfig('cursor', {
      global: false,
      cwd: tempDir,
      stdout: { write() { return true; } }
    });

    const merged = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
    assert.equal(merged.theme, 'dark');
    assert.equal(merged.mcpServers.existing.command, 'other-server');
    assert.equal(merged.mcpServers['browser-bridge'].command, 'bbx');
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('installMcpConfig upserts Codex TOML config without dropping other sections', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-codex-mcp-config-'));
  const configPath = path.join(tempDir, '.codex', 'config.toml');
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(configPath, [
    'model = "gpt-5"',
    '',
    '[sandbox_workspace_write]',
    'network_access = true',
    ''
  ].join('\n'), 'utf8');

  try {
    await installMcpConfig('codex', {
      global: false,
      cwd: tempDir,
      stdout: { write() { return true; } }
    });

    const merged = await fs.promises.readFile(configPath, 'utf8');
    assert.match(merged, /model = "gpt-5"/);
    assert.match(merged, /\[sandbox_workspace_write\]/);
    assert.match(merged, /\[mcp_servers\."browser-bridge"\]/);
    assert.match(merged, /command = "bbx"/);
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
      stdout: { write() { return true; } }
    });

    const configured = await findConfiguredMcpClients({
      clients: ['cursor', 'claude'],
      global: false,
      cwd: tempDir
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
  await fs.promises.writeFile(configPath, `${JSON.stringify({
    mcpServers: {
      existing: {
        command: 'other-server'
      },
      'browser-bridge': {
        command: 'bbx',
        args: ['mcp', 'serve']
      }
    },
    theme: 'dark'
  }, null, 2)}\n`, 'utf8');

  try {
    const removed = await removeMcpConfig('cursor', {
      global: false,
      cwd: tempDir,
      stdout: { write() { return true; } }
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
  await fs.promises.writeFile(configPath, [
    'model = "gpt-5"',
    '',
    '[mcp_servers."browser-bridge"]',
    'command = "bbx"',
    'args = ["mcp", "serve"]',
    '',
    '[sandbox_workspace_write]',
    'network_access = true',
    ''
  ].join('\n'), 'utf8');

  try {
    const removed = await removeMcpConfig('codex', {
      global: false,
      cwd: tempDir,
      stdout: { write() { return true; } }
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
  const originalAppData = process.env.APPDATA;

  try {
    process.env.HOME = tempHome;
    if (process.platform === 'win32') {
      process.env.APPDATA = path.join(tempHome, 'AppData', 'Roaming');
    }

    const userDir = process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(tempHome, 'AppData', 'Roaming'), 'Code', 'User')
      : process.platform === 'linux'
        ? path.join(tempHome, '.config', 'Code', 'User')
        : path.join(tempHome, 'Library', 'Application Support', 'Code', 'User');
    const userConfigPath = path.join(tempHome, '.copilot', 'mcp-config.json');
    const profileConfigPath = path.join(userDir, 'profiles', 'profile-a', 'mcp.json');
    await fs.promises.mkdir(path.dirname(profileConfigPath), { recursive: true });

    await installMcpConfig('copilot', {
      global: true,
      stdout: { write() { return true; } }
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
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  }
});

test('requireSession refreshes an expired saved session', async () => {
  await withTempCodexHome(async () => {
    await saveSession({
      sessionId: 'sess_old',
      tabId: 7,
      origin: 'https://example.com',
      capabilities: [],
      expiresAt: Date.now() - 1
    });

    /** @type {Array<{ method: string, sessionId?: string | null, params?: Record<string, unknown> }>} */
    const calls = [];
    const client = {
      connected: true,
      async connect() {},
      async request({ method, params = {}, sessionId = null }) {
        calls.push({ method, params, sessionId });
        if (method === 'session.get_status') {
          return {
            id: 'req_1',
            ok: false,
            result: null,
            error: { code: 'SESSION_EXPIRED', message: 'Expired', details: null },
            meta: { protocol_version: '1.0' }
          };
        }
        return {
          id: 'req_2',
          ok: true,
          result: {
            sessionId: 'sess_new',
            tabId: 7,
            origin: 'https://example.com',
            capabilities: [],
            expiresAt: Date.now() + 60_000
          },
          error: null,
          meta: { protocol_version: '1.0' }
        };
      }
    };

    const session = await requireSession(/** @type {any} */ (client));
    assert.equal(session.sessionId, 'sess_new');
    assert.deepEqual(calls.map((call) => call.method), ['session.get_status', 'session.request_access']);
    assert.equal(calls[1].params?.tabId, 7);

    const saved = await loadSession();
    assert.equal(saved?.sessionId, 'sess_new');
  });
});

test('resolveRef returns the first matching elementRef', async () => {
  const client = {
    connected: true,
    async connect() {},
    async request() {
      return {
        id: 'req_1',
        ok: true,
        result: {
          nodes: [
            { elementRef: 'el_main' }
          ]
        },
        error: null,
        meta: { protocol_version: '1.0' }
      };
    }
  };

  const ref = await resolveRef(/** @type {any} */ (client), 'main', 'sess_test');
  assert.equal(ref, 'el_main');
});

test('getDoctorReport exposes extension id source and next steps without a live daemon', async () => {
  const report = await getDoctorReport({
    manifestPath: '/tmp/browser-bridge.json',
    defaultExtensionIdInfo: {
      extensionId: 'ahhmghheecmambjebhfjkngdggghbkno',
      source: 'built_in'
    },
    loadManifest: async () => null,
    loadSavedSession: async () => null,
    bridgeClientRunner: async () => {
      throw new Error('offline');
    }
  });

  assert.equal(report.defaultExtensionIdSource, 'built_in');
  assert.equal(report.manifestInstalled, false);
  assert.ok(report.issues.includes('native_host_manifest_missing'));
  assert.ok(report.nextSteps.some((step) => step.includes('bbx install')));
});

test('CLI bridge method bindings stay aligned with the protocol registry', () => {
  for (const [command, method] of Object.entries(CLI_METHOD_BINDINGS)) {
    assert.ok(BRIDGE_METHOD_REGISTRY[method], `${command} should map to a registered bridge method`);
  }
});
