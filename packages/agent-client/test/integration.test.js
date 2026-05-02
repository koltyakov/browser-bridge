// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { handleHealthTool } from '../../mcp-server/src/handlers.js';
import { runNativeHost } from '../../native-host/src/native-host.js';
import { createFailure, createRequest, createSuccess } from '../../protocol/src/index.js';
import {
  decodeNativeMessages,
  frameNativeMessage,
} from '../../../tests/_helpers/nativeMessaging.js';
import { runCli } from '../../../tests/_helpers/runCli.js';
import {
  bridgeServerWith,
  startBridgeSocketServer,
} from '../../../tests/_helpers/socketHarness.js';

/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */

/**
 * @returns {Promise<void>}
 */
async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * @param {Buffer[]} chunks
 * @param {number} expectedCount
 * @returns {Promise<unknown[]>}
 */
async function waitForNativeMessages(chunks, expectedCount) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await flushAsyncWork();
    const messages = decodeNativeMessages(chunks);
    if (messages.length >= expectedCount) {
      return messages;
    }
  }
  return decodeNativeMessages(chunks);
}

/**
 * @param {() => boolean} predicate
 * @returns {Promise<void>}
 */
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await flushAsyncWork();
    if (predicate()) {
      return;
    }
  }
}

test('bbx status performs a real bridge health roundtrip over the socket protocol', async () => {
  const bridgeServer = await bridgeServerWith({
    'health.ping': (request) =>
      createSuccess(request.id, {
        daemon: 'ok',
        supported_versions: ['1.0'],
        extensionConnected: true,
        connectedExtensions: [
          {
            browserName: 'chrome',
            profileLabel: 'Default',
            accessEnabled: true,
          },
        ],
        access: {
          enabled: true,
          routeReady: true,
          routeTabId: 42,
          windowId: 7,
        },
      }),
  });

  try {
    const result = await runCli({
      args: ['status'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = result.json;

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, true);
    assert.equal(payload.evidence.daemon, 'ok');
    assert.match(payload.summary, /Daemon: ok/);
    assert.match(payload.summary, /tab 42/);
    assert.equal(bridgeServer.requests.length, 2);
    assert.equal(bridgeServer.requests[0].method, 'health.ping');
    assert.equal(bridgeServer.requests[0].meta.protocol_version, '1.0');
    assert.equal(bridgeServer.requests[1].method, 'health.ping');
    assert.equal(bridgeServer.requests[1].meta.protocol_version, '1.0');
    assert.equal(bridgeServer.requests[1].meta.source, 'cli');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx call writes a bridge request, prints the result JSON, and exits successfully', async () => {
  const bridgeServer = await bridgeServerWith({
    'health.ping': (request) =>
      createSuccess(request.id, {
        daemon: 'ok',
        supported_versions: ['1.0'],
        extensionConnected: false,
        connectedExtensions: [],
        access: {
          enabled: false,
          routeReady: false,
          routeTabId: null,
          windowId: null,
          reason: 'access_disabled',
        },
      }),
    'page.get_text': (request) =>
      createSuccess(request.id, {
        text: 'Bridge text payload',
        truncated: false,
        length: 19,
      }),
  });

  try {
    const result = await runCli({
      args: ['call', '--tab', '42', 'page.get_text', '{"textBudget":19}'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = result.json;

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.deepEqual(payload, {
      text: 'Bridge text payload',
      truncated: false,
      length: 19,
    });
    assert.equal(bridgeServer.requests.length, 2);
    assert.equal(bridgeServer.requests[1].method, 'page.get_text');
    assert.equal(bridgeServer.requests[1].tab_id, 42);
    assert.equal(bridgeServer.requests[1].params.textBudget, 100);
    assert.equal(bridgeServer.requests[1].meta.source, 'cli');
    assert.equal(bridgeServer.requests[1].meta.protocol_version, '1.0');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx call exits 1 and reports bridge failures with the error code on stderr', async () => {
  const bridgeServer = await bridgeServerWith({
    'health.ping': (request) =>
      createSuccess(request.id, {
        daemon: 'ok',
        supported_versions: ['1.0'],
        extensionConnected: false,
        connectedExtensions: [],
        access: {
          enabled: false,
          routeReady: false,
          routeTabId: null,
          windowId: null,
          reason: 'access_disabled',
        },
      }),
    'dom.query': (request) =>
      createFailure(request.id, 'INVALID_REQUEST', 'Bad \u001b[31mselector\u001b[0m', {
        selector: '#bad',
      }),
  });

  try {
    const result = await runCli({
      args: ['call', 'dom.query', '{"selector":"#bad"}'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = result.json;

    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /INVALID_REQUEST: Bad selector/);
    assert.equal(result.stderr.includes('\u001b['), false);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'INVALID_REQUEST');
    assert.equal(payload.error.message, 'Bad selector');
    assert.deepEqual(payload.error.details, { selector: '#bad' });
    assert.equal(bridgeServer.requests.length, 2);
    assert.equal(bridgeServer.requests[1].method, 'dom.query');
    assert.deepEqual(bridgeServer.requests[1].params, {
      selector: '#bad',
      withinRef: null,
      budget: {
        maxNodes: 25,
        maxDepth: 4,
        textBudget: 600,
        includeBbox: true,
        attributeAllowlist: [],
      },
    });
    assert.equal(bridgeServer.requests[1].meta.source, 'cli');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('handleHealthTool uses the live bridge client path and preserves MCP request metadata', async () => {
  const bridgeServer = await bridgeServerWith({
    'health.ping': (request) =>
      createSuccess(request.id, {
        daemon: 'ok',
        supported_versions: ['1.0'],
        extensionConnected: false,
        connectedExtensions: [],
        access: {
          enabled: false,
          routeReady: false,
          routeTabId: null,
          windowId: null,
          reason: 'access_disabled',
        },
      }),
  });
  const originalBridgeHome = process.env.BROWSER_BRIDGE_HOME;
  process.env.BROWSER_BRIDGE_HOME = bridgeServer.bridgeHome;

  try {
    const result = await handleHealthTool();

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Daemon: ok/);
    assert.equal(result.structuredContent.ok, true);
    assert.equal(bridgeServer.requests.length, 2);
    assert.equal(bridgeServer.requests[1].method, 'health.ping');
    assert.equal(bridgeServer.requests[1].meta.source, 'mcp');
    assert.equal(bridgeServer.requests[1].meta.protocol_version, '1.0');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    if (originalBridgeHome === undefined) {
      delete process.env.BROWSER_BRIDGE_HOME;
    } else {
      process.env.BROWSER_BRIDGE_HOME = originalBridgeHome;
    }
    await bridgeServer.close();
  }
});

test('runNativeHost bridges a framed host request through the daemon socket and back', async () => {
  const bridgeServer = await startBridgeSocketServer(async (message, context) => {
    const record = /** @type {Record<string, unknown>} */ (message);
    if (record.type !== 'agent.request') {
      return;
    }
    const request = /** @type {BridgeRequest} */ (record.request);
    context.socket.write(
      `${JSON.stringify({
        type: 'agent.response',
        response: createSuccess(request.id, {
          tabs: [
            {
              tabId: 9,
              active: true,
              origin: 'https://example.com',
              title: 'Example',
            },
          ],
        }),
      })}\n`
    );
  });
  const originalStdoutWrite = process.stdout.write;
  const originalExit = process.exit;
  /** @type {Buffer[]} */
  const stdoutChunks = [];
  const stdinListenersBefore = process.stdin.listeners('data');
  /** @type {number | null} */
  let exitCode = null;
  let bridgeServerClosed = false;

  process.stdout.write = /** @type {typeof process.stdout.write} */ (
    (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    }
  );
  process.exit = /** @type {typeof process.exit} */ (
    (code) => {
      exitCode = typeof code === 'number' ? code : 0;
      return undefined;
    }
  );

  try {
    await runNativeHost({ socketPath: bridgeServer.socketPath });
    await flushAsyncWork();
    await waitFor(() =>
      process.stdin.listeners('data').some((listener) => !stdinListenersBefore.includes(listener))
    );

    const stdinListenersAfter = process.stdin.listeners('data');
    assert.equal(
      stdinListenersAfter.some((listener) => !stdinListenersBefore.includes(listener)),
      true,
      'runNativeHost should attach a stdin data listener before test input is emitted'
    );

    process.stdin.emit(
      'data',
      frameNativeMessage({
        type: 'host.bridge_request',
        request: createRequest({
          id: 'req_native_roundtrip',
          method: 'tabs.list',
          meta: { source: 'cli' },
        }),
      })
    );

    const messages = await waitForNativeMessages(stdoutChunks, 1);
    assert.deepEqual(messages, [
      {
        type: 'host.bridge_response',
        response: createSuccess('req_native_roundtrip', {
          tabs: [
            {
              tabId: 9,
              active: true,
              origin: 'https://example.com',
              title: 'Example',
            },
          ],
        }),
      },
    ]);
    assert.equal(bridgeServer.messages.length >= 2, true);
    assert.equal(bridgeServer.requests.length, 1);
    assert.equal(bridgeServer.requests[0].method, 'tabs.list');
    assert.equal(bridgeServer.requests[0].meta.protocol_version, '1.0');
    assert.equal(bridgeServer.requests[0].meta.source, 'cli');
    assert.deepEqual(bridgeServer.errors, []);
    await bridgeServer.close();
    bridgeServerClosed = true;
    await waitFor(() => exitCode === 0);
  } finally {
    if (!bridgeServerClosed) {
      await bridgeServer.close();
    }
    process.stdout.write = originalStdoutWrite;
    process.exit = originalExit;
    for (const listener of process.stdin.listeners('data')) {
      if (!stdinListenersBefore.includes(listener)) {
        process.stdin.removeListener('data', listener);
      }
    }
    process.stdin.pause();
  }

  assert.equal(exitCode, 0);
});
