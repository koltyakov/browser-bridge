// @ts-check

(() => {
  const globalState =
    /** @type {typeof globalThis & { __BBX_CONTENT_DOM_QUERY__?: Record<string, unknown> }} */ (
      globalThis
    );

  if (globalState.__BBX_CONTENT_DOM_QUERY__) {
    return;
  }

  const contentHelpers =
    /** @type {typeof globalThis & { __BBX_CONTENT_HELPERS__?: {
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
     truncateText: (value: string, budget: number) => { value: string, truncated: boolean, omitted: number }
    } }} */ (globalThis).__BBX_CONTENT_HELPERS__;
  const registry =
    /** @type {typeof globalThis & { __BBX_CONTENT_REGISTRY__?: {
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
    clamp,
    extractElementText,
    findElementForWaitState,
    getImplicitRole,
    getImplicitRoleSelector,
    toRect,
    truncateText,
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
      : document.querySelector(query.selector);
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
          : document.querySelector(selector) !== null;
        return { found: !exists, element: null };
      }
      const candidates = document.querySelectorAll(selector);
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
   * Find elements matching visible text content.
   *
   * @param {Record<string, any>} params
   * @returns {{ found: boolean, nodes: NodeSummary[], count: number, scanned: number, truncated: boolean, truncationReason: 'maxResults' | 'scanLimit' | null }}
   */
  function findByText(params) {
    const searchText = String(params.text || '');
    if (!searchText) {
      throw new Error('text is required for dom.find_by_text');
    }
    const exact = Boolean(params.exact);
    const scope = String(params.selector || '*');
    const maxResults = clamp(params.maxResults ?? 10, 1, 50);
    const scanLimit = clamp(params.scanLimit ?? 1000, 1, 5000);
    const candidates = getElementCandidates(scope);
    const results = [];
    let scanned = 0;
    /** @type {'maxResults' | 'scanLimit' | null} */
    let truncationReason = null;

    for (const el of candidates) {
      if (scanned >= scanLimit) {
        truncationReason = 'scanLimit';
        break;
      }
      scanned += 1;
      const visibleText = extractElementText(el);
      if (!visibleText) continue;
      const matches = exact
        ? visibleText === searchText
        : visibleText.toLowerCase().includes(searchText.toLowerCase());
      if (matches) {
        if (results.length >= maxResults) {
          truncationReason = 'maxResults';
          break;
        }
        results.push(
          summarizeNode(el, ['id', 'class', 'role', 'href', 'data-testid'], 120, true).node
        );
      }
    }

    return {
      found: results.length > 0,
      nodes: results,
      count: results.length,
      scanned,
      truncated: truncationReason !== null,
      truncationReason,
    };
  }

  /**
   * @param {string} scope
   * @returns {Iterable<Element>}
   */
  function getElementCandidates(scope) {
    if (scope === '*' && typeof document.createTreeWalker === 'function') {
      const root = document.body || document.documentElement;
      if (!root) return [];
      return {
        *[Symbol.iterator]() {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          /** @type {Node | null} */
          let node = root;
          while (node) {
            if (node instanceof Element) yield node;
            node = walker.nextNode();
          }
        },
      };
    }
    return document.querySelectorAll(scope);
  }

  /**
   * Find elements matching ARIA role and optional accessible name.
   *
   * @param {Record<string, any>} params
   * @returns {{ found: boolean, nodes: NodeSummary[], count: number, scanned: number, truncated: boolean, truncationReason: 'maxResults' | null }}
   */
  function findByRole(params) {
    const role = String(params.role || '');
    if (!role) {
      throw new Error('role is required for dom.find_by_role');
    }
    const name = params.name ? String(params.name) : null;
    const scope = String(params.selector || '*');
    const maxResults = clamp(params.maxResults ?? 10, 1, 50);

    const implicitSelector = getImplicitRoleSelector(role);
    const attrSelector = `[role="${CSS.escape(role)}"]`;
    const combinedSelector =
      scope === '*'
        ? implicitSelector
          ? `${attrSelector}, ${implicitSelector}`
          : attrSelector
        : scope;
    const candidates = document.querySelectorAll(combinedSelector);
    const results = [];
    let scanned = 0;
    /** @type {'maxResults' | null} */
    let truncationReason = null;

    for (const el of candidates) {
      scanned += 1;
      const elRole = el.getAttribute('role') || getImplicitRole(el);
      if (elRole !== role) continue;
      if (name !== null) {
        const accName = getAccessibleName(el);
        if (!accName || !accName.toLowerCase().includes(name.toLowerCase())) {
          continue;
        }
      }
      if (results.length >= maxResults) {
        truncationReason = 'maxResults';
        break;
      }
      results.push(
        summarizeNode(el, ['id', 'class', 'role', 'aria-label', 'href'], 120, true).node
      );
    }

    return {
      found: results.length > 0,
      nodes: results,
      count: results.length,
      scanned,
      truncated: truncationReason !== null,
      truncationReason,
    };
  }

  /**
   * Resolve the accessible-name sources used by role search.
   *
   * @param {Element} element
   * @returns {string}
   */
  function getAccessibleName(element) {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/u)
        .map((id) => id.trim())
        .filter(Boolean)
        .map((id) => getLabelElementText(id))
        .filter(Boolean)
        .join(' ')
        .trim();
      if (text) return text;
    }

    return (
      element.getAttribute('aria-label') ||
      element.getAttribute('title') ||
      extractElementText(element)
    );
  }

  /**
   * @param {string} id
   * @returns {string}
   */
  function getLabelElementText(id) {
    const label = document.getElementById?.(id) || document.querySelector(`#${CSS.escape(id)}`);
    return label ? extractElementText(label) : '';
  }

  /**
   * Check whether an element's visible text contains the given string.
   *
   * @param {Element} element
   * @param {string} text
   * @returns {boolean}
   */
  function elementMatchesText(element, text) {
    const visible = extractElementText(element);
    return visible.toLowerCase().includes(text.toLowerCase());
  }

  /**
   * Find the first element matching a selector whose text contains a string.
   *
   * @param {string} selector
   * @param {string} text
   * @returns {Element | null}
   */
  function findElementWithText(selector, text) {
    for (const el of document.querySelectorAll(selector)) {
      if (elementMatchesText(el, text)) {
        return el;
      }
    }
    return null;
  }

  globalState.__BBX_CONTENT_DOM_QUERY__ = Object.freeze({
    describeElement,
    domQuery,
    findByRole,
    findByText,
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
