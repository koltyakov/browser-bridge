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
  /** @type {Map<string, ElementDescriptor>} */
  const elementDescriptors = new Map();
  const patchRegistry = new Map();
  const MAX_REGISTRY_SIZE = 5000;
  const ELEMENT_REGISTRY_PRUNE_BATCH_SIZE = 100;
  const MAX_STALE_RECOVERY_CANDIDATES = 100;
  const MAX_PATCH_REGISTRY_SIZE = 2000;
  let registryPruned = false;
  /** @type {IterableIterator<[string, Element]> | null} */
  let elementRegistryPruneIterator = null;

  /**
   * @typedef {{
   *   url: string,
   *   tag: string,
   *   id: string,
   *   testId: string,
   *   role: string,
   *   name: string,
   *   label: string,
   *   href: string,
   *   type: string,
   *   ancestry: string[]
   * }} ElementDescriptor
   */

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
    elementDescriptors.set(elementRef, describeElementIdentity(element));
    while (elementDescriptors.size > MAX_REGISTRY_SIZE) {
      const oldestDescriptor = elementDescriptors.keys().next();
      if (oldestDescriptor.done) break;
      elementDescriptors.delete(oldestDescriptor.value);
    }
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
    elementDescriptors.delete(elementRef);
    registryPruned = true;
  }

  /**
   * Keep semantic identity data small and independent of application DOM.
   *
   * @param {Element} element
   * @returns {ElementDescriptor}
   */
  function describeElementIdentity(element) {
    const labelText = getElementLabelText(element);
    const name = fingerprintDescriptorValue(
      element.getAttribute('aria-label') || element.getAttribute('title') || labelText
    );
    const ancestry = [];
    let parent = element.parentElement;
    while (parent && ancestry.length < 3) {
      const marker = getAncestryMarker(parent);
      if (marker) ancestry.push(marker);
      parent = parent.parentElement;
    }
    return {
      url: getCurrentDocumentUrl(),
      tag: element.tagName.toLowerCase(),
      id: fingerprintDescriptorValue(element.id || element.getAttribute('id')),
      testId: fingerprintDescriptorValue(
        element.getAttribute('data-testid') ||
          element.getAttribute('data-test') ||
          element.getAttribute('data-cy')
      ),
      role: fingerprintDescriptorValue(element.getAttribute('role')),
      name,
      label: fingerprintDescriptorValue(labelText),
      href: fingerprintDescriptorValue(element.getAttribute('href')),
      type: fingerprintDescriptorValue(element.getAttribute('type')),
      ancestry,
    };
  }

  /** @param {Element} element @returns {string} */
  function getElementLabelText(element) {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labels = labelledBy
        .split(/\s+/)
        .slice(0, 3)
        .map((id) => document.getElementById?.(id)?.textContent?.trim() || '')
        .filter(Boolean)
        .join(' ');
      if (labels) return labels;
    }
    if ('labels' in element) {
      const labels = /** @type {{ labels?: Iterable<Element> }} */ (element).labels;
      if (labels) {
        return [...labels]
          .slice(0, 3)
          .map((item) => item.textContent?.trim() || '')
          .filter(Boolean)
          .join(' ');
      }
    }
    return '';
  }

  /** @param {Element} element @returns {string} */
  function getAncestryMarker(element) {
    const testId =
      element.getAttribute('data-testid') ||
      element.getAttribute('data-test') ||
      element.getAttribute('data-cy');
    const id = element.id || element.getAttribute('id');
    if (testId) {
      return `${element.tagName.toLowerCase()}:testid:${fingerprintDescriptorValue(testId)}`;
    }
    if (id) return `${element.tagName.toLowerCase()}:id:${fingerprintDescriptorValue(id)}`;
    const role = element.getAttribute('role');
    return role ? `${element.tagName.toLowerCase()}:role:${fingerprintDescriptorValue(role)}` : '';
  }

  /**
   * Fingerprint the complete normalized value. The descriptor retains only
   * length and two independent 32-bit hashes, never the source value.
   *
   * @param {string | null | undefined} value
   * @returns {string}
   */
  function fingerprintDescriptorValue(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return '';
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < normalized.length; index += 1) {
      const code = normalized.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193) >>> 0;
      second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
    }
    return `${normalized.length}:${first.toString(16).padStart(8, '0')}${second
      .toString(16)
      .padStart(8, '0')}`;
  }

  /** @returns {string} */
  function getCurrentDocumentUrl() {
    return fingerprintDescriptorValue(document.URL || globalThis.location?.href || '');
  }

  /**
   * Resolve an explicit ref without changing its identity unless strict,
   * same-document recovery was explicitly requested.
   *
   * @param {string} elementRef
   * @param {boolean} recoverStale
   * @returns {{ element: Element, recovery: null | { oldRef: string, newRef: string, matchedFields: string[], confidenceBasis: string } }}
   */
  function resolveInputReference(elementRef, recoverStale) {
    const current = elementRegistry.get(elementRef);
    if (current && document.contains(current)) {
      return { element: current, recovery: null };
    }
    if (current) {
      elementRegistry.delete(elementRef);
      reverseRegistry.delete(current);
    }
    if (!recoverStale) {
      throw createRegistryError('ELEMENT_STALE', 'Element reference is stale.', {
        elementRef,
        recovered: false,
      });
    }

    const descriptor = elementDescriptors.get(elementRef);
    if (!descriptor) {
      throw createRegistryError(
        'ELEMENT_STALE',
        'Element reference is stale and has no recovery descriptor.',
        {
          elementRef,
          recovered: false,
          reason: 'descriptor_missing',
        }
      );
    }
    if (!descriptor.url || descriptor.url !== getCurrentDocumentUrl()) {
      throw createRegistryError(
        'ELEMENT_STALE',
        'Stale reference recovery requires the same URL.',
        {
          elementRef,
          recovered: false,
          reason: 'url_changed',
        }
      );
    }

    const strongFields = getStrongDescriptorFields(descriptor);
    if (!strongFields.length) {
      throw createRegistryError(
        'ELEMENT_STALE',
        'Stale reference descriptor is not strong enough.',
        {
          elementRef,
          recovered: false,
          reason: 'weak_descriptor',
        }
      );
    }
    const candidateNodes = document.querySelectorAll(descriptor.tag);
    const evaluatedCount = Math.min(candidateNodes.length, MAX_STALE_RECOVERY_CANDIDATES);
    const candidates = [];
    for (let index = 0; index < evaluatedCount; index += 1) {
      candidates.push(candidateNodes[index]);
    }
    const matches = candidates.filter((candidate) => descriptorMatches(candidate, descriptor));
    if (candidateNodes.length > evaluatedCount) {
      throw createRegistryError(
        'ELEMENT_AMBIGUOUS',
        'Stale reference recovery scan was incomplete; uniqueness could not be proven.',
        {
          elementRef,
          recovered: false,
          reason: 'scan_incomplete',
          candidateCount: candidateNodes.length,
          evaluatedCount,
          matchCount: matches.length,
          matchedFields: strongFields,
        }
      );
    }
    if (matches.length !== 1) {
      const code = matches.length > 1 ? 'ELEMENT_AMBIGUOUS' : 'ELEMENT_STALE';
      throw createRegistryError(
        code,
        matches.length > 1
          ? 'Stale reference recovery matched multiple elements.'
          : 'No element uniquely matched the stale reference descriptor.',
        {
          elementRef,
          recovered: false,
          candidateCount: matches.length,
          evaluatedCount,
          matchedFields: strongFields,
        }
      );
    }

    const newRef = rememberElement(matches[0]);
    return {
      element: matches[0],
      recovery: {
        oldRef: elementRef,
        newRef,
        matchedFields: strongFields,
        confidenceBasis: strongFields.join('+'),
      },
    };
  }

  /** @param {ElementDescriptor} descriptor @returns {string[]} */
  function getStrongDescriptorFields(descriptor) {
    if (descriptor.testId) return ['testId'];
    if (descriptor.id) return ['id'];
    if (descriptor.role && descriptor.name) return ['role', 'name'];
    if (descriptor.label) return ['label', 'tag', ...(descriptor.type ? ['type'] : [])];
    if (descriptor.href && (descriptor.role || descriptor.name)) {
      return ['href', ...(descriptor.role ? ['role'] : []), ...(descriptor.name ? ['name'] : [])];
    }
    return [];
  }

  /** @param {Element} element @param {ElementDescriptor} descriptor @returns {boolean} */
  function descriptorMatches(element, descriptor) {
    const current = describeElementIdentity(element);
    const fields = getStrongDescriptorFields(descriptor);
    return (
      fields.length > 0 &&
      fields.every(
        (field) =>
          current[/** @type {keyof ElementDescriptor} */ (field)] ===
          descriptor[/** @type {keyof ElementDescriptor} */ (field)]
      ) &&
      (!descriptor.ancestry.length ||
        descriptor.ancestry.every((marker, index) => current.ancestry[index] === marker))
    );
  }

  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} details
   * @returns {Error & { code: string, details: Record<string, unknown> }}
   */
  function createRegistryError(code, message, details) {
    return Object.assign(new Error(message), { code, details });
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
      const element = document.querySelector(escapeTailwindSelector(target.selector));
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
    const nestedBudget =
      params.budget && typeof params.budget === 'object' ? params.budget : undefined;
    return {
      selector: escapeTailwindSelector(rawSelector),
      withinRef: typeof params.withinRef === 'string' ? params.withinRef : null,
      budget: applyBudget({ ...nestedBudget, ...params }),
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
    resolveInputReference,
    resolveElementRefFromParams,
    resolveTarget,
  });
})();
