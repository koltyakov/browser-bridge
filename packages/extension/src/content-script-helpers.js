// @ts-check

(() => {
  const globalState =
    /** @type {typeof globalThis & { __BBX_CONTENT_HELPERS__?: Record<string, unknown> }} */ (
      globalThis
    );

  if (globalState.__BBX_CONTENT_HELPERS__) {
    return;
  }

  /**
   * @typedef {{
   *   maxNodes: number,
   *   maxDepth: number,
   *   textBudget: number,
   *   includeBbox: boolean,
   *   attributeAllowlist: string[]
   * }} Budget
   */

  const NON_TEXT_INPUT_TYPES = new Set([
    'button',
    'checkbox',
    'color',
    'file',
    'hidden',
    'image',
    'radio',
    'range',
    'reset',
    'submit',
  ]);

  /**
   * @param {number | string | null | undefined} value
   * @param {number} minimum
   * @param {number} maximum
   * @returns {number}
   */
  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(Number(value) || minimum, minimum), maximum);
  }

  /**
   * @param {unknown} value
   * @returns {string[]}
   */
  function normalizeList(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    return [...new Set(value.filter((item) => typeof item === 'string' && item.trim()))];
  }

  /**
   * @param {Record<string, any>} [options={}]
   * @returns {Budget}
   */
  function applyBudget(options = {}) {
    return {
      maxNodes: clamp(options.maxNodes ?? 25, 1, 250),
      maxDepth: clamp(options.maxDepth ?? 4, 1, 20),
      textBudget: clamp(options.textBudget ?? 600, 32, 10000),
      includeBbox: options.includeBbox !== false,
      attributeAllowlist: normalizeList(options.attributeAllowlist),
    };
  }

  /**
   * @param {string} value
   * @param {number} budget
   * @returns {{ value: string, truncated: boolean, omitted: number }}
   */
  function truncateText(value, budget) {
    if (!value) {
      return { value: '', truncated: false, omitted: 0 };
    }

    if (value.length <= budget) {
      return { value, truncated: false, omitted: 0 };
    }

    return {
      value: `${value.slice(0, Math.max(0, budget - 1))}\u2026`,
      truncated: true,
      omitted: value.length - budget,
    };
  }

  /**
   * @param {string} selector
   * @returns {string}
   */
  function escapeTailwindSelector(selector) {
    const probe = document.createDocumentFragment();
    try {
      probe.querySelector(selector);
      return selector;
    } catch {
      // Repair utility syntax only after the browser rejects the original CSS.
    }
    // Leave valid attribute selectors (even .utility-[auto]) and quoted values
    // alone. Only invalid bracket syntax on a utility-style class is shorthand.
    return selector.replace(
      /\\.|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[(?:\\.|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\]\\"'])*\]|(\.[-\w]+-)\[([^\]\r\n]+)\]/g,
      /** @param {string} match @param {string | undefined} prefix @param {string | undefined} value @returns {string} */
      (match, prefix, value) => {
        if (typeof prefix !== 'string' || typeof value !== 'string') return match;
        try {
          probe.querySelector(`*[${value}]`);
          return match;
        } catch {
          return `${prefix}${`[${value}]`.replace(/[^\w-]/g, '\\$&')}`;
        }
      }
    );
  }

  /**
   * @param {Element} el
   * @returns {string}
   */
  function getInputImplicitRole(el) {
    if (typeof HTMLInputElement === 'undefined' || !(el instanceof HTMLInputElement)) {
      return 'textbox';
    }
    const type = String(el.type || el.getAttribute('type') || 'text').toLowerCase();
    /** @type {Record<string, string>} */
    const map = {
      button: 'button',
      checkbox: 'checkbox',
      radio: 'radio',
      range: 'slider',
      search: 'searchbox',
      submit: 'button',
      reset: 'button',
      image: 'button',
    };
    return map[type] || 'textbox';
  }

  /**
   * @param {Element} el
   * @returns {string}
   */
  function getImplicitRole(el) {
    const tag = el.tagName.toLowerCase();
    /** @type {Record<string, string>} */
    const roleMap = {
      a: el.hasAttribute('href') ? 'link' : '',
      article: 'article',
      aside: 'complementary',
      button: 'button',
      dialog: 'dialog',
      footer: 'contentinfo',
      form: 'form',
      h1: 'heading',
      h2: 'heading',
      h3: 'heading',
      h4: 'heading',
      h5: 'heading',
      h6: 'heading',
      header: 'banner',
      img: 'img',
      input: getInputImplicitRole(el),
      li: 'listitem',
      main: 'main',
      nav: 'navigation',
      ol: 'list',
      option: 'option',
      progress: 'progressbar',
      section: 'region',
      select: 'listbox',
      table: 'table',
      td: 'cell',
      textarea: 'textbox',
      th: 'columnheader',
      tr: 'row',
      ul: 'list',
    };
    return roleMap[tag] || '';
  }

  /**
   * @param {string} role
   * @returns {string}
   */
  function getImplicitRoleSelector(role) {
    /** @type {Record<string, string>} */
    const map = {
      link: 'a[href]',
      article: 'article',
      complementary: 'aside',
      button:
        'button, input[type=button], input[type=submit], input[type=reset], input[type=image]',
      dialog: 'dialog',
      contentinfo: 'footer',
      form: 'form',
      heading: 'h1, h2, h3, h4, h5, h6',
      banner: 'header',
      img: 'img',
      textbox:
        'input:not([type=button]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=submit]):not([type=reset]):not([type=image]):not([type=hidden]), textarea',
      listitem: 'li',
      main: 'main',
      navigation: 'nav',
      list: 'ol, ul',
      option: 'option',
      progressbar: 'progress',
      region: 'section',
      listbox: 'select',
      table: 'table',
      cell: 'td',
      columnheader: 'th',
      row: 'tr',
      checkbox: 'input[type=checkbox]',
      radio: 'input[type=radio]',
      slider: 'input[type=range]',
      searchbox: 'input[type=search]',
    };
    return map[role] || '';
  }

  /**
   * @param {DOMRect | DOMRectReadOnly} rect
   * @returns {{ x: number, y: number, width: number, height: number }}
   */
  function toRect(rect) {
    return {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
    };
  }

  /**
   * @param {string[]} values
   * @param {string | null | undefined} candidate
   * @returns {void}
   */
  function pushUnique(values, candidate) {
    if (!candidate) {
      return;
    }

    const normalized = candidate.replace(/\s+/g, ' ').trim();
    if (normalized && !values.includes(normalized)) {
      values.push(normalized);
    }
  }

  /**
   * @param {Element} element
   * @returns {string}
   */
  function extractElementText(element) {
    /** @type {string[]} */
    const parts = [];

    pushUnique(parts, element.getAttribute('aria-label'));
    pushUnique(parts, element.getAttribute('name'));
    pushUnique(parts, element.getAttribute('placeholder'));
    pushUnique(parts, element.getAttribute('title'));

    if ('value' in element && typeof element.value === 'string' && element.value.trim()) {
      pushUnique(parts, element.value);
    }

    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    pushUnique(parts, ownText);

    if (!parts.length && element.childElementCount === 0) {
      pushUnique(parts, (element.textContent || '').replace(/\s+/g, ' ').trim());
    }

    return parts.join(' | ');
  }

  /**
   * @template {object} TElement
   * @param {{
   *   elements: Iterable<TElement>,
   *   waitState: 'visible' | 'hidden',
   *   getRect: (element: TElement) => { width: number, height: number },
   *   getVisibility: (element: TElement) => string
   * }} options
   * @returns {TElement | null}
   */
  function findElementForWaitState({ elements, waitState, getRect, getVisibility }) {
    /** @type {TElement | null} */
    let hiddenMatch = null;
    for (const element of elements) {
      const rect = getRect(element);
      const hasVisibleArea = rect.width > 0 && rect.height > 0;
      if (waitState === 'visible') {
        if (!hasVisibleArea) {
          continue;
        }

        if (getVisibility(element) !== 'hidden') {
          return element;
        }
        continue;
      }

      if (!hasVisibleArea) {
        hiddenMatch ??= element;
        continue;
      }

      if (getVisibility(element) === 'hidden') {
        hiddenMatch ??= element;
        continue;
      }

      return null;
    }

    return hiddenMatch;
  }

  /**
   * @template {object} TElement
   * @template {string} TRef
   * @param {{
   *   registry: Map<TRef, TElement>,
   *   reverseRegistry: WeakMap<TElement, TRef>,
   *   iterator: IterableIterator<[TRef, TElement]> | null,
   *   containsElement: (element: TElement) => boolean,
   *   batchSize: number
   * }} options
   * @returns {{ iterator: IterableIterator<[TRef, TElement]> | null, pruned: boolean }}
   */
  function pruneElementRegistryEntries({
    registry,
    reverseRegistry,
    iterator,
    containsElement,
    batchSize,
  }) {
    if (registry.size === 0) {
      return { iterator: null, pruned: false };
    }

    let nextIterator = iterator;
    if (!nextIterator) {
      nextIterator = registry.entries();
    }

    let scanned = 0;
    let pruned = false;
    while (scanned < batchSize) {
      const nextEntry = nextIterator.next();
      if (nextEntry.done) {
        nextIterator = null;
        break;
      }

      const [ref, element] = nextEntry.value;
      if (!containsElement(element)) {
        registry.delete(ref);
        reverseRegistry.delete(element);
        pruned = true;
      }
      scanned += 1;
    }

    return { iterator: nextIterator, pruned };
  }

  /** Tags whose text never counts as visible page text. */
  const NON_RENDERED_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'HEAD',
    'META',
    'LINK',
    'TITLE',
  ]);
  const DEEP_SCAN_LIMIT = 20_000;
  const LABELABLE_TAGS = new Set([
    'INPUT',
    'SELECT',
    'TEXTAREA',
    'BUTTON',
    'METER',
    'OUTPUT',
    'PROGRESS',
  ]);
  /** Roles whose accessible name comes from their content. */
  const NAME_FROM_CONTENT_ROLES = new Set([
    'button',
    'cell',
    'checkbox',
    'columnheader',
    'gridcell',
    'heading',
    'link',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'radio',
    'row',
    'rowheader',
    'switch',
    'tab',
    'tooltip',
    'treeitem',
  ]);

  /**
   * Connection check that also holds for elements inside shadow roots, where
   * `document.contains` is always false.
   *
   * @param {Node | null | undefined} node
   * @returns {boolean}
   */
  function isNodeAttached(node) {
    if (!node) return false;
    if (typeof node.isConnected === 'boolean') return node.isConnected;
    return typeof document.contains === 'function' ? document.contains(node) : true;
  }

  /**
   * Return an element's shadow root, including closed roots when the extension
   * `chrome.dom` API is available to the content script.
   *
   * @param {Element} element
   * @returns {ShadowRoot | null}
   */
  function getShadowRoot(element) {
    const open = /** @type {{ shadowRoot?: ShadowRoot | null }} */ (element).shadowRoot;
    if (open) return open;
    const domApi =
      /** @type {{ chrome?: { dom?: { openOrClosedShadowRoot?: (element: HTMLElement) => ShadowRoot | null } } }} */ (
        globalThis
      ).chrome?.dom;
    if (typeof domApi?.openOrClosedShadowRoot !== 'function') return null;
    try {
      return domApi.openOrClosedShadowRoot(/** @type {HTMLElement} */ (element)) || null;
    } catch {
      return null;
    }
  }

  /**
   * Iterate elements in document order, entering shadow trees right after
   * their host. Bounded so pathological pages cannot stall the content script.
   *
   * @param {ParentNode} [root=document]
   * @param {number} [limit=DEEP_SCAN_LIMIT]
   * @returns {Generator<Element>}
   */
  function* walkElementsDeep(root = document, limit = DEEP_SCAN_LIMIT) {
    /** @type {Array<{ children: ArrayLike<Element>, index: number }>} */
    const stack = [{ children: root.children ?? [], index: 0 }];
    let yielded = 0;
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.index >= frame.children.length) {
        stack.pop();
        continue;
      }
      const element = frame.children[frame.index];
      frame.index += 1;
      yield element;
      yielded += 1;
      if (yielded >= limit) return;
      if (element.children?.length) stack.push({ children: element.children, index: 0 });
      const shadowRoot = getShadowRoot(element);
      if (shadowRoot?.children?.length) stack.push({ children: shadowRoot.children, index: 0 });
    }
  }

  /**
   * Collect every shadow root reachable from a root, including nested ones.
   *
   * @param {ParentNode} [root=document]
   * @returns {ShadowRoot[]}
   */
  function collectShadowRoots(root = document) {
    /** @type {ShadowRoot[]} */
    const roots = [];
    for (const element of walkElementsDeep(root)) {
      const shadowRoot = getShadowRoot(element);
      if (shadowRoot) roots.push(shadowRoot);
    }
    return roots;
  }

  /**
   * `querySelectorAll` that also searches open (and, for the extension, closed)
   * shadow roots. Light-DOM matches come first.
   *
   * @param {string} selector
   * @param {ParentNode} [root=document]
   * @returns {Element[]}
   */
  function querySelectorAllDeep(selector, root = document) {
    const results = [...root.querySelectorAll(selector)];
    if (typeof root.querySelectorAll !== 'function' || !('children' in root)) return results;
    for (const shadowRoot of collectShadowRoots(root)) {
      results.push(...shadowRoot.querySelectorAll(selector));
    }
    return results;
  }

  /**
   * First light-DOM match, falling back to shadow roots.
   *
   * @param {string} selector
   * @param {ParentNode} [root=document]
   * @returns {Element | null}
   */
  function querySelectorDeep(selector, root = document) {
    const light = root.querySelector(selector);
    if (light || !('children' in root)) return light;
    for (const shadowRoot of collectShadowRoots(root)) {
      const match = shadowRoot.querySelector(selector);
      if (match) return match;
    }
    return null;
  }

  /**
   * Best-effort rendered visibility. Unknown environments count as visible.
   *
   * @param {Element} element
   * @returns {boolean}
   */
  function isElementVisible(element) {
    if (!isNodeAttached(element)) return false;
    const candidate =
      /** @type {Element & { checkVisibility?: (options?: Record<string, boolean>) => boolean }} */ (
        element
      );
    if (typeof candidate.checkVisibility === 'function') {
      if (!candidate.checkVisibility({ checkVisibilityCSS: true })) return false;
      // Layout is real here, so an empty leaf box is not something a user can see.
      const rect = element.getBoundingClientRect();
      return !(rect.width === 0 && rect.height === 0 && element.childElementCount === 0);
    }
    if (typeof globalThis.getComputedStyle === 'function') {
      const style = globalThis.getComputedStyle(element);
      if (style?.display === 'none' || style?.visibility === 'hidden') return false;
    }
    return true;
  }

  /**
   * @param {string | null | undefined} value
   * @param {number} [budget=200]
   * @returns {string}
   */
  function collapseText(value, budget = 200) {
    const collapsed = String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    return collapsed.length > budget ? collapsed.slice(0, budget) : collapsed;
  }

  /**
   * Rendered-ish text of a subtree, skipping script/style content and
   * descending into shadow roots.
   *
   * @param {Element} element
   * @param {number} [budget=200]
   * @returns {string}
   */
  function getElementTextContent(element, budget = 200) {
    if (NON_RENDERED_TAGS.has(element.tagName)) return '';
    const hasNonRendered =
      typeof element.querySelector === 'function' &&
      element.querySelector('script, style, noscript, template') !== null;
    const shadowRoot = getShadowRoot(element);
    if (!hasNonRendered && !shadowRoot) return collapseText(element.textContent, budget);
    /** @type {string[]} */
    const parts = [];
    let length = 0;
    /** @param {Node} node */
    const visit = (node) => {
      if (length > budget) return;
      if (node.nodeType === 3) {
        parts.push(node.textContent || '');
        length += (node.textContent || '').length;
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node.nodeType === 1 && NON_RENDERED_TAGS.has(/** @type {Element} */ (node).tagName))
        return;
      const root = node.nodeType === 1 ? getShadowRoot(/** @type {Element} */ (node)) : null;
      for (const child of (root ?? node).childNodes) visit(child);
    };
    visit(element);
    return collapseText(parts.join(' '), budget);
  }

  /**
   * Resolve ids from aria-labelledby within the element's own tree scope.
   *
   * @param {Element} element
   * @param {string} ids
   * @returns {string}
   */
  function getTextForIdRefs(element, ids) {
    const rootNode = typeof element.getRootNode === 'function' ? element.getRootNode() : document;
    const scope = /** @type {{ getElementById?: (id: string) => Element | null }} */ (rootNode);
    return ids
      .split(/\s+/u)
      .filter(Boolean)
      .map((id) => {
        const target =
          (typeof scope.getElementById === 'function' ? scope.getElementById(id) : null) ||
          document.getElementById?.(id) ||
          document.querySelector?.(
            typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
              ? `#${CSS.escape(id)}`
              : `[id="${escapeAttributeValue(id)}"]`
          );
        return target ? getElementTextContent(target) : '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  /**
   * Escape a value for use inside a double-quoted attribute selector.
   *
   * @param {string} value
   * @returns {string}
   */
  function escapeAttributeValue(value) {
    return value.replace(/["\\]/g, '\\$&');
  }

  /**
   * Text of the `<label>` elements associated with a form control.
   *
   * @param {Element} element
   * @returns {string}
   */
  function getAssociatedLabelText(element) {
    /** @type {Element[]} */
    const labels = [];
    const native = /** @type {{ labels?: ArrayLike<Element> | null }} */ (element).labels;
    if (native && typeof native.length === 'number' && native.length > 0) {
      labels.push(...Array.from(native));
    } else {
      const id = element.getAttribute('id');
      const rootNode = typeof element.getRootNode === 'function' ? element.getRootNode() : document;
      const scope = /** @type {ParentNode} */ (rootNode);
      if (id && typeof scope.querySelectorAll === 'function') {
        labels.push(...scope.querySelectorAll(`label[for="${escapeAttributeValue(id)}"]`));
      }
      const wrapping = typeof element.closest === 'function' ? element.closest('label') : null;
      if (wrapping && !labels.includes(wrapping)) labels.push(wrapping);
    }
    return labels
      .map((label) => getElementTextContent(label))
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  /**
   * ARIA roles an element matches: the explicit role, else its implicit role
   * plus lenient aliases (a single `<select>` is a combobox in Chrome's AX tree
   * but historically matched `listbox` here).
   *
   * @param {Element} element
   * @returns {string[]}
   */
  function getElementRoles(element) {
    const explicit = element.getAttribute('role')?.trim().split(/\s+/u)[0];
    if (explicit) return [explicit.toLowerCase()];
    const tag = element.tagName.toLowerCase();
    if (tag === 'select') {
      const select = /** @type {HTMLSelectElement} */ (element);
      return select.multiple || Number(select.size) > 1 ? ['listbox'] : ['combobox', 'listbox'];
    }
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return [];
      if (type === 'number') return ['spinbutton', 'textbox'];
      if (
        element.hasAttribute('list') &&
        ['text', 'search', 'email', 'tel', 'url'].includes(type)
      ) {
        return ['combobox', 'textbox'];
      }
    }
    if (tag === 'summary') return ['button'];
    if (tag === 'img' && element.getAttribute('alt') === '') return ['presentation'];
    if (
      /** @type {{ isContentEditable?: boolean }} */ (element).isContentEditable === true &&
      element.getAttribute('contenteditable') !== null
    ) {
      return ['textbox'];
    }
    const implicit = getImplicitRole(element);
    return implicit ? [implicit] : [];
  }

  /**
   * Practical accessible-name computation covering the common sources:
   * aria-labelledby, aria-label, associated labels, alt, button values,
   * content for name-from-content roles, title, and placeholder.
   *
   * @param {Element} element
   * @returns {string}
   */
  function getAccessibleName(element) {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = getTextForIdRefs(element, labelledBy);
      if (text) return text;
    }
    const ariaLabel = collapseText(element.getAttribute('aria-label'));
    if (ariaLabel) return ariaLabel;

    const tag = element.tagName;
    const type = (element.getAttribute('type') || '').toLowerCase();
    if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(type)) {
      const value = collapseText(element.getAttribute('value'));
      if (value) return value;
      if (type !== 'button') return type === 'submit' ? 'Submit' : 'Reset';
    }
    if (LABELABLE_TAGS.has(tag) && !(tag === 'INPUT' && type === 'hidden')) {
      const labelText = getAssociatedLabelText(element);
      if (labelText) return labelText;
    }
    if (tag === 'IMG' || tag === 'AREA' || (tag === 'INPUT' && type === 'image')) {
      const alt = collapseText(element.getAttribute('alt'));
      if (alt) return alt;
    }
    if (tag === 'FIELDSET') {
      const legend = element.querySelector?.(':scope > legend');
      if (legend) return getElementTextContent(legend);
    }
    const roles = getElementRoles(element);
    if (roles.some((role) => NAME_FROM_CONTENT_ROLES.has(role)) || tag === 'LABEL') {
      const content = getElementTextContent(element);
      if (content) return content;
    }
    return (
      collapseText(element.getAttribute('title')) ||
      collapseText(element.getAttribute('placeholder')) ||
      ''
    );
  }

  globalState.__BBX_CONTENT_HELPERS__ = Object.freeze({
    NON_TEXT_INPUT_TYPES,
    applyBudget,
    clamp,
    escapeTailwindSelector,
    extractElementText,
    findElementForWaitState,
    getImplicitRole,
    getImplicitRoleSelector,
    getInputImplicitRole,
    NON_RENDERED_TAGS,
    collapseText,
    getAccessibleName,
    getElementRoles,
    getElementTextContent,
    getShadowRoot,
    isElementVisible,
    isNodeAttached,
    querySelectorAllDeep,
    querySelectorDeep,
    walkElementsDeep,
    normalizeList,
    pruneElementRegistryEntries,
    toRect,
    truncateText,
  });
})();
