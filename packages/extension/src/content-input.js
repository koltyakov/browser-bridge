// @ts-check

(() => {
  const globalState =
    /** @type {typeof globalThis & { __BBX_CONTENT_INPUT__?: Record<string, unknown> }} */ (
      globalThis
    );

  if (globalState.__BBX_CONTENT_INPUT__) {
    return;
  }

  const contentHelpers =
    /** @type {typeof globalThis & { __BBX_CONTENT_HELPERS__?: {
     NON_TEXT_INPUT_TYPES: Set<string>,
     clamp: (value: number | string | null | undefined, minimum: number, maximum: number) => number
    } }} */ (globalThis).__BBX_CONTENT_HELPERS__;
  const registry =
    /** @type {typeof globalThis & { __BBX_CONTENT_REGISTRY__?: {
     getRequiredElement: (ref: string) => Element,
     rememberElement: (element: Element) => string,
     resolveTarget: (target?: { elementRef?: string, selector?: string }) => Element
    } }} */ (globalThis).__BBX_CONTENT_REGISTRY__;
  if (!contentHelpers || !registry) {
    throw new Error('Browser Bridge helpers and registry must load before content-input.js.');
  }

  const { NON_TEXT_INPUT_TYPES, clamp } = contentHelpers;
  const { rememberElement, resolveTarget } = registry;

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
   * Keep the target visible before dispatching interaction events.
   *
   * @param {Element} element
   * @returns {void}
   */
  function scrollTargetIntoView(element) {
    element.scrollIntoView({
      block: 'center',
      inline: 'center',
    });
  }

  /**
   * Focus an element when the platform allows it.
   *
   * @param {Element} element
   * @returns {Element}
   */
  function focusElement(element) {
    if ('focus' in element && typeof element.focus === 'function') {
      element.focus({
        preventScroll: true,
      });
    }

    return document.activeElement instanceof Element ? document.activeElement : element;
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
    return value === 'middle' || value === 'right' ? value : 'left';
  }

  /**
   * @param {unknown} value
   * @returns {{ altKey: boolean, ctrlKey: boolean, metaKey: boolean, shiftKey: boolean }}
   */
  function normalizeModifierState(value) {
    const modifiers = Array.isArray(value)
      ? value.filter((modifier) => typeof modifier === 'string')
      : [];
    return {
      altKey: modifiers.includes('Alt'),
      ctrlKey: modifiers.includes('Control') || modifiers.includes('Ctrl'),
      metaKey: modifiers.includes('Meta') || modifiers.includes('Command'),
      shiftKey: modifiers.includes('Shift'),
    };
  }

  /**
   * @param {'left' | 'middle' | 'right'} button
   * @returns {{ button: number, buttons: number }}
   */
  function getMouseButtonState(button) {
    switch (button) {
      case 'middle':
        return { button: 1, buttons: 4 };
      case 'right':
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
      })
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

    const editable = element.querySelector(
      "input, textarea, [contenteditable=''], [contenteditable='true']"
    );
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

    return element.innerText || element.textContent || '';
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

    dispatchKeyboardEvent(element, 'keydown', 'Backspace', {});
    if (dispatchBeforeInputEvent(element, '', 'deleteContentBackward')) {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        element.value = '';
      } else {
        element.textContent = '';
      }
      dispatchInputEvent(element, '', 'deleteContentBackward');
    }
    dispatchKeyboardEvent(element, 'keyup', 'Backspace', {});
  }

  /**
   * @param {Element} element
   * @param {string} key
   * @param {unknown} modifiers
   * @returns {{ target: Element, key: string, handled: boolean }}
   */
  function runKeyAction(element, key, modifiers) {
    const normalizedKey = key === 'Space' ? ' ' : key;
    const keyboardTarget = focusElement(element);
    const modifierState = normalizeModifierState(modifiers);
    dispatchKeyboardEvent(keyboardTarget, 'keydown', normalizedKey, modifierState);

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
    } else if (editable && normalizedKey === 'Backspace') {
      handled = deleteTextFromEditable(editable, 'backward');
    } else if (editable && normalizedKey === 'Delete') {
      handled = deleteTextFromEditable(editable, 'forward');
    } else if (normalizedKey === 'Enter') {
      handled = handleEnterKey(keyboardTarget);
    }

    dispatchKeyboardEvent(keyboardTarget, 'keyup', normalizedKey, modifierState);
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
      })
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
      new InputEvent('beforeinput', {
        data: value,
        inputType,
        bubbles: true,
        cancelable: true,
        composed: true,
      })
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
      new InputEvent('input', {
        data: value,
        inputType,
        bubbles: true,
        composed: true,
      })
    );
  }

  /**
   * @param {HTMLInputElement | HTMLTextAreaElement | HTMLElement} element
   * @param {string} value
   * @returns {boolean}
   */
  function insertTextIntoEditable(element, value) {
    if (!dispatchBeforeInputEvent(element, value, 'insertText')) {
      return false;
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? element.value.length;
      element.setRangeText(value, start, end, 'end');
    } else {
      element.textContent = `${element.textContent || ''}${value}`;
    }

    dispatchInputEvent(element, value, 'insertText');
    return true;
  }

  /**
   * @param {HTMLInputElement | HTMLTextAreaElement | HTMLElement} element
   * @param {'backward' | 'forward'} direction
   * @returns {boolean}
   */
  function deleteTextFromEditable(element, direction) {
    const inputType = direction === 'backward' ? 'deleteContentBackward' : 'deleteContentForward';
    if (!dispatchBeforeInputEvent(element, '', inputType)) {
      return false;
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? element.value.length;
      if (start !== end) {
        element.setRangeText('', start, end, 'end');
      } else if (direction === 'backward' && start > 0) {
        element.setRangeText('', start - 1, start, 'end');
      } else if (direction === 'forward' && end < element.value.length) {
        element.setRangeText('', end, end + 1, 'end');
      }
    } else {
      const text = element.textContent || '';
      element.textContent =
        direction === 'backward' ? text.slice(0, Math.max(0, text.length - 1)) : text.slice(1);
    }

    dispatchInputEvent(element, '', inputType);
    return true;
  }

  /**
   * @param {Element} element
   * @returns {boolean}
   */
  function handleEnterKey(element) {
    const editable = getEditableTarget(element);
    if (
      editable instanceof HTMLTextAreaElement ||
      (editable instanceof HTMLElement && editable.isContentEditable)
    ) {
      return insertTextIntoEditable(editable, '\n');
    }

    if (editable instanceof HTMLInputElement) {
      submitElement(editable);
      return true;
    }

    if (
      element instanceof HTMLButtonElement ||
      (element instanceof HTMLInputElement && ['button', 'submit'].includes(element.type))
    ) {
      element.click();
      return true;
    }

    const form = element instanceof HTMLElement ? element.closest('form') : null;
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
    const form = element instanceof HTMLElement ? element.closest('form') : null;
    if (form) {
      form.requestSubmit();
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  /**
   * @param {{ elementRef?: string, selector?: string }} [target={}]
   * @returns {HTMLInputElement}
   */
  function resolveCheckableTarget(target = {}) {
    const element = resolveTarget(target);
    if (
      element instanceof HTMLInputElement &&
      ['checkbox', 'radio'].includes(element.type.toLowerCase())
    ) {
      return element;
    }

    if (element instanceof HTMLElement) {
      const nested = element.querySelector('input[type="checkbox"], input[type="radio"]');
      if (nested instanceof HTMLInputElement) {
        return nested;
      }
    }

    throw new Error('Target is not a checkbox or radio input.');
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

    if (
      element instanceof HTMLOptionElement &&
      element.parentElement instanceof HTMLSelectElement
    ) {
      return element.parentElement;
    }

    if (element instanceof HTMLElement) {
      const nested = element.querySelector('select');
      if (nested instanceof HTMLSelectElement) {
        return nested;
      }
    }

    throw new Error('Target is not a select control.');
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

    scrollTargetIntoView(element);
    const point = getViewportPoint(element);
    focusElement(element);
    dispatchMouseEvent(element, 'mousemove', point, button, 0, modifiers);
    dispatchMouseEvent(element, 'mousedown', point, button, clickCount, modifiers);
    dispatchMouseEvent(element, 'mouseup', point, button, clickCount, modifiers);

    if (button === 'left') {
      if (element instanceof HTMLElement) {
        element.click();
        if (clickCount === 2) {
          element.click();
          dispatchMouseEvent(element, 'dblclick', point, button, clickCount, modifiers);
        }
      } else {
        dispatchMouseEvent(element, 'click', point, button, clickCount, modifiers);
        if (clickCount === 2) {
          dispatchMouseEvent(element, 'dblclick', point, button, clickCount, modifiers);
        }
      }
    } else if (button === 'right') {
      dispatchMouseEvent(element, 'contextmenu', point, button, clickCount, modifiers);
    } else {
      dispatchMouseEvent(element, 'auxclick', point, button, clickCount, modifiers);
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
      throw new Error('Target is not an editable control.');
    }

    scrollTargetIntoView(editable);
    focusElement(editable);

    if (params.clear) {
      clearEditableValue(editable);
    }

    const text = String(params.text ?? '');
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
   * Set the value of an input/textarea/select element using the native value
   * setter, then dispatch input + change events. This works with React, Vue,
   * Angular, and vanilla forms — frameworks intercept these events at the
   * document level and sync their internal state.
   *
   * mode:
   *   "setter" (default) — use Object.getOwnPropertyDescriptor prototype setter
   *   "keystrokes" — clear field + type each character (slower but handles
   *     custom components that don't respond to setter)
   *   "auto" — try setter first, verify value stuck, fallback to keystrokes
   *
   * @param {Record<string, any>} params
   * @returns {{ elementRef: string, value: string, mode: string }}
   */
  function fillTarget(params) {
    const element = resolveTarget(params.target);
    const editable = getEditableTarget(element);
    if (!editable) {
      throw new Error('Target is not an editable control.');
    }

    scrollTargetIntoView(editable);
    focusElement(editable);

    const value = String(params.value ?? '');
    const requestedMode = params.mode || 'auto';
    let usedMode = 'setter';

    if (requestedMode === 'keystrokes') {
      usedMode = 'keystrokes';
      clearEditableValue(editable);
      for (const ch of value) {
        runKeyAction(editable, ch, undefined);
      }
    } else {
      // setter mode: use the native prototype setter to bypass React's synthetic wrapper
      const tag = editable.tagName;
      const proto =
        tag === 'TEXTAREA'
          ? HTMLTextAreaElement.prototype
          : tag === 'SELECT'
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(editable, value);
      } else {
        /** @type {HTMLInputElement} */ (editable).value = value;
      }
      editable.dispatchEvent(new Event('input', { bubbles: true }));
      editable.dispatchEvent(new Event('change', { bubbles: true }));

      // auto mode: verify value stuck, fallback to keystrokes if not
      if (requestedMode === 'auto' && getEditableValue(editable) !== value) {
        usedMode = 'keystrokes-fallback';
        clearEditableValue(editable);
        for (const ch of value) {
          runKeyAction(editable, ch, undefined);
        }
      }
    }

    // Dispatch blur to trigger field-level validation
    editable.dispatchEvent(new Event('blur', { bubbles: true }));

    return {
      elementRef: rememberElement(editable),
      value: getEditableValue(editable),
      mode: usedMode,
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
      params.target?.elementRef || params.target?.selector
        ? resolveTarget(params.target)
        : document.activeElement instanceof Element
          ? document.activeElement
          : document.body;
    scrollTargetIntoView(target);
    focusElement(target);
    const key = String(params.key ?? '');
    if (!key) {
      throw new Error('A key is required.');
    }

    const result = runKeyAction(target, key, params.modifiers);
    return {
      elementRef: result.target instanceof Element ? rememberElement(result.target) : null,
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
    if (element.type === 'radio' && !checked && element.checked) {
      throw new Error('Radio inputs cannot be unchecked directly.');
    }

    scrollTargetIntoView(element);
    focusElement(element);
    const changed = element.checked !== checked;
    if (changed) {
      element.click();
      if (element.checked !== checked) {
        element.checked = checked;
        element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
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
      ? params.values.filter((value) => typeof value === 'string')
      : [];
    const labels = Array.isArray(params.labels)
      ? params.labels.filter((label) => typeof label === 'string')
      : [];
    const indexes = Array.isArray(params.indexes)
      ? params.indexes
          .map((index) => Number(index))
          .filter((index) => Number.isInteger(index) && index >= 0)
      : [];

    if (!values.length && !labels.length && !indexes.length) {
      throw new Error('At least one option selector is required.');
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
      throw new Error('No matching option found.');
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
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }

    return {
      elementRef: rememberElement(element),
      changed,
      multiple: element.multiple,
      selectedValues: selectedAfter,
    };
  }

  /**
   * Trigger hover state on an element by dispatching mouse events.
   *
   * @param {Record<string, any>} params
   * @returns {Promise<{ elementRef: string, hovered: boolean }> | { elementRef: string, hovered: boolean }}
   */
  function hoverTarget(params) {
    const element = resolveTarget(params.target);
    const modifiers = normalizeModifierState(params.modifiers);
    const duration = clamp(params.duration ?? 0, 0, 5000);

    scrollTargetIntoView(element);
    const point = getViewportPoint(element);
    dispatchMouseEvent(element, 'mouseenter', point, 'left', 0, modifiers);
    dispatchMouseEvent(element, 'mouseover', point, 'left', 0, modifiers);
    dispatchMouseEvent(element, 'mousemove', point, 'left', 0, modifiers);

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
    const offsetX = Number(params.offsetX) || 0;
    const offsetY = Number(params.offsetY) || 0;
    const emptyMods = {
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    };

    scrollTargetIntoView(source);
    const sourcePoint = getViewportPoint(source);

    const dataTransfer = new DataTransfer();

    source.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: sourcePoint.x,
        clientY: sourcePoint.y,
        ...emptyMods,
      })
    );
    source.dispatchEvent(
      new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: sourcePoint.x,
        clientY: sourcePoint.y,
        dataTransfer,
      })
    );
    source.dispatchEvent(
      new DragEvent('drag', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: sourcePoint.x,
        clientY: sourcePoint.y,
        dataTransfer,
      })
    );

    scrollTargetIntoView(destination);
    const destPoint = getViewportPoint(destination);
    const endPoint = { x: destPoint.x + offsetX, y: destPoint.y + offsetY };

    destination.dispatchEvent(
      new DragEvent('dragenter', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: endPoint.x,
        clientY: endPoint.y,
        dataTransfer,
      })
    );
    destination.dispatchEvent(
      new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: endPoint.x,
        clientY: endPoint.y,
        dataTransfer,
      })
    );
    destination.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: endPoint.x,
        clientY: endPoint.y,
        dataTransfer,
      })
    );
    source.dispatchEvent(
      new DragEvent('dragend', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: endPoint.x,
        clientY: endPoint.y,
        dataTransfer,
      })
    );
    source.dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: endPoint.x,
        clientY: endPoint.y,
        ...emptyMods,
      })
    );

    return {
      sourceRef: rememberElement(source),
      destinationRef: rememberElement(destination),
      dragged: true,
    };
  }

  /**
   * Scroll an element into the visible viewport.
   *
   * @param {Record<string, any>} params
   * @returns {{ elementRef: string, scrolled: boolean }}
   */
  function scrollIntoViewTarget(params) {
    const element = resolveTarget(params.target);
    scrollTargetIntoView(element);
    return { elementRef: rememberElement(element), scrolled: true };
  }

  /**
   * Scroll the window or a specific scrollable element.
   *
   * @param {Record<string, any>} params
   * @returns {{
   *   scrolled: boolean,
   *   target: string,
   *   x: number,
   *   y: number,
   *   top: number,
   *   left: number,
   *   behavior: 'auto' | 'smooth',
   *   relative: boolean
   * }}
   */
  function scrollViewport(params) {
    const top = Number(params.top) || 0;
    const left = Number(params.left) || 0;
    const behavior = params.behavior === 'smooth' ? 'smooth' : 'auto';
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
        scrolled: true,
        target: rememberElement(scrollTarget),
        x: scrollTarget.scrollLeft,
        y: scrollTarget.scrollTop,
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
      scrolled: true,
      target: 'window',
      x: window.scrollX,
      y: window.scrollY,
      top: window.scrollY,
      left: window.scrollX,
      behavior,
      relative,
    };
  }

  globalState.__BBX_CONTENT_INPUT__ = Object.freeze({
    clickTarget,
    dragTarget,
    fillTarget,
    focusTarget,
    hoverTarget,
    pressKeyTarget,
    scrollIntoViewTarget,
    scrollViewport,
    selectOptionTarget,
    setCheckedTarget,
    typeIntoTarget,
  });
})();
