// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { withDocument } from '../../../tests/_helpers/dom.js';

const MISSING = Symbol('missing');

/**
 * @returns {Promise<void>}
 */
async function flushMicrotasks() {
  await Promise.resolve();
}

/**
 * @param {string} relativePath
 * @returns {Promise<void>}
 */
async function importFresh(relativePath) {
  await import(
    `${new URL(relativePath, import.meta.url).href}?case=${Date.now()}-${Math.random()}`
  );
}

/**
 * @param {string[]} keys
 * @returns {Map<string, unknown>}
 */
function captureGlobals(keys) {
  /** @type {Map<string, unknown>} */
  const saved = new Map();
  for (const key of keys) {
    saved.set(
      key,
      Object.prototype.hasOwnProperty.call(globalThis, key) ? Reflect.get(globalThis, key) : MISSING
    );
  }
  return saved;
}

/**
 * @param {Map<string, unknown>} saved
 * @returns {void}
 */
function restoreGlobals(saved) {
  for (const [key, value] of saved.entries()) {
    if (value === MISSING) {
      Reflect.deleteProperty(globalThis, key);
    } else {
      Reflect.set(globalThis, key, value);
    }
  }
}

/**
 * @returns {{
 *   chrome: { runtime: { onMessage: { addListener: (callback: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => boolean) => void } } },
 *   getListener: () => (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => boolean
 * }}
 */
function createChromeHarness() {
  /** @type {((message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => boolean) | null} */
  let listener = null;

  return {
    chrome: {
      runtime: {
        onMessage: {
          addListener(callback) {
            listener = callback;
          },
        },
      },
    },
    getListener() {
      assert.ok(listener, 'content script should register a runtime listener');
      return listener;
    },
  };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{
 *   withHelpers?: boolean,
 *   preserveDomGlobals?: boolean,
 *   chrome?: unknown,
 *   document?: unknown,
 *   window?: unknown,
 * }} [options]
 * @returns {Promise<void>}
 */
