import test from 'node:test';
import assert from 'node:assert/strict';

import { handleScreenshot } from '../src/background-screenshots.js';
import { ERROR_CODES, MAX_ARTIFACT_BYTES } from '../../protocol/src/index.js';
import { TabDebuggerCoordinator } from '../src/debugger-coordinator.js';
import type { DebuggerRunOptions } from '../src/debugger-coordinator.js';

const target = {
  tabId: 7,
  windowId: 3,
  title: 'Capture',
  url: 'https://example.test/',
};

test('screenshot preserves serialized content errors before computing geometry', async () => {
  const cases = [
    {
      method: 'screenshot.capture_element',
      error: 'Complete capture is unsupported for a fixed element.',
      code: 'RESULT_TRUNCATED',
      message: /fixed element/u,
    },
    {
      method: 'screenshot.capture_element',
      error: {
        code: 'ELEMENT_NOT_FOUND',
        message: 'Target was removed.',
        details: { ref: 'el_1' },
      },
      code: 'ELEMENT_NOT_FOUND',
      message: /Target was removed/u,
    },
    {
      method: 'screenshot.capture_full_page',
      error: 'Document is unavailable.',
      message: /Document is unavailable/u,
    },
  ];
  for (const scenario of cases) {
    const deps = {
      async ensureContentScript() {},
      async sendTabMessage() {
        return { error: scenario.error };
      },
    } as unknown as Parameters<typeof handleScreenshot>[3];
    await assert.rejects(handleScreenshot(target, scenario.method, {}, deps, 'content-error'), {
      ...(scenario.code ? { code: scenario.code } : {}),
      message: scenario.message,
    });
  }
});

test('screenshot auto delivery uses artifact transport after a large-capture preflight', async () => {
  const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  const stored: Array<{ requestId: string; data: string }> = [];
  let debuggerBusy = false;
  const data = Buffer.from('small compressed image').toString('base64');
  const artifact = {
    artifactId: `art_${'e'.repeat(43)}`,
    kind: 'screenshot' as const,
    mimeType: 'image/png',
    byteLength: Buffer.from('small compressed image').length,
    sha256: 'f'.repeat(64),
    chunkSize: 196_608,
    chunkCount: 1,
    createdAt: '2026-07-23T00:00:00.000Z',
    expiresAt: '2026-07-23T00:05:00.000Z',
  };
  const deps = {
    chrome: {
      debugger: {
        async sendCommand(_target: unknown, method: string, params: Record<string, unknown>) {
          commands.push({ method, params });
          return { data };
        },
      },
    },
    contentScriptTimeoutMs: 1000,
    async ensureContentScript() {},
    async sendTabMessage() {
      return { scrollWidth: 1200, scrollHeight: 1000, devicePixelRatio: 1 };
    },
    tabDebugger: {
      async run(
        _tabId: number,
        callback: (debugTarget: { tabId: number }) => Promise<unknown>,
        options: DebuggerRunOptions
      ) {
        assert.deepEqual(options, { retryDetached: true, releaseAfterRun: true });
        debuggerBusy = true;
        try {
          return await callback({ tabId: 7 });
        } finally {
          debuggerBusy = false;
        }
      },
    },
    async storeArtifact(requestId: string, artifactData: string) {
      assert.equal(debuggerBusy, false, 'artifact upload must run outside debugger work');
      stored.push({ requestId, data: artifactData });
      return artifact;
    },
  } as unknown as Parameters<typeof handleScreenshot>[3];

  const result = await handleScreenshot(
    target,
    'screenshot.capture_full_page',
    { delivery: 'auto' },
    deps,
    'capture-large'
  );

  assert.equal(result.delivery, 'artifact');
  assert.deepEqual(result.artifact, artifact);
  assert.deepEqual(stored, [{ requestId: 'capture-large', data }]);
  assert.equal(commands[0].method, 'Page.captureScreenshot');
});

test('screenshot scaling keeps an explicitly inline full-page capture one-call', async () => {
  const commands: Array<Record<string, unknown>> = [];
  const data = Buffer.from('scaled image').toString('base64');
  const deps = {
    chrome: {
      debugger: {
        async sendCommand(_target: unknown, _method: string, params: Record<string, unknown>) {
          commands.push(params);
          return { data };
        },
      },
    },
    contentScriptTimeoutMs: 1000,
    async ensureContentScript() {},
    async sendTabMessage() {
      return { scrollWidth: 1200, scrollHeight: 1000, devicePixelRatio: 2 };
    },
    tabDebugger: {
      async run(_tabId: number, callback: (debugTarget: { tabId: number }) => Promise<unknown>) {
        return callback({ tabId: 7 });
      },
    },
    async storeArtifact() {
      throw new Error('inline capture must not create an artifact');
    },
  } as unknown as Parameters<typeof handleScreenshot>[3];

  const result = await handleScreenshot(
    target,
    'screenshot.capture_full_page',
    { delivery: 'inline', scale: 0.5 },
    deps,
    'capture-scaled'
  );

  assert.equal(result.delivery, 'inline');
  assert.equal(result.image, `data:image/png;base64,${data}`);
  assert.deepEqual(result.dimensions, { width: 600, height: 500 });
  assert.deepEqual(commands[0].clip, {
    x: 0,
    y: 0,
    width: 1200,
    height: 1000,
    scale: 0.5,
  });
  assert.equal(commands[0].captureBeyondViewport, true);
});

