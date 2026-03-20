// @ts-check

/** @typedef {import('./types.js').Capability} Capability */

export const CAPABILITIES = Object.freeze({
  DOM_READ: 'dom.read',
  STYLES_READ: 'styles.read',
  LAYOUT_READ: 'layout.read',
  SCREENSHOT_PARTIAL: 'screenshot.partial',
  PATCH_DOM: 'patch.dom',
  PATCH_STYLES: 'patch.styles',
  CDP_DOM_SNAPSHOT: 'cdp.dom_snapshot',
  CDP_BOX_MODEL: 'cdp.box_model',
  CDP_STYLES: 'cdp.styles',
  AUTOMATION_INPUT: 'automation.input'
});

export const DEFAULT_CAPABILITIES = Object.freeze([
  CAPABILITIES.DOM_READ,
  CAPABILITIES.STYLES_READ,
  CAPABILITIES.LAYOUT_READ,
  CAPABILITIES.SCREENSHOT_PARTIAL,
  CAPABILITIES.PATCH_DOM,
  CAPABILITIES.PATCH_STYLES,
  CAPABILITIES.AUTOMATION_INPUT,
  CAPABILITIES.CDP_DOM_SNAPSHOT,
  CAPABILITIES.CDP_BOX_MODEL,
  CAPABILITIES.CDP_STYLES
]);

/**
 * @param {unknown} value
 * @returns {value is Capability}
 */
export function isCapability(value) {
  return /** @type {string[]} */ (Object.values(CAPABILITIES)).includes(
    /** @type {string} */ (value)
  );
}