async function loadContentScript(t, options = {}) {
  const globalsToCapture = [
    'chrome',
    '__BBX_CONTENT_HELPERS__',
    '__BBX_CONTENT_REGISTRY__',
    '__BBX_CONTENT_DOM_QUERY__',
    '__BBX_CONTENT_INPUT__',
    '__BBX_CONTENT_PATCH__',
    '__chromeCodexBridgeContentScriptLoaded',
  ];
  if (!options.preserveDomGlobals) {
    globalsToCapture.push('document', 'window');
  }
  const saved = captureGlobals(globalsToCapture);
  t.after(() => restoreGlobals(saved));

  Reflect.deleteProperty(globalThis, '__chromeCodexBridgeContentScriptLoaded');

  if (options.withHelpers) {
    await importFresh('../src/content-script-helpers.js');
  } else {
    Reflect.deleteProperty(globalThis, '__BBX_CONTENT_HELPERS__');
  }

  if (Object.prototype.hasOwnProperty.call(options, 'chrome')) {
    Reflect.set(globalThis, 'chrome', options.chrome);
  } else {
    Reflect.deleteProperty(globalThis, 'chrome');
  }

  if (!options.preserveDomGlobals) {
    if (Object.prototype.hasOwnProperty.call(options, 'document')) {
      Reflect.set(globalThis, 'document', options.document);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }

    if (Object.prototype.hasOwnProperty.call(options, 'window')) {
      Reflect.set(globalThis, 'window', options.window);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }

  if (options.withHelpers) {
    await importFresh('../src/content-element-registry.js');
    await importFresh('../src/content-dom-query.js');
    await importFresh('../src/content-input.js');
    await importFresh('../src/content-patch.js');
  }

  await importFresh('../src/content-script.js');
}

/**
 * @param {{
 *   tagName?: string,
 *   textContent?: string,
 *   innerHTML?: string,
 *   outerHTML?: string,
 *   attributes?: Record<string, string>,
 *   children?: Array<any>,
 *   rect?: { x?: number, y?: number, left?: number, top?: number, width?: number, height?: number },
 * }} [options]
 * @returns {any}
 */
function createFakeElement(options = {}) {
  const tagName = (options.tagName ?? 'div').toUpperCase();
  const textContent = options.textContent ?? '';
  const innerHTML = options.innerHTML ?? textContent;
  const children = options.children ?? [];
  const attributes = new Map(Object.entries(options.attributes ?? {}));
  const rect = {
    x: options.rect?.x ?? options.rect?.left ?? 0,
    y: options.rect?.y ?? options.rect?.top ?? 0,
    left: options.rect?.left ?? options.rect?.x ?? 0,
    top: options.rect?.top ?? options.rect?.y ?? 0,
    width: options.rect?.width ?? 10,
    height: options.rect?.height ?? 10,
  };
  const classNames = new Set(
    String(options.attributes?.class ?? '')
      .split(/\s+/)
      .filter(Boolean)
  );

  const classList = {
    /** @param {string} value */
    contains(value) {
      return classNames.has(value);
    },
    /** @param {string} value */
    toggle(value) {
      if (classNames.has(value)) {
        classNames.delete(value);
      } else {
        classNames.add(value);
      }
      if (classNames.size) {
        attributes.set('class', [...classNames].join(' '));
      } else {
        attributes.delete('class');
      }
      return classNames.has(value);
    },
    [Symbol.iterator]() {
      return classNames.values();
    },
  };

  return {
    tagName,
    textContent,
    innerHTML,
    outerHTML:
      options.outerHTML ?? `<${tagName.toLowerCase()}>${innerHTML}</${tagName.toLowerCase()}>`,
    children,
    childNodes: textContent ? [{ nodeType: 3, textContent }] : [],
    childElementCount: children.length,
    classList,
    /** @param {string} name */
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    /** @param {string} name */
    hasAttribute(name) {
      return attributes.has(name);
    },
    /** @param {string} name @param {string} value */
    setAttribute(name, value) {
      attributes.set(name, String(value));
      if (name === 'class') {
        classNames.clear();
        for (const token of String(value).split(/\s+/).filter(Boolean)) {
          classNames.add(token);
        }
      }
    },
    /** @param {string} name */
    removeAttribute(name) {
      attributes.delete(name);
      if (name === 'class') {
        classNames.clear();
      }
    },
    getBoundingClientRect() {
      return rect;
    },
  };
}

/**
 * @param {any} body
 * @param {Record<string, any>} [selectors]
 * @param {Record<string, any>} [overrides]
 * @returns {{
 *   body: any,
 *   documentElement: any,
 *   activeElement: any,
 *   contains: (element: any) => boolean,
 *   elementFromPoint: (x: number, y: number) => any,
 *   hasFocus: () => boolean,
 *   getSelection: () => { toString: () => string },
 *   querySelector: (selector: string) => any,
 *   querySelectorAll: (selector: string) => any[]
 * }}
 */
function createDocumentHarness(body, selectors = {}, overrides = {}) {
  const elements = new Set();
  /** @type {any[]} */
  const orderedElements = [];

  /** @param {any} element */
  function visit(element) {
    if (!element || elements.has(element)) {
      return;
    }
    elements.add(element);
    orderedElements.push(element);
    for (const child of element.children ?? []) {
      visit(child);
    }
  }

  visit(body);

  /** @type {{
   *   body: any,
   *   documentElement: any,
   *   activeElement: any,
   *   contains: (element: any) => boolean,
   *   elementFromPoint: (x: number, y: number) => any,
   *   hasFocus: () => boolean,
   *   getSelection: () => { toString: () => string },
   *   querySelector: (selector: string) => any,
   *   querySelectorAll: (selector: string) => any[]
   * }} */
  const documentHarness = {
    body,
    documentElement: body,
    activeElement: null,
    contains(element) {
      return elements.has(element);
    },
    elementFromPoint() {
      return null;
    },
    hasFocus() {
      return true;
    },
    getSelection() {
      return {
        toString() {
          return '';
        },
      };
    },
    querySelector(selector) {
      if (selector === 'body') {
        return body;
      }
      const match = selectors[selector];
      return Array.isArray(match) ? (match[0] ?? null) : (match ?? null);
    },
    querySelectorAll(selector) {
      if (selector === 'body') {
        return [body];
      }
      if (selector === '*') {
        return orderedElements;
      }
      const match = selectors[selector];
      if (Array.isArray(match)) {
        return match;
      }
      return match ? [match] : [];
    },
    ...overrides,
  };

  return documentHarness;
}

/**
 * @param {(message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => boolean} listener
 * @param {string} method
 * @param {Record<string, any>} params
 * @returns {Promise<any>}
 */
function executeBridgeMethod(listener, method, params) {
  return new Promise((resolve) => {
    assert.equal(
      listener(
        {
          type: 'bridge.execute',
          method,
          params,
        },
        /** @type {chrome.runtime.MessageSender} */ ({}),
        resolve
      ),
      true
    );
  });
}

/**
 * @param {import('node:test').TestContext} t
 * @returns {{
 *   createBody: (children?: any[]) => any,
 *   createCheckbox: (options?: { checked?: boolean }) => any,
 *   createRadio: (options?: { checked?: boolean }) => any,
 *   createTextInput: (options?: { value?: string }) => any,
 *   createTextArea: (options?: { value?: string }) => any,
 *   createContentEditable: (options?: { textContent?: string }) => any,
 *   createButton: (options?: { type?: string, textContent?: string }) => any,
 *   createForm: (children?: any[]) => any,
 *   createOption: (options: { value: string, label?: string, text?: string, selected?: boolean }) => any,
 *   createSelect: (options: any[], config?: { multiple?: boolean }) => any,
 * }}
 */
function installInputDomGlobals(t) {
  const saved = captureGlobals([
    'Element',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLOptionElement',
    'HTMLButtonElement',
    'HTMLFormElement',
    'Event',
    'InputEvent',
    'KeyboardEvent',
    'MouseEvent',
    'DragEvent',
    'DataTransfer',
  ]);
  t.after(() => restoreGlobals(saved));

  /** @param {any} element @param {string} selector */
  function matchesSelector(element, selector) {
    if (selector === 'select') {
      return element instanceof FakeHTMLSelectElement;
    }
    if (selector === 'form') {
      return element instanceof FakeHTMLFormElement;
    }
    if (selector === 'textarea') {
      return element instanceof FakeHTMLTextAreaElement;
    }
    if (selector === "[contenteditable='']" || selector === "[contenteditable='true']") {
      return element instanceof FakeHTMLElement && element.isContentEditable;
    }
    if (selector === 'input') {
      return element instanceof FakeHTMLInputElement;
    }
    if (selector === 'button') {
      return element instanceof FakeHTMLButtonElement;
    }
    if (selector === 'input[type="checkbox"]') {
      return element instanceof FakeHTMLInputElement && element.type === 'checkbox';
    }
    if (selector === 'input[type="radio"]') {
      return element instanceof FakeHTMLInputElement && element.type === 'radio';
    }
    return false;
  }

  /** @param {any} root @param {string} selectorText @returns {any | null} */
  function findFirstMatchingDescendant(root, selectorText) {
    const selectors = selectorText.split(',').map((selector) => selector.trim());
    for (const child of root.children ?? []) {
      if (selectors.some((selector) => matchesSelector(child, selector))) {
        return child;
      }
      const nested = findFirstMatchingDescendant(child, selectorText);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  class FakeEvent {
    /**
     * @param {string} type
     * @param {Record<string, any>} [options]
     */
    constructor(type, options = {}) {
      this.type = type;
      this.defaultPrevented = false;
      Object.assign(this, options);
    }

    /** @returns {void} */
    preventDefault() {
      this.defaultPrevented = true;
    }
  }

  class FakeInputEvent extends FakeEvent {}

  class FakeKeyboardEvent extends FakeEvent {}

  class FakeMouseEvent extends FakeEvent {}

  class FakeDragEvent extends FakeMouseEvent {}

  class FakeDataTransfer {
    constructor() {
      this.data = new Map();
    }

    /** @param {string} type @param {string} value */
    setData(type, value) {
      this.data.set(type, value);
    }

    /** @param {string} type */
    getData(type) {
      return this.data.get(type) ?? '';
    }
  }

  class FakeElement {
    /**
     * @param {string} tagName
     * @param {{
     *   attributes?: Record<string, string>,
     *   children?: any[],
     *   textContent?: string
     * }} [options]
     */
    constructor(tagName, options = {}) {
      this.tagName = tagName.toUpperCase();
      this.attributes = new Map(Object.entries(options.attributes ?? {}));
      this.children = options.children ?? [];
      /** @type {any[]} */
      this.childNodes = [];
      /** @type {any | null} */
      this.parentElement = null;
      this._textContent = options.textContent ?? '';
      this._innerText = this._textContent;
      this._innerHTML = this._textContent;
      this.outerHTML = `<${tagName}>${this._innerHTML}</${tagName}>`;
      /** @type {string[]} */
      this.eventLog = [];
      this.scrollTop = 0;
      this.scrollLeft = 0;

      for (const child of this.children) {
        child.parentElement = this;
      }
    }

    /** @param {string} name */
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    /** @param {string} name */
    hasAttribute(name) {
      return this.attributes.has(name);
    }

    get textContent() {
      return this._textContent;
    }

    /** @param {string} value */
    set textContent(value) {
      this._textContent = String(value ?? '');
      this._innerText = this._textContent;
      this._innerHTML = this._textContent;
      this.outerHTML = `<${this.tagName.toLowerCase()}>${this._innerHTML}</${this.tagName.toLowerCase()}>`;
    }

    get innerText() {
      return this._innerText;
    }

    /** @param {string} value */
    set innerText(value) {
      this.textContent = value;
    }

    get innerHTML() {
      return this._innerHTML;
    }

    /** @param {string} value */
    set innerHTML(value) {
      this._innerHTML = String(value ?? '');
      this._textContent = this._innerHTML;
      this._innerText = this._innerHTML;
      this.outerHTML = `<${this.tagName.toLowerCase()}>${this._innerHTML}</${this.tagName.toLowerCase()}>`;
    }

    /** @param {any} node */
    contains(node) {
      if (node === this) {
        return true;
      }
      return this.children.some(
        (child) => typeof child.contains === 'function' && child.contains(node)
      );
    }

    /** @param {string} selector */
    querySelector(selector) {
      return findFirstMatchingDescendant(this, selector);
    }

    /** @param {string} selector */
    closest(selector) {
      let current = this.parentElement;
      while (current) {
        if (matchesSelector(current, selector)) {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    }

    /** @returns {{ left: number, top: number, width: number, height: number }} */
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 10, height: 10 };
    }

    /** @returns {void} */
    scrollIntoView() {}

    /** @param {{ top?: number, left?: number }} options */
    scrollTo(options) {
      this.scrollTop = options.top ?? this.scrollTop;
      this.scrollLeft = options.left ?? this.scrollLeft;
    }

    /** @param {{ top?: number, left?: number }} options */
    scrollBy(options) {
      this.scrollTop += options.top ?? 0;
      this.scrollLeft += options.left ?? 0;
    }

    /** @returns {void} */
    focus() {
      if (globalThis.document) {
        Reflect.set(globalThis.document, 'activeElement', this);
      }
    }

    /** @param {FakeEvent} event */
    dispatchEvent(event) {
      this.eventLog.push(event.type);
      return !event.defaultPrevented;
    }
  }

  class FakeHTMLElement extends FakeElement {}

  /** @type {boolean} */
  FakeHTMLElement.prototype.isContentEditable = false;

  class FakeHTMLButtonElement extends FakeHTMLElement {
    /** @param {string} [type='button'] */
    constructor(type = 'button') {
      super('button');
      this.type = type;
    }

    /** @returns {void} */
    click() {
      this.dispatchEvent(new FakeMouseEvent('click', { bubbles: true, composed: true }));
    }
  }

  class FakeHTMLFormElement extends FakeHTMLElement {
    constructor() {
      super('form');
      this.submitCount = 0;
    }

    /** @returns {void} */
    requestSubmit() {
      this.submitCount += 1;
      this.dispatchEvent(new FakeEvent('submit', { bubbles: true, composed: true }));
    }
  }

  class FakeHTMLInputElement extends FakeHTMLElement {
    /** @param {string} type */
    constructor(type) {
      super('input');
      this.type = type;
      this.checked = false;
      this.value = '';
      this.selectionStart = 0;
      this.selectionEnd = 0;
    }

    /** @param {string} replacement @param {number} start @param {number} end */
    setRangeText(replacement, start, end) {
      this.value = `${this.value.slice(0, start)}${replacement}${this.value.slice(end)}`;
      const cursor = start + replacement.length;
      this.selectionStart = cursor;
      this.selectionEnd = cursor;
    }

    /** @returns {void} */
    click() {
      this.dispatchEvent(new FakeMouseEvent('click', { bubbles: true, composed: true }));
      if (this.type === 'checkbox') {
        this.checked = !this.checked;
      } else if (this.type === 'radio') {
        this.checked = true;
      }
      this.dispatchEvent(new FakeEvent('input', { bubbles: true, composed: true }));
      this.dispatchEvent(new FakeEvent('change', { bubbles: true, composed: true }));
    }
  }

  class FakeHTMLTextAreaElement extends FakeHTMLElement {
    constructor() {
      super('textarea');
      this.value = '';
      this.selectionStart = 0;
      this.selectionEnd = 0;
    }

    /** @param {string} replacement @param {number} start @param {number} end */
    setRangeText(replacement, start, end) {
      this.value = `${this.value.slice(0, start)}${replacement}${this.value.slice(end)}`;
      const cursor = start + replacement.length;
      this.selectionStart = cursor;
      this.selectionEnd = cursor;
    }
  }

  class FakeHTMLOptionElement extends FakeHTMLElement {
    /**
     * @param {{ value: string, label?: string, text?: string, selected?: boolean }} options
     */
    constructor(options) {
      super('option', {
        textContent: options.text ?? options.label ?? options.value,
      });
      this.value = options.value;
      this.label = options.label ?? options.text ?? options.value;
      this.text = options.text ?? options.label ?? options.value;
      this.selected = options.selected === true;
    }
  }

  class FakeHTMLSelectElement extends FakeHTMLElement {
    /**
     * @param {FakeHTMLOptionElement[]} options
     * @param {{ multiple?: boolean }} [config]
     */
    constructor(options, config = {}) {
      super('select', {
        children: options,
      });
      this.options = options;
      this.multiple = config.multiple === true;
    }

    get selectedOptions() {
      return this.options.filter((option) => option.selected);
    }

    get value() {
      return this.selectedOptions[0]?.value ?? '';
    }

    /** @param {string} nextValue */
    set value(nextValue) {
      let matched = false;
      for (const option of this.options) {
        /** @type {boolean} */
        const selected = !matched && option.value === nextValue;
        option.selected = selected;
        matched = matched || selected;
      }
    }
  }

  globalThis.Element = /** @type {typeof Element} */ (/** @type {unknown} */ (FakeElement));
  globalThis.HTMLElement = /** @type {typeof HTMLElement} */ (
    /** @type {unknown} */ (FakeHTMLElement)
  );
  globalThis.HTMLInputElement = /** @type {typeof HTMLInputElement} */ (
    /** @type {unknown} */ (FakeHTMLInputElement)
  );
  globalThis.HTMLTextAreaElement = /** @type {typeof HTMLTextAreaElement} */ (
    /** @type {unknown} */ (FakeHTMLTextAreaElement)
  );
  globalThis.HTMLSelectElement = /** @type {typeof HTMLSelectElement} */ (
    /** @type {unknown} */ (FakeHTMLSelectElement)
  );
  globalThis.HTMLOptionElement = /** @type {typeof HTMLOptionElement} */ (
    /** @type {unknown} */ (FakeHTMLOptionElement)
  );
  globalThis.HTMLButtonElement = /** @type {typeof HTMLButtonElement} */ (
    /** @type {unknown} */ (FakeHTMLButtonElement)
  );
  globalThis.HTMLFormElement = /** @type {typeof HTMLFormElement} */ (
    /** @type {unknown} */ (FakeHTMLFormElement)
  );
  globalThis.Event = /** @type {typeof Event} */ (/** @type {unknown} */ (FakeEvent));
  globalThis.InputEvent = /** @type {typeof InputEvent} */ (
    /** @type {unknown} */ (FakeInputEvent)
  );
  globalThis.KeyboardEvent = /** @type {typeof KeyboardEvent} */ (
    /** @type {unknown} */ (FakeKeyboardEvent)
  );
  globalThis.MouseEvent = /** @type {typeof MouseEvent} */ (
    /** @type {unknown} */ (FakeMouseEvent)
  );
  globalThis.DragEvent = /** @type {typeof DragEvent} */ (/** @type {unknown} */ (FakeDragEvent));
  globalThis.DataTransfer = /** @type {typeof DataTransfer} */ (
    /** @type {unknown} */ (FakeDataTransfer)
  );

  return {
    /** @param {any[]} [children] */
    createBody(children = []) {
      return new FakeHTMLElement('body', { children });
    },
    /** @param {{ checked?: boolean }} [options] */
    createCheckbox(options = {}) {
      const checkbox = new FakeHTMLInputElement('checkbox');
      checkbox.checked = options.checked === true;
      return checkbox;
    },
    /** @param {{ checked?: boolean }} [options] */
    createRadio(options = {}) {
      const radio = new FakeHTMLInputElement('radio');
      radio.checked = options.checked === true;
      return radio;
    },
    /** @param {{ value?: string }} [options] */
    createTextInput(options = {}) {
      const input = new FakeHTMLInputElement('text');
      input.value = options.value ?? '';
      input.selectionStart = input.value.length;
      input.selectionEnd = input.value.length;
      return input;
    },
    /** @param {{ value?: string }} [options] */
    createTextArea(options = {}) {
      const textarea = new FakeHTMLTextAreaElement();
      textarea.value = options.value ?? '';
      textarea.selectionStart = textarea.value.length;
      textarea.selectionEnd = textarea.value.length;
      return textarea;
    },
    /** @param {{ textContent?: string }} [options] */
    createContentEditable(options = {}) {
      const editable = new FakeHTMLElement('div', {
        attributes: { contenteditable: 'true' },
        textContent: options.textContent ?? '',
      });
      editable.isContentEditable = true;
      return editable;
    },
    /** @param {{ type?: string, textContent?: string }} [options] */
    createButton(options = {}) {
      const button = new FakeHTMLButtonElement(options.type ?? 'button');
      button.textContent = options.textContent ?? '';
      return button;
    },
    /** @param {any[]} [children] */
    createForm(children = []) {
      const form = new FakeHTMLFormElement();
      form.children = children;
      for (const child of children) {
        child.parentElement = form;
      }
      return form;
    },
    /** @param {{ value: string, label?: string, text?: string, selected?: boolean }} options */
    createOption(options) {
      return new FakeHTMLOptionElement(options);
    },
    /** @param {FakeHTMLOptionElement[]} options @param {{ multiple?: boolean }} [config] */
    createSelect(options, config = {}) {
      return new FakeHTMLSelectElement(options, config);
    },
  };
}

test('content script skips initialization when Chrome runtime messaging is unavailable', async (t) => {
  const contentScriptGlobal =
    /** @type {typeof globalThis & { __chromeCodexBridgeContentScriptLoaded?: boolean }} */ (
      globalThis
    );

  await loadContentScript(t);

  assert.equal(contentScriptGlobal.__chromeCodexBridgeContentScriptLoaded, undefined);
});

test('content script registers a listener and answers bridge ping messages', async (t) => {
  const harness = createChromeHarness();
  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
  });

  /** @type {unknown[]} */
  const responses = [];
  const listener = harness.getListener();

  assert.equal(
    listener(
      { type: 'bridge.ping' },
      /** @type {chrome.runtime.MessageSender} */ ({}),
      (response) => responses.push(response)
    ),
    false
  );

  assert.deepEqual(responses, [{ ok: true }]);
});

test('content script dispatches bridge.execute page text requests', async (t) => {
  const harness = createChromeHarness();
  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document: {
      body: {
        innerText: '  Hello bridge  ',
      },
    },
  });

  /** @type {unknown[]} */
  const responses = [];
  const listener = harness.getListener();

  assert.equal(
    listener(
      {
        type: 'bridge.execute',
        method: 'page.get_text',
        params: { textBudget: 50 },
      },
      /** @type {chrome.runtime.MessageSender} */ ({}),
      (response) => responses.push(response)
    ),
    true
  );

  await flushMicrotasks();

  assert.deepEqual(responses, [
    {
      value: 'Hello bridge',
      truncated: false,
      omitted: 0,
      length: 12,
    },
  ]);
});