test('screenshot metadata reads actual dimensions from encoded image data', async () => {
  const png = Buffer.alloc(24);
  png.set([0x89, 0x50, 0x4e, 0x47], 0);
  png.writeUInt32BE(3, 16);
  png.writeUInt32BE(4, 20);
  const deps = {
    chrome: {
      debugger: {
        async sendCommand(_target: unknown, method: string) {
          return method === 'Page.getLayoutMetrics'
            ? { cssVisualViewport: { pageX: 0, pageY: 0 } }
            : { data: png.toString('base64') };
        },
      },
    },
    contentScriptTimeoutMs: 1000,
    async ensureContentScript() {},
    async sendTabMessage() {},
    tabDebugger: {
      async run(_tabId: number, callback: (debugTarget: { tabId: number }) => Promise<unknown>) {
        return callback({ tabId: 7 });
      },
    },
    async storeArtifact() {
      throw new Error('inline capture must not create an artifact');
    },
  } as unknown as Parameters<typeof handleScreenshot>[3];

  const result = await handleScreenshot(
    target,
    'screenshot.capture_region',
    { x: 0, y: 0, width: 10, height: 10 },
    deps,
    'capture-dimensions'
  );
  assert.deepEqual(result.dimensions, { width: 3, height: 4 });
  assert.equal(result.context?.rectSpace, 'viewport-css');
  assert.equal(result.context?.source, 'cdp-renderer');
  assert.equal(result.context?.tabActive, null);
  assert.ok(Number.isFinite(Date.parse(result.context?.capturedAt ?? '')));
});

test('screenshot artifact delivery rejects bytes above the daemon limit before upload', async () => {
  const data = 'A'.repeat(Math.ceil((MAX_ARTIFACT_BYTES + 1) / 3) * 4);
  let storeCalls = 0;
  const deps = {
    chrome: {
      debugger: {
        async sendCommand() {
          return { data };
        },
      },
    },
    contentScriptTimeoutMs: 1000,
    async ensureContentScript() {},
    async sendTabMessage() {
      return { scrollWidth: 1000, scrollHeight: 1000, devicePixelRatio: 1 };
    },
    tabDebugger: {
      async run(_tabId: number, callback: (debugTarget: { tabId: number }) => Promise<unknown>) {
        return callback({ tabId: 7 });
      },
    },
    async storeArtifact() {
      storeCalls += 1;
      throw new Error('oversized capture must not upload');
    },
  } as unknown as Parameters<typeof handleScreenshot>[3];

  await assert.rejects(
    handleScreenshot(
      target,
      'screenshot.capture_full_page',
      { delivery: 'artifact' },
      deps,
      'capture-oversized'
    ),
    (error: { code?: string }) => error.code === ERROR_CODES.RESULT_TOO_LARGE
  );
  assert.equal(storeCalls, 0);
});

test('a blocked screenshot artifact upload does not hold the debugger attachment', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveUpload: (
    value: import('../../protocol/src/types.js').ArtifactDescriptor
  ) => void = () => {};
  let uploadStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    uploadStarted = resolve;
  });
  const upload = new Promise<import('../../protocol/src/types.js').ArtifactDescriptor>(
    (resolve) => {
      resolveUpload = resolve;
    }
  );
  let detached: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    detached = resolve;
  });
  const coordinator = new TabDebuggerCoordinator({
    attach: async () => {},
    detach: async () => detached(),
  });
  const deps = {
    chrome: {
      debugger: {
        async sendCommand(_target: unknown, method: string) {
          return method === 'Page.getLayoutMetrics'
            ? { cssVisualViewport: { pageX: 0, pageY: 0 } }
            : { data: Buffer.from('image').toString('base64') };
        },
      },
    },
    contentScriptTimeoutMs: 1000,
    async ensureContentScript() {},
    async sendTabMessage() {},
    tabDebugger: coordinator,
    async storeArtifact() {
      uploadStarted();
      return upload;
    },
  } as unknown as Parameters<typeof handleScreenshot>[3];
  const capture = handleScreenshot(
    target,
    'screenshot.capture_region',
    { x: 0, y: 0, width: 10, height: 10, delivery: 'artifact' },
    deps,
    'capture-slow-upload'
  );

  await started;
  t.mock.timers.tick(0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await released;
  assert.equal(coordinator.attachedTabs.size, 0);
  resolveUpload({
    artifactId: `art_${'e'.repeat(43)}`,
    kind: 'screenshot',
    mimeType: 'image/png',
    byteLength: 5,
    sha256: 'f'.repeat(64),
    chunkSize: 196_608,
    chunkCount: 1,
    createdAt: '2026-07-23T00:00:00.000Z',
    expiresAt: '2026-07-23T00:05:00.000Z',
  });
  assert.equal((await capture).delivery, 'artifact');
});
