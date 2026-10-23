import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequest } from '../../../protocol/src/index.js';
import type { BridgeMethod } from '../../../protocol/src/types.js';
import { createChromeFake } from '../../../tests/_helpers/chromeFake.ts';
import { createExtensionState } from '../src/background-state.js';
import { createFileStaging } from '../src/background-files.js';
import { createDownloadController } from '../src/background-downloads.js';
import { createRecordingController } from '../src/background-recording.js';
import { TabDebuggerCoordinator } from '../src/debugger-coordinator.js';
import { resolveDataRequestScope, type StoreByteArtifact } from '../src/background-data-scope.js';
import { createFileRequestHandler } from '../src/background-file-requests.js';
import { createRecordingRequestHandler } from '../src/background-recording-requests.js';
import { captureWindowGrant } from '../src/background-access.js';
import { handleTabBoundRequest } from '../src/background-tab-bound.js';
import { createBackgroundInputController } from '../src/background-input.js';

function setup() {
  const state = createExtensionState();
  state.enabledWindow = { windowId: 5, enabledAt: 1, title: 'Enabled' };
  const disconnectedDataRequests = new Set<string>();
  const scope = {
    state,
    disconnectedDataRequests,
    resolveRequestTarget: async () => ({
      tabId: 21,
      windowId: 5,
      title: 'Test',
      url: 'https://example.com',
    }),
  };
  const artifacts: Array<{ bytes: Uint8Array; mimeType: string }> = [];
  const storeByteArtifact: StoreByteArtifact = async (_id, bytes, options) => {
    artifacts.push({ bytes, mimeType: options.mimeType });
    return {
      artifactId: 'art_' + 'a'.repeat(32),
      kind: options.kind,
      mimeType: options.mimeType,
      byteLength: bytes.length,
      sha256: 'a'.repeat(64),
      chunkSize: 196608,
      chunkCount: 1,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    };
  };
  const request = (method: BridgeMethod, params: Record<string, unknown> = {}) =>
    createRequest({
      id: 'data-request',
      method,
      tabId: 21,
      params,
      meta: { transport_owner: 'connection', agent_session: 'session' },
    });
  return { state, scope, request, artifacts, storeByteArtifact };
}

test('data scope rejects grant and transport changes during resolution and later checks', async () => {
  for (const change of ['revoke', 'replace', 'disconnect', 'transport'] as const) {
    const { state, scope, request } = setup();
    const mutate = () => {
      if (change === 'revoke') state.enabledWindow = null;
      else if (change === 'replace')
        state.enabledWindow = { windowId: 5, enabledAt: 2, title: 'New grant' };
      else if (change === 'disconnect') scope.disconnectedDataRequests.add('data-request');
      else state.nativePort = {} as chrome.runtime.Port;
    };
    const original = scope.resolveRequestTarget;
    scope.resolveRequestTarget = async () => {
      mutate();
      return original();
    };
    await assert.rejects(
      resolveDataRequestScope(request('session.status', { sessionId: 'test' }), scope),
      {
        code: 'ACCESS_DENIED',
      }
    );
  }
  const { state, scope, request } = setup();
  const captured = await resolveDataRequestScope(
    request('session.status', { sessionId: 'test' }),
    scope
  );
  scope.resolveRequestTarget = async () => {
    state.enabledWindow = null;
    return captured.target;
  };
  await assert.rejects(captured.assertAccess(), { code: 'ACCESS_DENIED' });
  const missingOwner = request('session.status', { sessionId: 'test' });
  delete missingOwner.meta.transport_owner;
  await assert.rejects(resolveDataRequestScope(missingOwner, scope), { code: 'ACCESS_DENIED' });
});

