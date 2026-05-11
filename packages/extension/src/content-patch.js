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
     getRequiredElement: (ref: string) => Element,
     rememberElement: (element: Element) => string,
     getPatchRegistry: () => Map<string, any>,
     getMaxPatchRegistrySize: () => number,
     pruneRegistry: (registry: Map<any, any>, maxSize: number) => void,
     resolveTarget: (target?: { elementRef?: string, selector?: string }) => Element
    } }} */ (globalThis).__BBX_CONTENT_REGISTRY__;
  if (!contentHelpers || !registry) {
    throw new Error('Browser Bridge helpers and registry must load before content-patch.js.');
  }

  const {
    getRequiredElement,
    rememberElement,
    getPatchRegistry,
    getMaxPatchRegistrySize,
    pruneRegistry,
    resolveTarget,
  } = registry;

  /** @typedef {{ elementRef?: string, selector?: string }} PatchTarget */
  /** @typedef {{ target?: PatchTarget, patchId?: string, declarations?: Record<string, string>, important?: boolean, verify?: boolean }} StylePatchParams */
  /** @typedef {{ target?: PatchTarget, patchId?: string, operation?: string, name?: string | null, value?: unknown, verify?: boolean }} DomPatchParams */

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
        : `patch_${crypto.randomUUID()}`;
    /** @type {Record<string, string>} */
    const previous = {};
    for (const [property, value] of Object.entries(params.declarations || {})) {
      previous[property] = element.style.getPropertyValue(property);
      element.style.setProperty(property, value, params.important ? 'important' : '');
    }
    pruneRegistry(getPatchRegistry(), getMaxPatchRegistrySize());
    const elementRef = rememberElement(element);
    getPatchRegistry().set(patchId, {
      kind: 'style',
      elementRef,
      previous,
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
        : `patch_${crypto.randomUUID()}`;
    const operation = typeof params.operation === 'string' ? params.operation : '';
    const name = typeof params.name === 'string' ? params.name : '';

    /** @type {{ text: string | null, attributes: Record<string, string | null>, toggledClass: string | null, hadClass: boolean | null, changed: boolean | null }} */
    const previous = {
      text: null,
      attributes: {},
      toggledClass: null,
      hadClass: null,
      changed: null,
    };

    switch (operation) {
      case 'set_text':
        previous.text = element.textContent;
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
        const className = String(params.value);
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

    pruneRegistry(getPatchRegistry(), getMaxPatchRegistrySize());
    const elementRef = rememberElement(element);
    getPatchRegistry().set(patchId, {
      kind: 'dom',
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

    const element = getRequiredElement(patch.elementRef);
    if (patch.kind === 'style') {
      const htmlElement = /** @type {HTMLElement} */ (element);
      for (const [property, value] of Object.entries(patch.previous)) {
        if (value) {
          htmlElement.style.setProperty(property, value);
        } else {
          htmlElement.style.removeProperty(property);
        }
      }
    } else if (patch.kind === 'dom') {
      if (patch.operation === 'set_text' && patch.previous.text !== null) {
        element.textContent = patch.previous.text;
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
        if (patch.previous.text !== null && patch.operation === 'set_text') {
          element.textContent = patch.previous.text;
        }
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

  globalState.__BBX_CONTENT_PATCH__ = Object.freeze({
    applyDomPatch,
    applyStylePatch,
    listPatches,
    rollbackPatch,
  });
})();
