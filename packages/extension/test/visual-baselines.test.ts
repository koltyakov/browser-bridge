import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { withDocument } from '../../../tests/_helpers/dom.ts';
import { loadExtensionModule } from '../../../tests/_helpers/extensionBuild.ts';
import type { ScreenshotDeps } from '../src/background-screenshots.js';
import type { VisualRect } from '../../../protocol/src/types.js';
import { createSuccess } from '../../../protocol/src/index.js';

const { captureVisualBaseline, readVisualScope, invalidateVisualBaselines } =
  await loadExtensionModule<typeof import('../src/background-visual-baselines.js')>(
    'src/background-visual-baselines.js'
  );
const target = { tabId: 7, windowId: 3, title: 'Visual', url: 'https://example.test/' };

test('visual lifecycle notifications contain only tab identity and tolerate disconnection', () => {
  const messages: unknown[] = [];
  invalidateVisualBaselines(
    { postMessage: (message: unknown) => messages.push(message) } as unknown as chrome.runtime.Port,
    7
  );
  assert.deepEqual(messages, [{ type: 'host.visual_baseline_invalidated', tabId: 7 }]);
  invalidateVisualBaselines(null, 7);
  invalidateVisualBaselines(
    {
      postMessage() {
        throw new Error('Disconnected');
      },
    } as unknown as chrome.runtime.Port,
    7
  );
});
const { enforceTokenBudget } = await loadExtensionModule<
  typeof import('../src/background-helpers.js')
>('src/background-helpers.js');

test('visual renderer bytes are atomic internal evidence, not text to truncate for the model', () => {
  const frame = createSuccess('visual-budget', {
    image: 'data:image/png;base64,' + 'A'.repeat(10000),
    scope: { documentId: 'document-one' },
  });
  assert.equal(enforceTokenBudget('screenshot.baseline.create', frame, 1), frame);
  assert.equal(enforceTokenBudget('screenshot.baseline.compare', frame, 1), frame);
});

test('serialized visual scope preserves whole component boxes without page markers or text', async () => {
  await withDocument(
    '<html><body><figure id="chart"><canvas></canvas><figcaption>Secret caption</figcaption></figure><input value="secret" /></body></html>',
    ({ window, document }) => {
      const figure = document.querySelector('figure');
      const canvas = document.querySelector('canvas');
      assert(figure && canvas);
      Reflect.set(figure, 'getBoundingClientRect', () => ({
        x: 10.5,
        y: 20.5,
        width: 400,
        height: 300,
      }));
      Reflect.set(canvas, 'getBoundingClientRect', () => ({
        x: 30,
        y: 50,
        width: 300,
        height: 200,
      }));
      const html = document.documentElement.outerHTML;
      const sample = vm.runInNewContext(`(${readVisualScope.toString()})('#chart', null)`, {
        window,
        document,
      }) as ReturnType<typeof readVisualScope>;
      assert(!('error' in sample));
      assert.equal(sample.rect.x, 10);
      assert.equal(sample.rect.width, 401);
      assert.equal(sample.contexts.length, 2);
      assert(!JSON.stringify(sample).includes('Secret'));
      assert.equal(document.documentElement.outerHTML, html);
      assert('error' in readVisualScope('canvas,figure', null));
      assert('error' in readVisualScope('#missing', null));
      assert('error' in readVisualScope('[', null));
      assert('error' in readVisualScope(null, { x: -1, y: 0, width: 1, height: 1 }));
      assert('error' in readVisualScope(null, { x: 0, y: 0, width: Infinity, height: 1 }));
      assert('error' in readVisualScope('#chart', {}));
    }
  );
});

function visualHarness(changeOnLastSample: boolean = false) {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let samples = 0;
  const rect: VisualRect = { x: 10, y: 20, width: 200, height: 100 };
  const deps: ScreenshotDeps = {
    chrome: {
      scripting: {
        async executeScript(options: { func: (...args: unknown[]) => unknown }) {
          if (options.func.name === 'readVisualScope') {
            samples++;
            return [
              {
                documentId:
                  changeOnLastSample && samples === 2 ? 'changed-document' : 'document-one',
                result: {
                  rect,
                  viewportWidth: 1280,
                  viewportHeight: 800,
                  scrollX: 0,
                  scrollY: 0,
                  devicePixelRatio: 2,
                  viewportScale: 1,
                  visualViewportX: 0,
                  visualViewportY: 0,
                  visualViewportWidth: 1280,
                  visualViewportHeight: 800,
                  contexts: [rect],
                },
              },
            ];
          }
          return [{ result: { visibility: 'hidden', focused: false } }];
        },
      },
      tabs: {
        async get() {
          return { active: false, windowId: target.windowId };
        },
      },
      windows: {
        async get() {
          return { focused: false };
        },
      },
      debugger: {
        async sendCommand(_target: unknown, method: string, params?: Record<string, unknown>) {
          commands.push({ method, params });
          if (method === 'Page.getLayoutMetrics')
            return { cssVisualViewport: { pageX: 0, pageY: 0 } };
          return {
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',
          };
        },
      },
    } as unknown as typeof chrome,
    contentScriptTimeoutMs: 1000,
    async ensureContentScript() {},
    async sendTabMessage() {
      throw new Error('Not needed for region capture');
    },
    tabDebugger: {
      async run<T>(tabId: number, callback: (debugTarget: chrome.debugger.Debuggee) => Promise<T>) {
        return callback({ tabId });
      },
    },
    async storeArtifact() {
      throw new Error('Visual pixels must not be written to artifacts');
    },
  };
  return { deps, commands };
}

test('visual capture is lossless, scoped and uses document identity, not tab focus', async () => {
  const harness = visualHarness();
  const result = await captureVisualBaseline(
    target,
    'screenshot.baseline.create',
    { selector: '#card' },
    harness.deps,
    'visual-test'
  );
  assert.equal(result.scope.documentId, 'document-one');
  assert.equal(result.scope.devicePixelRatio, 2);
  assert.equal(result.scope.tabId, 7);
  assert(result.image.startsWith('data:image/png;base64,'));
  const capture = harness.commands.find((entry) => entry.method === 'Page.captureScreenshot');
  assert.equal(capture?.params?.format, 'png');
  assert.deepEqual(capture?.params?.clip, { x: 10, y: 20, width: 200, height: 100, scale: 1 });
  const unstable = visualHarness(true);
  await assert.rejects(
    captureVisualBaseline(
      target,
      'screenshot.baseline.compare',
      { selector: '#card' },
      unstable.deps,
      'unstable'
    ),
    (error: unknown) =>
      error instanceof Error && Reflect.get(error, 'code') === 'VISUAL_BASELINE_INVALIDATED'
  );
});
