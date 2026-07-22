import test from 'node:test';
import assert from 'node:assert/strict';

import { withDocument } from '../../../tests/_helpers/dom.ts';

const MISSING = Symbol('missing');

type BridgeSendResponse = (response: unknown) => void;
type BridgeMessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: BridgeSendResponse
) => boolean;
type ChromeHarness = {
  chrome: {
    runtime: {
      onMessage: {
        addListener: (callback: BridgeMessageListener) => void;
      };
    };
  };
  getListener: () => BridgeMessageListener;
};
type FakeClassList = {
  contains: (value: string) => boolean;
  toggle: (value: string) => boolean;
  [Symbol.iterator]: () => SetIterator<string>;
};
type FakeElementLike = {
  tagName: string;
  attributes?: Map<string, string>;
  children: FakeElementLike[];
  childNodes: Array<{ nodeType: number; textContent: string }>;
  childElementCount?: number;
  parentElement?: FakeElementLike | null;
  textContent: string;
  innerText?: string;
  innerHTML: string;
  outerHTML: string;
  eventLog?: string[];
  scrollTop?: number;
  scrollLeft?: number;
  classList?: FakeClassList;
  isContentEditable?: boolean;
  type?: string;
  checked?: boolean;
  value?: string;
  selectionStart?: number;
  selectionEnd?: number;
  submitCount?: number;
  options?: FakeOptionElement[];
  multiple?: boolean;
  selected?: boolean;
  label?: string;
  text?: string;
  style?: StyleMock;
  selectedOptions?: FakeOptionElement[];
  getAttribute: (name: string) => string | null;
  hasAttribute: (name: string) => boolean;
  setAttribute?: (name: string, value: string) => void;
  removeAttribute?: (name: string) => void;
  contains?: (node: unknown) => boolean;
  querySelector?: (selector: string) => FakeElementLike | null;
  closest?: (selector: string) => FakeElementLike | null;
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
  scrollIntoView?: () => void;
  scrollTo?: (options: ScrollOptionsLike) => void;
  scrollBy?: (options: ScrollOptionsLike) => void;
  focus?: () => void;
  dispatchEvent?: (event: FakeEventLike) => boolean;
  click?: () => void;
  setRangeText?: (replacement: string, start: number, end: number) => void;
};
type FakeOptionElement = FakeElementLike & {
  value: string;
  label: string;
  text: string;
  selected: boolean;
};
type FakeInputElement = FakeElementLike & {
  eventLog: string[];
  type: string;
  checked: boolean;
  value: string;
  selectionStart: number;
  selectionEnd: number;
  setRangeText: (replacement: string, start: number, end: number) => void;
};
type FakeTextAreaElement = FakeElementLike & {
  eventLog: string[];
  value: string;
  selectionStart: number;
  selectionEnd: number;
  setRangeText: (replacement: string, start: number, end: number) => void;
};
type FakeSelectElement = FakeElementLike & {
  eventLog: string[];
  options: FakeOptionElement[];
  multiple: boolean;
  selectedOptions: FakeOptionElement[];
  value: string;
};
type FakeButtonElement = FakeElementLike & { eventLog: string[]; type: string; click: () => void };
type FakeFormElement = FakeElementLike & { submitCount: number; requestSubmit: () => void };
type FakeHTMLElementLike = FakeElementLike & { eventLog: string[]; isContentEditable: boolean };
type FakeEventLike = { type: string; defaultPrevented: boolean; preventDefault: () => void };
type ScrollOptionsLike = { top?: number; left?: number; behavior?: string };
type StyleMock = {
  getPropertyValue: (name: string) => string;
  getPropertyPriority: (name: string) => string;
  setProperty: (name: string, value: string, priority?: string) => void;
  removeProperty: (name: string) => void;
};
type DocumentHarness = {
  body: FakeElementLike;
  documentElement: FakeElementLike;
  activeElement: FakeElementLike | null;
  contains: (element: unknown) => boolean;
  elementFromPoint: (x: number, y: number) => FakeElementLike | null;
  hasFocus: () => boolean;
  getSelection: () => { toString: () => string };
  querySelector: (selector: string) => FakeElementLike | null;
  querySelectorAll: (selector: string) => FakeElementLike[];
};
type InputDomGlobals = {
  createBody: (children?: FakeElementLike[]) => FakeHTMLElementLike;
  createCheckbox: (options?: { checked?: boolean }) => FakeInputElement;
  createRadio: (options?: { checked?: boolean }) => FakeInputElement;
  createTextInput: (options?: { value?: string }) => FakeInputElement;
  createTextArea: (options?: { value?: string }) => FakeTextAreaElement;
  createContentEditable: (options?: { textContent?: string }) => FakeHTMLElementLike;
  createButton: (options?: { type?: string; textContent?: string }) => FakeButtonElement;
  createForm: (children?: FakeElementLike[]) => FakeFormElement;
  createOption: (options: {
    value: string;
    label?: string;
    text?: string;
    selected?: boolean;
  }) => FakeOptionElement;
  createSelect: (
    options: FakeOptionElement[],
    config?: { multiple?: boolean }
  ) => FakeSelectElement;
};
type QueryNode = {
  elementRef: string;
  tag: string;
  textExcerpt?: string;
  attrs: Record<string, string | null>;
  name?: string | null;
};
type QueryResult = {
  nodes: QueryNode[];
  truncated?: boolean;
  registrySize?: number;
  _registryPruned?: boolean;
};
type FindResult = {
  found: boolean;
  count: number;
  nodes: QueryNode[];
  scanned: number;
  truncated: boolean;
  truncationReason: 'maxResults' | 'scanLimit' | null;
  error?: string;
};
type PatchResult = {
  patchId: string;
  applied?: boolean;
  rolledBack?: boolean;
  verified?: unknown;
  elementRef?: string;
};
type BridgeResult = Record<string, unknown>;
type PageStateResult = BridgeResult & {
  viewport: { width: number; height: number; devicePixelRatio: number };
  scroll: { x: number; y: number; maxX: number; maxY: number };
  activeElement: { tag: string };
  selection: { value: string };
  hints: { tailwind: boolean };
};
type StorageResult = BridgeResult & {
  entries: Record<string, string>;
};
type WaitResult = BridgeResult & { duration: number };
type PatchListEntry = { patchId: string };
type PatchListResult = PatchListEntry[];
type FakeStorage = Storage & {
  entries: Record<string, string>;
};

const EMPTY_SENDER = {} as chrome.runtime.MessageSender;

function expectRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

function expectQueryResult(value: unknown): QueryResult {
  return expectRecord(value) as QueryResult;
}

function expectFindResult(value: unknown): FindResult {
  return expectRecord(value) as FindResult;
}

function expectPatchResult(value: unknown): PatchResult {
  return expectRecord(value) as PatchResult;
}