test('content script page text requests honor the text budget cap', async (t) => {
  const harness = createChromeHarness();
  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document: {
      body: {
        innerText: '  abcdefghij  ',
      },
    },
  });

  /** @type {unknown[]} */
  const responses = [];
  const listener = harness.getListener();

  assert.equal(
    listener(
      {
        type: 'bridge.execute',
        method: 'page.get_text',
        params: { textBudget: 5 },
      },
      /** @type {chrome.runtime.MessageSender} */ ({}),
      (response) => responses.push(response)
    ),
    true
  );

  await flushMicrotasks();

  assert.deepEqual(responses, [
    {
      value: 'abcd…',
      truncated: true,
      omitted: 5,
      length: 10,
    },
  ]);
});

test('content script dom.get_html truncates large HTML payloads', async (t) => {
  const harness = createChromeHarness();
  const target = createFakeElement({
    innerHTML: 'x'.repeat(50),
  });
  const body = createFakeElement({
    tagName: 'body',
    children: [target],
  });
  const document = createDocumentHarness(body, { '#target': target });

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
  });

  /** @type {unknown[]} */
  const responses = [];
  const listener = harness.getListener();

  assert.equal(
    listener(
      {
        type: 'bridge.execute',
        method: 'dom.get_html',
        params: {
          target: { selector: '#target' },
          maxLength: 32,
        },
      },
      /** @type {chrome.runtime.MessageSender} */ ({}),
      (response) => responses.push(response)
    ),
    true
  );

  await flushMicrotasks();

  assert.deepEqual(responses, [
    {
      html: `${'x'.repeat(31)}…`,
      truncated: true,
      omitted: 18,
    },
  ]);
});

