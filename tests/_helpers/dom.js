// @ts-check

import { parseHTML } from 'linkedom';
import { webcrypto } from 'node:crypto';

const MISSING = Symbol('missing');

if (!globalThis.crypto) {
  Reflect.set(globalThis, 'crypto', webcrypto);
}

const DOM_GLOBAL_KEYS = [
  'window',
  'document',
  'location',
  'navigator',
  'Node',
  'Text',
  'Element',
  'HTMLElement',
  'Document',
  'MutationObserver',
  'DOMRect',
  'DOMRectReadOnly',
  'Event',
  'InputEvent',
  'KeyboardEvent',
  'MouseEvent',
  'CustomEvent',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
  'HTMLOptionElement',
  'HTMLButtonElement',
  'getComputedStyle',
];

/**
 * @param {string[]} keys
 * @returns {Map<string, unknown>}
 */
function captureGlobals(keys) {
  /** @type {Map<string, unknown>} */
  const saved = new Map();
  for (const key of keys) {
    saved.set(
      key,
      Object.prototype.hasOwnProperty.call(globalThis, key) ? Reflect.get(globalThis, key) : MISSING
    );
  }
  return saved;
}

/**
 * @param {Map<string, unknown>} saved
 * @returns {void}
 */
function restoreGlobals(saved) {
  for (const [key, value] of saved.entries()) {
    if (value === MISSING) {
      Reflect.deleteProperty(globalThis, key);
      continue;
    }
    Reflect.set(globalThis, key, value);
  }
}

/**
 * @param {Window & typeof globalThis} window
 * @param {Document} document
 * @returns {void}
 */
function installDomGlobals(window, document) {
  const windowRecord = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));

  Reflect.set(globalThis, 'window', window);
  Reflect.set(globalThis, 'document', document);
  Reflect.set(globalThis, 'location', window.location);
  Reflect.set(globalThis, 'navigator', window.navigator);

  for (const key of DOM_GLOBAL_KEYS) {
    if (key === 'window' || key === 'document' || key === 'location' || key === 'navigator') {
      continue;
    }
    if (key === 'getComputedStyle') {
      if (typeof window.getComputedStyle === 'function') {
        Reflect.set(globalThis, key, window.getComputedStyle.bind(window));
      }
      continue;
    }
    if (typeof windowRecord[key] !== 'undefined') {
      Reflect.set(globalThis, key, windowRecord[key]);
    }
  }

  if (typeof document.hasFocus !== 'function') {
    Reflect.set(document, 'hasFocus', () => true);
  }
  if (typeof window.innerWidth !== 'number') {
    Reflect.set(window, 'innerWidth', 1280);
  }
  if (typeof window.innerHeight !== 'number') {
    Reflect.set(window, 'innerHeight', 720);
  }
  if (typeof window.devicePixelRatio !== 'number') {
    Reflect.set(window, 'devicePixelRatio', 1);
  }
  if (typeof window.scrollX !== 'number') {
    Reflect.set(window, 'scrollX', 0);
  }
  if (typeof window.scrollY !== 'number') {
    Reflect.set(window, 'scrollY', 0);
  }
}

/**
 * Install a temporary linkedom-backed `window`/`document` into `globalThis`
 * for the duration of one async test callback.
 *
 * @template T
 * @param {string} html
 * @param {(context: { window: Window & typeof globalThis, document: Document }) => Promise<T> | T} callback
 * @returns {Promise<T>}
 */
export async function withDocument(html, callback) {
  const { window, document } = parseHTML(html);
  const saved = captureGlobals(DOM_GLOBAL_KEYS);

  try {
    installDomGlobals(window, document);
    return await callback({ window, document });
  } finally {
    restoreGlobals(saved);
  }
}
