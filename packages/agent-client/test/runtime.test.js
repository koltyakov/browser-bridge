// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BRIDGE_METHOD_REGISTRY } from '../../protocol/src/index.js';
import { CLI_METHOD_BINDINGS } from '../src/command-registry.js';
import { detectMcpClients, detectSkillTargets } from '../src/detect.js';
import { installMcpConfig } from '../src/mcp-config.js';
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
    claude: () => true,
    codex: () => true,
    opencode: () => false
  };

  assert.deepEqual(detectMcpClients(detectors), ['copilot', 'codex', 'claude']);
  assert.deepEqual(detectSkillTargets(detectors), ['copilot', 'codex', 'claude', 'agents']);
});

test('detectSkillTargets includes cursor when detected', () => {
  /** @type {Record<string, () => boolean>} */
  const detectors = {
    copilot: () => false,
    cursor: () => true,
    claude: () => false,
    codex: () => false,
    opencode: () => false
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
      extensionId: 'niaidbpnkbfbjgdfieabpmlomilpdipn',
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
