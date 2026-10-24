import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionFile } from '../../../tests/_helpers/extensionBuild.ts';

import { withDocument } from '../../../tests/_helpers/dom.ts';

type Locator = {
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  selector?: string;
  exact?: boolean;
  includeHidden?: boolean;
};
type LocateResult = { matches: Element[]; hiddenMatches: number; scanned: number };
type DomQueryApi = {
  locateElements: (locator: Locator, options?: { maxResults?: number }) => LocateResult;
  getAccessibilityOutline: (params: Record<string, unknown>) => { outline: string; count: number };
};
type HelpersApi = {
  getAccessibleName: (element: Element) => string;
  getElementRoles: (element: Element) => string[];
  walkElementsDeep: (root?: ParentNode, limit?: number) => Generator<Element>;
  querySelectorDeep: (selector: string, root?: ParentNode) => Element | null;
};

const GLOBAL_KEYS = [
  '__BBX_CONTENT_HELPERS__',
  '__BBX_CONTENT_REGISTRY__',
  '__BBX_CONTENT_DOM_QUERY__',
];

async function importFresh(relativePath: string): Promise<void> {
  await import(
    `${extensionFile(relativePath.replace('../', '')).href}?case=${Date.now()}-${Math.random()}`
  );
}

async function loadModules(): Promise<{ query: DomQueryApi; helpers: HelpersApi }> {
  for (const key of GLOBAL_KEYS) Reflect.deleteProperty(globalThis, key);
  await importFresh('../src/content-script-helpers.js');
  await importFresh('../src/content-element-registry.js');
  await importFresh('../src/content-dom-query.js');
  return {
    query: Reflect.get(globalThis, '__BBX_CONTENT_DOM_QUERY__') as DomQueryApi,
    helpers: Reflect.get(globalThis, '__BBX_CONTENT_HELPERS__') as HelpersApi,
  };
}

const FIXTURE = `<!doctype html><html><head><title>Fixture</title></head><body>
<main>
  <form>
    <label for="email">Email address</label><input id="email" type="email">
    <label>Full name <input id="fullname"></label>
    <input id="search" placeholder="Search products">
    <input id="qty" type="number" aria-label="Quantity">
    <select id="country"><option>US</option></select>
    <button type="submit" data-testid="place-order"><b>Place</b> order</button>
  </form>
  <nav style="display:none"><a id="hidden-link" href="#x">Place order</a></nav>
  <p id="para">Hello <em>world</em></p>
</main>
<script>window.label = 'Place order Shadow save';</script>
</body></html>`;

test('accessible names cover label[for], wrapping labels, aria-label, and content', async () => {
  await withDocument(FIXTURE, async ({ document }) => {
    const { helpers } = await loadModules();
    const byId = (id: string) => document.getElementById(id) as Element;
    assert.equal(helpers.getAccessibleName(byId('email')), 'Email address');
    assert.equal(helpers.getAccessibleName(byId('fullname')), 'Full name');
    assert.equal(helpers.getAccessibleName(byId('search')), 'Search products');
    assert.equal(helpers.getAccessibleName(byId('qty')), 'Quantity');
    assert.equal(
      helpers.getAccessibleName(document.querySelector('[data-testid=place-order]') as Element),
      'Place order'
    );
    assert.deepEqual(helpers.getElementRoles(byId('qty')), ['spinbutton', 'textbox']);
    assert.deepEqual(helpers.getElementRoles(byId('country')), ['combobox', 'listbox']);
  });
});

test('locators find labelled textboxes by role and name', async () => {
  await withDocument(FIXTURE, async () => {
    const { query } = await loadModules();
    const email = query.locateElements({ role: 'textbox', name: 'email address' });
    assert.deepEqual(
      email.matches.map((element) => element.id),
      ['email']
    );
    const label = query.locateElements({ label: 'Full name' });
    assert.deepEqual(
      label.matches.map((element) => element.id),
      ['fullname']
    );
    const placeholder = query.locateElements({ placeholder: 'search' });
    assert.deepEqual(
      placeholder.matches.map((element) => element.id),
      ['search']
    );
    const testId = query.locateElements({ testId: 'place-order' });
    assert.equal(testId.matches[0]?.tagName, 'BUTTON');
  });
});

