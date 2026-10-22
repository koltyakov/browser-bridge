import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { extensionFile } from '../../../tests/_helpers/extensionBuild.ts';
import type { ScrollContainerDetection } from '../../../protocol/src/types.ts';

// Runs in a real browser with production content scripts and layout engines.
async function checkBrowserScrolling(): Promise<void> {
  const input = Reflect.get(globalThis, '__BBX_CONTENT_INPUT__') as {
    scrollViewport: (params: Record<string, unknown>) => {
      target: string;
      y: number;
      autoDetected?: boolean;
    };
    getScrollContainerDetection: () => ScrollContainerDetection;
  };
  const listener = Reflect.get(globalThis, '__bbxListener') as (
    message: { type: string; method: string; params: Record<string, unknown> },
    sender: object,
    respond: (value: { scroll: ScrollContainerDetection }) => void
  ) => void;
  const state = () =>
    new Promise<{ scroll: ScrollContainerDetection }>((resolve) =>
      listener({ type: 'bridge.execute', method: 'page.get_state', params: {} }, {}, resolve)
    );
  const equal = (actual: unknown, expected: unknown, label: string): void => {
    if (actual !== expected) throw new Error(`${label}: ${actual} !== ${expected}`);
  };
  const reset = (html: string): void => {
    document.documentElement.style.cssText = 'height:100%;overflow:hidden';
    document.body.style.cssText = 'margin:0;height:100vh;overflow:hidden;display:flex';
    document.body.innerHTML = html;
  };
  const panel = (id: string, width: string, tag = 'div'): string =>
    `<${tag} id="${id}" style="width:${width};height:100vh;overflow:auto"><div style="height:2400px;width:100%">content</div></${tag}>`;
  const get = (id: string): HTMLElement => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing ${id}`);
    return element;
  };

  reset(panel('primary', '100%', 'main'));
  equal(input.scrollViewport({ top: 200 }).autoDetected, true, 'nested container detection');
  equal(get('primary').scrollTop, 200, 'main scroll');
  equal(window.scrollY, 0, 'document unchanged');
  equal((await state()).scroll.container?.y, 200, 'page state uses actual container position');
  equal(input.scrollViewport({ top: 50, relative: true }).y, 250, 'relative nested scroll');
  equal(input.scrollViewport({ top: 0 }).y, 0, 'return to top');

  reset(panel('sidebar', '15%') + panel('primary', '85%', 'main'));
  input.scrollViewport({ top: 200 });
  equal(get('primary').scrollTop, 200, 'dominant main panel');
  equal(get('sidebar').scrollTop, 0, 'sidebar untouched');

  reset(panel('left', '50%', 'main') + panel('right', '50%', 'aside'));
  const ambiguous = (await state()).scroll;
  equal(ambiguous.ambiguous, true, 'split pane ambiguity');
  equal(ambiguous.candidates?.length, 2, 'split pane candidate references');
  let error: { code?: string; details?: ScrollContainerDetection } = {};
  try {
    input.scrollViewport({ top: 300 });
  } catch (caught) {
    error = caught as typeof error;
  }
  equal(error.code, 'ELEMENT_AMBIGUOUS', 'ambiguous scroll is rejected');
  equal(error.details?.candidates?.length, 2, 'error includes targets');
  equal(get('left').scrollTop, 0, 'left unchanged after rejection');
  equal(get('right').scrollTop, 0, 'right unchanged after rejection');
  const chosen = ambiguous.candidates?.[0];
  if (!chosen) throw new Error('No candidate');
  equal(
    input.scrollViewport({ target: { elementRef: chosen.elementRef }, top: 300 }).y,
    300,
    'explicit reference resolves ambiguity'
  );
  equal(
    input.scrollViewport({ target: { selector: '#right' }, top: 120 }).y,
    120,
    'explicit selector takes precedence'
  );

  reset(
    '<main id="outer" style="width:100%;height:100vh;overflow:auto"><div id="inner" style="width:100%;height:95vh;overflow:auto"><div style="height:2400px"></div></div><div style="height:1000px"></div></main>'
  );
  equal(
    input.getScrollContainerDetection().ambiguous,
    true,
    'similarly sized nested panels are ambiguous'
  );
  let nestedCode: unknown;
  try {
    input.scrollViewport({ top: 200 });
  } catch (caught) {
    nestedCode = (caught as { code: string }).code;
  }
  equal(nestedCode, 'ELEMENT_AMBIGUOUS', 'nested ambiguity requires explicit target');
  equal(get('outer').scrollTop, 0, 'outer unchanged after rejection');
  equal(get('inner').scrollTop, 0, 'inner unchanged after rejection');

  reset(
    panel('primary', '100%', 'main') +
      '<aside id="overlay" style="position:fixed;left:0;top:0;width:60vw;height:100vh;overflow:auto;background:white"><div style="height:2400px"></div></aside>'
  );
  equal(
    input.getScrollContainerDetection().ambiguous,
    true,
    'partially covered background is not ranked by its full area'
  );
  equal(
    input.scrollViewport({ target: { selector: '#overlay' }, top: 140 }).y,
    140,
    'overlay can be targeted explicitly'
  );
  equal(get('primary').scrollTop, 0, 'background stays unchanged');

  reset(
    panel('primary', '100%', 'main') +
      '<div style="display:none;height:100vh;overflow:auto"><div style="height:9000px"></div></div>' +
      '<div style="position:fixed;left:200vw;width:100vw;height:100vh;overflow:auto"><div style="height:9000px"></div></div>'
  );
  equal(
    input.getScrollContainerDetection().ambiguous,
    undefined,
    'hidden and offscreen panels ignored'
  );
  input.scrollViewport({ top: 180 });
  equal(get('primary').scrollTop, 180, 'visible panel selected');

  reset(
    '<div style="height:100vh;width:100%;overflow:visible"><div style="height:2400px"></div></div>'
  );
  equal(
    input.getScrollContainerDetection().container,
    undefined,
    'overflow-visible is not scrollable'
  );

  reset(
    '<main id="primary" style="width:100%;height:100vh;overflow:auto"><div style="width:3000px;height:100%"></div></main>'
  );
  input.scrollViewport({ left: 200 });
  equal(get('primary').scrollLeft, 200, 'horizontal nested scrolling');
  equal((await state()).scroll.container?.x, 200, 'page state reports horizontal container');

  reset(panel('primary', '100%', 'main'));
  document.documentElement.style.cssText = 'overflow:auto';
  document.body.style.cssText = 'margin:0;height:3000px';
  window.scrollTo(0, 0);
  equal(input.scrollViewport({ top: 200 }).target, 'window', 'ordinary document scrolling wins');
  equal(window.scrollY, 200, 'ordinary document scroll position');
  equal(get('primary').scrollTop, 0, 'nested panel unchanged when document scrolls');
  document.body.style.overflow = 'hidden';
  equal(
    input.scrollViewport({ top: 250 }).target,
    'window',
    'body overflow does not override explicit root scrolling'
  );
  equal(window.scrollY, 250, 'root remains scrollable with hidden body overflow');
}

test(
  'nested scrolling handles primary, ambiguous, hidden, horizontal, and document layouts in Chrome',
  {
    skip: !process.env.BBX_TEST_CHROME && 'Set BBX_TEST_CHROME to a Chrome/Chromium executable',
    timeout: 45_000,
  },
  async (t) => {
    const executable = process.env.BBX_TEST_CHROME;
    assert.ok(executable);
    const profile = await mkdtemp(join(tmpdir(), 'bbx-scroll-test-'));
    t.after(() => rm(profile, { recursive: true, force: true }));
    const scripts = await Promise.all(
      [
        'content-script-helpers.js',
        'content-dom-baseline.js',
        'content-element-registry.js',
        'content-dom-query.js',
        'content-input.js',
        'content-patch.js',
        'content-script.js',
      ].map((name) => readFile(extensionFile(`src/${name}`), 'utf8'))
    );
    // tsx preserves nested function names with this helper when serializing tests.
    const html = `<!doctype html><html><body><script>function __name(fn){return fn} globalThis.chrome={runtime:{onMessage:{addListener(fn){globalThis.__bbxListener=fn}}}};</script><script>${scripts.join('\n')}</script><script>
    (${checkBrowserScrolling.toString()})().then(() => { document.body.dataset.result='passed'; }).catch(error => { document.body.dataset.result='failed'; document.body.textContent=error.stack || String(error); });
  </script></body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        })
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const { stdout } = await promisify(execFile)(
      executable,
      [
        '--headless',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--password-store=basic',
        '--use-mock-keychain',
        `--user-data-dir=${profile}`,
        '--virtual-time-budget=3000',
        '--dump-dom',
        `http://127.0.0.1:${address.port}/`,
      ],
      { timeout: 30_000, maxBuffer: 2_000_000 }
    );
    assert.match(stdout, /data-result="passed"/, stdout);
  }
);
