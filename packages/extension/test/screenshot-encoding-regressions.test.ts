import assert from 'node:assert/strict';
import test from 'node:test';
import { withDocument } from '../../../tests/_helpers/dom.ts';
import { loadExtensionModule } from '../../../tests/_helpers/extensionBuild.ts';
import { SCREENSHOT_MAX_INLINE_BYTES } from '../../../protocol/src/index.js';
import type { ScreenshotDeps } from '../src/background-screenshots.js';

const { handleScreenshot, readScreenshotDocumentState } = await loadExtensionModule<
  typeof import('../src/background-screenshots.js')
>('src/background-screenshots.js');

const target = { tabId: 7, windowId: 3, title: 'Capture', url: 'https://example.test/' };

// Complete 3-by-2 images encoded by Pillow, rather than headers manufactured to match the parser.
const images = [
  {
    name: 'progressive JPEG',
    format: 'jpeg',
    data: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAACAAMDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUAQEAAAAAAAAAAAAAAAAAAAAF/9oADAMBAAIQAxAAAAGQGDv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAn//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/An//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEA//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==',
  },
  {
    name: 'lossy WebP',
    format: 'webp',
    data: 'UklGRjwAAABXRUJQVlA4IDAAAADwAQCdASoDAAIAAUAmJaACdLoB+AAF9AAA/vFNr/0mzxNnibPkkf/KVeCxub4AAAA=',
  },
  {
    name: 'lossless WebP',
    format: 'webp',
    data: 'UklGRh4AAABXRUJQVlA4TBEAAAAvAkAAAAdQrXqUtv+BiOh/AAA=',
  },
  {
    name: 'extended WebP with alpha',
    format: 'webp',
    data: 'UklGRl4AAABXRUJQVlA4WAoAAAAQAAAAAgAAAQAAQUxQSAcAAAAAgICAgICAAFZQOCAwAAAA8AEAnQEqAwACAAFAJiWgAnS6AfgABfQAAP7xTa/9Js8TZ4mz5JH/ylXgsbm+AAAA',
  },
] as const;

function screenshotHarness(data: string, geometry: unknown = {}) {
  const captures: Array<Record<string, unknown> | undefined> = [];
  let artifactWrites = 0;
  const deps: ScreenshotDeps = {
    chrome: {
      debugger: {
        async sendCommand(_target: unknown, method: string, params?: Record<string, unknown>) {
          if (method === 'Page.getLayoutMetrics')
            return { cssVisualViewport: { pageX: 12, pageY: 34 } };
          assert.equal(method, 'Page.captureScreenshot');
          captures.push(params);
          return { data };
        },
      },
      tabs: {
        async get() {
          return { active: false };
        },
      },
      windows: {
        async get() {
          return { focused: false };
        },
      },
      scripting: {
        async executeScript(options: { func: () => unknown }) {
          return [{ result: options.func() }];
        },
      },
    } as unknown as typeof chrome,
    contentScriptTimeoutMs: 1000,
    async ensureContentScript() {},
    async sendTabMessage() {
      return geometry;
    },
    tabDebugger: {
      async run<T>(tabId: number, callback: (target: chrome.debugger.Debuggee) => Promise<T>) {
        return callback({ tabId });
      },
    },
    async storeArtifact() {
      artifactWrites++;
      throw new Error('No artifact upload expected');
    },
  };
  return { deps, captures, artifactWrites: () => artifactWrites };
}

