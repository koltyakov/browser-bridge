// @ts-check

(() => {
  const globalState =
    /** @type {typeof globalThis & { __BBX_CONTENT_INPUT__?: Record<string, unknown> }} */ (
      globalThis
    );

  if (globalState.__BBX_CONTENT_INPUT__) {
    return;
  }

  const contentHelpers = /** @type {typeof globalThis & { __BBX_CONTENT_HELPERS__?: {
     NON_TEXT_INPUT_TYPES: Set<string>,
     clamp: (value: number | string | null | undefined, minimum: number, maximum: number) => number,
     escapeTailwindSelector: (selector: string) => string,
     getAccessibleName: (element: Element) => string,
     getElementRoles: (element: Element) => string[],
     getElementTextContent: (element: Element, budget?: number) => string,
     getShadowRoot: (element: Element) => ShadowRoot | null,
     isElementVisible: (element: Element) => boolean,
     isNodeAttached: (node: Node | null | undefined) => boolean,
     querySelectorAllDeep: (selector: string, root?: ParentNode) => Element[]
    } }} */ (globalThis).__BBX_CONTENT_HELPERS__;
  const registry = /** @type {typeof globalThis & { __BBX_CONTENT_REGISTRY__?: {
     getRequiredElement: (ref: string) => Element,
     rememberElement: (element: Element) => string,
     resolveTarget: (target?: { elementRef?: string, selector?: string }) => Element,
     resolveInputReference: (ref: string, recoverStale: boolean) => {
       element: Element,
       recovery: null | { oldRef: string, newRef: string, matchedFields: string[], confidenceBasis: string }
     }
    } }} */ (globalThis).__BBX_CONTENT_REGISTRY__;
  if (!contentHelpers || !registry) {
    throw new Error('Browser Bridge helpers and registry must load before content-input.js.');
  }

  const {
    NON_TEXT_INPUT_TYPES,
    clamp,
    escapeTailwindSelector,
    getAccessibleName,
    getElementRoles,
    getElementTextContent,
    getShadowRoot,
    isElementVisible,
    isNodeAttached,
    querySelectorAllDeep,
  } = contentHelpers;
  const { rememberElement, resolveTarget, resolveInputReference } = registry;
  const MAX_INPUT_CANDIDATES = 25;

  /**
   * @typedef {{
   *   elementRef?: string,
   *   selector?: string,
   *   role?: string,
   *   name?: string,
   *   text?: string,
   *   label?: string,
   *   placeholder?: string,
   *   testId?: string,
   *   exact?: boolean,
   *   nth?: number
   * }} InputTargetSpec
   */

  /**
   * The locator engine lives in content-dom-query.js, which loads first.
   *
   * @returns {{
   *   isLocator: (value: unknown) => boolean,
   *   locateElements: (locator: Record<string, unknown>, options?: { maxResults?: number, scanLimit?: number }) => { matches: Element[], hiddenMatches: number, scanned: number, truncationReason: string | null }
   * } | null}
   */
  function getDomQueryModule() {
    return (
      /** @type {typeof globalThis & { __BBX_CONTENT_DOM_QUERY__?: ReturnType<typeof getDomQueryModule> }} */ (
        globalThis
      ).__BBX_CONTENT_DOM_QUERY__ ?? null
    );
  }

  /**
   * Hit-test through open/closed shadow roots, since document-level
   * elementFromPoint retargets to the outermost shadow host.
   *
   * @param {number} x
   * @param {number} y
   * @returns {Element | null}
   */
  function deepElementFromPoint(x, y) {
    if (typeof document.elementFromPoint !== 'function') return null;
    let hit = document.elementFromPoint(x, y);
    for (let depth = 0; hit && depth < 32; depth += 1) {
      const shadowRoot = getShadowRoot(hit);
      if (!shadowRoot || typeof shadowRoot.elementFromPoint !== 'function') break;
      const inner = shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  /**
   * `contains` across shadow boundaries (host -> shadow tree).
   *
   * @param {Element} ancestor
   * @param {Node | null} node
   * @returns {boolean}
   */
  function composedContains(ancestor, node) {
    /** @type {Node | null} */
    let current = node;
    while (current) {
      if (current === ancestor) return true;
      const parent = /** @type {Node & { host?: Element }} */ (current).parentNode ?? null;
      current =
        parent && parent.nodeType === 11 && /** @type {ShadowRoot} */ (parent).host
          ? /** @type {ShadowRoot} */ (parent).host
          : parent;
    }
    return false;
  }

  /**
   * @typedef {{
   *   strategy: 'elementRef' | 'selector-first' | 'selector-ranked' | 'locator-first' | 'locator-ranked' | 'stale-recovery',
   *   candidateCount: number,
   *   evaluatedCount: number,
   *   scrolled: boolean,
   *   hitTest: 'target' | 'descendant' | 'none' | 'not-required',
   *   recovered: boolean,
   *   oldRef?: string,
   *   newRef?: string,
   *   matchedFields?: string[],
   *   confidenceBasis?: string,
   *   waitedMs?: number
   * }} InputResolutionMetadata
   */

  /**
   * @typedef {{
   *   element: Element,
   *   point: { x: number, y: number },
   *   resolution: InputResolutionMetadata
   * }} ResolvedInputTarget
   */

  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} details
   * @returns {Error & { code: string, details: Record<string, unknown> }}
   */
  function createInputError(code, message, details) {
    return Object.assign(new Error(message), { code, details });
  }

  /** @param {Element} element @returns {CSSStyleDeclaration | { display: string, visibility: string, opacity: string, pointerEvents: string }} */
  function readComputedStyle(element) {
    if (typeof globalThis.getComputedStyle === 'function') {
      return globalThis.getComputedStyle(element);
    }
    return {
      display: '',
      visibility: '',
      opacity: '1',
      pointerEvents: '',
    };
  }

  /**
   * @param {Element} element
   * @returns {{ actionable: boolean, reasons: string[], inViewport: boolean, hitRequired: boolean, point: { x: number, y: number }, hit: Element | null }}
   */
  function inspectActionability(element) {
    const rect = element.getBoundingClientRect();
    const style = readComputedStyle(element);
    const reasons = [];
    const disabled =
      ('disabled' in element &&
        Boolean(/** @type {{ disabled?: boolean }} */ (element).disabled)) ||
      element.getAttribute('aria-disabled') === 'true';
    const inert =
      ('inert' in element && Boolean(/** @type {{ inert?: boolean }} */ (element).inert)) ||
      element.hasAttribute('inert') ||
      Boolean(element.closest?.('[inert]'));
    if (!isNodeAttached(element)) reasons.push('detached');
    if (rect.width < 1 || rect.height < 1) reasons.push('zero-size');
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    ) {
      reasons.push('hidden');
    }
    if (Number(style.opacity) === 0) reasons.push('transparent');
    if (style.pointerEvents === 'none') reasons.push('pointer-events-none');
    if (disabled) reasons.push('disabled');
    if (inert) reasons.push('inert');
    const viewportWidth = Number(globalThis.window?.innerWidth || globalThis.innerWidth || 0);
    const viewportHeight = Number(globalThis.window?.innerHeight || globalThis.innerHeight || 0);
    const hitRequired = viewportWidth > 0 && viewportHeight > 0;
    const inViewport = !hitRequired
      ? true
      : rect.left + rect.width > 0 &&
        rect.top + rect.height > 0 &&
        rect.left < viewportWidth &&
        rect.top < viewportHeight;
    const visibleLeft = hitRequired ? Math.max(0, rect.left) : rect.left;
    const visibleTop = hitRequired ? Math.max(0, rect.top) : rect.top;
    const visibleRight = hitRequired
      ? Math.min(viewportWidth, rect.left + rect.width)
      : rect.left + rect.width;
    const visibleBottom = hitRequired
      ? Math.min(viewportHeight, rect.top + rect.height)
      : rect.top + rect.height;
    const point =
      inViewport && visibleRight > visibleLeft && visibleBottom > visibleTop
        ? {
            x: visibleLeft + (visibleRight - visibleLeft) / 2,
            y: visibleTop + (visibleBottom - visibleTop) / 2,
          }
        : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const hit = inViewport ? deepElementFromPoint(point.x, point.y) : null;
    return { actionable: reasons.length === 0, reasons, inViewport, hitRequired, point, hit };
  }

  /** @param {Element} element @param {Element | null} hit @returns {'target' | 'descendant' | 'none'} */
  function classifyHit(element, hit) {
    if (!hit) return 'none';
    if (hit === element) return 'target';
    if (typeof element.contains === 'function' && element.contains(hit)) return 'descendant';
    return composedContains(element, hit) ? 'descendant' : 'none';
  }

  /** @param {Element} element @returns {Record<string, string>} */
  function describeBlocker(element) {
    /** @type {Record<string, string>} */
    const description = { tag: element.tagName.toLowerCase() };
    const id = element.getAttribute('id');
    const role = element.getAttribute('role');
    const name = element.getAttribute('aria-label');
    const className = element.getAttribute('class');
    if (id) description.id = id.slice(0, 80);
    if (role) description.role = role.slice(0, 80);
    if (name) description.name = name.slice(0, 120);
    if (className) description.class = className.trim().split(/\s+/).slice(0, 3).join(' ');
    return description;
  }

  /**
   * Resolve one input target atomically, ranking at most 25 selector matches.
   * Explicit refs retain exact identity unless stale recovery is opted in.
   *
   * @param {InputTargetSpec | undefined} target
   * @param {{ pointer: boolean, recoverStale: boolean }} options
   * @returns {ResolvedInputTarget}
   */
  function resolveActionableTarget(target, options) {
    const domQuery = getDomQueryModule();
    const usesLocator = !target?.elementRef && Boolean(domQuery?.isLocator(target));
    /** @type {Element} */
    let element;
    /** @type {InputResolutionMetadata} */
    let resolution;
    if (target?.elementRef) {
      const resolved = resolveInputReference(target.elementRef, options.recoverStale);
      element = resolved.element;
      resolution = {
        strategy: resolved.recovery ? 'stale-recovery' : 'elementRef',
        candidateCount: 1,
        evaluatedCount: 1,
        scrolled: false,
        hitTest: options.pointer ? 'none' : 'not-required',
        recovered: Boolean(resolved.recovery),
        ...(resolved.recovery || {}),
      };
    } else if (target?.selector || usesLocator) {
      const kind = usesLocator ? 'locator' : 'selector';
      const describedTarget = usesLocator ? describeLocator(target) : null;
      /** @type {Element[]} */
      let allMatches;
      let hiddenMatches = 0;
      try {
        if (usesLocator && domQuery) {
          const located = domQuery.locateElements(
            /** @type {Record<string, unknown>} */ ({ ...target }),
            { maxResults: MAX_INPUT_CANDIDATES + 1 }
          );
          hiddenMatches = located.hiddenMatches;
          allMatches =
            typeof target?.nth === 'number'
              ? located.matches.slice(target.nth, target.nth + 1)
              : located.matches;
        } else {
          allMatches = querySelectorAllDeep(escapeTailwindSelector(String(target?.selector)));
        }
      } catch (error) {
        throw createInputError('INVALID_REQUEST', 'Input selector is invalid.', {
          selector: String(target?.selector ?? '').slice(0, 500),
          reason:
            error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
        });
      }
      const candidates = [...allMatches].slice(0, MAX_INPUT_CANDIDATES);
      if (!candidates.length) {
        throw createInputError('ELEMENT_NOT_FOUND', 'Input target was not found.', {
          ...(describedTarget ? { locator: describedTarget } : { selector: target?.selector }),
          candidateCount: 0,
          evaluatedCount: 0,
          ...(hiddenMatches ? { hiddenMatches } : {}),
        });
      }
      const inspected = candidates.map((candidate, index) => {
        const state = inspectActionability(candidate);
        const hit = classifyHit(candidate, state.hit);
        const usable =
          state.actionable && !(options.pointer && state.hitRequired && hit === 'none');
        return {
          element: candidate,
          index,
          state,
          hit,
          score: usable ? 10 + (state.inViewport ? 2 : 0) + (hit !== 'none' ? 1 : 0) : -1,
        };
      });
      if (inspected[0].score >= 0) {
        element = inspected[0].element;
        resolution = {
          strategy: kind === 'locator' ? 'locator-first' : 'selector-first',
          candidateCount: Math.min(allMatches.length, MAX_INPUT_CANDIDATES),
          evaluatedCount: candidates.length,
          scrolled: false,
          hitTest: options.pointer ? inspected[0].hit : 'not-required',
          recovered: false,
        };
      } else {
        if (allMatches.length > MAX_INPUT_CANDIDATES) {
          throw createInputError(
            'ELEMENT_AMBIGUOUS',
            'Selector has too many candidates for bounded input resolution.',
            {
              ...(describedTarget ? { locator: describedTarget } : { selector: target?.selector }),
              candidateCount: allMatches.length,
              evaluatedCount: MAX_INPUT_CANDIDATES,
              limit: MAX_INPUT_CANDIDATES,
            }
          );
        }
        const ranked = inspected
          .filter((candidate) => candidate.score >= 0)
          .sort((a, b) => b.score - a.score);
        if (!ranked.length) {
          if (
            options.pointer &&
            inspected[0].state.actionable &&
            (inspected[0].state.hitRequired || inspected[0].state.hit)
          ) {
            element = inspected[0].element;
            resolution = {
              strategy: kind === 'locator' ? 'locator-first' : 'selector-first',
              candidateCount: candidates.length,
              evaluatedCount: candidates.length,
              scrolled: false,
              hitTest: inspected[0].hit,
              recovered: false,
            };
          } else {
            throw createInputError('ELEMENT_NOT_ACTIONABLE', 'No selector match is actionable.', {
              ...(describedTarget ? { locator: describedTarget } : { selector: target?.selector }),
              candidateCount: candidates.length,
              evaluatedCount: candidates.length,
              reasons: [
                ...new Set(inspected.flatMap((candidate) => candidate.state.reasons)),
              ].slice(0, 8),
            });
          }
        } else {
          if (ranked.length > 1 && ranked[0].score === ranked[1].score) {
            throw createInputError(
              'ELEMENT_AMBIGUOUS',
              'Selector matches equally actionable elements.',
              {
                ...(describedTarget
                  ? { locator: describedTarget }
                  : { selector: target?.selector }),
                candidateCount: candidates.length,
                evaluatedCount: candidates.length,
                topScore: ranked[0].score,
              }
            );
          }
          element = ranked[0].element;
          resolution = {
            strategy: kind === 'locator' ? 'locator-ranked' : 'selector-ranked',
            candidateCount: candidates.length,
            evaluatedCount: candidates.length,
            scrolled: false,
            hitTest: options.pointer ? ranked[0].hit : 'not-required',
            recovered: false,
          };
        }
      }
    } else {
      throw createInputError('ELEMENT_NOT_ACTIONABLE', 'Input target is required.', {
        candidateCount: 0,
        evaluatedCount: 0,
      });
    }

    let state = inspectActionability(element);
    if (!state.inViewport) {
      scrollTargetIntoView(element);
      resolution.scrolled = true;
      state = inspectActionability(element);
    }
    if (!state.actionable) {
      throw createInputError('ELEMENT_NOT_ACTIONABLE', 'Input target is not actionable.', {
        elementRef: rememberElement(element),
        reasons: state.reasons.slice(0, 8),
        resolution,
      });
    }
    if (options.pointer) {
      const hit = classifyHit(element, state.hit);
      resolution.hitTest = hit;
      if (hit === 'none' && state.hitRequired) {
        throw createInputError(
          'ELEMENT_OBSCURED',
          'Input target is obscured at its center point.',
          {
            elementRef: rememberElement(element),
            point: state.point,
            blocker: state.hit ? describeBlocker(state.hit) : null,
            resolution,
          }
        );
      }
    }
    return { element, point: state.point, resolution };
  }

  /** @param {'dom' | 'cdp'} mode @param {{ x: number, y: number }} point */
  function getExecutionMetadata(mode, point) {
    return {
      requestedMode: mode,
      actualMode: mode,
      fallbackReason: null,
      debuggerUsed: mode === 'cdp',
      targetCoordinates: point,
    };
  }

  /**
   * Recheck a nested control selected from an actionable wrapper.
   *
   * @param {ResolvedInputTarget} resolved
   * @param {Element} element
   * @returns {ResolvedInputTarget}
   */
  function finalizeDerivedTarget(resolved, element) {
    if (element === resolved.element) return resolved;
    let state = inspectActionability(element);
    if (!state.inViewport) {
      scrollTargetIntoView(element);
      resolved.resolution.scrolled = true;
      state = inspectActionability(element);
    }
    if (!state.actionable) {
      throw createInputError('ELEMENT_NOT_ACTIONABLE', 'Nested input control is not actionable.', {
        elementRef: rememberElement(element),
        reasons: state.reasons.slice(0, 8),
        resolution: resolved.resolution,
      });
    }
    return { element, point: state.point, resolution: resolved.resolution };
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

  const FOCUSABLE_SELECTOR =
    'a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"]';

  /**
   * Apply the focus change of a real mouse press: focus the nearest focusable
   * ancestor, or blur the current field when the press lands on content that
   * cannot take focus.
   *
   * @param {Element} element
   * @returns {void}
   */
  function focusForPointerPress(element) {
    const focusable =
      typeof element.closest === 'function' ? element.closest(FOCUSABLE_SELECTOR) : null;
    const target = focusable ?? element;
    focusElement(target);
    const active = document.activeElement;
    if (
      !focusable &&
      active instanceof HTMLElement &&
      active !== document.body &&
      active !== target &&
      !containsNode(target, active) &&
      typeof active.blur === 'function'
    ) {
      active.blur();
    }
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
   * @typedef {{ altKey: boolean, ctrlKey: boolean, metaKey: boolean, shiftKey: boolean }} ModifierState
   */

  /**
   * @typedef {{
   *   modifiers: ModifierState,
   *   button?: number,
   *   buttons?: number,
   *   detail?: number,
   *   bubbles?: boolean,
   *   cancelable?: boolean,
   *   relatedTarget?: Element | null
   * }} MouseDispatchOptions
   */

  /**
   * @typedef {MouseDispatchOptions & {
   *   pointerId: number,
   *   pointerType: 'mouse' | 'touch',
   *   isPrimary: boolean,
   *   pressure?: number
   * }} PointerDispatchOptions
   */

  /** @type {Readonly<{ pointerId: number, pointerType: 'mouse', isPrimary: true }>} */
  const MOUSE_POINTER = Object.freeze({ pointerId: 1, pointerType: 'mouse', isPrimary: true });
  const FIRST_TOUCH_POINTER_ID = 2;
  const NO_MODIFIERS = Object.freeze({
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  });

  /**
   * Element under the virtual mouse after the last DOM pointer interaction.
   * Boundary events (over/enter/out/leave) are derived from it so repeated
   * interactions see the same transitions a real pointer would produce.
   *
   * @type {Element | null}
   */
  let pointerElement = null;

  /** @param {number} ms @returns {Promise<void>} */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** @param {unknown} value @returns {number} */
  function normalizeHoldMs(value) {
    return clamp(Number(value) || 0, 0, 10_000);
  }

  /** @param {Element} element @returns {boolean} */
  function isConnectedElement(element) {
    return isNodeAttached(element);
  }

  /** @param {Element | null} node @param {Element | null} other @returns {boolean} */
  function containsNode(node, other) {
    return Boolean(node && other && typeof node.contains === 'function' && node.contains(other));
  }

  /**
   * @param {{ x: number, y: number }} point
   * @param {MouseDispatchOptions} options
   * @returns {MouseEventInit}
   */
  function createMouseInit(point, options) {
    return {
      bubbles: options.bubbles ?? true,
      cancelable: options.cancelable ?? true,
      composed: true,
      clientX: point.x,
      clientY: point.y,
      detail: options.detail ?? 0,
      button: options.button ?? 0,
      buttons: options.buttons ?? 0,
      relatedTarget: options.relatedTarget ?? null,
      ...options.modifiers,
    };
  }

  /**
   * @param {Element} element
   * @param {string} type
   * @param {{ x: number, y: number }} point
   * @param {MouseDispatchOptions} options
   * @returns {boolean}
   */
  function dispatchMouseEvent(element, type, point, options) {
    return element.dispatchEvent(new MouseEvent(type, createMouseInit(point, options)));
  }

  /**
   * Dispatch a PointerEvent where the platform has one. Real input always
   * produces pointer events before their compatibility mouse/touch events, and
   * many applications listen only to pointer events.
   *
   * @param {Element} element
   * @param {string} type
   * @param {{ x: number, y: number }} point
   * @param {PointerDispatchOptions} options
   * @returns {boolean}
   */
  function dispatchPointerEvent(element, type, point, options) {
    if (typeof PointerEvent !== 'function') return true;
    return element.dispatchEvent(
      new PointerEvent(type, {
        ...createMouseInit(point, options),
        pointerId: options.pointerId,
        pointerType: options.pointerType,
        isPrimary: options.isPrimary,
        pressure: options.pressure ?? 0,
        width: 1,
        height: 1,
      })
    );
  }

  /**
   * Dispatch a click-family event the way Chrome does: as a PointerEvent
   * carrying the pointer type when available, otherwise as a MouseEvent.
   * Dispatching `click` runs the element's activation behavior (checkbox
   * toggles, link navigation, form submission) just like HTMLElement.click(),
   * while preserving coordinates, modifiers, and click count.
   *
   * @param {Element} element
   * @param {'click' | 'auxclick' | 'contextmenu'} type
   * @param {{ x: number, y: number }} point
   * @param {PointerDispatchOptions} options
   * @returns {boolean}
   */
  function dispatchClickEvent(element, type, point, options) {
    if (typeof PointerEvent === 'function') {
      return dispatchPointerEvent(element, type, point, options);
    }
    return dispatchMouseEvent(element, type, point, options);
  }

  /**
   * Elements from `start` upward, stopping before the first ancestor that
   * contains `other`. These receive the non-bubbling enter/leave events.
   *
   * @param {Element} start
   * @param {Element | null} other
   * @returns {Element[]}
   */
  function collectBoundaryChain(start, other) {
    /** @type {Element[]} */
    const chain = [];
    for (
      let node = /** @type {Element | null} */ (start);
      node && !containsNode(node, other);
      node = node.parentElement ?? null
    ) {
      chain.push(node);
    }
    return chain;
  }

  /**
   * Move the virtual mouse onto an element: out/leave on the previous element,
   * over/enter on the new one, then pointermove/mousemove.
   *
   * @param {Element} element
   * @param {{ x: number, y: number }} point
   * @param {ModifierState} modifiers
   * @param {{ buttons?: number, pointerEvents?: boolean }} [options]
   * @returns {void}
   */
  function movePointerTo(element, point, modifiers, options = {}) {
    const buttons = options.buttons ?? 0;
    const pointerEvents = options.pointerEvents !== false;
    const mouseOptions = { modifiers, buttons };
    const pointerOptions = { ...MOUSE_POINTER, modifiers, buttons, button: -1 };
    if (pointerElement !== element) {
      const previous = pointerElement && isConnectedElement(pointerElement) ? pointerElement : null;
      const leaving = previous ? collectBoundaryChain(previous, element) : [];
      const entering = collectBoundaryChain(element, previous).reverse();
      const quiet = { bubbles: false, cancelable: false };
      if (pointerEvents) {
        if (previous) {
          dispatchPointerEvent(previous, 'pointerout', point, {
            ...pointerOptions,
            relatedTarget: element,
          });
          for (const node of leaving) {
            dispatchPointerEvent(node, 'pointerleave', point, {
              ...pointerOptions,
              ...quiet,
              relatedTarget: element,
            });
          }
        }
        dispatchPointerEvent(element, 'pointerover', point, {
          ...pointerOptions,
          relatedTarget: previous,
        });
        for (const node of entering) {
          dispatchPointerEvent(node, 'pointerenter', point, {
            ...pointerOptions,
            ...quiet,
            relatedTarget: previous,
          });
        }
      }
      if (previous) {
        dispatchMouseEvent(previous, 'mouseout', point, {
          ...mouseOptions,
          relatedTarget: element,
        });
        for (const node of leaving) {
          dispatchMouseEvent(node, 'mouseleave', point, {
            ...mouseOptions,
            ...quiet,
            relatedTarget: element,
          });
        }
      }
      dispatchMouseEvent(element, 'mouseover', point, { ...mouseOptions, relatedTarget: previous });
      for (const node of entering) {
        dispatchMouseEvent(node, 'mouseenter', point, {
          ...mouseOptions,
          ...quiet,
          relatedTarget: previous,
        });
      }
      pointerElement = element;
    }
    if (pointerEvents) dispatchPointerEvent(element, 'pointermove', point, pointerOptions);
    dispatchMouseEvent(element, 'mousemove', point, mouseOptions);
  }

  /**
   * Press a mouse button: pointerdown, then mousedown unless the page canceled
   * pointerdown (which suppresses compatibility mouse events per the Pointer
   * Events spec). Focus is the default action of an uncanceled mousedown.
   *
   * @param {Element} element
   * @param {{ x: number, y: number }} point
   * @param {'left' | 'middle' | 'right'} button
   * @param {number} detail
   * @param {ModifierState} modifiers
   * @returns {{ mouseEventsSuppressed: boolean, focusAllowed: boolean }}
   */
  function pressMouseButton(element, point, button, detail, modifiers) {
    const state = getMouseButtonState(button);
    const pointerAllowed = dispatchPointerEvent(element, 'pointerdown', point, {
      ...MOUSE_POINTER,
      modifiers,
      button: state.button,
      buttons: state.buttons,
      pressure: 0.5,
    });
    if (!pointerAllowed) {
      return { mouseEventsSuppressed: true, focusAllowed: true };
    }
    const mouseAllowed = dispatchMouseEvent(element, 'mousedown', point, {
      modifiers,
      button: state.button,
      buttons: state.buttons,
      detail,
    });
    return { mouseEventsSuppressed: false, focusAllowed: mouseAllowed };
  }

  /**
   * @param {Element} element
   * @param {{ x: number, y: number }} point
   * @param {'left' | 'middle' | 'right'} button
   * @param {number} detail
   * @param {ModifierState} modifiers
   * @param {boolean} mouseEventsSuppressed
   * @returns {void}
   */
  function releaseMouseButton(element, point, button, detail, modifiers, mouseEventsSuppressed) {
    const state = getMouseButtonState(button);
    dispatchPointerEvent(element, 'pointerup', point, {
      ...MOUSE_POINTER,
      modifiers,
      button: state.button,
      buttons: 0,
    });
    if (!mouseEventsSuppressed) {
      dispatchMouseEvent(element, 'mouseup', point, {
        modifiers,
        button: state.button,
        buttons: 0,
        detail,
      });
    }
  }

  /**
   * Pick the element that receives a release after a hold: the pressed
   * element while it is still attached, otherwise whatever is now under the
   * pointer.
   *
   * @param {Element} element
   * @param {{ x: number, y: number }} point
   * @returns {Element}
   */
  function getReleaseTarget(element, point) {
    if (isConnectedElement(element)) return element;
    const hit =
      typeof document.elementFromPoint === 'function'
        ? document.elementFromPoint(point.x, point.y)
        : null;
    return hit ?? document.body;
  }

  /** US-layout code and legacy keyCode for keys DOM keyboard events commonly need. */
  const KEY_DEFINITIONS = Object.freeze({
    ' ': { code: 'Space', keyCode: 32 },
    Enter: { code: 'Enter', keyCode: 13 },
    Tab: { code: 'Tab', keyCode: 9 },
    Escape: { code: 'Escape', keyCode: 27 },
    Backspace: { code: 'Backspace', keyCode: 8 },
    Delete: { code: 'Delete', keyCode: 46 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    Home: { code: 'Home', keyCode: 36 },
    End: { code: 'End', keyCode: 35 },
    PageUp: { code: 'PageUp', keyCode: 33 },
    PageDown: { code: 'PageDown', keyCode: 34 },
    Shift: { code: 'ShiftLeft', keyCode: 16 },
    Control: { code: 'ControlLeft', keyCode: 17 },
    Alt: { code: 'AltLeft', keyCode: 18 },
    Meta: { code: 'MetaLeft', keyCode: 91 },
    ',': { code: 'Comma', keyCode: 188 },
    '.': { code: 'Period', keyCode: 190 },
    '/': { code: 'Slash', keyCode: 191 },
    ';': { code: 'Semicolon', keyCode: 186 },
    "'": { code: 'Quote', keyCode: 222 },
    '[': { code: 'BracketLeft', keyCode: 219 },
    ']': { code: 'BracketRight', keyCode: 221 },
    '\\': { code: 'Backslash', keyCode: 220 },
    '-': { code: 'Minus', keyCode: 189 },
    '=': { code: 'Equal', keyCode: 187 },
    '`': { code: 'Backquote', keyCode: 192 },
  });

  /**
   * @param {string} key
   * @returns {{ code: string, keyCode: number }}
   */
  function getKeyDefinition(key) {
    if (Object.hasOwn(KEY_DEFINITIONS, key)) {
      return KEY_DEFINITIONS[/** @type {keyof typeof KEY_DEFINITIONS} */ (key)];
    }
    if (/^[a-z]$/i.test(key)) {
      return { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) };
    }
    if (/^[0-9]$/.test(key)) {
      return { code: `Digit${key}`, keyCode: key.charCodeAt(0) };
    }
    const functionKey = /^F([1-9]|1[0-2])$/.exec(key);
    if (functionKey) {
      return { code: key, keyCode: 111 + Number(functionKey[1]) };
    }
    return { code: '', keyCode: 0 };
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
    const pressed = beginKeyAction(element, key, modifiers);
    endKeyAction(pressed);
    return { target: pressed.target, key: pressed.key, handled: pressed.handled };
  }

  /**
   * @typedef {{ target: Element, key: string, handled: boolean, modifierState: ModifierState }} PressedKey
   */

  /**
   * Press a key: keydown, keypress for character keys, then the default
   * editing action. A canceled keydown suppresses both, as in real browsers.
   *
   * @param {Element} element
   * @param {string} key
   * @param {unknown} modifiers
   * @returns {PressedKey}
   */
  function beginKeyAction(element, key, modifiers) {
    const normalizedKey = key === 'Space' ? ' ' : key;
    const keyboardTarget = focusElement(element);
    const modifierState = normalizeModifierState(modifiers);
    const keyDownAllowed = dispatchKeyboardEvent(
      keyboardTarget,
      'keydown',
      normalizedKey,
      modifierState
    );

    let handled = false;
    const commandModifier = modifierState.altKey || modifierState.ctrlKey || modifierState.metaKey;
    const producesCharacter =
      (normalizedKey.length === 1 || normalizedKey === 'Enter') && !commandModifier;
    const keyPressAllowed =
      keyDownAllowed && producesCharacter
        ? dispatchKeyboardEvent(keyboardTarget, 'keypress', normalizedKey, modifierState)
        : keyDownAllowed;

    if (keyPressAllowed) {
      const editable = getEditableTarget(keyboardTarget);
      if (editable && normalizedKey.length === 1 && !commandModifier) {
        handled = insertTextIntoEditable(editable, normalizedKey);
      } else if (editable && normalizedKey === 'Backspace') {
        handled = deleteTextFromEditable(editable, 'backward');
      } else if (editable && normalizedKey === 'Delete') {
        handled = deleteTextFromEditable(editable, 'forward');
      } else if (normalizedKey === 'Enter') {
        handled = handleEnterKey(keyboardTarget);
      }
    }

    return { target: keyboardTarget, key: normalizedKey, handled, modifierState };
  }

  /** @param {PressedKey} pressed @returns {void} */
  function endKeyAction(pressed) {
    dispatchKeyboardEvent(pressed.target, 'keyup', pressed.key, pressed.modifierState);
  }

  /**
   * @param {Element} element
   * @param {string} type
   * @param {string} key
   * @param {{ altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean }} modifiers
   * @returns {boolean}
   */
  function dispatchKeyboardEvent(element, type, key, modifiers) {
    const definition = getKeyDefinition(key);
    const charCode = type === 'keypress' ? (key === 'Enter' ? 13 : key.charCodeAt(0)) : 0;
    return element.dispatchEvent(
      new KeyboardEvent(type, {
        key,
        code: definition.code,
        keyCode: type === 'keypress' ? charCode : definition.keyCode,
        charCode,
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
   * @param {Element} element
   * @returns {HTMLInputElement}
   */
  function resolveCheckableTarget(element) {
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

    throw createInputError('INPUT_INVALID_TARGET', 'Target is not a checkbox or radio input.', {
      elementRef: rememberElement(element),
    });
  }

  /**
   * @param {Element} element
   * @returns {HTMLSelectElement}
   */
  function resolveSelectTarget(element) {
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

    throw createInputError('INPUT_INVALID_TARGET', 'Target is not a select control.', {
      elementRef: rememberElement(element),
    });
  }

  /**
   * Trigger a click with the event sequence of a real mouse: boundary and move
   * events, then per click pointerdown/mousedown, focus, optional hold,
   * pointerup/mouseup, and a click/auxclick/contextmenu event, plus dblclick
   * for a double click.
   *
   * @param {Record<string, any>} params
   * @returns {Promise<Record<string, unknown>>}
   */
  async function clickTarget(params) {
    const resolved = resolveActionableTarget(params.target, {
      pointer: true,
      recoverStale: params.recoverStale === true,
    });
    const { element, point, resolution } = resolved;
    const button = normalizeMouseButton(params.button);
    const clickCount = clamp(params.clickCount ?? 1, 1, 2);
    const modifiers = normalizeModifierState(params.modifiers);
    const holdMs = normalizeHoldMs(params.holdMs);
    const state = getMouseButtonState(button);
    const clickType = button === 'left' ? 'click' : button === 'right' ? 'contextmenu' : 'auxclick';

    movePointerTo(element, point, modifiers);
    let releaseTarget = element;
    for (let detail = 1; detail <= clickCount; detail += 1) {
      const pressed = pressMouseButton(element, point, button, detail, modifiers);
      if (detail === 1 && pressed.focusAllowed) focusForPointerPress(element);
      if (holdMs > 0) await sleep(holdMs);
      releaseTarget = getReleaseTarget(element, point);
      releaseMouseButton(
        releaseTarget,
        point,
        button,
        detail,
        modifiers,
        pressed.mouseEventsSuppressed
      );
      dispatchClickEvent(releaseTarget, clickType, point, {
        ...MOUSE_POINTER,
        modifiers,
        button: state.button,
        buttons: 0,
        detail,
      });
    }
    if (clickCount === 2 && button === 'left') {
      dispatchMouseEvent(releaseTarget, 'dblclick', point, {
        modifiers,
        button: state.button,
        detail: 2,
      });
    }

    return {
      elementRef: rememberElement(element),
      clicked: true,
      button,
      clickCount,
      ...(holdMs > 0 ? { holdMs } : {}),
      resolution,
      execution: getExecutionMetadata('dom', point),
    };
  }

  /**
   * Focus one element so follow-up keyboard input lands consistently.
   *
   * @param {Record<string, any>} params
   * @returns {Record<string, unknown>}
   */
  function focusTarget(params) {
    const resolved = resolveActionableTarget(params.target, {
      pointer: false,
      recoverStale: params.recoverStale === true,
    });
    const { element, point, resolution } = resolved;
    const focused = focusElement(element);
    return {
      elementRef: rememberElement(element),
      focused: isElementFocused(element) || isElementFocused(focused),
      tag: focused.tagName.toLowerCase(),
      resolution,
      execution: getExecutionMetadata('dom', point),
    };
  }

  /**
   * Type text into an editable control or contenteditable region.
   *
   * @param {Record<string, any>} params
   * @returns {Record<string, unknown>}
   */
  function typeIntoTarget(params) {
    const base = resolveActionableTarget(params.target, {
      pointer: false,
      recoverStale: params.recoverStale === true,
    });
    const editable = getEditableTarget(base.element);
    if (!editable) {
      throw createInputError('INPUT_INVALID_TARGET', 'Target is not an editable control.', {
        elementRef: rememberElement(base.element),
        resolution: base.resolution,
      });
    }

    const resolved = finalizeDerivedTarget(base, editable);
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
      resolution: resolved.resolution,
      execution: getExecutionMetadata('dom', resolved.point),
    };
  }

  /**
   * Replace a contenteditable's text through the editing pipeline
   * (`beforeinput`/`input` with inputType insertText), which rich editors such
   * as Lexical, ProseMirror, Slate, and Draft handle. Setting textContent
   * directly is ignored or reverted by them.
   *
   * @param {HTMLElement} editable
   * @param {string} value
   * @returns {boolean} whether the editor accepted the text
   */
  function replaceRichText(editable, value) {
    const selection = document.getSelection?.();
    if (!selection || typeof document.execCommand !== 'function') return false;
    try {
      editable.focus?.();
      const range = document.createRange();
      range.selectNodeContents(editable);
      selection.removeAllRanges();
      selection.addRange(range);
      const applied = value
        ? document.execCommand('insertText', false, value)
        : document.execCommand('delete', false);
      if (!applied) return false;
      const normalize = (/** @type {string} */ text) => text.replace(/\s+/g, ' ').trim();
      return normalize(editable.innerText ?? editable.textContent ?? '') === normalize(value);
    } catch {
      return false;
    }
  }

  /**
   * @param {Element} element
   * @returns {void}
   */
  function dispatchBlurSignals(element) {
    const FocusCtor = typeof FocusEvent === 'function' ? FocusEvent : Event;
    element.dispatchEvent(new FocusCtor('focusout', { bubbles: true }));
    element.dispatchEvent(new FocusCtor('blur', { bubbles: false }));
  }

  /**
   * Set the value of an input/textarea/select element using the native value
   * setter, then dispatch input + change events. This works with React, Vue,
   * Angular, and vanilla forms - frameworks intercept these events at the
   * document level and sync their internal state.
   *
   * mode:
   *   "setter" (default) - use Object.getOwnPropertyDescriptor prototype setter
   *   "keystrokes" - clear field + type each character (slower but handles
   *     custom components that don't respond to setter)
   *   "auto" - try setter first, verify value stuck, fallback to keystrokes
   *
   * @param {Record<string, any>} params
   * @returns {Record<string, unknown>}
   */
  function fillTarget(params) {
    const base = resolveActionableTarget(params.target, {
      pointer: false,
      recoverStale: params.recoverStale === true,
    });
    const editable = getEditableTarget(base.element);
    if (!editable) {
      throw createInputError('INPUT_INVALID_TARGET', 'Target is not an editable control.', {
        elementRef: rememberElement(base.element),
        resolution: base.resolution,
      });
    }

    const resolved = finalizeDerivedTarget(base, editable);
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
      if (editable instanceof HTMLElement && editable.isContentEditable) {
        if (replaceRichText(editable, value)) {
          usedMode = 'rich-text';
        } else {
          editable.textContent = value;
        }
      } else {
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
      }
      if (usedMode !== 'rich-text') {
        editable.dispatchEvent(new Event('input', { bubbles: true }));
        editable.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // auto mode: verify value stuck, fallback to keystrokes if not
      if (
        requestedMode === 'auto' &&
        usedMode !== 'rich-text' &&
        getEditableValue(editable) !== value
      ) {
        usedMode = 'keystrokes-fallback';
        clearEditableValue(editable);
        for (const ch of value) {
          runKeyAction(editable, ch, undefined);
        }
      }
    }

    // Trigger field-level validation without moving focus, so a following
    // page-level Enter still reaches the field. React's onBlur listens to focusout.
    dispatchBlurSignals(editable);

    return {
      elementRef: rememberElement(editable),
      value: getEditableValue(editable),
      mode: usedMode,
      resolution: resolved.resolution,
      execution: getExecutionMetadata('dom', resolved.point),
    };
  }

  /**
   * Send one keyboard interaction to the currently focused or targeted element,
   * optionally holding the key down for holdMs before keyup.
   *
   * @param {Record<string, any>} params
   * @returns {Promise<Record<string, unknown>>}
   */
  async function pressKeyTarget(params) {
    const resolved =
      params.target?.elementRef || params.target?.selector
        ? resolveActionableTarget(params.target, {
            pointer: false,
            recoverStale: params.recoverStale === true,
          })
        : {
            element:
              document.activeElement instanceof Element ? document.activeElement : document.body,
            point: getViewportPoint(
              document.activeElement instanceof Element ? document.activeElement : document.body
            ),
            resolution: /** @type {InputResolutionMetadata} */ ({
              strategy: 'elementRef',
              candidateCount: 1,
              evaluatedCount: 1,
              scrolled: false,
              hitTest: 'not-required',
              recovered: false,
            }),
          };
    const target = resolved.element;
    focusElement(target);
    const key = String(params.key ?? '');
    if (!key) {
      throw new Error('A key is required.');
    }

    const holdMs = normalizeHoldMs(params.holdMs);
    const result = beginKeyAction(target, key, params.modifiers);
    if (holdMs > 0) await sleep(holdMs);
    endKeyAction(result);
    return {
      elementRef: result.target instanceof Element ? rememberElement(result.target) : null,
      key: result.key,
      handled: result.handled,
      ...(holdMs > 0 ? { holdMs } : {}),
      resolution: resolved.resolution,
      execution: getExecutionMetadata('dom', resolved.point),
    };
  }

  /**
   * Toggle a checkbox-like control to a desired checked state.
   *
   * @param {Record<string, any>} params
   * @returns {Record<string, unknown>}
   */
  function setCheckedTarget(params) {
    const base = resolveActionableTarget(params.target, {
      pointer: false,
      recoverStale: params.recoverStale === true,
    });
    const element = resolveCheckableTarget(base.element);
    const resolved = finalizeDerivedTarget(base, element);
    const checked = params.checked !== false;
    if (element.type === 'radio' && !checked && element.checked) {
      throw createInputError('INPUT_INVALID_TARGET', 'Radio inputs cannot be unchecked directly.', {
        elementRef: rememberElement(element),
      });
    }

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
      resolution: resolved.resolution,
      execution: getExecutionMetadata('dom', resolved.point),
    };
  }

  /**
   * Select options in a native select control by value, label, or index.
   *
   * @param {Record<string, any>} params
   * @returns {Record<string, unknown>}
   */
  function selectOptionTarget(params) {
    const base = resolveActionableTarget(params.target, {
      pointer: false,
      recoverStale: params.recoverStale === true,
    });
    const element = resolveSelectTarget(base.element);
    const resolved = finalizeDerivedTarget(base, element);
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
      throw createInputError('INPUT_INVALID_TARGET', 'No matching option found.', {
        elementRef: rememberElement(element),
        requestedCount: values.length + labels.length + indexes.length,
      });
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
      resolution: resolved.resolution,
      execution: getExecutionMetadata('dom', resolved.point),
    };
  }

  /**
   * Trigger hover state on an element by dispatching mouse events.
   *
   * @param {Record<string, any>} params
   * @returns {Promise<Record<string, unknown>> | Record<string, unknown>}
   */
  function hoverTarget(params) {
    const resolved = resolveActionableTarget(params.target, {
      pointer: true,
      recoverStale: params.recoverStale === true,
    });
    const { element, point, resolution } = resolved;
    const modifiers = normalizeModifierState(params.modifiers);
    const duration = clamp(params.duration ?? 0, 0, 5000);

    movePointerTo(element, point, modifiers);

    const ref = rememberElement(element);
    if (duration > 0) {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            elementRef: ref,
            hovered: true,
            resolution,
            execution: getExecutionMetadata('dom', point),
          });
        }, duration);
      });
    }
    return {
      elementRef: ref,
      hovered: true,
      resolution,
      execution: getExecutionMetadata('dom', point),
    };
  }

  /**
   * @param {Element} element
   * @returns {boolean}
   */
  function isNativeDragSource(element) {
    if (element instanceof HTMLElement && element.draggable === true) return true;
    return typeof element.closest === 'function' && Boolean(element.closest('[draggable="true"]'));
  }

  /**
   * @param {Element} element
   * @param {string} type
   * @param {{ x: number, y: number }} point
   * @param {DataTransfer} dataTransfer
   * @returns {boolean}
   */
  function dispatchDragEvent(element, type, point, dataTransfer) {
    return element.dispatchEvent(
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: point.x,
        clientY: point.y,
        dataTransfer,
      })
    );
  }

  /**
   * @param {{ x: number, y: number }} point
   * @param {Element} fallback
   * @returns {Element}
   */
  function elementAtPoint(point, fallback) {
    const hit = deepElementFromPoint(point.x, point.y);
    return hit ?? fallback;
  }

  /**
   * Perform a drag between two elements. Sources the browser would drag
   * natively (draggable elements) get the HTML5 drag-and-drop sequence; all
   * other sources get a pointer drag (press, interpolated moves across the
   * elements under the pointer, release), which is what pointer-driven
   * sortable lists, sliders, and canvases listen for.
   *
   * @param {Record<string, any>} params
   * @returns {Promise<Record<string, unknown>>}
   */
  async function dragTarget(params) {
    const sourceResolved = resolveActionableTarget(params.source, {
      pointer: true,
      recoverStale: params.recoverStale === true,
    });
    const source = sourceResolved.element;
    const sourcePoint = sourceResolved.point;
    const offsetX = Number(params.offsetX) || 0;
    const offsetY = Number(params.offsetY) || 0;
    const native = isNativeDragSource(source);

    movePointerTo(source, sourcePoint, NO_MODIFIERS);
    const pressed = pressMouseButton(source, sourcePoint, 'left', 1, NO_MODIFIERS);
    if (pressed.focusAllowed) focusForPointerPress(source);

    let destinationResolved;
    try {
      destinationResolved = resolveActionableTarget(params.destination, {
        pointer: true,
        recoverStale: params.recoverStale === true,
      });
    } catch (error) {
      releaseMouseButton(
        source,
        sourcePoint,
        'left',
        1,
        NO_MODIFIERS,
        pressed.mouseEventsSuppressed
      );
      throw error;
    }
    const destination = destinationResolved.element;
    const destPoint = destinationResolved.point;
    const endPoint = { x: destPoint.x + offsetX, y: destPoint.y + offsetY };

    if (native) {
      const dataTransfer = new DataTransfer();
      const started = dispatchDragEvent(source, 'dragstart', sourcePoint, dataTransfer);
      if (started) {
        dispatchPointerEvent(source, 'pointercancel', sourcePoint, {
          ...MOUSE_POINTER,
          modifiers: NO_MODIFIERS,
          button: -1,
          cancelable: false,
        });
        dispatchDragEvent(source, 'drag', sourcePoint, dataTransfer);
        dispatchDragEvent(destination, 'dragenter', endPoint, dataTransfer);
        const dropAllowed = !dispatchDragEvent(destination, 'dragover', endPoint, dataTransfer);
        if (dropAllowed) {
          dispatchDragEvent(destination, 'drop', endPoint, dataTransfer);
        } else {
          dispatchDragEvent(destination, 'dragleave', endPoint, dataTransfer);
        }
        dispatchDragEvent(source, 'dragend', endPoint, dataTransfer);
        pointerElement = destination;
      } else {
        releaseMouseButton(
          source,
          sourcePoint,
          'left',
          1,
          NO_MODIFIERS,
          pressed.mouseEventsSuppressed
        );
      }
    } else {
      const steps = 10;
      let current = source;
      for (let step = 1; step <= steps; step += 1) {
        // Hidden documents throttle each timer to about a second. DOM drags
        // have no duration contract, so deliver the ordered moves without
        // frame pacing rather than timing out or activating the user's tab.
        if (!document.hidden) await sleep(16);
        const progress = step / steps;
        const point = {
          x: sourcePoint.x + (endPoint.x - sourcePoint.x) * progress,
          y: sourcePoint.y + (endPoint.y - sourcePoint.y) * progress,
        };
        current = elementAtPoint(point, progress < 0.5 ? source : destination);
        movePointerTo(current, point, NO_MODIFIERS, { buttons: 1 });
      }
      releaseMouseButton(current, endPoint, 'left', 1, NO_MODIFIERS, pressed.mouseEventsSuppressed);
    }

    return {
      sourceRef: rememberElement(source),
      destinationRef: rememberElement(destination),
      dragged: true,
      strategy: native ? 'html5' : 'pointer',
      resolution: {
        source: sourceResolved.resolution,
        destination: destinationResolved.resolution,
      },
      execution: getExecutionMetadata('dom', endPoint),
    };
  }

  /**
   * @typedef {{
   *   identifier: number,
   *   element: Element,
   *   start: { x: number, y: number },
   *   end: { x: number, y: number } | null,
   *   current: { x: number, y: number }
   * }} TouchContact
   */

  /**
   * Resolve one normalized touch position: an actionable target's center or
   * a viewport point and the element under it.
   *
   * @param {{ target?: InputTargetSpec | null, x?: number | null, y?: number | null } | null | undefined} position
   * @param {boolean} recoverStale
   * @returns {{ element: Element, point: { x: number, y: number } }}
   */
  function resolveTouchPosition(position, recoverStale) {
    if (position?.target) {
      const resolved = resolveActionableTarget(position.target, { pointer: true, recoverStale });
      return { element: resolved.element, point: resolved.point };
    }
    const x = Number(position?.x);
    const y = Number(position?.y);
    if (position?.x == null || position?.y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw createInputError(
        'INVALID_REQUEST',
        'Touch point needs a target or numeric x and y.',
        {}
      );
    }
    const point = { x, y };
    return { element: elementAtPoint(point, document.body ?? document.documentElement), point };
  }

  /**
   * @param {TouchContact} contact
   * @param {number} pressure
   * @param {number} buttons
   * @returns {PointerDispatchOptions}
   */
  function touchPointerOptions(contact, pressure, buttons) {
    return {
      pointerId: FIRST_TOUCH_POINTER_ID + contact.identifier,
      pointerType: 'touch',
      isPrimary: contact.identifier === 0,
      modifiers: NO_MODIFIERS,
      button: buttons ? 0 : -1,
      buttons,
      pressure,
    };
  }

  /**
   * @param {TouchContact} contact
   * @returns {Touch}
   */
  function createTouch(contact) {
    return new Touch({
      identifier: contact.identifier,
      target: contact.element,
      clientX: contact.current.x,
      clientY: contact.current.y,
      pageX: contact.current.x + (Number(globalThis.scrollX) || 0),
      pageY: contact.current.y + (Number(globalThis.scrollY) || 0),
      radiusX: 1,
      radiusY: 1,
      force: 0.5,
    });
  }

  /**
   * Dispatch a TouchEvent for one changed contact. Pages without Touch support
   * receive only the pointer events.
   *
   * @param {TouchContact} changed
   * @param {'touchstart' | 'touchmove' | 'touchend'} type
   * @param {TouchContact[]} active - contacts still on the surface after this change
   * @returns {boolean}
   */
  function dispatchTouchEvent(changed, type, active) {
    if (typeof Touch !== 'function' || typeof TouchEvent !== 'function') return true;
    return changed.element.dispatchEvent(
      new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        touches: active.map(createTouch),
        targetTouches: active
          .filter((contact) => contact.element === changed.element)
          .map(createTouch),
        changedTouches: [createTouch(changed)],
      })
    );
  }

  /**
   * Put one or more fingers down at the same time, optionally move them, hold
   * for holdMs, and lift them. Each finger is a separate touch pointer, so
   * chords and multi-finger gestures reach pointer and touch listeners alike.
   * A single-finger tap also produces compatibility mouse events and a click.
   *
   * @param {Record<string, any>} params
   * @returns {Promise<Record<string, unknown>>}
   */
  async function touchTarget(params) {
    const recoverStale = params.recoverStale === true;
    const points = Array.isArray(params.points) ? params.points : [];
    if (!points.length) {
      throw createInputError(
        'INVALID_REQUEST',
        'points must contain at least one touch point.',
        {}
      );
    }
    /** @type {TouchContact[]} */
    const contacts = points.map((point, index) => {
      const start = resolveTouchPosition(point, recoverStale);
      return {
        identifier: index,
        element: start.element,
        start: start.point,
        end: point?.to ? resolveTouchPosition(point.to, recoverStale).point : null,
        current: { ...start.point },
      };
    });
    const holdMs = normalizeHoldMs(params.holdMs);
    const moveSteps = clamp(params.moveSteps ?? 10, 1, 60);
    const moving = contacts.some((contact) => contact.end);
    let canceled = false;

    /** @type {TouchContact[]} */
    const active = [];
    for (const contact of contacts) {
      const options = touchPointerOptions(contact, 0.5, 1);
      dispatchPointerEvent(contact.element, 'pointerover', contact.current, options);
      dispatchPointerEvent(contact.element, 'pointerenter', contact.current, {
        ...options,
        bubbles: false,
        cancelable: false,
      });
      dispatchPointerEvent(contact.element, 'pointerdown', contact.current, options);
      active.push(contact);
      if (!dispatchTouchEvent(contact, 'touchstart', active)) canceled = true;
    }

    if (moving) {
      for (let step = 1; step <= moveSteps; step += 1) {
        await sleep(holdMs / moveSteps);
        const progress = step / moveSteps;
        for (const contact of contacts) {
          if (!contact.end) continue;
          contact.current = {
            x: contact.start.x + (contact.end.x - contact.start.x) * progress,
            y: contact.start.y + (contact.end.y - contact.start.y) * progress,
          };
          dispatchPointerEvent(
            contact.element,
            'pointermove',
            contact.current,
            touchPointerOptions(contact, 0.5, 1)
          );
          if (!dispatchTouchEvent(contact, 'touchmove', active)) canceled = true;
        }
      }
    } else if (holdMs > 0) {
      await sleep(holdMs);
    }

    for (const contact of contacts) {
      const options = touchPointerOptions(contact, 0, 0);
      dispatchPointerEvent(contact.element, 'pointerup', contact.current, options);
      dispatchPointerEvent(contact.element, 'pointerout', contact.current, options);
      dispatchPointerEvent(contact.element, 'pointerleave', contact.current, {
        ...options,
        bubbles: false,
        cancelable: false,
      });
      active.splice(active.indexOf(contact), 1);
      if (!dispatchTouchEvent(contact, 'touchend', active)) canceled = true;
    }

    let clicked = false;
    if (contacts.length === 1 && !moving && !canceled) {
      const [contact] = contacts;
      const element = getReleaseTarget(contact.element, contact.current);
      movePointerTo(element, contact.current, NO_MODIFIERS, { pointerEvents: false });
      const mouseOptions = { modifiers: NO_MODIFIERS, detail: 1 };
      if (
        dispatchMouseEvent(element, 'mousedown', contact.current, { ...mouseOptions, buttons: 1 })
      ) {
        focusForPointerPress(element);
      }
      dispatchMouseEvent(element, 'mouseup', contact.current, mouseOptions);
      dispatchClickEvent(element, 'click', contact.current, {
        ...touchPointerOptions(contact, 0, 0),
        button: 0,
        detail: 1,
      });
      clicked = true;
    }

    return {
      touched: true,
      pointCount: contacts.length,
      points: contacts.map((contact) => ({
        elementRef: rememberElement(contact.element),
        x: Math.round(contact.start.x),
        y: Math.round(contact.start.y),
        ...(contact.end ? { toX: Math.round(contact.end.x), toY: Math.round(contact.end.y) } : {}),
      })),
      holdMs,
      canceled,
      clicked,
      execution: getExecutionMetadata('dom', contacts[0].start),
    };
  }

  /**
   * Resolve and validate a target immediately before debugger-backed input.
   * This helper performs no click, typing, value setting, or drag mutation.
   *
   * @param {Record<string, unknown>} params
   * @returns {Promise<{ elementRef: string, point: { x: number, y: number }, resolution: InputResolutionMetadata, tag: string, value?: string }>}
   */
  async function prepareNativeInput(params) {
    const target =
      params.target && typeof params.target === 'object'
        ? /** @type {InputTargetSpec} */ (params.target)
        : undefined;
    const { resolved: base, waitedMs } = await awaitActionableTarget(target, {
      pointer: params.kind === 'pointer',
      recoverStale: params.recoverStale === true,
      timeoutMs: clamp(Number(params.timeoutMs) || 0, 0, 15_000),
    });
    if (waitedMs > 0) base.resolution = { ...base.resolution, waitedMs };
    if (params.kind === 'focus') focusElement(base.element);
    let resolved = base;
    if (params.kind === 'editable') {
      const editable = getEditableTarget(base.element);
      if (!editable) {
        throw createInputError('INPUT_INVALID_TARGET', 'Target is not an editable control.', {
          elementRef: rememberElement(base.element),
          resolution: base.resolution,
        });
      }
      resolved = finalizeDerivedTarget(base, editable);
      focusElement(editable);
    }
    const editable = getEditableTarget(resolved.element);
    return {
      elementRef: rememberElement(resolved.element),
      point: resolved.point,
      resolution: resolved.resolution,
      tag: resolved.element.tagName.toLowerCase(),
      ...(editable ? { value: getEditableValue(editable) } : {}),
    };
  }

  /**
   * Verify exact editable identity and focus without attempting to restore it.
   *
   * @param {Record<string, unknown>} params
   * @returns {{ elementRef: string, active: true }}
   */
  function revalidateNativeInput(params) {
    const ref = typeof params.elementRef === 'string' ? params.elementRef : '';
    const { element } = resolveInputReference(ref, false);
    if (!isEditableElement(element)) {
      throw createInputError('INPUT_INVALID_TARGET', 'Target is no longer an editable control.', {
        elementRef: ref,
      });
    }
    if (document.activeElement !== element) {
      const active = document.activeElement;
      throw createInputError(
        'INPUT_FOCUS_CHANGED',
        'Focus moved away from the native text target.',
        {
          elementRef: ref,
          activeTag: active instanceof Element ? active.tagName.toLowerCase() : null,
        }
      );
    }
    return { elementRef: ref, active: true };
  }

  /**
   * Read a post-dispatch editable value without replaying a mutation.
   *
   * @param {Record<string, unknown>} params
   * @returns {{ elementRef: string, value: string }}
   */
  function readInputValue(params) {
    const ref = typeof params.elementRef === 'string' ? params.elementRef : '';
    const { element } = resolveInputReference(ref, false);
    const editable = getEditableTarget(element);
    if (!editable) {
      throw createInputError('INPUT_INVALID_TARGET', 'Target is not an editable control.', {
        elementRef: ref,
      });
    }
    return { elementRef: rememberElement(editable), value: getEditableValue(editable) };
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

  /**
   * Compact locator description for error details.
   *
   * @param {InputTargetSpec | undefined} target
   * @returns {Record<string, unknown>}
   */
  function describeLocator(target) {
    /** @type {Record<string, unknown>} */
    const described = {};
    for (const key of ['role', 'name', 'text', 'label', 'placeholder', 'testId', 'selector']) {
      const value = target?.[/** @type {keyof InputTargetSpec} */ (key)];
      if (typeof value === 'string' && value) described[key] = value.slice(0, 120);
    }
    if (target?.exact) described.exact = true;
    if (typeof target?.nth === 'number') described.nth = target.nth;
    return described;
  }

  /** Failures that can clear up while the page keeps rendering. */
  const RETRYABLE_WAIT_CODES = new Set([
    'ELEMENT_NOT_FOUND',
    'ELEMENT_NOT_ACTIONABLE',
    'ELEMENT_OBSCURED',
  ]);
  const WAIT_POLL_MS = 100;
  const STABILITY_SAMPLE_MS = 34;
  const OBSERVE_QUIET_MS = 150;
  const MAX_OBSERVED_MESSAGES = 3;
  const DIALOG_SELECTOR =
    'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
  const LIVE_REGION_SELECTOR =
    '[role="alert"], [role="status"], [role="log"], [aria-live]:not([aria-live="off"])';

  /**
   * Resolve after the next DOM mutation (plus a frame) or the delay.
   *
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function waitForDomActivity(ms) {
    return new Promise((resolve) => {
      let done = false;
      /** @type {MutationObserver | null} */
      let observer = null;
      const finish = () => {
        if (done) return;
        done = true;
        observer?.disconnect();
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, ms));
      if (typeof MutationObserver === 'function' && document.documentElement) {
        observer = new MutationObserver(() => setTimeout(finish, 16));
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
        });
      }
    });
  }

  /**
   * Whether a running CSS/Web animation may still be moving the element.
   *
   * @param {Element} element
   * @returns {boolean}
   */
  function hasRunningAnimation(element) {
    if (typeof document.getAnimations !== 'function') return false;
    for (const animation of document.getAnimations()) {
      if (animation.playState !== 'running') continue;
      const animated = /** @type {KeyframeEffect | null} */ (animation.effect)?.target;
      if (animated && (animated === element || composedContains(animated, element))) return true;
    }
    return false;
  }

  /**
   * Wait until the target exists, is actionable, and is not mid-animation, up
   * to `timeoutMs`. Saves agents a separate wait call plus a retry round trip.
   *
   * @param {InputTargetSpec | undefined} target
   * @param {{ pointer: boolean, recoverStale: boolean, timeoutMs: number }} options
   * @returns {Promise<{ resolved: ResolvedInputTarget, waitedMs: number }>}
   */
  async function awaitActionableTarget(target, options) {
    const start = Date.now();
    const deadline = start + Math.max(0, options.timeoutMs);
    for (;;) {
      try {
        const resolved = resolveActionableTarget(target, options);
        if (hasRunningAnimation(resolved.element) && Date.now() < deadline) {
          const before = resolved.element.getBoundingClientRect();
          await sleep(STABILITY_SAMPLE_MS);
          const after = resolved.element.getBoundingClientRect();
          if (before.x !== after.x || before.y !== after.y || before.width !== after.width) {
            continue;
          }
        }
        return { resolved, waitedMs: Date.now() - start };
      } catch (error) {
        const code = /** @type {{ code?: unknown }} */ (error)?.code;
        if (typeof code !== 'string' || !RETRYABLE_WAIT_CODES.has(code) || Date.now() >= deadline) {
          const details = /** @type {{ details?: Record<string, unknown> }} */ (error)?.details;
          if (details && typeof details === 'object' && Date.now() > start) {
            details.waitedMs = Date.now() - start;
          }
          throw error;
        }
      }
      await waitForDomActivity(Math.min(WAIT_POLL_MS, deadline - Date.now()));
    }
  }

  /**
   * Active element, following focus into shadow roots.
   *
   * @returns {Element | null}
   */
  function deepActiveElement() {
    let active = document.activeElement;
    for (let depth = 0; active && depth < 32; depth += 1) {
      const inner = getShadowRoot(active)?.activeElement ?? null;
      if (!inner) break;
      active = inner;
    }
    return active;
  }

  /**
   * @returns {Element[]}
   */
  function visibleDialogs() {
    return querySelectorAllDeep(DIALOG_SELECTOR).filter((element) => isElementVisible(element));
  }

  /**
   * @param {Element} element
   * @returns {{ role: string, name?: string, ref: string }}
   */
  function describeEffectElement(element) {
    const name = getAccessibleName(element).slice(0, 120);
    return {
      role: getElementRoles(element)[0] ?? element.tagName.toLowerCase(),
      ...(name ? { name } : {}),
      ref: rememberElement(element),
    };
  }

  /**
   * Post-action state of the acted-on element, limited to fields it has.
   *
   * @param {Element | null} element
   * @returns {Record<string, unknown> | null}
   */
  function describeTargetState(element) {
    if (!element) return null;
    if (!isNodeAttached(element)) return { removed: true };
    /** @type {Record<string, unknown>} */
    const state = {};
    const editable = getEditableTarget(element);
    if (editable) state.value = getEditableValue(editable).slice(0, 200);
    const control = /** @type {{ checked?: unknown, type?: unknown }} */ (element);
    if (element.tagName === 'INPUT' && (control.type === 'checkbox' || control.type === 'radio')) {
      state.checked = Boolean(control.checked);
    }
    for (const attribute of ['aria-checked', 'aria-expanded', 'aria-pressed', 'aria-selected']) {
      const value = element.getAttribute(attribute);
      if (value !== null)
        state[attribute.slice(5)] = value === 'true' ? true : value === 'false' ? false : value;
    }
    if (
      ('disabled' in element &&
        Boolean(/** @type {{ disabled?: unknown }} */ (element).disabled)) ||
      element.getAttribute('aria-disabled') === 'true'
    ) {
      state.disabled = true;
    }
    return Object.keys(state).length ? state : null;
  }

  /**
   * @param {Node} node
   * @returns {Element | null}
   */
  function closestLiveRegion(node) {
    const element = node.nodeType === 1 ? /** @type {Element} */ (node) : node.parentElement;
    return element && typeof element.closest === 'function'
      ? element.closest(LIVE_REGION_SELECTOR)
      : null;
  }

  /**
   * Record what an action changes: same-document URL changes, unloads, new
   * dialogs, live-region/alert messages, focus moves, DOM churn, and the
   * target's own state. Lets agents skip a follow-up read after most actions.
   *
   * @returns {{ finish: (options: { settleMs: number, element: Element | null }) => Promise<Record<string, unknown>> }}
   */
  function startObservation() {
    const startedAt = Date.now();
    const startUrl = location.href;
    const startTitle = document.title;
    const startActive = deepActiveElement();
    const startDialogs = new Set(visibleDialogs());
    let added = 0;
    let removed = 0;
    let lastMutationAt = startedAt;
    let unloading = false;
    /** @type {Set<Element>} */
    const messageRegions = new Set();
    /** @param {Node} node */
    const collectNotable = (node) => {
      if (node.nodeType !== 1) return;
      const element = /** @type {Element} */ (node);
      if (element.matches?.(LIVE_REGION_SELECTOR)) messageRegions.add(element);
      for (const region of element.querySelectorAll?.(LIVE_REGION_SELECTOR) ?? []) {
        if (messageRegions.size > 20) break;
        messageRegions.add(region);
      }
    };
    const observer =
      typeof MutationObserver === 'function' && document.documentElement
        ? new MutationObserver((records) => {
            lastMutationAt = Date.now();
            for (const record of records) {
              if (record.type === 'childList') {
                for (const node of record.addedNodes) {
                  if (node.nodeType !== 1) continue;
                  added += 1;
                  collectNotable(node);
                }
                for (const node of record.removedNodes) {
                  if (node.nodeType === 1) removed += 1;
                }
              }
              const region = closestLiveRegion(record.target);
              if (region) messageRegions.add(region);
            }
          })
        : null;
    observer?.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['open', 'hidden', 'aria-hidden', 'aria-expanded', 'class', 'style'],
    });
    const onUnload = () => {
      unloading = true;
    };
    globalThis.addEventListener?.('pagehide', onUnload);
    globalThis.addEventListener?.('beforeunload', onUnload);

    return {
      async finish({ settleMs, element }) {
        const deadline = startedAt + settleMs;
        await sleep(Math.min(50, settleMs));
        while (
          !unloading &&
          Date.now() < deadline &&
          Date.now() - lastMutationAt < OBSERVE_QUIET_MS
        ) {
          await sleep(Math.min(50, Math.max(0, deadline - Date.now())));
        }
        observer?.disconnect();
        globalThis.removeEventListener?.('pagehide', onUnload);
        globalThis.removeEventListener?.('beforeunload', onUnload);

        /** @type {Record<string, unknown>} */
        const effects = {};
        if (unloading) effects.navigation = 'unloading';
        if (location.href !== startUrl) effects.url = location.href;
        if (document.title !== startTitle) effects.title = document.title.slice(0, 160);
        const dialogs = visibleDialogs()
          .filter((dialog) => !startDialogs.has(dialog))
          .slice(0, 2)
          .map(describeEffectElement);
        if (dialogs.length) effects.dialogs = dialogs;
        const messages = [...messageRegions]
          .filter((region) => isNodeAttached(region) && isElementVisible(region))
          .map((region) => ({
            role: getElementRoles(region)[0] ?? 'status',
            text: getElementTextContent(region, 160),
          }))
          .filter((message) => message.text)
          .slice(0, MAX_OBSERVED_MESSAGES);
        if (messages.length) effects.messages = messages;
        const active = deepActiveElement();
        if (active && active !== startActive && active !== document.body) {
          effects.focused = describeEffectElement(active);
        }
        if (added || removed) effects.dom = { added, removed };
        const targetState = describeTargetState(element);
        if (targetState) effects.target = targetState;
        effects.changed = Object.keys(effects).some((key) => key !== 'target');
        effects.settledMs = Date.now() - startedAt;
        return effects;
      },
    };
  }

  /** Which params hold targets per method, and whether they need a pointer hit. */
  const INPUT_TARGET_KEYS = /** @type {Record<string, Array<[string, boolean]>>} */ ({
    'input.click': [['target', true]],
    'input.hover': [['target', true]],
    'input.drag': [
      ['source', true],
      ['destination', true],
    ],
    'input.focus': [['target', false]],
    'input.type': [['target', false]],
    'input.fill': [['target', false]],
    'input.press_key': [['target', false]],
    'input.set_checked': [['target', false]],
    'input.select_option': [['target', false]],
  });

  /**
   * @param {unknown} value
   * @returns {value is InputTargetSpec}
   */
  function hasTargetSpec(value) {
    if (!value || typeof value !== 'object') return false;
    const spec = /** @type {InputTargetSpec} */ (value);
    return Boolean(spec.elementRef || spec.selector || getDomQueryModule()?.isLocator(spec));
  }

  /**
   * Run one input method with auto-wait for its targets and optional effect
   * observation. Targets are pre-resolved (waiting as needed) and handed to the
   * action as exact refs, so the action itself stays synchronous and atomic.
   *
   * @param {string} method
   * @param {(params: Record<string, any>) => unknown} action
   * @returns {(params: Record<string, any>) => Promise<Record<string, unknown>>}
   */
  function withInputPipeline(method, action) {
    return async (params) => {
      const timeoutMs = clamp(Number(params.timeoutMs) || 0, 0, 15_000);
      const recoverStale = params.recoverStale === true;
      /** @type {Record<string, any>} */
      const prepared = { ...params };
      /** @type {Record<string, { resolution: InputResolutionMetadata, waitedMs: number }>} */
      const preResolutions = {};
      /** @type {Element | null} */
      let primaryElement = null;
      for (const [key, pointer] of INPUT_TARGET_KEYS[method] ?? []) {
        const spec = params[key];
        if (!hasTargetSpec(spec)) continue;
        const { resolved, waitedMs } = await awaitActionableTarget(spec, {
          pointer,
          recoverStale,
          timeoutMs,
        });
        prepared[key] = { elementRef: rememberElement(resolved.element) };
        preResolutions[key] = { resolution: resolved.resolution, waitedMs };
        primaryElement ??= resolved.element;
      }
      if (Object.keys(preResolutions).length) prepared.recoverStale = false;

      const observeOptions = /** @type {{ settleMs?: unknown } | null | undefined} */ (
        params.observe
      );
      const observation = observeOptions ? startObservation() : null;
      const result = /** @type {Record<string, unknown>} */ (await action(prepared));
      mergePreResolution(result, preResolutions);
      if (observation) {
        result.effects = await observation.finish({
          settleMs: clamp(Number(observeOptions?.settleMs) || 0, 0, 5_000),
          element: primaryElement,
        });
      }
      return result;
    };
  }

  /**
   * Keep the original strategy (selector/locator/stale recovery) in the
   * reported resolution even though the action ran on an exact ref.
   *
   * @param {Record<string, unknown>} result
   * @param {Record<string, { resolution: InputResolutionMetadata, waitedMs: number }>} preResolutions
   * @returns {void}
   */
  function mergePreResolution(result, preResolutions) {
    const primary = preResolutions.target ?? preResolutions.source;
    if (primary && result.resolution && typeof result.resolution === 'object') {
      const actionResolution = /** @type {InputResolutionMetadata} */ (result.resolution);
      result.resolution = {
        ...primary.resolution,
        scrolled: primary.resolution.scrolled || actionResolution.scrolled,
        hitTest: actionResolution.hitTest,
        ...(primary.waitedMs > 0 ? { waitedMs: primary.waitedMs } : {}),
      };
    }
    for (const key of ['source', 'destination']) {
      const pre = preResolutions[key];
      const reported = result[key];
      if (pre && reported && typeof reported === 'object') {
        const record = /** @type {Record<string, unknown>} */ (reported);
        if (record.resolution && typeof record.resolution === 'object') {
          record.resolution = {
            ...pre.resolution,
            hitTest: /** @type {InputResolutionMetadata} */ (record.resolution).hitTest,
            ...(pre.waitedMs > 0 ? { waitedMs: pre.waitedMs } : {}),
          };
        }
      }
    }
  }

  /**
   * Whether a target likely needs trusted (debugger) input because browsers
   * gate the behavior on user activation or rich editors ignore synthetic
   * key events. Read-only: resolves without waiting or mutating.
   *
   * @param {Record<string, unknown>} params
   * @returns {{ needsTrusted: boolean, reason: string | null }}
   */
  function getTrustHint(params) {
    const spec = params.target;
    if (!hasTargetSpec(spec)) return { needsTrusted: false, reason: null };
    let element;
    try {
      element = resolveActionableTarget(spec, { pointer: false, recoverStale: false }).element;
    } catch {
      return { needsTrusted: false, reason: null };
    }
    const method = String(params.method ?? '');
    const tag = element.tagName;
    if (tag === 'INPUT' && element.getAttribute('type') === 'file') {
      return { needsTrusted: true, reason: 'file-input' };
    }
    if (element.closest?.('video, audio') || tag === 'VIDEO' || tag === 'AUDIO') {
      return { needsTrusted: true, reason: 'media-activation' };
    }
    const link = element.closest?.('a[href]');
    if (method === 'input.click' && link && /^_blank$/i.test(link.getAttribute('target') ?? '')) {
      return { needsTrusted: true, reason: 'new-window-link' };
    }
    if (
      (method === 'input.type' || method === 'input.fill' || method === 'input.press_key') &&
      /** @type {HTMLElement} */ (getEditableTarget(element) ?? element).isContentEditable
    ) {
      return { needsTrusted: true, reason: 'rich-text-editor' };
    }
    return { needsTrusted: false, reason: null };
  }

  /** @type {Map<string, ReturnType<typeof startObservation>>} */
  const pendingObservations = new Map();
  let observationCounter = 0;

  /**
   * Begin observing for a debugger-dispatched (CDP) input action.
   *
   * @returns {{ observationId: string }}
   */
  function beginNativeObservation() {
    observationCounter += 1;
    const observationId = `obs_${observationCounter}`;
    pendingObservations.set(observationId, startObservation());
    if (pendingObservations.size > 8) {
      const oldest = pendingObservations.keys().next().value;
      if (oldest !== undefined) pendingObservations.delete(oldest);
    }
    return { observationId };
  }

  /**
   * Finish a CDP-mode observation and report its effects.
   *
   * @param {Record<string, unknown>} params
   * @returns {Promise<Record<string, unknown>>}
   */
  async function finishNativeObservation(params) {
    const observationId = String(params.observationId ?? '');
    const observation = pendingObservations.get(observationId);
    pendingObservations.delete(observationId);
    if (!observation) return { changed: false, expired: true };
    /** @type {Element | null} */
    let element = null;
    if (typeof params.elementRef === 'string' && params.elementRef) {
      try {
        element = resolveInputReference(params.elementRef, false).element;
      } catch {
        element = null;
      }
    }
    return observation.finish({
      settleMs: clamp(Number(params.settleMs) || 0, 0, 5_000),
      element,
    });
  }

  globalState.__BBX_CONTENT_INPUT__ = Object.freeze({
    beginNativeObservation,
    getTrustHint,
    finishNativeObservation,
    clickTarget: withInputPipeline('input.click', clickTarget),
    dragTarget: withInputPipeline('input.drag', dragTarget),
    fillTarget: withInputPipeline('input.fill', fillTarget),
    focusTarget: withInputPipeline('input.focus', focusTarget),
    hoverTarget: withInputPipeline('input.hover', hoverTarget),
    prepareNativeInput,
    revalidateNativeInput,
    readInputValue,
    pressKeyTarget: withInputPipeline('input.press_key', pressKeyTarget),
    scrollIntoViewTarget,
    scrollViewport,
    selectOptionTarget: withInputPipeline('input.select_option', selectOptionTarget),
    setCheckedTarget: withInputPipeline('input.set_checked', setCheckedTarget),
    touchTarget,
    typeIntoTarget: withInputPipeline('input.type', typeIntoTarget),
  });
})();
