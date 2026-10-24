import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { withDocument, type DocumentContext } from '../../../tests/_helpers/dom.ts';
import { extensionFile } from '../../../tests/_helpers/extensionBuild.ts';

type OutlineNode = { ref: string; role: string; name: string; depth: number; states: string[] };
type FindResult = {
  nodes: Array<{ elementRef: string; name: string; visible?: boolean }>;
  found: boolean;
  count: number;
  scanned: number;
  truncated: boolean;
  truncationReason: string | null;
  hiddenMatches?: number;
};
type QueryApi = {
  getAccessibilityOutline: (params: Record<string, unknown>) => {
    source: string;
    format: string;
    nodes?: OutlineNode[];
    outline?: string;
    count: number;
    scanned: number;
    truncated: boolean;
  };
  domQuery: (params: Record<string, unknown>) => {
    nodes: Array<{ tag: string }>;
    matchCount?: number;
    truncated: boolean;
  };
  findByRole: (params: Record<string, unknown>) => FindResult;
  findByText: (params: Record<string, unknown>) => FindResult;
  probeTarget: (params: Record<string, unknown>) => { found: boolean };
  waitForDom: (params: Record<string, unknown>) => Promise<{
    found: boolean;
    elementRef: string | null;
    duration: number;
  }>;
};
type RegistryApi = { getRequiredElement: (ref: string) => Element };
type HelpersApi = {
  querySelectorAllDeep: (selector: string, root?: ParentNode) => Element[];
  querySelectorMatchesDeep: (selector: string, root?: ParentNode) => Generator<Element>;
  getAccessibleName: (element: Element) => string;
  getElementRoles: (element: Element) => string[];
  getElementTextContent: (element: Element, budget?: number) => string;
};

test('deep DOM scans fail explicitly at their work limit instead of claiming unique matches', async () => {
  await withQuery('<section>' + '<span>item</span>'.repeat(20010) + '</section>', ({ helpers }) => {
    assert.throws(() => helpers.querySelectorAllDeep('span'), { code: 'RESULT_TRUNCATED' });
  });
});

test('lazy deep selectors preserve scoped matching and validate empty trees', async () => {
  await withQuery(
    '<section><button>Child</button><div><button>Nested</button></div></section>',
    ({ document, helpers }) => {
      const root = document.querySelector('section')!;
      assert.deepEqual(
        [...helpers.querySelectorMatchesDeep(':scope > button', root)].map(
          (element) => element.textContent
        ),
        ['Child']
      );
      assert.deepEqual(
        [...helpers.querySelectorMatchesDeep('button', root)],
        helpers.querySelectorAllDeep('button', root)
      );
      assert.throws(() => [
        ...helpers.querySelectorMatchesDeep('[', document.createDocumentFragment()),
      ]);
    }
  );
});

test('bounded text extraction stops before reading later text nodes', async () => {
  await withQuery(
    '<p id="text">' + 'x'.repeat(2000) + '<span>must not read</span></p>',
    ({ document, helpers }) => {
      const element = document.getElementById('text')!;
      const span = element.querySelector('span')!;
      Object.defineProperty(span.firstChild!, 'textContent', {
        get() {
          throw new Error('unbounded read');
        },
      });
      assert.equal(helpers.getElementTextContent(element, 20), 'x'.repeat(20));
    }
  );
});

test('scoped semantic searches stop after the truncation lookahead instead of scanning the page', async () => {
  await withQuery(
    '<button>First</button><button>Second</button><section>' +
      '<span>unrelated</span>'.repeat(20010) +
      '</section>',
    ({ document, query }) => {
      const sentinel = document.querySelector('span')!;
      Object.defineProperty(sentinel, 'matches', {
        value() {
          throw new Error('bounded search visited an unrelated subtree');
        },
      });
      const result = query.findByRole({ role: 'button', selector: 'button', maxResults: 1 });
      assert.equal(result.found, true);
      assert.equal(result.count, 1);
      assert.equal(result.scanned, 2);
      assert.equal(result.nodes[0].name, 'First');
      assert.equal(result.truncated, true);
      assert.equal(result.truncationReason, 'maxResults');
    }
  );
});

