// @ts-check

(() => {
  if (globalThis.__chromeCodexBridgeContentScriptLoaded) {
    return;
  }
  globalThis.__chromeCodexBridgeContentScriptLoaded = true;

  /**
   * @typedef {{
   *   maxNodes: number,
   *   maxDepth: number,
   *   textBudget: number,
   *   includeHtml: boolean,
   *   includeScreenshot: boolean,
   *   attributeAllowlist: string[],
   *   styleAllowlist: string[]
   * }} Budget
   */

  /**
   * @typedef {{
   *   selector: string,
   *   withinRef: string | null,
   *   budget: Budget,
   *   includeRoles: boolean
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
   *   bbox: { x: number, y: number, width: number, height: number }
   * }} NodeSummary
  */

  const elementRegistry = new Map();
  const patchRegistry = new Map();
  const NON_TEXT_INPUT_TYPES = new Set([
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ]);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "bridge.ping") {
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type !== "bridge.execute") {
      return false;
    }

    try {
      const result = handleCommand(message.method, message.params);
      Promise.resolve(result).then(sendResponse);
    } catch (error) {
      sendResponse({ error: error.message });
    }

    return true;
  });

  /**
   * Dispatch a bridge method within the page context.
   *
   * @param {string} method
   * @param {Record<string, any>} params
   * @returns {unknown}
   */
  function handleCommand(method, params) {
    switch (method) {
      case "page.get_state":
        return getPageState();
      case "page.get_storage":
        return getStorageData(params);
      case "navigation.navigate":
      case "navigation.reload":
      case "navigation.go_back":
      case "navigation.go_forward":
        throw new Error(`Unsupported content-script method ${method}`);
      case "dom.query":
        return domQuery(params);
      case "dom.describe":
        return describeElement(params.elementRef);
      case "dom.get_text":
        return getText(params.elementRef, params.textBudget);
      case "dom.get_attributes":
        return getAttributes(params.elementRef, params.attributes ?? []);
      case "dom.wait_for":
        return waitForDom(params);
      case "dom.find_by_text":
        return findByText(params);
      case "dom.find_by_role":
        return findByRole(params);
      case "dom.get_html":
        return getHtml(params);
      case "layout.get_box_model":
        return getBoxModel(params.elementRef);
      case "layout.hit_test":
        return hitTest(params.x, params.y);
      case "styles.get_computed":
        return getComputedStyles(params.elementRef, params.properties);
      case "styles.get_matched_rules":
        return getMatchedRules(params.elementRef);
      case "viewport.scroll":
        return scrollViewport(params);
      case "input.click":
        return clickTarget(params);
      case "input.focus":
        return focusTarget(params);
      case "input.type":
        return typeIntoTarget(params);
      case "input.press_key":
        return pressKeyTarget(params);
      case "input.set_checked":
        return setCheckedTarget(params);
      case "input.select_option":
        return selectOptionTarget(params);
      case "input.hover":
        return hoverTarget(params);
      case "input.drag":
        return dragTarget(params);
      case "patch.apply_styles":
        return applyStylePatch(params);
      case "patch.apply_dom":
        return applyDomPatch(params);
      case "patch.list":
        return listPatches();
      case "patch.rollback":
        return rollbackPatch(params.patchId);
      case "patch.commit_session_baseline":
        return { committed: true };
      case "screenshot.capture_element":
        return getElementRect(params.elementRef);
      default:
        throw new Error(`Unsupported method ${method}`);
    }
  }

  /**
   * Return lightweight page state useful for browser automation decisions.
   *
   * @returns {{
   *   url: string,
   *   origin: string,
   *   title: string,
   *   readyState: DocumentReadyState,
   *   focused: boolean,
   *   viewport: { width: number, height: number, devicePixelRatio: number },
   *   scroll: { x: number, y: number, maxX: number, maxY: number },
   *   activeElement: NodeSummary | null,
   *   selection: { value: string, truncated: boolean, omitted: number }
   * }}
   */
  function getPageState() {
    const scrollingElement =
      document.scrollingElement || document.documentElement || document.body;
    const selection = document.getSelection?.()?.toString() || "";

    return {
      url: window.location.href,
      origin: window.location.origin,
      title: document.title,
      readyState: document.readyState,
      focused: document.hasFocus(),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
      scroll: {
        x: window.scrollX,
        y: window.scrollY,
        maxX: Math.max(
          0,
          (scrollingElement?.scrollWidth || document.documentElement.scrollWidth || 0) -
            window.innerWidth,
        ),
        maxY: Math.max(
          0,
          (scrollingElement?.scrollHeight || document.documentElement.scrollHeight || 0) -
            window.innerHeight,
        ),
      },
      activeElement:
        document.activeElement instanceof Element
          ? summarizeNode(
              document.activeElement,
              ["id", "class", "name", "type", "href", "role"],
              120,
            ).node
          : null,
      selection: truncateText(selection.trim(), 200),
    };
  }

  /**
   * Perform a bounded breadth-first DOM summary rooted at a selector or existing
   * element reference.
   *
   * @param {Record<string, any>} params
   * @returns {{ nodes: NodeSummary[], revision: number, truncated?: boolean }}
   */
  function domQuery(params) {
    const query = normalizeDomQuery(params);
    const root = query.withinRef
      ? getRequiredElement(query.withinRef)
      : document.querySelector(query.selector);
    if (!root) {
      return { nodes: [], revision: getDocumentRevision() };
    }

    const nodes = [];
    let remaining = query.budget.textBudget;
    const queue = [{ element: root, depth: 0 }];

    while (
      queue.length &&
      nodes.length < query.budget.maxNodes &&
      remaining > 0
    ) {
      const { element, depth } = queue.shift();
      if (depth > query.budget.maxDepth) {
        continue;
      }

      const summary = summarizeNode(
        element,
        query.budget.attributeAllowlist,
        remaining,
      );
      remaining -= summary.textLength;
      nodes.push(summary.node);

      for (const child of element.children) {
        queue.push({ element: child, depth: depth + 1 });
      }
    }

    return {
      nodes,
      revision: getDocumentRevision(),
      truncated: nodes.length >= query.budget.maxNodes || remaining <= 0,
    };
  }

  /**
   * Create a compact, token-efficient summary for a single element.
   *
   * @param {Element} element
   * @param {string[]} attributeAllowlist
   * @param {number} remainingText
   * @returns {{ textLength: number, node: NodeSummary }}
   */
  function summarizeNode(element, attributeAllowlist, remainingText) {
    const elementRef = rememberElement(element);
    const text = truncateText(
      extractElementText(element),
      Math.min(Math.max(0, remainingText), 160),
    );
    return {
      textLength: text.value.length,
      node: {
        elementRef,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        name:
          element.getAttribute("aria-label") ||
          element.getAttribute("name") ||
          null,
        textExcerpt: text.value,
        attrs: summarizeAttributes(element, attributeAllowlist),
        bbox: toRect(element.getBoundingClientRect()),
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
    }, {});
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
    return truncateText(
      (element.innerText || element.textContent || "").trim(),
      budget,
    );
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
    }, {});
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
    return element ? summarizeNode(element, ["id", "class"], 120).node : null;
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
      : ["display", "position", "width", "height", "color"];
    return requested.reduce((accumulator, property) => {
      accumulator[property] = styles.getPropertyValue(property);
      return accumulator;
    }, {});
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
      inlineStyle: element.getAttribute("style") || "",
    };
  }

  /**
   * Scroll the window or a specific scrollable element.
   *
   * @param {Record<string, any>} params
   * @returns {{
   *   target: string,
   *   top: number,
   *   left: number,
   *   behavior: 'auto' | 'smooth',
   *   relative: boolean
   * }}
   */
  function scrollViewport(params) {
    const top = Number(params.top) || 0;
    const left = Number(params.left) || 0;
    const behavior = params.behavior === "smooth" ? "smooth" : "auto";
    const relative = Boolean(params.relative);

    if (params.target?.elementRef || params.target?.selector) {
      const element = resolveTarget(params.target);
      const scrollTarget = getScrollableElementTarget(element);
      if (relative) {
        scrollTarget.scrollBy({
          top,
          left,
          behavior,
        });
      } else {
        scrollTarget.scrollTo({
          top,
          left,
          behavior,
        });
      }

      return {
        target: rememberElement(scrollTarget),
        top: scrollTarget.scrollTop,
        left: scrollTarget.scrollLeft,
        behavior,
        relative,
      };
    }

    if (relative) {
      window.scrollBy({
        top,
        left,
        behavior,
      });
    } else {
      window.scrollTo({
        top,
        left,
        behavior,
      });
    }

    return {
      target: "window",
      top: window.scrollY,
      left: window.scrollX,
      behavior,
      relative,
    };
  }

  /**
   * Trigger a click-like interaction on a target element.
   *
   * @param {Record<string, any>} params
   * @returns {{ elementRef: string, clicked: boolean, button: string, clickCount: number }}
   */
  function clickTarget(params) {
    const element = resolveTarget(params.target);
    const button = normalizeMouseButton(params.button);
    const clickCount = clamp(params.clickCount ?? 1, 1, 2);
    const modifiers = normalizeModifierState(params.modifiers);
    const point = getViewportPoint(element);

    scrollTargetIntoView(element);
    focusElement(element);
    dispatchMouseEvent(element, "mousemove", point, button, 0, modifiers);
    dispatchMouseEvent(element, "mousedown", point, button, clickCount, modifiers);
    dispatchMouseEvent(element, "mouseup", point, button, clickCount, modifiers);

    if (button === "left") {
      if (element instanceof HTMLElement) {
        element.click();
        if (clickCount === 2) {
          element.click();
          dispatchMouseEvent(element, "dblclick", point, button, clickCount, modifiers);
        }
      } else {
        dispatchMouseEvent(element, "click", point, button, clickCount, modifiers);
        if (clickCount === 2) {
          dispatchMouseEvent(element, "dblclick", point, button, clickCount, modifiers);
        }
      }
    } else if (button === "right") {
      dispatchMouseEvent(element, "contextmenu", point, button, clickCount, modifiers);
    } else {
      dispatchMouseEvent(element, "auxclick", point, button, clickCount, modifiers);
    }

    return {
      elementRef: rememberElement(element),
      clicked: true,
      button,
      clickCount,
    };
  }

  /**
   * Focus one element so follow-up keyboard input lands consistently.
   *
   * @param {Record<string, any>} params
   * @returns {{ elementRef: string, focused: boolean, tag: string }}
   */
  function focusTarget(params) {
    const element = resolveTarget(params.target);
    scrollTargetIntoView(element);
    const focused = focusElement(element);
    return {
      elementRef: rememberElement(element),
      focused: isElementFocused(element) || isElementFocused(focused),
      tag: focused.tagName.toLowerCase(),
    };
  }

  /**
   * Type text into an editable control or contenteditable region.
   *
   * @param {Record<string, any>} params
   * @returns {{ elementRef: string, typed: number, value: string }}
   */
  function typeIntoTarget(params) {
    const element = resolveTarget(params.target);
    const editable = getEditableTarget(element);
    if (!editable) {
      throw new Error("Target is not an editable control.");
    }

    scrollTargetIntoView(editable);
    focusElement(editable);

    if (params.clear) {
      clearEditableValue(editable);
    }

    const text = String(params.text ?? "");
    for (const character of text) {
      runKeyAction(editable, character, params.modifiers);
    }

    if (params.submit) {
      submitElement(editable);
    }

    return {
      elementRef: rememberElement(editable),
      typed: text.length,
      value: getEditableValue(editable),
    };
  }

  /**
   * Send one keyboard interaction to the currently focused or targeted element.
   *
   * @param {Record<string, any>} params
   * @returns {{ elementRef: string | null, key: string, handled: boolean }}
   */
  function pressKeyTarget(params) {
    const target =
      params.target
        ? resolveTarget(params.target)
        : document.activeElement instanceof Element
          ? document.activeElement
          : document.body;
    scrollTargetIntoView(target);
    focusElement(target);
    const key = String(params.key ?? "");
    if (!key) {
      throw new Error("A key is required.");
    }

    const result = runKeyAction(target, key, params.modifiers);
    return {
      elementRef:
        result.target instanceof Element
          ? rememberElement(result.target)
          : null,
      key: result.key,
      handled: result.handled,
    };
  }

  /**
   * Toggle a checkbox-like control to a desired checked state.
   *
   * @param {Record<string, any>} params
   * @returns {{ elementRef: string, checked: boolean, changed: boolean, type: string }}
   */
  function setCheckedTarget(params) {
    const element = resolveCheckableTarget(params.target);
    const checked = params.checked !== false;
    if (element.type === "radio" && !checked && element.checked) {
      throw new Error("Radio inputs cannot be unchecked directly.");
    }

    scrollTargetIntoView(element);
    focusElement(element);
    const changed = element.checked !== checked;
    if (changed) {
      element.click();
      if (element.checked !== checked) {
        element.checked = checked;
        element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      }
    }

    return {
      elementRef: rememberElement(element),
      checked: element.checked,
      changed,
      type: element.type,
    };
  }

  /**
   * Select options in a native select control by value, label, or index.
   *
   * @param {Record<string, any>} params
   * @returns {{ elementRef: string, changed: boolean, multiple: boolean, selectedValues: string[] }}
   */
  function selectOptionTarget(params) {
    const element = resolveSelectTarget(params.target);
    const values = Array.isArray(params.values)
      ? params.values.filter((value) => typeof value === "string")
      : [];
    const labels = Array.isArray(params.labels)
      ? params.labels.filter((label) => typeof label === "string")
      : [];
    const indexes = Array.isArray(params.indexes)
      ? params.indexes
          .map((index) => Number(index))
          .filter((index) => Number.isInteger(index) && index >= 0)
      : [];

    if (!values.length && !labels.length && !indexes.length) {
      throw new Error("At least one option selector is required.");
    }

    scrollTargetIntoView(element);
    focusElement(element);

    const options = [...element.options];
    const selectedBefore = getSelectedOptionValues(element);
    const matchingOptions = options.filter((option, index) => {
      return (
        values.includes(option.value) ||
        labels.includes(option.label) ||
        labels.includes(option.text.trim()) ||
        indexes.includes(index)
      );
    });

    if (!matchingOptions.length) {
      throw new Error("No matching option found.");
    }

    if (element.multiple) {
      const matchedValues = new Set(matchingOptions.map((option) => option.value));
      for (const option of options) {
        option.selected = matchedValues.has(option.value);
      }
    } else {
      element.value = matchingOptions[0].value;
    }

    const selectedAfter = getSelectedOptionValues(element);
    const changed = !areStringArraysEqual(selectedBefore, selectedAfter);
    if (changed) {
      element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }

    return {
      elementRef: rememberElement(element),
      changed,
      multiple: element.multiple,
      selectedValues: selectedAfter,
    };
  }

  /**
   * Apply a reversible inline style patch to an element or selector target.
   *
   * @param {Record<string, any>} params
   * @returns {{ patchId: string, applied: boolean }}
   */
  function applyStylePatch(params) {
    const element = /** @type {HTMLElement} */ (resolveTarget(params.target));
    const patchId = params.patchId || `patch_${crypto.randomUUID()}`;
    const previous = {};
    for (const [property, value] of Object.entries(params.declarations || {})) {
      previous[property] = element.style.getPropertyValue(property);
      element.style.setProperty(
        property,
        value,
        params.important ? "important" : "",
      );
    }
    patchRegistry.set(patchId, {
      kind: "style",
      elementRef: rememberElement(element),
      previous,
    });
    return { patchId, applied: true };
  }

  /**
   * Apply a reversible DOM patch to a target element.
   *
   * @param {Record<string, any>} params
   * @returns {{ patchId: string, applied: boolean }}
   */
  function applyDomPatch(params) {
    const element = resolveTarget(params.target);
    const patchId = params.patchId || `patch_${crypto.randomUUID()}`;
    const previous = {
      text: element.textContent,
      attributes: {},
    };

    switch (params.operation) {
      case "set_text":
        element.textContent = String(params.value ?? "");
        break;
      case "set_attribute":
        previous.attributes[params.name] = element.getAttribute(params.name);
        element.setAttribute(params.name, String(params.value ?? ""));
        break;
      case "remove_attribute":
        previous.attributes[params.name] = element.getAttribute(params.name);
        element.removeAttribute(params.name);
        break;
      case "toggle_class":
        element.classList.toggle(String(params.value));
        break;
      default:
        throw new Error(`Unsupported DOM patch operation ${params.operation}`);
    }

    patchRegistry.set(patchId, {
      kind: "dom",
      elementRef: rememberElement(element),
      operation: params.operation,
      previous,
    });
    return { patchId, applied: true };
  }

  /**
   * List currently active reversible patches.
   *
   * @returns {Array<{ patchId: string, kind: string, elementRef: string }>}
   */
  function listPatches() {
    return [...patchRegistry.entries()].map(([patchId, patch]) => ({
      patchId,
      kind: patch.kind,
      elementRef: patch.elementRef,
    }));
  }

  /**
   * Roll back a previously applied patch if it still exists.
   *
   * @param {string} patchId
   * @returns {{ patchId: string, rolledBack: boolean }}
   */
  function rollbackPatch(patchId) {
    const patch = patchRegistry.get(patchId);
    if (!patch) {
      return { patchId, rolledBack: false };
    }

    const element = getRequiredElement(patch.elementRef);
    if (patch.kind === "style") {
      const htmlElement = /** @type {HTMLElement} */ (element);
      for (const [property, value] of Object.entries(patch.previous)) {
        if (value) {
          htmlElement.style.setProperty(property, value);
        } else {
          htmlElement.style.removeProperty(property);
        }
      }
    } else if (patch.kind === "dom") {
      element.textContent = patch.previous.text;
      for (const [name, value] of Object.entries(patch.previous.attributes)) {
        if (value == null) {
          element.removeAttribute(name);
        } else {
          element.setAttribute(name, value);
        }
      }
    }

    patchRegistry.delete(patchId);
    return { patchId, rolledBack: true };
  }

  /**
   * Return the viewport rect for an element reference.
   *
   * @param {string} elementRef
   * @returns {{ x: number, y: number, width: number, height: number, scale: number }}
   */
  function getElementRect(elementRef) {
    const rect = getRequiredElement(elementRef).getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      scale: window.devicePixelRatio || 1,
    };
  }

  // ── New methods: DOM wait, find, HTML, hover, drag, storage ────────

  /**
   * Wait for a DOM condition using MutationObserver + polling fallback.
   *
   * @param {Record<string, any>} params
   * @returns {Promise<{ found: boolean, elementRef: string | null, duration: number }>}
   */
  function waitForDom(params) {
    const selector = String(params.selector || "");
    if (!selector) {
      throw new Error("selector is required for dom.wait_for");
    }
    const text = params.text != null ? String(params.text) : null;
    const waitState = params.state || "attached";
    const timeout = clamp(params.timeoutMs ?? 5000, 100, 30000);
    const start = Date.now();

    /**
     * @returns {{ found: boolean, element: Element | null }}
     */
    function check() {
      if (waitState === "detached") {
        const exists = text
          ? findElementWithText(selector, text) !== null
          : document.querySelector(selector) !== null;
        return { found: !exists, element: null };
      }
      const candidates = document.querySelectorAll(selector);
      for (const el of candidates) {
        if (text !== null && !elementMatchesText(el, text)) {
          continue;
        }
        if (waitState === "visible") {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden") {
            return { found: true, element: el };
          }
        } else if (waitState === "hidden") {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") {
            return { found: true, element: el };
          }
        } else {
          return { found: true, element: el };
        }
      }
      return { found: false, element: null };
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
      let observer;
      let timeoutHandle;
      let pollHandle;

      function cleanup() {
        if (observer) observer.disconnect();
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (pollHandle) clearInterval(pollHandle);
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

      observer = new MutationObserver(tryResolve);
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
          duration: Date.now() - start,
        });
      }, timeout);
    });
  }

  /**
   * Find elements matching visible text content.
   *
   * @param {Record<string, any>} params
   * @returns {{ nodes: NodeSummary[], count: number }}
   */
  function findByText(params) {
    const searchText = String(params.text || "");
    if (!searchText) {
      throw new Error("text is required for dom.find_by_text");
    }
    const exact = Boolean(params.exact);
    const scope = String(params.selector || "*");
    const maxResults = clamp(params.maxResults ?? 10, 1, 50);
    const candidates = document.querySelectorAll(scope);
    const results = [];

    for (const el of candidates) {
      if (results.length >= maxResults) break;
      const visibleText = extractElementText(el);
      if (!visibleText) continue;
      const matches = exact
        ? visibleText === searchText
        : visibleText.toLowerCase().includes(searchText.toLowerCase());
      if (matches) {
        results.push(summarizeNode(el, ["id", "class", "role", "href", "data-testid"], 120).node);
      }
    }

    return { nodes: results, count: results.length };
  }

  /**
   * Find elements matching ARIA role and optional accessible name.
   *
   * @param {Record<string, any>} params
   * @returns {{ nodes: NodeSummary[], count: number }}
   */
  function findByRole(params) {
    const role = String(params.role || "");
    if (!role) {
      throw new Error("role is required for dom.find_by_role");
    }
    const name = params.name ? String(params.name) : null;
    const scope = String(params.selector || "*");
    const maxResults = clamp(params.maxResults ?? 10, 1, 50);

    const candidates = document.querySelectorAll(
      scope === "*" ? `[role="${CSS.escape(role)}"]` : scope
    );
    const results = [];

    for (const el of candidates) {
      if (results.length >= maxResults) break;
      const elRole = el.getAttribute("role") || getImplicitRole(el);
      if (elRole !== role) continue;
      if (name !== null) {
        const accName =
          el.getAttribute("aria-label") ||
          el.getAttribute("aria-labelledby") ||
          el.getAttribute("title") ||
          extractElementText(el);
        if (!accName || !accName.toLowerCase().includes(name.toLowerCase())) {
          continue;
        }
      }
      results.push(summarizeNode(el, ["id", "class", "role", "aria-label", "href"], 120).node);
    }

    return { nodes: results, count: results.length };
  }

  /**
   * Return innerHTML or outerHTML of an element, truncated to budget.
   *
   * @param {Record<string, any>} params
   * @returns {{ html: string, truncated: boolean, omitted: number }}
   */
  function getHtml(params) {
    const element = getRequiredElement(String(params.elementRef || ""));
    const outer = Boolean(params.outer);
    const maxLength = clamp(params.maxLength ?? 2000, 32, 50000);
    const raw = outer ? element.outerHTML : element.innerHTML;
    const t = truncateText(raw, maxLength);
    return { html: t.value, truncated: t.truncated, omitted: t.omitted };
  }

  /**
   * Trigger hover state on an element by dispatching mouse events.
   *
   * @param {Record<string, any>} params
   * @returns {Promise<{ elementRef: string, hovered: boolean }> | { elementRef: string, hovered: boolean }}
   */
  function hoverTarget(params) {
    const element = resolveTarget(params.target);
    const point = getViewportPoint(element);
    const modifiers = normalizeModifierState(params.modifiers);
    const duration = clamp(params.duration ?? 0, 0, 5000);

    scrollTargetIntoView(element);
    dispatchMouseEvent(element, "mouseenter", point, "left", 0, modifiers);
    dispatchMouseEvent(element, "mouseover", point, "left", 0, modifiers);
    dispatchMouseEvent(element, "mousemove", point, "left", 0, modifiers);

    const ref = rememberElement(element);
    if (duration > 0) {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({ elementRef: ref, hovered: true });
        }, duration);
      });
    }
    return { elementRef: ref, hovered: true };
  }

  /**
   * Perform a drag-and-drop operation between two elements.
   *
   * @param {Record<string, any>} params
   * @returns {{ sourceRef: string, destinationRef: string, dragged: boolean }}
   */
  function dragTarget(params) {
    const source = resolveTarget(params.source);
    const destination = resolveTarget(params.destination);
    const sourcePoint = getViewportPoint(source);
    const destPoint = getViewportPoint(destination);
    const offsetX = Number(params.offsetX) || 0;
    const offsetY = Number(params.offsetY) || 0;
    const endPoint = { x: destPoint.x + offsetX, y: destPoint.y + offsetY };
    const emptyMods = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

    scrollTargetIntoView(source);

    const dataTransfer = new DataTransfer();

    source.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, cancelable: true, composed: true,
      clientX: sourcePoint.x, clientY: sourcePoint.y, ...emptyMods,
    }));
    source.dispatchEvent(new DragEvent("dragstart", {
      bubbles: true, cancelable: true, composed: true,
      clientX: sourcePoint.x, clientY: sourcePoint.y, dataTransfer,
    }));
    source.dispatchEvent(new DragEvent("drag", {
      bubbles: true, cancelable: true, composed: true,
      clientX: sourcePoint.x, clientY: sourcePoint.y, dataTransfer,
    }));

    scrollTargetIntoView(destination);

    destination.dispatchEvent(new DragEvent("dragenter", {
      bubbles: true, cancelable: true, composed: true,
      clientX: endPoint.x, clientY: endPoint.y, dataTransfer,
    }));
    destination.dispatchEvent(new DragEvent("dragover", {
      bubbles: true, cancelable: true, composed: true,
      clientX: endPoint.x, clientY: endPoint.y, dataTransfer,
    }));
    destination.dispatchEvent(new DragEvent("drop", {
      bubbles: true, cancelable: true, composed: true,
      clientX: endPoint.x, clientY: endPoint.y, dataTransfer,
    }));
    source.dispatchEvent(new DragEvent("dragend", {
      bubbles: true, cancelable: true, composed: true,
      clientX: endPoint.x, clientY: endPoint.y, dataTransfer,
    }));
    source.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true, cancelable: true, composed: true,
      clientX: endPoint.x, clientY: endPoint.y, ...emptyMods,
    }));

    return {
      sourceRef: rememberElement(source),
      destinationRef: rememberElement(destination),
      dragged: true,
    };
  }

  /**
   * Read localStorage or sessionStorage entries.
   *
   * @param {Record<string, any>} params
   * @returns {{ type: string, entries: Record<string, string | null>, count: number }}
   */
  function getStorageData(params) {
    const type = params.type === "session" ? "session" : "local";
    const storage = type === "session" ? sessionStorage : localStorage;
    const keys = Array.isArray(params.keys) ? params.keys.filter((k) => typeof k === "string") : null;
    /** @type {Record<string, string | null>} */
    const result = {};
    if (keys) {
      for (const key of keys) {
        result[key] = storage.getItem(key);
      }
    } else {
      for (let i = 0; i < Math.min(storage.length, 100); i++) {
        const key = storage.key(i);
        if (key !== null) {
          const val = storage.getItem(key);
          result[key] = val !== null && val.length > 500 ? val.slice(0, 500) + "\u2026" : val;
        }
      }
    }
    return { type, entries: result, count: Object.keys(result).length };
  }

  // ── Helpers for new methods ────────────────────────────────────────

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

  /**
   * Return a basic implicit ARIA role for common HTML elements.
   *
   * @param {Element} el
   * @returns {string}
   */
  function getImplicitRole(el) {
    const tag = el.tagName.toLowerCase();
    const roleMap = {
      a: el.hasAttribute("href") ? "link" : "",
      article: "article",
      aside: "complementary",
      button: "button",
      dialog: "dialog",
      footer: "contentinfo",
      form: "form",
      h1: "heading", h2: "heading", h3: "heading",
      h4: "heading", h5: "heading", h6: "heading",
      header: "banner",
      img: "img",
      input: getInputImplicitRole(el),
      li: "listitem",
      main: "main",
      nav: "navigation",
      ol: "list",
      option: "option",
      progress: "progressbar",
      section: "region",
      select: "listbox",
      table: "table",
      td: "cell",
      textarea: "textbox",
      th: "columnheader",
      tr: "row",
      ul: "list",
    };
    return roleMap[tag] || "";
  }

  /**
   * @param {Element} el
   * @returns {string}
   */
  function getInputImplicitRole(el) {
    if (!(el instanceof HTMLInputElement)) return "textbox";
    const type = el.type.toLowerCase();
    const map = {
      button: "button", checkbox: "checkbox", radio: "radio",
      range: "slider", search: "searchbox", submit: "button",
      reset: "button", image: "button",
    };
    return map[type] || "textbox";
  }

  /**
   * Resolve a patch target from either an element reference or a selector.
   *
   * @param {{ elementRef?: string, selector?: string }} [target={}]
   * @returns {Element}
   */
  function resolveTarget(target = {}) {
    if (target.elementRef) {
      return getRequiredElement(target.elementRef);
    }
    if (target.selector) {
      const element = document.querySelector(target.selector);
      if (element) {
        return element;
      }
    }
    throw new Error("Target not found.");
  }

  /**
   * @param {{ elementRef?: string, selector?: string }} [target={}]
   * @returns {HTMLInputElement}
   */
  function resolveCheckableTarget(target = {}) {
    const element = resolveTarget(target);
    if (
      element instanceof HTMLInputElement &&
      ["checkbox", "radio"].includes(element.type.toLowerCase())
    ) {
      return element;
    }

    if (element instanceof HTMLElement) {
      const nested = element.querySelector('input[type="checkbox"], input[type="radio"]');
      if (nested instanceof HTMLInputElement) {
        return nested;
      }
    }

    throw new Error("Target is not a checkbox or radio input.");
  }

  /**
   * @param {{ elementRef?: string, selector?: string }} [target={}]
   * @returns {HTMLSelectElement}
   */
  function resolveSelectTarget(target = {}) {
    const element = resolveTarget(target);
    if (element instanceof HTMLSelectElement) {
      return element;
    }

    if (element instanceof HTMLOptionElement && element.parentElement instanceof HTMLSelectElement) {
      return element.parentElement;
    }

    if (element instanceof HTMLElement) {
      const nested = element.querySelector("select");
      if (nested instanceof HTMLSelectElement) {
        return nested;
      }
    }

    throw new Error("Target is not a select control.");
  }

  /**
   * @param {Element} element
   * @returns {HTMLElement}
   */
  function getScrollableElementTarget(element) {
    if (element instanceof HTMLElement) {
      return element;
    }
    if (document.scrollingElement instanceof HTMLElement) {
      return document.scrollingElement;
    }
    return document.documentElement;
  }

  /**
   * Resolve an existing element reference and verify it is still attached.
   *
   * @param {string} elementRef
   * @returns {Element}
   */
  function getRequiredElement(elementRef) {
    const element = elementRegistry.get(elementRef);
    if (!element || !document.contains(element)) {
      throw new Error("Element reference is stale.");
    }
    return element;
  }

  /**
   * Reuse or create a stable element reference for later bridge calls.
   *
   * @param {Element} element
   * @returns {string}
   */
  function rememberElement(element) {
    for (const [key, value] of elementRegistry.entries()) {
      if (value === element) {
        return key;
      }
    }
    const elementRef = `el_${crypto.randomUUID()}`;
    elementRegistry.set(elementRef, element);
    return elementRef;
  }

  /**
   * Keep the target visible before dispatching interaction events.
   *
   * @param {Element} element
   * @returns {void}
   */
  function scrollTargetIntoView(element) {
    element.scrollIntoView({
      block: "center",
      inline: "center",
    });
  }

  /**
   * Focus an element when the platform allows it.
   *
   * @param {Element} element
   * @returns {Element}
   */
  function focusElement(element) {
    if ("focus" in element && typeof element.focus === "function") {
      element.focus({
        preventScroll: true,
      });
    }

    return document.activeElement instanceof Element
      ? document.activeElement
      : element;
  }

  /**
   * @param {Element} element
   * @returns {boolean}
   */
  function isElementFocused(element) {
    return document.activeElement === element || element.contains(document.activeElement);
  }

  /**
   * @param {Element} element
   * @returns {{ x: number, y: number }}
   */
  function getViewportPoint(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }

  /**
   * @param {unknown} value
   * @returns {'left' | 'middle' | 'right'}
   */
  function normalizeMouseButton(value) {
    return value === "middle" || value === "right" ? value : "left";
  }

  /**
   * @param {unknown} value
   * @returns {{ altKey: boolean, ctrlKey: boolean, metaKey: boolean, shiftKey: boolean }}
   */
  function normalizeModifierState(value) {
    const modifiers = Array.isArray(value)
      ? value.filter((modifier) => typeof modifier === "string")
      : [];
    return {
      altKey: modifiers.includes("Alt"),
      ctrlKey: modifiers.includes("Control") || modifiers.includes("Ctrl"),
      metaKey: modifiers.includes("Meta") || modifiers.includes("Command"),
      shiftKey: modifiers.includes("Shift"),
    };
  }

  /**
   * @param {'left' | 'middle' | 'right'} button
   * @returns {{ button: number, buttons: number }}
   */
  function getMouseButtonState(button) {
    switch (button) {
      case "middle":
        return { button: 1, buttons: 4 };
      case "right":
        return { button: 2, buttons: 2 };
      default:
        return { button: 0, buttons: 1 };
    }
  }

  /**
   * @param {Element} element
   * @param {string} type
   * @param {{ x: number, y: number }} point
   * @param {'left' | 'middle' | 'right'} button
   * @param {number} detail
   * @param {{ altKey: boolean, ctrlKey: boolean, metaKey: boolean, shiftKey: boolean }} modifiers
   * @returns {boolean}
   */
  function dispatchMouseEvent(element, type, point, button, detail, modifiers) {
    const buttonState = getMouseButtonState(button);
    return element.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: point.x,
        clientY: point.y,
        detail,
        button: buttonState.button,
        buttons: buttonState.buttons,
        ...modifiers,
      }),
    );
  }

  /**
   * @param {Element} element
   * @returns {HTMLInputElement | HTMLTextAreaElement | HTMLElement | null}
   */
  function getEditableTarget(element) {
    if (isEditableElement(element)) {
      return /** @type {HTMLInputElement | HTMLTextAreaElement | HTMLElement} */ (element);
    }

    if (!(element instanceof HTMLElement)) {
      return null;
    }

    const editable = element.querySelector("input, textarea, [contenteditable=''], [contenteditable='true']");
    return editable && isEditableElement(editable)
      ? /** @type {HTMLInputElement | HTMLTextAreaElement | HTMLElement} */ (editable)
      : null;
  }

  /**
   * @param {Element} element
   * @returns {boolean}
   */
  function isEditableElement(element) {
    if (element instanceof HTMLTextAreaElement) {
      return true;
    }

    if (element instanceof HTMLInputElement) {
      return !NON_TEXT_INPUT_TYPES.has(element.type.toLowerCase());
    }

    return element instanceof HTMLElement && element.isContentEditable;
  }

  /**
   * @param {HTMLInputElement | HTMLTextAreaElement | HTMLElement} element
   * @returns {string}
   */
  function getEditableValue(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value;
    }

    return element.innerText || element.textContent || "";
  }

  /**
   * @param {HTMLSelectElement} element
   * @returns {string[]}
   */
  function getSelectedOptionValues(element) {
    return [...element.selectedOptions].map((option) => option.value);
  }

  /**
   * @param {string[]} left
   * @param {string[]} right
   * @returns {boolean}
   */
  function areStringArraysEqual(left, right) {
    if (left.length !== right.length) {
      return false;
    }

    return left.every((value, index) => value === right[index]);
  }

  /**
   * @param {HTMLInputElement | HTMLTextAreaElement | HTMLElement} element
   * @returns {void}
   */
  function clearEditableValue(element) {
    if (!getEditableValue(element)) {
      return;
    }

    dispatchKeyboardEvent(element, "keydown", "Backspace", {});
    if (dispatchBeforeInputEvent(element, "", "deleteContentBackward")) {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        element.value = "";
      } else {
        element.textContent = "";
      }
      dispatchInputEvent(element, "", "deleteContentBackward");
    }
    dispatchKeyboardEvent(element, "keyup", "Backspace", {});
  }

  /**
   * @param {Element} element
   * @param {string} key
   * @param {unknown} modifiers
   * @returns {{ target: Element, key: string, handled: boolean }}
   */
  function runKeyAction(element, key, modifiers) {
    const normalizedKey = key === "Space" ? " " : key;
    const keyboardTarget = focusElement(element);
    const modifierState = normalizeModifierState(modifiers);
    dispatchKeyboardEvent(keyboardTarget, "keydown", normalizedKey, modifierState);

    let handled = false;
    const editable = getEditableTarget(keyboardTarget);
    if (
      editable &&
      normalizedKey.length === 1 &&
      !modifierState.altKey &&
      !modifierState.ctrlKey &&
      !modifierState.metaKey
    ) {
      handled = insertTextIntoEditable(editable, normalizedKey);
    } else if (editable && normalizedKey === "Backspace") {
      handled = deleteTextFromEditable(editable, "backward");
    } else if (editable && normalizedKey === "Delete") {
      handled = deleteTextFromEditable(editable, "forward");
    } else if (normalizedKey === "Enter") {
      handled = handleEnterKey(keyboardTarget);
    }

    dispatchKeyboardEvent(keyboardTarget, "keyup", normalizedKey, modifierState);
    return {
      target: keyboardTarget,
      key: normalizedKey,
      handled,
    };
  }

  /**
   * @param {Element} element
   * @param {string} type
   * @param {string} key
   * @param {{ altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean }} modifiers
   * @returns {boolean}
   */
  function dispatchKeyboardEvent(element, type, key, modifiers) {
    return element.dispatchEvent(
      new KeyboardEvent(type, {
        key,
        bubbles: true,
        cancelable: true,
        composed: true,
        ...modifiers,
      }),
    );
  }

  /**
   * @param {HTMLInputElement | HTMLTextAreaElement | HTMLElement} element
   * @param {string} value
   * @param {string} inputType
   * @returns {boolean}
   */
  function dispatchBeforeInputEvent(element, value, inputType) {
    return element.dispatchEvent(
      new InputEvent("beforeinput", {
        data: value,
        inputType,
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
  }

  /**
   * @param {HTMLInputElement | HTMLTextAreaElement | HTMLElement} element
   * @param {string} value
   * @param {string} inputType
   * @returns {boolean}
   */
  function dispatchInputEvent(element, value, inputType) {
    return element.dispatchEvent(
      new InputEvent("input", {
        data: value,
        inputType,
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * @param {HTMLInputElement | HTMLTextAreaElement | HTMLElement} element
   * @param {string} value
   * @returns {boolean}
   */
  function insertTextIntoEditable(element, value) {
    if (!dispatchBeforeInputEvent(element, value, "insertText")) {
      return false;
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? element.value.length;
      element.setRangeText(value, start, end, "end");
    } else {
      element.textContent = `${element.textContent || ""}${value}`;
    }

    dispatchInputEvent(element, value, "insertText");
    return true;
  }

  /**
   * @param {HTMLInputElement | HTMLTextAreaElement | HTMLElement} element
   * @param {'backward' | 'forward'} direction
   * @returns {boolean}
   */
  function deleteTextFromEditable(element, direction) {
    const inputType =
      direction === "backward" ? "deleteContentBackward" : "deleteContentForward";
    if (!dispatchBeforeInputEvent(element, "", inputType)) {
      return false;
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? element.value.length;
      if (start !== end) {
        element.setRangeText("", start, end, "end");
      } else if (direction === "backward" && start > 0) {
        element.setRangeText("", start - 1, start, "end");
      } else if (direction === "forward" && end < element.value.length) {
        element.setRangeText("", end, end + 1, "end");
      }
    } else {
      const text = element.textContent || "";
      element.textContent =
        direction === "backward"
          ? text.slice(0, Math.max(0, text.length - 1))
          : text.slice(1);
    }

    dispatchInputEvent(element, "", inputType);
    return true;
  }

  /**
   * @param {Element} element
   * @returns {boolean}
   */
  function handleEnterKey(element) {
    const editable = getEditableTarget(element);
    if (editable instanceof HTMLTextAreaElement || (editable instanceof HTMLElement && editable.isContentEditable)) {
      return insertTextIntoEditable(editable, "\n");
    }

    if (editable instanceof HTMLInputElement) {
      submitElement(editable);
      return true;
    }

    if (element instanceof HTMLButtonElement || (element instanceof HTMLInputElement && ["button", "submit"].includes(element.type))) {
      element.click();
      return true;
    }

    const form = element instanceof HTMLElement ? element.closest("form") : null;
    if (form) {
      form.requestSubmit();
      return true;
    }

    return false;
  }

  /**
   * @param {HTMLInputElement | HTMLTextAreaElement | HTMLElement} element
   * @returns {void}
   */
  function submitElement(element) {
    const form = element instanceof HTMLElement ? element.closest("form") : null;
    if (form) {
      form.requestSubmit();
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  /**
   * Convert a DOMRect into page-relative coordinates.
   *
   * @param {DOMRect | DOMRectReadOnly} rect
   * @returns {{ x: number, y: number, width: number, height: number }}
   */
  function toRect(rect) {
    return {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
    };
  }

  /**
   * Return a cheap document revision marker for change detection.
   *
   * @returns {number}
   */
  function getDocumentRevision() {
    return (document.body?.textContent || "").length;
  }

  /**
   * Build a lightweight text description for an element without walking the full
   * subtree like `innerText` does.
   *
   * @param {Element} element
   * @returns {string}
   */
  function extractElementText(element) {
    const parts = [];

    pushUnique(parts, element.getAttribute("aria-label"));
    pushUnique(parts, element.getAttribute("name"));
    pushUnique(parts, element.getAttribute("placeholder"));
    pushUnique(parts, element.getAttribute("title"));

    if (
      "value" in element &&
      typeof element.value === "string" &&
      element.value.trim()
    ) {
      pushUnique(parts, element.value);
    }

    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    pushUnique(parts, ownText);

    if (!parts.length && element.childElementCount === 0) {
      pushUnique(
        parts,
        (element.textContent || "").replace(/\s+/g, " ").trim(),
      );
    }

    return parts.join(" | ");
  }

  /**
   * Push a normalized string into a list only if it is non-empty and unique.
   *
   * @param {string[]} values
   * @param {string | null | undefined} candidate
   * @returns {void}
   */
  function pushUnique(values, candidate) {
    if (!candidate) {
      return;
    }

    const normalized = candidate.replace(/\s+/g, " ").trim();
    if (normalized && !values.includes(normalized)) {
      values.push(normalized);
    }
  }

  /**
   * Keep the content script self-contained because manifest-declared
   * content scripts are classic scripts, not ES modules.
   *
   * @param {Record<string, any>} [params={}]
   * @returns {NormalizedDomQuery}
   */
  function normalizeDomQuery(params = {}) {
    return {
      selector:
        typeof params.selector === "string" && params.selector.trim()
          ? params.selector
          : "body",
      withinRef: typeof params.withinRef === "string" ? params.withinRef : null,
      budget: applyBudget(params),
      includeRoles: params.includeRoles !== false,
    };
  }

  /**
   * @param {Record<string, any>} [options={}]
   * @returns {Budget}
   */
  function applyBudget(options = {}) {
    return {
      maxNodes: clamp(options.maxNodes ?? 25, 1, 250),
      maxDepth: clamp(options.maxDepth ?? 4, 1, 20),
      textBudget: clamp(options.textBudget ?? 600, 32, 10000),
      includeHtml: Boolean(options.includeHtml),
      includeScreenshot: Boolean(options.includeScreenshot),
      attributeAllowlist: normalizeList(options.attributeAllowlist),
      styleAllowlist: normalizeList(options.styleAllowlist),
    };
  }

  /**
   * @param {string} value
   * @param {number} budget
   * @returns {{ value: string, truncated: boolean, omitted: number }}
   */
  function truncateText(value, budget) {
    if (!value) {
      return { value: "", truncated: false, omitted: 0 };
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

  /**
   * @param {unknown} value
   * @returns {string[]}
   */
  function normalizeList(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    return [
      ...new Set(
        value.filter((item) => typeof item === "string" && item.trim()),
      ),
    ];
  }

  /**
   * @param {number | string | null | undefined} value
   * @param {number} minimum
   * @param {number} maximum
   * @returns {number}
   */
  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(Number(value) || minimum, minimum), maximum);
  }
})();
