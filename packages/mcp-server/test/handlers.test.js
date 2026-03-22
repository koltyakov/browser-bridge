// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BridgeClient } from '../../agent-client/src/client.js';
import { clearSession, saveSession } from '../../agent-client/src/session-store.js';
import {
  handleDomTool,
  handleRawCallTool,
  handleTabsTool
} from '../src/handlers.js';

/**
 * @typedef {{
 *   method: import('../../protocol/src/types.js').BridgeMethod,
 *   params?: Record<string, unknown>,
 *   sessionId?: string | null
 * }} RequestRecord
 */

/**
 * @param {(record: RequestRecord, index: number) => Promise<import('../../protocol/src/types.js').BridgeResponse>} responder
 * @param {(calls: RequestRecord[]) => Promise<void>} callback
 * @returns {Promise<void>}
 */
async function withMockedBridge(responder, callback) {
  const originalConnect = BridgeClient.prototype.connect;
  const originalClose = BridgeClient.prototype.close;
  const originalRequest = BridgeClient.prototype.request;
  /** @type {RequestRecord[]} */
  const calls = [];

  BridgeClient.prototype.connect = async function connect() {
    this.connected = true;
  };
  BridgeClient.prototype.close = async function close() {};
  BridgeClient.prototype.request = async function request({ method, params = {}, sessionId = null }) {
    const record = { method, params, sessionId };
    calls.push(record);
    return responder(record, calls.length - 1);
  };

  try {
    await callback(calls);
  } finally {
    BridgeClient.prototype.connect = originalConnect;
    BridgeClient.prototype.close = originalClose;
    BridgeClient.prototype.request = originalRequest;
  }
}

/**
 * @param {unknown} result
 * @returns {import('../../protocol/src/types.js').BridgeResponse}
 */
function ok(result) {
  return {
    id: 'req_test',
    ok: true,
    result,
    error: null,
    meta: { protocol_version: '1.0' }
  };
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {import('../../protocol/src/types.js').BridgeResponse}
 */
function fail(code, message) {
  return {
    id: 'req_test',
    ok: false,
    result: null,
    error: { code: /** @type {any} */ (code), message, details: null },
    meta: { protocol_version: '1.0' }
  };
}

test('handleTabsTool maps list to tabs.list and returns summarized output', async () => {
  await withMockedBridge(async () => ok({
    tabs: [{ tabId: 4, active: true, origin: 'https://example.com', title: 'Example' }]
  }), async (calls) => {
    const result = await handleTabsTool({ action: 'list' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'tabs.list');
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Bridge listed 1 tab/);
    assert.equal(result.structuredContent.ok, true);
  });
});

test('handleDomTool reuses the saved session for session-bound calls', async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const tempCodexHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-mcp-test-'));
  process.env.CODEX_HOME = tempCodexHome;
  await saveSession({
    sessionId: 'sess_saved',
    tabId: 12,
    origin: 'https://example.com',
    capabilities: [],
    expiresAt: Date.now() + 60_000
  });

  try {
    await withMockedBridge(async (record, index) => {
      if (index === 0) {
        assert.equal(record.method, 'session.get_status');
        return ok({
          sessionId: 'sess_saved',
          tabId: 12,
          origin: 'https://example.com',
          capabilities: [],
          expiresAt: Date.now() + 60_000
        });
      }

      assert.equal(record.method, 'dom.query');
      assert.equal(record.sessionId, 'sess_saved');
      return ok({
        nodes: [
          { elementRef: 'el_main', tag: 'main', attrs: {}, bbox: {}, textExcerpt: 'Hello' }
        ]
      });
    }, async (calls) => {
      const result = await handleDomTool({ action: 'query', selector: 'main' });

      assert.equal(calls.length, 2);
      assert.equal(calls[1].sessionId, 'sess_saved');
      assert.match(result.content[0].text, /DOM query returned 1 element/);
      assert.equal(result.structuredContent.ok, true);
    });
  } finally {
    await clearSession();
    if (previousCodexHome) {
      process.env.CODEX_HOME = previousCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }
  }
});

test('handleTabsTool translates bridge failures into MCP tool errors', async () => {
  await withMockedBridge(async () => fail('ACCESS_DENIED', 'Denied'), async () => {
    const result = await handleTabsTool({ action: 'list' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /ACCESS_DENIED/);
    assert.equal(result.structuredContent.ok, false);
  });
});

test('handleRawCallTool rejects unsupported methods without calling the bridge', async () => {
  await withMockedBridge(async () => ok({}), async (calls) => {
    const result = await handleRawCallTool({ method: 'not.real', params: {} });
    assert.equal(calls.length, 0);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown bridge method/);
  });
});