test('content script dom.query scopes to withinRef and respects maxNodes', async (t) => {
  const harness = createChromeHarness();
  await withDocument(
    `<!doctype html>
    <html>
      <body>
        <section id="scope">
          Scoped root
          <button>
            Scoped child
            <span>Scoped grandchild</span>
          </button>
        </section>
        <aside id="outside">Outside child</aside>
      </body>
    </html>`,
    async () => {
      await loadContentScript(t, {
        withHelpers: true,
        preserveDomGlobals: true,
        chrome: harness.chrome,
      });

      const listener = harness.getListener();

      /**
       * @param {Record<string, any>} params
       * @returns {Promise<any>}
       */
      function query(params) {
        return new Promise((resolve) => {
          assert.equal(
            listener(
              {
                type: 'bridge.execute',
                method: 'dom.query',
                params,
              },
              /** @type {chrome.runtime.MessageSender} */ ({}),
              resolve
            ),
            true
          );
        });
      }

      const initialQuery = await query({
        selector: '#scope',
        includeBbox: false,
        maxNodes: 10,
        textBudget: 200,
      });
      const scopedQuery = await query({
        selector: '#outside',
        withinRef: initialQuery.nodes[0].elementRef,
        includeBbox: false,
        maxNodes: 2,
        textBudget: 200,
      });

      assert.equal(initialQuery.nodes.length, 3);
      assert.equal(scopedQuery.nodes.length, 2);
      assert.equal(scopedQuery.truncated, true);
      assert.deepEqual(
        scopedQuery.nodes.map(
          /** @param {{ tag: string, textExcerpt?: string }} node */
          (node) => ({ tag: node.tag, textExcerpt: node.textExcerpt })
        ),
        [
          { tag: 'section', textExcerpt: 'Scoped root' },
          { tag: 'button', textExcerpt: 'Scoped child' },
        ]
      );
    }
  );
});

test('content script dom.find_by_text is case-insensitive and respects selector scope', async (t) => {
  const saved = captureGlobals(['Node']);
  t.after(() => restoreGlobals(saved));
  globalThis.Node = /** @type {typeof Node} */ (/** @type {unknown} */ ({ TEXT_NODE: 3 }));

  const harness = createChromeHarness();
  const insideMatch = createFakeElement({
    tagName: 'button',
    textContent: 'Hello Bridge',
    attributes: { id: 'inside', class: 'scope' },
  });
  const outsideMatch = createFakeElement({
    tagName: 'button',
    textContent: 'HELLO bridge',
    attributes: { id: 'outside', class: 'outside' },
  });
  const nonMatch = createFakeElement({
    tagName: 'button',
    textContent: 'Ignore me',
    attributes: { id: 'skip', class: 'scope' },
  });
  const body = createFakeElement({
    tagName: 'body',
    children: [insideMatch, outsideMatch, nonMatch],
  });
  const document = createDocumentHarness(body, {
    button: [insideMatch, outsideMatch, nonMatch],
    '.scope': [insideMatch, nonMatch],
  });

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
    window: /** @type {Window & typeof globalThis} */ (
      /** @type {unknown} */ ({ scrollX: 0, scrollY: 0 })
    ),
  });

  const listener = harness.getListener();

  /**
   * @param {Record<string, any>} params
   * @returns {Promise<any>}
   */
  function execute(params) {
    return new Promise((resolve) => {
      assert.equal(
        listener(
          {
            type: 'bridge.execute',
            method: 'dom.find_by_text',
            params,
          },
          /** @type {chrome.runtime.MessageSender} */ ({}),
          resolve
        ),
        true
      );
    });
  }

  const allMatches = await execute({
    selector: 'button',
    text: 'hello bridge',
    maxResults: 10,
  });
  const scopedMatches = await execute({
    selector: '.scope',
    text: 'hello bridge',
    maxResults: 10,
  });

  assert.equal(allMatches.count, 2);
  assert.deepEqual(
    allMatches.nodes.map(
      /** @param {{ attrs: Record<string, string | null>, textExcerpt?: string }} node */
      (node) => ({ id: node.attrs.id, textExcerpt: node.textExcerpt })
    ),
    [
      { id: 'inside', textExcerpt: 'Hello Bridge' },
      { id: 'outside', textExcerpt: 'HELLO bridge' },
    ]
  );
  assert.equal(scopedMatches.count, 1);
  assert.deepEqual(
    scopedMatches.nodes.map(
      /** @param {{ attrs: Record<string, string | null>, textExcerpt?: string }} node */
      (node) => ({ id: node.attrs.id, textExcerpt: node.textExcerpt })
    ),
    [{ id: 'inside', textExcerpt: 'Hello Bridge' }]
  );
});

test('content script dom.find_by_role matches explicit and implicit roles by accessible name', async (t) => {
  const saved = captureGlobals(['Node', 'CSS', 'HTMLInputElement']);
  t.after(() => restoreGlobals(saved));
  globalThis.Node = /** @type {typeof Node} */ (/** @type {unknown} */ ({ TEXT_NODE: 3 }));
  globalThis.CSS = /** @type {typeof CSS} */ (
    /** @type {unknown} */ ({
      /** @param {string} value */
      escape(value) {
        return value;
      },
    })
  );
  globalThis.HTMLInputElement = /** @type {typeof HTMLInputElement} */ (
    /** @type {unknown} */ (function FakeInputElement() {})
  );

  const harness = createChromeHarness();
  const explicitMatch = createFakeElement({
    tagName: 'div',
    textContent: 'Open panel',
    attributes: { id: 'explicit', role: 'button', 'aria-label': 'Launch Bridge Panel' },
  });
  const implicitMatch = createFakeElement({
    tagName: 'button',
    textContent: 'Bridge search',
    attributes: { id: 'implicit' },
  });
  const nameMiss = createFakeElement({
    tagName: 'button',
    textContent: 'Settings',
    attributes: { id: 'miss' },
  });
  const body = createFakeElement({
    tagName: 'body',
    children: [explicitMatch, implicitMatch, nameMiss],
  });
  const document = createDocumentHarness(body, {
    '[role="button"], button, input[type=button], input[type=submit], input[type=reset], input[type=image]':
      [explicitMatch, implicitMatch, nameMiss],
    '*': [explicitMatch, implicitMatch, nameMiss],
  });

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
    window: /** @type {Window & typeof globalThis} */ (
      /** @type {unknown} */ ({ scrollX: 0, scrollY: 0 })
    ),
  });

  const listener = harness.getListener();

  const matches = /** @type {any} */ (
    await new Promise((resolve) => {
      assert.equal(
        listener(
          {
            type: 'bridge.execute',
            method: 'dom.find_by_role',
            params: {
              role: 'button',
              name: 'bridge',
              maxResults: 10,
            },
          },
          /** @type {chrome.runtime.MessageSender} */ ({}),
          resolve
        ),
        true
      );
    })
  );

  assert.equal(matches.error, undefined);

  assert.equal(matches.count, 2);
  assert.deepEqual(
    matches.nodes.map(
      /** @param {{ tag: string, name: string | null, attrs: Record<string, string | null>, textExcerpt?: string }} node */
      (node) => ({
        tag: node.tag,
        id: node.attrs.id,
        role: node.attrs.role ?? null,
        name: node.name,
        textExcerpt: node.textExcerpt,
      })
    ),
    [
      {
        tag: 'div',
        id: 'explicit',
        role: 'button',
        name: 'Launch Bridge Panel',
        textExcerpt: 'Launch Bridge Panel | Open panel',
      },
      {
        tag: 'button',
        id: 'implicit',
        role: null,
        name: null,
        textExcerpt: 'Bridge search',
      },
    ]
  );
});

test('content script reuses the same elementRef for repeated dom.query calls', async (t) => {
  const saved = captureGlobals(['Node']);
  t.after(() => restoreGlobals(saved));
  globalThis.Node = /** @type {typeof Node} */ (/** @type {unknown} */ ({ TEXT_NODE: 3 }));

  const harness = createChromeHarness();
  const target = createFakeElement({
    tagName: 'button',
    textContent: 'Repeat me',
  });
  const body = createFakeElement({
    tagName: 'body',
    textContent: 'Repeat me',
    children: [target],
  });
  const document = createDocumentHarness(body, { '#target': target });

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
  });

  /** @type {Array<any>} */
  const responses = [];
  const listener = harness.getListener();
  const message = {
    type: 'bridge.execute',
    method: 'dom.query',
    params: {
      selector: '#target',
      includeBbox: false,
      maxNodes: 1,
      textBudget: 50,
    },
  };

  assert.equal(
    listener(message, /** @type {chrome.runtime.MessageSender} */ ({}), (response) =>
      responses.push(response)
    ),
    true
  );
  await flushMicrotasks();

  assert.equal(
    listener(message, /** @type {chrome.runtime.MessageSender} */ ({}), (response) =>
      responses.push(response)
    ),
    true
  );
  await flushMicrotasks();

  assert.equal(responses.length, 2);
  assert.equal(responses[0].nodes.length, 1);
  assert.equal(responses[1].nodes.length, 1);
  assert.equal(responses[0].registrySize, 1);
  assert.equal(responses[1].registrySize, 1);
  assert.equal(responses[0].nodes[0].elementRef, responses[1].nodes[0].elementRef);
});

