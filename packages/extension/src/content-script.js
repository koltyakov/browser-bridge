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
      case "dom.query":
        return domQuery(params);
      case "dom.describe":
        return describeElement(params.elementRef);
      case "dom.get_text":
        return getText(params.elementRef, params.textBudget);
      case "dom.get_attributes":
        return getAttributes(params.elementRef, params.attributes ?? []);
      case "layout.get_box_model":
        return getBoxModel(params.elementRef);
      case "layout.hit_test":
        return hitTest(params.x, params.y);
      case "styles.get_computed":
        return getComputedStyles(params.elementRef, params.properties);
      case "styles.get_matched_rules":
        return getMatchedRules(params.elementRef);
      case "input.click":
        return clickTarget(params);
      case "input.focus":
        return focusTarget(params);
      case "input.type":
        return typeIntoTarget(params);
      case "input.press_key":
        return pressKeyTarget(params);
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
