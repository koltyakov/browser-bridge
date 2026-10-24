(() => {
  const globalState = globalThis as typeof globalThis & {
    __BBX_CONTENT_HELPERS__?: Record<string, unknown>;
  };

  if (globalState.__BBX_CONTENT_HELPERS__) {
    return;
  }

  type Budget = {
    maxNodes: number;
    maxDepth: number;
    textBudget: number;
    includeBbox: boolean;
    attributeAllowlist: string[];
  };

  const NON_TEXT_INPUT_TYPES = new Set([
    'button',
    'checkbox',
    'color',
    'file',
    'hidden',
    'image',
    'radio',
    'range',
    'reset',
    'submit',
  ]);

  function clamp(value: unknown, minimum: number, maximum: number): number {
    return Math.min(Math.max(Number(value) || minimum, minimum), maximum);
  }

  /** Chrome aligns timers in hidden tabs to roughly one-second wake-ups, which
turns short polling and settle waits into seconds. Hidden documents let the
service worker, whose timers are not throttled, time the delay instead, and
fall back to setTimeout when the extension context is unavailable. */
  function delay(ms: number): Promise<void> {
    const wait = Math.max(0, Number(ms) || 0);
    const runtime = globalThis.chrome?.runtime;
    if (document.visibilityState !== 'hidden' || !runtime?.id) {
      return new Promise((resolve) => setTimeout(resolve, wait));
    }
    return new Promise((resolve) => {
      const fallback = () => setTimeout(resolve, wait);
      try {
        runtime.sendMessage({ type: 'bridge.delay', ms: wait }).then(() => resolve(), fallback);
      } catch {
        fallback();
      }
    });
  }

  function normalizeList(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return [...new Set(value.filter((item) => typeof item === 'string' && item.trim()))];
  }

  function applyBudget(options: Record<string, unknown> = {}): Budget {
    return {
      maxNodes: clamp(options.maxNodes ?? 25, 1, 250),
      maxDepth: clamp(options.maxDepth ?? 4, 1, 20),
      textBudget: clamp(options.textBudget ?? 600, 32, 10000),
      includeBbox: options.includeBbox !== false,
      attributeAllowlist: normalizeList(options.attributeAllowlist),
    };
  }

  function truncateText(
    value: string,
    budget: number
  ): { value: string; truncated: boolean; omitted: number } {
    if (!value) {
      return { value: '', truncated: false, omitted: 0 };
    }

    if (value.length <= budget) {
      return { value, truncated: false, omitted: 0 };
    }

    return {
      value: `${value.slice(0, Math.max(0, budget - 1))}\u2026`,
      truncated: true,
      omitted: value.length - budget,
    };
  }

  function escapeTailwindSelector(selector: string): string {
    const probe = document.createDocumentFragment();
    try {
      probe.querySelector(selector);
      return selector;
    } catch {
      // Repair utility syntax only after the browser rejects the original CSS.
    }
    // Leave valid attribute selectors (even .utility-[auto]) and quoted values
    // alone. Only invalid bracket syntax on a utility-style class is shorthand.
    return selector.replace(
      /\\.|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[(?:\\.|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\]\\"'])*\]|(\.[-\w]+-)\[([^\]\r\n]+)\]/g,

      (match: string, prefix: string | undefined, value: string | undefined): string => {
        if (typeof prefix !== 'string' || typeof value !== 'string') return match;
        try {
          probe.querySelector(`*[${value}]`);
          return match;
        } catch {
          return `${prefix}${`[${value}]`.replace(/[^\w-]/g, '\\$&')}`;
        }
      }
    );
  }

  function getInputImplicitRole(el: Element): string {
    if (typeof HTMLInputElement === 'undefined' || !(el instanceof HTMLInputElement)) {
      return 'textbox';
    }
    const type = String(el.type || el.getAttribute('type') || 'text').toLowerCase();

    const map: Record<string, string> = {
      button: 'button',
      checkbox: 'checkbox',
      radio: 'radio',
      range: 'slider',
      search: 'searchbox',
      submit: 'button',
      reset: 'button',
      image: 'button',
    };
    return map[type] || 'textbox';
  }

  function getImplicitRole(el: Element): string {
    const tag = el.tagName.toLowerCase();

    const roleMap: Record<string, string> = {
      a: el.hasAttribute('href') ? 'link' : '',
      article: 'article',
      aside: 'complementary',
      button: 'button',
      dialog: 'dialog',
      footer: 'contentinfo',
      form: 'form',
      h1: 'heading',
      h2: 'heading',
      h3: 'heading',
      h4: 'heading',
      h5: 'heading',
      h6: 'heading',
      header: 'banner',
      img: 'img',
      input: getInputImplicitRole(el),
      li: 'listitem',
      main: 'main',
      nav: 'navigation',
      ol: 'list',
      option: 'option',
      progress: 'progressbar',
      section: 'region',
      select: 'listbox',
      table: 'table',
      td: 'cell',
      textarea: 'textbox',
      th: 'columnheader',
      tr: 'row',
      ul: 'list',
    };
    return roleMap[tag] || '';
  }

  function getImplicitRoleSelector(role: string): string {
    const map: Record<string, string> = {
      link: 'a[href]',
      article: 'article',
      complementary: 'aside',
      button:
        'button, input[type=button], input[type=submit], input[type=reset], input[type=image]',
      dialog: 'dialog',
      contentinfo: 'footer',
      form: 'form',
      heading: 'h1, h2, h3, h4, h5, h6',
      banner: 'header',
      img: 'img',
      textbox:
        'input:not([type=button]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=submit]):not([type=reset]):not([type=image]):not([type=hidden]), textarea',
      listitem: 'li',
      main: 'main',
      navigation: 'nav',
      list: 'ol, ul',
      option: 'option',
      progressbar: 'progress',
      region: 'section',
      listbox: 'select',
      table: 'table',
      cell: 'td',
      columnheader: 'th',
      row: 'tr',
      checkbox: 'input[type=checkbox]',
      radio: 'input[type=radio]',
      slider: 'input[type=range]',
      searchbox: 'input[type=search]',
    };
    return map[role] || '';
  }

  function toRect(rect: DOMRect | DOMRectReadOnly): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    return {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
    };
  }

  function pushUnique(values: string[], candidate: string | null | undefined): void {
    if (!candidate) {
      return;
    }

    const normalized = candidate.replace(/\s+/g, ' ').trim();
    if (normalized && !values.includes(normalized)) {
      values.push(normalized);
    }
  }

  function extractElementText(element: Element): string {
    const parts: string[] = [];

    pushUnique(parts, element.getAttribute('aria-label'));
    pushUnique(parts, element.getAttribute('name'));
    pushUnique(parts, element.getAttribute('placeholder'));
    pushUnique(parts, element.getAttribute('title'));

    if ('value' in element && typeof element.value === 'string' && element.value.trim()) {
      pushUnique(parts, element.value);
    }

    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    pushUnique(parts, ownText);

    if (!parts.length && element.childElementCount === 0) {
      pushUnique(parts, (element.textContent || '').replace(/\s+/g, ' ').trim());
    }

    return parts.join(' | ');
  }

  function findElementForWaitState<TElement extends object>({
    elements,
    waitState,
    getRect,
    getVisibility,
  }: {
    elements: Iterable<TElement>;
    waitState: 'visible' | 'hidden';
    getRect: (element: TElement) => { width: number; height: number };
    getVisibility: (element: TElement) => string;
  }): TElement | null {
    let hiddenMatch: TElement | null = null;
    for (const element of elements) {
      const rect = getRect(element);
      const hasVisibleArea = rect.width > 0 && rect.height > 0;
      if (waitState === 'visible') {
        if (!hasVisibleArea) {
          continue;
        }

        if (getVisibility(element) !== 'hidden') {
          return element;
        }
        continue;
      }

      if (!hasVisibleArea) {
        hiddenMatch ??= element;
        continue;
      }

      if (getVisibility(element) === 'hidden') {
        hiddenMatch ??= element;
        continue;
      }

      return null;
    }

    return hiddenMatch;
  }

  function pruneElementRegistryEntries<TElement extends object, TRef extends string>({
    registry,
    reverseRegistry,
    iterator,
    containsElement,
    batchSize,
  }: {
    registry: Map<TRef, TElement>;
    reverseRegistry: WeakMap<TElement, TRef>;
    iterator: IterableIterator<[TRef, TElement]> | null;
    containsElement: (element: TElement) => boolean;
    batchSize: number;
  }): { iterator: IterableIterator<[TRef, TElement]> | null; pruned: boolean } {
    if (registry.size === 0) {
      return { iterator: null, pruned: false };
    }

    let nextIterator = iterator;
    if (!nextIterator) {
      nextIterator = registry.entries();
    }

    let scanned = 0;
    let pruned = false;
    while (scanned < batchSize) {
      const nextEntry = nextIterator.next();
      if (nextEntry.done) {
        nextIterator = null;
        break;
      }

      const [ref, element] = nextEntry.value;
      if (!containsElement(element)) {
        registry.delete(ref);
        reverseRegistry.delete(element);
        pruned = true;
      }
      scanned += 1;
    }

    return { iterator: nextIterator, pruned };
  }

  /** Tags whose text never counts as visible page text. */
  const NON_RENDERED_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'HEAD',
    'META',
    'LINK',
    'TITLE',
  ]);
  const DEEP_SCAN_LIMIT = 20_000;
  const LABELABLE_TAGS = new Set([
    'INPUT',
    'SELECT',
    'TEXTAREA',
    'BUTTON',
    'METER',
    'OUTPUT',
    'PROGRESS',
  ]);
  /** Roles whose accessible name comes from their content. */
  const NAME_FROM_CONTENT_ROLES = new Set([
    'button',
    'cell',
    'checkbox',
    'columnheader',
    'gridcell',
    'heading',
    'link',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'radio',
    'row',
    'rowheader',
    'switch',
    'tab',
    'tooltip',
    'treeitem',
  ]);

  /** Connection check that also holds for elements inside shadow roots, where
`document.contains` is always false. */
  function isNodeAttached(node: Node | null | undefined): boolean {
    if (!node) return false;
    if (typeof node.isConnected === 'boolean') return node.isConnected;
    return typeof document.contains === 'function' ? document.contains(node) : true;
  }

  /** Return an element's shadow root, including closed roots when the extension
`chrome.dom` API is available to the content script. */
  function getShadowRoot(element: Element): ShadowRoot | null {
    const open = (element as { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (open) return open;
    const domApi = (
      globalThis as {
        chrome?: { dom?: { openOrClosedShadowRoot?: (element: HTMLElement) => ShadowRoot | null } };
      }
    ).chrome?.dom;
    if (typeof domApi?.openOrClosedShadowRoot !== 'function') return null;
    try {
      return domApi.openOrClosedShadowRoot(element as HTMLElement) || null;
    } catch {
      return null;
    }
  }

  /** Iterate elements in document order, entering shadow trees right after
their host. Bounded so pathological pages cannot stall the content script. */
  function* walkElementsDeep(
    root: ParentNode = document,
    limit: number = DEEP_SCAN_LIMIT
  ): Generator<Element> {
    const stack: Array<{ children: ArrayLike<Element>; index: number }> = [
      { children: root.children ?? [], index: 0 },
    ];
    const rootShadow =
      'nodeType' in root && root.nodeType === 1 ? getShadowRoot(root as Element) : null;
    if (rootShadow?.children?.length) stack.push({ children: rootShadow.children, index: 0 });
    let yielded = 0;
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.index >= frame.children.length) {
        stack.pop();
        continue;
      }
      const element = frame.children[frame.index];
      frame.index += 1;
      yield element;
      yielded += 1;
      if (yielded >= limit) return;
      if (element.children?.length) stack.push({ children: element.children, index: 0 });
      const shadowRoot = getShadowRoot(element);
      if (shadowRoot?.children?.length) stack.push({ children: shadowRoot.children, index: 0 });
    }
  }

  /** Lazily visit shadow roots so first-match reads stop before unrelated trees. */
  function* walkShadowRoots(root: ParentNode = document): Generator<ShadowRoot> {
    let scanned = 0;
    const started = performance.now();
    const rootShadow =
      'nodeType' in root && root.nodeType === 1 ? getShadowRoot(root as Element) : null;
    if (rootShadow) yield rootShadow;
    for (const element of walkElementsDeep(root, DEEP_SCAN_LIMIT + 1)) {
      if (++scanned > DEEP_SCAN_LIMIT || performance.now() - started > 100) throw scanLimitError();
      const shadowRoot = getShadowRoot(element);
      if (shadowRoot) yield shadowRoot;
    }
  }

  /** `querySelectorAll` that also searches open (and, for the extension, closed)
shadow roots. Light-DOM matches come first. */
  function querySelectorAllDeep(selector: string, root: ParentNode = document): Element[] {
    // Validate even on an empty tree. :scope requires native tree-scoped CSS
    // semantics; ordinary selectors can be matched lazily without a NodeList
    // containing the entire document.
    root.querySelector(selector);
    if (selector.includes(':scope') || !('children' in root)) {
      const results: Element[] = [];
      for (const scope of [root, ...walkShadowRoots(root)]) {
        const matches = scope.querySelectorAll(selector);
        if (matches.length + results.length > DEEP_SCAN_LIMIT) throw scanLimitError();
        for (const element of matches) results.push(element);
      }
      return results;
    }
    const results: Element[] = [];
    const started = performance.now();
    let scanned = 0;
    for (const element of walkElementsDeep(root, DEEP_SCAN_LIMIT + 1)) {
      if (++scanned > DEEP_SCAN_LIMIT || performance.now() - started > 100) throw scanLimitError();
      if (element.matches(selector)) results.push(element);
    }
    return results;
  }

  function scanLimitError(): Error {
    return Object.assign(
      new Error('DOM scan limit reached. Use a narrower selector or element scope.'),
      { code: 'RESULT_TRUNCATED', details: { scanLimit: DEEP_SCAN_LIMIT } }
    );
  }

  /** First light-DOM match, falling back to shadow roots. */
  function querySelectorDeep(selector: string, root: ParentNode = document): Element | null {
    const light = root.querySelector(selector);
    if (light || !('children' in root)) return light;
    for (const shadowRoot of walkShadowRoots(root)) {
      const match = shadowRoot.querySelector(selector);
      if (match) return match;
    }
    return null;
  }

  /** Best-effort rendered visibility. Unknown environments count as visible. */
  function isElementVisible(element: Element): boolean {
    if (!isNodeAttached(element)) return false;
    const candidate = element as Element & {
      checkVisibility?: (options?: Record<string, boolean>) => boolean;
    };
    if (typeof candidate.checkVisibility === 'function') {
      if (!candidate.checkVisibility({ checkVisibilityCSS: true })) return false;
      // Layout is real here, so an empty leaf box is not something a user can see.
      const rect = element.getBoundingClientRect();
      return !(rect.width === 0 && rect.height === 0 && element.childElementCount === 0);
    }
    if (typeof globalThis.getComputedStyle === 'function') {
      const style = globalThis.getComputedStyle(element);
      if (style?.display === 'none' || style?.visibility === 'hidden') return false;
    }
    return true;
  }

  function collapseText(value: string | null | undefined, budget: number = 200): string {
    const collapsed = String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    return collapsed.length > budget ? collapsed.slice(0, budget) : collapsed;
  }

  /** Rendered-ish text of a subtree, skipping script/style content and
descending into shadow roots. */
  function getElementTextContent(element: Element, budget: number = 200): string {
    if (NON_RENDERED_TAGS.has(element.tagName)) return '';
    const elementShadowRoot = getShadowRoot(element);
    if (!elementShadowRoot && element.childNodes.length === 0)
      return collapseText(element.textContent, budget);
    const parts: string[] = [];
    let length = 0;
    const stack: Array<{ children: NodeListOf<ChildNode>; index: number }> = [
      { children: (elementShadowRoot ?? element).childNodes, index: 0 },
    ];
    let scanned = 0;
    while (stack.length && length < budget && scanned++ < DEEP_SCAN_LIMIT) {
      const current = stack[stack.length - 1];
      if (current.index >= current.children.length) {
        stack.pop();
        continue;
      }
      const node = current.children[current.index++];
      if (node.nodeType === 3) {
        const text = (node.textContent || '').slice(0, budget - length);
        parts.push(text);
        length += text.length;
        continue;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11) continue;
      if (node.nodeType === 1 && NON_RENDERED_TAGS.has((node as Element).tagName)) continue;
      const root = node.nodeType === 1 ? getShadowRoot(node as Element) : null;
      stack.push({ children: (root ?? node).childNodes, index: 0 });
    }
    return collapseText(parts.join(' '), budget);
  }

  /** Resolve ids from aria-labelledby within the element's own tree scope. */
  function getTextForIdRefs(element: Element, ids: string): string {
    const rootNode = typeof element.getRootNode === 'function' ? element.getRootNode() : document;
    const scope = rootNode as { getElementById?: (id: string) => Element | null };
    return ids
      .split(/\s+/u)
      .filter(Boolean)
      .map((id) => {
        const target =
          (typeof scope.getElementById === 'function' ? scope.getElementById(id) : null) ||
          document.getElementById?.(id) ||
          document.querySelector?.(
            typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
              ? `#${CSS.escape(id)}`
              : `[id="${escapeAttributeValue(id)}"]`
          );
        return target ? getElementTextContent(target) : '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  /** Escape a value for use inside a double-quoted attribute selector. */
  function escapeAttributeValue(value: string): string {
    return value.replace(/["\\]/g, '\\$&');
  }

  /** Text of the `<label>` elements associated with a form control. */
  function getAssociatedLabelText(element: Element): string {
    const labels: Element[] = [];
    const native = (element as { labels?: ArrayLike<Element> | null }).labels;
    if (native && typeof native.length === 'number' && native.length > 0) {
      labels.push(...Array.from(native));
    } else {
      const id = element.getAttribute('id');
      const rootNode = typeof element.getRootNode === 'function' ? element.getRootNode() : document;
      const scope = rootNode as ParentNode;
      if (id && typeof scope.querySelectorAll === 'function') {
        labels.push(...scope.querySelectorAll(`label[for="${escapeAttributeValue(id)}"]`));
      }
      const wrapping = typeof element.closest === 'function' ? element.closest('label') : null;
      if (wrapping && !labels.includes(wrapping)) labels.push(wrapping);
    }
    return labels
      .map((label) => getElementTextContent(label))
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  /** ARIA roles an element matches: the explicit role, else its implicit role
plus lenient aliases (a single `<select>` is a combobox in Chrome's AX tree
but historically matched `listbox` here). */
  function getElementRoles(element: Element): string[] {
    const explicit = element.getAttribute('role')?.trim().split(/\s+/u)[0];
    if (explicit) return [explicit.toLowerCase()];
    const tag = element.tagName.toLowerCase();
    if (tag === 'select') {
      const select = element as HTMLSelectElement;
      return select.multiple || Number(select.size) > 1 ? ['listbox'] : ['combobox', 'listbox'];
    }
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return [];
      if (type === 'number') return ['spinbutton', 'textbox'];
      if (
        element.hasAttribute('list') &&
        ['text', 'search', 'email', 'tel', 'url'].includes(type)
      ) {
        return ['combobox', 'textbox'];
      }
    }
    if (tag === 'summary') return ['button'];
    if (tag === 'img' && element.getAttribute('alt') === '') return ['presentation'];
    if (
      (element as { isContentEditable?: boolean }).isContentEditable === true &&
      element.getAttribute('contenteditable') !== null
    ) {
      return ['textbox'];
    }
    const implicit = getImplicitRole(element);
    return implicit ? [implicit] : [];
  }

  /** Practical accessible-name computation covering the common sources:
aria-labelledby, aria-label, associated labels, alt, button values,
content for name-from-content roles, title, and placeholder. */
  function getAccessibleName(element: Element): string {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = getTextForIdRefs(element, labelledBy);
      if (text) return text;
    }
    const ariaLabel = collapseText(element.getAttribute('aria-label'));
    if (ariaLabel) return ariaLabel;

    const tag = element.tagName;
    const type = (element.getAttribute('type') || '').toLowerCase();
    if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(type)) {
      const value = collapseText(element.getAttribute('value'));
      if (value) return value;
      if (type !== 'button') return type === 'submit' ? 'Submit' : 'Reset';
    }
    if (LABELABLE_TAGS.has(tag) && !(tag === 'INPUT' && type === 'hidden')) {
      const labelText = getAssociatedLabelText(element);
      if (labelText) return labelText;
    }
    if (tag === 'IMG' || tag === 'AREA' || (tag === 'INPUT' && type === 'image')) {
      const alt = collapseText(element.getAttribute('alt'));
      if (alt) return alt;
    }
    if (tag === 'FIELDSET') {
      const legend = element.querySelector?.(':scope > legend');
      if (legend) return getElementTextContent(legend);
    }
    const roles = getElementRoles(element);
    if (roles.some((role) => NAME_FROM_CONTENT_ROLES.has(role)) || tag === 'LABEL') {
      const content = getElementTextContent(element);
      if (content) return content;
    }
    return (
      collapseText(element.getAttribute('title')) ||
      collapseText(element.getAttribute('placeholder')) ||
      ''
    );
  }

  globalState.__BBX_CONTENT_HELPERS__ = Object.freeze({
    NON_TEXT_INPUT_TYPES,
    applyBudget,
    clamp,
    delay,
    escapeTailwindSelector,
    extractElementText,
    findElementForWaitState,
    getImplicitRole,
    getImplicitRoleSelector,
    getInputImplicitRole,
    NON_RENDERED_TAGS,
    collapseText,
    getAccessibleName,
    getElementRoles,
    getElementTextContent,
    getShadowRoot,
    isElementVisible,
    isNodeAttached,
    querySelectorAllDeep,
    querySelectorDeep,
    walkElementsDeep,
    normalizeList,
    pruneElementRegistryEntries,
    toRect,
    truncateText,
  });
})();
