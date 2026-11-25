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
        querySelectorAllDeepNative?: (selector: string, root?: ParentNode) => Element[];
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
  const queryAllDeepNative = contentHelpers.querySelectorAllDeepNative ?? queryAllDeep;

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

  /** Ref -> element map that does not keep removed DOM alive. A detached
  subtree referenced only by old refs can be collected; its refs then read as
  stale, which they already were. Engines without WeakRef keep strong refs. */
  class WeakElementMap {
    readonly #entries = new Map<string, WeakRef<Element> | Element>();
    readonly #finalizer =
      typeof FinalizationRegistry === 'function'
        ? new FinalizationRegistry<string>((ref) => {
            const held = this.#entries.get(ref);
            if (held && this.#deref(held) === undefined) this.#entries.delete(ref);
          })
        : null;

    #deref(held: WeakRef<Element> | Element): Element | undefined {
      return typeof WeakRef === 'function' && held instanceof WeakRef
        ? held.deref()
        : (held as Element);
    }

    get size(): number {
      return this.#entries.size;
    }

    get(ref: string): Element | undefined {
      const held = this.#entries.get(ref);
      if (!held) return undefined;
      const element = this.#deref(held);
      if (!element) this.#entries.delete(ref);
      return element;
    }

    has(ref: string): boolean {
      return this.get(ref) !== undefined;
    }

    set(ref: string, element: Element): this {
      this.#entries.set(ref, typeof WeakRef === 'function' ? new WeakRef(element) : element);
      this.#finalizer?.register(element, ref);
      return this;
    }

    delete(ref: string): boolean {
      return this.#entries.delete(ref);
    }

    *entries(): IterableIterator<[string, Element]> {
      for (const [ref, held] of this.#entries) {
        const element = this.#deref(held);
        if (element) yield [ref, element];
        else this.#entries.delete(ref);
      }
    }
  }

  const elementRegistry = new WeakElementMap();
  const reverseRegistry = new WeakMap<Element, string>();

  const elementDescriptors: Map<string, ElementDescriptor> = new Map();
  const patchRegistry = new Map<string, import('./content-types.js').StoredPatch>();
  const MAX_REGISTRY_SIZE = 5000;
  const ELEMENT_REGISTRY_PRUNE_BATCH_SIZE = 100;
  /** Candidates compared during stale recovery. Candidates are pre-filtered by
the attribute behind the strongest descriptor field, so this bounds work on
pages with thousands of same-tag elements rather than typical pages. */
  const MAX_STALE_RECOVERY_CANDIDATES = 5000;
  /** Stale recovery fails fast instead of consuming the action's timeout. */
  const STALE_RECOVERY_TIME_MS = 3000;
  const MAX_PATCH_REGISTRY_SIZE = 2000;
  let registryPruned = false;
  /** Counts prunes without being consumed, so a retained outline snapshot can
  tell whether any of its refs may have been dropped since it was taken. */
  let pruneEpoch = 0;

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
  function rememberElement(element: Element, retain = false): string {
    const existing = reverseRegistry.get(element);
    if (existing && elementRegistry.has(existing)) {
      if (retain) {
        elementRegistry.delete(existing);
        elementRegistry.set(existing, element);
        const descriptor = elementDescriptors.get(existing);
        if (descriptor) {
          elementDescriptors.delete(existing);
          elementDescriptors.set(existing, descriptor);
        }
      }
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
    pruneEpoch += 1;
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

  let cachedDocumentUrl: string | null = null;
  let cachedDocumentUrlFingerprint = '';

  /** URL fingerprint, recomputed only when the URL changes (SPA navigation). */
  function getCurrentDocumentUrl(): string {
    const url = document.URL || globalThis.location?.href || '';
    if (url !== cachedDocumentUrl) {
      cachedDocumentUrl = url;
      cachedDocumentUrlFingerprint = fingerprintDescriptorValue(url);
    }
    return cachedDocumentUrlFingerprint;
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
    let candidateNodes: Element[];
    try {
      candidateNodes = queryAllDeepNative(getRecoveryCandidateSelector(descriptor, strongFields));
    } catch {
      candidateNodes = [];
    }
    const started = Date.now();
    let evaluatedCount = 0;
    const matches: Element[] = [];
    for (const candidate of candidateNodes) {
      if (evaluatedCount >= MAX_STALE_RECOVERY_CANDIDATES) break;
      if (evaluatedCount % 64 === 0 && Date.now() - started > STALE_RECOVERY_TIME_MS) break;
      evaluatedCount += 1;
      if (descriptorMatches(candidate, descriptor, strongFields)) {
        matches.push(candidate);
        // Two matches already prove ambiguity.
        if (matches.length > 1) break;
      }
    }
    if (matches.length < 2 && candidateNodes.length > evaluatedCount) {
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

  /** Attribute selector that every element matching the strong fields has,
so recovery does not compare every same-tag element on large pages. */
  function getRecoveryCandidateSelector(descriptor: ElementDescriptor, fields: string[]): string {
    const tag = /^[a-z][a-z0-9-]*$/i.test(descriptor.tag) ? descriptor.tag : '*';
    const withAttributes = (attributes: string[]) =>
      attributes.map((attribute) => `${tag}[${attribute}]`).join(', ');
    if (fields[0] === 'testId') return withAttributes(['data-testid', 'data-test', 'data-cy']);
    if (fields[0] === 'id') return withAttributes(['id']);
    if (fields[0] === 'href') return withAttributes(['href']);
    if (fields[0] === 'role') return withAttributes(['role']);
    return tag;
  }

  /** Compute one identity field without building the whole descriptor. */
  function readDescriptorField(element: Element, field: string): string {
    switch (field) {
      case 'testId':
        return fingerprintDescriptorValue(
          element.getAttribute('data-testid') ||
            element.getAttribute('data-test') ||
            element.getAttribute('data-cy')
        );
      case 'id':
        return fingerprintDescriptorValue(element.id || element.getAttribute('id'));
      case 'role':
        return fingerprintDescriptorValue(element.getAttribute('role'));
      case 'href':
        return fingerprintDescriptorValue(element.getAttribute('href'));
      case 'type':
        return fingerprintDescriptorValue(element.getAttribute('type'));
      case 'tag':
        return element.tagName.toLowerCase();
      case 'label':
        return fingerprintDescriptorValue(getElementLabelText(element));
      case 'name':
        return fingerprintDescriptorValue(
          element.getAttribute('aria-label') ||
            element.getAttribute('title') ||
            getElementLabelText(element)
        );
      default:
        return '';
    }
  }

  function descriptorMatches(
    element: Element,
    descriptor: ElementDescriptor,
    fields: string[] = getStrongDescriptorFields(descriptor)
  ): boolean {
    if (!fields.length || element.tagName.toLowerCase() !== descriptor.tag) return false;
    if (
      !fields.every(
        (field) =>
          readDescriptorField(element, field) === descriptor[field as keyof ElementDescriptor]
      )
    ) {
      return false;
    }
    if (!descriptor.ancestry.length) return true;
    const ancestry: string[] = [];
    let parent = element.parentElement;
    while (parent && ancestry.length < 3) {
      const marker = getAncestryMarker(parent);
      if (marker) ancestry.push(marker);
      parent = parent.parentElement;
    }
    return descriptor.ancestry.every((marker, index) => ancestry[index] === marker);
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
      registry: elementRegistry as unknown as Map<string, Element>,
      reverseRegistry,
      iterator: elementRegistryPruneIterator,
      containsElement: (element) => isAttached(element),
      batchSize: ELEMENT_REGISTRY_PRUNE_BATCH_SIZE,
    });
    elementRegistryPruneIterator = result.iterator;
    if (result.pruned) {
      registryPruned = true;
      pruneEpoch += 1;
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

  const LOCATOR_KEYS = ['role', 'name', 'text', 'label', 'placeholder', 'testId'];

  type LocatorModule = {
    locateElements: (
      locator: Record<string, unknown>,
      options?: { maxResults?: number }
    ) => { matches: Element[]; hiddenMatches: number };
  };

  /** Resolve a semantic read target to its single visible match. */
  function resolveLocatorTarget(target: Record<string, unknown>): Element {
    const domQuery = Reflect.get(globalThis, '__BBX_CONTENT_DOM_QUERY__') as
      | LocatorModule
      | undefined;
    if (typeof domQuery?.locateElements !== 'function') {
      throw createRegistryError(
        'INVALID_REQUEST',
        'Semantic targets are unavailable in this frame. Pass target.selector or target.elementRef.',
        {}
      );
    }
    const nth = typeof target.nth === 'number' ? target.nth : null;
    const located = domQuery.locateElements(target, { maxResults: nth === null ? 2 : nth + 1 });
    const locator = Object.fromEntries(
      LOCATOR_KEYS.filter((key) => typeof target[key] === 'string').map((key) => [key, target[key]])
    );
    const element = nth === null ? located.matches[0] : located.matches[nth];
    if (!element) {
      throw createRegistryError('ELEMENT_NOT_FOUND', 'No visible element matched the target.', {
        locator,
        ...(located.hiddenMatches ? { hiddenMatches: located.hiddenMatches } : {}),
      });
    }
    if (nth === null && located.matches.length > 1) {
      throw createRegistryError(
        'ELEMENT_AMBIGUOUS',
        'The target matches several elements. Add target.nth, a narrower locator, or a selector.',
        { locator }
      );
    }
    return element;
  }

  /** Resolve element-level read params from either a legacy top-level
`elementRef` or the newer `target` alias. */
  function resolveElementRefFromParams(
    params: {
      elementRef?: string;
      selector?: string;
      target?: string | Record<string, unknown>;
    } = {}
  ): string {
    if (typeof params.elementRef === 'string' && params.elementRef) {
      return params.elementRef;
    }
    // Reads accept the same target shapes as input methods: a selector string,
    // `css`, a top-level selector, or a semantic locator matching one element.
    let target: Record<string, unknown> | null = null;
    if (typeof params.target === 'string' && params.target.trim()) {
      target = { selector: params.target };
    } else if (params.target && typeof params.target === 'object') {
      target = { ...params.target };
      if (typeof target.selector !== 'string' && typeof target.css === 'string') {
        target.selector = target.css;
      }
    } else if (typeof params.selector === 'string' && params.selector.trim()) {
      target = { selector: params.selector };
    }
    if (target) {
      if (!target.elementRef && LOCATOR_KEYS.some((key) => typeof target[key] === 'string')) {
        return rememberElement(resolveLocatorTarget(target));
      }
      return rememberElement(resolveTarget(target as { elementRef?: string; selector?: string }));
    }
    throw createRegistryError(
      'INVALID_REQUEST',
      'elementRef or target is required. Pass a selector as target.selector.',
      {}
    );
  }

  let documentRevision = 0;
  let revisionObserver: MutationObserver | null = null;

  /** Start counting mutations on the first read that needs a revision. Frames
  the bridge never reads (most ads and embeds) then pay no observer cost.
  Revisions compare reads within one document, so a late start is harmless.
  The observer sees the light DOM only: mutations inside shadow roots, property
  changes such as checked or value, and focus do not count. */
  function ensureRevisionObserver(): void {
    if (revisionObserver || typeof MutationObserver !== 'function' || !document.documentElement) {
      return;
    }
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
    ensureRevisionObserver();
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
    getPruneEpoch: () => pruneEpoch,
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
