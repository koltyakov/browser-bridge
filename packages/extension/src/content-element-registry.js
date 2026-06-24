// @ts-check

(() => {
  const globalState =
    /** @type {typeof globalThis & { __BBX_CONTENT_REGISTRY__?: Record<string, unknown> }} */ (
      globalThis
    );

  if (globalState.__BBX_CONTENT_REGISTRY__) {
    return;
  }

  const contentHelpers =
    /** @type {typeof globalThis & { __BBX_CONTENT_HELPERS__?: {
     escapeTailwindSelector: (selector: string) => string,
     applyBudget: (options?: Record<string, any>) => Budget,
     clamp: (value: number | string | null | undefined, minimum: number, maximum: number) => number,
     pruneElementRegistryEntries: (options: {
      registry: Map<string, Element>,
      reverseRegistry: WeakMap<Element, string>,
      iterator: IterableIterator<[string, Element]> | null,
      containsElement: (element: Element) => boolean,
      batchSize: number
    }) => { iterator: IterableIterator<[string, Element]> | null, pruned: boolean }
    } }} */ (globalThis).__BBX_CONTENT_HELPERS__;
  if (!contentHelpers) {
    throw new Error(
      'Browser Bridge content-script helpers must load before content-element-registry.js.'
    );
  }

  const { escapeTailwindSelector, applyBudget, pruneElementRegistryEntries } = contentHelpers;

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

  const elementRegistry = new Map();
  const reverseRegistry = new WeakMap();
  const patchRegistry = new Map();
  const MAX_REGISTRY_SIZE = 5000;
  const ELEMENT_REGISTRY_PRUNE_BATCH_SIZE = 100;
  const MAX_PATCH_REGISTRY_SIZE = 2000;
  let registryPruned = false;
  /** @type {IterableIterator<[string, Element]> | null} */
  let elementRegistryPruneIterator = null;

  /**
   * Generate an ID in content scripts, including insecure HTTP pages where
   * crypto.randomUUID() is unavailable.
   *
   * @param {string} prefix
   * @returns {string}
   */
  function createContentId(prefix) {
    const webCrypto = globalThis.crypto;
    if (typeof webCrypto?.randomUUID === 'function') {
      return `${prefix}_${webCrypto.randomUUID()}`;
    }
    const bytes = new Uint8Array(16);
    webCrypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
    return `${prefix}_${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
      .slice(6, 8)
      .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
  }

  /**
   * @returns {number}
   */
  function getRegistrySize() {
    return elementRegistry.size;
  }

  /**
   * Atomically read and clear the pruned flag.
   *
   * @returns {boolean}
   */
  function consumePruned() {
    const pruned = registryPruned;
    registryPruned = false;
    return pruned;
  }

  /**
   * Resolve an existing element reference and verify it is still attached.
   *
   * @param {string} elementRef
   * @returns {Element}
   */
  function getRequiredElement(elementRef) {
    const element = elementRegistry.get(elementRef);
    if (!element) {
      throw new Error('Element reference is stale.');
    }
    if (!document.contains(element)) {
      elementRegistry.delete(elementRef);
      reverseRegistry.delete(element);
      throw new Error('Element reference is stale.');
    }
    return element;
  }

  /**
   * Reuse or create a stable element reference for later bridge calls.
   * Uses a reverse WeakMap for O(1) lookup instead of scanning the registry.
   *
   * @param {Element} element
   * @returns {string}
   */
  function rememberElement(element) {
    const existing = reverseRegistry.get(element);
    if (existing && elementRegistry.has(existing)) {
      return existing;
    }
    if (elementRegistry.size >= MAX_REGISTRY_SIZE) {
      pruneElementRegistry();
    }
    while (elementRegistry.size >= MAX_REGISTRY_SIZE) {
      evictOldestElementRegistryEntry();
    }
    const elementRef = createContentId('el');
    elementRegistry.set(elementRef, element);
    reverseRegistry.set(element, elementRef);
    return elementRef;
  }

  /**
   * @returns {void}
   */
  function evictOldestElementRegistryEntry() {
    const first = elementRegistry.entries().next();
    if (first.done) return;
    const [elementRef, element] = first.value;
    elementRegistry.delete(elementRef);
    reverseRegistry.delete(element);
    registryPruned = true;
  }

  /**
   * Remove a small batch of entries for elements no longer in the document so
   * pruning work is amortized across calls instead of scanning the full
   * registry at once.
   *
   * @returns {void}
   */
  function pruneElementRegistry() {
    const result = pruneElementRegistryEntries({
      registry: elementRegistry,
      reverseRegistry,
      iterator: elementRegistryPruneIterator,
      containsElement: (element) => document.contains(element),
      batchSize: ELEMENT_REGISTRY_PRUNE_BATCH_SIZE,
    });
    elementRegistryPruneIterator = result.iterator;
    if (result.pruned) {
      registryPruned = true;
    }
  }

  /**
   * @param {Map<any, any>} registry
   * @param {number} maxSize
   * @returns {void}
   */
  function pruneRegistry(registry, maxSize) {
    if (registry.size < maxSize) return;
    const excess = registry.size - maxSize + 1;
    let count = 0;
    for (const key of registry.keys()) {
      if (count >= excess) break;
      registry.delete(key);
      count++;
    }
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
    throw new Error('Target not found.');
  }

  /**
   * Resolve element-level read params from either a legacy top-level
   * `elementRef` or the newer `target` alias.
   *
   * @param {{ elementRef?: string, target?: { elementRef?: string, selector?: string } }} [params={}]
   * @returns {string}
   */
  function resolveElementRefFromParams(params = {}) {
    if (typeof params.elementRef === 'string' && params.elementRef) {
      return params.elementRef;
    }
    if (params.target && typeof params.target === 'object') {
      return rememberElement(resolveTarget(params.target));
    }
    throw new Error('Element target not found.');
  }

  /**
   * Return a cheap document revision marker for change detection.
   *
   * @returns {number}
   */
  function getDocumentRevision() {
    return (document.body?.textContent || '').length;
  }

  /**
   * Normalize DOM query parameters.
   *
   * @param {Record<string, any>} [params={}]
   * @returns {NormalizedDomQuery}
   */
  function normalizeDomQuery(params = {}) {
    const rawSelector =
      typeof params.selector === 'string' && params.selector.trim() ? params.selector : 'body';
    return {
      selector: escapeTailwindSelector(rawSelector),
      withinRef: typeof params.withinRef === 'string' ? params.withinRef : null,
      budget: applyBudget(params),
    };
  }

  globalState.__BBX_CONTENT_REGISTRY__ = Object.freeze({
    consumePruned,
    getDocumentRevision,
    createContentId,
    getPatchRegistry: () => patchRegistry,
    getMaxPatchRegistrySize: () => MAX_PATCH_REGISTRY_SIZE,
    getRegistrySize,
    getRequiredElement,
    normalizeDomQuery,
    pruneRegistry,
    rememberElement,
    resolveElementRefFromParams,
    resolveTarget,
  });
})();