test('screenshot dimensions reflect JPEG and all WebP encodings while retaining capture context', async () => {
  await withDocument(
    '<html><body>Private page contents are not sampled</body></html>',
    async ({ document }) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      Reflect.set(document, 'hasFocus', () => false);
      assert.deepEqual(readScreenshotDocumentState(), { visibility: 'hidden', focused: false });
      for (const image of images) {
        const harness = screenshotHarness(image.data);
        const result = await handleScreenshot(
          target,
          'screenshot.capture_region',
          {
            x: 10,
            y: 20,
            width: 200,
            height: 100,
            scale: 0.5,
            format: image.format,
            quality: 87.9,
          },
          harness.deps,
          image.name
        );
        assert.deepEqual(result.dimensions, { width: 3, height: 2 }, image.name);
        assert.equal(result.byteLength, Buffer.from(image.data, 'base64').length);
        assert(result.delivery === 'inline');
        assert.equal(result.image, `data:image/${image.format};base64,${image.data}`);
        assert.equal(result.context?.visibility, 'hidden');
        assert.equal(result.context?.documentFocused, false);
        assert.equal(result.context?.tabActive, false);
        assert.equal(result.context?.windowFocused, false);
        assert.deepEqual(result.context?.pageClip, {
          x: 22,
          y: 54,
          width: 200,
          height: 100,
          scale: 0.5,
        });
        assert.deepEqual(harness.captures, [
          {
            format: image.format,
            quality: 87,
            captureBeyondViewport: true,
            clip: { x: 22, y: 54, width: 200, height: 100, scale: 0.5 },
          },
        ]);
        assert.equal(harness.artifactWrites(), 0);
      }
    }
  );
});

test('truncated or invalid image headers fall back to capture dimensions without hanging the parser', async () => {
  await withDocument('<html><body></body></html>', async () => {
    const invalidSegment = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 1, 0, 0, 0, 0, 0, 0]);
    const trailingJunk = Buffer.from([0xff, 0xd8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    for (const data of [
      invalidSegment.toString('base64'),
      trailingJunk.toString('base64'),
      images[0].data.slice(0, 40),
    ]) {
      const harness = screenshotHarness(data);
      const result = await handleScreenshot(
        target,
        'screenshot.capture_region',
        {
          width: 25,
          height: 10,
          scale: 2,
          format: 'jpeg',
        },
        harness.deps,
        'invalid-encoded-dimensions'
      );
      assert.deepEqual(result.dimensions, { width: 50, height: 20 });
      assert(result.delivery === 'inline');
      assert.equal(result.image, `data:image/jpeg;base64,${data}`);
    }
  });
});

test('inline screenshot byte limits fail explicitly and never silently create an artifact', async () => {
  await withDocument('<html><body></body></html>', async () => {
    const data = Buffer.alloc(SCREENSHOT_MAX_INLINE_BYTES + 1, 65).toString('base64');
    const harness = screenshotHarness(data);
    await assert.rejects(
      handleScreenshot(
        target,
        'screenshot.capture_region',
        {
          width: 20,
          height: 20,
          delivery: 'inline',
        },
        harness.deps,
        'too-large'
      ),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(Reflect.get(error, 'code'), 'RESULT_TOO_LARGE');
        assert.deepEqual(Reflect.get(error, 'details'), {
          byteLength: SCREENSHOT_MAX_INLINE_BYTES + 1,
          maxInlineBytes: SCREENSHOT_MAX_INLINE_BYTES,
          guidance: 'Use delivery=artifact.',
        });
        return true;
      }
    );
    assert.equal(harness.captures.length, 1);
    assert.equal(harness.artifactWrites(), 0);
  });
});

test('negative element geometry and malformed content errors reject capture before debugger work', async () => {
  for (const geometry of [{ x: -1, y: 0, width: 10, height: 10 }, { error: {} }]) {
    const harness = screenshotHarness(images[0].data, geometry);
    await assert.rejects(
      handleScreenshot(
        target,
        'screenshot.capture_element',
        {
          elementRef: 'element_1',
        },
        harness.deps,
        'bad-geometry'
      ),
      'error' in geometry
        ? {
            code: 'INTERNAL_ERROR',
            message: 'Screenshot geometry failed.',
          }
        : {
            code: 'RESULT_TRUNCATED',
            message: /outside page bounds/,
          }
    );
    assert.deepEqual(harness.captures, []);
    assert.equal(harness.artifactWrites(), 0);
  }
});
