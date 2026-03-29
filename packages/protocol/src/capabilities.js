// @ts-check

/** @typedef {import('./types.js').BridgeMethod} CapabilityMethod */
/** @typedef {import('./types.js').Capability} Capability */

export const CAPABILITIES = Object.freeze({
  PAGE_READ: 'page.read',
  PAGE_EVALUATE: 'page.evaluate',
  DOM_READ: 'dom.read',
  STYLES_READ: 'styles.read',
  LAYOUT_READ: 'layout.read',
  VIEWPORT_CONTROL: 'viewport.control',
  NAVIGATION_CONTROL: 'navigation.control',
  SCREENSHOT_PARTIAL: 'screenshot.partial',
  PATCH_DOM: 'patch.dom',
  PATCH_STYLES: 'patch.styles',
  CDP_DOM_SNAPSHOT: 'cdp.dom_snapshot',
  CDP_BOX_MODEL: 'cdp.box_model',
  CDP_STYLES: 'cdp.styles',
  AUTOMATION_INPUT: 'automation.input',
  TABS_MANAGE: 'tabs.manage',
  PERFORMANCE_READ: 'performance.read',
  NETWORK_READ: 'network.read'
});

export const DEFAULT_CAPABILITIES = Object.freeze([
  CAPABILITIES.PAGE_READ,
  CAPABILITIES.PAGE_EVALUATE,
  CAPABILITIES.DOM_READ,
  CAPABILITIES.STYLES_READ,
  CAPABILITIES.LAYOUT_READ,
  CAPABILITIES.VIEWPORT_CONTROL,
  CAPABILITIES.NAVIGATION_CONTROL,
  CAPABILITIES.SCREENSHOT_PARTIAL,
  CAPABILITIES.PATCH_DOM,
  CAPABILITIES.PATCH_STYLES,
  CAPABILITIES.AUTOMATION_INPUT,
  CAPABILITIES.CDP_DOM_SNAPSHOT,
  CAPABILITIES.CDP_BOX_MODEL,
  CAPABILITIES.CDP_STYLES,
  CAPABILITIES.TABS_MANAGE,
  CAPABILITIES.PERFORMANCE_READ,
  CAPABILITIES.NETWORK_READ
]);

/** @type {Readonly<Record<CapabilityMethod, Capability | null>>} */
export const METHOD_CAPABILITIES = Object.freeze({
  'access.request': null,
  'tabs.list': null,
  'tabs.create': CAPABILITIES.TABS_MANAGE,
  'tabs.close': CAPABILITIES.TABS_MANAGE,
  'skill.get_runtime_context': null,
  'setup.get_status': null,
  'setup.install': null,
  'page.get_state': CAPABILITIES.PAGE_READ,
  'page.evaluate': CAPABILITIES.PAGE_EVALUATE,
  'page.get_console': CAPABILITIES.PAGE_READ,
  'page.wait_for_load_state': CAPABILITIES.PAGE_READ,
  'page.get_storage': CAPABILITIES.PAGE_READ,
  'page.get_text': CAPABILITIES.PAGE_READ,
  'page.get_network': CAPABILITIES.NETWORK_READ,
  'navigation.navigate': CAPABILITIES.NAVIGATION_CONTROL,
  'navigation.reload': CAPABILITIES.NAVIGATION_CONTROL,
  'navigation.go_back': CAPABILITIES.NAVIGATION_CONTROL,
  'navigation.go_forward': CAPABILITIES.NAVIGATION_CONTROL,
  'dom.query': CAPABILITIES.DOM_READ,
  'dom.describe': CAPABILITIES.DOM_READ,
  'dom.get_text': CAPABILITIES.DOM_READ,
  'dom.get_attributes': CAPABILITIES.DOM_READ,
  'dom.wait_for': CAPABILITIES.DOM_READ,
  'dom.find_by_text': CAPABILITIES.DOM_READ,
  'dom.find_by_role': CAPABILITIES.DOM_READ,
  'dom.get_html': CAPABILITIES.DOM_READ,
  'dom.get_accessibility_tree': CAPABILITIES.DOM_READ,
  'layout.get_box_model': CAPABILITIES.LAYOUT_READ,
  'layout.hit_test': CAPABILITIES.LAYOUT_READ,
  'styles.get_computed': CAPABILITIES.STYLES_READ,
  'styles.get_matched_rules': CAPABILITIES.STYLES_READ,
  'viewport.scroll': CAPABILITIES.VIEWPORT_CONTROL,
  'viewport.resize': CAPABILITIES.VIEWPORT_CONTROL,
  'input.click': CAPABILITIES.AUTOMATION_INPUT,
  'input.focus': CAPABILITIES.AUTOMATION_INPUT,
  'input.type': CAPABILITIES.AUTOMATION_INPUT,
  'input.press_key': CAPABILITIES.AUTOMATION_INPUT,
  'input.set_checked': CAPABILITIES.AUTOMATION_INPUT,
  'input.select_option': CAPABILITIES.AUTOMATION_INPUT,
  'input.hover': CAPABILITIES.AUTOMATION_INPUT,
  'input.drag': CAPABILITIES.AUTOMATION_INPUT,
  'screenshot.capture_region': CAPABILITIES.SCREENSHOT_PARTIAL,
  'screenshot.capture_element': CAPABILITIES.SCREENSHOT_PARTIAL,
  'patch.apply_styles': CAPABILITIES.PATCH_STYLES,
  'patch.apply_dom': CAPABILITIES.PATCH_DOM,
  'patch.list': CAPABILITIES.PATCH_DOM,
  'patch.rollback': CAPABILITIES.PATCH_DOM,
  'patch.commit_session_baseline': CAPABILITIES.PATCH_DOM,
  'cdp.get_document': CAPABILITIES.CDP_DOM_SNAPSHOT,
  'cdp.get_dom_snapshot': CAPABILITIES.CDP_DOM_SNAPSHOT,
  'cdp.get_box_model': CAPABILITIES.CDP_BOX_MODEL,
  'cdp.get_computed_styles_for_node': CAPABILITIES.CDP_STYLES,
  'performance.get_metrics': CAPABILITIES.PERFORMANCE_READ,
  'log.tail': null,
  'health.ping': null
});

/**
 * @param {unknown} value
 * @returns {value is Capability}
 */
export function isCapability(value) {
  return /** @type {string[]} */ (Object.values(CAPABILITIES)).includes(
    /** @type {string} */ (value)
  );
}

/**
 * Return the legacy capability bucket associated with one bridge method.
 * A `null` value means the method is global/system-scoped and does not map to
 * a former capability gate.
 *
 * @param {CapabilityMethod} method
 * @returns {Capability | null}
 */
export function getMethodCapability(method) {
  return METHOD_CAPABILITIES[method] ?? null;
}
