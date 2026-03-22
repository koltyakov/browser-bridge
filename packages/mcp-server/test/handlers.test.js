// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BridgeClient } from '../../agent-client/src/client.js';
import { clearSession, saveSession } from '../../agent-client/src/session-store.js';
import {
  handleCaptureTool,
  handleDomTool,
  handleInputTool,
  handleNavigationTool,
  handlePageTool,
  handlePatchTool,
  handleRawCallTool,
  handleSessionTool,
  handleSkillTool,
  handleStatusTool,
  handleStylesLayoutTool,
  handleTabsTool
} from '../src/handlers.js';

/**
 * Set CODEX_HOME to a temp dir, save a test session, run the callback, then
 * restore the original env and clean up the session. Using a temp dir ensures
 * session reads/writes stay isolated and don't require permissions on the real
 * ~/.codex directory.
 *
 * @param {() => Promise<void>} callback
 * @returns {Promise<void>}
 */
async function withTestSession(callback) {
  const prevCodexHome = process.env.CODEX_HOME;
  const tempCodexHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-handler-test-'));
  process.env.CODEX_HOME = tempCodexHome;
  await saveSession({
    sessionId: 'sess_test',
    tabId: 42,
    origin: 'https://example.com',
    capabilities: [],
    expiresAt: Date.now() + 60_000
  });
  try {
    await callback();
  } finally {
    await clearSession();
    if (prevCodexHome !== undefined) {
      process.env.CODEX_HOME = prevCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }
    await fs.promises.rm(tempCodexHome, { recursive: true, force: true });
  }
}

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
  await withTestSession(async () => {
    await withMockedBridge(async (record, index) => {
      if (index === 0) {
        assert.equal(record.method, 'session.get_status');
        return ok({
          sessionId: 'sess_test',
          tabId: 42,
          origin: 'https://example.com',
          capabilities: [],
          expiresAt: Date.now() + 60_000
        });
      }

      assert.equal(record.method, 'dom.query');
      assert.equal(record.sessionId, 'sess_test');
      return ok({
        nodes: [
          { elementRef: 'el_main', tag: 'main', attrs: {}, bbox: {}, textExcerpt: 'Hello' }
        ]
      });
    }, async (calls) => {
      const result = await handleDomTool({ action: 'query', selector: 'main' });

      assert.equal(calls.length, 2);
      assert.equal(calls[1].sessionId, 'sess_test');
      assert.match(result.content[0].text, /DOM query returned 1 element/);
      assert.equal(result.structuredContent.ok, true);
    });
  });
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

test('handleStatusTool returns doctor report without bridge calls', async () => {
  // handleStatusTool calls getDoctorReport, which tries to connect. Since there is no
  // daemon running in tests it should catch the error and still return a tool result.
  const result = await handleStatusTool();
  // Either success or error — the key is it must return a ToolResult, never throw.
  assert.ok(typeof result.structuredContent === 'object');
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content[0].type, 'text');
});

test('handleSkillTool returns runtime context without a bridge connection', async () => {
  const result = await handleSkillTool();
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Runtime context retrieved/);
  assert.ok(result.structuredContent.runtimeContext);
});

/** A minimal resolved session returned by session.get_status mocks. */
const TEST_SESSION = Object.freeze({
  sessionId: 'sess_test',
  tabId: 42,
  origin: 'https://example.com',
  capabilities: [],
  expiresAt: Date.now() + 60_000
});

/**
 * Return a mock responder that always responds to session.get_status with the
 * test session and delegates all other calls to `inner`.
 *
 * @param {(record: import('./handlers.test.js').RequestRecord, index: number) => Promise<import('../../protocol/src/types.js').BridgeResponse>} inner
 * @returns {(record: import('./handlers.test.js').RequestRecord, index: number) => Promise<import('../../protocol/src/types.js').BridgeResponse>}
 */
function withSessionMock(inner) {
  return async (record, index) => {
    if (record.method === 'session.get_status') {
      return ok(TEST_SESSION);
    }
    return inner(record, index);
  };
}

test('handleSessionTool request_access calls session.request_access', async () => {
  // request_access does not need a session but does call saveSession on success.
  await withTestSession(async () => {
    await withMockedBridge(async () => ok({
      sessionId: 'sess_new',
      tabId: 5,
      origin: 'https://example.com',
      capabilities: [],
      expiresAt: Date.now() + 60_000
    }), async (calls) => {
      const result = await handleSessionTool({ action: 'request_access', tabId: 5 });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'session.request_access');
      assert.equal(result.isError, undefined);
    });
  });
});