test('target existence probes stop at the first semantic match without a uniqueness scan', async () => {
  await withQuery(
    '<button>Save</button><section>' + '<span>unrelated</span>'.repeat(20010) + '</section>',
    ({ document, query }) => {
      Object.defineProperty(document.querySelector('span')!, 'matches', {
        value() {
          throw new Error('existence probe visited an unrelated subtree');
        },
      });
      for (const target of [
        { role: 'button', name: 'Save', selector: 'button' },
        { text: 'Save', selector: 'button' },
      ]) {
        assert.equal(query.probeTarget({ target }).found, true);
      }
    }
  );
});

test('attached and visible waits stop at the first match on large pages', async () => {
  await withQuery(
    '<button>Save</button><section>' + '<span>unrelated</span>'.repeat(20010) + '</section>',
    async ({ document, query, registry }) => {
      const first = document.querySelector('button')!;
      Object.defineProperty(document.querySelector('span')!, 'matches', {
        value() {
          throw new Error('wait visited an unrelated subtree');
        },
      });
      for (const state of ['attached', 'visible']) {
        for (const text of [undefined, 'Save']) {
          const result = await query.waitForDom({ selector: 'button', text, state });
          assert.equal(result.found, true);
          assert.equal(registry.getRequiredElement(result.elementRef!), first);
        }
      }
    }
  );
});

test('hidden waits stop at the first visible match but inspect all hidden matches', async () => {
  await withQuery('<button>Save</button><button>Save</button>', async ({ document, query }) => {
    const buttons = [...document.querySelectorAll('button')];
    let laterChecks = 0;
    Reflect.set(buttons[1], 'getBoundingClientRect', () => {
      laterChecks += 1;
      return { x: 0, y: 0, width: 0, height: 0 };
    });
    const visible = await query.waitForDom({ selector: 'button', state: 'hidden', timeoutMs: 100 });
    assert.equal(visible.found, false);
    assert.equal(laterChecks, 0);
    Reflect.set(buttons[0], 'getBoundingClientRect', () => ({ width: 0, height: 0 }));
    const hidden = await query.waitForDom({ selector: 'button', state: 'hidden' });
    assert.equal(hidden.found, true);
    assert.equal(laterChecks, 1);
    assert.equal((await query.waitForDom({ selector: '.missing', state: 'hidden' })).found, true);
  });
});

test('semantic result summaries reuse visibility checks and retain hidden and zero-size handling', async () => {
  await withQuery('<button id="target">Save</button>', ({ document, query }) => {
    const target = document.getElementById('target')!;
    let checks = 0;
    let rectangles = 0;
    let visible = true;
    let width = 100;
    Reflect.set(target, 'checkVisibility', () => {
      checks += 1;
      return visible;
    });
    Reflect.set(target, 'getBoundingClientRect', () => {
      rectangles += 1;
      return { x: 0, y: 0, width, height: width ? 20 : 0 };
    });
    const found = query.findByRole({ role: 'button', name: 'Save' });
    assert.equal(found.count, 1);
    assert.equal(found.nodes[0].visible, undefined);
    assert.equal(checks, 1);
    assert.equal(rectangles, 2);

    for (const state of ['hidden', 'zero-size']) {
      visible = state !== 'hidden';
      width = state === 'zero-size' ? 0 : 100;
      checks = 0;
      const skipped = query.findByRole({ role: 'button', name: 'Save' });
      assert.equal(skipped.count, 0);
      assert.equal(skipped.hiddenMatches, 1);
      assert.equal(checks, 1);
      const included = query.findByRole({ role: 'button', name: 'Save', includeHidden: true });
      assert.equal(included.count, 1);
      assert.equal(included.nodes[0].visible, false);
      assert.equal(checks, 2);
    }
  });
});

