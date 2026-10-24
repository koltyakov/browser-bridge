import assert from 'node:assert/strict';
import test from 'node:test';
import { connectFakeExtension, startTestDaemon } from '../_helpers/daemonHarness.ts';
import { runCli } from '../_helpers/runCli.ts';
import type {
  VisualBaselineDescriptor,
  VisualBaselineCompareResult,
  VisualCaptureFrame,
} from '../../protocol/src/types.js';

// Complete lossless RGBA PNGs, not fabricated headers. The renderer transport is simulated;
// the daemon, CLI connections, native decoding, comparison and encoding are real processes.
const pngs = [
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP48OHDfwAJdAPQXHvArAAAAABJRU5ErkJggg==',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgSDnxHwADwAIsn7GFYgAAAABJRU5ErkJggg==',
];

test('Go visual baselines retain pixels across CLI processes, compare exactly, advance and release', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);
  extension.enableAccess();
  const rect = { x: 10, y: 20, width: 1, height: 1 };
  const frame: VisualCaptureFrame = {
    image: `data:image/png;base64,${pngs[0]}`,
    capturedAt: new Date().toISOString(),
    scope: {
      tabId: 42,
      windowId: 1,
      documentId: 'isolated-document',
      rect,
      viewportWidth: 1280,
      viewportHeight: 800,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
      viewportScale: 1,
      visualViewportX: 0,
      visualViewportY: 0,
      visualViewportWidth: 1280,
      visualViewportHeight: 800,
    },
    contexts: [],
  };
  try {
    const create = runCli({
      args: ['call', '--tab', '42', 'screenshot.baseline.create', JSON.stringify({ rect })],
      env: ctx.env,
    });
    const forwarded = await extension.nextRequest();
    assert.equal(forwarded.method, 'screenshot.baseline.create');
    extension.respondOk(forwarded, frame);
    const created = await create;
    assert.equal(created.status, 0, created.stderr);
    const descriptor = created.json as VisualBaselineDescriptor;
    assert.match(descriptor.baselineId, /^visual_[a-f0-9]{32}$/u);
    assert(!JSON.stringify(descriptor).includes('base64'));

    for (const [index, advance, equal] of [
      [0, false, true],
      [1, true, false],
      [1, false, true],
    ] as const) {
      const compare = runCli({
        args: [
          'call',
          '--tab',
          '42',
          'screenshot.baseline.compare',
          JSON.stringify({ baselineId: descriptor.baselineId, advance }),
        ],
        env: ctx.env,
      });
      const request = await extension.nextRequest();
      assert.equal(request.tab_id, 42);
      assert.deepEqual(request.params, { rect });
      extension.respondOk(request, { ...frame, image: `data:image/png;base64,${pngs[index]}` });
      const compared = await compare;
      assert.equal(compared.status, 0, compared.stderr);
      const result = compared.json as VisualBaselineCompareResult;
      assert.equal(result.equal, equal);
      assert.equal(result.advanced, advance);
      assert.equal(result.changedPixels, equal ? 0 : 1);
      assert.equal(result.images.length, equal ? 0 : 2);
      assert.deepEqual(result.beforeScope, frame.scope);
      if (!equal) {
        assert.equal(result.images[0].phase, 'before');
        assert.equal(result.images[1].phase, 'after');
        assert.deepEqual(result.images[0].rect, { x: 0, y: 0, width: 1, height: 1 });
      }
    }
    for (const released of [true, false]) {
      const result = await runCli({
        args: [
          'call',
          'screenshot.baseline.release',
          JSON.stringify({ baselineId: descriptor.baselineId }),
        ],
        env: ctx.env,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.json, { baselineId: descriptor.baselineId, released });
    }
  } finally {
    extension.destroy();
    await ctx.stop();
  }
});