function withoutInputMetadata(value: BridgeResult): BridgeResult {
  const { resolution, execution, ...result } = value;
  assert.equal(typeof resolution, 'object');
  assert.equal((execution as { actualMode?: unknown })?.actualMode, 'dom');
  assert.equal((execution as { debuggerUsed?: unknown })?.debuggerUsed, false);
  return result;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

async function importFresh(relativePath: string): Promise<void> {
  await import(
    `${new URL(relativePath, import.meta.url).href}?case=${Date.now()}-${Math.random()}`
  );
}

function captureGlobals(keys: string[]): Map<string, unknown> {
  const saved = new Map();
  for (const key of keys) {
    saved.set(
      key,
      Object.prototype.hasOwnProperty.call(globalThis, key) ? Reflect.get(globalThis, key) : MISSING
    );
  }
  return saved;
}

function restoreGlobals(saved: Map<string, unknown>): void {
  for (const [key, value] of saved.entries()) {
    if (value === MISSING) {
      Reflect.deleteProperty(globalThis, key);
    } else {
      Reflect.set(globalThis, key, value);
    }
  }
}

function createChromeHarness(): ChromeHarness {
  let listener: BridgeMessageListener | null = null;

  return {
    chrome: {
      runtime: {
        onMessage: {
          addListener(callback: BridgeMessageListener) {
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

async function loadContentScript(
  t: import('node:test').TestContext,
  options: {
    withHelpers?: boolean;
    preserveDomGlobals?: boolean;
    chrome?: unknown;
    document?: unknown;
    window?: unknown;
  } = {}
): Promise<void> {
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

function createFakeElement(
  options: {
    tagName?: string;
    textContent?: string;
    innerHTML?: string;
    outerHTML?: string;
    attributes?: Record<string, string>;
    children?: FakeElementLike[];
    rect?: { x?: number; y?: number; left?: number; top?: number; width?: number; height?: number };
  } = {}
): FakeElementLike {
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
    contains(value: string) {
      return classNames.has(value);
    },
    toggle(value: string) {
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
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
    hasAttribute(name: string) {
      return attributes.has(name);
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, String(value));
      if (name === 'class') {
        classNames.clear();
        for (const token of String(value).split(/\s+/).filter(Boolean)) {
          classNames.add(token);
        }
      }
    },
    removeAttribute(name: string) {
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

function createDocumentHarness(
  body: FakeElementLike,
  selectors: Record<string, FakeElementLike | FakeElementLike[]> = {},
  overrides: Partial<DocumentHarness> = {}
): DocumentHarness {
  const elements = new Set<FakeElementLike>();
  const orderedElements: FakeElementLike[] = [];

  function visit(element: FakeElementLike | null | undefined): void {
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

  const documentHarness = {
    body,
    documentElement: body,
    activeElement: null,
    contains(element: unknown) {
      return (
        typeof element === 'object' && element !== null && elements.has(element as FakeElementLike)
      );
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
    querySelector(selector: string) {
      if (selector === 'body') {
        return body;
      }
      const match = selectors[selector];
      return Array.isArray(match) ? (match[0] ?? null) : (match ?? null);
    },
    querySelectorAll(selector: string) {
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

function executeBridgeMethod(
  listener: BridgeMessageListener,
  method: string,
  params: Record<string, unknown>
): Promise<BridgeResult> {
  return new Promise((resolve) => {
    assert.equal(
      listener(
        {
          type: 'bridge.execute',
          method,
          params,
        },
        EMPTY_SENDER,
        (response) => resolve(expectRecord(response))
      ),
      true
    );
  });
}

function installInputDomGlobals(t: import('node:test').TestContext): InputDomGlobals {
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

  function matchesSelector(element: unknown, selector: string): boolean {
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

  function findFirstMatchingDescendant(
    root: FakeElementLike,
    selectorText: string
  ): FakeElementLike | null {
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
    type: string;
    defaultPrevented: boolean;

    constructor(type: string, options: Record<string, unknown> = {}) {
      this.type = type;
      this.defaultPrevented = false;
      Object.assign(this, options);
    }

    preventDefault(): void {
      this.defaultPrevented = true;
    }
  }

  class FakeInputEvent extends FakeEvent {}

  class FakeKeyboardEvent extends FakeEvent {}

  class FakeMouseEvent extends FakeEvent {}

  class FakeDragEvent extends FakeMouseEvent {}

  class FakeDataTransfer {
    data: Map<string, string>;

    constructor() {
      this.data = new Map();
    }

    setData(type: string, value: string): void {
      this.data.set(type, value);
    }

    getData(type: string): string {
      return this.data.get(type) ?? '';
    }
  }

  class FakeElement {
    tagName: string;
    attributes: Map<string, string>;
    children: FakeElementLike[];
    childNodes: Array<{ nodeType: number; textContent: string }>;
    parentElement: FakeElementLike | null;
    _textContent: string;
    _innerText: string;
    _innerHTML: string;
    outerHTML: string;
    eventLog: string[];
    scrollTop: number;
    scrollLeft: number;

    constructor(
      tagName: string,
      options: {
        attributes?: Record<string, string>;
        children?: FakeElementLike[];
        textContent?: string;
      } = {}
    ) {
      this.tagName = tagName.toUpperCase();
      this.attributes = new Map(Object.entries(options.attributes ?? {}));
      this.children = options.children ?? [];
      this.childNodes = [];
      this.parentElement = null;
      this._textContent = options.textContent ?? '';
      this._innerText = this._textContent;
      this._innerHTML = this._textContent;
      this.outerHTML = `<${tagName}>${this._innerHTML}</${tagName}>`;
      this.eventLog = [];
      this.scrollTop = 0;
      this.scrollLeft = 0;

      for (const child of this.children) {
        child.parentElement = this;
      }
    }

    get selectedOptions(): FakeOptionElement[] {
      return [];
    }

    getAttribute(name: string): string | null {
      return this.attributes.get(name) ?? null;
    }

    hasAttribute(name: string): boolean {
      return this.attributes.has(name);
    }

    get textContent() {
      return this._textContent;
    }

    set textContent(value: string) {
      this._textContent = String(value ?? '');
      this._innerText = this._textContent;
      this._innerHTML = this._textContent;
      this.outerHTML = `<${this.tagName.toLowerCase()}>${this._innerHTML}</${this.tagName.toLowerCase()}>`;
    }

    get innerText() {
      return this._innerText;
    }

    set innerText(value: string) {
      this.textContent = value;
    }

    get innerHTML() {
      return this._innerHTML;
    }

    set innerHTML(value: string) {
      this._innerHTML = String(value ?? '');
      this._textContent = this._innerHTML;
      this._innerText = this._innerHTML;
      this.outerHTML = `<${this.tagName.toLowerCase()}>${this._innerHTML}</${this.tagName.toLowerCase()}>`;
    }

    contains(node: unknown): boolean {
      if (node === this) {
        return true;
      }
      return this.children.some(
        (child) => typeof child.contains === 'function' && child.contains(node)
      );
    }

    querySelector(selector: string): FakeElementLike | null {
      return findFirstMatchingDescendant(this, selector);
    }

    closest(selector: string): FakeElementLike | null {
      let current = this.parentElement;
      while (current) {
        if (matchesSelector(current, selector)) {
          return current;
        }
        current = current.parentElement ?? null;
      }
      return null;
    }

    getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
      return { left: 0, top: 0, width: 10, height: 10 };
    }

    scrollIntoView(): void {}

    scrollTo(options: ScrollOptionsLike): void {
      this.scrollTop = options.top ?? this.scrollTop;
      this.scrollLeft = options.left ?? this.scrollLeft;
    }

    scrollBy(options: ScrollOptionsLike): void {
      this.scrollTop += options.top ?? 0;
      this.scrollLeft += options.left ?? 0;
    }

    focus(): void {
      if (globalThis.document) {
        Reflect.set(globalThis.document, 'activeElement', this);
      }
    }

    dispatchEvent(event: FakeEventLike): boolean {
      this.eventLog.push(event.type);
      return !event.defaultPrevented;
    }
  }

  class FakeHTMLElement extends FakeElement {
    isContentEditable = false;
  }

  class FakeHTMLButtonElement extends FakeHTMLElement {
    type: string;

    constructor(type = 'button') {
      super('button');
      this.type = type;
    }

    click(): void {
      this.dispatchEvent(new FakeMouseEvent('click', { bubbles: true, composed: true }));
    }
  }

  class FakeHTMLFormElement extends FakeHTMLElement {
    submitCount: number;

    constructor() {
      super('form');
      this.submitCount = 0;
    }

    requestSubmit(): void {
      this.submitCount += 1;
      this.dispatchEvent(new FakeEvent('submit', { bubbles: true, composed: true }));
    }
  }

  class FakeHTMLInputElement extends FakeHTMLElement {
    type: string;
    checked: boolean;
    value: string;
    selectionStart: number;
    selectionEnd: number;

    constructor(type: string) {
      super('input');
      this.type = type;
      this.checked = false;
      this.value = '';
      this.selectionStart = 0;
      this.selectionEnd = 0;
    }

    setRangeText(replacement: string, start: number, end: number): void {
      this.value = `${this.value.slice(0, start)}${replacement}${this.value.slice(end)}`;
      const cursor = start + replacement.length;
      this.selectionStart = cursor;
      this.selectionEnd = cursor;
    }

    click(): void {
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
    value: string;
    selectionStart: number;
    selectionEnd: number;

    constructor() {
      super('textarea');
      this.value = '';
      this.selectionStart = 0;
      this.selectionEnd = 0;
    }

    setRangeText(replacement: string, start: number, end: number): void {
      this.value = `${this.value.slice(0, start)}${replacement}${this.value.slice(end)}`;
      const cursor = start + replacement.length;
      this.selectionStart = cursor;
      this.selectionEnd = cursor;
    }
  }

  class FakeHTMLOptionElement extends FakeHTMLElement {
    value: string;
    label: string;
    text: string;
    selected: boolean;

    constructor(options: { value: string; label?: string; text?: string; selected?: boolean }) {
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
    options: FakeHTMLOptionElement[];
    multiple: boolean;

    constructor(options: FakeHTMLOptionElement[], config: { multiple?: boolean } = {}) {
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

    set value(nextValue: string) {
      let matched = false;
      for (const option of this.options) {
        const selected: boolean = !matched && option.value === nextValue;
        option.selected = selected;
        matched = matched || selected;
      }
    }
  }

  Reflect.set(globalThis, 'Element', FakeElement);
  Reflect.set(globalThis, 'HTMLElement', FakeHTMLElement);
  Reflect.set(globalThis, 'HTMLInputElement', FakeHTMLInputElement);
  Reflect.set(globalThis, 'HTMLTextAreaElement', FakeHTMLTextAreaElement);
  Reflect.set(globalThis, 'HTMLSelectElement', FakeHTMLSelectElement);
  Reflect.set(globalThis, 'HTMLOptionElement', FakeHTMLOptionElement);
  Reflect.set(globalThis, 'HTMLButtonElement', FakeHTMLButtonElement);
  Reflect.set(globalThis, 'HTMLFormElement', FakeHTMLFormElement);
  Reflect.set(globalThis, 'Event', FakeEvent);
  Reflect.set(globalThis, 'InputEvent', FakeInputEvent);
  Reflect.set(globalThis, 'KeyboardEvent', FakeKeyboardEvent);
  Reflect.set(globalThis, 'MouseEvent', FakeMouseEvent);
  Reflect.set(globalThis, 'DragEvent', FakeDragEvent);
  Reflect.set(globalThis, 'DataTransfer', FakeDataTransfer);

  return {
    createBody(children: FakeElementLike[] = []) {
      return new FakeHTMLElement('body', { children }) as FakeHTMLElementLike;
    },
    createCheckbox(options: { checked?: boolean } = {}) {
      const checkbox = new FakeHTMLInputElement('checkbox');
      checkbox.checked = options.checked === true;
      return checkbox as FakeInputElement;
    },
    createRadio(options: { checked?: boolean } = {}) {
      const radio = new FakeHTMLInputElement('radio');
      radio.checked = options.checked === true;
      return radio as FakeInputElement;
    },
    createTextInput(options: { value?: string } = {}) {
      const input = new FakeHTMLInputElement('text');
      input.value = options.value ?? '';
      input.selectionStart = input.value.length;
      input.selectionEnd = input.value.length;
      return input as FakeInputElement;
    },
    createTextArea(options: { value?: string } = {}) {
      const textarea = new FakeHTMLTextAreaElement();
      textarea.value = options.value ?? '';
      textarea.selectionStart = textarea.value.length;
      textarea.selectionEnd = textarea.value.length;
      return textarea as FakeTextAreaElement;
    },
    createContentEditable(options: { textContent?: string } = {}) {
      const editable = new FakeHTMLElement('div', {
        attributes: { contenteditable: 'true' },
        textContent: options.textContent ?? '',
      });
      editable.isContentEditable = true;
      return editable as FakeHTMLElementLike;
    },
    createButton(options: { type?: string; textContent?: string } = {}) {
      const button = new FakeHTMLButtonElement(options.type ?? 'button');
      button.textContent = options.textContent ?? '';
      return button as FakeButtonElement;
    },
    createForm(children: FakeElementLike[] = []) {
      const form = new FakeHTMLFormElement();
      form.children = children;
      for (const child of children) {
        child.parentElement = form;
      }
      return form as FakeFormElement;
    },
    createOption(options: { value: string; label?: string; text?: string; selected?: boolean }) {
      return new FakeHTMLOptionElement(options) as FakeOptionElement;
    },
    createSelect(options: FakeOptionElement[], config: { multiple?: boolean } = {}) {
      return new FakeHTMLSelectElement(
        options as FakeHTMLOptionElement[],
        config
      ) as FakeSelectElement;
    },
  };
}

test('content script skips initialization when Chrome runtime messaging is unavailable', async (t) => {
  const contentScriptGlobal = globalThis as typeof globalThis & {
    __chromeCodexBridgeContentScriptLoaded?: boolean;
  };

  await loadContentScript(t);

  assert.equal(contentScriptGlobal.__chromeCodexBridgeContentScriptLoaded, undefined);
});

test('content script registers a listener and answers bridge ping messages', async (t) => {
  const harness = createChromeHarness();
  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
  });

  const responses: unknown[] = [];
  const listener = harness.getListener();

  assert.equal(
    listener({ type: 'bridge.ping' }, EMPTY_SENDER, (response) => responses.push(response)),
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

  const responses: unknown[] = [];
  const listener = harness.getListener();

  assert.equal(
    listener(
      {
        type: 'bridge.execute',
        method: 'page.get_text',
        params: { textBudget: 50 },
      },
      EMPTY_SENDER,
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

  const responses: unknown[] = [];
  const listener = harness.getListener();

  assert.equal(
    listener(
      {
        type: 'bridge.execute',
        method: 'page.get_text',
        params: { textBudget: 5 },
      },
      EMPTY_SENDER,
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

  const responses: unknown[] = [];
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
      EMPTY_SENDER,
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

      function query(params: Record<string, unknown>): Promise<QueryResult> {
        return new Promise((resolve) => {
          assert.equal(
            listener(
              {
                type: 'bridge.execute',
                method: 'dom.query',
                params,
              },
              EMPTY_SENDER,
              (response) => resolve(expectQueryResult(response))
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
        scopedQuery.nodes.map((node) => ({ tag: node.tag, textExcerpt: node.textExcerpt })),
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
  Reflect.set(globalThis, 'Node', { TEXT_NODE: 3 });

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
    window: { scrollX: 0, scrollY: 0 },
  });

  const listener = harness.getListener();

  function execute(params: Record<string, unknown>): Promise<FindResult> {
    return new Promise((resolve) => {
      assert.equal(
        listener(
          {
            type: 'bridge.execute',
            method: 'dom.find_by_text',
            params,
          },
          EMPTY_SENDER,
          (response) => resolve(expectFindResult(response))
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
  const cappedMatches = await execute({
    selector: 'button',
    text: 'hello bridge',
    maxResults: 1,
  });

  assert.equal(allMatches.count, 2);
  assert.deepEqual(
    allMatches.nodes.map((node) => ({ id: node.attrs.id, textExcerpt: node.textExcerpt })),
    [
      { id: 'inside', textExcerpt: 'Hello Bridge' },
      { id: 'outside', textExcerpt: 'HELLO bridge' },
    ]
  );
  assert.equal(scopedMatches.count, 1);
  assert.deepEqual(
    scopedMatches.nodes.map((node) => ({ id: node.attrs.id, textExcerpt: node.textExcerpt })),
    [{ id: 'inside', textExcerpt: 'Hello Bridge' }]
  );
  assert.equal(allMatches.found, true);
  assert.equal(allMatches.scanned, 3);
  assert.equal(allMatches.truncated, false);
  assert.equal(cappedMatches.count, 1);
  assert.equal(cappedMatches.truncated, true);
  assert.equal(cappedMatches.truncationReason, 'maxResults');
});

test('content script dom.find_by_role matches explicit and implicit roles by accessible name', async (t) => {
  const saved = captureGlobals(['Node', 'CSS', 'HTMLInputElement']);
  t.after(() => restoreGlobals(saved));
  Reflect.set(globalThis, 'Node', { TEXT_NODE: 3 });
  Reflect.set(globalThis, 'CSS', {
    escape(value: string) {
      return value;
    },
  });
  Reflect.set(globalThis, 'HTMLInputElement', function FakeInputElement() {});

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
  const labelledMatch = createFakeElement({
    tagName: 'button',
    textContent: 'Use it',
    attributes: { id: 'labelled', 'aria-labelledby': 'label-one label-two' },
  });
  const labelOne = createFakeElement({
    tagName: 'span',
    textContent: 'Bridge',
    attributes: { id: 'label-one' },
  });
  const labelTwo = createFakeElement({
    tagName: 'span',
    textContent: 'external label',
    attributes: { id: 'label-two' },
  });
  const nameMiss = createFakeElement({
    tagName: 'button',
    textContent: 'Settings',
    attributes: { id: 'miss' },
  });
  const body = createFakeElement({
    tagName: 'body',
    children: [explicitMatch, implicitMatch, labelledMatch, labelOne, labelTwo, nameMiss],
  });
  const document = createDocumentHarness(body, {
    '[role="button"], button, input[type=button], input[type=submit], input[type=reset], input[type=image]':
      [explicitMatch, implicitMatch, labelledMatch, nameMiss],
    '#label-one': labelOne,
    '#label-two': labelTwo,
    '*': [explicitMatch, implicitMatch, labelledMatch, labelOne, labelTwo, nameMiss],
  });

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
    window: { scrollX: 0, scrollY: 0 },
  });

  const listener = harness.getListener();

  const matches = await new Promise<FindResult>((resolve) => {
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
        EMPTY_SENDER,
        (response) => resolve(expectFindResult(response))
      ),
      true
    );
  });
  const cappedMatches = await new Promise<FindResult>((resolve) => {
    listener(
      {
        type: 'bridge.execute',
        method: 'dom.find_by_role',
        params: { role: 'button', name: 'bridge', maxResults: 1 },
      },
      EMPTY_SENDER,
      (response) => resolve(expectFindResult(response))
    );
  });

  assert.equal(matches.error, undefined);

  assert.equal(matches.count, 3);
  assert.equal(matches.found, true);
  assert.equal(matches.scanned, 4);
  assert.equal(matches.truncated, false);
  assert.equal(cappedMatches.count, 1);
  assert.equal(cappedMatches.truncated, true);
  assert.equal(cappedMatches.truncationReason, 'maxResults');
  assert.deepEqual(
    matches.nodes.map((node) => ({
      tag: node.tag,
      id: node.attrs.id,
      role: node.attrs.role ?? null,
      name: node.name,
      textExcerpt: node.textExcerpt,
    })),
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
      {
        tag: 'button',
        id: 'labelled',
        role: null,
        name: null,
        textExcerpt: 'Use it',
      },
    ]
  );
});

test('content script dom.query works when randomUUID is unavailable', async (t) => {
  const saved = captureGlobals(['crypto']);
  t.after(() => restoreGlobals(saved));

  Reflect.set(globalThis, 'crypto', {
    getRandomValues(array: Uint8Array) {
      for (let index = 0; index < array.length; index += 1) {
        array[index] = index;
      }
      return array;
    },
  });

  const harness = createChromeHarness();
  await withDocument(
    '<!doctype html><html><body><main>HTTP page</main></body></html>',
    async () => {
      await loadContentScript(t, {
        withHelpers: true,
        preserveDomGlobals: true,
        chrome: harness.chrome,
      });

      const result = expectQueryResult(
        await executeBridgeMethod(harness.getListener(), 'dom.query', {
          selector: 'body',
          includeBbox: false,
          maxNodes: 1,
        })
      );

      assert.match(
        result.nodes[0].elementRef,
        /^el_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    }
  );
});

test('content script reuses the same elementRef for repeated dom.query calls', async (t) => {
  const saved = captureGlobals(['Node']);
  t.after(() => restoreGlobals(saved));
  Reflect.set(globalThis, 'Node', { TEXT_NODE: 3 });

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

  const responses: QueryResult[] = [];
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
    listener(message, EMPTY_SENDER, (response) => responses.push(expectQueryResult(response))),
    true
  );
  await flushMicrotasks();

  assert.equal(
    listener(message, EMPTY_SENDER, (response) => responses.push(expectQueryResult(response))),
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
  Reflect.set(globalThis, 'Node', { TEXT_NODE: 3 });

  const harness = createChromeHarness();
  const sections: Array<{ root: FakeElementLike; children: FakeElementLike[] }> = [];
  const selectors: Record<string, FakeElementLike | FakeElementLike[]> = {};
  const attachedElements = new Set<FakeElementLike>();

  for (let sectionIndex = 0; sectionIndex < 20; sectionIndex++) {
    const children: FakeElementLike[] = [];
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

  const overflowAttached = createFakeElement({
    tagName: 'section',
    textContent: 'overflow-attached-node',
    attributes: { id: 'overflow-attached' },
  });
  selectors['#overflow-attached'] = overflowAttached;
  attachedElements.add(overflowAttached);

  const overflowAfterDetach = createFakeElement({
    tagName: 'section',
    textContent: 'overflow-after-detach-node',
    attributes: { id: 'overflow-after-detach' },
  });
  selectors['#overflow-after-detach'] = overflowAfterDetach;
  attachedElements.add(overflowAfterDetach);

  const body = createFakeElement({
    tagName: 'body',
    children: [...sections.map((section) => section.root), overflowAttached, overflowAfterDetach],
  });
  attachedElements.add(body);

  const baseDocument = createDocumentHarness(body, selectors);
  const document = {
    ...baseDocument,
    contains(element: unknown) {
      return (
        typeof element === 'object' &&
        element !== null &&
        attachedElements.has(element as FakeElementLike)
      );
    },
  };

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
  });

  const listener = harness.getListener();

  function query(params: Record<string, unknown>): Promise<QueryResult> {
    return new Promise((resolve) => {
      assert.equal(
        listener(
          {
            type: 'bridge.execute',
            method: 'dom.query',
            params,
          },
          EMPTY_SENDER,
          (response) => resolve(expectQueryResult(response))
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

  const cappedQuery = await query({
    selector: '#overflow-attached',
    includeBbox: false,
    maxNodes: 10,
    textBudget: 1000,
  });

  assert.equal(cappedQuery.nodes.length, 1);
  assert.equal(cappedQuery._registryPruned, true);
  assert.equal(cappedQuery.registrySize, 5000);

  attachedElements.delete(sections[0].root);
  for (const detachedChild of sections[0].children) {
    attachedElements.delete(detachedChild);
  }

  const overflowQuery = await query({
    selector: '#overflow-after-detach',
    includeBbox: false,
    maxNodes: 10,
    textBudget: 1000,
  });

  assert.equal(overflowQuery.nodes.length, 1);
  assert.equal(overflowQuery._registryPruned, true);
  assert.equal(overflowQuery.registrySize, 4901);
});

test('content script rejects patches past MAX_PATCH_REGISTRY_SIZE without orphaning history', async (t) => {
  const harness = createChromeHarness();
  const styleValues = new Map<string, string>();
  const target = {
    ...createFakeElement(),
    style: {
      getPropertyValue(name: string) {
        return styleValues.get(name) ?? '';
      },
      getPropertyPriority() {
        return '';
      },
      setProperty(name: string, value: string) {
        styleValues.set(name, value);
      },
      removeProperty(name: string) {
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

  function execute(
    method: string,
    params: Record<string, unknown>
  ): Promise<PatchResult | PatchListResult> {
    return new Promise((resolve) => {
      assert.equal(
        listener(
          {
            type: 'bridge.execute',
            method,
            params,
          },
          EMPTY_SENDER,
          (response) => {
            resolve(
              Array.isArray(response) ? (response as PatchListResult) : expectPatchResult(response)
            );
          }
        ),
        true
      );
    });
  }

  for (let index = 0; index < 2000; index++) {
    const response = await execute('patch.apply_styles', {
      patchId: `patch-${index}`,
      target: { selector: '#target' },
      declarations: { color: String(index) },
    });
    const patchResponse = response as PatchResult;
    assert.equal(patchResponse.patchId, `patch-${index}`);
    assert.equal(patchResponse.applied, true);
  }

  const overflow = await executeBridgeMethod(listener, 'patch.apply_styles', {
    patchId: 'patch-2000',
    target: { selector: '#target' },
    declarations: { color: '2000' },
  });
  assert.deepEqual(overflow, {
    error: 'Patch registry is full. Roll back or commit active patches before applying more.',
  });

  const patches = await execute('patch.list', {});
  assert.ok(Array.isArray(patches));
  assert.equal(patches.length, 2000);
  assert.equal(patches[0]?.patchId, 'patch-0');
  assert.equal(patches.at(-1)?.patchId, 'patch-1999');

  const oldest = await execute('patch.rollback', { patchId: 'patch-0' });
  const newest = await execute('patch.rollback', { patchId: 'patch-1999' });

  assert.deepEqual(oldest, { patchId: 'patch-0', rolledBack: true });
  assert.deepEqual(newest, { patchId: 'patch-1999', rolledBack: true });
});

test('content script patch.apply_styles rollbacks restore prior inline style values', async (t) => {
  const harness = createChromeHarness();
  const styleValues = new Map<string, string>([['color', 'blue']]);
  const stylePriorities = new Map<string, string>([['color', 'important']]);
  const target = {
    ...createFakeElement(),
    style: {
      getPropertyValue(name: string) {
        return styleValues.get(name) ?? '';
      },
      getPropertyPriority(name: string) {
        return stylePriorities.get(name) ?? '';
      },
      setProperty(name: string, value: string, priority = '') {
        styleValues.set(name, value);
        if (priority) {
          stylePriorities.set(name, priority);
        } else {
          stylePriorities.delete(name);
        }
      },
      removeProperty(name: string) {
        styleValues.delete(name);
        stylePriorities.delete(name);
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

  function execute(
    method: string,
    params: Record<string, unknown>
  ): Promise<PatchResult | PatchListResult> {
    return new Promise((resolve) => {
      assert.equal(
        listener(
          {
            type: 'bridge.execute',
            method,
            params,
          },
          EMPTY_SENDER,
          (response) => {
            resolve(
              Array.isArray(response) ? (response as PatchListResult) : expectPatchResult(response)
            );
          }
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
  assert.equal(stylePriorities.has('color'), false);
  assert.equal(styleValues.get('border'), '1px solid black');

  const duplicateResult = await executeBridgeMethod(listener, 'patch.apply_styles', {
    patchId: 'patch-style-roundtrip',
    target: { selector: '#target' },
    declarations: { color: 'green' },
  });
  assert.deepEqual(duplicateResult, {
    error: 'Patch ID patch-style-roundtrip is already active.',
  });
  assert.equal(styleValues.get('color'), 'red');

  const rollbackResult = await execute('patch.rollback', {
    patchId: 'patch-style-roundtrip',
  });

  assert.deepEqual(rollbackResult, {
    patchId: 'patch-style-roundtrip',
    rolledBack: true,
  });
  assert.equal(styleValues.get('color'), 'blue');
  assert.equal(stylePriorities.get('color'), 'important');
  assert.equal(styleValues.has('border'), false);
  assert.equal(stylePriorities.has('border'), false);
  assert.deepEqual(await execute('patch.list', {}), []);

  await execute('patch.apply_styles', {
    patchId: 'patch-committed-baseline',
    target: { selector: '#target' },
    declarations: { color: 'green' },
  });
  assert.deepEqual(await executeBridgeMethod(listener, 'patch.commit_session_baseline', {}), {
    committed: true,
  });
  assert.equal(styleValues.get('color'), 'green');
  assert.deepEqual(await execute('patch.list', {}), []);
  assert.deepEqual(
    await executeBridgeMethod(listener, 'patch.rollback', {
      patchId: 'patch-committed-baseline',
    }),
    { patchId: 'patch-committed-baseline', rolledBack: false }
  );
  assert.equal(styleValues.get('color'), 'green');
});

test('content patch module guards duplicate and missing dependency loads', async (t) => {
  const saved = captureGlobals([
    '__BBX_CONTENT_PATCH__',
    '__BBX_CONTENT_HELPERS__',
    '__BBX_CONTENT_REGISTRY__',
  ]);
  t.after(() => restoreGlobals(saved));

  Reflect.set(globalThis, '__BBX_CONTENT_PATCH__', { existing: true });
  await importFresh('../src/content-patch.js');
  assert.deepEqual(Reflect.get(globalThis, '__BBX_CONTENT_PATCH__'), { existing: true });

  Reflect.deleteProperty(globalThis, '__BBX_CONTENT_PATCH__');
  Reflect.deleteProperty(globalThis, '__BBX_CONTENT_HELPERS__');
  Reflect.deleteProperty(globalThis, '__BBX_CONTENT_REGISTRY__');
  await assert.rejects(
    importFresh('../src/content-patch.js'),
    /Browser Bridge helpers and registry must load before content-patch\.js/
  );
});

test('content script input.click returns click metadata and stale element refs fail after detachment', async (t) => {
  const harness = createChromeHarness();
  const inputs = installInputDomGlobals(t);
  const checkbox = inputs.createCheckbox();
  const body = inputs.createBody([checkbox]);
  const attachedElements = new Set<FakeElementLike>([body, checkbox]);
  const baseDocument = createDocumentHarness(body, {
    '#checkbox': checkbox,
  });
  const document = {
    ...baseDocument,
    activeElement: null,
    elementFromPoint: () => checkbox,
    contains(element: unknown) {
      return (
        typeof element === 'object' &&
        element !== null &&
        attachedElements.has(element as FakeElementLike)
      );
    },
  };

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
    window: { innerWidth: 100, innerHeight: 100 },
  });

  const listener = harness.getListener();

  function execute(method: string, params: Record<string, unknown>): Promise<BridgeResult> {
    return new Promise((resolve) => {
      assert.equal(
        listener(
          {
            type: 'bridge.execute',
            method,
            params,
          },
          EMPTY_SENDER,
          (response) => resolve(expectRecord(response))
        ),
        true
      );
    });
  }

  const clickResult = await execute('input.click', {
    target: { selector: '#checkbox' },
  });

  assert.deepEqual(withoutInputMetadata(clickResult), {
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
      error: {
        code: 'ELEMENT_STALE',
        message: 'Element reference is stale.',
        details: { elementRef: clickResult.elementRef, recovered: false },
      },
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

  function execute(method: string, params: Record<string, unknown>): Promise<BridgeResult> {
    return new Promise((resolve) => {
      assert.equal(
        listener(
          {
            type: 'bridge.execute',
            method,
            params,
          },
          EMPTY_SENDER,
          (response) => resolve(expectRecord(response))
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

  assert.deepEqual(withoutInputMetadata(inputResult), {
    elementRef: inputResult.elementRef,
    typed: 6,
    value: 'Bridge',
  });
  assert.equal(typeof inputResult.elementRef, 'string');
  assert.equal(textInput.value, 'Bridge');
  assert.deepEqual(textInput.eventLog.slice(0, 4), ['keydown', 'beforeinput', 'input', 'keyup']);

  assert.deepEqual(withoutInputMetadata(editableResult), {
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

  function execute(method: string, params: Record<string, unknown>): Promise<BridgeResult> {
    return new Promise((resolve) => {
      assert.equal(
        listener(
          {
            type: 'bridge.execute',
            method,
            params,
          },
          EMPTY_SENDER,
          (response) => resolve(expectRecord(response))
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

  assert.deepEqual(withoutInputMetadata(checkedResult), {
    elementRef: checkedResult.elementRef,
    checked: true,
    changed: true,
    type: 'checkbox',
  });
  assert.equal(typeof checkedResult.elementRef, 'string');
  assert.deepEqual(checkbox.eventLog, ['click', 'input', 'change']);
  assert.equal(checkbox.checked, true);

  assert.deepEqual(withoutInputMetadata(selectedResult), {
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
  Reflect.set(globalThis, 'Node', { TEXT_NODE: 3 });

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
  const window = {
    scrollX: 3,
    scrollY: 4,
    getComputedStyle() {
      return {
        getPropertyValue(property: string) {
          return property === 'color' ? 'rgb(255, 0, 0)' : 'block';
        },
      };
    },
  };

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
      const timeout = (await executeBridgeMethod(listener, 'dom.wait_for', {
        selector: '#later',
        timeoutMs: 100,
      })) as WaitResult;
      const missingSelector = await executeBridgeMethod(listener, 'dom.wait_for', {
        text: 'ready now',
      });
      const hiddenMissing = await executeBridgeMethod(listener, 'dom.wait_for', {
        selector: '#missing',
        state: 'hidden',
      });
      const missingCondition = await executeBridgeMethod(listener, 'dom.wait_for', {
        timeoutMs: 100,
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
      assert.equal(missingSelector.found, true);
      assert.equal(typeof missingSelector.elementRef, 'string');
      assert.deepEqual(hiddenMissing, {
        found: true,
        elementRef: null,
        duration: 0,
      });
      assert.deepEqual(missingCondition, {
        error: 'selector or text is required for dom.wait_for',
      });
    }
  );
});

test('content script patch operations verify and roll back DOM and style changes', async (t) => {
  const saved = captureGlobals(['getComputedStyle']);
  t.after(() => restoreGlobals(saved));

  const harness = createChromeHarness();
  const styleValues = new Map<string, string>([['color', 'blue']]);
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
      getPropertyValue(name: string) {
        return styleValues.get(name) ?? '';
      },
      getPropertyPriority() {
        return '';
      },
      setProperty(name: string, value: string) {
        styleValues.set(name, value);
      },
      removeProperty(name: string) {
        styleValues.delete(name);
      },
    },
  };
  Reflect.set(globalThis, 'getComputedStyle', (element: unknown) => ({
    getPropertyValue(property: string) {
      return property === 'color' && element === target ? (styleValues.get(property) ?? '') : '';
    },
  }));

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
  const unverifiedStylePatch = await executeBridgeMethod(listener, 'patch.apply_styles', {
    patchId: 'style-2',
    target: { selector: '#target' },
    declarations: { background: 'white' },
  });
  const unverifiedDomPatch = await executeBridgeMethod(listener, 'patch.apply_dom', {
    patchId: 'attribute-3',
    target: { selector: '#target' },
    operation: 'set_attribute',
    name: 'data-unverified',
    value: 'yes',
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
  const addExistingClassPatch = await executeBridgeMethod(listener, 'patch.apply_dom', {
    patchId: 'class-2',
    target: { selector: '#target' },
    operation: 'add_class',
    name: 'initial',
    verify: true,
  });
  const removeMissingClassPatch = await executeBridgeMethod(listener, 'patch.apply_dom', {
    patchId: 'class-3',
    target: { selector: '#target' },
    operation: 'remove_class',
    name: 'fresh',
    verify: true,
  });
  const addMissingClassPatch = await executeBridgeMethod(listener, 'patch.apply_dom', {
    patchId: 'class-4',
    target: { selector: '#target' },
    operation: 'add_class',
    name: 'fresh',
    verify: true,
  });
  const removeExistingClassPatch = await executeBridgeMethod(listener, 'patch.apply_dom', {
    patchId: 'class-5',
    target: { selector: '#target' },
    operation: 'remove_class',
    name: 'initial',
    verify: true,
  });

  assert.deepEqual(stylePatch, {
    patchId: 'style-1',
    applied: true,
    verified: { color: 'red' },
    elementRef: stylePatch.elementRef,
  });
  assert.equal(typeof stylePatch.elementRef, 'string');
  assert.deepEqual(unverifiedStylePatch, {
    patchId: 'style-2',
    applied: true,
  });
  assert.deepEqual(unverifiedDomPatch, {
    patchId: 'attribute-3',
    applied: true,
  });
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
  assert.deepEqual(addExistingClassPatch, {
    patchId: 'class-2',
    applied: true,
    verified: { classList: ['initial', 'active'] },
    elementRef: addExistingClassPatch.elementRef,
  });
  assert.deepEqual(removeMissingClassPatch, {
    patchId: 'class-3',
    applied: true,
    verified: { classList: ['initial', 'active'] },
    elementRef: removeMissingClassPatch.elementRef,
  });
  assert.deepEqual(addMissingClassPatch, {
    patchId: 'class-4',
    applied: true,
    verified: { classList: ['initial', 'active', 'fresh'] },
    elementRef: addMissingClassPatch.elementRef,
  });
  assert.deepEqual(removeExistingClassPatch, {
    patchId: 'class-5',
    applied: true,
    verified: { classList: ['active', 'fresh'] },
    elementRef: removeExistingClassPatch.elementRef,
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
  assert.deepEqual(await executeBridgeMethod(listener, 'patch.rollback', { patchId: 'class-2' }), {
    patchId: 'class-2',
    rolledBack: true,
  });
  assert.deepEqual(target.classList ? [...target.classList] : [], ['active', 'fresh']);
  assert.deepEqual(await executeBridgeMethod(listener, 'patch.rollback', { patchId: 'class-3' }), {
    patchId: 'class-3',
    rolledBack: true,
  });
  assert.deepEqual(target.classList ? [...target.classList] : [], ['active', 'fresh']);
  assert.deepEqual(await executeBridgeMethod(listener, 'patch.rollback', { patchId: 'class-5' }), {
    patchId: 'class-5',
    rolledBack: true,
  });
  assert.deepEqual(target.classList ? [...target.classList] : [], ['active', 'fresh', 'initial']);
  assert.deepEqual(await executeBridgeMethod(listener, 'patch.rollback', { patchId: 'class-4' }), {
    patchId: 'class-4',
    rolledBack: true,
  });
  assert.deepEqual(target.classList ? [...target.classList] : [], ['active', 'initial']);
  assert.deepEqual(await executeBridgeMethod(listener, 'patch.rollback', { patchId: 'class-1' }), {
    patchId: 'class-1',
    rolledBack: true,
  });
  assert.deepEqual(target.classList ? [...target.classList] : [], ['initial']);
  assert.deepEqual(await executeBridgeMethod(listener, 'patch.rollback', { patchId: 'style-1' }), {
    patchId: 'style-1',
    rolledBack: true,
  });
  assert.equal(styleValues.get('color'), 'blue');
  assert.deepEqual(await executeBridgeMethod(listener, 'patch.rollback', { patchId: 'style-2' }), {
    patchId: 'style-2',
    rolledBack: true,
  });
  assert.deepEqual(
    await executeBridgeMethod(listener, 'patch.rollback', { patchId: 'attribute-3' }),
    {
      patchId: 'attribute-3',
      rolledBack: true,
    }
  );
  assert.deepEqual(await executeBridgeMethod(listener, 'patch.rollback', { patchId: 'missing' }), {
    patchId: 'missing',
    rolledBack: false,
  });
  const unsupportedPatch = await executeBridgeMethod(listener, 'patch.apply_dom', {
    target: { selector: '#target' },
    operation: 'unsupported',
  });
  assert.deepEqual(unsupportedPatch, { error: 'Unsupported DOM patch operation unsupported' });
  const missingToggleClassPatch = await executeBridgeMethod(listener, 'patch.apply_dom', {
    target: { selector: '#target' },
    operation: 'toggle_class',
  });
  assert.deepEqual(missingToggleClassPatch, {
    error: 'class name is required for class patch operations',
  });
  assert.deepEqual(await executeBridgeMethod(listener, 'patch.list', {}), []);
  assert.deepEqual(await executeBridgeMethod(listener, 'patch.commit_session_baseline', {}), {
    committed: true,
  });
});

test('content script page state, storage, and screenshot helpers report page context', async (t) => {
  const saved = captureGlobals(['localStorage', 'sessionStorage']);
  t.after(() => restoreGlobals(saved));

  const harness = createChromeHarness();

  function createStorage(entries: Record<string, string>): FakeStorage {
    const keys = Object.keys(entries);
    return {
      entries,
      get length() {
        return keys.length;
      },
      key(index: number) {
        return keys[index] ?? null;
      },
      getItem(key: string) {
        return Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : null;
      },
      setItem(key: string, value: string) {
        entries[key] = value;
      },
      removeItem(key: string) {
        Reflect.deleteProperty(entries, key);
      },
      clear() {
        for (const key of Object.keys(entries)) {
          Reflect.deleteProperty(entries, key);
        }
      },
    };
  }

  Reflect.set(globalThis, 'localStorage', createStorage({ short: 'ok', long: 'x'.repeat(510) }));
  Reflect.set(globalThis, 'sessionStorage', createStorage({ token: 'abc123' }));

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
      const state = (await executeBridgeMethod(listener, 'page.get_state', {})) as PageStateResult;
      const local = (await executeBridgeMethod(listener, 'page.get_storage', {})) as StorageResult;
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
  const window = {
    get scrollX() {
      return windowState.scrollX;
    },
    get scrollY() {
      return windowState.scrollY;
    },
    scrollTo(options: { top?: number; left?: number }) {
      windowState.scrollY = options.top ?? windowState.scrollY;
      windowState.scrollX = options.left ?? windowState.scrollX;
    },
    scrollBy(options: { top?: number; left?: number }) {
      windowState.scrollY += options.top ?? 0;
      windowState.scrollX += options.left ?? 0;
    },
  };

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

  assert.deepEqual(withoutInputMetadata(focusResult), {
    elementRef: focusResult.elementRef,
    focused: true,
    tag: 'button',
  });
  assert.equal(document.activeElement, button);
  assert.deepEqual(withoutInputMetadata(backspaceResult), {
    elementRef: backspaceResult.elementRef,
    key: 'Backspace',
    handled: true,
  });
  assert.equal(textInput.value, 'ab');
  assert.deepEqual(withoutInputMetadata(enterResult), {
    elementRef: enterResult.elementRef,
    key: 'Enter',
    handled: true,
  });
  assert.equal(form.submitCount, 1);
  assert.equal(textInput.eventLog.includes('change'), true);
  assert.deepEqual(withoutInputMetadata(deleteResult), {
    elementRef: deleteResult.elementRef,
    key: 'Delete',
    handled: true,
  });
  assert.equal(textarea.value, 'wyz');
  assert.deepEqual(withoutInputMetadata(buttonEnterResult), {
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
  const pointerTargets = [hoverTarget, clickTarget, source, destination];
  pointerTargets.forEach((element, index) => {
    Reflect.set(element, 'getBoundingClientRect', () => ({
      left: index * 20,
      top: 0,
      width: 10,
      height: 10,
    }));
  });
  const body = inputs.createBody([
    multiSelect,
    radio,
    hoverTarget,
    clickTarget,
    source,
    destination,
  ]);
  const document = createDocumentHarness(
    body,
    {
      '#select': multiSelect,
      '#radio': radio,
      '#hover': hoverTarget,
      '#click': clickTarget,
      '#source': source,
      '#destination': destination,
    },
    {
      elementFromPoint: (x) => pointerTargets[Math.floor(x / 20)] ?? null,
    }
  );

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
    window: { innerWidth: 100, innerHeight: 100 },
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

  assert.deepEqual(withoutInputMetadata(hoverResult), {
    elementRef: hoverResult.elementRef,
    hovered: true,
  });
  assert.equal(typeof hoverResult.elementRef, 'string');
  assert.deepEqual(hoverTarget.eventLog, ['mouseenter', 'mouseover', 'mousemove']);
  assert.deepEqual(withoutInputMetadata(dragResult), {
    sourceRef: dragResult.sourceRef,
    destinationRef: dragResult.destinationRef,
    dragged: true,
  });
  assert.equal(source.eventLog.includes('dragstart'), true);
  assert.equal(source.eventLog.includes('dragend'), true);
  assert.equal(destination.eventLog.includes('drop'), true);
  assert.deepEqual(withoutInputMetadata(rightClickResult), {
    elementRef: rightClickResult.elementRef,
    clicked: true,
    button: 'right',
    clickCount: 1,
  });
  assert.deepEqual(withoutInputMetadata(middleClickResult), {
    elementRef: middleClickResult.elementRef,
    clicked: true,
    button: 'middle',
    clickCount: 1,
  });
  assert.equal(clickTarget.eventLog.includes('contextmenu'), true);
  assert.equal(clickTarget.eventLog.includes('auxclick'), true);
  assert.deepEqual(withoutInputMetadata(selectedResult), {
    elementRef: selectedResult.elementRef,
    changed: true,
    multiple: true,
    selectedValues: ['beta', 'gamma'],
  });
  assert.deepEqual(multiSelect.eventLog, ['input', 'change']);
  assert.equal((missingOption.error as { code?: unknown }).code, 'INPUT_INVALID_TARGET');
  assert.equal((radioError.error as { code?: unknown }).code, 'INPUT_INVALID_TARGET');
});

test('content script computes pointer coordinates after scrolling elements into view', async (t) => {
  const harness = createChromeHarness();
  const inputs = installInputDomGlobals(t);
  const clickTarget = inputs.createButton({ textContent: 'Click me' });
  const hoverTarget = inputs.createButton({ textContent: 'Hover me' });
  const source = inputs.createButton({ textContent: 'Drag source' });
  const destination = inputs.createButton({ textContent: 'Drop target' });
  const body = inputs.createBody([clickTarget, hoverTarget, source, destination]);
  const pointerTargets = [clickTarget, hoverTarget, source, destination];
  const document = createDocumentHarness(
    body,
    {
      '#click': clickTarget,
      '#hover': hoverTarget,
      '#source': source,
      '#destination': destination,
    },
    {
      elementFromPoint: (x, y) =>
        pointerTargets.find((element) => {
          const rect = element.getBoundingClientRect();
          return (
            x >= rect.left &&
            x < rect.left + rect.width &&
            y >= rect.top &&
            y < rect.top + rect.height
          );
        }) ?? null,
    }
  );
  type PointerEventRecord = { type: string; x: number; y: number };

  function capturePointerEvents(
    element: FakeElementLike,
    afterScrollRect: { left: number; top: number; width: number; height: number }
  ): PointerEventRecord[] {
    const events: PointerEventRecord[] = [];
    const originalDispatch = element.dispatchEvent?.bind(element);
    let scrolled = false;
    Reflect.set(element, 'scrollIntoView', () => {
      scrolled = true;
    });
    Reflect.set(element, 'getBoundingClientRect', () =>
      scrolled ? afterScrollRect : { left: -500, top: -500, width: 10, height: 10 }
    );
    Reflect.set(element, 'dispatchEvent', (event: FakeEventLike) => {
      const pointerEvent = event as FakeEventLike & { clientX?: number; clientY?: number };
      if (typeof pointerEvent.clientX === 'number' && typeof pointerEvent.clientY === 'number') {
        events.push({ type: event.type, x: pointerEvent.clientX, y: pointerEvent.clientY });
      }
      return originalDispatch ? originalDispatch(event) : true;
    });
    return events;
  }

  const clickEvents = capturePointerEvents(clickTarget, {
    left: 100,
    top: 200,
    width: 20,
    height: 10,
  });
  const hoverEvents = capturePointerEvents(hoverTarget, {
    left: 300,
    top: 400,
    width: 20,
    height: 10,
  });
  const sourceEvents = capturePointerEvents(source, {
    left: 10,
    top: 20,
    width: 10,
    height: 10,
  });
  const destinationEvents = capturePointerEvents(destination, {
    left: 1000,
    top: 1200,
    width: 10,
    height: 10,
  });

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
    window: { innerWidth: 2000, innerHeight: 1500 },
  });

  const listener = harness.getListener();
  const clickResult = await executeBridgeMethod(listener, 'input.click', {
    target: { selector: '#click' },
  });
  const hoverResult = await executeBridgeMethod(listener, 'input.hover', {
    target: { selector: '#hover' },
  });
  const dragResult = await executeBridgeMethod(listener, 'input.drag', {
    source: { selector: '#source' },
    destination: { selector: '#destination' },
    offsetX: 4,
    offsetY: 6,
  });
  assert.equal(clickResult.error, undefined);
  assert.equal(hoverResult.error, undefined);
  assert.equal(dragResult.error, undefined);

  assert.deepEqual(
    clickEvents.find((event) => event.type === 'mousedown'),
    {
      type: 'mousedown',
      x: 110,
      y: 205,
    }
  );
  assert.deepEqual(
    hoverEvents.find((event) => event.type === 'mousemove'),
    {
      type: 'mousemove',
      x: 310,
      y: 405,
    }
  );
  assert.deepEqual(
    sourceEvents.find((event) => event.type === 'dragstart'),
    {
      type: 'dragstart',
      x: 15,
      y: 25,
    }
  );
  assert.deepEqual(
    destinationEvents.find((event) => event.type === 'drop'),
    {
      type: 'drop',
      x: 1009,
      y: 1211,
    }
  );
});

test('content script input.fill sets values and dispatches input, change, and blur', async (t) => {
  const harness = createChromeHarness();
  const inputs = installInputDomGlobals(t);
  const textInput = inputs.createTextInput({ value: 'old value' });
  const textarea = inputs.createTextArea();
  const editable = inputs.createContentEditable({ textContent: 'old content' });
  const body = inputs.createBody([textInput, textarea, editable]);
  const document = createDocumentHarness(body, {
    '#text-input': textInput,
    '#textarea': textarea,
    '#editable': editable,
  });
  document.activeElement = null;

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
  });

  const listener = harness.getListener();

  function execute(method: string, params: Record<string, unknown>): Promise<BridgeResult> {
    return new Promise((resolve) => {
      assert.equal(
        listener({ type: 'bridge.execute', method, params }, EMPTY_SENDER, (response) =>
          resolve(expectRecord(response))
        ),
        true
      );
    });
  }

  const fillResult = await execute('input.fill', {
    target: { selector: '#text-input' },
    value: 'Bridge',
    mode: 'auto',
  });

  assert.equal(typeof fillResult.elementRef, 'string');
  assert.equal(fillResult.value, 'Bridge');
  assert.equal(fillResult.mode, 'setter');
  assert.equal(textInput.value, 'Bridge');
  // Frameworks listen for input/change at the document level; blur triggers
  // field-level validation. All three must fire.
  assert.deepEqual(
    textInput.eventLog.filter((type) => ['input', 'change', 'blur'].includes(type)),
    ['input', 'change', 'blur']
  );

  const setterResult = await execute('input.fill', {
    target: { selector: '#textarea' },
    value: 'multi\nline',
    mode: 'setter',
  });
  assert.equal(setterResult.mode, 'setter');
  assert.equal(setterResult.value, 'multi\nline');
  assert.equal(textarea.value, 'multi\nline');

  const contentEditableResult = await execute('input.fill', {
    target: { selector: '#editable' },
    value: 'editable value',
    mode: 'setter',
  });
  assert.equal(contentEditableResult.mode, 'setter');
  assert.equal(contentEditableResult.value, 'editable value');
  assert.equal(editable.textContent, 'editable value');
  assert.deepEqual(
    editable.eventLog.filter((type) => ['input', 'change', 'blur'].includes(type)),
    ['input', 'change', 'blur']
  );
});

test('content script input.fill keystrokes mode types character by character', async (t) => {
  const harness = createChromeHarness();
  const inputs = installInputDomGlobals(t);
  const textInput = inputs.createTextInput({ value: 'clear me' });
  const body = inputs.createBody([textInput]);
  const document = createDocumentHarness(body, { '#text-input': textInput });
  document.activeElement = null;

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
  });

  const listener = harness.getListener();

  function execute(method: string, params: Record<string, unknown>): Promise<BridgeResult> {
    return new Promise((resolve) => {
      assert.equal(
        listener({ type: 'bridge.execute', method, params }, EMPTY_SENDER, (response) =>
          resolve(expectRecord(response))
        ),
        true
      );
    });
  }

  const fillResult = await execute('input.fill', {
    target: { selector: '#text-input' },
    value: 'Hi',
    mode: 'keystrokes',
  });

  assert.equal(fillResult.mode, 'keystrokes');
  assert.equal(fillResult.value, 'Hi');
  assert.equal(textInput.value, 'Hi');
  // Existing value is cleared first, then each character arrives as a key press.
  assert.equal(textInput.eventLog.filter((type) => type === 'keydown').length >= 3, true);
});

test('content script input.fill falls back to keystrokes when the setter does not stick', async (t) => {
  const harness = createChromeHarness();
  const inputs = installInputDomGlobals(t);
  const textInput = inputs.createTextInput();
  // Simulate a custom component that swallows direct value assignment but
  // accepts per-character insertion via setRangeText.
  let internalValue = '';
  let allowWrites = false;
  Object.defineProperty(textInput, 'value', {
    configurable: true,
    get: () => internalValue,
    set: (next: string) => {
      if (allowWrites) internalValue = next;
    },
  });
  textInput.setRangeText = (replacement: string) => {
    allowWrites = true;
    internalValue += replacement;
  };
  const body = inputs.createBody([textInput]);
  const document = createDocumentHarness(body, { '#text-input': textInput });
  document.activeElement = null;

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
  });

  const listener = harness.getListener();

  function execute(method: string, params: Record<string, unknown>): Promise<BridgeResult> {
    return new Promise((resolve) => {
      assert.equal(
        listener({ type: 'bridge.execute', method, params }, EMPTY_SENDER, (response) =>
          resolve(expectRecord(response))
        ),
        true
      );
    });
  }

  const fillResult = await execute('input.fill', {
    target: { selector: '#text-input' },
    value: 'AB',
    mode: 'auto',
  });

  assert.equal(fillResult.mode, 'keystrokes-fallback');
});

test('content script input.fill rejects non-editable targets', async (t) => {
  const harness = createChromeHarness();
  const inputs = installInputDomGlobals(t);
  const button = inputs.createButton({ textContent: 'Save' });
  const body = inputs.createBody([button]);
  const document = createDocumentHarness(body, { '#button': button });
  document.activeElement = null;

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
  });

  const responses: unknown[] = [];

  assert.equal(
    harness.getListener()(
      {
        type: 'bridge.execute',
        method: 'input.fill',
        params: { target: { selector: '#button' }, value: 'nope' },
      },
      EMPTY_SENDER,
      (response) => responses.push(response)
    ),
    true
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    ((responses[0] as BridgeResult).error as { code?: unknown }).code,
    'INPUT_INVALID_TARGET'
  );
});

test('input resolution ranks actionable duplicates and rejects ambiguity, disabled targets, and overlays', async (t) => {
  const saved = captureGlobals(['getComputedStyle']);
  t.after(() => restoreGlobals(saved));
  const harness = createChromeHarness();
  const inputs = installInputDomGlobals(t);
  const hidden = inputs.createButton({ textContent: 'Hidden' });
  const visible = inputs.createButton({ textContent: 'Visible' });
  const tied = inputs.createButton({ textContent: 'Tied' });
  const disabled = inputs.createButton({ textContent: 'Disabled' });
  const zeroSize = inputs.createButton({ textContent: 'Zero size' });
  const overlay = inputs.createButton({ textContent: 'Overlay' });
  Reflect.set(disabled, 'disabled', true);
  Reflect.set(visible, 'getBoundingClientRect', () => ({ left: 0, top: 0, width: 10, height: 10 }));
  Reflect.set(tied, 'getBoundingClientRect', () => ({ left: 20, top: 0, width: 10, height: 10 }));
  Reflect.set(zeroSize, 'getBoundingClientRect', () => ({ left: 0, top: 0, width: 0, height: 0 }));
  const body = inputs.createBody([hidden, visible, tied, disabled, zeroSize, overlay]);
  const attached = new Set<FakeElementLike>([
    body,
    hidden,
    visible,
    tied,
    disabled,
    zeroSize,
    overlay,
  ]);
  let hitTarget: FakeElementLike | null | undefined;
  const document = createDocumentHarness(
    body,
    {
      '.ranked': [hidden, visible],
      '.ambiguous': [hidden, visible, tied],
      '#disabled': disabled,
      '#zero-size': zeroSize,
      '#visible': visible,
    },
    {
      contains: (element) => attached.has(element as FakeElementLike),
      elementFromPoint: (x) => hitTarget ?? (x < 15 ? visible : tied),
    }
  );
  Reflect.set(globalThis, 'getComputedStyle', (element: unknown) => ({
    display: element === hidden ? 'none' : 'block',
    visibility: 'visible',
    opacity: '1',
    pointerEvents: 'auto',
  }));

  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
    window: { innerWidth: 100, innerHeight: 100 },
  });
  const listener = harness.getListener();
  const ranked = await executeBridgeMethod(listener, 'input.click', {
    target: { selector: '.ranked' },
  });
  assert.equal((ranked.resolution as { strategy?: unknown }).strategy, 'selector-ranked');
  assert.equal(typeof ranked.elementRef, 'string');
  assert.equal(hidden.eventLog.includes('click'), false);
  assert.equal(visible.eventLog.includes('click'), true);

  const ambiguous = await executeBridgeMethod(listener, 'input.click', {
    target: { selector: '.ambiguous' },
  });
  assert.equal((ambiguous.error as { code?: unknown }).code, 'ELEMENT_AMBIGUOUS');

  const disabledResult = await executeBridgeMethod(listener, 'input.focus', {
    target: { selector: '#disabled' },
  });
  assert.equal((disabledResult.error as { code?: unknown }).code, 'ELEMENT_NOT_ACTIONABLE');

  const zeroSizeResult = await executeBridgeMethod(listener, 'input.focus', {
    target: { selector: '#zero-size' },
  });
  assert.equal((zeroSizeResult.error as { code?: unknown }).code, 'ELEMENT_NOT_ACTIONABLE');

  hitTarget = overlay;
  const obscured = await executeBridgeMethod(listener, 'input.click', {
    target: { selector: '#visible' },
  });
  const obscuredError = obscured.error as {
    code?: unknown;
    details?: { blocker?: { tag?: unknown } };
  };
  assert.equal(obscuredError.code, 'ELEMENT_OBSCURED');
  assert.equal(obscuredError.details?.blocker?.tag, 'button');
});

test('stale ref recovery is opt-in, same-URL, descriptor-strong, and ambiguity-safe', async (t) => {
  const harness = createChromeHarness();
  const inputs = installInputDomGlobals(t);
  const oldButton = inputs.createButton({ textContent: 'Save' });
  const newButton = inputs.createButton({ textContent: 'Save' });
  oldButton.attributes?.set('data-testid', 'save-button');
  newButton.attributes?.set('data-testid', 'save-button');
  const body = inputs.createBody([oldButton, newButton]);
  const attached = new Set<FakeElementLike>([body, oldButton]);
  let currentButtons = [oldButton];
  const base = createDocumentHarness(body, { '#save': oldButton });
  const document = {
    ...base,
    URL: 'https://example.test/form',
    contains: (element: unknown) => attached.has(element as FakeElementLike),
    querySelectorAll(selector: string) {
      return selector === 'button' ? currentButtons : base.querySelectorAll(selector);
    },
  };

  await loadContentScript(t, { withHelpers: true, chrome: harness.chrome, document });
  const listener = harness.getListener();
  const first = await executeBridgeMethod(listener, 'input.focus', {
    target: { selector: '#save' },
  });
  const oldRef = String(first.elementRef);
  attached.delete(oldButton);
  attached.add(newButton);
  currentButtons = [newButton];

  const recovered = await executeBridgeMethod(listener, 'input.focus', {
    target: { elementRef: oldRef },
    recoverStale: true,
  });
  const recovery = recovered.resolution as {
    recovered?: unknown;
    oldRef?: unknown;
    newRef?: unknown;
    matchedFields?: unknown;
  };
  assert.equal(recovery.recovered, true);
  assert.equal(recovery.oldRef, oldRef);
  assert.equal(typeof recovery.newRef, 'string');
  assert.deepEqual(recovery.matchedFields, ['testId']);

  attached.delete(newButton);
  Reflect.set(document, 'URL', 'https://example.test/other');
  const wrongUrl = await executeBridgeMethod(listener, 'input.focus', {
    target: { elementRef: String(recovered.elementRef) },
    recoverStale: true,
  });
  assert.equal((wrongUrl.error as { code?: unknown }).code, 'ELEMENT_STALE');
  assert.equal(
    (wrongUrl.error as { details?: { reason?: unknown } }).details?.reason,
    'url_changed'
  );
  Reflect.set(document, 'URL', 'https://example.test/form');

  const duplicate = inputs.createButton({ textContent: 'Save' });
  duplicate.attributes?.set('data-testid', 'save-button');
  attached.add(duplicate);
  const duplicateTwo = inputs.createButton({ textContent: 'Save' });
  duplicateTwo.attributes?.set('data-testid', 'save-button');
  attached.add(duplicateTwo);
  currentButtons = [duplicate, duplicateTwo];
  const ambiguous = await executeBridgeMethod(listener, 'input.focus', {
    target: { elementRef: String(recovered.elementRef) },
    recoverStale: true,
  });
  assert.equal((ambiguous.error as { code?: unknown }).code, 'ELEMENT_AMBIGUOUS');
});

test('pointer resolution clips hit coordinates and rejects a null viewport hit', async (t) => {
  const harness = createChromeHarness();
  const inputs = installInputDomGlobals(t);
  const target = inputs.createButton({ textContent: 'Clipped' });
  Reflect.set(target, 'getBoundingClientRect', () => ({
    left: -80,
    top: 20,
    width: 100,
    height: 20,
  }));
  const body = inputs.createBody([target]);
  let returnHit = true;
  const hitPoints: Array<{ x: number; y: number }> = [];
  const document = createDocumentHarness(
    body,
    { '#clipped': target },
    {
      elementFromPoint(x, y) {
        hitPoints.push({ x, y });
        return returnHit ? target : null;
      },
    }
  );
  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
    document,
    window: { innerWidth: 100, innerHeight: 100 },
  });
  const listener = harness.getListener();

  const clicked = await executeBridgeMethod(listener, 'input.click', {
    target: { selector: '#clipped' },
  });
  assert.equal(clicked.clicked, true);
  assert.deepEqual(hitPoints.at(-1), { x: 10, y: 30 });
  assert.deepEqual((clicked.execution as { targetCoordinates?: unknown }).targetCoordinates, {
    x: 10,
    y: 30,
  });

  returnHit = false;
  const noHit = await executeBridgeMethod(listener, 'input.click', {
    target: { selector: '#clipped' },
  });
  const error = noHit.error as { code?: unknown; details?: { blocker?: unknown } };
  assert.equal(error.code, 'ELEMENT_OBSCURED');
  assert.equal(error.details?.blocker, null);
});

test('atomic input selectors preserve utility-class escaping', async (t) => {
  const harness = createChromeHarness();
  const inputs = installInputDomGlobals(t);
  const target = inputs.createButton({ textContent: 'Utility' });
  const body = inputs.createBody([target]);
  const document = createDocumentHarness(body, {
    '.top-\\[30px\\]': target,
  });
  await loadContentScript(t, { withHelpers: true, chrome: harness.chrome, document });
  const result = await executeBridgeMethod(harness.getListener(), 'input.focus', {
    target: { selector: '.top-[30px]' },
  });
  assert.equal(result.focused, true);
  assert.equal(document.activeElement, target);
});

test('native editable revalidation rejects redirected focus', async (t) => {
  const harness = createChromeHarness();
  const inputs = installInputDomGlobals(t);
  const target = inputs.createTextInput();
  const redirected = inputs.createTextInput();
  const body = inputs.createBody([target, redirected]);
  const document = createDocumentHarness(body, { '#target': target });
  await loadContentScript(t, { withHelpers: true, chrome: harness.chrome, document });
  const listener = harness.getListener();
  const resolved = await executeBridgeMethod(listener, 'input.resolve_native', {
    target: { selector: '#target' },
    kind: 'editable',
  });
  document.activeElement = redirected;
  const revalidated = await executeBridgeMethod(listener, 'input.revalidate_native', {
    elementRef: resolved.elementRef,
  });
  assert.equal((revalidated.error as { code?: unknown }).code, 'INPUT_FOCUS_CHANGED');
});

test('stale descriptors distinguish full values with identical bounded prefixes', async (t) => {
  const harness = createChromeHarness();
  const inputs = installInputDomGlobals(t);
  const prefix = 'x'.repeat(120);
  const originalValue = `${prefix}A`;
  const collidingValue = `${prefix}B`;
  const original = inputs.createButton({ textContent: 'Original' });
  const collision = inputs.createButton({ textContent: 'Collision' });
  const exact = inputs.createButton({ textContent: 'Exact' });
  original.attributes?.set('data-testid', originalValue);
  collision.attributes?.set('data-testid', collidingValue);
  exact.attributes?.set('data-testid', originalValue);
  const body = inputs.createBody([original, collision, exact]);
  const attached = new Set<FakeElementLike>([body, original]);
  let candidates = [original];
  const base = createDocumentHarness(body, { '#original': original });
  const document = {
    ...base,
    URL: 'https://example.test/collision',
    contains: (element: unknown) => attached.has(element as FakeElementLike),
    querySelectorAll(selector: string) {
      return selector === 'button' ? candidates : base.querySelectorAll(selector);
    },
  };
  await loadContentScript(t, { withHelpers: true, chrome: harness.chrome, document });
  const listener = harness.getListener();
  const remembered = await executeBridgeMethod(listener, 'input.focus', {
    target: { selector: '#original' },
  });
  attached.delete(original);
  attached.add(collision);
  candidates = [collision];

  const rejected = await executeBridgeMethod(listener, 'input.focus', {
    target: { elementRef: String(remembered.elementRef) },
    recoverStale: true,
  });
  assert.equal((rejected.error as { code?: unknown }).code, 'ELEMENT_STALE');
  assert.equal(JSON.stringify(rejected).includes(originalValue), false);
  assert.equal(JSON.stringify(rejected).includes(collidingValue), false);

  attached.delete(collision);
  attached.add(exact);
  candidates = [exact];
  const recovered = await executeBridgeMethod(listener, 'input.focus', {
    target: { elementRef: String(remembered.elementRef) },
    recoverStale: true,
  });
  assert.equal((recovered.resolution as { recovered?: unknown }).recovered, true);
});

test('content script reports unsupported execute methods as errors', async (t) => {
  const harness = createChromeHarness();
  await loadContentScript(t, {
    withHelpers: true,
    chrome: harness.chrome,
  });

  const responses: unknown[] = [];
  const listener = harness.getListener();

  assert.equal(
    listener(
      {
        type: 'bridge.execute',
        method: 'navigation.reload',
        params: {},
      },
      EMPTY_SENDER,
      (response) => responses.push(response)
    ),
    true
  );

  assert.deepEqual(responses, [{ error: 'Unsupported content-script method navigation.reload' }]);
});