test('DOM queries ending exactly at maxNodes report complete subtrees', async () => {
  await withQuery('<a id="logo"><img alt="Logo"></a>', ({ query }) => {
    for (const maxNodes of [2, 3]) {
      const result = query.domQuery({ selector: '#logo', maxNodes });
      assert.deepEqual(
        result.nodes.map((node) => node.tag),
        ['a', 'img']
      );
      assert.equal(result.truncated, false);
    }
    const leaf = query.domQuery({ selector: '#logo img', maxNodes: 1 });
    assert.equal(leaf.nodes.length, 1);
    assert.equal(leaf.truncated, false);
  });
});

test('DOM queries still report omitted siblings, descendants, and depth-limited nodes', async () => {
  await withQuery('<main><div><span></span></div><aside></aside></main>', ({ query }) => {
    for (const maxNodes of [1, 2, 3]) {
      const result = query.domQuery({ selector: 'main', maxNodes });
      assert.equal(result.nodes.length, maxNodes);
      assert.equal(result.truncated, true);
    }
    assert.equal(query.domQuery({ selector: 'main', maxNodes: 4 }).truncated, false);
    const shallow = query.domQuery({ selector: 'main', maxNodes: 10, maxDepth: 1 });
    assert.deepEqual(
      shallow.nodes.map((node) => node.tag),
      ['main', 'div', 'aside']
    );
    assert.equal(shallow.truncated, true);
  });
});

