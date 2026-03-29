// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

await import('../src/content-script-helpers.js');

const helpers = /** @type {typeof globalThis & { __BBX_CONTENT_HELPERS__?: any }} */ (globalThis).__BBX_CONTENT_HELPERS__;

test('content script helpers clamp, truncate, and normalize budgets', () => {
  assert.ok(helpers, 'content-script helpers should be registered on globalThis');
  assert.equal(helpers.clamp(999, 1, 10), 10);
  assert.equal(helpers.clamp(-1, 1, 10), 1);
  assert.deepEqual(helpers.truncateText('abcdef', 4), {
    value: 'abc…',
    truncated: true,
    omitted: 2
  });
  assert.deepEqual(helpers.applyBudget({
    maxNodes: 999,
    maxDepth: 0,
    textBudget: 4,
    attributeAllowlist: ['id', '', 'id']
  }), {
    maxNodes: 250,
    maxDepth: 1,
    textBudget: 32,
    includeBbox: true,
    attributeAllowlist: ['id']
  });
});

test('content script helpers escape Tailwind selectors and expose shared constants', () => {
  assert.equal(
    helpers.escapeTailwindSelector('.top-[30px] .bg-[#f00]'),
    '.top-\\[30px\\] .bg-\\[#f00\\]'
  );
  assert.equal(helpers.NON_TEXT_INPUT_TYPES.has('checkbox'), true);
  assert.equal(helpers.NON_TEXT_INPUT_TYPES.has('text'), false);
});

test('content script helpers infer implicit roles and selectors', () => {
  const originalHtmlInputElement = globalThis.HTMLInputElement;

  class FakeHtmlInputElement {
    /**
     * @param {string} type
     */
    constructor(type) {
      this.type = type;
    }
  }

  globalThis.HTMLInputElement = /** @type {typeof HTMLInputElement} */ (/** @type {unknown} */ (FakeHtmlInputElement));

  try {
    const searchInput = new FakeHtmlInputElement('search');
    const textInput = new FakeHtmlInputElement('text');

    assert.equal(helpers.getInputImplicitRole(searchInput), 'searchbox');
    assert.equal(helpers.getInputImplicitRole(textInput), 'textbox');
    assert.equal(helpers.getImplicitRole({
      tagName: 'A',
      /**
       * @param {string} name
       * @returns {boolean}
       */
      hasAttribute(name) {
        return name === 'href';
      }
    }), 'link');
    assert.equal(helpers.getImplicitRole({
      tagName: 'SECTION',
      /**
       * @returns {boolean}
       */
      hasAttribute() {
        return false;
      }
    }), 'region');
    assert.equal(helpers.getImplicitRoleSelector('checkbox'), 'input[type=checkbox]');
    assert.equal(helpers.getImplicitRoleSelector('missing'), '');
  } finally {
    if (originalHtmlInputElement === undefined) {
      Reflect.deleteProperty(globalThis, 'HTMLInputElement');
    } else {
      globalThis.HTMLInputElement = originalHtmlInputElement;
    }
  }
});

test('content script helpers convert rects and extract element text', () => {
  const originalNode = globalThis.Node;
  const originalWindow = globalThis.window;

  globalThis.Node = /** @type {typeof Node} */ (/** @type {unknown} */ ({
    TEXT_NODE: 3
  }));
  globalThis.window = /** @type {Window & typeof globalThis} */ (/** @type {unknown} */ ({
    scrollX: 12,
    scrollY: 34
  }));

  try {
    assert.deepEqual(helpers.toRect({
      x: 5,
      y: 6,
      width: 70,
      height: 80
    }), {
      x: 17,
      y: 40,
      width: 70,
      height: 80
    });

    const richElement = {
      /**
       * @param {string} name
       * @returns {string | null}
       */
      getAttribute(name) {
        const attributes = /** @type {Record<string, string>} */ ({
          'aria-label': 'Primary action',
          name: 'save',
          placeholder: 'Click save',
          title: 'Save'
        });
        return attributes[name] ?? null;
      },
      value: 'Save',
      childNodes: [
        { nodeType: 3, textContent: 'Save' },
        { nodeType: 3, textContent: 'now' },
        { nodeType: 8, textContent: 'ignored' }
      ],
      childElementCount: 1,
      textContent: 'unused fallback'
    };

    assert.equal(
      helpers.extractElementText(richElement),
      'Primary action | save | Click save | Save | Save now'
    );

    const plainTextElement = {
      getAttribute() {
        return null;
      },
      childNodes: [],
      childElementCount: 0,
      textContent: '  Plain   text  '
    };

    assert.equal(helpers.extractElementText(plainTextElement), 'Plain text');
  } finally {
    if (originalNode === undefined) {
      Reflect.deleteProperty(globalThis, 'Node');
    } else {
      globalThis.Node = originalNode;
    }

    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window');
    } else {
      globalThis.window = originalWindow;
    }
  }
});