function filesHarness() {
  const harness = setup();
  const chrome = createChromeFake() as unknown as typeof globalThis.chrome;
  const stagedFiles = createFileStaging();
  const resourceFetches = new Set<number>();
  const resourceOwners = new Map<number, string>();
  const deps = {
    ...harness.scope,
    chrome,
    stagedFiles,
    downloads: createDownloadController({
      downloads: chrome.downloads,
      storage: chrome.storage.session,
    }),
    tabDebugger: new TabDebuggerCoordinator({
      attach: async () => {},
      detach: async () => {},
      burstIdleMs: 0,
    }),
    ensureContentScript: async () => {},
    getFrameForRef: async () => 3,
    sendTabMessage: async () => ({ focused: true, elementRef: 'el_test_1' }),
    storeByteArtifact: harness.storeByteArtifact,
    resourceFetches,
    resourceOwners,
  };
  return {
    ...harness,
    deps,
    handle: createFileRequestHandler(deps),
    resourceFetches,
    resourceOwners,
  };
}

test('file request handler stages, assigns in the owning frame, and releases files', async () => {
  const { handle, request, deps } = filesHarness();
  const staged = await handle(
    request('files.stage', {
      name: 'test.txt',
      size: 1,
      offset: 0,
      data: 'YQ==',
      mimeType: 'text/plain',
    })
  );
  assert.equal(staged.ok, true);
  const transferId = (staged.result as { transferId: string }).transferId;
  const injected: unknown[] = [];
  deps.chrome.scripting.executeScript = async (injection) => {
    injected.push(injection);
    return [{ frameId: 3, documentId: 'document', result: { assigned: 1 } }];
  };
  const assigned = await handle(
    request('input.set_files', { target: { elementRef: 'el_test_1' }, files: [transferId] })
  );
  assert.equal(assigned.ok, true);
  assert.deepEqual((injected[0] as { target: unknown }).target, { tabId: 21, frameIds: [3] });
  const released = await handle(request('files.release', { transferId }));
  assert.equal(released.ok, true);
});

test('file assignment does not inject after revocation during content-script setup', async () => {
  const { handle, request, deps, state } = filesHarness();
  const staged = await handle(
    request('files.stage', {
      name: 'test.txt',
      size: 1,
      offset: 0,
      data: 'YQ==',
      mimeType: 'text/plain',
    })
  );
  const transferId = (staged.result as { transferId: string }).transferId;
  deps.ensureContentScript = async () => {
    state.enabledWindow = null;
  };
  let injected = false;
  deps.chrome.scripting.executeScript = async () => {
    injected = true;
    return [];
  };
  await assert.rejects(
    handle(request('input.set_files', { target: { selector: 'input' }, files: [transferId] })),
    { code: 'ACCESS_DENIED' }
  );
  assert.equal(injected, false);
  deps.stagedFiles.clearTab(21);
});

test('resource fetch releases admission on success, errors, and transport changes', async () => {
  for (const outcome of ['success', 'error', 'disconnect'] as const) {
    const { handle, request, deps, state, artifacts, resourceFetches, resourceOwners } =
      filesHarness();
    deps.chrome.scripting.executeScript = async () => {
      if (outcome === 'error') throw new Error('fetch failed');
      if (outcome === 'disconnect') state.nativePort = {} as chrome.runtime.Port;
      return [
        {
          frameId: 0,
          documentId: 'document',
          result: { data: 'YQ==', mimeType: 'text/plain', status: 200 },
        },
      ];
    };
    const pending = handle(request('download.resource', { url: 'https://example.com/test.txt' }));
    if (outcome === 'success') {
      assert.equal((await pending).ok, true);
      assert.deepEqual([...artifacts[0].bytes], [97]);
    } else {
      await assert.rejects(pending);
      assert.equal(artifacts.length, 0);
    }
    assert.equal(resourceFetches.size, 0);
    assert.equal(resourceOwners.size, 0);
  }
});