async function withQuery(
  body: string,
  run: (
    context: DocumentContext & { query: QueryApi; registry: RegistryApi; helpers: HelpersApi }
  ) => Promise<void> | void
): Promise<void> {
  await withDocument(`<!doctype html><html><body>${body}</body></html>`, async (context) => {
    const keys = [
      '__BBX_CONTENT_HELPERS__',
      '__BBX_CONTENT_REGISTRY__',
      '__BBX_CONTENT_DOM_QUERY__',
    ];
    const saved = keys.map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    );
    try {
      for (const key of keys) Reflect.deleteProperty(globalThis, key);
      // Linkedom has no layout engine. Supply geometry and computed visibility at the browser boundary.
      Reflect.set(globalThis, 'getComputedStyle', (element: HTMLElement) => ({
        display: element.style.display || 'block',
        visibility: element.style.visibility || 'visible',
      }));
      for (const element of context.document.querySelectorAll('*')) {
        Reflect.set(element, 'getBoundingClientRect', () => ({
          x: 0,
          y: 0,
          width: 100,
          height: 20,
        }));
      }
      for (const name of [
        'content-script-helpers',
        'content-element-registry',
        'content-dom-query',
      ]) {
        await import(`${extensionFile(`src/${name}.js`).href}?case=${crypto.randomUUID()}`);
      }
      await run({
        ...context,
        query: Reflect.get(globalThis, keys[2]) as QueryApi,
        registry: Reflect.get(globalThis, keys[1]) as RegistryApi,
        helpers: Reflect.get(globalThis, keys[0]) as HelpersApi,
      });
    } finally {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}

test('accessibility outline exposes control states and resolvable references without password values', async () => {
  await withQuery(
    `
    <main id="main" aria-label="Checkout">
      <h2>Delivery</h2><div role="heading" aria-level="4">Instructions</div>
      <form aria-label="Address">
        <input id="email" aria-label="Email" value="buyer@example.test" aria-required="true">
        <input id="password" type="password" aria-label="Password" value="never-show-this">
        <input id="remember" type="checkbox" aria-label="Remember">
        <div role="checkbox" aria-checked="mixed" aria-label="All options"></div>
        <div role="switch" aria-checked="true" aria-label="Notifications"></div>
        <button id="more" aria-expanded="false" aria-pressed="true" disabled>More</button>
        <button aria-expanded="true" aria-selected="true" aria-disabled="true">Selected</button>
        <div tabindex="0" aria-label="Keyboard target"></div>
        <div id="editor" contenteditable="true">Editable note</div>
        <div role="slider" aria-label="Volume"></div>
      </form>
      <section>Unnamed region</section>
      <button style="display:none">Hidden action</button>
      <script>Invisible source</script>
    </main>
  `,
    ({ document, query, registry }) => {
      const remember = document.getElementById('remember');
      const email = document.getElementById('email');
      const editor = document.getElementById('editor');
      assert(remember && email && editor);
      Reflect.set(remember, 'checked', true);
      Reflect.set(email, 'required', true);
      Reflect.set(editor, 'isContentEditable', true);
      Object.defineProperty(document, 'activeElement', { configurable: true, value: email });
      const result = query.getAccessibilityOutline({ selector: '#main', format: 'tree' });
      assert.equal(result.source, 'dom');
      assert.equal(result.format, 'tree');
      assert.equal(result.truncated, false);
      const nodes = result.nodes;
      assert(nodes);
      const named = (name: string): OutlineNode => {
        const node = nodes.find((entry) => entry.name === name);
        assert(node, `Outline contains ${name}`);
        return node;
      };
      assert.equal(nodes[0].name, 'Checkout');
      assert.equal(nodes[0].depth, 0);
      assert.equal(named('Address').depth, 1);
      assert.equal(named('Email').depth, 2);
      assert.deepEqual(named('Delivery').states, ['level=2']);
      assert.deepEqual(named('Instructions').states, ['level=4']);
      assert.deepEqual(named('Email').states, [
        'required',
        'value="buyer@example.test"',
        'focused',
      ]);
      assert.deepEqual(named('Password').states, []);
      assert.deepEqual(named('Remember').states, ['checked']);
      assert.deepEqual(named('All options').states, ['mixed']);
      assert.deepEqual(named('Notifications').states, ['checked']);
      assert.deepEqual(named('More').states, ['disabled', 'collapsed', 'pressed']);
      assert.deepEqual(named('Selected').states, ['disabled', 'expanded', 'selected']);
      assert.equal(named('Keyboard target').role, 'generic');
      assert(nodes.some((node) => node.states.includes('value="Editable note"')));
      assert(!nodes.some((node) => node.name === 'Hidden action' || node.role === 'region'));
      assert.equal(registry.getRequiredElement(named('Email').ref), email);
      assert.equal(new Set(nodes.map((node) => node.ref)).size, nodes.length);
      const outline = query.getAccessibilityOutline({ selector: '#main' });
      assert.equal(outline.format, 'outline');
      assert.match(outline.outline ?? '', /^- main "Checkout" \[/);
      assert.match(
        outline.outline ?? '',
        /\n    - textbox "Email" \[.*\] required value="buyer@example.test" focused/
      );
      assert.doesNotMatch(
        JSON.stringify(outline),
        /never-show-this|Invisible source|Hidden action/
      );
    }
  );
});

test('outline traverses shadow roots with tree-scoped names and usable target references', async () => {
  await withQuery(
    '<main aria-label="Shop"><span id="label">Wrong document label</span><div id="host" role="region" aria-label="Payment"></div></main>',
    ({ document, query, registry, helpers }) => {
      const host = document.getElementById('host');
      assert(host);
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML =
        '<span id="label">Pay securely</span><button id="pay" aria-labelledby="label missing">Ignored fallback</button><div id="nested"></div><script>doNotRead()</script>';
      const pay = shadow.querySelector('#pay');
      const nested = shadow.querySelector('#nested');
      assert(pay && nested);
      nested.attachShadow({ mode: 'open' }).innerHTML = '<button data-qa="cancel">Cancel</button>';
      assert.equal(helpers.getAccessibleName(pay), 'Pay securely');
      assert.doesNotMatch(helpers.getElementTextContent(host), /doNotRead/);
      assert.equal(helpers.getElementTextContent(host, 3), 'Pay');
      const outline = query.getAccessibilityOutline({ format: 'tree' });
      const payNode = outline.nodes?.find((node) => node.name === 'Pay securely');
      const cancelNode = outline.nodes?.find((node) => node.name === 'Cancel');
      assert(payNode && cancelNode);
      assert.equal(payNode.depth, 2);
      assert.equal(cancelNode.depth, 2);
      const shallow = query.getAccessibilityOutline({ format: 'tree', maxDepth: 1 });
      assert.deepEqual(
        shallow.nodes?.map((node) => node.name),
        ['Shop', 'Payment']
      );
      assert.equal(shallow.truncated, true);
      assert.equal(query.getAccessibilityOutline({ maxDepth: 2 }).truncated, false);
      assert.equal(registry.getRequiredElement(payNode.ref), pay);
      assert.equal(query.probeTarget({ target: { selector: '#pay' } }).found, true);
      assert.equal(query.probeTarget({ target: { testId: 'cancel' } }).found, true);
      const roleResult = query.findByRole({ role: 'button', name: 'Pay securely', exact: true });
      assert.equal(roleResult.count, 1);
      assert.equal(roleResult.nodes[0].elementRef, payNode.ref);
    }
  );
});

test('outline maxDepth bounds semantic depth without dropping later siblings or scoped roots', async () => {
  await withQuery(
    '<main id="scope" aria-label="Root"><section aria-label="Section"><div><nav aria-label="Nested"><button>Deep</button></nav></div></section><h2>Sibling</h2></main>',
    ({ query }) => {
      for (const format of ['tree', 'outline']) {
        const shallow = query.getAccessibilityOutline({ selector: '#scope', format, maxDepth: 1 });
        assert.equal(shallow.count, 3);
        assert.equal(shallow.truncated, true);
        if (format === 'tree') {
          assert.deepEqual(
            shallow.nodes?.map((node) => [node.name, node.depth]),
            [
              ['Root', 0],
              ['Section', 1],
              ['Sibling', 1],
            ]
          );
        } else {
          assert.doesNotMatch(shallow.outline ?? '', /Nested|Deep/);
        }
        const complete = query.getAccessibilityOutline({ selector: '#scope', format, maxDepth: 3 });
        assert.equal(complete.count, 5);
        assert.equal(complete.truncated, false);
        const scoped = query.getAccessibilityOutline({ selector: 'nav', format, maxDepth: 1 });
        assert.equal(scoped.count, 2);
        assert.equal(scoped.truncated, false);
        const controls = query.getAccessibilityOutline({
          format,
          maxDepth: 1,
          interactiveOnly: true,
        });
        assert.equal(controls.count, 1);
        assert.equal(controls.truncated, false);
      }
    }
  );
});

test('outlines and semantic search report truncation while respecting scopes and hidden matches', async () => {
  await withQuery(
    `<main id="scope"><h1>Actions</h1>${Array.from({ length: 12 }, (_, index) => `<button>Action ${index}</button>`).join('')}<button style="visibility:hidden">Hidden</button></main><button>Outside</button>`,
    ({ query }) => {
      const result = query.getAccessibilityOutline({
        selector: '#scope',
        interactiveOnly: true,
        maxNodes: 10,
        format: 'tree',
      });
      assert.equal(result.count, 10);
      assert.equal(result.truncated, true);
      assert(result.nodes?.every((node) => node.role === 'button' && node.depth === 0));
      assert.throws(() => query.getAccessibilityOutline({ selector: '#missing' }), {
        code: 'ELEMENT_NOT_FOUND',
      });
      const bounded = query.findByText({
        selector: '#scope button',
        text: 'Action',
        maxResults: 2,
      });
      assert.equal(bounded.count, 2);
      assert.equal(bounded.truncationReason, 'maxResults');
      assert.equal(bounded.truncated, true);
      const scanned = query.findByRole({
        selector: '#scope button',
        role: 'button',
        name: 'Absent',
        scanLimit: 2,
      });
      assert.equal(scanned.found, false);
      assert.equal(scanned.scanned, 2);
      assert.equal(scanned.truncationReason, 'scanLimit');
      const hidden = query.findByText({ text: 'Hidden', exact: true });
      assert.equal(hidden.count, 0);
      assert.equal(hidden.hiddenMatches, 1);
      const included = query.findByText({ text: 'Hidden', exact: true, includeHidden: true });
      assert.equal(included.nodes[0].visible, false);
      assert.equal(query.probeTarget({ target: { text: 'Hidden' } }).found, true);
      for (const target of [null, {}, { selector: '[' }, { selector: '#missing' }]) {
        assert.equal(query.probeTarget({ target }).found, false);
      }
    }
  );
});

test('scoped outlines stop traversing after the first omitted eligible node', async () => {
  await withQuery(
    `<main id="scope">${'<button>Action</button>'.repeat(12)}<div id="later"></div></main>`,
    ({ document, query }) => {
      Object.defineProperty(document.getElementById('later')!, 'shadowRoot', {
        get() {
          throw new Error('outline traversed beyond its result budget');
        },
      });
      const result = query.getAccessibilityOutline({
        selector: '#scope',
        interactiveOnly: true,
        maxNodes: 10,
        format: 'tree',
      });
      assert.equal(result.count, 10);
      assert.equal(result.scanned, 12);
      assert.equal(result.truncated, true);
    }
  );
});

test('sparse outlines report scan-limit truncation for scoped and document reads', async () => {
  await withQuery(
    `<main id="scope">${'<div></div>'.repeat(20001)}<button>Beyond scan limit</button></main>`,
    ({ query }) => {
      for (const selector of [undefined, '#scope']) {
        const result = query.getAccessibilityOutline({ selector, interactiveOnly: true });
        assert.equal(result.count, 0);
        assert.equal(result.scanned, 20000);
        assert.equal(result.truncated, true);
      }
    }
  );
});

test('an outline ending exactly at the scan limit remains complete', async () => {
  await withQuery(`<main id="scope">${'<div></div>'.repeat(19999)}</main>`, ({ query }) => {
    const result = query.getAccessibilityOutline({ selector: '#scope', interactiveOnly: true });
    assert.equal(result.count, 0);
    assert.equal(result.scanned, 20000);
    assert.equal(result.truncated, false);
  });
});

test('accessible names honor native labels, input defaults, images, and fieldset legends', async () => {
  await withQuery(
    `
    <label id="native-label">Native label</label><input id="native">
    <input id="submit" type="submit"><input id="reset" type="reset"><input id="button" type="button" value="Run">
    <input id="image" type="image" alt="Send"><img id="photo" alt="Mountain"><img id="decorative" alt="">
    <fieldset id="group"><legend>Delivery address</legend><input></fieldset>
    <input id="suggest" list="suggestions"><select id="multi" multiple></select><summary id="summary">Details</summary>
    <button id="fallback" aria-labelledby="not-present" aria-label="Fallback name"></button>
  `,
    ({ document, helpers }) => {
      const get = (id: string): Element => {
        const element = document.getElementById(id);
        assert(element);
        return element;
      };
      Object.defineProperty(get('native'), 'labels', { value: [get('native-label')] });
      Reflect.set(get('multi'), 'multiple', true);
      const names: Record<string, string> = {
        native: 'Native label',
        submit: 'Submit',
        reset: 'Reset',
        button: 'Run',
        image: 'Send',
        photo: 'Mountain',
        group: 'Delivery address',
        fallback: 'Fallback name',
      };
      for (const [id, expected] of Object.entries(names))
        assert.equal(helpers.getAccessibleName(get(id)), expected);
      assert.deepEqual(helpers.getElementRoles(get('suggest')), ['combobox', 'textbox']);
      assert.deepEqual(helpers.getElementRoles(get('multi')), ['listbox']);
      assert.deepEqual(helpers.getElementRoles(get('summary')), ['button']);
      assert.deepEqual(helpers.getElementRoles(get('decorative')), ['presentation']);
    }
  );
});

test(
  'DOM waits observe insertions, text changes, disappearance, and all-hidden transitions',
  { timeout: 5000 },
  async (t) => {
    await withQuery(
      '<main><button id="first" class="status">Loading</button><button id="second" class="status">Ready</button></main>',
      async ({ document, query, registry }) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000 });
        const main = document.querySelector('main');
        const first = document.getElementById('first');
        const second = document.getElementById('second');
        assert(main && first && second);
        const attached = query.waitForDom({ selector: '#inserted', timeoutMs: 1000 });
        const inserted = document.createElement('button');
        inserted.id = 'inserted';
        inserted.textContent = 'Inserted';
        main.appendChild(inserted);
        await setImmediate();
        t.mock.timers.tick(50);
        const attachedResult = await attached;
        assert.equal(attachedResult.found, true);
        assert.equal(attachedResult.duration, 50);
        assert(attachedResult.elementRef);
        assert.equal(registry.getRequiredElement(attachedResult.elementRef), inserted);

        const changed = query.waitForDom({ selector: '#first', text: 'Complete', timeoutMs: 1000 });
        first.textContent = 'Complete';
        await setImmediate();
        t.mock.timers.tick(50);
        assert.equal((await changed).found, true);
        const detached = query.waitForDom({
          selector: '.status',
          text: 'Complete',
          state: 'detached',
          timeoutMs: 1000,
        });
        first.remove();
        await setImmediate();
        t.mock.timers.tick(50);
        assert.deepEqual(await detached, { found: true, elementRef: null, duration: 50 });

        main.appendChild(first);
        const hidden = query.waitForDom({ selector: '.status', state: 'hidden', timeoutMs: 1000 });
        let allHidden = false;
        void hidden.then(() => {
          allHidden = true;
        });
        second.style.visibility = 'hidden';
        await setImmediate();
        t.mock.timers.tick(50);
        await Promise.resolve();
        assert.equal(allHidden, false, 'one visible match keeps a hidden-state wait pending');
        first.style.visibility = 'hidden';
        await setImmediate();
        t.mock.timers.tick(250);
        const hiddenResult = await hidden;
        assert.equal(hiddenResult.found, true);
        assert(hiddenResult.elementRef);
        assert.equal(registry.getRequiredElement(hiddenResult.elementRef), second);
        assert.deepEqual(await query.waitForDom({ selector: '#never-existed', state: 'hidden' }), {
          found: true,
          elementRef: null,
          duration: 0,
        });
        const visible = query.waitForDom({
          selector: '.status',
          state: 'visible',
          timeoutMs: 1000,
        });
        second.style.visibility = 'visible';
        await setImmediate();
        t.mock.timers.tick(250);
        assert.equal((await visible).found, true);
      }
    );
  }
);