test('content script prunes detached registry entries in 100-entry batches once full', async (t) => {
  const saved = captureGlobals(['Node']);
  t.after(() => restoreGlobals(saved));
  globalThis.Node = /** @type {typeof Node} */ (/** @type {unknown} */ ({ TEXT_NODE: 3 }));

  const harness = createChromeHarness();
  /** @type {Array<{ root: any, children: any[] }>} */
  const sections = [];
  /** @type {Record<string, any>} */
  const selectors = {};
  /** @type {Set<any>} */
  const attachedElements = new Set();

  for (let sectionIndex = 0; sectionIndex < 20; sectionIndex++) {
    /** @type {any[]} */
    const children = [];
    for (let childIndex = 0; childIndex < 249; childIndex++) {
      const child = createFakeElement({
        tagName: 'div',
        textContent: `node-${sectionIndex}-${childIndex}`,
      });
      children.push(child);
      attachedElements.add(child);
    }

    const root = createFakeElement({
      tagName: 'section',
      textContent: `section-${sectionIndex}`,
      children,
      attributes: { id: `section-${sectionIndex}` },
    });
    sections.push({ root, children });
    selectors[`#section-${sectionIndex}`] = root;
    attachedElements.add(root);
  }

  const overflow = createFakeElement({
    tagName: 'section',
    textContent: 'overflow-node',
    attributes: { id: 'overflow' },
  });
  selectors['#overflow'] = overflow;
  attachedElements.add(overflow);

  const body = createFakeElement({
    tagName: 'body',
    children: [...sections.map((section) => section.root), overflow],
  });
  attachedElements.add(body);

  const baseDocument = createDocumentHarness(body, selectors);
  const document = {
    ...baseDocument,
    /** @param {any} element */
    contains(element) {
      return attachedElements.has(element);
    },
  };

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
  });

  const listener = harness.getListener();

  /**
   * @param {Record<string, any>} params
   * @returns {Promise<any>}
   */
  function query(params) {
    return new Promise((resolve) => {
      assert.equal(
        listener(
          {
            type: 'bridge.execute',
            method: 'dom.query',
            params,
          },
          /** @type {chrome.runtime.MessageSender} */ ({}),
          resolve
        ),
        true
      );
    });
  }

  const initialQuery = await query({
    selector: '#section-0',
    includeBbox: false,
    maxNodes: 250,
    textBudget: 10000,
  });

  assert.equal(initialQuery.nodes.length, 250);
  assert.equal(initialQuery.registrySize, 250);

  let lastQuery = initialQuery;
  for (let sectionIndex = 1; sectionIndex < 20; sectionIndex++) {
    lastQuery = await query({
      selector: `#section-${sectionIndex}`,
      includeBbox: false,
      maxNodes: 250,
      textBudget: 10000,
    });
  }

  assert.equal(lastQuery.registrySize, 5000);

  attachedElements.delete(sections[0].root);
  for (const detachedChild of sections[0].children.slice(0, 100)) {
    attachedElements.delete(detachedChild);
  }

  const overflowQuery = await query({
    selector: '#overflow',
    includeBbox: false,
    maxNodes: 10,
    textBudget: 1000,
  });

  assert.equal(overflowQuery.nodes.length, 1);
  assert.equal(overflowQuery._registryPruned, true);
  assert.equal(overflowQuery.registrySize, 4901);
});

test('content script evicts the oldest patches past MAX_PATCH_REGISTRY_SIZE', async (t) => {
  const harness = createChromeHarness();
  const styleValues = new Map();
  const target = {
    ...createFakeElement(),
    style: {
      /** @param {string} name */
      getPropertyValue(name) {
        return styleValues.get(name) ?? '';
      },
      /** @param {string} name @param {string} value */
      setProperty(name, value) {
        styleValues.set(name, value);
      },
      /** @param {string} name */
      removeProperty(name) {
        styleValues.delete(name);
      },
    },
  };
  const body = createFakeElement({
    tagName: 'body',
    children: [target],
  });
  const document = createDocumentHarness(body, { '#target': target });

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
  });

  const listener = harness.getListener();

  /**
   * @param {string} method
   * @param {Record<string, any>} params
   * @returns {Promise<any>}
   */
  function execute(method, params) {
    return new Promise((resolve) => {
      assert.equal(
        listener(
          {
            type: 'bridge.execute',
            method,
            params,
          },
          /** @type {chrome.runtime.MessageSender} */ ({}),
          resolve
        ),
        true
      );
    });
  }

  for (let index = 0; index <= 2000; index++) {
    const response = await execute('patch.apply_styles', {
      patchId: `patch-${index}`,
      target: { selector: '#target' },
      declarations: { color: String(index) },
    });
    assert.equal(response.patchId, `patch-${index}`);
    assert.equal(response.applied, true);
  }

  const patches = await execute('patch.list', {});
  assert.equal(patches.length, 2000);
  assert.equal(patches[0].patchId, 'patch-1');
  assert.equal(patches.at(-1).patchId, 'patch-2000');

  const evicted = await execute('patch.rollback', { patchId: 'patch-0' });
  const retained = await execute('patch.rollback', { patchId: 'patch-2000' });

  assert.deepEqual(evicted, { patchId: 'patch-0', rolledBack: false });
  assert.deepEqual(retained, { patchId: 'patch-2000', rolledBack: true });
});

test('content script patch.apply_styles rollbacks restore prior inline style values', async (t) => {
  const harness = createChromeHarness();
  const styleValues = new Map([['color', 'blue']]);
  const target = {
    ...createFakeElement(),
    style: {
      /** @param {string} name */
      getPropertyValue(name) {
        return styleValues.get(name) ?? '';
      },
      /** @param {string} name @param {string} value */
      setProperty(name, value) {
        styleValues.set(name, value);
      },
      /** @param {string} name */
      removeProperty(name) {
        styleValues.delete(name);
      },
    },
  };
  const body = createFakeElement({
    tagName: 'body',
    children: [target],
  });
  const document = createDocumentHarness(body, { '#target': target });

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
  });

  const listener = harness.getListener();

  /**
   * @param {string} method
   * @param {Record<string, any>} params
   * @returns {Promise<any>}
   */
  function execute(method, params) {
    return new Promise((resolve) => {
      assert.equal(
        listener(
          {
            type: 'bridge.execute',
            method,
            params,
          },
          /** @type {chrome.runtime.MessageSender} */ ({}),
          resolve
        ),
        true
      );
    });
  }

  const applyResult = await execute('patch.apply_styles', {
    patchId: 'patch-style-roundtrip',
    target: { selector: '#target' },
    declarations: {
      color: 'red',
      border: '1px solid black',
    },
  });

  assert.deepEqual(applyResult, {
    patchId: 'patch-style-roundtrip',
    applied: true,
  });
  assert.equal(styleValues.get('color'), 'red');
  assert.equal(styleValues.get('border'), '1px solid black');

  const rollbackResult = await execute('patch.rollback', {
    patchId: 'patch-style-roundtrip',
  });

  assert.deepEqual(rollbackResult, {
    patchId: 'patch-style-roundtrip',
    rolledBack: true,
  });
  assert.equal(styleValues.get('color'), 'blue');
  assert.equal(styleValues.has('border'), false);
  assert.deepEqual(await execute('patch.list', {}), []);
});

test('content script input.click returns click metadata and stale element refs fail after detachment', async (t) => {
  const harness = createChromeHarness();
  const inputs = installInputDomGlobals(t);
  const checkbox = inputs.createCheckbox();
  const body = inputs.createBody([checkbox]);
  const attachedElements = new Set([body, checkbox]);
  const baseDocument = createDocumentHarness(body, {
    '#checkbox': checkbox,
  });
  const document = {
    ...baseDocument,
    activeElement: null,
    /** @param {any} element */
    contains(element) {
      return attachedElements.has(element);
    },
  };

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
  });

  const listener = harness.getListener();

  /**
   * @param {string} method
   * @param {Record<string, any>} params
   * @returns {Promise<any>}
   */
  function execute(method, params) {
    return new Promise((resolve) => {
      assert.equal(
        listener(
          {
            type: 'bridge.execute',
            method,
            params,
          },
          /** @type {chrome.runtime.MessageSender} */ ({}),
          resolve
        ),
        true
      );
    });
  }

  const clickResult = await execute('input.click', {
    target: { selector: '#checkbox' },
  });

  assert.deepEqual(clickResult, {
    elementRef: clickResult.elementRef,
    clicked: true,
    button: 'left',
    clickCount: 1,
  });
  assert.equal(typeof clickResult.elementRef, 'string');
  assert.equal(document.activeElement, checkbox);
  assert.deepEqual(checkbox.eventLog, [
    'mousemove',
    'mousedown',
    'mouseup',
    'click',
    'input',
    'change',
  ]);

  attachedElements.delete(checkbox);

  assert.deepEqual(
    await execute('input.click', { target: { elementRef: clickResult.elementRef } }),
    {
      error: 'Element reference is stale.',
    }
  );
});

