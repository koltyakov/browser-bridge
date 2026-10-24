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
        getAccessibleName: (element: Element) => string;
        getElementRoles: (element: Element) => string[];
        getElementTextContent: (element: Element, budget?: number) => string;
        getShadowRoot: (element: Element) => ShadowRoot | null;
        isElementVisible: (element: Element) => boolean;
        querySelectorMatchesDeep: (selector: string, root?: ParentNode) => Generator<Element>;
        querySelectorDeep: (selector: string, root?: ParentNode) => Element | null;
        walkElementsDeep: (root?: ParentNode, limit?: number) => Generator<Element>;
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
        rememberElement: (element: Element) => string;
        resolveTarget: (target?: { elementRef?: string; selector?: string }) => Element;
      };
    }
  ).__BBX_CONTENT_REGISTRY__;
  if (!contentHelpers || !registry) {
    throw new Error('Browser Bridge helpers and registry must load before content-dom-query.js.');
  }

  const {
    NON_RENDERED_TAGS,
    clamp,
    collapseText,
    delay,
    escapeTailwindSelector,
    extractElementText,
    findElementForWaitState,
    getAccessibleName,
    getElementRoles,
    getElementTextContent,
    isElementVisible,
    querySelectorMatchesDeep,
    querySelectorDeep,
    toRect,
    truncateText,
    walkElementsDeep,
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

  /** Return innerHTML or outerHTML of an element, truncated to budget. */
  function getHtml(params: Record<string, unknown>): {
    html: string;
    truncated: boolean;
    omitted: number;
  } {
    const element = getRequiredElement(String(params.elementRef || ''));
    const outer = Boolean(params.outer);
    const maxLength = clamp(params.maxLength ?? 2000, 32, 50000);
    const raw = outer ? element.outerHTML : element.innerHTML;
    const t = truncateText(raw, maxLength);
    return { html: t.value, truncated: t.truncated, omitted: t.omitted };
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
      if (typeof params.__bbxAssertActive === 'function') params.__bbxAssertActive();
      if (waitState === 'detached') {
        const exists = text
          ? findElementWithText(selector, text) !== null
          : querySelectorDeep(selector) !== null;
        return { found: !exists, element: null };
      }
      let hasMatches = false;
      function* matchingCandidates(): Generator<Element> {
        for (const element of querySelectorMatchesDeep(selector)) {
          if (text !== null && !elementMatchesText(element, text)) continue;
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
      const observer = new MutationObserver(scheduleObserverCheck);

      function finish(result: { found: boolean; elementRef: string | null; duration: number }) {
        if (settled) return;
        settled = true;
        observer.disconnect();
        resolve(result);
      }

      function tryResolve() {
        if (settled) return;
        let result: ReturnType<typeof check>;
        try {
          result = check();
        } catch (error) {
          settled = true;
          observer.disconnect();
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
          await delay(250);
          tryResolve();
        }
      }

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      void poll();
      void delay(timeout).then(() =>
        finish({
          found: false,
          elementRef: null,
          duration: Math.max(timeout, Date.now() - start),
        })
      );
    });
  }

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

  function textMatches(haystack: string, needle: string, exact: boolean): boolean {
    if (!haystack) return false;
    const collapsedNeedle = collapseText(needle, 10_000);
    const collapsedHaystack = exact ? collapseText(haystack, 100_000) : haystack;
    return exact
      ? collapsedHaystack === collapsedNeedle
      : collapsedHaystack.toLowerCase().includes(collapsedNeedle.toLowerCase());
  }

  /** Full collapsed subtree text used for innermost text matching. Shadow hosts
contribute their shadow content. */
  function getMatchableText(element: Element): string {
    return getElementTextContent(element, 100_000);
  }

  /** Match visible text the way a user reads it: own text and text-like
attributes first, otherwise the innermost element whose combined
descendant text matches (so `<button><b>Place</b> order</button>` matches
"Place order" on the button, not on `<body>`). */
  function matchesTextLocator(element: Element, needle: string, exact: boolean): boolean {
    if (NON_RENDERED_TAGS.has(element.tagName)) return false;
    const own = extractElementText(element);
    if (own && own.split(' | ').some((part) => textMatches(part, needle, exact))) return true;
    if (!textMatches(getMatchableText(element), needle, exact)) return false;
    for (const child of element.children ?? []) {
      if (textMatches(getMatchableText(child), needle, exact)) return false;
    }
    return true;
  }

  function matchesLocator(element: Element, locator: ElementLocator): boolean {
    const exact = locator.exact === true;
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
    if (
      locator.placeholder &&
      !textMatches(element.getAttribute('placeholder') ?? '', locator.placeholder, exact)
    ) {
      return false;
    }
    if (
      locator.label &&
      (element.tagName === 'LABEL' ||
        getElementRoles(element).length === 0 ||
        !textMatches(getAccessibleName(element), locator.label, exact))
    ) {
      return false;
    }
    if (locator.name && !textMatches(getAccessibleName(element), locator.name, exact)) {
      return false;
    }
    if (locator.text && !matchesTextLocator(element, locator.text, exact)) {
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
    const scanLimit = options.scanLimit ?? 5_000;
    const scope = locator.selector && locator.selector !== '*' ? locator.selector : null;

    const candidates: Iterable<Element> = scope
      ? querySelectorMatchesDeep(escapeTailwindSelector(scope))
      : walkElementsDeep(document.body ?? document.documentElement ?? document);

    const matches: Element[] = [];
    let hiddenMatches = 0;
    let scanned = 0;

    let truncationReason: 'maxResults' | 'scanLimit' | null = null;
    const started = performance.now();
    for (const element of candidates) {
      if (scanned >= scanLimit || performance.now() - started > 100) {
        truncationReason = 'scanLimit';
        break;
      }
      scanned += 1;
      if (!matchesLocator(element, locator)) continue;
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
          scanLimit: clamp(params.scanLimit ?? 5000, 1, 20000),
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
          scanLimit: clamp(params.scanLimit ?? 5000, 1, 20000),
        }
      )
    );
  }

  /** A scoped wait matches descendant text too. Finder locators deliberately
  prefer innermost matches, but a status/container wait must retain its scope. */
  function elementMatchesText(element: Element, text: string): boolean {
    return (
      matchesTextLocator(element, text, false) ||
      (!NON_RENDERED_TAGS.has(element.tagName) &&
        textMatches(getMatchableText(element), text, false))
    );
  }

  /** Find the first element matching a selector whose text contains a string. */
  function findElementWithText(selector: string, text: string): Element | null {
    for (const el of querySelectorMatchesDeep(selector)) {
      if (elementMatchesText(el, text)) {
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

  /** Build an actionable accessibility outline from the live DOM (including
shadow roots) without the debugger. Every line carries an elementRef that
input methods accept directly, so agents can go from overview to action in
one step. Hidden elements are skipped. */
  function getAccessibilityOutline(params: Record<string, unknown>): {
    source: 'dom';
    format: 'outline' | 'tree';
    outline?: string;
    nodes?: Array<Record<string, unknown>>;
    count: number;
    scanned: number;
    truncated: boolean;
  } {
    const maxNodes = clamp(params.maxNodes ?? 150, 10, 5000);
    const maxDepth = clamp(params.maxDepth ?? 6, 1, 20);
    const interactiveOnly = params.interactiveOnly === true;
    const root = params.selector
      ? querySelectorDeep(escapeTailwindSelector(String(params.selector)))
      : null;
    if (params.selector && !root) {
      throw Object.assign(new Error('Accessibility outline selector matched no element.'), {
        code: 'ELEMENT_NOT_FOUND',
        details: { selector: String(params.selector).slice(0, 500) },
      });
    }

    const depths: Map<Element, number> = new Map();

    const entries: Array<{
      ref: string;
      role: string;
      name: string;
      depth: number;
      states: string[];
    }> = [];
    let scanned = 0;
    let truncated = false;
    for (const element of walkOutlineCandidates(root)) {
      if (scanned >= OUTLINE_SCAN_LIMIT) {
        truncated = true;
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
      if (role === 'region' && !getAccessibleName(element)) continue;
      if (!isElementVisible(element)) continue;
      const depth = getOutlineDepth(element, depths);
      // Retain omitted ancestors' depths so their descendants cannot reappear
      // at a shallower level. Later siblings still get their own depth check.
      depths.set(element, depth);
      if (depth > maxDepth) {
        truncated = true;
        continue;
      }
      if (entries.length >= maxNodes) {
        truncated = true;
        break;
      }
      entries.push({
        ref: rememberElement(element),
        role,
        name: collapseText(getAccessibleName(element), OUTLINE_NAME_BUDGET),
        depth,
        states: getOutlineStates(element, role),
      });
    }
    const base = {
      source: 'dom' as 'dom',
      count: entries.length,
      scanned,
      truncated,
    };
    if (params.format === 'tree') {
      return { ...base, format: 'tree', nodes: entries };
    }
    const outline = entries
      .map(
        (entry) =>
          `${'  '.repeat(Math.min(entry.depth, 12))}- ${entry.role}${entry.name ? ` ${JSON.stringify(entry.name)}` : ''} [${entry.ref}]${entry.states.length ? ` ${entry.states.join(' ')}` : ''}`
      )
      .join('\n');
    return { ...base, format: 'outline', outline };
  }

  globalState.__BBX_CONTENT_DOM_QUERY__ = Object.freeze({
    describeElement,
    domQuery,
    findByRole,
    findByText,
    getAccessibilityOutline,
    isLocator,
    probeTarget,
    locateElements,
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
