// @ts-check

(() => {
  const globalState = /** @type {typeof globalThis & { __BBX_CONTENT_HELPERS__?: Record<string, unknown> }} */ (globalThis);

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
    'submit'
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

    return [
      ...new Set(
        value.filter((item) => typeof item === 'string' && item.trim())
      )
    ];
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
      attributeAllowlist: normalizeList(options.attributeAllowlist)
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
      omitted: value.length - budget
    };
  }

  /**
   * @param {string} selector
   * @returns {string}
   */
  function escapeTailwindSelector(selector) {
    return selector.replace(
      /(\.[-\w]+)\[([^\]]+)\]/g,
      (_, prefix, value) => `${prefix}\\[${value}\\]`
    );
  }

  /**
   * @param {Element} el
   * @returns {string}
   */
  function getInputImplicitRole(el) {
    if (!(el instanceof HTMLInputElement)) return 'textbox';
    const type = el.type.toLowerCase();
    /** @type {Record<string, string>} */
    const map = {
      button: 'button',
      checkbox: 'checkbox',
      radio: 'radio',
      range: 'slider',
      search: 'searchbox',
      submit: 'button',
      reset: 'button',
      image: 'button'
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
      ul: 'list'
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
      button: 'button, input[type=button], input[type=submit], input[type=reset], input[type=image]',
      dialog: 'dialog',
      contentinfo: 'footer',
      form: 'form',
      heading: 'h1, h2, h3, h4, h5, h6',
      banner: 'header',
      img: 'img',
      textbox: 'input:not([type=button]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=submit]):not([type=reset]):not([type=image]):not([type=hidden]), textarea',
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
      searchbox: 'input[type=search]'
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
      height: rect.height
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

  globalState.__BBX_CONTENT_HELPERS__ = Object.freeze({
    NON_TEXT_INPUT_TYPES,
    applyBudget,
    clamp,
    escapeTailwindSelector,
    extractElementText,
    getImplicitRole,
    getImplicitRoleSelector,
    getInputImplicitRole,
    normalizeList,
    toRect,
    truncateText
  });
})();