test(
  'DOM wait polling notices visibility changes without mutation events and times out missing text',
  { timeout: 5000 },
  async (t) => {
    await withQuery(
      '<button id="target" style="visibility:hidden">Waiting</button>',
      async ({ document, query }) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000 });
        const target = document.getElementById('target');
        assert(target);
        let visibility = 'hidden';
        Reflect.set(globalThis, 'getComputedStyle', () => ({ visibility }));
        const visible = query.waitForDom({
          selector: '#target',
          state: 'visible',
          timeoutMs: 1000,
        });
        visibility = 'visible';
        t.mock.timers.tick(250);
        assert.equal((await visible).duration, 250);
        const absentText = query.waitForDom({
          selector: '#target',
          text: 'Missing',
          timeoutMs: 100,
        });
        t.mock.timers.tick(100);
        assert.deepEqual(await absentText, { found: false, elementRef: null, duration: 100 });
        assert.deepEqual(
          await query.waitForDom({ selector: '#target', text: 'Missing', state: 'detached' }),
          { found: true, elementRef: null, duration: 0 }
        );
      }
    );
  }
);

test('dom.query reports when a selector matched more than the returned subtree', async () => {
  await withQuery(
    '<nav><a href="/one"><img alt=""></a><a href="/two">Two</a><a href="/three">Three</a></nav><p id="only">Only</p>',
    ({ query }) => {
      const links = query.domQuery({ selector: 'a', maxNodes: 10 });
      assert.deepEqual(
        links.nodes.map((node) => node.tag),
        ['a', 'img']
      );
      assert.equal(links.matchCount, 3);
      assert.equal('matchCount' in query.domQuery({ selector: '#only' }), false);
    }
  );
});
