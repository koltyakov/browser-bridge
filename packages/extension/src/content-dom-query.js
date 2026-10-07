// @ts-check

(() => {
  const globalState =
    /** @type {typeof globalThis & { __BBX_CONTENT_DOM_QUERY__?: Record<string, unknown> }} */ (
      globalThis
    );

  if (globalState.__BBX_CONTENT_DOM_QUERY__) {
    return;
  }

  const contentHelpers = /** @type {typeof globalThis & { __BBX_CONTENT_HELPERS__?: {
     applyBudget: (options?: Record<string, any>) => Budget,
     clamp: (value: number | string | null | undefined, minimum: number, maximum: number) => number,
     extractElementText: (element: Element) => string,
     findElementForWaitState: (options: {
      elements: Iterable<Element>,
      waitState: 'visible' | 'hidden',
      getRect: (element: Element) => { width: number, height: number },
      getVisibility: (element: Element) => string
    }) => Element | null,
     getImplicitRole: (element: Element) => string,
     getImplicitRoleSelector: (role: string) => string,
     toRect: (rect: DOMRect | DOMRectReadOnly) => { x: number, y: number, width: number, height: number },
     truncateText: (value: string, budget: number) => { value: string, truncated: boolean, omitted: number },
     NON_RENDERED_TAGS: Set<string>,
     collapseText: (value: string | null | undefined, budget?: number) => string,
     escapeTailwindSelector: (selector: string) => string,
     getAccessibleName: (element: Element) => string,
     getElementRoles: (element: Element) => string[],
     getElementTextContent: (element: Element, budget?: number) => string,
     getShadowRoot: (element: Element) => ShadowRoot | null,
     isElementVisible: (element: Element) => boolean,
     querySelectorAllDeep: (selector: string, root?: ParentNode) => Element[],
     querySelectorDeep: (selector: string, root?: ParentNode) => Element | null,
     walkElementsDeep: (root?: ParentNode, limit?: number) => Generator<Element>
    } }} */ (globalThis).__BBX_CONTENT_HELPERS__;
  const registry = /** @type {typeof globalThis & { __BBX_CONTENT_REGISTRY__?: {
     consumePruned: () => boolean,
     getDocumentRevision: () => number,
     getRegistrySize: () => number,
     getRequiredElement: (ref: string) => Element,
     normalizeDomQuery: (params?: Record<string, any>) => NormalizedDomQuery,
     rememberElement: (element: Element) => string,
     resolveTarget: (target?: { elementRef?: string, selector?: string }) => Element
    } }} */ (globalThis).__BBX_CONTENT_REGISTRY__;
  if (!contentHelpers || !registry) {
    throw new Error('Browser Bridge helpers and registry must load before content-dom-query.js.');
  }

  const {
    NON_RENDERED_TAGS,
    clamp,
    collapseText,
    escapeTailwindSelector,
    extractElementText,
    findElementForWaitState,
    getAccessibleName,
    getElementRoles,
    getElementTextContent,
    getShadowRoot,
    isElementVisible,
    querySelectorAllDeep,
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

  /**
   * @typedef {{
   *   maxNodes: number,
   *   maxDepth: number,
   *   textBudget: number,
   *   includeBbox: boolean,
   *   attributeAllowlist: string[]
   * }} Budget
   */

  /**
   * @typedef {{
   *   selector: string,
   *   withinRef: string | null,
   *   budget: Budget
   * }} NormalizedDomQuery
   */

  /**
   * @typedef {{
   *   elementRef: string,
   *   tag: string,
   *   role: string | null,
   *   name: string | null,
   *   textExcerpt: string,
   *   attrs: Record<string, string | null>,
   *   bbox?: { x: number, y: number, width: number, height: number }
   * }} NodeSummary
   */

  /**
   * Perform a bounded breadth-first DOM summary rooted at a selector or existing
   * element reference.
   *
   * @param {Record<string, any>} params
   * @returns {{ nodes: NodeSummary[], revision: number, truncated?: boolean, registrySize: number, _registryPruned?: boolean }}
   */
  function domQuery(params) {
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

    /** @type {NodeSummary[]} */
    const nodes = [];
    let remaining = query.budget.textBudget;
    /** @type {Array<{ element: Element, depth: number }>} */
    const queue = [{ element: root, depth: 0 }];
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

    const pruned = consumePruned();
    return {
      nodes,
      revision: getDocumentRevision(),
      truncated:
        truncatedByQueueCap ||
        queueIndex < queue.length ||
        nodes.length >= query.budget.maxNodes ||
        remaining <= 0,
      registrySize: getRegistrySize(),
      ...(pruned ? { _registryPruned: true } : {}),
    };
  }

  /**
   * Create a compact, token-efficient summary for a single element.
   *
   * @param {Element} element
   * @param {string[]} attributeAllowlist
   * @param {number} remainingText
   * @param {boolean} includeBbox
   * @returns {{ textLength: number, node: NodeSummary }}
   */
  function summarizeNode(element, attributeAllowlist, remainingText, includeBbox) {
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

  /**
   * Extract only allowlisted attributes from an element.
   *
   * @param {Element} element
   * @param {string[]} attributeAllowlist
   * @returns {Record<string, string | null>}
   */
  function summarizeAttributes(element, attributeAllowlist) {
    if (!attributeAllowlist.length) {
      return {};
    }
    return attributeAllowlist.reduce((accumulator, attribute) => {
      if (element.hasAttribute(attribute)) {
        accumulator[attribute] = element.getAttribute(attribute);
      }
      return accumulator;
    }, /** @type {Record<string, string | null>} */ ({}));
  }

  /**
   * Describe a known element reference.
   *
   * @param {string} elementRef
   * @returns {{ elementRef: string, tag: string, text: { value: string, truncated: boolean, omitted: number }, bbox: { x: number, y: number, width: number, height: number } }}
   */
  function describeElement(elementRef) {
    const element = getRequiredElement(elementRef);
    return {
      elementRef,
      tag: element.tagName.toLowerCase(),
      text: truncateText(extractElementText(element), 300),
      bbox: toRect(element.getBoundingClientRect()),
    };
  }

  /**
   * Return bounded text content for an element.
   *
   * @param {string} elementRef
   * @param {number} [budget=600]
   * @returns {{ value: string, truncated: boolean, omitted: number }}
   */
  function getText(elementRef, budget = 600) {
    const element = /** @type {HTMLElement} */ (getRequiredElement(elementRef));
    return truncateText((element.innerText || element.textContent || '').trim(), budget);
  }

  /**
   * Read a selected set of attributes from an element reference.
   *
   * @param {string} elementRef
   * @param {string[]} attributes
   * @returns {Record<string, string | null>}
   */
  function getAttributes(elementRef, attributes) {
    const element = getRequiredElement(elementRef);
    return attributes.reduce((accumulator, attribute) => {
      if (element.hasAttribute(attribute)) {
        accumulator[attribute] = element.getAttribute(attribute);
      }
      return accumulator;
    }, /** @type {Record<string, string | null>} */ ({}));
  }

  /**
   * Return the box model rectangle for an element.
   *
   * @param {string} elementRef
   * @returns {{ x: number, y: number, width: number, height: number }}
   */
  function getBoxModel(elementRef) {
    return toRect(getRequiredElement(elementRef).getBoundingClientRect());
  }

  /**
   * Resolve the topmost element at a viewport coordinate into a compact summary.
   *
   * @param {number} x
   * @param {number} y
   * @returns {NodeSummary | null}
   */
  function hitTest(x, y) {
    const element = document.elementFromPoint(x, y);
    return element ? summarizeNode(element, ['id', 'class'], 120, true).node : null;
  }

  /**
   * Read computed CSS properties for an element reference.
   *
   * @param {string} elementRef
   * @param {string[]} [properties=[]]
   * @returns {Record<string, string>}
   */
  function getComputedStyles(elementRef, properties = []) {
    const styles = window.getComputedStyle(getRequiredElement(elementRef));
    const requested = properties.length
      ? properties
      : ['display', 'position', 'width', 'height', 'color'];
    return requested.reduce((accumulator, property) => {
      accumulator[property] = styles.getPropertyValue(property);
      return accumulator;
    }, /** @type {Record<string, string>} */ ({}));
  }

  /**
   * Return simple matched-rule context for an element.
   *
   * @param {string} elementRef
   * @returns {{ elementRef: string, classes: string[], inlineStyle: string }}
   */
  function getMatchedRules(elementRef) {
    const element = getRequiredElement(elementRef);
    return {
      elementRef,
      classes: [...element.classList],
      inlineStyle: element.getAttribute('style') || '',
    };
  }

  /**
   * Return innerHTML or outerHTML of an element, truncated to budget.
   *
   * @param {Record<string, any>} params
   * @returns {{ html: string, truncated: boolean, omitted: number }}
   */
  function getHtml(params) {
    const element = getRequiredElement(String(params.elementRef || ''));
    const outer = Boolean(params.outer);
    const maxLength = clamp(params.maxLength ?? 2000, 32, 50000);
    const raw = outer ? element.outerHTML : element.innerHTML;
    const t = truncateText(raw, maxLength);
    return { html: t.value, truncated: t.truncated, omitted: t.omitted };
  }

  /**
   * Wait for a DOM condition using MutationObserver + polling fallback.
   *
   * @param {Record<string, any>} params
   * @returns {Promise<{ found: boolean, elementRef: string | null, duration: number }>}
   */
  function waitForDom(params) {
    const text = typeof params.text === 'string' && params.text.trim() ? String(params.text) : null;
    const selector = String(params.selector || (text !== null ? '*' : ''));
    if (!selector && text === null) {
      throw new Error('selector or text is required for dom.wait_for');
    }
    const waitState = params.state || 'attached';
    const timeout = clamp(params.timeoutMs ?? 5000, 100, 30000);
    const start = Date.now();

    /**
     * @returns {{ found: boolean, element: Element | null }}
     */
    function check() {
      if (waitState === 'detached') {
        const exists = text
          ? findElementWithText(selector, text) !== null
          : querySelectorDeep(selector) !== null;
        return { found: !exists, element: null };
      }
      const candidates = querySelectorAllDeep(selector);
      /** @type {Element[]} */
      const matched = [];
      for (const el of candidates) {
        if (text !== null && !elementMatchesText(el, text)) {
          continue;
        }
        if (waitState !== 'visible' && waitState !== 'hidden') {
          return { found: true, element: el };
        }
        matched.push(el);
      }

      const matchedElement = findElementForWaitState({
        elements: matched,
        waitState,
        getRect: (element) => element.getBoundingClientRect(),
        getVisibility: (element) => getComputedStyle(element).visibility,
      });
      if (waitState === 'hidden' && matched.length === 0) {
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

    return new Promise((resolve) => {
      /** @type {MutationObserver | null} */
      let observer = null;
      /** @type {ReturnType<typeof setTimeout> | null} */
      let timeoutHandle = null;
      /** @type {ReturnType<typeof setInterval> | null} */
      let pollHandle = null;
      /** @type {ReturnType<typeof setTimeout> | null} */
      let observerDebounceHandle = null;

      function cleanup() {
        if (observer) observer.disconnect();
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (pollHandle) clearInterval(pollHandle);
        if (observerDebounceHandle) clearTimeout(observerDebounceHandle);
      }

      function tryResolve() {
        const result = check();
        if (result.found) {
          cleanup();
          resolve({
            found: true,
            elementRef: result.element ? rememberElement(result.element) : null,
            duration: Date.now() - start,
          });
        }
      }

      function scheduleObserverCheck() {
        if (observerDebounceHandle) return;
        observerDebounceHandle = setTimeout(() => {
          observerDebounceHandle = null;
          tryResolve();
        }, 50);
      }

      observer = new MutationObserver(scheduleObserverCheck);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      pollHandle = setInterval(tryResolve, 250);
      timeoutHandle = setTimeout(() => {
        cleanup();
        resolve({
          found: false,
          elementRef: null,
          duration: Math.max(timeout, Date.now() - start),
        });
      }, timeout);
    });
  }

  /**
   * @typedef {{
   *   role?: string,
   *   name?: string,
   *   text?: string,
   *   label?: string,
   *   placeholder?: string,
   *   testId?: string,
   *   selector?: string,
   *   exact?: boolean,
   *   includeHidden?: boolean
   * }} ElementLocator
   */

  /**
   * @typedef {{
   *   matches: Element[],
   *   hiddenMatches: number,
   *   scanned: number,
   *   truncationReason: 'maxResults' | 'scanLimit' | null
   * }} LocateResult
   */

  const LOCATOR_KEYS = /** @type {const} */ ([
    'role',
    'name',
    'text',
    'label',
    'placeholder',
    'testId',
  ]);
  const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-qa'];

  /**
   * @param {unknown} value
   * @returns {value is ElementLocator}
   */
  function isLocator(value) {
    if (!value || typeof value !== 'object') return false;
    const record = /** @type {Record<string, unknown>} */ (value);
    return LOCATOR_KEYS.some((key) => typeof record[key] === 'string' && record[key] !== '');
  }

  /**
   * @param {string} haystack
   * @param {string} needle
   * @param {boolean} exact
   * @returns {boolean}
   */
  function textMatches(haystack, needle, exact) {
    if (!haystack) return false;
    const collapsedNeedle = collapseText(needle, 10_000);
    const collapsedHaystack = exact ? collapseText(haystack, 100_000) : haystack;
    return exact
      ? collapsedHaystack === collapsedNeedle
      : collapsedHaystack.toLowerCase().includes(collapsedNeedle.toLowerCase());
  }

  /**
   * Full collapsed subtree text used for innermost text matching. Shadow hosts
   * contribute their shadow content.
   *
   * @param {Element} element
   * @returns {string}
   */
  function getMatchableText(element) {
    if (getShadowRoot(element)) return getElementTextContent(element, 100_000);
    return collapseText(element.textContent, 100_000);
  }

  /**
   * Match visible text the way a user reads it: own text and text-like
   * attributes first, otherwise the innermost element whose combined
   * descendant text matches (so `<button><b>Place</b> order</button>` matches
   * "Place order" on the button, not on `<body>`).
   *
   * @param {Element} element
   * @param {string} needle
   * @param {boolean} exact
   * @returns {boolean}
   */
  function matchesTextLocator(element, needle, exact) {
    if (NON_RENDERED_TAGS.has(element.tagName)) return false;
    const own = extractElementText(element);
    if (own && own.split(' | ').some((part) => textMatches(part, needle, exact))) return true;
    if (!textMatches(getMatchableText(element), needle, exact)) return false;
    for (const child of element.children ?? []) {
      if (textMatches(getMatchableText(child), needle, exact)) return false;
    }
    return true;
  }

  /**
   * @param {Element} element
   * @param {ElementLocator} locator
   * @returns {boolean}
   */
  function matchesLocator(element, locator) {
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

  /**
   * Locate elements by role, accessible name, text, label, placeholder, or test
   * id across the light DOM and shadow roots. Hidden matches are counted but
   * excluded unless `includeHidden` is set.
   *
   * @param {ElementLocator} locator
   * @param {{ maxResults?: number, scanLimit?: number }} [options]
   * @returns {LocateResult}
   */
  function locateElements(locator, options = {}) {
    const maxResults = options.maxResults ?? 10;
    const scanLimit = options.scanLimit ?? 5_000;
    const scope = locator.selector && locator.selector !== '*' ? locator.selector : null;
    /** @type {Iterable<Element>} */
    const candidates = scope
      ? querySelectorAllDeep(escapeTailwindSelector(scope))
      : walkElementsDeep(document.body ?? document.documentElement ?? document);
    /** @type {Element[]} */
    const matches = [];
    let hiddenMatches = 0;
    let scanned = 0;
    /** @type {'maxResults' | 'scanLimit' | null} */
    let truncationReason = null;
    for (const element of candidates) {
      if (scanned >= scanLimit) {
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
    }
    return { matches, hiddenMatches, scanned, truncationReason };
  }

  /**
   * @param {Element} element
   * @returns {NodeSummary & { visible?: boolean }}
   */
  function summarizeMatch(element) {
    const node = summarizeNode(element, ['id', 'class', 'href', 'data-testid'], 120, true).node;
    const role = getElementRoles(element)[0] ?? node.role;
    const name = getAccessibleName(element);
    return {
      ...node,
      role: role || null,
      name: name ? name.slice(0, 120) : node.name,
      ...(isElementVisible(element) ? {} : { visible: false }),
    };
  }

  /**
   * @param {LocateResult} located
   * @returns {{ found: boolean, nodes: NodeSummary[], count: number, scanned: number, truncated: boolean, truncationReason: 'maxResults' | 'scanLimit' | null, hiddenMatches?: number }}
   */
  function toFindResult(located) {
    return {
      found: located.matches.length > 0,
      nodes: located.matches.map(summarizeMatch),
      count: located.matches.length,
      scanned: located.scanned,
      truncated: located.truncationReason !== null,
      truncationReason: located.truncationReason,
      ...(located.hiddenMatches ? { hiddenMatches: located.hiddenMatches } : {}),
    };
  }

  /**
   * Cheap existence check used to pick the frame that owns a selector or
   * locator target. Hidden matches count: the action decides actionability.
   *
   * @param {Record<string, any>} params
   * @returns {{ found: boolean }}
   */
  function probeTarget(params) {
    const spec = params.target;
    if (!spec || typeof spec !== 'object') return { found: false };
    try {
      if (spec.elementRef) return { found: true };
      if (isLocator(spec)) {
        return {
          found:
            locateElements({ ...spec, includeHidden: true }, { maxResults: 1 }).matches.length > 0,
        };
      }
      if (typeof spec.selector === 'string' && spec.selector) {
        return { found: querySelectorDeep(escapeTailwindSelector(spec.selector)) !== null };
      }
    } catch {
      return { found: false };
    }
    return { found: false };
  }

  /**
   * Find elements matching visible text content.
   *
   * @param {Record<string, any>} params
   * @returns {ReturnType<typeof toFindResult>}
   */
  function findByText(params) {
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

  /**
   * Find elements matching ARIA role and optional accessible name.
   *
   * @param {Record<string, any>} params
   * @returns {ReturnType<typeof toFindResult>}
   */
  function findByRole(params) {
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

  /**
   * Check whether an element's visible text contains the given string.
   *
   * @param {Element} element
   * @param {string} text
   * @returns {boolean}
   */
  function elementMatchesText(element, text) {
    return matchesTextLocator(element, text, false);
  }

  /**
   * Find the first element matching a selector whose text contains a string.
   *
   * @param {string} selector
   * @param {string} text
   * @returns {Element | null}
   */
  function findElementWithText(selector, text) {
    for (const el of querySelectorAllDeep(selector)) {
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

  /**
   * Compact states worth showing in an outline line.
   *
   * @param {Element} element
   * @param {string} role
   * @returns {string[]}
   */
  function getOutlineStates(element, role) {
    /** @type {string[]} */
    const states = [];
    const control =
      /** @type {{ disabled?: unknown, checked?: unknown, required?: unknown, value?: unknown, type?: unknown }} */ (
        element
      );
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
          : /** @type {HTMLElement} */ (element).isContentEditable
            ? collapseText(element.textContent, 40)
            : '';
      if (value && control.type !== 'password')
        states.push(`value=${JSON.stringify(value.slice(0, 40))}`);
    }
    if (document.activeElement === element) states.push('focused');
    return states;
  }

  /**
   * Nearest outline ancestor across shadow boundaries.
   *
   * @param {Element} element
   * @param {Map<Element, number>} depths
   * @returns {number}
   */
  function getOutlineDepth(element, depths) {
    /** @type {Node | null} */
    let current = element.parentNode;
    for (let hops = 0; current && hops < 200; hops += 1) {
      if (current.nodeType === 1) {
        const depth = depths.get(/** @type {Element} */ (current));
        if (depth !== undefined) return depth + 1;
      }
      current =
        current.nodeType === 11 && /** @type {ShadowRoot} */ (current).host
          ? /** @type {ShadowRoot} */ (current).host
          : current.parentNode;
    }
    return 0;
  }

  /**
   * Build an actionable accessibility outline from the live DOM (including
   * shadow roots) without the debugger. Every line carries an elementRef that
   * input methods accept directly, so agents can go from overview to action in
   * one step. Hidden elements are skipped.
   *
   * @param {Record<string, any>} params
   * @returns {{ source: 'dom', format: 'outline' | 'tree', outline?: string, nodes?: Array<Record<string, unknown>>, count: number, scanned: number, truncated: boolean }}
   */
  function getAccessibilityOutline(params) {
    const maxNodes = clamp(params.maxNodes ?? 150, 10, 5000);
    const interactiveOnly = params.interactiveOnly === true;
    const root = params.selector
      ? querySelectorDeep(escapeTailwindSelector(params.selector))
      : null;
    if (params.selector && !root) {
      throw Object.assign(new Error('Accessibility outline selector matched no element.'), {
        code: 'ELEMENT_NOT_FOUND',
        details: { selector: String(params.selector).slice(0, 500) },
      });
    }
    /** @type {Map<Element, number>} */
    const depths = new Map();
    /** @type {Array<{ ref: string, role: string, name: string, depth: number, states: string[] }>} */
    const entries = [];
    let scanned = 0;
    let truncated = false;
    const candidates = root
      ? [root, ...walkElementsDeep(root)]
      : walkElementsDeep(document.body ?? document.documentElement ?? document);
    for (const element of candidates) {
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
      if (entries.length >= maxNodes) {
        truncated = true;
        break;
      }
      const depth = getOutlineDepth(element, depths);
      depths.set(element, depth);
      entries.push({
        ref: rememberElement(element),
        role,
        name: collapseText(getAccessibleName(element), OUTLINE_NAME_BUDGET),
        depth,
        states: getOutlineStates(element, role),
      });
    }
    const base = {
      source: /** @type {'dom'} */ ('dom'),
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