test('handleSessionTool get_status calls session.get_status with the provided sessionId', async () => {
  await withMockedBridge(async () => ok({
    sessionId: 'sess_abc',
    tabId: 7,
    origin: 'https://example.com',
    capabilities: [],
    expiresAt: Date.now() + 60_000
  }), async (calls) => {
    const result = await handleSessionTool({ action: 'get_status', sessionId: 'sess_abc' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'session.get_status');
    assert.equal(calls[0].sessionId, 'sess_abc');
    assert.equal(result.isError, undefined);
  });
});

test('handlePageTool state calls page.get_state', async () => {
  await withTestSession(async () => {
    await withMockedBridge(withSessionMock(async () => ok({
      url: 'https://example.com/',
      title: 'Example',
      origin: 'https://example.com',
      hints: {}
    })), async (calls) => {
      const result = await handlePageTool({ action: 'state' });
      const pageCall = calls.find((c) => c.method === 'page.get_state');
      assert.ok(pageCall, 'page.get_state should be called');
      assert.equal(result.isError, undefined);
    });
  });
});

test('handlePageTool evaluate calls page.evaluate with given expression', async () => {
  await withTestSession(async () => {
    await withMockedBridge(withSessionMock(async () => ok({ value: 42, type: 'number' })), async (calls) => {
      const result = await handlePageTool({ action: 'evaluate', expression: '1+1' });
      const evalCall = calls.find((c) => c.method === 'page.evaluate');
      assert.ok(evalCall, 'page.evaluate should be called');
      assert.equal(evalCall.params.expression, '1+1');
      assert.equal(result.isError, undefined);
    });
  });
});

test('handleNavigationTool navigate calls navigation.navigate', async () => {
  await withTestSession(async () => {
    await withMockedBridge(withSessionMock(async () => ok({ navigated: true })), async (calls) => {
      const result = await handleNavigationTool({ action: 'navigate', url: 'https://example.com' });
      const navCall = calls.find((c) => c.method === 'navigation.navigate');
      assert.ok(navCall, 'navigation.navigate should be called');
      assert.equal(navCall.params.url, 'https://example.com');
      assert.equal(result.isError, undefined);
    });
  });
});

test('handleNavigationTool scroll calls viewport.scroll', async () => {
  await withTestSession(async () => {
    await withMockedBridge(withSessionMock(async () => ok({})), async (calls) => {
      const result = await handleNavigationTool({ action: 'scroll', top: 500 });
      const scrollCall = calls.find((c) => c.method === 'viewport.scroll');
      assert.ok(scrollCall, 'viewport.scroll should be called');
      assert.equal(scrollCall.params.top, 500);
      assert.equal(result.isError, undefined);
    });
  });
});

test('handleInputTool click resolves elementRef and calls input.click', async () => {
  await withTestSession(async () => {
    await withMockedBridge(withSessionMock(async (record) => {
      if (record.method === 'dom.query') {
        return ok({ nodes: [{ elementRef: 'el_btn', tag: 'button', attrs: {}, bbox: {}, textExcerpt: 'OK' }] });
      }
      return ok({});
    }), async (calls) => {
      const result = await handleInputTool({ action: 'click', selector: 'button' });
      const clickCall = calls.find((c) => c.method === 'input.click');
      assert.ok(clickCall, 'input.click should be called');
      assert.equal(result.isError, undefined);
    });
  });
});

test('handleStylesLayoutTool computed resolves ref and calls styles.get_computed', async () => {
  await withTestSession(async () => {
    await withMockedBridge(withSessionMock(async (record) => {
      if (record.method === 'dom.query') {
        return ok({ nodes: [{ elementRef: 'el_div', tag: 'div', attrs: {}, bbox: {}, textExcerpt: '' }] });
      }
      return ok({ properties: { color: 'red' }, elementRef: 'el_div' });
    }), async (calls) => {
      const result = await handleStylesLayoutTool({ action: 'computed', selector: 'div', properties: ['color'] });
      const styleCall = calls.find((c) => c.method === 'styles.get_computed');
      assert.ok(styleCall, 'styles.get_computed should be called');
      assert.equal(result.isError, undefined);
    });
  });
});

test('handlePatchTool list calls patch.list', async () => {
  await withTestSession(async () => {
    await withMockedBridge(withSessionMock(async () => ok({ patches: [] })), async (calls) => {
      const result = await handlePatchTool({ action: 'list' });
      const patchCall = calls.find((c) => c.method === 'patch.list');
      assert.ok(patchCall, 'patch.list should be called');
      assert.equal(result.isError, undefined);
    });
  });
});

test('handleCaptureTool element resolves ref and calls screenshot.capture_element', async () => {
  await withTestSession(async () => {
    await withMockedBridge(withSessionMock(async (record) => {
      if (record.method === 'dom.query') {
        return ok({ nodes: [{ elementRef: 'el_hero', tag: 'div', attrs: {}, bbox: {}, textExcerpt: '' }] });
      }
      return ok({ image: 'data:image/png;base64,abc', rect: {} });
    }), async (calls) => {
      const result = await handleCaptureTool({ action: 'element', selector: '.hero' });
      const captureCall = calls.find((c) => c.method === 'screenshot.capture_element');
      assert.ok(captureCall, 'screenshot.capture_element should be called');
      assert.equal(result.isError, undefined);
    });
  });
});