test('recording handler dispatches lifecycle calls and JSON/HTML export with consistent ownership', async (t) => {
  const { scope, request, artifacts, storeByteArtifact } = setup();
  const recordings = createRecordingController({
    page: async () => ({ epoch: 'document', active: true, events: [], dropped: 0 }),
    captureFrame: async () => 'YQ==',
    startNetwork: async () => ({}),
    stopNetwork: async () => ({}),
    send: async () => ({}),
  });
  t.after(() => recordings.clear(21));
  const handle = createRecordingRequestHandler({
    ...scope,
    recordings,
    storeByteArtifact,
    journals: {
      begin: async () => {
        throw new Error('unexpected durable journal');
      },
    },
  });
  const started = await handle(request('session.start', { network: true, durationMs: 1000 }));
  assert.equal(started.ok, true);
  const sessionId = (started.result as { sessionId: string }).sessionId;
  for (const method of ['session.status', 'session.read', 'session.stop'] as const) {
    assert.equal(
      (
        await handle(
          request(
            method,
            method === 'session.read'
              ? { sessionId, cursor: 0, limit: 10, waitMs: 0 }
              : { sessionId }
          )
        )
      ).ok,
      true
    );
  }
  for (const format of ['json', 'html']) {
    assert.equal((await handle(request('session.export', { sessionId, format }))).ok, true);
  }
  assert.deepEqual(
    artifacts.map((artifact) => artifact.mimeType),
    ['application/json', 'text/html']
  );
  assert.equal((await handle(request('session.release', { sessionId }))).ok, true);
});

test('durable recording startup cannot continue after its journal await revokes access', async () => {
  const { scope, state, request, storeByteArtifact } = setup();
  let starts = 0;
  const recordings = createRecordingController({
    page: async () => {
      starts += 1;
      return { epoch: 'document', active: true, events: [], dropped: 0 };
    },
    captureFrame: async () => '',
    startNetwork: async () => ({}),
    stopNetwork: async () => ({}),
    send: async () => ({}),
  });
  const handle = createRecordingRequestHandler({
    ...scope,
    recordings,
    storeByteArtifact,
    journals: {
      begin: async () => {
        state.enabledWindow = null;
        return { journalId: 'journal-test', append: async () => {} };
      },
    },
  });
  await assert.rejects(handle(request('session.start', { durable: true })), {
    code: 'ACCESS_DENIED',
  });
  assert.equal(starts, 0);
  assert.equal(recordings.tabIds().length, 0);
});

test('DOM actions recheck access after instrumentation and after the debugger queue', async () => {
  for (const phase of ['instrumentation', 'debugger'] as const) {
    const { state, scope, request } = setup();
    let dispatched = false;
    await assert.rejects(
      handleTabBoundRequest(request('input.click', { target: { selector: '#save' } }), {
        resolveRequestTarget: scope.resolveRequestTarget,
        captureAccess: () => captureWindowGrant(state),
        ensureContentScript: async () => {
          if (phase === 'instrumentation') state.enabledWindow = null;
        },
        runWithDialogGuard: async (_tabId, operation) => {
          state.enabledWindow = null;
          return operation();
        },
        sendTabMessage: async () => {
          dispatched = true;
          return {};
        },
        handleScreenshot: async () => ({}),
        handleNativeInput: async () => ({}),
        toFailureResponse: () => {
          throw new Error('not a content failure');
        },
        contentScriptTimeoutMs: 5000,
      }),
      { code: 'ACCESS_DENIED' }
    );
    assert.equal(dispatched, false);
  }
});

test('native input cannot start when access is revoked while waiting for the debugger', async () => {
  const { state, request } = setup();
  let commands = 0;
  const native = createBackgroundInputController({
    captureAccess: () => captureWindowGrant(state),
    getTab: async () => ({ active: true }),
    runWithDebugger: async (_tabId, operation) => {
      state.enabledWindow = null;
      return operation({ tabId: 21 });
    },
    sendCommand: async () => {
      commands += 1;
      return {};
    },
    sendTabMessage: async () => ({}),
    contentScriptTimeoutMs: 5000,
  });
  const input = request('input.click', { target: { selector: '#save' }, executionMode: 'cdp' });
  await assert.rejects(
    native.handleNativeInput(
      input,
      { tabId: 21, windowId: 5, url: 'https://example.com', title: 'Test' },
      input.params
    ),
    { code: 'ACCESS_DENIED' }
  );
  assert.equal(commands, 0);
});
