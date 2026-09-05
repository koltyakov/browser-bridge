// @ts-check

(() => {
  const globalState =
    /** @type {typeof globalThis & { __BBX_CONTENT_PATCH__?: Record<string, unknown> }} */ (
      globalThis
    );

  if (globalState.__BBX_CONTENT_PATCH__) {
    return;
  }

  const contentHelpers =
    /** @type {typeof globalThis & { __BBX_CONTENT_HELPERS__?: Record<string, unknown> }} */ (
      globalThis
    ).__BBX_CONTENT_HELPERS__;
  const registry =
    /** @type {typeof globalThis & { __BBX_CONTENT_REGISTRY__?: {
      rememberElement: (element: Element) => string,
      createContentId: (prefix: string) => string,
      getPatchRegistry: () => Map<string, StoredPatch>,
      getMaxPatchRegistrySize: () => number,
      resolveTarget: (target?: { elementRef?: string, selector?: string }) => Element
    } }} */ (globalThis).__BBX_CONTENT_REGISTRY__;
  if (!contentHelpers || !registry) {
    throw new Error('Browser Bridge helpers and registry must load before content-patch.js.');
  }

  const {
    rememberElement,
    createContentId,
    getPatchRegistry,
    getMaxPatchRegistrySize,
    resolveTarget,
  } = registry;

  /** @typedef {{ elementRef?: string, selector?: string }} PatchTarget */
  /** @typedef {{ target?: PatchTarget, patchId?: string, declarations?: Record<string, string>, important?: boolean, verify?: boolean }} StylePatchParams */
  /** @typedef {{ target?: PatchTarget, patchId?: string, operation?: string, name?: string | null, value?: unknown, verify?: boolean }} DomPatchParams */
  /** @typedef {{ value: string, priority: string }} StyleValue */
  /** @typedef {{ kind: 'style', element: Element, elementRef: string, previous: Map<string, StyleValue>, shorthands: Map<string, StyleValue & { longhands: string[] }> }} StoredStylePatch */
  /** @typedef {{ kind: 'dom', element: Element, elementRef: string, operation: string, previous: { children: Node[] | null, attributes: Record<string, string | null>, toggledClass: string | null, hadClass: boolean | null, changed: boolean | null } }} StoredDomPatch */
  /** @typedef {StoredStylePatch | StoredDomPatch} StoredPatch */

  /**
   * @param {string} patchId
   * @returns {void}
   */
  function rejectDuplicatePatchId(patchId) {
    if (getPatchRegistry().has(patchId)) {
      throw new Error(`Patch ID ${patchId} is already active.`);
    }
  }

  /** @returns {void} */
  function assertPatchRegistryCapacity() {
    if (getPatchRegistry().size >= getMaxPatchRegistrySize()) {
      throw new Error(
        'Patch registry is full. Roll back or commit active patches before applying more.'
      );
    }
  }

  /**
   * Apply a reversible inline style patch to an element or selector target.
   *
   * @param {StylePatchParams} params
   * @returns {{ patchId: string, applied: boolean, verified?: Record<string, string>, elementRef?: string }}
   */
  function applyStylePatch(params) {
    const element = /** @type {HTMLElement} */ (resolveTarget(params.target));
    const patchId =
      typeof params.patchId === 'string' && params.patchId
        ? params.patchId
        : createContentId('patch');
    rejectDuplicatePatchId(patchId);
    assertPatchRegistryCapacity();
    /** @type {Map<string, StyleValue>} */
    const previous = new Map();
    const declarations = Object.entries(params.declarations || {});
    const probe = document.createElement('div').style;
    // CSSOM expands shorthands into their affected longhands, including reset-only
    // properties such as border-image. Capture everything before the first write.
    for (const [property] of declarations) {
      probe.cssText = '';
      probe.setProperty(property, 'initial');
      for (let index = 0; index < probe.length; index += 1) {
        const longhand = probe[index];
        previous.set(longhand, {
          value: element.style.getPropertyValue(longhand),
          priority: element.style.getPropertyPriority(longhand),
        });
      }
    }
    /** @type {Set<string>} */
    const pending = new Set();
    for (let index = 0; index < element.style.length; index += 1) {
      const property = element.style[index];
      if (previous.has(property) && !element.style.getPropertyValue(property))
        pending.add(property);
    }
    /** @type {StoredStylePatch['shorthands']} */
    const shorthands = new Map();
    if (pending.size) {
      // A var() shorthand can have present but unserializable longhands. Recover
      // candidate declaration names from cssText, then let CSSOM validate them.
      for (const match of element.style.cssText.matchAll(/(?:^|;)\s*([-\w]+)\s*:/g)) {
        const property = match[1];
        const value = element.style.getPropertyValue(property);
        if (!value) continue;
        probe.cssText = '';
        probe.setProperty(property, 'initial');
        const longhands = Array.from(probe);
        if (!longhands.some((name) => pending.has(name))) continue;
        shorthands.set(property, {
          value,
          priority: element.style.getPropertyPriority(property),
          longhands,
        });
        for (const name of longhands) pending.delete(name);
      }
      if (pending.size) {
        throw new Error(
          'Cannot reversibly patch pending-substitution longhands without their original shorthand.'
        );
      }
    }
    for (const [property, value] of declarations) {
      element.style.setProperty(property, value, params.important ? 'important' : '');
    }
    const elementRef = rememberElement(element);
    getPatchRegistry().set(patchId, {
      kind: 'style',
      element,
      elementRef,
      previous,
      shorthands,
    });
    const result = { patchId, applied: true };
    if (params.verify) {
      const computed = globalThis.getComputedStyle(element);
      /** @type {Record<string, string>} */
      const verified = {};
      for (const property of Object.keys(params.declarations || {})) {
        verified[property] = computed.getPropertyValue(property);
      }
      return { ...result, verified, elementRef };
    }
    return result;
  }

  /**
   * @param {DomPatchParams} params
   * @returns {string}
   */
  function getClassPatchValue(params) {
    const className = String(params.value ?? params.name ?? '');
    if (!className) {
      throw new Error('class name is required for class patch operations');
    }
    return className;
  }

  /**
   * Apply a reversible DOM patch to a target element.
   *
   * @param {DomPatchParams} params
   * @returns {{ patchId: string, applied: boolean, verified?: Record<string, unknown>, elementRef?: string }}
   */
  function applyDomPatch(params) {
    const element = resolveTarget(params.target);
    const patchId =
      typeof params.patchId === 'string' && params.patchId
        ? params.patchId
        : createContentId('patch');
    rejectDuplicatePatchId(patchId);
    assertPatchRegistryCapacity();
    const operation = typeof params.operation === 'string' ? params.operation : '';
    const name = typeof params.name === 'string' ? params.name : '';

    /** @type {StoredDomPatch['previous']} */
    const previous = {
      children: null,
      attributes: {},
      toggledClass: null,
      hadClass: null,
      changed: null,
    };

    switch (operation) {
      case 'set_text':
        previous.children = Array.from(element.childNodes);
        element.textContent = String(params.value ?? '');
        break;
      case 'set_attribute':
        previous.attributes[name] = element.getAttribute(name);
        element.setAttribute(name, String(params.value ?? ''));
        break;
      case 'remove_attribute':
        previous.attributes[name] = element.getAttribute(name);
        element.removeAttribute(name);
        break;
      case 'toggle_class': {
        const className = getClassPatchValue(params);
        previous.toggledClass = className;
        previous.hadClass = element.classList.contains(className);
        previous.changed = true;
        element.classList.toggle(className);
        break;
      }
      case 'add_class':
      case 'remove_class': {
        const className = getClassPatchValue(params);
        previous.toggledClass = className;
        previous.hadClass = element.classList.contains(className);
        const shouldHaveClass = operation === 'add_class';
        const changed = previous.hadClass !== shouldHaveClass;
        previous.changed = changed;
        if (changed) {
          element.classList.toggle(className);
        }
        break;
      }
      default:
        throw new Error(`Unsupported DOM patch operation ${operation}`);
    }

    const elementRef = rememberElement(element);
    getPatchRegistry().set(patchId, {
      kind: 'dom',
      element,
      elementRef,
      operation,
      previous,
    });
    const result = { patchId, applied: true };
    if (params.verify) {
      /** @type {Record<string, unknown>} */
      const verified = {};
      if (operation === 'set_text') {
        verified.textContent = element.textContent;
      } else if (operation === 'set_attribute' || operation === 'remove_attribute') {
        verified[name] = element.getAttribute(name);
      } else if (
        operation === 'toggle_class' ||
        operation === 'add_class' ||
        operation === 'remove_class'
      ) {
        verified.classList = [...element.classList];
      }
      return { ...result, verified, elementRef };
    }
    return result;
  }

  /**
   * List currently active reversible patches.
   *
   * @returns {Array<{ patchId: string, kind: string, elementRef: string }>}
   */
  function listPatches() {
    return [...getPatchRegistry().entries()].map(([patchId, patch]) => ({
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
    const patchRegistry = getPatchRegistry();
    const patch = patchRegistry.get(patchId);
    if (!patch) {
      return { patchId, rolledBack: false };
    }

    const element = patch.element;
    if (patch.kind === 'style') {
      const htmlElement = /** @type {HTMLElement} */ (element);
      const present = new Set(Array.from(htmlElement.style));
      /** @type {Map<string, StyleValue>} */
      const unaffected = new Map();
      /** @type {Set<string>} */
      const restored = new Set();
      for (const shorthand of patch.shorthands.values()) {
        for (const property of shorthand.longhands) {
          restored.add(property);
          if (patch.previous.has(property)) continue;
          const value = htmlElement.style.getPropertyValue(property);
          // Empty, present siblings still carry the original pending substitution.
          if (value || !present.has(property)) {
            unaffected.set(property, {
              value,
              priority: htmlElement.style.getPropertyPriority(property),
            });
          }
        }
      }
      for (const [property, shorthand] of patch.shorthands) {
        htmlElement.style.setProperty(property, shorthand.value, shorthand.priority);
      }
      for (const [property, previous] of patch.previous) {
        if (previous.value) {
          htmlElement.style.setProperty(property, previous.value, previous.priority);
        } else if (!restored.has(property)) {
          htmlElement.style.removeProperty(property);
        }
      }
      for (const [property, current] of unaffected) {
        if (current.value) htmlElement.style.setProperty(property, current.value, current.priority);
        else htmlElement.style.removeProperty(property);
      }
    } else if (patch.kind === 'dom') {
      if (patch.operation === 'set_text' && patch.previous.children !== null) {
        element.replaceChildren();
        for (const child of patch.previous.children) element.appendChild(child);
      } else if (
        (patch.operation === 'toggle_class' ||
          patch.operation === 'add_class' ||
          patch.operation === 'remove_class') &&
        patch.previous.toggledClass
      ) {
        const shouldRollbackClassPatch =
          patch.operation === 'toggle_class' || patch.previous.changed !== false;
        if (shouldRollbackClassPatch) {
          const hasNow = element.classList.contains(patch.previous.toggledClass);
          if (hasNow !== patch.previous.hadClass) {
            element.classList.toggle(patch.previous.toggledClass);
          }
        }
      } else {
        for (const [name, value] of Object.entries(patch.previous.attributes || {})) {
          if (value == null) {
            element.removeAttribute(name);
          } else {
            element.setAttribute(name, value);
          }
        }
      }
    }

    patchRegistry.delete(patchId);
    return { patchId, rolledBack: true };
  }

  /**
   * Keep current DOM changes while discarding their rollback history.
   *
   * @returns {{ committed: true }}
   */
  function commitSessionBaseline() {
    getPatchRegistry().clear();
    return { committed: true };
  }

  globalState.__BBX_CONTENT_PATCH__ = Object.freeze({
    applyDomPatch,
    applyStylePatch,
    commitSessionBaseline,
    listPatches,
    rollbackPatch,
  });
})();
