(() => {
  const globalState = globalThis as typeof globalThis & {
    __BBX_CONTENT_REGISTRY__?: Record<string, unknown>;
  };

  if (globalState.__BBX_CONTENT_REGISTRY__) {
    return;
  }

  const contentHelpers = (
    globalThis as typeof globalThis & {
      __BBX_CONTENT_HELPERS__?: {
        escapeTailwindSelector: (selector: string) => string;
        applyBudget: (options?: Record<string, unknown>) => Budget;
        clamp: (value: unknown, minimum: number, maximum: number) => number;
        pruneElementRegistryEntries: (options: {
          registry: Map<string, Element>;
          reverseRegistry: WeakMap<Element, string>;
          iterator: IterableIterator<[string, Element]> | null;
          containsElement: (element: Element) => boolean;
          batchSize: number;
        }) => { iterator: IterableIterator<[string, Element]> | null; pruned: boolean };
        isNodeAttached?: (node: Node | null | undefined) => boolean;
        querySelectorAllDeep?: (selector: string, root?: ParentNode) => Element[];
        querySelectorDeep?: (selector: string, root?: ParentNode) => Element | null;
      };
    }
  ).__BBX_CONTENT_HELPERS__;
  if (!contentHelpers) {
    throw new Error(
      'Browser Bridge content-script helpers must load before content-element-registry.js.'
    );
  }

  const { escapeTailwindSelector, applyBudget, pruneElementRegistryEntries } = contentHelpers;
  /** Attachment check that also holds for elements inside shadow roots. */
  const isAttached =
    contentHelpers.isNodeAttached ??
    ((node: Node | null | undefined) => Boolean(node) && document.contains(node as Node));
  const queryAllDeep =
    contentHelpers.querySelectorAllDeep ??
    ((selector: string) => [...document.querySelectorAll(selector)]);
  const queryDeep =
    contentHelpers.querySelectorDeep ?? ((selector: string) => document.querySelector(selector));

  /**
   * Short per-injection tag so refs stay compact (≈4 tokens instead of a
   * UUID's ≈20) while refs minted by an earlier document or injection never
   * resolve here and correctly read as stale.
   */
  const REF_DOCUMENT_TAG = createRefTag();
  let elementRefCounter = 0;

  function createRefTag(): string {
    const bytes = new Uint8Array(4);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => (byte % 36).toString(36)).join('');
  }

  function createElementRef(): string {
    elementRefCounter += 1;
    return `el_${REF_DOCUMENT_TAG}_${elementRefCounter.toString(36)}`;
  }

  type Budget = {
    maxNodes: number;
    maxDepth: number;
    textBudget: number;
    includeBbox: boolean;
    attributeAllowlist: string[];
  };

  type NormalizedDomQuery = {
    selector: string;
    withinRef: string | null;
    budget: Budget;
  };

  const elementRegistry = new Map<string, Element>();
  const reverseRegistry = new WeakMap<Element, string>();

  const elementDescriptors: Map<string, ElementDescriptor> = new Map();
  const patchRegistry = new Map<string, import('./content-types.js').StoredPatch>();
  const MAX_REGISTRY_SIZE = 5000;
  const ELEMENT_REGISTRY_PRUNE_BATCH_SIZE = 100;
  const MAX_STALE_RECOVERY_CANDIDATES = 100;
  const MAX_PATCH_REGISTRY_SIZE = 2000;
  let registryPruned = false;

  let elementRegistryPruneIterator: IterableIterator<[string, Element]> | null = null;

  type ElementDescriptor = {
    url: string;
    tag: string;
    id: string;
    testId: string;
    role: string;
    name: string;
    label: string;
    href: string;
    type: string;
    ancestry: string[];
  };

  /** Generate an ID in content scripts, including insecure HTTP pages where
crypto.randomUUID() is unavailable. */
  function createContentId(prefix: string): string {
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

  function getRegistrySize(): number {
    return elementRegistry.size;
  }

  /** Atomically read and clear the pruned flag. */
  function consumePruned(): boolean {
    const pruned = registryPruned;
    registryPruned = false;
    return pruned;
  }

  /** Resolve an existing element reference and verify it is still attached. */
  function getRequiredElement(elementRef: string): Element {
    const element = elementRegistry.get(elementRef);
    if (!element) {
      throw new Error('Element reference is stale.');
    }
    if (!isAttached(element)) {
      elementRegistry.delete(elementRef);
      reverseRegistry.delete(element);
      throw new Error('Element reference is stale.');
    }
    return element;
  }

  /** Reuse or create a stable element reference for later bridge calls.
Uses a reverse WeakMap for O(1) lookup instead of scanning the registry. */
  function rememberElement(element: Element): string {
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
    const elementRef = createElementRef();
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

  function evictOldestElementRegistryEntry(): void {
    const first = elementRegistry.entries().next();
    if (first.done) return;
    const [elementRef, element] = first.value;
    elementRegistry.delete(elementRef);
    reverseRegistry.delete(element);
    elementDescriptors.delete(elementRef);
    registryPruned = true;
  }

  /** Keep semantic identity data small and independent of application DOM. */
  function describeElementIdentity(element: Element): ElementDescriptor {
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

  function getElementLabelText(element: Element): string {
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
      const labels = (element as { labels?: Iterable<Element> }).labels;
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

  function getAncestryMarker(element: Element): string {
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

  /** Fingerprint the complete normalized value. The descriptor retains only
length and two independent 32-bit hashes, never the source value. */
  function fingerprintDescriptorValue(value: string | null | undefined): string {
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

  function getCurrentDocumentUrl(): string {
    return fingerprintDescriptorValue(document.URL || globalThis.location?.href || '');
  }

  /** Resolve an explicit ref without changing its identity unless strict,
same-document recovery was explicitly requested. */
  function resolveInputReference(
    elementRef: string,
    recoverStale: boolean
  ): {
    element: Element;
    recovery: null | {
      oldRef: string;
      newRef: string;
      matchedFields: string[];
      confidenceBasis: string;
    };
  } {
    const current = elementRegistry.get(elementRef);
    if (current && isAttached(current)) {
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
          recoveryAttempted: true,
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
          recoveryAttempted: true,
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
          recoveryAttempted: true,
          reason: 'weak_descriptor',
        }
      );
    }
    const candidateNodes = queryAllDeep(descriptor.tag);
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
          recoveryAttempted: true,
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
          recoveryAttempted: true,
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

  function getStrongDescriptorFields(descriptor: ElementDescriptor): string[] {
    if (descriptor.testId) return ['testId'];
    if (descriptor.id) return ['id'];
    if (descriptor.role && descriptor.name) return ['role', 'name'];
    if (descriptor.label) return ['label', 'tag', ...(descriptor.type ? ['type'] : [])];
    if (descriptor.href && (descriptor.role || descriptor.name)) {
      return ['href', ...(descriptor.role ? ['role'] : []), ...(descriptor.name ? ['name'] : [])];
    }
    return [];
  }

  function descriptorMatches(element: Element, descriptor: ElementDescriptor): boolean {
    const current = describeElementIdentity(element);
    const fields = getStrongDescriptorFields(descriptor);
    return (
      fields.length > 0 &&
      fields.every(
        (field) =>
          current[field as keyof ElementDescriptor] === descriptor[field as keyof ElementDescriptor]
      ) &&
      (!descriptor.ancestry.length ||
        descriptor.ancestry.every((marker, index) => current.ancestry[index] === marker))
    );
  }

  function createRegistryError(
    code: string,
    message: string,
    details: Record<string, unknown>
  ): Error & { code: string; details: Record<string, unknown> } {
    return Object.assign(new Error(message), { code, details });
  }

  /** Remove a small batch of entries for elements no longer in the document so
pruning work is amortized across calls instead of scanning the full
registry at once. */
  function pruneElementRegistry(): void {
    const result = pruneElementRegistryEntries({
      registry: elementRegistry,
      reverseRegistry,
      iterator: elementRegistryPruneIterator,
      containsElement: (element) => isAttached(element),
      batchSize: ELEMENT_REGISTRY_PRUNE_BATCH_SIZE,
    });
    elementRegistryPruneIterator = result.iterator;
    if (result.pruned) {
      registryPruned = true;
    }
  }

  function pruneRegistry(registry: Map<unknown, unknown>, maxSize: number): void {
    if (registry.size < maxSize) return;
    const excess = registry.size - maxSize + 1;
    let count = 0;
    for (const key of registry.keys()) {
      if (count >= excess) break;
      registry.delete(key);
      count++;
    }
  }

  /** Resolve a patch target from either an element reference or a selector. */
  function resolveTarget(target: { elementRef?: string; selector?: string } = {}): Element {
    if (target.elementRef) {
      return getRequiredElement(target.elementRef);
    }
    if (target.selector) {
      const element = queryDeep(escapeTailwindSelector(target.selector));
      if (element) {
        return element;
      }
      throw createRegistryError('ELEMENT_NOT_FOUND', 'No element matched the target selector.', {
        selector: target.selector,
      });
    }
    // Semantic locators resolve only for input methods; say how to get a ref
    // instead of reporting the target as missing.
    const locator = ['role', 'name', 'text', 'label', 'placeholder', 'testId'].some(
      (key) => key in target
    );
    throw createRegistryError(
      'INVALID_REQUEST',
      locator
        ? 'This method takes target.elementRef or target.selector. Find role, name, text, or label targets with dom.find_by_role or dom.find_by_text, then pass the returned elementRef.'
        : 'target.elementRef or target.selector is required.',
      {}
    );
  }

  /** Resolve element-level read params from either a legacy top-level
`elementRef` or the newer `target` alias. */
  function resolveElementRefFromParams(
    params: { elementRef?: string; target?: { elementRef?: string; selector?: string } } = {}
  ): string {
    if (typeof params.elementRef === 'string' && params.elementRef) {
      return params.elementRef;
    }
    if (params.target && typeof params.target === 'object') {
      return rememberElement(resolveTarget(params.target));
    }
    throw createRegistryError(
      'INVALID_REQUEST',
      'elementRef or target is required. Pass a selector as target.selector.',
      {}
    );
  }

  let documentRevision = 0;
  let revisionObserver: MutationObserver | null = null;
  if (typeof MutationObserver === 'function' && document.documentElement) {
    try {
      revisionObserver = new MutationObserver(() => {
        documentRevision++;
      });
      revisionObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    } catch {
      revisionObserver = null;
    }
  }
  /** Mutation revisions avoid copying the entire body's text on every read. */
  function getDocumentRevision(): number {
    if (revisionObserver?.takeRecords().length) documentRevision++;
    return documentRevision;
  }

  /** Normalize DOM query parameters. */
  function normalizeDomQuery(params: Record<string, unknown> = {}): NormalizedDomQuery {
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
    refDocumentTag: REF_DOCUMENT_TAG,
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
