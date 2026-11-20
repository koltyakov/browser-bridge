(() => {
  const globalState = globalThis as typeof globalThis & {
    __BBX_CONTENT_DOM_QUERY__?: Record<string, unknown>;
  };

  if (globalState.__BBX_CONTENT_DOM_QUERY__) {
    return;
  }

  const contentHelpers = (
    globalThis as typeof globalThis & {
      __BBX_CONTENT_HELPERS__?: {
        applyBudget: (options?: Record<string, unknown>) => Budget;
        clamp: (value: unknown, minimum: number, maximum: number) => number;
        delay: (ms: number) => Promise<void>;
        extractElementText: (element: Element) => string;
        getAssociatedLabels: (element: Element) => Element[];
        findElementForWaitState: (options: {
          elements: Iterable<Element>;
          waitState: 'visible' | 'hidden';
          getRect: (element: Element) => { width: number; height: number };
          getVisibility: (element: Element) => string;
        }) => Element | null;
        getImplicitRole: (element: Element) => string;
        getImplicitRoleSelector: (role: string) => string;
        toRect: (rect: DOMRect | DOMRectReadOnly) => {
          x: number;
          y: number;
          width: number;
          height: number;
        };
        truncateText: (
          value: string,
          budget: number
        ) => { value: string; truncated: boolean; omitted: number };
        NON_RENDERED_TAGS: Set<string>;
        collapseText: (value: string | null | undefined, budget?: number) => string;
        escapeTailwindSelector: (selector: string) => string;
        getAccessibleName: (element: Element, budget?: number, onTruncated?: () => void) => string;
        getElementRoles: (element: Element) => string[];
        getElementTextContent: (
          element: Element,
          budget?: number,
          onTruncated?: () => void
        ) => string;
        getShadowRoot: (element: Element) => ShadowRoot | null;
        isElementVisible: (element: Element) => boolean;
        querySelectorMatchesDeep: (selector: string, root?: ParentNode) => Generator<Element>;
        querySelectorDeep: (selector: string, root?: ParentNode) => Element | null;
        walkElementsDeep: (root?: ParentNode, limit?: number) => Generator<Element>;
        withDomScanCache: <T>(scan: () => T) => T;
        DEEP_WALK_LIMIT: number;
        DEEP_WALK_TIME_MS: number;
      };
    }
  ).__BBX_CONTENT_HELPERS__;
  const registry = (
    globalThis as typeof globalThis & {
      __BBX_CONTENT_REGISTRY__?: {
        consumePruned: () => boolean;
        getDocumentRevision: () => number;
        getRegistrySize: () => number;
        getRequiredElement: (ref: string) => Element;
        normalizeDomQuery: (params?: Record<string, unknown>) => NormalizedDomQuery;
        rememberElement: (element: Element, retain?: boolean) => string;
        resolveTarget: (target?: { elementRef?: string; selector?: string }) => Element;
      };
    }
  ).__BBX_CONTENT_REGISTRY__;
  if (!contentHelpers || !registry) {
    throw new Error('Browser Bridge helpers and registry must load before content-dom-query.js.');
  }

  const {
    DEEP_WALK_LIMIT,
    DEEP_WALK_TIME_MS,
    NON_RENDERED_TAGS,
    clamp,
    collapseText,
    delay,
    escapeTailwindSelector,
    extractElementText,
    findElementForWaitState,
    getAssociatedLabels,
    getAccessibleName,
    getElementRoles,
    getElementTextContent,
    getShadowRoot,
    isElementVisible,
    querySelectorMatchesDeep,
    querySelectorDeep,
    toRect,
    truncateText,
    walkElementsDeep,
    withDomScanCache,
  } = contentHelpers;
  const {
    consumePruned,
    getDocumentRevision,
    getRegistrySize,
    getRequiredElement,
    normalizeDomQuery,
    rememberElement,
  } = registry;

  type Budget = {
    maxNodes: number;
    maxDepth: number;
    textBudget: number;
    includeBbox: boolean;
    attributeAllowlist: string[];
  };

  type NormalizedDomQuery = {
    selector: string;
    withinRef: string | null;
    budget: Budget;
  };

  type NodeSummary = {
    elementRef: string;
    tag: string;
    role: string | null;
    name: string | null;
    textExcerpt: string;
    attrs: Record<string, string | null>;
    bbox?: { x: number; y: number; width: number; height: number };
  };

  /** Perform a bounded breadth-first DOM summary rooted at a selector or existing
element reference. */
  function domQuery(params: Record<string, unknown>): {
    nodes: NodeSummary[];
    revision: number;
    truncated?: boolean;
    matchCount?: number;
    registrySize: number;
    _registryPruned?: boolean;
  } {
    const query = normalizeDomQuery(params);
    const root = query.withinRef
      ? getRequiredElement(query.withinRef)
      : querySelectorDeep(query.selector);
    if (!root) {
      return {
        nodes: [],
        revision: getDocumentRevision(),
        registrySize: getRegistrySize(),
      };
    }

    const nodes: NodeSummary[] = [];
    let remaining = query.budget.textBudget;

    const queue: Array<{ element: Element; depth: number }> = [{ element: root, depth: 0 }];
    let queueIndex = 0;
    let truncatedByQueueCap = false;

    while (queueIndex < queue.length && nodes.length < query.budget.maxNodes && remaining > 0) {
      const next = queue[queueIndex];
      queueIndex += 1;
      const { element, depth } = next;
      if (depth > query.budget.maxDepth) {
        continue;
      }

      const summary = summarizeNode(
        element,
        query.budget.attributeAllowlist,
        remaining,
        query.budget.includeBbox
      );
      remaining -= summary.textLength;
      nodes.push(summary.node);

      if (depth >= query.budget.maxDepth) {
        if (element.children.length > 0) {
          truncatedByQueueCap = true;
        }
        continue;
      }

      for (const child of element.children) {
        if (nodes.length + (queue.length - queueIndex) >= query.budget.maxNodes) {
          truncatedByQueueCap = true;
          break;
        }
        queue.push({ element: child, depth: depth + 1 });
      }
    }

    // The result is the first match's subtree. Say when the selector matched
    // more, so a broad selector is not mistaken for a complete list. The
    // native light-DOM count stays cheap on large pages.
    const matchCount = query.withinRef ? 0 : document.querySelectorAll(query.selector).length;
    const pruned = consumePruned();
    return {
      nodes,
      revision: getDocumentRevision(),
      ...(matchCount > 1 ? { matchCount } : {}),
      truncated: truncatedByQueueCap || queueIndex < queue.length || remaining <= 0,
      registrySize: getRegistrySize(),
      ...(pruned ? { _registryPruned: true } : {}),
    };
  }

  /** Create a compact, token-efficient summary for a single element. */
  function summarizeNode(
    element: Element,
    attributeAllowlist: string[],
    remainingText: number,
    includeBbox: boolean
  ): { textLength: number; node: NodeSummary } {
    const elementRef = rememberElement(element);
    const text = truncateText(
      extractElementText(element),
      Math.min(Math.max(0, remainingText), 160)
    );
    return {
      textLength: text.value.length,
      node: {
        elementRef,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role'),
        name: element.getAttribute('aria-label') || element.getAttribute('name') || null,
        textExcerpt: text.value,
        attrs: summarizeAttributes(element, attributeAllowlist),
        ...(includeBbox ? { bbox: toRect(element.getBoundingClientRect()) } : {}),
      },
    };
  }

  /** Extract only allowlisted attributes from an element. */
  function summarizeAttributes(
    element: Element,
    attributeAllowlist: string[]
  ): Record<string, string | null> {
    if (!attributeAllowlist.length) {
      return {};
    }
    return attributeAllowlist.reduce(
      (accumulator, attribute) => {
        if (element.hasAttribute(attribute)) {
          accumulator[attribute] = element.getAttribute(attribute);
        }
        return accumulator;
      },
      {} as Record<string, string | null>
    );
  }

  /** Describe a known element reference. */
  function describeElement(elementRef: string): {
    elementRef: string;
    tag: string;
    text: { value: string; truncated: boolean; omitted: number };
    bbox: { x: number; y: number; width: number; height: number };
  } {
    const element = getRequiredElement(elementRef);
    return {
      elementRef,
      tag: element.tagName.toLowerCase(),
      text: truncateText(extractElementText(element), 300),
      bbox: toRect(element.getBoundingClientRect()),
    };
  }

  /** Return bounded text content for an element. */
  function getText(
    elementRef: string,
    budget: number = 600
  ): { value: string; truncated: boolean; omitted: number } {
    const element = getRequiredElement(elementRef) as HTMLElement;
    return truncateText((element.innerText || element.textContent || '').trim(), budget);
  }

  /** Read a selected set of attributes from an element reference. */
  function getAttributes(elementRef: string, attributes: string[]): Record<string, string | null> {
    const element = getRequiredElement(elementRef);
    return attributes.reduce(
      (accumulator, attribute) => {
        if (element.hasAttribute(attribute)) {
          accumulator[attribute] = element.getAttribute(attribute);
        }
        return accumulator;
      },
      {} as Record<string, string | null>
    );
  }

  /** Return the box model rectangle for an element. */
  function getBoxModel(elementRef: string): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    return toRect(getRequiredElement(elementRef).getBoundingClientRect());
  }

  /** Resolve the topmost element at a viewport coordinate into a compact summary. */
  function hitTest(x: number, y: number): NodeSummary | null {
    const element = document.elementFromPoint(x, y);
    return element ? summarizeNode(element, ['id', 'class'], 120, true).node : null;
  }

  /** Read computed CSS properties for an element reference. */
  function getComputedStyles(
    elementRef: string,
    properties: string[] = []
  ): Record<string, string> {
    const styles = window.getComputedStyle(getRequiredElement(elementRef));
    const requested = properties.length
      ? properties
      : ['display', 'position', 'width', 'height', 'color'];
    return requested.reduce(
      (accumulator, property) => {
        accumulator[property] = styles.getPropertyValue(property);
        return accumulator;
      },
      {} as Record<string, string>
    );
  }

  /** Return simple matched-rule context for an element. */
  function getMatchedRules(elementRef: string): {
    elementRef: string;
    classes: string[];
    inlineStyle: string;
  } {
    const element = getRequiredElement(elementRef);
    return {
      elementRef,
      classes: [...element.classList],
      inlineStyle: element.getAttribute('style') || '',
    };
  }

  // Keep in sync with MAX_HTML_LENGTH / MAX_PRUNED_HTML_LENGTH in protocol defaults.
  const MAX_HTML_LENGTH = 50_000;
  const MAX_PRUNED_HTML_LENGTH = 400_000;
  // Chrome caps a native message at 1 MiB; leave room for JSON escaping.
  const MAX_PRUNED_HTML_BYTES = 768 * 1024;
  const PRUNED_HTML_DROPPED_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'SVG',
    'IFRAME',
    'FRAME',
    'OBJECT',
    'EMBED',
    'LINK',
    'META',
    'CANVAS',
  ]);
  // Structure and Readability scoring use these; everything else is dropped.
  const PRUNED_HTML_ATTRIBUTES = new Set([
    'id',
    'class',
    'role',
    'href',
    'src',
    'alt',
    'title',
    'lang',
    'dir',
    'colspan',
    'rowspan',
    'start',
    'datetime',
    'itemprop',
    'aria-label',
  ]);
  const PRUNED_HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden/i;

  /** Copy of an element without inert, hidden, or presentational payload. */
  function prunedClone(element: Element): Element {
    const clone = element.cloneNode(true) as Element;
    const stack: Element[] = [clone];
    while (stack.length) {
      const current = stack.pop() as Element;
      for (const attribute of [...current.attributes]) {
        if (!PRUNED_HTML_ATTRIBUTES.has(attribute.name)) current.removeAttribute(attribute.name);
      }
      for (const node of [...current.childNodes]) {
        if (node.nodeType === 8) {
          current.removeChild(node);
          continue;
        }
        if (node.nodeType !== 1) continue;
        const child = node as Element;
        if (
          PRUNED_HTML_DROPPED_TAGS.has(child.tagName.toUpperCase()) ||
          child.hasAttribute('hidden') ||
          child.getAttribute('aria-hidden') === 'true' ||
          PRUNED_HIDDEN_STYLE.test(child.getAttribute('style') ?? '')
        ) {
          current.removeChild(child);
        } else {
          stack.push(child);
        }
      }
    }
    return clone;
  }

  /** Return innerHTML or outerHTML of an element, truncated to budget. */
  function getHtml(params: Record<string, unknown>): {
    html: string;
    truncated: boolean;
    omitted: number;
  } {
    const element = getRequiredElement(String(params.elementRef || ''));
    const outer = Boolean(params.outer);
    const prune = params.prune === true;
    const maxLength = clamp(
      params.maxLength ?? 2000,
      32,
      prune ? MAX_PRUNED_HTML_LENGTH : MAX_HTML_LENGTH
    );
    const source = prune ? prunedClone(element) : element;
    const raw = outer ? source.outerHTML : source.innerHTML;
    let t = truncateText(raw, maxLength);
    if (prune) {
      const bytes = new TextEncoder().encode(t.value).length;
      if (bytes > MAX_PRUNED_HTML_BYTES) {
        const budget = Math.floor((t.value.length * MAX_PRUNED_HTML_BYTES) / bytes);
        t = { ...truncateText(raw, budget), truncated: true };
      }
    }
    return { html: t.value, truncated: t.truncated, omitted: t.omitted };
  }

  // All pending frame-aware waits in this document share one load listener.
  // window.length counts direct child browsing contexts across origins without
  // walking added subtrees or touching another document.
  let frameWaitCount = 0;
  let childFrameCount = 0;
  function signalFrameChange() {
    if (globalThis.chrome?.runtime?.id)
      void chrome.runtime.sendMessage({ type: 'bridge.frame-tree-changed' }).catch(() => {});
  }
  function onFrameLoad(event: Event) {
    if (
      event.isTrusted &&
      event.target instanceof Element &&
      (event.target.tagName === 'IFRAME' || event.target.tagName === 'FRAME')
    )
      signalFrameChange();
  }
  function monitorFrameTree() {
    if (frameWaitCount++ === 0) {
      childFrameCount = window.length;
      document.addEventListener('load', onFrameLoad, true);
    }
    return () => {
      if (--frameWaitCount === 0) document.removeEventListener('load', onFrameLoad, true);
    };
  }

  /** Wait for a DOM condition using MutationObserver + polling fallback. */
  function waitForDom(
    params: Record<string, unknown>
  ): Promise<{ found: boolean; elementRef: string | null; duration: number }> {
    const text = typeof params.text === 'string' && params.text.trim() ? String(params.text) : null;
    const selector = String(params.selector || (text !== null ? '*' : ''));
    if (!selector && text === null) {
      throw new Error('selector or text is required for dom.wait_for');
    }
    const waitState = params.state || 'attached';
    const timeout = clamp(params.timeoutMs ?? 5000, 100, 30000);
    const start = Date.now();

    function check(): { found: boolean; element: Element | null } {
      return withDomScanCache(checkOnce);
    }

    function checkOnce(): { found: boolean; element: Element | null } {
      if (typeof params.__bbxAssertActive === 'function') params.__bbxAssertActive();
      if (waitState === 'detached') {
        const exists = text
          ? findElementWithText(selector, text) !== null
          : querySelectorDeep(selector) !== null;
        return { found: !exists, element: null };
      }
      let hasMatches = false;
      function* matchingCandidates(): Generator<Element> {
        const index = text !== null ? createTextIndex(text) : null;
        for (const element of querySelectorMatchesDeep(selector)) {
          if (text !== null && !elementMatchesText(element, text, index)) continue;
          hasMatches = true;
          yield element;
        }
      }
      const matched = matchingCandidates();
      if (waitState !== 'visible' && waitState !== 'hidden') {
        const first = matched.next();
        return { found: !first.done, element: first.value ?? null };
      }

      const matchedElement = findElementForWaitState({
        elements: matched,
        waitState: waitState === 'hidden' ? 'hidden' : 'visible',
        getRect: (element) => element.getBoundingClientRect(),
        getVisibility: (element) => getComputedStyle(element).visibility,
      });
      if (waitState === 'hidden' && !hasMatches) {
        return { found: true, element: null };
      }
      return { found: matchedElement !== null, element: matchedElement };
    }

    const immediate = check();
    if (immediate.found) {
      return Promise.resolve({
        found: true,
        elementRef: immediate.element ? rememberElement(immediate.element) : null,
        duration: 0,
      });
    }

    // Timers go through delay() so a hidden tab is not held to Chrome's
    // one-second timer alignment for the debounce, poll, or timeout.
    return new Promise((resolve, reject) => {
      let settled = false;
      let checkScheduled = false;
      const stopMonitoring = params.__bbxWatchFrameTree === true ? monitorFrameTree() : undefined;
      const observer = new MutationObserver(() => {
        if (stopMonitoring && window.length !== childFrameCount) {
          childFrameCount = window.length;
          signalFrameChange();
        }
        scheduleObserverCheck();
      });
      const signal = params.__bbxSignal as AbortSignal | undefined;
      function cleanup() {
        settled = true;
        observer.disconnect();
        stopMonitoring?.();
        signal?.removeEventListener('abort', tryResolve);
      }

      function finish(result: { found: boolean; elementRef: string | null; duration: number }) {
        if (settled) return;
        cleanup();
        resolve(result);
      }

      function tryResolve() {
        if (settled) return;
        let result: ReturnType<typeof check>;
        try {
          result = check();
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        if (result.found) {
          finish({
            found: true,
            elementRef: result.element ? rememberElement(result.element) : null,
            duration: Date.now() - start,
          });
        }
      }

      function scheduleObserverCheck() {
        if (checkScheduled || settled) return;
        checkScheduled = true;
        void delay(50).then(() => {
          checkScheduled = false;
          tryResolve();
        });
      }

      async function poll() {
        while (!settled) {
          await delay(Math.min(250, Math.max(0, start + timeout - Date.now())));
          if (settled) return;
          tryResolve();
          if (Date.now() - start >= timeout) {
            finish({ found: false, elementRef: null, duration: Date.now() - start });
          }
        }
      }

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      signal?.addEventListener('abort', tryResolve, { once: true });
      void poll();
    });
  }

  // Semantic evaluations per locator scan match the traversal bound: text and
  // name pruning keep each evaluation small, and the walk deadline caps time.
  const LOCATE_EVALUATION_LIMIT = DEEP_WALK_LIMIT;
  // A locator answers one explicit agent action and must prove uniqueness over
  // the whole page, so it may run longer than a plain selector walk.
  const LOCATE_TIME_BUDGET_MS = Math.max(DEEP_WALK_TIME_MS, 2_000);

  type ElementLocator = {
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

  type LocateResult = {
    matches: Element[];
    visibleOnly: boolean;
    hiddenMatches: number;
    scanned: number;
    truncationReason: 'maxResults' | 'scanLimit' | null;
  };

  const LOCATOR_KEYS = ['role', 'name', 'text', 'label', 'placeholder', 'testId'] as const;
  const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-qa'];

  function isLocator(value: unknown): value is ElementLocator {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return LOCATOR_KEYS.some((key) => typeof record[key] === 'string' && record[key] !== '');
  }

  type TextMatcher = (haystack: string) => boolean;

  /** Normalize the needle once per scan, not once per element or text part.
  Substring haystacks intentionally keep their existing whitespace semantics. */
  function createTextMatcher(needle: string, exact: boolean): TextMatcher {
    const normalized = collapseText(needle, 10_000);
    if (exact)
      return (haystack) => Boolean(haystack) && collapseText(haystack, 100_000) === normalized;
    const lowered = normalized.toLowerCase();
    return (haystack) => Boolean(haystack) && haystack.toLowerCase().includes(lowered);
  }

  function textPartsMatch(text: string, matches: TextMatcher): boolean {
    return text.includes(' | ') ? text.split(' | ').some(matches) : matches(text);
  }

  function textValueMatches(value: unknown, matches: TextMatcher): boolean {
    return (
      typeof value === 'string' &&
      value.length > 0 &&
      textPartsMatch(collapseText(value, 100_000), matches)
    );
  }

  /** Full collapsed subtree text used for innermost text matching. Shadow hosts
contribute their shadow content. */
  function getMatchableText(element: Element): string {
    return getElementTextContent(element, 100_000);
  }

  type TextIndex = {
    matches: TextMatcher;
    text: (element: Element) => string;
    excluded: (element: Element) => boolean;
    /** Whether the element's complete subtree text provably lacks the needle. */
    lacks: (element: Element) => boolean;
  };

  /** Per-scan subtree text cache. Each element's text is collected once, and a
complete subtree text without the needle proves that no descendant included
in it can match by subtree text either. Without this, a document-order scan
re-reads every ancestor's whole subtree, which is quadratic on large pages. */
  function createTextIndex(needle: string, exact = false): TextIndex {
    const lowered = collapseText(needle, 10_000).toLowerCase();
    const texts = new Map<Element, string>();
    const excluded = new WeakSet<Element>();
    // The ancestor whose collected text contains this element's text: shadow
    // content is read through its host, while a host's light children are not.
    const textParent = (element: Element): Element | null => {
      const parent = element.parentNode;
      if (!parent) return null;
      if (parent.nodeType === 11) return (parent as ShadowRoot).host ?? null;
      if (parent.nodeType !== 1 || !excluded.has(parent as Element)) return null;
      return getShadowRoot(parent as Element) ? null : (parent as Element);
    };
    return {
      matches: createTextMatcher(needle, exact),
      text(element) {
        let text = texts.get(element);
        if (text === undefined) {
          let complete = true;
          text = getElementTextContent(element, 100_000, () => {
            complete = false;
          });
          texts.set(element, text);
          if (complete && !text.toLowerCase().includes(lowered)) excluded.add(element);
        }
        return text;
      },
      excluded(element) {
        if (excluded.has(element)) return true;
        const parent = textParent(element);
        if (parent && excluded.has(parent)) {
          excluded.add(element);
          return true;
        }
        return false;
      },
      lacks(element) {
        if (this.excluded(element)) return true;
        this.text(element);
        return excluded.has(element);
      },
    };
  }

  // Accessible-name sources outside an element's own subtree text.
  const NAME_SOURCE_ATTRIBUTES = ['aria-labelledby', 'aria-label', 'alt', 'title', 'placeholder'];
  const LABELABLE_NAME_TAGS = new Set([
    'INPUT',
    'SELECT',
    'TEXTAREA',
    'BUTTON',
    'METER',
    'OUTPUT',
    'PROGRESS',
  ]);

  /** True when no accessible-name source of this element can contain the
needle: no naming attributes, no associated label containing it, no input
value or default button name, and subtree text that lacks it. */
  function nameCannotContain(element: Element, index: TextIndex): boolean {
    if (NAME_SOURCE_ATTRIBUTES.some((attribute) => element.hasAttribute(attribute))) return false;
    const tag = element.tagName.toUpperCase();
    if (LABELABLE_NAME_TAGS.has(tag)) {
      if (tag === 'INPUT') return false;
      // Mirror getAccessibleName: associated labels, else a wrapping label (the
      // id-based fallback is left to the full name computation).
      let labels = getAssociatedLabels(element);
      if (!labels.length) {
        if (element.getAttribute('id')) return false;
        const wrapping = element.closest?.('label');
        labels = wrapping ? [wrapping] : [];
      }
      for (const label of labels) if (!index.lacks(label)) return false;
    }
    return index.lacks(element);
  }

  const OWN_TEXT_ATTRIBUTES = ['aria-label', 'name', 'placeholder', 'title'];

  /** extractElementText matching for an element whose subtree text lacks the
needle. Its text nodes are then only a match when the element joins
several of them across child elements; attributes and values still count. */
  function excludedOwnTextMatches(element: Element, matches: TextMatcher): boolean {
    // Most table cells carry no attributes. Keep attributes and live values
    // eligible even when their subtree text has been ruled out.
    if (element.hasAttributes?.() !== false) {
      for (const attribute of OWN_TEXT_ATTRIBUTES) {
        if (textValueMatches(element.getAttribute(attribute), matches)) return true;
      }
    }
    if ('value' in element && textValueMatches((element as { value?: unknown }).value, matches))
      return true;
    // One text node is part of the subtree text, which lacks the needle.
    const children = element.childNodes;
    if (children.length < 2) return false;
    let textNodes = 0;
    for (const node of children) {
      if (node.nodeType === 3 && (node.textContent ?? '').trim() && ++textNodes > 1) {
        const own = extractElementText(element);
        return Boolean(own) && textPartsMatch(own, matches);
      }
    }
    return false;
  }

  /** Match visible text the way a user reads it: own text and text-like
attributes first, otherwise the innermost element whose combined
descendant text matches (so `<button><b>Place</b> order</button>` matches
"Place order" on the button, not on `<body>`). */
  function matchesTextLocator(
    element: Element,
    matches: TextMatcher,
    index: TextIndex | null = null
  ): boolean {
    if (NON_RENDERED_TAGS.has(element.tagName)) return false;
    if (index?.excluded(element)) return excludedOwnTextMatches(element, matches);
    const own = extractElementText(element);
    if (own && textPartsMatch(own, matches)) return true;
    const text = index ? index.text(element) : getMatchableText(element);
    if (!matches(text)) return false;
    for (const child of element.children ?? []) {
      const childText = index
        ? index.excluded(child)
          ? ''
          : index.text(child)
        : getMatchableText(child);
      if (matches(childText)) return false;
    }
    return true;
  }

  type LocatorTextMatchers = {
    placeholder: TextMatcher | null;
    label: TextMatcher | null;
    name: TextMatcher | null;
    text: TextMatcher | null;
  };

  function matchesLocator(
    element: Element,
    locator: ElementLocator,
    matchers: LocatorTextMatchers,
    textIndex: TextIndex | null = null,
    labelIndex: TextIndex | null = null
  ): boolean {
    if (NON_RENDERED_TAGS.has(element.tagName)) return false;
    if (locator.role && !getElementRoles(element).includes(locator.role.toLowerCase())) {
      return false;
    }
    if (
      locator.testId &&
      !TEST_ID_ATTRIBUTES.some((attribute) => element.getAttribute(attribute) === locator.testId)
    ) {
      return false;
    }
    if (matchers.placeholder && !matchers.placeholder(element.getAttribute('placeholder') ?? '')) {
      return false;
    }
    if (
      matchers.label &&
      (element.tagName === 'LABEL' ||
        getElementRoles(element).length === 0 ||
        (labelIndex !== null && nameCannotContain(element, labelIndex)) ||
        !matchers.label(getAccessibleName(element)))
    ) {
      return false;
    }
    if (matchers.name && !matchers.name(getAccessibleName(element))) {
      return false;
    }
    if (matchers.text && !matchesTextLocator(element, matchers.text, textIndex)) {
      return false;
    }
    return true;
  }

  /** Locate elements by role, accessible name, text, label, placeholder, or test
id across the light DOM and shadow roots. Hidden matches are counted but
excluded unless `includeHidden` is set. */
  function locateElements(
    locator: ElementLocator,
    options: { maxResults?: number; scanLimit?: number; lookahead?: boolean } = {}
  ): LocateResult {
    const maxResults = options.maxResults ?? 10;
    const scanLimit = options.scanLimit ?? LOCATE_EVALUATION_LIMIT;
    const traversalLimit = Math.max(scanLimit, DEEP_WALK_LIMIT);
    const scope = locator.selector && locator.selector !== '*' ? locator.selector : null;
    const exact = locator.exact === true;
    const textIndex = locator.text ? createTextIndex(locator.text, exact) : null;
    const labelIndex = locator.label ? createTextIndex(locator.label, exact) : null;
    const matchers: LocatorTextMatchers = {
      text: textIndex?.matches ?? null,
      label: labelIndex?.matches ?? null,
      name: locator.name ? createTextMatcher(locator.name, exact) : null,
      placeholder: locator.placeholder ? createTextMatcher(locator.placeholder, exact) : null,
    };

    const candidates: Iterable<Element> = scope
      ? querySelectorMatchesDeep(escapeTailwindSelector(scope))
      : walkElementsDeep(document.body ?? document.documentElement ?? document, traversalLimit + 1);

    const matches: Element[] = [];
    let hiddenMatches = 0;
    let scanned = 0;
    let evaluated = 0;

    let truncationReason: 'maxResults' | 'scanLimit' | null = null;
    const started = performance.now();
    for (const element of candidates) {
      // Large charts can contain thousands of decorative nodes before an
      // editor control. Spend the semantic scan budget on the requested role,
      // while retaining an independent traversal/time bound for hostile DOMs.
      if (
        scanned >= traversalLimit ||
        evaluated >= scanLimit ||
        performance.now() - started > LOCATE_TIME_BUDGET_MS
      ) {
        truncationReason = 'scanLimit';
        break;
      }
      scanned += 1;
      if (locator.role && !getElementRoles(element).includes(locator.role.toLowerCase())) continue;
      evaluated += 1;
      if (!matchesLocator(element, locator, matchers, textIndex, labelIndex)) continue;
      if (locator.includeHidden !== true && !isElementVisible(element)) {
        hiddenMatches += 1;
        continue;
      }
      if (matches.length >= maxResults) {
        truncationReason = 'maxResults';
        break;
      }
      matches.push(element);
      // Existence probes do not need the extra match used to report truncation.
      if (options.lookahead === false && matches.length >= maxResults) break;
    }
    return {
      matches,
      visibleOnly: locator.includeHidden !== true,
      hiddenMatches,
      scanned,
      truncationReason,
    };
  }

  function summarizeMatch(
    element: Element,
    knownVisible: boolean
  ): NodeSummary & { visible?: boolean } {
    const node = summarizeNode(element, ['id', 'class', 'href', 'data-testid'], 120, true).node;
    const role = getElementRoles(element)[0] ?? node.role;
    const name = getAccessibleName(element);
    return {
      ...node,
      role: role || null,
      name: name ? name.slice(0, 120) : node.name,
      ...(knownVisible || isElementVisible(element) ? {} : { visible: false }),
    };
  }

  function toFindResult(located: LocateResult): {
    found: boolean;
    nodes: NodeSummary[];
    count: number;
    scanned: number;
    truncated: boolean;
    truncationReason: 'maxResults' | 'scanLimit' | null;
    hiddenMatches?: number;
  } {
    return {
      found: located.matches.length > 0,
      // Visibility was already checked during this synchronous scan unless
      // hidden matches were requested. Do not repeat its layout reads.
      nodes: located.matches.map((element) => summarizeMatch(element, located.visibleOnly)),
      count: located.matches.length,
      scanned: located.scanned,
      truncated: located.truncationReason !== null,
      truncationReason: located.truncationReason,
      ...(located.hiddenMatches ? { hiddenMatches: located.hiddenMatches } : {}),
    };
  }

  /** Cheap existence check used to pick the frame that owns a selector or
locator target. Hidden matches count: the action decides actionability. */
  function probeTarget(params: Record<string, unknown>): { found: boolean } {
    const target = params.target;
    if (!target || typeof target !== 'object') return { found: false };
    const spec = target as Record<string, unknown>;
    try {
      if (typeof params.waitText === 'string' && typeof spec.selector === 'string')
        return {
          found:
            findElementWithText(escapeTailwindSelector(spec.selector), params.waitText) !== null,
        };
      if (spec.elementRef) return { found: true };
      if (isLocator(spec)) {
        const located = locateElements(
          { ...spec, includeHidden: true },
          { maxResults: 1, lookahead: false }
        );
        if (located.truncationReason === 'scanLimit' && !located.matches.length)
          throw Object.assign(new Error('Target probe scan was incomplete. Narrow the locator.'), {
            code: 'RESULT_TRUNCATED',
          });
        return {
          found: located.matches.length > 0,
        };
      }
      if (typeof spec.selector === 'string' && spec.selector) {
        return { found: querySelectorDeep(escapeTailwindSelector(spec.selector)) !== null };
      }
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'RESULT_TRUNCATED'
      )
        throw error;
      return { found: false };
    }
    return { found: false };
  }

  /** Find elements matching visible text content. */
  function findByText(params: Record<string, unknown>): ReturnType<typeof toFindResult> {
    const searchText = String(params.text || '');
    if (!searchText) {
      throw new Error('text is required for dom.find_by_text');
    }
    return toFindResult(
      locateElements(
        {
          text: searchText,
          exact: Boolean(params.exact),
          selector: params.selector ? String(params.selector) : undefined,
          includeHidden: params.includeHidden === true,
        },
        {
          maxResults: clamp(params.maxResults ?? 10, 1, 50),
          scanLimit: clamp(params.scanLimit ?? LOCATE_EVALUATION_LIMIT, 1, DEEP_WALK_LIMIT),
        }
      )
    );
  }

  /** Find elements matching ARIA role and optional accessible name. */
  function findByRole(params: Record<string, unknown>): ReturnType<typeof toFindResult> {
    const role = String(params.role || '');
    if (!role) {
      throw new Error('role is required for dom.find_by_role');
    }
    return toFindResult(
      locateElements(
        {
          role,
          name: params.name ? String(params.name) : undefined,
          exact: Boolean(params.exact),
          selector: params.selector ? String(params.selector) : undefined,
          includeHidden: params.includeHidden === true,
        },
        {
          maxResults: clamp(params.maxResults ?? 10, 1, 50),
          scanLimit: clamp(params.scanLimit ?? LOCATE_EVALUATION_LIMIT, 1, DEEP_WALK_LIMIT),
        }
      )
    );
  }

  /** A scoped wait matches descendant text too. Finder locators deliberately
  prefer innermost matches, but a status/container wait must retain its scope. */
  function elementMatchesText(
    element: Element,
    text: string,
    index: TextIndex | null = null
  ): boolean {
    const matches = index?.matches ?? createTextMatcher(text, false);
    return (
      matchesTextLocator(element, matches, index) ||
      (!NON_RENDERED_TAGS.has(element.tagName) &&
        !index?.excluded(element) &&
        matches(index ? index.text(element) : getMatchableText(element)))
    );
  }

  /** Find the first element matching a selector whose text contains a string. */
  function findElementWithText(selector: string, text: string): Element | null {
    const index = createTextIndex(text);
    for (const el of querySelectorMatchesDeep(selector)) {
      if (elementMatchesText(el, text, index)) {
        return el;
      }
    }
    return null;
  }

  /** Roles a user can operate; always part of the outline. */
  const OUTLINE_INTERACTIVE_ROLES = new Set([
    'button',
    'checkbox',
    'combobox',
    'gridcell',
    'link',
    'listbox',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'radio',
    'scrollbar',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'textbox',
    'treeitem',
  ]);
  /** Structural roles that give the outline context when not interactive-only. */
  const OUTLINE_CONTEXT_ROLES = new Set([
    'alert',
    'alertdialog',
    'banner',
    'complementary',
    'contentinfo',
    'dialog',
    'form',
    'heading',
    'img',
    'main',
    'navigation',
    'region',
    'status',
    'tablist',
    'menu',
    'menubar',
    'tree',
    'grid',
    'table',
  ]);
  const OUTLINE_NAME_BUDGET = 80;
  const OUTLINE_SCAN_LIMIT = 20000;

  /** Include a scoped root without eagerly traversing its descendants. Read one
  extra candidate so scan exhaustion is distinguishable from a complete tree. */
  function* walkOutlineCandidates(root: Element | null): Generator<Element> {
    if (root) yield root;
    yield* walkElementsDeep(
      root ?? document.body ?? document.documentElement ?? document,
      OUTLINE_SCAN_LIMIT + 1
    );
  }

  /** Compact states worth showing in an outline line. */
  function getOutlineStates(element: Element, role: string): string[] {
    const states: string[] = [];
    const control = element as {
      disabled?: unknown;
      checked?: unknown;
      required?: unknown;
      value?: unknown;
      type?: unknown;
    };
    if (control.disabled === true || element.getAttribute('aria-disabled') === 'true') {
      states.push('disabled');
    }
    const ariaChecked = element.getAttribute('aria-checked');
    if (
      (element.tagName === 'INPUT' &&
        (control.type === 'checkbox' || control.type === 'radio') &&
        control.checked === true) ||
      ariaChecked === 'true'
    ) {
      states.push('checked');
    } else if (ariaChecked === 'mixed') {
      states.push('mixed');
    }
    for (const [attribute, label] of [
      ['aria-expanded', 'expanded'],
      ['aria-selected', 'selected'],
      ['aria-pressed', 'pressed'],
    ]) {
      const value = element.getAttribute(attribute);
      if (value === 'true') states.push(label);
      else if (value === 'false' && attribute === 'aria-expanded') states.push('collapsed');
    }
    if (control.required === true || element.getAttribute('aria-required') === 'true') {
      states.push('required');
    }
    if (role === 'heading') {
      const level = element.getAttribute('aria-level') || element.tagName.match(/^H([1-6])$/)?.[1];
      if (level) states.push(`level=${level}`);
    }
    if (['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider'].includes(role)) {
      const value =
        typeof control.value === 'string'
          ? control.value
          : (element as HTMLElement).isContentEditable
            ? collapseText(element.textContent, 40)
            : '';
      if (value && control.type !== 'password')
        states.push(`value=${JSON.stringify(value.slice(0, 40))}`);
    }
    if (document.activeElement === element) states.push('focused');
    return states;
  }

  /** Nearest outline ancestor across shadow boundaries. */
  function getOutlineDepth(element: Element, depths: Map<Element, number>): number {
    let current: Node | null = element.parentNode;
    for (let hops = 0; current && hops < 200; hops += 1) {
      if (current.nodeType === 1) {
        const depth = depths.get(current as Element);
        if (depth !== undefined) return depth + 1;
      }
      current =
        current.nodeType === 11 && (current as ShadowRoot).host
          ? (current as ShadowRoot).host
          : current.parentNode;
    }
    return 0;
  }

  /** Scope discovery is bounded separately from outline traversal. An incomplete
  scan cannot establish that a landmark is unique, so it falls back explicitly. */
  function resolveOutlineScope(params: Record<string, unknown>): {
    root: Element | null;
    scope?: import('../../../protocol/src/types.js').DomOutlineScope;
  } {
    const enhanced = params.scope !== undefined || params.find !== undefined;
    if (params.selector) {
      const root = querySelectorDeep(escapeTailwindSelector(String(params.selector)));
      if (!root) {
        throw Object.assign(new Error('Accessibility outline selector matched no element.'), {
          code: 'ELEMENT_NOT_FOUND',
          details: { selector: String(params.selector).slice(0, 500) },
        });
      }
      return {
        root,
        ...(enhanced
          ? {
              scope: {
                requested: (params.scope ??
                  'selector') as import('../../../protocol/src/types.js').DomOutlineScope['requested'],
                resolved: 'selector' as const,
                boundary: 'document' as const,
                selector: String(params.selector).slice(0, 500),
                scanned: 0,
              },
            }
          : {}),
      };
    }
    if (!enhanced) return { root: null };
    const requested = (params.scope ?? 'document') as 'auto' | 'modal' | 'main' | 'document';
    const scope: import('../../../protocol/src/types.js').DomOutlineScope = {
      requested,
      resolved: 'document',
      boundary: 'document',
      scanned: 0,
    };
    if (requested === 'document') return { root: null, scope };
    const modals: Element[] = [];
    const mains: Element[] = [];
    for (const element of walkOutlineCandidates(null)) {
      if (scope.scanned >= OUTLINE_SCAN_LIMIT) {
        scope.fallbackReason = 'scope_scan_limit';
        return { root: null, scope };
      }
      scope.scanned += 1;
      const role = getElementRoles(element)[0];
      if (!['dialog', 'alertdialog', 'main'].includes(role)) continue;
      if (!isElementVisible(element)) continue;
      if (role === 'main' && mains.length < 2) mains.push(element);
      if (role === 'dialog' || role === 'alertdialog') {
        let modal = element.getAttribute('aria-modal') === 'true';
        if (!modal && element.tagName === 'DIALOG') {
          try {
            modal = element.matches(':modal');
          } catch {
            /* Older DOM implementations. */
          }
        }
        if (modal && modals.length < 2) modals.push(element);
      }
    }
    const kind = requested === 'auto' ? (modals.length ? 'modal' : 'main') : requested;
    const candidates = kind === 'modal' ? modals : mains;
    if (candidates.length !== 1) {
      scope.fallbackReason =
        kind === 'modal'
          ? candidates.length
            ? 'modal_ambiguous'
            : 'modal_missing'
          : candidates.length
            ? 'main_ambiguous'
            : 'main_missing';
      return { root: null, scope };
    }
    scope.resolved = kind;
    return { root: candidates[0], scope };
  }

  function outlineParent(element: Element, indices: Map<Element, number>): number {
    let current: Node | null = element.parentNode;
    for (let hops = 0; current && hops < 200; hops += 1) {
      if (current.nodeType === 1) {
        const index = indices.get(current as Element);
        if (index !== undefined) return index;
      }
      current =
        current.nodeType === 11 && (current as ShadowRoot).host
          ? (current as ShadowRoot).host
          : current.parentNode;
    }
    return -1;
  }

  /** Build an actionable accessibility outline from the live DOM (including
shadow roots) without the debugger. Every line carries an elementRef that
input methods accept directly, so agents can go from overview to action in
one step. Hidden elements are skipped. */
  function getAccessibilityOutline(
    params: Record<string, unknown>
  ): import('../../../protocol/src/types.js').DomOutlineResult {
    const maxNodes = clamp(params.maxNodes ?? 150, 10, 5000);
    const maxDepth = clamp(params.maxDepth ?? 6, 1, 20);
    const interactiveOnly = params.interactiveOnly === true;
    const { root, scope } = resolveOutlineScope(params);
    const query = typeof params.find === 'string' ? params.find.toLowerCase() : null;
    const context = clamp(params.context ?? 1, 0, 3);
    const depths: Map<Element, number> = new Map();
    const indices: Map<Element, number> = new Map();
    const entries: Array<{
      node: import('../../../protocol/src/types.js').DomOutlineNode;
      parent: number;
      element: Element;
    }> = [];
    let scanned = 0;
    const reasons = new Set<
      import('../../../protocol/src/types.js').DomOutlineCompleteness['reasons'][number]
    >();
    if (scope?.fallbackReason === 'scope_scan_limit') reasons.add('scopeScanLimit');
    for (const element of walkOutlineCandidates(root)) {
      if (scanned >= OUTLINE_SCAN_LIMIT) {
        reasons.add('scanLimit');
        break;
      }
      scanned += 1;
      if (NON_RENDERED_TAGS.has(element.tagName)) continue;
      const roles = getElementRoles(element);
      let role = roles[0] ?? '';
      if (
        !role &&
        Number(element.getAttribute('tabindex')) >= 0 &&
        element.hasAttribute('tabindex')
      ) {
        role = 'generic';
      }
      const interactive = OUTLINE_INTERACTIVE_ROLES.has(role) || role === 'generic';
      if (!interactive && (interactiveOnly || !OUTLINE_CONTEXT_ROLES.has(role))) continue;
      if (!isElementVisible(element)) continue;
      const regionName =
        role === 'region'
          ? query === null
            ? getAccessibleName(element)
            : getAccessibleName(element, 2000, () => reasons.add('nameLimit'))
          : undefined;
      if (role === 'region' && !regionName) continue;
      const depth = getOutlineDepth(element, depths);
      // Retain omitted ancestors' depths so their descendants cannot reappear
      // at a shallower level. Later siblings still get their own depth check.
      depths.set(element, depth);
      if (depth > maxDepth) {
        reasons.add('maxDepth');
        continue;
      }
      if (query === null && entries.length >= maxNodes) {
        reasons.add('maxNodes');
        break;
      }
      const name =
        regionName ??
        (query === null
          ? getAccessibleName(element)
          : getAccessibleName(element, 2000, () => reasons.add('nameLimit')));
      const parent = query === null ? -1 : outlineParent(element, indices);
      if (query !== null) indices.set(element, entries.length);
      entries.push({
        parent,
        element,
        node: {
          ref: query === null && !scope ? rememberElement(element) : '',
          role,
          name: collapseText(name, OUTLINE_NAME_BUDGET),
          depth,
          states: query === null ? getOutlineStates(element, role) : [],
          ...(query !== null
            ? { matched: role.toLowerCase().includes(query) || name.toLowerCase().includes(query) }
            : {}),
        },
      });
    }
    let selected = entries;
    let search: import('../../../protocol/src/types.js').DomOutlineSearch | undefined;
    if (query !== null) {
      const included = new Set<number>();
      const siblings = new Map<number, number[]>();
      const positions: number[] = [];
      entries.forEach((entry, index) => {
        const group = siblings.get(entry.parent) ?? [];
        positions[index] = group.length;
        group.push(index);
        siblings.set(entry.parent, group);
      });
      let matchCount = 0;
      entries.forEach((entry, index) => {
        if (!entry.node.matched) return;
        matchCount += 1;
        included.add(index);
        if (!context) return;
        const group = siblings.get(entry.parent) ?? [];
        for (const neighbor of group.slice(
          Math.max(0, positions[index] - context),
          positions[index] + context + 1
        ))
          included.add(neighbor);
        let ancestor = entry.parent;
        while (ancestor !== -1) {
          included.add(ancestor);
          ancestor = entries[ancestor].parent;
        }
      });
      selected = entries.filter((_, index) => included.has(index));
      if (selected.length > maxNodes) {
        reasons.add('maxNodes');
        // Context must not consume the result budget before the actual match.
        const retained = new Set(selected.filter((entry) => entry.node.matched).slice(0, maxNodes));
        for (const entry of selected) {
          if (retained.size >= maxNodes) break;
          retained.add(entry);
        }
        selected = selected.filter((entry) => retained.has(entry));
      }
      search = {
        query: String(params.find),
        context,
        matchCount,
        returnedMatches: selected.filter((entry) => entry.node.matched).length,
      };
    }
    // A separately returned scope root also occupies one registry slot.
    if (
      scope &&
      root &&
      selected.length >= 5000 &&
      !selected.some((entry) => entry.element === root)
    ) {
      reasons.add('maxNodes');
      let omitted = selected.length - 1;
      if (search) {
        for (let index = selected.length - 1; index >= 0; index -= 1) {
          if (!selected[index].node.matched) {
            omitted = index;
            break;
          }
        }
      }
      selected = selected.filter((_, index) => index !== omitted);
    }
    if (search) search.returnedMatches = selected.filter((entry) => entry.node.matched).length;
    const nodes = selected.map((entry) =>
      query === null && !scope
        ? entry.node
        : {
            ...entry.node,
            ref: rememberElement(entry.element, true),
            states: getOutlineStates(entry.element, entry.node.role),
          }
    );
    if (scope && root) scope.rootRef = rememberElement(root, true);
    const base = {
      source: 'dom' as 'dom',
      count: nodes.length,
      scanned,
      truncated: reasons.size > 0,
      ...(scope
        ? { scope, completeness: { complete: reasons.size === 0, reasons: [...reasons] } }
        : {}),
      ...(search ? { search } : {}),
    };
    if (params.format === 'tree') {
      return { ...base, format: 'tree', nodes };
    }
    const outline = nodes
      .map(
        (entry) =>
          `${'  '.repeat(Math.min(entry.depth, 12))}- ${entry.role}${entry.name ? ` ${JSON.stringify(entry.name)}` : ''} [${entry.ref}]${entry.states.length ? ` ${entry.states.join(' ')}` : ''}${entry.matched ? ' [match]' : ''}`
      )
      .join('\n');
    return { ...base, format: 'outline', outline };
  }

  /** Expose a synchronous read-only scan with per-scan lookup caches. */
  function scanned<A extends unknown[], R>(scan: (...args: A) => R): (...args: A) => R {
    return (...args) => withDomScanCache(() => scan(...args));
  }

  globalState.__BBX_CONTENT_DOM_QUERY__ = Object.freeze({
    describeElement,
    domQuery: scanned(domQuery),
    findByRole: scanned(findByRole),
    findByText: scanned(findByText),
    getAccessibilityOutline: scanned(getAccessibilityOutline),
    isLocator,
    probeTarget: scanned(probeTarget),
    locateElements: scanned(locateElements),
    getAttributes,
    getBoxModel,
    getComputedStyles,
    getHtml,
    getMatchedRules,
    getText,
    hitTest,
    summarizeNode,
    waitForDom,
  });
})();