test('content script input.type types into text inputs and contenteditable regions', async (t) => {
  const harness = createChromeHarness();
  const inputs = installInputDomGlobals(t);
  const textInput = inputs.createTextInput();
  const editable = inputs.createContentEditable();
  const body = inputs.createBody([textInput, editable]);
  const document = createDocumentHarness(body, {
    '#text-input': textInput,
    '#editable': editable,
  });
  document.activeElement = null;

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
  });

  const listener = harness.getListener();

  /**
   * @param {string} method
   * @param {Record<string, any>} params
   * @returns {Promise<any>}
   */
  function execute(method, params) {
    return new Promise((resolve) => {
      assert.equal(
        listener(
          {
            type: 'bridge.execute',
            method,
            params,
          },
          /** @type {chrome.runtime.MessageSender} */ ({}),
          resolve
        ),
        true
      );
    });
  }

  const inputResult = await execute('input.type', {
    target: { selector: '#text-input' },
    text: 'Bridge',
  });
  const editableResult = await execute('input.type', {
    target: { selector: '#editable' },
    text: 'Panel',
  });

  assert.deepEqual(inputResult, {
    elementRef: inputResult.elementRef,
    typed: 6,
    value: 'Bridge',
  });
  assert.equal(typeof inputResult.elementRef, 'string');
  assert.equal(textInput.value, 'Bridge');
  assert.deepEqual(textInput.eventLog.slice(0, 4), ['keydown', 'beforeinput', 'input', 'keyup']);

  assert.deepEqual(editableResult, {
    elementRef: editableResult.elementRef,
    typed: 5,
    value: 'Panel',
  });
  assert.equal(typeof editableResult.elementRef, 'string');
  assert.equal(editable.textContent, 'Panel');
  assert.deepEqual(editable.eventLog.slice(0, 4), ['keydown', 'beforeinput', 'input', 'keyup']);
});

test('content script input.set_checked and input.select_option update state and emit events', async (t) => {
  const harness = createChromeHarness();
  const inputs = installInputDomGlobals(t);
  const checkbox = inputs.createCheckbox();
  const optionAlpha = inputs.createOption({ value: 'alpha', selected: true });
  const optionBeta = inputs.createOption({ value: 'beta' });
  const select = inputs.createSelect([optionAlpha, optionBeta]);
  const body = inputs.createBody([checkbox, select]);
  const document = createDocumentHarness(body, {
    '#checkbox': checkbox,
    '#select': select,
  });
  document.activeElement = null;

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
  });

  const listener = harness.getListener();

  /**
   * @param {string} method
   * @param {Record<string, any>} params
   * @returns {Promise<any>}
   */
  function execute(method, params) {
    return new Promise((resolve) => {
      assert.equal(
        listener(
          {
            type: 'bridge.execute',
            method,
            params,
          },
          /** @type {chrome.runtime.MessageSender} */ ({}),
          resolve
        ),
        true
      );
    });
  }

  const checkedResult = await execute('input.set_checked', {
    target: { selector: '#checkbox' },
    checked: true,
  });
  const selectedResult = await execute('input.select_option', {
    target: { selector: '#select' },
    values: ['beta'],
  });

  assert.deepEqual(checkedResult, {
    elementRef: checkedResult.elementRef,
    checked: true,
    changed: true,
    type: 'checkbox',
  });
  assert.equal(typeof checkedResult.elementRef, 'string');
  assert.deepEqual(checkbox.eventLog, ['click', 'input', 'change']);
  assert.equal(checkbox.checked, true);

  assert.deepEqual(selectedResult, {
    elementRef: selectedResult.elementRef,
    changed: true,
    multiple: false,
    selectedValues: ['beta'],
  });
  assert.equal(typeof selectedResult.elementRef, 'string');
  assert.deepEqual(select.eventLog, ['input', 'change']);
  assert.equal(optionAlpha.selected, false);
  assert.equal(optionBeta.selected, true);
});

test('content script dispatches dom describe, style, and layout reads', async (t) => {
  const saved = captureGlobals(['Node']);
  t.after(() => restoreGlobals(saved));
  globalThis.Node = /** @type {typeof Node} */ (/** @type {unknown} */ ({ TEXT_NODE: 3 }));

  const harness = createChromeHarness();
  const target = createFakeElement({
    tagName: 'button',
    textContent: 'Click me',
    innerHTML: '<span>Click me</span>',
    attributes: {
      id: 'target',
      class: 'primary active',
      style: 'color:red',
      'aria-label': 'Press me',
    },
    rect: { x: 10, y: 20, width: 30, height: 40 },
  });
  const body = createFakeElement({
    tagName: 'body',
    children: [target],
  });
  const document = createDocumentHarness(
    body,
    {
      '#target': target,
    },
    {
      elementFromPoint() {
        return target;
      },
    }
  );
  const window = /** @type {Window & typeof globalThis} */ (
    /** @type {unknown} */ ({
      scrollX: 3,
      scrollY: 4,
      getComputedStyle() {
        return {
          /** @param {string} property */
          getPropertyValue(property) {
            return property === 'color' ? 'rgb(255, 0, 0)' : 'block';
          },
        };
      },
    })
  );

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
    window,
  });

  const listener = harness.getListener();
  const described = await executeBridgeMethod(listener, 'dom.describe', {
    target: { selector: '#target' },
  });
  const text = await executeBridgeMethod(listener, 'dom.get_text', {
    target: { selector: '#target' },
    textBudget: 20,
  });
  const attrs = await executeBridgeMethod(listener, 'dom.get_attributes', {
    target: { selector: '#target' },
    attributes: ['id', 'class', 'style'],
  });
  const box = await executeBridgeMethod(listener, 'layout.get_box_model', {
    target: { selector: '#target' },
  });
  const hit = await executeBridgeMethod(listener, 'layout.hit_test', { x: 15, y: 25 });
  const computed = await executeBridgeMethod(listener, 'styles.get_computed', {
    target: { selector: '#target' },
    properties: ['display', 'color'],
  });
  const matched = await executeBridgeMethod(listener, 'styles.get_matched_rules', {
    target: { selector: '#target' },
  });
  const missingText = await executeBridgeMethod(listener, 'dom.find_by_text', {});
  const missingRole = await executeBridgeMethod(listener, 'dom.find_by_role', {});

  assert.deepEqual(described, {
    elementRef: described.elementRef,
    tag: 'button',
    text: {
      value: 'Press me | Click me',
      truncated: false,
      omitted: 0,
    },
    bbox: { x: 13, y: 24, width: 30, height: 40 },
  });
  assert.equal(typeof described.elementRef, 'string');
  assert.deepEqual(text, {
    value: 'Click me',
    truncated: false,
    omitted: 0,
  });
  assert.deepEqual(attrs, {
    id: 'target',
    class: 'primary active',
    style: 'color:red',
  });
  assert.deepEqual(box, { x: 13, y: 24, width: 30, height: 40 });
  assert.deepEqual(hit, {
    elementRef: hit.elementRef,
    tag: 'button',
    role: null,
    name: 'Press me',
    textExcerpt: 'Press me | Click me',
    attrs: { id: 'target', class: 'primary active' },
    bbox: { x: 13, y: 24, width: 30, height: 40 },
  });
  assert.equal(typeof hit.elementRef, 'string');
  assert.deepEqual(computed, {
    display: 'block',
    color: 'rgb(255, 0, 0)',
  });
  assert.deepEqual(matched, {
    elementRef: matched.elementRef,
    classes: ['primary', 'active'],
    inlineStyle: 'color:red',
  });
  assert.equal(typeof matched.elementRef, 'string');
  assert.deepEqual(missingText, { error: 'text is required for dom.find_by_text' });
  assert.deepEqual(missingRole, { error: 'role is required for dom.find_by_role' });
});

test('content script dom.wait_for handles immediate matches, timeouts, and validation', async (t) => {
  const harness = createChromeHarness();

  await withDocument(
    `<!doctype html>
    <html>
      <body>
        <div id="ready">Ready now</div>
      </body>
    </html>`,
    async () => {
      await loadContentScript(t, {
        withHelpers: true,
        preserveDomGlobals: true,
        chrome: harness.chrome,
      });

      const listener = harness.getListener();
      const found = await executeBridgeMethod(listener, 'dom.wait_for', {
        selector: '#ready',
        text: 'ready',
        timeoutMs: 100,
      });
      const detached = await executeBridgeMethod(listener, 'dom.wait_for', {
        selector: '#missing',
        state: 'detached',
        text: 'missing',
        timeoutMs: 100,
      });
      const timeout = await executeBridgeMethod(listener, 'dom.wait_for', {
        selector: '#later',
        timeoutMs: 100,
      });
      const missingSelector = await executeBridgeMethod(listener, 'dom.wait_for', {
        text: 'missing',
      });

      assert.equal(found.found, true);
      assert.equal(typeof found.elementRef, 'string');
      assert.equal(found.duration, 0);
      assert.deepEqual(detached, {
        found: true,
        elementRef: null,
        duration: 0,
      });
      assert.equal(timeout.found, false);
      assert.equal(timeout.elementRef, null);
      assert.ok(timeout.duration >= 100);
      assert.deepEqual(missingSelector, { error: 'selector is required for dom.wait_for' });
    }
  );
});

