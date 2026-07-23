import test from 'node:test';
import assert from 'node:assert/strict';

import { handleScreenshot } from '../src/background-screenshots.js';
import { ERROR_CODES, MAX_ARTIFACT_BYTES } from '../../protocol/src/index.js';

const target = {
  tabId: 7,
  windowId: 3,
  title: 'Capture',
  url: 'https://example.test/',
};

test('screenshot auto delivery uses artifact transport after a large-capture preflight', async () => {
  const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  const stored: Array<{ requestId: string; data: string }> = [];
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
      async run(_tabId: number, callback: (debugTarget: { tabId: number }) => Promise<unknown>) {
        return callback({ tabId: 7 });
      },
    },
    async storeArtifact(requestId: string, artifactData: string) {
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
