(() => {
  type BaselineParams = {
    selector: string;
    maxNodes: number;
    maxDepth: number;
    textBudget: number;
    attributeAllowlist: string[];
    expectedDocumentToken?: string;
    allowMissingRoot?: boolean;
  };

  type FingerprintedValue = { value: string; fingerprint: string };

  type BaselineNode = {
    nodeId: string;
    parentId: string | null;
    ancestorIds: string[];
    siblingIndex: number;
    order: number;
    depth: number;
    tag: string;
    role: string | null;
    name: string | null;
    nameFingerprint: string;
    textExcerpt: string;
    textFingerprint: string;
    attrs: Record<string, FingerprintedValue>;
    attrsFingerprint: string;
    state: Record<string, boolean | 'mixed'>;
  };

  type ContentDomBaseline = {
    capture: (params: BaselineParams) => {
      documentToken: string;
      representation: 'semantic-dom-v1';
      selector: string;
      nodes: BaselineNode[];
      stats: { nodeCount: number; byteLength: number; digest: string };
    };
    getDocumentToken: () => string;
  };

  const globalState = globalThis as typeof globalThis & {
    __bbxContentDomBaseline?: ContentDomBaseline;
  };
  if (globalState.__bbxContentDomBaseline) {
    return;
  }

  const contentHelpers = (
    globalThis as typeof globalThis & {
      __BBX_CONTENT_HELPERS__?: {
        getImplicitRole: (element: Element) => string;
        truncateText: (value: string, budget: number) => { value: string };
      };
    }
  ).__BBX_CONTENT_HELPERS__;
  if (!contentHelpers) {
    throw new Error(
      'Browser Bridge content-script helpers must load before content-dom-baseline.js.'
    );
  }
  const helpers = contentHelpers;

  const MAX_SERIALIZED_BYTES = 262_144;
  const MAX_DISPLAY_VALUE = 160;
  const MAX_TEXT_DISPLAY_VALUE = 1_000;
  const MAX_SOURCE_VALUE = 32_768;
  const MAX_LABELLED_BY_IDS = 16;
  const DEFAULT_ATTRIBUTES = ['data-cy', 'data-test', 'data-testid', 'href', 'id', 'name', 'type'];
  const EXCLUDED_SUBTREES = new Set(['script', 'style', 'template', 'noscript']);

  const nodeIdentities: WeakMap<Element, string> = new WeakMap();
  const documentToken = createOpaqueId('doc');

  /** Capture a deterministic, compact semantic representation of one light-DOM subtree.
Fingerprints and the snapshot digest are opaque, deterministic, non-cryptographic
change detectors. Callers must not interpret them as content hashes. */
  function capture(params: BaselineParams): {
    documentToken: string;
    representation: 'semantic-dom-v1';
    selector: string;
    nodes: BaselineNode[];
    stats: { nodeCount: number; byteLength: number; digest: string };
  } {
    validateParams(params);
    if (
      typeof params.expectedDocumentToken === 'string' &&
      params.expectedDocumentToken !== documentToken
    ) {
      throwContentError(
        'DOM_BASELINE_INVALIDATED',
        'The document changed since this baseline token was issued.',
        { expectedDocumentToken: params.expectedDocumentToken, documentToken }
      );
    }

    const root = resolveUniqueRoot(params.selector, params.allowMissingRoot === true);
    const attributeNames = getAttributeNames(params.attributeAllowlist);

    const nodes: BaselineNode[] = [];

    const stack: Array<{
      element: Element;
      depth: number;
      parentId: string | null;
      ancestorIds: string[];
    }> = root ? [{ element: root, depth: 0, parentId: null, ancestorIds: [] }] : [];

    while (stack.length > 0) {
      const entry = stack.pop();
      if (!entry) break;
      if (entry.depth > params.maxDepth) {
        throwTruncated('maxDepth', params.maxDepth);
      }
      if (nodes.length >= params.maxNodes) {
        throwTruncated('maxNodes', params.maxNodes);
      }

      const nodeId = rememberElement(entry.element);
      const name = getAccessibleName(entry.element, root as Element);
      const text = getDirectOrLeafText(entry.element);
      const attrs = getAttributes(entry.element, attributeNames);
      const node = {
        nodeId,
        parentId: entry.parentId,
        ancestorIds: entry.ancestorIds,
        siblingIndex: getSiblingIndex(entry.element),
        order: nodes.length,
        depth: entry.depth,
        tag: entry.element.tagName.toLowerCase(),
        role: getRole(entry.element),
        name: takeDisplay(name, params.textBudget),
        nameFingerprint: fingerprint(name),
        textExcerpt: takeDisplay(text, params.textBudget) || '',
        textFingerprint: fingerprint(text),
        attrs,
        attrsFingerprint: fingerprint(
          Object.entries(attrs)
            .map(([attribute, value]) => `${attribute}=${value.fingerprint}`)
            .join('|')
        ),
        state: getSemanticState(entry.element),
      };
      nodes.push(node);

      if (EXCLUDED_SUBTREES.has(node.tag)) {
        node.name = null;
        node.nameFingerprint = '';
        node.textExcerpt = '';
        node.textFingerprint = '';
        continue;
      }

      const childAncestorIds = [...entry.ancestorIds, nodeId].slice(-params.maxDepth);
      const children = Array.from(entry.element.children);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (EXCLUDED_SUBTREES.has(child.tagName.toLowerCase())) continue;
        stack.push({
          element: child,
          depth: entry.depth + 1,
          parentId: nodeId,
          ancestorIds: childAncestorIds,
        });
      }
    }

    const digestInput = JSON.stringify({
      representation: 'semantic-dom-v1',
      selector: params.selector,
      nodes,
    });
    const result = {
      documentToken,
      representation: 'semantic-dom-v1' as const,
      selector: params.selector,
      nodes,
      stats: {
        nodeCount: nodes.length,
        byteLength: 0,
        digest: fingerprint(digestInput),
      },
    };
    result.stats.byteLength = getStableSerializedByteLength(result);
    if (result.stats.byteLength > MAX_SERIALIZED_BYTES) {
      throwTruncated('byteLength', MAX_SERIALIZED_BYTES);
    }
    return result;

    function takeDisplay(value: string, requestedBudget: number): string | null {
      if (!value || requestedBudget <= 0) return null;
      const budget = Math.min(MAX_TEXT_DISPLAY_VALUE, requestedBudget);
      const displayed = helpers.truncateText(value, budget).value;
      return displayed || null;
    }

    function getAttributes(element: Element, names: string[]): Record<string, FingerprintedValue> {
      const attrs: Record<string, FingerprintedValue> = {};
      for (const name of names) {
        if (!element.hasAttribute(name)) continue;
        const rawValue = element.getAttribute(name) || '';
        assertSourceBound(rawValue, 'attributeLength');
        const normalized = name === 'href' ? sanitizeHref(rawValue) : normalizeText(rawValue);
        attrs[name] = {
          value: helpers.truncateText(normalized, MAX_DISPLAY_VALUE).value,
          fingerprint: fingerprint(normalized),
        };
      }
      return attrs;
    }
  }

  function validateParams(params: BaselineParams): void {
    if (!params || typeof params !== 'object' || typeof params.selector !== 'string') {
      throwContentError('INVALID_REQUEST', 'A selector is required.', null);
    }
    const bounds = [
      ['maxNodes', params.maxNodes, 1, 1000],
      ['maxDepth', params.maxDepth, 1, 20],
      ['textBudget', params.textBudget, 32, 1000],
    ];
    for (const [name, value, minimum, maximum] of bounds) {
      if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throwContentError('INVALID_REQUEST', `${name} is outside the normalized bounds.`, {
          name,
          minimum,
          maximum,
        });
      }
    }
    if (
      !Array.isArray(params.attributeAllowlist) ||
      params.attributeAllowlist.length > 16 ||
      params.attributeAllowlist.some((name) => typeof name !== 'string')
    ) {
      throwContentError(
        'INVALID_REQUEST',
        'attributeAllowlist is outside the normalized bounds.',
        null
      );
    }
  }

  function resolveUniqueRoot(selector: string, allowMissing: boolean): Element | null {
    let matches: NodeListOf<Element>;
    try {
      matches = document.querySelectorAll(selector);
    } catch (error) {
      throwContentError('INVALID_REQUEST', 'The baseline selector is not valid CSS.', {
        selector,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (matches.length === 0) {
      if (allowMissing) return null;
      throwContentError('ELEMENT_NOT_FOUND', 'No element matched the baseline selector.', {
        selector,
      });
    }
    if (matches.length !== 1) {
      throwContentError(
        'ELEMENT_AMBIGUOUS',
        'The baseline selector must match exactly one element.',
        {
          selector,
          count: matches.length,
        }
      );
    }
    return matches[0];
  }

  function getAttributeNames(allowlist: string[]): string[] {
    return [...new Set([...DEFAULT_ATTRIBUTES, ...allowlist.map((name) => name.toLowerCase())])]
      .filter((name) => name !== 'value' && !name.startsWith('on'))
      .sort();
  }

  function rememberElement(element: Element): string {
    const existing = nodeIdentities.get(element);
    if (existing) return existing;
    const nodeId = createOpaqueId('node');
    nodeIdentities.set(element, nodeId);
    return nodeId;
  }

  function getSiblingIndex(element: Element): number {
    if (!element.parentElement) return 0;
    return Array.prototype.indexOf.call(element.parentElement.children, element);
  }

  function getRole(element: Element): string | null {
    const explicit = normalizeSourceText(element.getAttribute('role') || '').split(' ')[0];
    return explicit || helpers.getImplicitRole(element) || null;
  }

  function getAccessibleName(element: Element, scopeRoot: Element): string {
    const labelledBy = normalizeSourceText(element.getAttribute('aria-labelledby') || '');
    if (labelledBy) {
      const value = joinBoundedText(
        labelledBy
          .split(' ')
          .slice(0, MAX_LABELLED_BY_IDS)
          .map((id) => document.getElementById(id))
          .filter((candidate) => candidate && scopeRoot.contains(candidate))
          .map((candidate) => getSafeTextContent(candidate))
      );
      if (value) return value;
    }

    const ariaLabel = normalizeSourceText(element.getAttribute('aria-label') || '');
    if (ariaLabel) return ariaLabel;

    if ('labels' in element) {
      const labels = (element as { labels?: Iterable<Element> | null }).labels;
      if (labels) {
        const value = joinBoundedText(
          [...labels]
            .slice(0, MAX_LABELLED_BY_IDS)
            .filter((label) => scopeRoot.contains(label))
            .map((label) => getSafeTextContent(label))
        );
        if (value) return value;
      }
    }

    const wrappingLabel = element.closest?.('label');
    if (wrappingLabel && scopeRoot.contains(wrappingLabel)) {
      const value = getSafeTextContent(wrappingLabel);
      if (value) return value;
    }

    for (const attribute of ['alt', 'title']) {
      const value = normalizeSourceText(element.getAttribute(attribute) || '');
      if (value) return value;
    }
    return getDirectOrLeafText(element);
  }

  function getDirectOrLeafText(element: Element): string {
    const parts: string[] = [];
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent || '');
    }
    const directText = joinBoundedText(parts);
    if (normalizeText(directText)) return normalizeText(directText);
    return element.childElementCount === 0 ? normalizeSourceText(element.textContent || '') : '';
  }

  function getSafeTextContent(element: Element | null): string {
    if (!element || EXCLUDED_SUBTREES.has(element.tagName.toLowerCase())) return '';

    const parts: string[] = [];
    let sourceChars = 0;
    let sourceNodes = 0;
    if (element.childNodes.length > 2_000) throwTruncated('sourceText', MAX_SOURCE_VALUE);

    const stack: Node[] = Array.from(element.childNodes).reverse();
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) break;
      sourceNodes += 1;
      if (sourceNodes > 2_000) throwTruncated('sourceText', MAX_SOURCE_VALUE);
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || '';
        sourceChars += text.length;
        if (sourceChars > MAX_SOURCE_VALUE) throwTruncated('sourceText', MAX_SOURCE_VALUE);
        parts.push(text);
        continue;
      }
      if (!(node instanceof Element) || EXCLUDED_SUBTREES.has(node.tagName.toLowerCase())) continue;
      if (node.childNodes.length + stack.length > 2_000) {
        throwTruncated('sourceText', MAX_SOURCE_VALUE);
      }
      stack.push(...Array.from(node.childNodes).reverse());
    }
    return joinBoundedText(parts);
  }

  function getSemanticState(element: Element): Record<string, boolean | 'mixed'> {
    const state: Record<string, boolean | 'mixed'> = {};
    const tag = element.tagName.toLowerCase();
    const role = getRole(element);
    const inputType = normalizeSourceText(element.getAttribute('type') || '').toLowerCase();

    if (['button', 'fieldset', 'input', 'optgroup', 'option', 'select', 'textarea'].includes(tag)) {
      state.disabled = readLiveBoolean(element, 'disabled', 'disabled');
    } else {
      assignAriaState(state, 'disabled', element.getAttribute('aria-disabled'));
    }
    if (
      (tag === 'input' && ['checkbox', 'radio'].includes(inputType)) ||
      ['checkbox', 'menuitemcheckbox', 'menuitemradio', 'radio', 'switch'].includes(role || '')
    ) {
      const ariaChecked = element.getAttribute('aria-checked');
      if (ariaChecked !== null) assignAriaState(state, 'checked', ariaChecked, true);
      else state.checked = readLiveBoolean(element, 'checked', 'checked');
    }
    if (tag === 'option' || role === 'option') {
      const ariaSelected = element.getAttribute('aria-selected');
      if (ariaSelected !== null) assignAriaState(state, 'selected', ariaSelected);
      else state.selected = readLiveBoolean(element, 'selected', 'selected');
    }
    assignAriaState(state, 'expanded', element.getAttribute('aria-expanded'));
    assignAriaState(state, 'pressed', element.getAttribute('aria-pressed'), true);
    if (element.hasAttribute('hidden') || (tag === 'input' && inputType === 'hidden'))
      state.hidden = true;
    else assignAriaState(state, 'hidden', element.getAttribute('aria-hidden'));
    return state;
  }

  function assignAriaState(
    state: Record<string, boolean | 'mixed'>,
    name: string,
    value: string | null,
    allowMixed: boolean = false
  ): void {
    if (value === null) return;
    const normalized = value.trim().toLowerCase();
    if (allowMixed && normalized === 'mixed') state[name] = 'mixed';
    else if (normalized === 'true' || normalized === 'false') state[name] = normalized === 'true';
  }

  function readBooleanProperty(element: Element, name: string): boolean {
    return Boolean((element as Element & Record<string, unknown>)[name]);
  }

  function readLiveBoolean(element: Element, property: string, attribute: string) {
    return property in element
      ? readBooleanProperty(element, property)
      : element.hasAttribute(attribute);
  }

  function normalizeText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  function normalizeSourceText(value: string) {
    assertSourceBound(value, 'sourceText');
    return normalizeText(value);
  }

  function joinBoundedText(values: string[]) {
    let result = '';
    for (const value of values) {
      if (!value) continue;
      if (result.length + value.length + 1 > MAX_SOURCE_VALUE) {
        throwTruncated('sourceText', MAX_SOURCE_VALUE);
      }
      result += `${result ? ' ' : ''}${value}`;
    }
    return normalizeText(result);
  }

  function assertSourceBound(value: string, limit: 'sourceText' | 'attributeLength') {
    if (value.length > MAX_SOURCE_VALUE) throwTruncated(limit, MAX_SOURCE_VALUE);
  }

  function sanitizeHref(value: string) {
    assertSourceBound(value, 'attributeLength');
    try {
      const parsed = new URL(value, document.baseURI);
      if (!['http:', 'https:', 'about:'].includes(parsed.protocol)) {
        return `${parsed.protocol}[redacted]`;
      }
      parsed.username = '';
      parsed.password = '';
      parsed.hash = '';
      for (const key of parsed.searchParams.keys()) parsed.searchParams.set(key, '[redacted]');
      return parsed.toString();
    } catch {
      return '';
    }
  }

  /** Fingerprint the complete normalized value without retaining the source. The
output is opaque and intentionally non-cryptographic. */
  function fingerprint(value: string): string {
    const normalized = normalizeText(value);
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

  function createOpaqueId(prefix: string): string {
    if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
      throw new Error('Secure randomness is unavailable for Browser Bridge DOM identity.');
    }
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  function getStableSerializedByteLength(value: unknown): number {
    const encoder = new TextEncoder();
    const candidate = value as { stats: { byteLength: number } };
    let previous = -1;
    while (candidate.stats.byteLength !== previous) {
      previous = candidate.stats.byteLength;
      candidate.stats.byteLength = encoder.encode(JSON.stringify(value)).byteLength;
    }
    return candidate.stats.byteLength;
  }

  function throwTruncated(
    limit: 'maxNodes' | 'maxDepth' | 'byteLength' | 'sourceText' | 'attributeLength',
    maximum: number
  ) {
    throwContentError('RESULT_TRUNCATED', `The semantic DOM baseline exceeded ${limit}.`, {
      limit,
      maximum,
    });
  }

  function throwContentError(code: string, message: string, details: unknown): never {
    const error = new Error(message);
    Object.assign(error, { code, details });
    throw error;
  }

  globalState.__bbxContentDomBaseline = Object.freeze({
    capture,
    getDocumentToken: () => documentToken,
  });
})();
