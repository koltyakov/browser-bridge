// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

await import('../src/content-script-helpers.js');

const helpers =
  /** @type {typeof globalThis & { __BBX_CONTENT_HELPERS__?: any }} */ (
    globalThis
  ).__BBX_CONTENT_HELPERS__;

test('content script helpers clamp, truncate, and normalize budgets', () => {
  assert.ok(helpers, 'content-script helpers should be registered on globalThis');
  assert.equal(helpers.clamp(999, 1, 10), 10);
  assert.equal(helpers.clamp(-1, 1, 10), 1);
  assert.deepEqual(helpers.truncateText('abcdef', 4), {
    value: 'abc…',
    truncated: true,
    omitted: 2,
  });
  assert.deepEqual(
    helpers.applyBudget({
      maxNodes: 999,
      maxDepth: 0,
      textBudget: 4,
      attributeAllowlist: ['id', '', 'id'],
    }),
    {
      maxNodes: 250,
      maxDepth: 1,
      textBudget: 32,
      includeBbox: true,
      attributeAllowlist: ['id'],
    }
  );
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

  globalThis.HTMLInputElement = /** @type {typeof HTMLInputElement} */ (
    /** @type {unknown} */ (FakeHtmlInputElement)
  );

  try {
    const searchInput = new FakeHtmlInputElement('search');
    const textInput = new FakeHtmlInputElement('text');

    assert.equal(helpers.getInputImplicitRole(searchInput), 'searchbox');
    assert.equal(helpers.getInputImplicitRole(textInput), 'textbox');
    assert.equal(
      helpers.getImplicitRole({
        tagName: 'A',
        /**
         * @param {string} name
         * @returns {boolean}
         */
        hasAttribute(name) {
          return name === 'href';
        },
      }),
      'link'
    );
    assert.equal(
      helpers.getImplicitRole({
        tagName: 'SECTION',
        /**
         * @returns {boolean}
         */
        hasAttribute() {
          return false;
        },
      }),
      'region'
    );
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

  globalThis.Node = /** @type {typeof Node} */ (
    /** @type {unknown} */ ({
      TEXT_NODE: 3,
    })
  );
  globalThis.window = /** @type {Window & typeof globalThis} */ (
    /** @type {unknown} */ ({
      scrollX: 12,
      scrollY: 34,
    })
  );

  try {
    assert.deepEqual(
      helpers.toRect({
        x: 5,
        y: 6,
        width: 70,
        height: 80,
      }),
      {
        x: 17,
        y: 40,
        width: 70,
        height: 80,
      }
    );

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
          title: 'Save',
        });
        return attributes[name] ?? null;
      },
      value: 'Save',
      childNodes: [
        { nodeType: 3, textContent: 'Save' },
        { nodeType: 3, textContent: 'now' },
        { nodeType: 8, textContent: 'ignored' },
      ],
      childElementCount: 1,
      textContent: 'unused fallback',
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
      textContent: '  Plain   text  ',
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

test('content script helpers prune only detached element registry entries', () => {
  /** @typedef {{}} RegistryElement */
  const liveOne = {};
  const liveTwo = {};
  const detachedOne = {};
  const detachedTwo = {};
  const registry = new Map([
    ['el_live_1', liveOne],
    ['el_detached_1', detachedOne],
    ['el_live_2', liveTwo],
    ['el_detached_2', detachedTwo],
  ]);
  const reverseRegistry = new WeakMap([
    [liveOne, 'el_live_1'],
    [detachedOne, 'el_detached_1'],
    [liveTwo, 'el_live_2'],
    [detachedTwo, 'el_detached_2'],
  ]);
  const attachedElements = new Set([liveOne, liveTwo]);

  const result = helpers.pruneElementRegistryEntries({
    registry,
    reverseRegistry,
    iterator: null,
    containsElement: (/** @type {RegistryElement} */ element) => attachedElements.has(element),
    batchSize: 10,
  });

  assert.equal(result.pruned, true);
  assert.equal(result.iterator, null);
  assert.deepEqual([...registry.keys()], ['el_live_1', 'el_live_2']);
  assert.equal(reverseRegistry.get(liveOne), 'el_live_1');
  assert.equal(reverseRegistry.get(liveTwo), 'el_live_2');
  assert.equal(reverseRegistry.get(detachedOne), undefined);
  assert.equal(reverseRegistry.get(detachedTwo), undefined);
});

test('content script helpers visibility matching avoids duplicate layout reads', () => {
  /** @typedef {{ id: string, rect: { width: number, height: number }, visibility: string }} WaitElement */
  const visibleElements = [
    { id: 'zero-area', rect: { width: 0, height: 10 }, visibility: 'visible' },
    { id: 'hidden', rect: { width: 20, height: 20 }, visibility: 'hidden' },
    { id: 'visible', rect: { width: 30, height: 30 }, visibility: 'visible' },
  ];
  const hiddenElements = [
    { id: 'shown', rect: { width: 20, height: 20 }, visibility: 'visible' },
    { id: 'hidden', rect: { width: 25, height: 25 }, visibility: 'hidden' },
    { id: 'after-match', rect: { width: 40, height: 40 }, visibility: 'visible' },
  ];

  /**
   * @param {WaitElement[]} elements
   * @param {'visible' | 'hidden'} waitState
   */
  function runCase(elements, waitState) {
    /** @type {Map<string, number>} */
    const rectCalls = new Map();
    /** @type {Map<string, number>} */
    const styleCalls = new Map();
    const match = helpers.findElementForWaitState({
      elements,
      waitState,
      getRect(/** @type {WaitElement} */ element) {
        rectCalls.set(element.id, (rectCalls.get(element.id) ?? 0) + 1);
        return element.rect;
      },
      getVisibility(/** @type {WaitElement} */ element) {
        styleCalls.set(element.id, (styleCalls.get(element.id) ?? 0) + 1);
        return element.visibility;
      },
    });

    for (const element of elements) {
      assert.ok((rectCalls.get(element.id) ?? 0) <= 1, `${element.id} rect read once`);
      assert.ok((styleCalls.get(element.id) ?? 0) <= 1, `${element.id} style read once`);
    }

    return { match, rectCalls, styleCalls };
  }

  const visibleResult = runCase(visibleElements, 'visible');
  assert.equal(visibleResult.match, visibleElements[2]);
  assert.deepEqual(Object.fromEntries(visibleResult.rectCalls), {
    'zero-area': 1,
    hidden: 1,
    visible: 1,
  });
  assert.deepEqual(Object.fromEntries(visibleResult.styleCalls), {
    hidden: 1,
    visible: 1,
  });

  const hiddenResult = runCase(hiddenElements, 'hidden');
  assert.equal(hiddenResult.match, hiddenElements[1]);
  assert.deepEqual(Object.fromEntries(hiddenResult.rectCalls), {
    shown: 1,
    hidden: 1,
  });
  assert.deepEqual(Object.fromEntries(hiddenResult.styleCalls), {
    shown: 1,
    hidden: 1,
  });
});
