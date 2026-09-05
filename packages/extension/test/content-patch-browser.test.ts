import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

// This function runs in Chrome, not LinkeDOM. Keep it self-contained.
function checkBrowserPatches(): void {
  const patches = Reflect.get(globalThis, '__BBX_CONTENT_PATCH__') as {
    applyStylePatch: (params: {
      patchId: string;
      target: { selector: string };
      declarations: Record<string, string>;
      important?: boolean;
    }) => void;
    rollbackPatch: (id: string) => { rolledBack: boolean };
  };
  const helpers = Reflect.get(globalThis, '__BBX_CONTENT_HELPERS__') as {
    escapeTailwindSelector: (selector: string) => string;
  };
  const registry = Reflect.get(globalThis, '__BBX_CONTENT_REGISTRY__') as {
    rememberElement: (element: Element) => string;
  };
  const { equal } = {
    equal(actual: unknown, expected: unknown, message: string): void {
      if (actual !== expected) throw new Error(`${message}: ${actual} !== ${expected}`);
    },
  };
  const element = document.createElement('div');
  element.id = 'target';
  document.body.appendChild(element);
  const cases: Array<{
    before: string;
    declarations: Record<string, string>;
    important?: boolean;
  }> = [
    { before: 'margin-left: 12px !important', declarations: { margin: '0px' } },
    { before: 'margin: 1px 2px 3px 4px !important', declarations: { 'margin-left': '8px' } },
    {
      before: 'margin-left: 12px; margin-top: 9px !important',
      declarations: { margin: '0px', 'margin-left': '4px' },
    },
    { before: 'margin: 5px', declarations: { margin: '' } },
    {
      before: '--spacing: 12px; margin: var(--spacing) !important',
      declarations: { margin: '0px' },
    },
    {
      before: '--spacing: 12px; margin: var(--spacing) !important',
      declarations: { 'margin-left': '8px' },
    },
    { before: '--spacing: 12px; margin: var(--spacing) !important', declarations: { margin: '' } },
    {
      before:
        'border-left: 3px dashed red !important; border-image-source: linear-gradient(red, blue)',
      declarations: { border: '1px solid black' },
    },
    {
      before: 'background-color: red !important; background-size: 12px 14px',
      declarations: { background: 'blue' },
      important: true,
    },
    {
      before: '--theme: red !important; padding-top: 7px',
      declarations: { '--theme': 'blue', padding: '0px' },
    },
  ];
  for (const [index, entry] of cases.entries()) {
    element.style.cssText = entry.before;
    const originalMargin = element.style.margin;
    const originalComputedMargin = getComputedStyle(element).margin;
    const before = new Map<string, { value: string; priority: string }>();
    for (let index = 0; index < element.style.length; index++) {
      const name = element.style[index];
      before.set(name, {
        value: element.style.getPropertyValue(name),
        priority: element.style.getPropertyPriority(name),
      });
    }
    const patchId = `style-${index}`;
    patches.applyStylePatch({ patchId, target: { selector: '#target' }, ...entry });
    element.style.setProperty('color', 'green', 'important');
    equal(patches.rollbackPatch(patchId).rolledBack, true, patchId);
    equal(element.style.getPropertyValue('color'), 'green', 'unrelated later value');
    equal(element.style.getPropertyPriority('color'), 'important', 'unrelated later priority');
    element.style.removeProperty('color');
    equal(element.style.length, before.size, `${patchId} restored declaration count`);
    for (const [name, value] of before) {
      equal(element.style.getPropertyValue(name), value.value, `${patchId} ${name}`);
      equal(element.style.getPropertyPriority(name), value.priority, `${patchId} ${name} priority`);
    }
    equal(element.style.margin, originalMargin, `${patchId} original shorthand`);
    equal(getComputedStyle(element).margin, originalComputedMargin, `${patchId} computed margin`);
  }

  element.style.cssText = '--spacing: 12px; margin: var(--spacing) !important';
  patches.applyStylePatch({
    patchId: 'variable-sibling',
    target: { selector: '#target' },
    declarations: { 'margin-left': '8px' },
  });
  element.style.setProperty('margin-right', '27px', 'important');
  element.style.setProperty('--spacing', '16px');
  element.style.setProperty('color', 'green', 'important');
  equal(patches.rollbackPatch('variable-sibling').rolledBack, true, 'variable sibling rollback');
  equal(getComputedStyle(element).marginLeft, '16px', 'restored variable remains live');
  equal(element.style.marginRight, '27px', 'unaffected sibling value');
  equal(
    element.style.getPropertyPriority('margin-right'),
    'important',
    'unaffected sibling priority'
  );
  equal(element.style.color, 'green', 'unrelated declaration survives variable rollback');

  element.style.cssText = '--spacing: 12px; margin: var(--spacing) !important';
  patches.applyStylePatch({
    patchId: 'variable-removed-sibling',
    target: { selector: '#target' },
    declarations: { 'margin-left': '8px' },
  });
  element.style.removeProperty('margin-right');
  equal(
    patches.rollbackPatch('variable-removed-sibling').rolledBack,
    true,
    'removed sibling rollback'
  );
  equal(getComputedStyle(element).marginLeft, '12px', 'restored variable after sibling removal');
  equal(
    Array.from(element.style).includes('margin-right'),
    false,
    'unrelated sibling removal survives'
  );

  // Chrome cannot serialize the source of an already-partially-overridden var()
  // shorthand. Reject before mutation rather than inventing an empty baseline.
  element.style.cssText = '--spacing: 12px; margin: var(--spacing) !important';
  element.style.setProperty('margin-left', '3px', 'important');
  const incompleteBaseline = element.style.cssText;
  let rejected = false;
  try {
    patches.applyStylePatch({
      patchId: 'unrepresentable',
      target: { selector: '#target' },
      declarations: { margin: '0px' },
    });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes('pending-substitution');
  }
  equal(rejected, true, 'unrepresentable baseline rejection');
  equal(element.style.cssText, incompleteBaseline, 'rejection precedes mutation');
  equal(
    patches.rollbackPatch('unrepresentable').rolledBack,
    false,
    'rejected patch has no history'
  );

  element.style.cssText = 'margin-left: 13px !important';
  patches.applyStylePatch({
    patchId: 'overflow',
    target: { selector: '#target' },
    declarations: { margin: '0' },
  });
  for (let index = 0; index < 5000; index++) {
    const child = document.createElement('i');
    document.body.appendChild(child);
    registry.rememberElement(child);
  }
  equal(patches.rollbackPatch('overflow').rolledBack, true, 'style rollback after eviction');
  equal(element.style.marginLeft, '13px', 'evicted target original longhand');
  equal(element.style.getPropertyPriority('margin-left'), 'important', 'evicted target priority');

  element.className = 'btn top-[30px] bg-[#f00]';
  element.setAttribute('data-state', 'ready');
  for (const selector of [
    '.btn[data-state="ready"]',
    '.top-[30px]',
    '.bg-[#f00]',
    '.btn[data-state="ready"].top-[30px]',
  ]) {
    equal(document.querySelector(helpers.escapeTailwindSelector(selector)), element, selector);
  }
  for (const selector of [
    '.btn[disabled]',
    '.utility-[auto]',
    '[data-label=".top-[30px]"]',
    '.top-\\[30px\\]',
    ':is(.top-[30px], .btn[disabled])',
  ]) {
    equal(helpers.escapeTailwindSelector(selector), selector, 'valid selector preservation');
  }
}

