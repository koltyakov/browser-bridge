(() => {
  const globalState = globalThis as typeof globalThis & {
    __BBX_CONTENT_INPUT__?: Record<string, unknown>;
  };

  if (globalState.__BBX_CONTENT_INPUT__) {
    return;
  }

  const contentHelpers = (
    globalThis as typeof globalThis & {
      __BBX_CONTENT_HELPERS__?: {
        NON_TEXT_INPUT_TYPES: Set<string>;
        clamp: (value: unknown, minimum: number, maximum: number) => number;
        escapeTailwindSelector: (selector: string) => string;
        getAccessibleName: (element: Element) => string;
        getElementRoles: (element: Element) => string[];
        getElementTextContent: (element: Element, budget?: number) => string;
        getShadowRoot: (element: Element) => ShadowRoot | null;
        isElementVisible: (element: Element) => boolean;
        isNodeAttached: (node: Node | null | undefined) => boolean;
        querySelectorAllDeep: (selector: string, root?: ParentNode) => Element[];
      };
    }
  ).__BBX_CONTENT_HELPERS__;
  const registry = (
    globalThis as typeof globalThis & {
      __BBX_CONTENT_REGISTRY__?: {
        getRequiredElement: (ref: string) => Element;
        rememberElement: (element: Element) => string;
        resolveTarget: (target?: { elementRef?: string; selector?: string }) => Element;
        resolveInputReference: (
          ref: string,
          recoverStale: boolean
        ) => {
          element: Element;
          recovery: null | {
            oldRef: string;
            newRef: string;
            matchedFields: string[];
            confidenceBasis: string;
          };
        };
      };
    }
  ).__BBX_CONTENT_REGISTRY__;
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

  type InputTargetSpec = import('../../../protocol/src/types.js').InputTarget;

  /** Targets have already passed protocol normalization in the background. */
  type InputParams = Record<string, unknown> & {
    target?: InputTargetSpec;
    source?: InputTargetSpec;
    destination?: InputTargetSpec;
    points?: import('../../../protocol/src/types.js').TouchPointParams[];
  };

  /** The locator engine lives in content-dom-query.js, which loads first. */
  function getDomQueryModule(): {
    isLocator: (value: unknown) => boolean;
    locateElements: (
      locator: Record<string, unknown>,
      options?: { maxResults?: number; scanLimit?: number }
    ) => {
      matches: Element[];
      hiddenMatches: number;
      scanned: number;
      truncationReason: string | null;
    };
  } | null {
    return (
      (
        globalThis as typeof globalThis & {
          __BBX_CONTENT_DOM_QUERY__?: ReturnType<typeof getDomQueryModule>;
        }
      ).__BBX_CONTENT_DOM_QUERY__ ?? null
    );
  }

  /** Hit-test through open/closed shadow roots, since document-level
elementFromPoint retargets to the outermost shadow host. */
  function deepElementFromPoint(x: number, y: number): Element | null {
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

  /** `contains` across shadow boundaries (host -> shadow tree). */
  function composedContains(ancestor: Element, node: Node | null): boolean {
    let current: Node | null = node;
    while (current) {
      if (current === ancestor) return true;
      const parent = (current as Node & { host?: Element }).parentNode ?? null;
      current =
        parent && parent.nodeType === 11 && (parent as ShadowRoot).host
          ? (parent as ShadowRoot).host
          : parent;
    }
    return false;
  }

  type InputResolutionMetadata = {
    strategy:
      | 'elementRef'
      | 'selector-first'
      | 'selector-ranked'
      | 'locator-first'
      | 'locator-ranked'
      | 'stale-recovery';
    candidateCount: number;
    evaluatedCount: number;
    scrolled: boolean;
    hitTest: 'target' | 'descendant' | 'none' | 'not-required';
    recovered: boolean;
    oldRef?: string;
    newRef?: string;
    matchedFields?: string[];
    confidenceBasis?: string;
    waitedMs?: number;
  };

  type ResolvedInputTarget = {
    element: Element;
    point: { x: number; y: number };
    resolution: InputResolutionMetadata;
  };

  function createInputError(
    code: string,
    message: string,
    details: Record<string, unknown>
  ): Error & { code: string; details: Record<string, unknown> } {
    return Object.assign(new Error(message), { code, details });
  }

  function assertInputActive(params: InputParams): void {
    if (typeof params.__bbxAssertActive === 'function') params.__bbxAssertActive();
  }

  function readComputedStyle(
    element: Element
  ):
    | CSSStyleDeclaration
    | { display: string; visibility: string; opacity: string; pointerEvents: string } {
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

  function inspectActionability(element: Element): {
    actionable: boolean;
    reasons: string[];
    inViewport: boolean;
    hitRequired: boolean;
    point: { x: number; y: number };
    hit: Element | null;
  } {
    const rect = element.getBoundingClientRect();
    const style = readComputedStyle(element);
    const reasons = [];
    const disabled =
      ('disabled' in element && Boolean((element as { disabled?: boolean }).disabled)) ||
      element.getAttribute('aria-disabled') === 'true';
    const inert =
      ('inert' in element && Boolean((element as { inert?: boolean }).inert)) ||
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

  function classifyHit(element: Element, hit: Element | null): 'target' | 'descendant' | 'none' {
    if (!hit) return 'none';
    if (hit === element) return 'target';
    if (typeof element.contains === 'function' && element.contains(hit)) return 'descendant';
    return composedContains(element, hit) ? 'descendant' : 'none';
  }

  function describeBlocker(element: Element): Record<string, string> {
    const description: Record<string, string> = { tag: element.tagName.toLowerCase() };
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

  /** Resolve one input target atomically, ranking at most 25 selector matches.
Explicit refs retain exact identity unless stale recovery is opted in. */
  function resolveActionableTarget(
    target: InputTargetSpec | undefined,
    options: { pointer: boolean; recoverStale: boolean }
  ): ResolvedInputTarget {
    const domQuery = getDomQueryModule();
    const usesLocator = !target?.elementRef && Boolean(domQuery?.isLocator(target));

    let element: Element;

    let resolution: InputResolutionMetadata;
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

      let allMatches: Element[];
      let hiddenMatches = 0;
      try {
        if (usesLocator && domQuery) {
          const located = domQuery.locateElements({ ...target } as Record<string, unknown>, {
            maxResults: MAX_INPUT_CANDIDATES + 1,
          });
          if (located.truncationReason && typeof target?.nth !== 'number') {
            throw createInputError(
              'RESULT_TRUNCATED',
              'Input scan was incomplete; uniqueness could not be proven. Use a narrower locator.',
              { reason: located.truncationReason, scanned: located.scanned }
            );
          }
          hiddenMatches = located.hiddenMatches;
          allMatches =
            typeof target?.nth === 'number'
              ? located.matches.slice(target.nth, target.nth + 1)
              : located.matches;
        } else {
          allMatches = querySelectorAllDeep(escapeTailwindSelector(String(target?.selector)));
        }
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'RESULT_TRUNCATED'
        )
          throw error;
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

  function getExecutionMetadata(mode: 'dom' | 'cdp', point: { x: number; y: number }) {
    return {
      requestedMode: mode,
      actualMode: mode,
      fallbackReason: null,
      debuggerUsed: mode === 'cdp',
      targetCoordinates: point,
    };
  }

  /** Recheck a nested control selected from an actionable wrapper. */
  function finalizeDerivedTarget(
    resolved: ResolvedInputTarget,
    element: Element
  ): ResolvedInputTarget {
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

  function getScrollableElementTarget(element: Element): HTMLElement {
    if (element instanceof HTMLElement) {
      return element;
    }
    if (document.scrollingElement instanceof HTMLElement) {
      return document.scrollingElement;
    }
    return document.documentElement;
  }

  /** Keep the target visible before dispatching interaction events. */
  function scrollTargetIntoView(element: Element): void {
    element.scrollIntoView({
      block: 'center',
      inline: 'center',
    });
  }

  /** Focus an element when the platform allows it. */
  function focusElement(element: Element): Element {
    if ('focus' in element && typeof element.focus === 'function') {
      element.focus({
        preventScroll: true,
      });
    }

    return document.activeElement instanceof Element ? document.activeElement : element;
  }

  const FOCUSABLE_SELECTOR =
    'a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"]';

  /** Apply the focus change of a real mouse press: focus the nearest focusable
ancestor, or blur the current field when the press lands on content that
cannot take focus. */
  function focusForPointerPress(element: Element): void {
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

  function isElementFocused(element: Element): boolean {
    return document.activeElement === element || element.contains(document.activeElement);
  }

  function getViewportPoint(element: Element): { x: number; y: number } {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }

  function normalizeMouseButton(value: unknown): 'left' | 'middle' | 'right' {
    return value === 'middle' || value === 'right' ? value : 'left';
  }

  function normalizeModifierState(value: unknown): {
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  } {
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

  function getMouseButtonState(button: 'left' | 'middle' | 'right'): {
    button: number;
    buttons: number;
  } {
    switch (button) {
      case 'middle':
        return { button: 1, buttons: 4 };
      case 'right':
        return { button: 2, buttons: 2 };
      default:
        return { button: 0, buttons: 1 };
    }
  }

  type ModifierState = { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };

  type MouseDispatchOptions = {
    modifiers: ModifierState;
    button?: number;
    buttons?: number;
    detail?: number;
    bubbles?: boolean;
    cancelable?: boolean;
    relatedTarget?: Element | null;
  };

  type PointerDispatchOptions = MouseDispatchOptions & {
    pointerId: number;
    pointerType: 'mouse' | 'touch';
    isPrimary: boolean;
    pressure?: number;
  };

  const MOUSE_POINTER: Readonly<{ pointerId: number; pointerType: 'mouse'; isPrimary: true }> =
    Object.freeze({ pointerId: 1, pointerType: 'mouse', isPrimary: true });
  const FIRST_TOUCH_POINTER_ID = 2;
  const NO_MODIFIERS = Object.freeze({
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  });

  /** Element under the virtual mouse after the last DOM pointer interaction.
Boundary events (over/enter/out/leave) are derived from it so repeated
interactions see the same transitions a real pointer would produce. */
  let pointerElement: Element | null = null;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normalizeHoldMs(value: unknown): number {
    return clamp(Number(value) || 0, 0, 10_000);
  }

  function isConnectedElement(element: Element): boolean {
    return isNodeAttached(element);
  }

  function containsNode(node: Element | null, other: Element | null): boolean {
    return Boolean(node && other && typeof node.contains === 'function' && node.contains(other));
  }

  function createMouseInit(
    point: { x: number; y: number },
    options: MouseDispatchOptions
  ): MouseEventInit {
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

  function dispatchMouseEvent(
    element: Element,
    type: string,
    point: { x: number; y: number },
    options: MouseDispatchOptions
  ): boolean {
    return element.dispatchEvent(new MouseEvent(type, createMouseInit(point, options)));
  }

  /** Dispatch a PointerEvent where the platform has one. Real input always
produces pointer events before their compatibility mouse/touch events, and
many applications listen only to pointer events. */
  function dispatchPointerEvent(
    element: Element,
    type: string,
    point: { x: number; y: number },
    options: PointerDispatchOptions
  ): boolean {
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

  /** Dispatch a click-family event the way Chrome does: as a PointerEvent
carrying the pointer type when available, otherwise as a MouseEvent.
Dispatching `click` runs the element's activation behavior (checkbox
toggles, link navigation, form submission) just like HTMLElement.click(),
while preserving coordinates, modifiers, and click count. */
  function dispatchClickEvent(
    element: Element,
    type: 'click' | 'auxclick' | 'contextmenu',
    point: { x: number; y: number },
    options: PointerDispatchOptions
  ): boolean {
    if (typeof PointerEvent === 'function') {
      return dispatchPointerEvent(element, type, point, options);
    }
    return dispatchMouseEvent(element, type, point, options);
  }

  /** Elements from `start` upward, stopping before the first ancestor that
contains `other`. These receive the non-bubbling enter/leave events. */
  function collectBoundaryChain(start: Element, other: Element | null): Element[] {
    const chain: Element[] = [];
    for (
      let node = start as Element | null;
      node && !containsNode(node, other);
      node = node.parentElement ?? null
    ) {
      chain.push(node);
    }
    return chain;
  }

  /** Move the virtual mouse onto an element: out/leave on the previous element,
over/enter on the new one, then pointermove/mousemove. */
  function movePointerTo(
    element: Element,
    point: { x: number; y: number },
    modifiers: ModifierState,
    options: { buttons?: number; pointerEvents?: boolean } = {}
  ): void {
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

  /** Press a mouse button: pointerdown, then mousedown unless the page canceled
pointerdown (which suppresses compatibility mouse events per the Pointer
Events spec). Focus is the default action of an uncanceled mousedown. */
  function pressMouseButton(
    element: Element,
    point: { x: number; y: number },
    button: 'left' | 'middle' | 'right',
    detail: number,
    modifiers: ModifierState
  ): { mouseEventsSuppressed: boolean; focusAllowed: boolean } {
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

  function releaseMouseButton(
    element: Element,
    point: { x: number; y: number },
    button: 'left' | 'middle' | 'right',
    detail: number,
    modifiers: ModifierState,
    mouseEventsSuppressed: boolean
  ): void {
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

  /** Pick the element that receives a release after a hold: the pressed
element while it is still attached, otherwise whatever is now under the
pointer. */
  function getReleaseTarget(element: Element, point: { x: number; y: number }): Element {
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

  function getKeyDefinition(key: string): { code: string; keyCode: number } {
    if (Object.hasOwn(KEY_DEFINITIONS, key)) {
      return KEY_DEFINITIONS[key as keyof typeof KEY_DEFINITIONS];
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

  function getEditableTarget(
    element: Element
  ): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
    if (isEditableElement(element)) {
      return element as HTMLInputElement | HTMLTextAreaElement | HTMLElement;
    }

    if (!(element instanceof HTMLElement)) {
      return null;
    }

    const editable = element.querySelector(
      "input, textarea, [contenteditable=''], [contenteditable='true']"
    );
    return editable && isEditableElement(editable)
      ? (editable as HTMLInputElement | HTMLTextAreaElement | HTMLElement)
      : null;
  }

  function isEditableElement(element: Element): boolean {
    if (element instanceof HTMLTextAreaElement) {
      return true;
    }

    if (element instanceof HTMLInputElement) {
      return !NON_TEXT_INPUT_TYPES.has(element.type.toLowerCase());
    }

    return element instanceof HTMLElement && element.isContentEditable;
  }

  function getEditableValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLElement): string {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value;
    }

    return element.innerText || element.textContent || '';
  }

  function getSelectedOptionValues(element: HTMLSelectElement): string[] {
    return [...element.selectedOptions].map((option) => option.value);
  }

  function areStringArraysEqual(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
      return false;
    }

    return left.every((value, index) => value === right[index]);
  }

  function clearEditableValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLElement): void {
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

  function runKeyAction(
    element: Element,
    key: string,
    modifiers: unknown
  ): { target: Element; key: string; handled: boolean } {
    const pressed = beginKeyAction(element, key, modifiers);
    endKeyAction(pressed);
    return { target: pressed.target, key: pressed.key, handled: pressed.handled };
  }

  type PressedKey = {
    target: Element;
    key: string;
    handled: boolean;
    modifierState: ModifierState;
  };

  /** Press a key: keydown, keypress for character keys, then the default
editing action. A canceled keydown suppresses both, as in real browsers. */
  function beginKeyAction(element: Element, key: string, modifiers: unknown): PressedKey {
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

  function endKeyAction(pressed: PressedKey): void {
    dispatchKeyboardEvent(pressed.target, 'keyup', pressed.key, pressed.modifierState);
  }

  function dispatchKeyboardEvent(
    element: Element,
    type: string,
    key: string,
    modifiers: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }
  ): boolean {
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

  function dispatchBeforeInputEvent(
    element: HTMLInputElement | HTMLTextAreaElement | HTMLElement,
    value: string,
    inputType: string
  ): boolean {
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

  function dispatchInputEvent(
    element: HTMLInputElement | HTMLTextAreaElement | HTMLElement,
    value: string,
    inputType: string
  ): boolean {
    return element.dispatchEvent(
      new InputEvent('input', {
        data: value,
        inputType,
        bubbles: true,
        composed: true,
      })
    );
  }

  function insertTextIntoEditable(
    element: HTMLInputElement | HTMLTextAreaElement | HTMLElement,
    value: string
  ): boolean {
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

  function deleteTextFromEditable(
    element: HTMLInputElement | HTMLTextAreaElement | HTMLElement,
    direction: 'backward' | 'forward'
  ): boolean {
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

  function handleEnterKey(element: Element): boolean {
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

  function submitElement(element: HTMLInputElement | HTMLTextAreaElement | HTMLElement): void {
    const form = element instanceof HTMLElement ? element.closest('form') : null;
    if (form) {
      form.requestSubmit();
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function resolveCheckableTarget(element: Element): HTMLInputElement {
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

  function resolveSelectTarget(element: Element): HTMLSelectElement {
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

  /** Trigger a click with the event sequence of a real mouse: boundary and move
events, then per click pointerdown/mousedown, focus, optional hold,
pointerup/mouseup, and a click/auxclick/contextmenu event, plus dblclick
for a double click. */
  async function clickTarget(params: InputParams): Promise<Record<string, unknown>> {
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
      if (typeof params.__bbxAssertActive === 'function') params.__bbxAssertActive();
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

  /** Focus one element so follow-up keyboard input lands consistently. */
  function focusTarget(params: InputParams): Record<string, unknown> {
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

  /** Type text into an editable control or contenteditable region. */
  function typeIntoTarget(params: InputParams): Record<string, unknown> {
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

  /** Replace a contenteditable's text through the editing pipeline
(`beforeinput`/`input` with inputType insertText), which rich editors such
as Lexical, ProseMirror, Slate, and Draft handle. Setting textContent
directly is ignored or reverted by them. */
  function replaceRichText(editable: HTMLElement, value: string): boolean {
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
      const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
      return normalize(editable.innerText ?? editable.textContent ?? '') === normalize(value);
    } catch {
      return false;
    }
  }

  function dispatchBlurSignals(element: Element): void {
    const FocusCtor = typeof FocusEvent === 'function' ? FocusEvent : Event;
    element.dispatchEvent(new FocusCtor('focusout', { bubbles: true }));
    element.dispatchEvent(new FocusCtor('blur', { bubbles: false }));
  }

  /** Set the value of an input/textarea/select element using the native value
setter, then dispatch input + change events. This works with React, Vue,
Angular, and vanilla forms - frameworks intercept these events at the
document level and sync their internal state.

mode:
  "setter" (default) - use Object.getOwnPropertyDescriptor prototype setter
  "keystrokes" - clear field + type each character (slower but handles
    custom components that don't respond to setter)
  "auto" - try setter first, verify value stuck, fallback to keystrokes */
  function fillTarget(params: InputParams): Record<string, unknown> {
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
          (editable as HTMLInputElement).value = value;
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

  /** Send one keyboard interaction to the currently focused or targeted element,
optionally holding the key down for holdMs before keyup. */
  async function pressKeyTarget(params: InputParams): Promise<Record<string, unknown>> {
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
            resolution: {
              strategy: 'elementRef',
              candidateCount: 1,
              evaluatedCount: 1,
              scrolled: false,
              hitTest: 'not-required',
              recovered: false,
            } as InputResolutionMetadata,
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
    assertInputActive(params);
    return {
      elementRef: result.target instanceof Element ? rememberElement(result.target) : null,
      key: result.key,
      handled: result.handled,
      ...(holdMs > 0 ? { holdMs } : {}),
      resolution: resolved.resolution,
      execution: getExecutionMetadata('dom', resolved.point),
    };
  }

  /** Toggle a checkbox-like control to a desired checked state. */
  function setCheckedTarget(params: InputParams): Record<string, unknown> {
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

  /** Select options in a native select control by value, label, or index. */
  function selectOptionTarget(params: InputParams): Record<string, unknown> {
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

  /** Trigger hover state on an element by dispatching mouse events. */
  function hoverTarget(
    params: InputParams
  ): Promise<Record<string, unknown>> | Record<string, unknown> {
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

  function isNativeDragSource(element: Element): boolean {
    if (element instanceof HTMLElement && element.draggable === true) return true;
    return typeof element.closest === 'function' && Boolean(element.closest('[draggable="true"]'));
  }

  function dispatchDragEvent(
    element: Element,
    type: string,
    point: { x: number; y: number },
    dataTransfer: DataTransfer
  ): boolean {
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

  function elementAtPoint(point: { x: number; y: number }, fallback: Element): Element {
    const hit = deepElementFromPoint(point.x, point.y);
    return hit ?? fallback;
  }

  /** Perform a drag between two elements. Sources the browser would drag
natively (draggable elements) get the HTML5 drag-and-drop sequence; all
other sources get a pointer drag (press, interpolated moves across the
elements under the pointer, release), which is what pointer-driven
sortable lists, sliders, and canvases listen for. */
  async function dragTarget(params: InputParams): Promise<Record<string, unknown>> {
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
      let currentPoint = sourcePoint;
      try {
        for (let step = 1; step <= steps; step += 1) {
          // Hidden documents throttle each timer to about a second. DOM drags
          // have no duration contract, so deliver the ordered moves without
          // frame pacing rather than timing out or activating the user's tab.
          if (!document.hidden) await sleep(16);
          assertInputActive(params);
          const progress = step / steps;
          const point = {
            x: sourcePoint.x + (endPoint.x - sourcePoint.x) * progress,
            y: sourcePoint.y + (endPoint.y - sourcePoint.y) * progress,
          };
          current = elementAtPoint(point, progress < 0.5 ? source : destination);
          currentPoint = point;
          movePointerTo(current, point, NO_MODIFIERS, { buttons: 1 });
        }
      } finally {
        releaseMouseButton(
          current,
          currentPoint,
          'left',
          1,
          NO_MODIFIERS,
          pressed.mouseEventsSuppressed
        );
      }
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

  type TouchContact = {
    identifier: number;
    element: Element;
    start: { x: number; y: number };
    end: { x: number; y: number } | null;
    current: { x: number; y: number };
  };

  /** Resolve one normalized touch position: an actionable target's center or
a viewport point and the element under it. */
  function resolveTouchPosition(
    position:
      | { target?: InputTargetSpec | null; x?: number | null; y?: number | null }
      | null
      | undefined,
    recoverStale: boolean
  ): { element: Element; point: { x: number; y: number } } {
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

  function touchPointerOptions(
    contact: TouchContact,
    pressure: number,
    buttons: number
  ): PointerDispatchOptions {
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

  function createTouch(contact: TouchContact): Touch {
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

  /** Dispatch a TouchEvent for one changed contact. Pages without Touch support
receive only the pointer events. */
  function dispatchTouchEvent(
    changed: TouchContact,
    type: 'touchstart' | 'touchmove' | 'touchend',
    active: TouchContact[]
  ): boolean {
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

  /** Put one or more fingers down at the same time, optionally move them, hold
for holdMs, and lift them. Each finger is a separate touch pointer, so
chords and multi-finger gestures reach pointer and touch listeners alike.
A single-finger tap also produces compatibility mouse events and a click. */
  async function touchTarget(params: InputParams): Promise<Record<string, unknown>> {
    const recoverStale = params.recoverStale === true;
    const points = Array.isArray(params.points) ? params.points : [];
    if (!points.length) {
      throw createInputError(
        'INVALID_REQUEST',
        'points must contain at least one touch point.',
        {}
      );
    }

    const contacts: TouchContact[] = points.map((point, index) => {
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

    const active: TouchContact[] = [];
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

    try {
      if (moving) {
        for (let step = 1; step <= moveSteps; step += 1) {
          await sleep(holdMs / moveSteps);
          assertInputActive(params);
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
    } finally {
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
    }
    assertInputActive(params);

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

  /** Resolve and validate a target immediately before debugger-backed input.
This helper performs no click, typing, value setting, or drag mutation. */
  async function prepareNativeInput(params: InputParams): Promise<{
    elementRef: string;
    point: { x: number; y: number };
    resolution: InputResolutionMetadata;
    tag: string;
    value?: string;
  }> {
    const assertActive = () => assertInputActive(params);
    assertActive();
    const target =
      params.target && typeof params.target === 'object'
        ? (params.target as InputTargetSpec)
        : undefined;
    const { resolved: base, waitedMs } = await awaitActionableTarget(target, {
      pointer: params.kind === 'pointer',
      recoverStale: params.recoverStale === true,
      timeoutMs: clamp(Number(params.timeoutMs) || 0, 0, 15_000),
      assertActive,
    });
    assertActive();
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

  /** Verify exact editable identity and focus without attempting to restore it. */
  function revalidateNativeInput(params: Record<string, unknown>): {
    elementRef: string;
    active: true;
  } {
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

  /** Read a post-dispatch editable value without replaying a mutation. */
  function readInputValue(params: Record<string, unknown>): { elementRef: string; value: string } {
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

  /** Scroll an element into the visible viewport. */
  function scrollIntoViewTarget(params: InputParams): {
    elementRef: string;
    scrolled: boolean;
  } {
    const element = resolveTarget(params.target);
    scrollTargetIntoView(element);
    return { elementRef: rememberElement(element), scrolled: true };
  }

  /** Probe visible viewport points instead of scanning every DOM node. Only
large, exposed, CSS-scrollable ancestors qualify as implicit targets. */
  function findScrollContainers(axis: 'x' | 'y'): {
    elements: HTMLElement[];
    ambiguous: boolean;
    truncated: boolean;
  } {
    if (typeof getComputedStyle !== 'function')
      return { elements: [], ambiguous: false, truncated: false };
    const root = document.scrollingElement || document.documentElement;
    const extent =
      axis === 'y' ? root.scrollHeight - root.clientHeight : root.scrollWidth - root.clientWidth;
    const rootStyle = getComputedStyle(document.documentElement);
    const bodyStyle = document.body ? getComputedStyle(document.body) : rootStyle;
    const overflow = axis === 'y' ? 'overflowY' : 'overflowX';
    // Body overflow propagates to the viewport only while root overflow is visible.
    const documentOverflow =
      rootStyle[overflow] === 'visible' ? bodyStyle[overflow] : rootStyle[overflow];
    if (extent > 1 && documentOverflow !== 'hidden' && documentOverflow !== 'clip') {
      return { elements: [], ambiguous: false, truncated: false };
    }

    const candidates: Map<HTMLElement, { area: number; hits: number }> = new Map();
    let truncated = false;
    const viewportArea = window.innerWidth * window.innerHeight;
    if (!viewportArea) return { elements: [], ambiguous: false, truncated };
    for (const x of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      for (const y of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        let element = deepElementFromPoint(x * window.innerWidth, y * window.innerHeight);
        let depth = 0;
        for (; element && depth < 64; depth += 1) {
          if (element instanceof HTMLElement && element !== root && element !== document.body) {
            const known = candidates.get(element);
            if (known) known.hits += 1;
            const range =
              axis === 'y'
                ? element.scrollHeight - element.clientHeight
                : element.scrollWidth - element.clientWidth;
            if (
              !known &&
              range > 1 &&
              element.clientHeight >= 100 &&
              element.clientWidth >= 100 &&
              isElementVisible(element)
            ) {
              const style = getComputedStyle(element);
              if (
                style[overflow] === 'auto' ||
                style[overflow] === 'scroll' ||
                style[overflow] === 'overlay'
              ) {
                const rect = element.getBoundingClientRect();
                const width = Math.max(
                  0,
                  Math.min(rect.right, window.innerWidth) - Math.max(0, rect.left)
                );
                const height = Math.max(
                  0,
                  Math.min(rect.bottom, window.innerHeight) - Math.max(0, rect.top)
                );
                const area = width * height;
                if (area >= viewportArea * 0.1) candidates.set(element, { area, hits: 1 });
              }
            }
          }
          const parent = element.parentElement;
          const tree = element.getRootNode?.();
          element =
            parent ||
            (typeof ShadowRoot !== 'undefined' && tree instanceof ShadowRoot ? tree.host : null);
        }
        if (element) truncated = true;
      }
    }
    const ranked = [...candidates]
      .map(([element, candidate]) => ({
        element,
        area: Math.min(candidate.area, (viewportArea * candidate.hits) / 25),
      }))
      .sort((left, right) => right.area - left.area);
    const ambiguous = truncated || (ranked.length > 1 && ranked[0].area < ranked[1].area * 1.8);
    return {
      elements: ranked.slice(0, 5).map(({ element }) => element),
      ambiguous,
      truncated: truncated || ranked.length > 5,
    };
  }

  function describeScrollContainer(
    element: HTMLElement
  ): import('../../../protocol/src/types.js').ScrollContainerInfo {
    return {
      elementRef: rememberElement(element),
      tag: element.tagName.toLowerCase(),
      x: element.scrollLeft,
      y: element.scrollTop,
      maxX: Math.max(0, element.scrollWidth - element.clientWidth),
      maxY: Math.max(0, element.scrollHeight - element.clientHeight),
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
    };
  }

  function getScrollContainerDetection(
    axis?: 'x' | 'y'
  ): import('../../../protocol/src/types.js').ScrollContainerDetection {
    let detection = findScrollContainers(axis ?? 'y');
    const root = document.scrollingElement || document.documentElement;
    if (
      axis === undefined &&
      !detection.elements.length &&
      !detection.ambiguous &&
      root.scrollHeight <= root.clientHeight + 1
    )
      detection = findScrollContainers('x');
    if (!detection.elements.length)
      return detection.truncated ? { ambiguous: true, candidates: [], truncated: true } : {};
    if (detection.ambiguous) {
      return {
        ambiguous: true,
        candidates: detection.elements.map(describeScrollContainer),
        truncated: detection.truncated,
      };
    }
    return { container: describeScrollContainer(detection.elements[0]) };
  }

  /** Scroll the window or a specific scrollable element. */
  function scrollViewport(params: Record<string, unknown>): {
    scrolled: boolean;
    target: string;
    x: number;
    y: number;
    top: number;
    left: number;
    behavior: 'auto' | 'smooth';
    relative: boolean;
    autoDetected?: boolean;
  } {
    const top = Number(params.top) || 0;
    const left = Number(params.left) || 0;
    const behavior = params.behavior === 'smooth' ? 'smooth' : 'auto';
    const relative = Boolean(params.relative);

    const target =
      params.target && typeof params.target === 'object'
        ? (params.target as { elementRef?: string; selector?: string })
        : undefined;
    const detection =
      target?.elementRef || target?.selector
        ? {}
        : getScrollContainerDetection(left !== 0 && top === 0 ? 'x' : 'y');
    if (detection.ambiguous) {
      throw createInputError(
        'ELEMENT_AMBIGUOUS',
        'Multiple scroll containers are plausible. Set target.elementRef to one of the reported candidates.',
        { ...detection }
      );
    }
    if (target?.elementRef || target?.selector || detection.container) {
      const element = resolveTarget(
        target?.elementRef || target?.selector
          ? target
          : { elementRef: detection.container?.elementRef }
      );
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
        ...(detection.container ? { autoDetected: true } : {}),
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

  /** Compact locator description for error details. */
  function describeLocator(target: InputTargetSpec | undefined): Record<string, unknown> {
    const described: Record<string, unknown> = {};
    for (const key of ['role', 'name', 'text', 'label', 'placeholder', 'testId', 'selector']) {
      const value = target?.[key as keyof InputTargetSpec];
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

  /** Resolve after the next DOM mutation (plus a frame) or the delay. */
  function waitForDomActivity(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;

      let observer: MutationObserver | null = null;
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

  /** Whether a running CSS/Web animation may still be moving the element. */
  function hasRunningAnimation(element: Element): boolean {
    if (typeof document.getAnimations !== 'function') return false;
    for (const animation of document.getAnimations()) {
      if (animation.playState !== 'running') continue;
      const animated = (animation.effect as KeyframeEffect | null)?.target;
      if (animated && (animated === element || composedContains(animated, element))) return true;
    }
    return false;
  }

  /** Wait until the target exists, is actionable, and is not mid-animation, up
to `timeoutMs`. Saves agents a separate wait call plus a retry round trip. */
  async function awaitActionableTarget(
    target: InputTargetSpec | undefined,
    options: {
      pointer: boolean;
      recoverStale: boolean;
      timeoutMs: number;
      assertActive?: () => void;
    }
  ): Promise<{ resolved: ResolvedInputTarget; waitedMs: number }> {
    const start = Date.now();
    const deadline = start + Math.max(0, options.timeoutMs);
    for (;;) {
      options.assertActive?.();
      try {
        const resolved = resolveActionableTarget(target, options);
        if (hasRunningAnimation(resolved.element) && Date.now() < deadline) {
          const before = resolved.element.getBoundingClientRect();
          await sleep(STABILITY_SAMPLE_MS);
          options.assertActive?.();
          const after = resolved.element.getBoundingClientRect();
          if (before.x !== after.x || before.y !== after.y || before.width !== after.width) {
            continue;
          }
        }
        return { resolved, waitedMs: Date.now() - start };
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        if (typeof code !== 'string' || !RETRYABLE_WAIT_CODES.has(code) || Date.now() >= deadline) {
          const details = (error as { details?: Record<string, unknown> })?.details;
          if (details && typeof details === 'object' && Date.now() > start) {
            details.waitedMs = Date.now() - start;
          }
          throw error;
        }
      }
      await waitForDomActivity(Math.min(WAIT_POLL_MS, deadline - Date.now()));
    }
  }

  /** Active element, following focus into shadow roots. */
  function deepActiveElement(): Element | null {
    let active = document.activeElement;
    for (let depth = 0; active && depth < 32; depth += 1) {
      const inner = getShadowRoot(active)?.activeElement ?? null;
      if (!inner) break;
      active = inner;
    }
    return active;
  }

  function visibleDialogs(): Element[] {
    return querySelectorAllDeep(DIALOG_SELECTOR).filter((element) => isElementVisible(element));
  }

  function describeEffectElement(element: Element): { role: string; name?: string; ref: string } {
    const name = getAccessibleName(element).slice(0, 120);
    return {
      role: getElementRoles(element)[0] ?? element.tagName.toLowerCase(),
      ...(name ? { name } : {}),
      ref: rememberElement(element),
    };
  }

  /** Post-action state of the acted-on element, limited to fields it has. */
  function describeTargetState(element: Element | null): Record<string, unknown> | null {
    if (!element) return null;
    if (!isNodeAttached(element)) return { removed: true };

    const state: Record<string, unknown> = {};
    const editable = getEditableTarget(element);
    if (editable) state.value = getEditableValue(editable).slice(0, 200);
    const control = element as { checked?: unknown; type?: unknown };
    if (element.tagName === 'INPUT' && (control.type === 'checkbox' || control.type === 'radio')) {
      state.checked = Boolean(control.checked);
    }
    for (const attribute of ['aria-checked', 'aria-expanded', 'aria-pressed', 'aria-selected']) {
      const value = element.getAttribute(attribute);
      if (value !== null)
        state[attribute.slice(5)] = value === 'true' ? true : value === 'false' ? false : value;
    }
    if (
      ('disabled' in element && Boolean((element as { disabled?: unknown }).disabled)) ||
      element.getAttribute('aria-disabled') === 'true'
    ) {
      state.disabled = true;
    }
    return Object.keys(state).length ? state : null;
  }

  function closestLiveRegion(node: Node): Element | null {
    const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
    return element && typeof element.closest === 'function'
      ? element.closest(LIVE_REGION_SELECTOR)
      : null;
  }

  /** Record what an action changes: same-document URL changes, unloads, new
dialogs, live-region/alert messages, focus moves, DOM churn, and the
target's own state. Lets agents skip a follow-up read after most actions. */
  function startObservation(): {
    finish: (options: {
      settleMs: number;
      element: Element | null;
    }) => Promise<Record<string, unknown>>;
  } {
    const startedAt = Date.now();
    const startUrl = location.href;
    const startTitle = document.title;
    const startActive = deepActiveElement();
    const startDialogs = new Set(visibleDialogs());
    let added = 0;
    let removed = 0;
    let lastMutationAt = startedAt;
    let unloading = false;
    let notifyUnload = () => {};
    const unloadSignal = new Promise<void>((resolve) => {
      notifyUnload = resolve;
    });

    const messageRegions: Set<Element> = new Set();

    const collectNotable = (node: Node) => {
      if (node.nodeType !== 1) return;
      const element = node as Element;
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
      notifyUnload();
    };
    globalThis.addEventListener?.('pagehide', onUnload);
    globalThis.addEventListener?.('beforeunload', onUnload);

    return {
      async finish({ settleMs, element }) {
        const deadline = startedAt + settleMs;
        // Chrome can freeze this document's timers and close its message port
        // on navigation. Finish before that happens instead of waiting to settle.
        await Promise.race([sleep(Math.min(50, settleMs)), unloadSignal]);
        while (
          !unloading &&
          Date.now() < deadline &&
          Date.now() - lastMutationAt < OBSERVE_QUIET_MS
        ) {
          await Promise.race([
            sleep(Math.min(50, Math.max(0, deadline - Date.now()))),
            unloadSignal,
          ]);
        }
        observer?.disconnect();
        globalThis.removeEventListener?.('pagehide', onUnload);
        globalThis.removeEventListener?.('beforeunload', onUnload);

        const effects: Record<string, unknown> = {};
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
  const INPUT_TARGET_KEYS = {
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
  } as Record<string, Array<[string, boolean]>>;

  function hasTargetSpec(value: unknown): value is InputTargetSpec {
    if (!value || typeof value !== 'object') return false;
    const spec = value as InputTargetSpec;
    return Boolean(spec.elementRef || spec.selector || getDomQueryModule()?.isLocator(spec));
  }

  /** Run one input method with auto-wait for its targets and optional effect
observation. Targets are pre-resolved (waiting as needed) and handed to the
action as exact refs, so the action itself stays synchronous and atomic. */
  function withInputPipeline(
    method: string,
    action: (params: InputParams) => Record<string, unknown> | Promise<Record<string, unknown>>
  ): (params: InputParams) => Promise<Record<string, unknown>> {
    return async (params) => {
      const assertActive =
        typeof params.__bbxAssertActive === 'function'
          ? (params.__bbxAssertActive as () => void)
          : () => {};
      assertActive();
      const timeoutMs = clamp(Number(params.timeoutMs) || 0, 0, 15_000);
      const recoverStale = params.recoverStale === true;

      const prepared: InputParams = { ...params };

      const preResolutions: Record<
        string,
        { resolution: InputResolutionMetadata; waitedMs: number }
      > = {};

      let primaryElement: Element | null = null;
      for (const [key, pointer] of INPUT_TARGET_KEYS[method] ?? []) {
        const spec = params[key];
        if (!hasTargetSpec(spec)) continue;
        const { resolved, waitedMs } = await awaitActionableTarget(spec, {
          pointer,
          recoverStale,
          timeoutMs,
          assertActive,
        });
        prepared[key] = { elementRef: rememberElement(resolved.element) };
        preResolutions[key] = { resolution: resolved.resolution, waitedMs };
        primaryElement ??= resolved.element;
      }
      if (Object.keys(preResolutions).length) prepared.recoverStale = false;

      const observeOptions = params.observe as { settleMs?: unknown } | null | undefined;
      const observation = observeOptions ? startObservation() : null;
      assertActive();
      const result = await action(prepared);
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

  /** Keep the original strategy (selector/locator/stale recovery) in the
reported resolution even though the action ran on an exact ref. */
  function mergePreResolution(
    result: Record<string, unknown>,
    preResolutions: Record<string, { resolution: InputResolutionMetadata; waitedMs: number }>
  ): void {
    const primary = preResolutions.target ?? preResolutions.source;
    if (primary && result.resolution && typeof result.resolution === 'object') {
      const actionResolution = result.resolution as InputResolutionMetadata;
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
        const record = reported as Record<string, unknown>;
        if (record.resolution && typeof record.resolution === 'object') {
          record.resolution = {
            ...pre.resolution,
            hitTest: (record.resolution as InputResolutionMetadata).hitTest,
            ...(pre.waitedMs > 0 ? { waitedMs: pre.waitedMs } : {}),
          };
        }
      }
    }
  }

  /** Whether a target likely needs trusted (debugger) input because browsers
gate the behavior on user activation or rich editors ignore synthetic
key events. Read-only: resolves without waiting or mutating. */
  function getTrustHint(params: Record<string, unknown>): {
    needsTrusted: boolean;
    reason: string | null;
  } {
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
      (getEditableTarget(element) ?? (element as HTMLElement)).isContentEditable
    ) {
      return { needsTrusted: true, reason: 'rich-text-editor' };
    }
    return { needsTrusted: false, reason: null };
  }

  const pendingObservations: Map<string, ReturnType<typeof startObservation>> = new Map();
  let observationCounter = 0;

  /** Begin observing for a debugger-dispatched (CDP) input action. */
  function beginNativeObservation(): { observationId: string } {
    observationCounter += 1;
    const observationId = `obs_${observationCounter}`;
    pendingObservations.set(observationId, startObservation());
    if (pendingObservations.size > 8) {
      const oldest = pendingObservations.keys().next().value;
      if (oldest !== undefined) pendingObservations.delete(oldest);
    }
    return { observationId };
  }

  /** Finish a CDP-mode observation and report its effects. */
  async function finishNativeObservation(
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const observationId = String(params.observationId ?? '');
    const observation = pendingObservations.get(observationId);
    pendingObservations.delete(observationId);
    if (!observation) return { changed: false, expired: true };

    let element: Element | null = null;
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
    getScrollContainerDetection,
    scrollViewport,
    selectOptionTarget: withInputPipeline('input.select_option', selectOptionTarget),
    setCheckedTarget: withInputPipeline('input.set_checked', setCheckedTarget),
    touchTarget,
    typeIntoTarget: withInputPipeline('input.type', typeIntoTarget),
  });
})();
