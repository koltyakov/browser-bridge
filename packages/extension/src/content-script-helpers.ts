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
  // Element traversals (selector matching, shadow-root discovery, locators)
  // are cheap per element, so they get a larger bound than text collection.
  // The time bound still protects hostile DOMs on the page's main thread.
  const DEEP_WALK_LIMIT = 200_000;
  const DEEP_WALK_TIME_MS = 1_000;
  // attachShadow() only accepts these built-in elements or custom elements, so
  // other tags never need the comparatively expensive closed-root lookup.
  const SHADOW_HOST_TAGS = new Set([
    'ARTICLE',
    'ASIDE',
    'BLOCKQUOTE',
    'BODY',
    'DIV',
    'FOOTER',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HEADER',
    'MAIN',
    'NAV',
    'P',
    'SECTION',
    'SPAN',
  ]);
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

  // Read-only scans memoize closed shadow-root lookups and the document's
  // label associations. Page scripts cannot change either while a synchronous
  // scan runs, and caching is limited to that scope so event dispatch is never
  // followed by a stale lookup.
  let scanCacheDepth = 0;
  let closedShadowRootCache: Map<Element, ShadowRoot | null> | null = null;
  let documentLabelIndex: Map<Element, Element[]> | null = null;

  /** Run a synchronous, read-only DOM scan with per-scan lookup caches. */
  function withDomScanCache<T>(scan: () => T): T {
    if (scanCacheDepth === 0) {
      closedShadowRootCache = new Map();
      documentLabelIndex = null;
    }
    scanCacheDepth += 1;
    try {
      return scan();
    } finally {
      scanCacheDepth -= 1;
      if (scanCacheDepth === 0) {
        closedShadowRootCache = null;
        documentLabelIndex = null;
      }
    }
  }

  /** Return an element's shadow root, including closed roots when the extension
`chrome.dom` API is available to the content script. */
  function getShadowRoot(element: Element): ShadowRoot | null {
    const open = (element as { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (open) return open;
    const tag = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
    if (tag && !tag.includes('-') && !SHADOW_HOST_TAGS.has(tag)) return null;
    const cached = closedShadowRootCache?.get(element);
    if (cached !== undefined) return cached;
    const domApi = (
      globalThis as {
        chrome?: { dom?: { openOrClosedShadowRoot?: (element: HTMLElement) => ShadowRoot | null } };
      }
    ).chrome?.dom;
    if (typeof domApi?.openOrClosedShadowRoot !== 'function') return null;
    let root: ShadowRoot | null = null;
    try {
      root = domApi.openOrClosedShadowRoot(element as HTMLElement) || null;
    } catch {
      root = null;
    }
    closedShadowRootCache?.set(element, root);
    return root;
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
    for (const element of walkElementsDeep(root, DEEP_WALK_LIMIT + 1)) {
      if (++scanned > DEEP_WALK_LIMIT || performance.now() - started > DEEP_WALK_TIME_MS)
        throw scanLimitError();
      const shadowRoot = getShadowRoot(element);
      if (shadowRoot) yield shadowRoot;
    }
  }

  /** `querySelectorAll` that also searches open (and, for the extension, closed)
shadow roots. Light-DOM matches come first. */
  function querySelectorAllDeep(selector: string, root: ParentNode = document): Element[] {
    return [...querySelectorMatchesDeep(selector, root)];
  }

  /** Complete, sparse selector reads use native matching in each tree. Only
  potential shadow hosts need root lookup; TreeWalker preserves the existing
  host -> shadow -> light-child order without calling matches on every node.
  Do not retain roots between reads: an existing host can acquire a shadow root
  without a light-DOM mutation. */
  function querySelectorAllDeepNative(selector: string, root: ParentNode = document): Element[] {
    if (typeof document.createTreeWalker !== 'function')
      return querySelectorAllDeep(selector, root);
    const started = performance.now();
    let scanned = 0;
    let found = 0;
    const results: Element[] = [];
    const stack: Array<{ walker: TreeWalker; matches: Set<Element> }> = [];
    const checkBudget = () => {
      if (scanned > DEEP_WALK_LIMIT || performance.now() - started > DEEP_WALK_TIME_MS)
        throw scanLimitError();
    };
    const enter = (scope: ParentNode) => {
      checkBudget();
      const matches = scope.querySelectorAll(selector);
      found += matches.length;
      if (found > DEEP_WALK_LIMIT) throw scanLimitError();
      checkBudget();
      stack.push({
        walker: document.createTreeWalker(scope as Node, 1),
        matches: new Set(matches),
      });
    };
    enter(root);
    const rootShadow =
      'nodeType' in root && root.nodeType === 1 ? getShadowRoot(root as Element) : null;
    if (rootShadow) enter(rootShadow);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const element = frame.walker.nextNode() as Element | null;
      if (!element) {
        stack.pop();
        continue;
      }
      scanned += 1;
      // Sample elapsed time, but retain the exact element-work limit.
      if (scanned > DEEP_WALK_LIMIT || scanned % 128 === 0) checkBudget();
      if (frame.matches.has(element)) results.push(element);
      const tag = element.tagName.toUpperCase();
      if (!tag.includes('-') && !SHADOW_HOST_TAGS.has(tag)) continue;
      const shadow = getShadowRoot(element);
      if (shadow) enter(shadow);
    }
    checkBudget();
    return results;
  }

  /** Iterate selector matches without scanning later subtrees when a bounded
consumer has enough results. Complete scans still enforce the work limit. */
  function* querySelectorMatchesDeep(
    selector: string,
    root: ParentNode = document
  ): Generator<Element> {
    // Validate even on an empty tree. :scope requires native tree-scoped CSS
    // semantics; ordinary selectors can be matched lazily without a NodeList
    // containing the entire document.
    root.querySelector(selector);
    if (selector.includes(':scope') || !('children' in root)) {
      let count = 0;
      const scopes = function* (): Generator<ParentNode> {
        yield root;
        yield* walkShadowRoots(root);
      };
      for (const scope of scopes()) {
        const matches = scope.querySelectorAll(selector);
        if (matches.length + count > DEEP_WALK_LIMIT) throw scanLimitError();
        count += matches.length;
        yield* matches;
      }
      return;
    }
    const started = performance.now();
    let scanned = 0;
    for (const element of walkElementsDeep(root, DEEP_WALK_LIMIT + 1)) {
      if (++scanned > DEEP_WALK_LIMIT || performance.now() - started > DEEP_WALK_TIME_MS)
        throw scanLimitError();
      if (element.matches(selector)) yield element;
    }
  }

  function scanLimitError(): Error {
    return Object.assign(
      new Error('DOM scan limit reached. Use a narrower selector or element scope.'),
      { code: 'RESULT_TRUNCATED', details: { scanLimit: DEEP_WALK_LIMIT } }
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
  function getElementTextContent(
    element: Element,
    budget: number = 200,
    onTruncated?: () => void
  ): string {
    if (NON_RENDERED_TAGS.has(element.tagName)) return '';
    const elementShadowRoot = getShadowRoot(element);
    if (!elementShadowRoot && element.childNodes.length === 0) {
      const text = element.textContent || '';
      if (onTruncated && text.length > budget) onTruncated();
      return collapseText(onTruncated ? text.slice(0, budget) : text, budget);
    }
    // Adjacent inline text joins without a space, as rendered ("<b>S</b>ave"
    // reads "Save"); block boundaries and line breaks separate words.
    const parts: string[] = [];
    let length = 0;
    const stack: Array<{ children: NodeListOf<ChildNode>; index: number; block: boolean }> = [
      { children: (elementShadowRoot ?? element).childNodes, index: 0, block: false },
    ];
    let scanned = 0;
    while (stack.length && length < budget && scanned++ < DEEP_SCAN_LIMIT) {
      const current = stack[stack.length - 1];
      if (current.index >= current.children.length) {
        stack.pop();
        if (current.block) parts.push(' ');
        continue;
      }
      const node = current.children[current.index++];
      if (node.nodeType === 3) {
        const source = node.textContent || '';
        if (onTruncated && source.length > budget - length) onTruncated();
        const text = source.slice(0, budget - length);
        parts.push(text);
        length += text.length;
        continue;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11) continue;
      const tag = node.nodeType === 1 ? String((node as Element).tagName).toUpperCase() : '';
      if (tag && NON_RENDERED_TAGS.has(tag)) continue;
      if (tag === 'BR') {
        parts.push(' ');
        continue;
      }
      const block = BLOCK_TEXT_TAGS.has(tag);
      if (block) parts.push(' ');
      const root = node.nodeType === 1 ? getShadowRoot(node as Element) : null;
      stack.push({ children: (root ?? node).childNodes, index: 0, block });
    }
    if (onTruncated && stack.length > 0) onTruncated();
    const text = parts.join('');
    if (onTruncated && text.length > budget) onTruncated();
    return collapseText(text, budget);
  }

  /** Resolve ids from aria-labelledby within the element's own tree scope. */
  function getTextForIdRefs(
    element: Element,
    ids: string,
    budget = 200,
    onTruncated?: () => void
  ): string {
    const rootNode = typeof element.getRootNode === 'function' ? element.getRootNode() : document;
    const scope = rootNode as { getElementById?: (id: string) => Element | null };
    if (onTruncated && ids.length > 4096) onTruncated();
    const references = (onTruncated ? ids.slice(0, 4096) : ids).split(/\s+/u).filter(Boolean);
    if (onTruncated && references.length > 16) onTruncated();
    return (onTruncated ? references.slice(0, 16) : references)
      .map((id) => {
        const target =
          (typeof scope.getElementById === 'function' ? scope.getElementById(id) : null) ||
          document.getElementById?.(id) ||
          document.querySelector?.(
            typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
              ? `#${CSS.escape(id)}`
              : `[id="${escapeAttributeValue(id)}"]`
          );
        return target ? getElementTextContent(target, budget, onTruncated) : '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  /** Escape a value for use inside a double-quoted attribute selector. */
  function escapeAttributeValue(value: string): string {
    return value.replace(/["\\]/g, '\\$&');
  }

  /** Labels associated with a control, in document order. */
  function getAssociatedLabels(element: Element): Element[] {
    const rootNode = typeof element.getRootNode === 'function' ? element.getRootNode() : document;
    // Chrome resolves `element.labels` by walking the element's whole tree
    // scope, so reading it for every control in a scan is quadratic. Scans
    // index the document's labels once instead.
    if (
      scanCacheDepth === 0 ||
      rootNode !== document ||
      typeof document.querySelectorAll !== 'function'
    ) {
      const native = (element as { labels?: ArrayLike<Element> | null }).labels;
      return native && typeof native.length === 'number' ? Array.from(native) : [];
    }
    if (!documentLabelIndex) {
      const index = new Map<Element, Element[]>();
      for (const label of document.querySelectorAll('label')) {
        const control = (label as { control?: Element | null }).control;
        if (!control) continue;
        const labels = index.get(control);
        if (labels) labels.push(label);
        else index.set(control, [label]);
      }
      documentLabelIndex = index;
    }
    return documentLabelIndex.get(element) ?? [];
  }

  /** Text of the `<label>` elements associated with a form control. */
  function getAssociatedLabelText(
    element: Element,
    budget = 200,
    onTruncated?: () => void
  ): string {
    const labels: Element[] = [];
    const native = getAssociatedLabels(element);
    if (native.length > 0) {
      if (onTruncated && native.length > 16) onTruncated();
      labels.push(...(onTruncated ? native.slice(0, 16) : native));
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
    if (onTruncated && labels.length > 16) onTruncated();
    return (onTruncated ? labels.slice(0, 16) : labels)
      .map((label) => getElementTextContent(label, budget, onTruncated))
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

  /** Whether a subtree holds any shadow root, within the deep-walk budget. */
  function hasShadowContent(root: Element): boolean {
    try {
      for (const shadowRoot of walkShadowRoots(root)) {
        if (shadowRoot) return true;
      }
    } catch {
      // Past the walk budget, treat the subtree as composed.
      return true;
    }
    return false;
  }

  function isRenderedForText(element: Element): boolean {
    const candidate = element as Element & { checkVisibility?: () => boolean };
    if (typeof candidate.checkVisibility === 'function') {
      if (candidate.checkVisibility()) return true;
      // Slots and display:contents wrappers have no box but render their children.
      try {
        return globalThis.getComputedStyle?.(element)?.display === 'contents';
      } catch {
        return false;
      }
    }
    if (element.hasAttribute?.('hidden')) return false;
    if (typeof globalThis.getComputedStyle !== 'function') return true;
    try {
      return globalThis.getComputedStyle(element)?.display !== 'none';
    } catch {
      return true;
    }
  }

  /** Visible text of a subtree as a reader sees it, including open (and, for
the extension, closed) shadow trees and slotted content, which innerText
leaves out. Pages without shadow DOM use innerText directly. */
  function getVisibleText(root: Element, maxChars = 2_000_000): string {
    const light = root as HTMLElement;
    if (!hasShadowContent(root)) {
      return (typeof light.innerText === 'string' ? light.innerText : root.textContent || '')
        .slice(0, maxChars)
        .trim();
    }
    const out: string[] = [];
    let length = 0;
    let visited = 0;
    const lineBreak = () => {
      const last = out[out.length - 1];
      if (last !== undefined && !last.endsWith('\n')) {
        out.push('\n');
        length += 1;
      }
    };
    const visit = (node: Node): void => {
      if (length >= maxChars || ++visited > DEEP_SCAN_LIMIT) return;
      if (node.nodeType === 3) {
        const parent = (node as Text).parentElement;
        const preformatted = parent?.closest?.('pre, textarea') != null;
        const text = preformatted
          ? node.textContent || ''
          : (node.textContent || '').replace(/\s+/g, ' ');
        if (!text) return;
        if (text === ' ' && (!out.length || /[\s]$/.test(out[out.length - 1]))) return;
        out.push(text);
        length += text.length;
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      let block = false;
      if (node.nodeType === 1) {
        const element = node as Element;
        const tag = String(element.tagName).toUpperCase();
        if (NON_RENDERED_TAGS.has(tag)) return;
        if (tag === 'BR') {
          out.push('\n');
          length += 1;
          return;
        }
        if (element !== root && !isRenderedForText(element)) return;
        block = BLOCK_TEXT_TAGS.has(tag);
        if (block) lineBreak();
      }
      const shadowRoot = node.nodeType === 1 ? getShadowRoot(node as Element) : null;
      const slot = node as Node & { assignedNodes?: (options?: { flatten?: boolean }) => Node[] };
      const assigned =
        node.nodeType === 1 &&
        String((node as Element).tagName).toUpperCase() === 'SLOT' &&
        typeof slot.assignedNodes === 'function'
          ? slot.assignedNodes({ flatten: true })
          : [];
      const children = shadowRoot
        ? shadowRoot.childNodes
        : assigned.length
          ? assigned
          : node.childNodes;
      for (const child of children ?? []) visit(child);
      if (block) lineBreak();
    };
    visit(root);
    return out
      .join('')
      .slice(0, maxChars)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** A budgeted window of text starting at offset, with the offset that
continues it when more text remains. */
  function readTextWindow(
    text: string,
    budget: number,
    offset = 0
  ): {
    value: string;
    truncated: boolean;
    omitted: number;
    length: number;
    offset?: number;
    nextOffset?: number;
  } {
    const start = Math.max(0, Math.min(Math.trunc(offset) || 0, text.length));
    const window = truncateText(text.slice(start), budget);
    return {
      ...window,
      length: text.length,
      ...(start ? { offset: start } : {}),
      ...(window.truncated ? { nextOffset: start + Math.max(1, budget - 1) } : {}),
    };
  }

  /** Elements whose box starts on its own line, so their text is a separate word. */
  const BLOCK_TEXT_TAGS = new Set([
    'ADDRESS',
    'ARTICLE',
    'ASIDE',
    'BLOCKQUOTE',
    'DD',
    'DETAILS',
    'DIALOG',
    'DIV',
    'DL',
    'DT',
    'FIELDSET',
    'FIGCAPTION',
    'FIGURE',
    'FOOTER',
    'FORM',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HEADER',
    'HR',
    'LEGEND',
    'LI',
    'MAIN',
    'NAV',
    'OL',
    'OPTION',
    'P',
    'PRE',
    'SECTION',
    'SUMMARY',
    'TABLE',
    'TBODY',
    'TD',
    'TFOOT',
    'TH',
    'THEAD',
    'TR',
    'UL',
  ]);

  const NAME_FROM_CONTENT_NODE_LIMIT = 2000;

  /** Whether a descendant is excluded from its ancestor's name. */
  function isHiddenFromName(element: Element): boolean {
    if (element.hasAttribute?.('hidden')) return true;
    if (element.getAttribute?.('aria-hidden') === 'true') return true;
    if (typeof globalThis.getComputedStyle !== 'function') return false;
    try {
      const style = globalThis.getComputedStyle(element);
      return style?.display === 'none' || style?.visibility === 'hidden';
    } catch {
      return false;
    }
  }

  /** Name a descendant contributes as a unit (accname step 2C-2E), or null to
recurse into its content. */
  function getEmbeddedName(element: Element): string | null {
    const ariaLabel = element.getAttribute('aria-label')?.trim();
    if (ariaLabel) return ariaLabel;
    const tag = String(element.tagName).toUpperCase();
    if (tag === 'IMG' || tag === 'AREA') {
      return element.getAttribute('alt') ?? element.getAttribute('title') ?? '';
    }
    if (tag === 'SVG') {
      const title = [...(element.children ?? [])].find(
        (child) => String(child.tagName).toUpperCase() === 'TITLE'
      );
      return title?.textContent?.trim() ?? '';
    }
    if (tag === 'INPUT') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type)) {
        return element.getAttribute('value') ?? '';
      }
      if (['checkbox', 'radio', 'file', 'hidden', 'image', 'range', 'color'].includes(type)) {
        return element.getAttribute('alt') ?? '';
      }
      return (element as HTMLInputElement).value ?? '';
    }
    if (tag === 'TEXTAREA') return (element as HTMLTextAreaElement).value ?? '';
    if (tag === 'SELECT') {
      const select = element as HTMLSelectElement;
      return [...(select.selectedOptions ?? [])]
        .map((option) => option.textContent ?? '')
        .join(' ');
    }
    return null;
  }

  /** Name from content, following the accessible-name algorithm closely
enough to match what assistive technology announces: inline text joins
without spaces, hidden descendants are skipped, and images, labelled
elements, SVG titles, and embedded controls contribute their own names. */
  function getNameFromContent(element: Element, budget = 200, onTruncated?: () => void): string {
    const parts: string[] = [];
    let length = 0;
    let visited = 0;
    let truncated = false;
    const pushText = (source: string, padded = false): void => {
      const room = budget - length;
      if (source.length > room) truncated = true;
      const text = source.slice(0, Math.max(0, room));
      parts.push(padded ? ` ${text} ` : text);
      length += text.length;
    };
    const visit = (node: Node, depth: number): void => {
      if (length >= budget || visited++ > NAME_FROM_CONTENT_NODE_LIMIT || depth > 32) {
        truncated = true;
        return;
      }
      if (node.nodeType === 3) {
        pushText(node.textContent || '');
        return;
      }
      const isElement = node.nodeType === 1 || node === element;
      if (!isElement && node.nodeType !== 11) return;
      let block = false;
      if (node.nodeType === 1 && node !== element) {
        const child = node as Element;
        const tag = String(child.tagName).toUpperCase();
        if (NON_RENDERED_TAGS.has(tag) || isHiddenFromName(child)) return;
        if (tag === 'BR') {
          parts.push(' ');
          return;
        }
        block = BLOCK_TEXT_TAGS.has(tag);
        const embedded = getEmbeddedName(child);
        if (embedded !== null) {
          pushText(embedded, block);
          return;
        }
      }
      const shadowRoot = isElement ? getShadowRoot(node as Element) : null;
      if (!shadowRoot && isElement && !node.childNodes?.length) {
        pushText(node.textContent || '', block);
        return;
      }
      if (block) parts.push(' ');
      const slot = node as Node & { assignedNodes?: (options?: { flatten?: boolean }) => Node[] };
      const assigned =
        isElement &&
        String((node as Element).tagName).toUpperCase() === 'SLOT' &&
        typeof slot.assignedNodes === 'function'
          ? slot.assignedNodes({ flatten: true })
          : [];
      const children = shadowRoot
        ? shadowRoot.childNodes
        : assigned.length
          ? assigned
          : node.childNodes;
      for (const childNode of children ?? []) visit(childNode, depth + 1);
      if (block) parts.push(' ');
    };
    visit(element, 0);
    if (truncated && onTruncated) onTruncated();
    return collapseText(parts.join(''), budget);
  }

  /** Practical accessible-name computation covering the common sources:
aria-labelledby, aria-label, associated labels, alt, button values,
content for name-from-content roles, title, and placeholder. */
  function getAccessibleName(element: Element, budget = 200, onTruncated?: () => void): string {
    const bounded = (text: string | null) => {
      if (onTruncated && text && text.length > budget) onTruncated();
      return collapseText(onTruncated ? text?.slice(0, budget) : text, budget);
    };
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = getTextForIdRefs(element, labelledBy, budget, onTruncated);
      if (text) return onTruncated ? bounded(text) : text;
    }
    const ariaLabel = bounded(element.getAttribute('aria-label'));
    if (ariaLabel) return ariaLabel;

    const tag = element.tagName;
    const type = (element.getAttribute('type') || '').toLowerCase();
    if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(type)) {
      const value = bounded(element.getAttribute('value'));
      if (value) return value;
      if (type !== 'button') return type === 'submit' ? 'Submit' : 'Reset';
    }
    if (LABELABLE_TAGS.has(tag) && !(tag === 'INPUT' && type === 'hidden')) {
      const labelText = getAssociatedLabelText(element, budget, onTruncated);
      if (labelText) return onTruncated ? bounded(labelText) : labelText;
    }
    if (tag === 'IMG' || tag === 'AREA' || (tag === 'INPUT' && type === 'image')) {
      const alt = bounded(element.getAttribute('alt'));
      if (alt) return alt;
    }
    if (tag === 'FIELDSET') {
      const legend = element.querySelector?.(':scope > legend');
      if (legend) return getElementTextContent(legend, budget, onTruncated);
    }
    const roles = getElementRoles(element);
    if (roles.some((role) => NAME_FROM_CONTENT_ROLES.has(role)) || tag === 'LABEL') {
      const content = getNameFromContent(element, budget, onTruncated);
      if (content) return content;
    }
    if (tag === 'svg' || tag === 'SVG') {
      const title = getEmbeddedName(element);
      if (title) return title;
    }
    return (
      bounded(element.getAttribute('title')) || bounded(element.getAttribute('placeholder')) || ''
    );
  }

  globalState.__BBX_CONTENT_HELPERS__ = Object.freeze({
    NON_TEXT_INPUT_TYPES,
    DEEP_WALK_LIMIT,
    DEEP_WALK_TIME_MS,
    applyBudget,
    clamp,
    delay,
    escapeTailwindSelector,
    extractElementText,
    findElementForWaitState,
    getAssociatedLabels,
    getImplicitRole,
    getImplicitRoleSelector,
    getInputImplicitRole,
    NON_RENDERED_TAGS,
    collapseText,
    getAccessibleName,
    getElementRoles,
    getElementTextContent,
    getShadowRoot,
    getVisibleText,
    isElementVisible,
    readTextWindow,
    isNodeAttached,
    querySelectorAllDeep,
    querySelectorAllDeepNative,
    querySelectorMatchesDeep,
    querySelectorDeep,
    walkElementsDeep,
    withDomScanCache,
    normalizeList,
    pruneElementRegistryEntries,
    toRect,
    truncateText,
  });
})();