test(
  'content patches and selectors round-trip in real Chrome CSSOM',
  {
    skip: !process.env.BBX_TEST_CHROME && 'Set BBX_TEST_CHROME to a Chrome/Chromium executable',
    timeout: 45_000,
  },
  async (t) => {
    const executable = process.env.BBX_TEST_CHROME;
    assert.ok(executable);
    const profile = await mkdtemp(join(tmpdir(), 'bbx-content-test-'));
    t.after(() => rm(profile, { recursive: true, force: true }));
    const scripts = await Promise.all(
      ['content-script-helpers.js', 'content-element-registry.js', 'content-patch.js'].map((name) =>
        readFile(new URL(`../src/${name}`, import.meta.url), 'utf8')
      )
    );
    const html = `<html><body><script>${scripts.join('\n')}</script><script>
    try {
      (${checkBrowserPatches.toString()})();
      document.body.textContent = 'passed';
      document.body.dataset.result = 'passed';
    } catch (error) {
      document.body.textContent = error.stack || String(error);
      document.body.dataset.result = 'failed';
    }
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
        '--dump-dom',
        `http://127.0.0.1:${address.port}/`,
      ],
      { timeout: 30_000, maxBuffer: 2_000_000 }
    );
    assert.match(stdout, /data-result="passed"/, stdout);
  }
);