test('content script patch operations verify and roll back DOM and style changes', async (t) => {
  const saved = captureGlobals(['getComputedStyle']);
  t.after(() => restoreGlobals(saved));

  const harness = createChromeHarness();
  const styleValues = new Map([['color', 'blue']]);
  const target = {
    ...createFakeElement({
      tagName: 'div',
      textContent: 'before',
      attributes: {
        id: 'target',
        class: 'initial',
        'data-state': 'old',
        'data-remove': 'present',
      },
    }),
    style: {
      /** @param {string} name */
      getPropertyValue(name) {
        return styleValues.get(name) ?? '';
      },
      /** @param {string} name @param {string} value */
      setProperty(name, value) {
        styleValues.set(name, value);
      },
      /** @param {string} name */
      removeProperty(name) {
        styleValues.delete(name);
      },
    },
  };
  globalThis.getComputedStyle = /** @type {typeof getComputedStyle} */ (
    /** @type {unknown} */ (
      (/** @type {any} */ element) => ({
        /** @param {string} property */
        getPropertyValue(property) {
          return property === 'color' && element === target
            ? (styleValues.get(property) ?? '')
            : '';
        },
      })
    )
  );

  const body = createFakeElement({
    tagName: 'body',
    children: [target],
  });
  const document = createDocumentHarness(body, { '#target': target });

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
  });

  const listener = harness.getListener();
  const stylePatch = await executeBridgeMethod(listener, 'patch.apply_styles', {
    patchId: 'style-1',
    target: { selector: '#target' },
    declarations: { color: 'red' },
    verify: true,
  });
  const textPatch = await executeBridgeMethod(listener, 'patch.apply_dom', {
    patchId: 'text-1',
    target: { selector: '#target' },
    operation: 'set_text',
    value: 'after',
    verify: true,
  });
  const setAttributePatch = await executeBridgeMethod(listener, 'patch.apply_dom', {
    patchId: 'attribute-1',
    target: { selector: '#target' },
    operation: 'set_attribute',
    name: 'data-added',
    value: 'fresh',
    verify: true,
  });
  const removeAttributePatch = await executeBridgeMethod(listener, 'patch.apply_dom', {
    patchId: 'attribute-2',
    target: { selector: '#target' },
    operation: 'remove_attribute',
    name: 'data-remove',
    verify: true,
  });
  const toggleClassPatch = await executeBridgeMethod(listener, 'patch.apply_dom', {
    patchId: 'class-1',
    target: { selector: '#target' },
    operation: 'toggle_class',
    value: 'active',
    verify: true,
  });

  assert.deepEqual(stylePatch, {
    patchId: 'style-1',
    applied: true,
    verified: { color: 'red' },
    elementRef: stylePatch.elementRef,
  });
  assert.equal(typeof stylePatch.elementRef, 'string');
  assert.deepEqual(textPatch, {
    patchId: 'text-1',
    applied: true,
    verified: { textContent: 'after' },
    elementRef: textPatch.elementRef,
  });
  assert.deepEqual(setAttributePatch, {
    patchId: 'attribute-1',
    applied: true,
    verified: { 'data-added': 'fresh' },
    elementRef: setAttributePatch.elementRef,
  });
  assert.deepEqual(removeAttributePatch, {
    patchId: 'attribute-2',
    applied: true,
    verified: { 'data-remove': null },
    elementRef: removeAttributePatch.elementRef,
  });
  assert.deepEqual(toggleClassPatch, {
    patchId: 'class-1',
    applied: true,
    verified: { classList: ['initial', 'active'] },
    elementRef: toggleClassPatch.elementRef,
  });
  assert.deepEqual(await executeBridgeMethod(listener, 'patch.rollback', { patchId: 'text-1' }), {
    patchId: 'text-1',
    rolledBack: true,
  });
  assert.equal(target.textContent, 'before');
  assert.deepEqual(
    await executeBridgeMethod(listener, 'patch.rollback', { patchId: 'attribute-1' }),
    {
      patchId: 'attribute-1',
      rolledBack: true,
    }
  );
  assert.equal(target.getAttribute('data-added'), null);
  assert.deepEqual(
    await executeBridgeMethod(listener, 'patch.rollback', { patchId: 'attribute-2' }),
    {
      patchId: 'attribute-2',
      rolledBack: true,
    }
  );
  assert.equal(target.getAttribute('data-remove'), 'present');
  assert.deepEqual(await executeBridgeMethod(listener, 'patch.rollback', { patchId: 'class-1' }), {
    patchId: 'class-1',
    rolledBack: true,
  });
  assert.deepEqual([...target.classList], ['initial']);
  assert.deepEqual(await executeBridgeMethod(listener, 'patch.rollback', { patchId: 'style-1' }), {
    patchId: 'style-1',
    rolledBack: true,
  });
  assert.equal(styleValues.get('color'), 'blue');
  assert.deepEqual(await executeBridgeMethod(listener, 'patch.list', {}), []);
  assert.deepEqual(await executeBridgeMethod(listener, 'patch.commit_session_baseline', {}), {
    committed: true,
  });
});

test('content script page state, storage, and screenshot helpers report page context', async (t) => {
  const saved = captureGlobals(['localStorage', 'sessionStorage']);
  t.after(() => restoreGlobals(saved));

  const harness = createChromeHarness();

  /**
   * @param {Record<string, string>} entries
   * @returns {{ length: number, key: (index: number) => string | null, getItem: (key: string) => string | null }}
   */
  function createStorage(entries) {
    const keys = Object.keys(entries);
    return {
      get length() {
        return keys.length;
      },
      /** @param {number} index */
      key(index) {
        return keys[index] ?? null;
      },
      /** @param {string} key */
      getItem(key) {
        return Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : null;
      },
    };
  }

  globalThis.localStorage = /** @type {Storage} */ (
    /** @type {unknown} */ (createStorage({ short: 'ok', long: 'x'.repeat(510) }))
  );
  globalThis.sessionStorage = /** @type {Storage} */ (
    /** @type {unknown} */ (createStorage({ token: 'abc123' }))
  );

  await withDocument(
    `<!doctype html>
    <html>
      <head>
        <title>Bridge Title</title>
        <style id="tailwind-theme"></style>
      </head>
      <body>
        <button id="shot" class="flex bg-blue-500">Capture target</button>
      </body>
    </html>`,
    async ({ window, document }) => {
      const target = document.getElementById('shot');
      assert.ok(target);

      Reflect.set(document, 'title', 'Bridge Title');
      Reflect.set(window, 'location', {
        href: 'https://example.com/path',
        origin: 'https://example.com',
      });
      Reflect.set(window, 'innerWidth', 400);
      Reflect.set(window, 'innerHeight', 300);
      Reflect.set(window, 'devicePixelRatio', 2);
      Reflect.set(window, 'scrollX', 12);
      Reflect.set(window, 'scrollY', 34);
      Reflect.set(document, 'activeElement', target);
      Reflect.set(document, 'hasFocus', () => false);
      Reflect.set(document, 'getSelection', () => ({ toString: () => '  Selected text  ' }));
      Reflect.set(document, 'scrollingElement', document.documentElement);
      Reflect.set(document.documentElement, 'scrollWidth', 18000);
      Reflect.set(document.documentElement, 'scrollHeight', 17000);
      Reflect.set(target, 'scrollIntoView', () => {});
      Reflect.set(target, 'getBoundingClientRect', () => ({
        x: 50,
        y: 60,
        width: 200,
        height: 150,
      }));

      await loadContentScript(t, {
        withHelpers: true,
        preserveDomGlobals: true,
        chrome: harness.chrome,
      });

      const listener = harness.getListener();
      const state = await executeBridgeMethod(listener, 'page.get_state', {});
      const local = await executeBridgeMethod(listener, 'page.get_storage', {});
      const session = await executeBridgeMethod(listener, 'page.get_storage', {
        type: 'session',
        keys: ['token'],
      });
      const elementRect = await executeBridgeMethod(listener, 'screenshot.capture_element', {
        target: { selector: '#shot' },
      });
      const fullPage = await executeBridgeMethod(listener, 'screenshot.capture_full_page', {});

      assert.equal(state.error, undefined);
      assert.equal(state.title, 'Bridge Title');
      assert.equal(state.focused, false);
      assert.equal(state.viewport.width, 400);
      assert.equal(state.viewport.height, 300);
      assert.equal(state.viewport.devicePixelRatio, 2);
      assert.equal(state.scroll.x, 12);
      assert.equal(state.scroll.y, 34);
      assert.equal(state.scroll.maxX, 17600);
      assert.equal(state.scroll.maxY, 16700);
      assert.equal(state.activeElement.tag, 'button');
      assert.equal(state.selection.value, 'Selected text');
      assert.equal(state.hints.tailwind, true);
      assert.equal(local.type, 'local');
      assert.equal(local.count, 2);
      assert.equal(local.entries.short, 'ok');
      assert.equal(local.entries.long.length, 501);
      assert.equal(local.entries.long.endsWith('…'), true);
      assert.deepEqual(session, {
        type: 'session',
        entries: { token: 'abc123' },
        count: 1,
      });
      assert.deepEqual(elementRect, { x: 50, y: 60, width: 200, height: 150, scale: 2 });
      assert.deepEqual(fullPage, {
        scrollWidth: 16384,
        scrollHeight: 16384,
        devicePixelRatio: 2,
      });
    }
  );
});