test('text locators ignore script source and prefer the innermost element', async () => {
  await withDocument(FIXTURE, async () => {
    const { query } = await loadModules();
    const placeOrder = query.locateElements({ text: 'Place order', includeHidden: true });
    assert.deepEqual(
      placeOrder.matches.map((element) => element.tagName),
      ['BUTTON', 'A']
    );
    const shadowText = query.locateElements({ text: 'Shadow save', includeHidden: true });
    assert.equal(shadowText.matches.length, 0);
    const split = query.locateElements({ text: 'Hello world' });
    assert.deepEqual(
      split.matches.map((element) => element.id),
      ['para']
    );
    const inner = query.locateElements({ text: 'world' });
    assert.deepEqual(
      inner.matches.map((element) => element.tagName),
      ['EM']
    );
  });
});

test('hidden matches are excluded by default and counted', async (t) => {
  await withDocument(FIXTURE, async ({ document }) => {
    const { query } = await loadModules();
    const hiddenLink = document.getElementById('hidden-link') as Element & {
      checkVisibility?: () => boolean;
    };
    // linkedom has no layout; emulate Chrome's checkVisibility for the hidden nav.
    for (const element of document.querySelectorAll('*')) {
      Reflect.set(element, 'checkVisibility', () => !element.closest('nav'));
    }
    t.diagnostic(`hidden link visible: ${String(hiddenLink.checkVisibility?.())}`);
    const result = query.locateElements({ text: 'Place order' });
    assert.deepEqual(
      result.matches.map((element) => element.tagName),
      ['BUTTON']
    );
    assert.equal(result.hiddenMatches, 1);
  });
});

test('scoped deep walks include the root host shadow tree before its light children', async () => {
  await withDocument(
    '<html><body><div id="host"><b id="light"></b></div></body></html>',
    async ({ document }) => {
      const { helpers, query } = await loadModules();
      const host = document.getElementById('host') as HTMLElement;
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML =
        '<div id="nested"><i id="nested-light"></i></div><button id="save">Save</button>';
      (shadow.querySelector('#nested') as HTMLElement).attachShadow({ mode: 'open' }).innerHTML =
        '<input id="nested-input">';
      assert.deepEqual(
        [...helpers.walkElementsDeep(host)].map((element) => element.id),
        ['nested', 'nested-input', 'nested-light', 'save', 'light']
      );
      assert.deepEqual(
        [...helpers.walkElementsDeep(host, 2)].map((element) => element.id),
        ['nested', 'nested-input']
      );
      assert.equal(helpers.querySelectorDeep('#save', host), shadow.querySelector('#save'));
      const outline = query.getAccessibilityOutline({ selector: '#host', interactiveOnly: true });
      assert.equal(outline.count, 2);
      assert.match(outline.outline, /button "Save"/);
      assert.match(outline.outline, /textbox/);
    }
  );
});

test('scoped deep walks and queries include closed roots available through chrome.dom', async () => {
  await withDocument('<html><body><div id="host"></div></body></html>', async ({ document }) => {
    const { helpers } = await loadModules();
    const host = document.getElementById('host') as HTMLElement;
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<button id="save">Save</button>';
    const savedChrome = globalThis.chrome;
    Reflect.set(globalThis, 'chrome', {
      dom: { openOrClosedShadowRoot: (element: Element) => (element === host ? shadow : null) },
    });
    try {
      assert.equal(host.shadowRoot, null);
      assert.deepEqual(
        [...helpers.walkElementsDeep(host)].map((element) => element.id),
        ['save']
      );
      assert.equal(helpers.querySelectorDeep('#save', host), shadow.querySelector('#save'));
    } finally {
      if (savedChrome === undefined) Reflect.deleteProperty(globalThis, 'chrome');
      else Reflect.set(globalThis, 'chrome', savedChrome);
    }
  });
});