test('content script input focus, key handling, and scrolling cover form and viewport branches', async (t) => {
  const harness = createChromeHarness();
  const inputs = installInputDomGlobals(t);
  const textInput = inputs.createTextInput({ value: 'abc' });
  const textarea = inputs.createTextArea({ value: 'wxyz' });
  textarea.selectionStart = 1;
  textarea.selectionEnd = 2;
  const button = inputs.createButton({ textContent: 'Submit now' });
  const form = inputs.createForm([textInput, button]);
  const scrollable = inputs.createBody([]);
  const body = inputs.createBody([form, textarea, scrollable]);
  const document = createDocumentHarness(body, {
    '#text-input': textInput,
    '#textarea': textarea,
    '#button': button,
    '#scrollable': scrollable,
  });
  document.activeElement = null;

  const windowState = {
    scrollX: 0,
    scrollY: 0,
  };
  const window = /** @type {Window & typeof globalThis} */ (
    /** @type {unknown} */ ({
      get scrollX() {
        return windowState.scrollX;
      },
      get scrollY() {
        return windowState.scrollY;
      },
      /** @param {{ top?: number, left?: number }} options */
      scrollTo(options) {
        windowState.scrollY = options.top ?? windowState.scrollY;
        windowState.scrollX = options.left ?? windowState.scrollX;
      },
      /** @param {{ top?: number, left?: number }} options */
      scrollBy(options) {
        windowState.scrollY += options.top ?? 0;
        windowState.scrollX += options.left ?? 0;
      },
    })
  );

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
    window,
  });

  const listener = harness.getListener();
  const focusResult = await executeBridgeMethod(listener, 'input.focus', {
    target: { selector: '#button' },
  });
  const backspaceResult = await executeBridgeMethod(listener, 'input.press_key', {
    target: { selector: '#text-input' },
    key: 'Backspace',
  });
  const enterResult = await executeBridgeMethod(listener, 'input.press_key', {
    target: { selector: '#text-input' },
    key: 'Enter',
  });
  const deleteResult = await executeBridgeMethod(listener, 'input.press_key', {
    target: { selector: '#textarea' },
    key: 'Delete',
  });
  const buttonEnterResult = await executeBridgeMethod(listener, 'input.press_key', {
    target: { selector: '#button' },
    key: 'Enter',
  });
  const scrollIntoViewResult = await executeBridgeMethod(listener, 'input.scroll_into_view', {
    target: { selector: '#button' },
  });
  const targetScroll = await executeBridgeMethod(listener, 'viewport.scroll', {
    target: { selector: '#scrollable' },
    top: 10,
    left: 5,
  });
  const targetScrollRelative = await executeBridgeMethod(listener, 'viewport.scroll', {
    target: { selector: '#scrollable' },
    top: 2,
    left: 3,
    relative: true,
    behavior: 'smooth',
  });
  const windowScroll = await executeBridgeMethod(listener, 'viewport.scroll', {
    top: 20,
    left: 15,
  });
  const windowScrollRelative = await executeBridgeMethod(listener, 'viewport.scroll', {
    top: 4,
    left: 6,
    relative: true,
  });

  assert.deepEqual(focusResult, {
    elementRef: focusResult.elementRef,
    focused: true,
    tag: 'button',
  });
  assert.equal(document.activeElement, button);
  assert.deepEqual(backspaceResult, {
    elementRef: backspaceResult.elementRef,
    key: 'Backspace',
    handled: true,
  });
  assert.equal(textInput.value, 'ab');
  assert.deepEqual(enterResult, {
    elementRef: enterResult.elementRef,
    key: 'Enter',
    handled: true,
  });
  assert.equal(form.submitCount, 1);
  assert.equal(textInput.eventLog.includes('change'), true);
  assert.deepEqual(deleteResult, {
    elementRef: deleteResult.elementRef,
    key: 'Delete',
    handled: true,
  });
  assert.equal(textarea.value, 'wyz');
  assert.deepEqual(buttonEnterResult, {
    elementRef: buttonEnterResult.elementRef,
    key: 'Enter',
    handled: true,
  });
  assert.equal(button.eventLog.includes('click'), true);
  assert.deepEqual(scrollIntoViewResult, {
    elementRef: scrollIntoViewResult.elementRef,
    scrolled: true,
  });
  assert.deepEqual(targetScroll, {
    scrolled: true,
    target: targetScroll.target,
    x: 5,
    y: 10,
    top: 10,
    left: 5,
    behavior: 'auto',
    relative: false,
  });
  assert.deepEqual(targetScrollRelative, {
    scrolled: true,
    target: targetScrollRelative.target,
    x: 8,
    y: 12,
    top: 12,
    left: 8,
    behavior: 'smooth',
    relative: true,
  });
  assert.deepEqual(windowScroll, {
    scrolled: true,
    target: 'window',
    x: 15,
    y: 20,
    top: 20,
    left: 15,
    behavior: 'auto',
    relative: false,
  });
  assert.deepEqual(windowScrollRelative, {
    scrolled: true,
    target: 'window',
    x: 21,
    y: 24,
    top: 24,
    left: 21,
    behavior: 'auto',
    relative: true,
  });
});

test('content script input hover, drag, alternative clicks, and multi-select cover extra interaction branches', async (t) => {
  const harness = createChromeHarness();
  const inputs = installInputDomGlobals(t);
  const multiSelect = inputs.createSelect(
    [
      inputs.createOption({ value: 'alpha', selected: true }),
      inputs.createOption({ value: 'beta' }),
      inputs.createOption({ value: 'gamma' }),
    ],
    { multiple: true }
  );
  const radio = inputs.createRadio({ checked: true });
  const hoverTarget = inputs.createButton({ textContent: 'Hover me' });
  const clickTarget = inputs.createButton({ textContent: 'Context menu' });
  const source = inputs.createButton({ textContent: 'Drag source' });
  const destination = inputs.createButton({ textContent: 'Drop target' });
  const body = inputs.createBody([
    multiSelect,
    radio,
    hoverTarget,
    clickTarget,
    source,
    destination,
  ]);
  const document = createDocumentHarness(body, {
    '#select': multiSelect,
    '#radio': radio,
    '#hover': hoverTarget,
    '#click': clickTarget,
    '#source': source,
    '#destination': destination,
  });

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
  });

  const listener = harness.getListener();
  const hoverResult = await executeBridgeMethod(listener, 'input.hover', {
    target: { selector: '#hover' },
    duration: 1,
    modifiers: ['Shift'],
  });
  const dragResult = await executeBridgeMethod(listener, 'input.drag', {
    source: { selector: '#source' },
    destination: { selector: '#destination' },
    offsetX: 4,
    offsetY: 6,
  });
  const rightClickResult = await executeBridgeMethod(listener, 'input.click', {
    target: { selector: '#click' },
    button: 'right',
  });
  const middleClickResult = await executeBridgeMethod(listener, 'input.click', {
    target: { selector: '#click' },
    button: 'middle',
  });
  const selectedResult = await executeBridgeMethod(listener, 'input.select_option', {
    target: { selector: '#select' },
    values: ['beta', 'gamma'],
  });
  const missingOption = await executeBridgeMethod(listener, 'input.select_option', {
    target: { selector: '#select' },
    values: ['missing'],
  });
  const radioError = await executeBridgeMethod(listener, 'input.set_checked', {
    target: { selector: '#radio' },
    checked: false,
  });

  assert.deepEqual(hoverResult, {
    elementRef: hoverResult.elementRef,
    hovered: true,
  });
  assert.equal(typeof hoverResult.elementRef, 'string');
  assert.deepEqual(hoverTarget.eventLog, ['mouseenter', 'mouseover', 'mousemove']);
  assert.deepEqual(dragResult, {
    sourceRef: dragResult.sourceRef,
    destinationRef: dragResult.destinationRef,
    dragged: true,
  });
  assert.equal(source.eventLog.includes('dragstart'), true);
  assert.equal(source.eventLog.includes('dragend'), true);
  assert.equal(destination.eventLog.includes('drop'), true);
  assert.deepEqual(rightClickResult, {
    elementRef: rightClickResult.elementRef,
    clicked: true,
    button: 'right',
    clickCount: 1,
  });
  assert.deepEqual(middleClickResult, {
    elementRef: middleClickResult.elementRef,
    clicked: true,
    button: 'middle',
    clickCount: 1,
  });
  assert.equal(clickTarget.eventLog.includes('contextmenu'), true);
  assert.equal(clickTarget.eventLog.includes('auxclick'), true);
  assert.deepEqual(selectedResult, {
    elementRef: selectedResult.elementRef,
    changed: true,
    multiple: true,
    selectedValues: ['beta', 'gamma'],
  });
  assert.deepEqual(multiSelect.eventLog, ['input', 'change']);
  assert.deepEqual(missingOption, { error: 'No matching option found.' });
  assert.deepEqual(radioError, { error: 'Radio inputs cannot be unchecked directly.' });
});

test('content script reports unsupported execute methods as errors', async (t) => {
  const harness = createChromeHarness();
  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
  });

  /** @type {unknown[]} */
  const responses = [];
  const listener = harness.getListener();

  assert.equal(
    listener(
      {
        type: 'bridge.execute',
        method: 'navigation.reload',
        params: {},
      },
      /** @type {chrome.runtime.MessageSender} */ ({}),
      (response) => responses.push(response)
    ),
    true
  );

  assert.deepEqual(responses, [{ error: 'Unsupported content-script method navigation.reload' }]);
});
