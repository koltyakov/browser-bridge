// @ts-check

/**
 * Canonical bridge method registry. This is the shared source of truth for
 * method grouping, tab-routing requirements, and exposed params so the protocol,
 * CLI, MCP layer, and docs can stay aligned.
 *
 * @type {Readonly<Record<import('./types.js').BridgeMethod, {
 *   group: string,
 *   tab: boolean,
 *   params: readonly string[],
 *   since: string
 * }>>}
 */
export const BRIDGE_METHOD_REGISTRY = Object.freeze({
  'access.request': { group: 'system', tab: false, params: [], since: '1.0' },
  'tabs.list': { group: 'tabs', tab: false, params: [], since: '1.0' },
  'tabs.create': { group: 'tabs', tab: false, params: ['url', 'active'], since: '1.0' },
  'tabs.close': { group: 'tabs', tab: false, params: ['tabId'], since: '1.0' },
  'skill.get_runtime_context': { group: 'system', tab: false, params: [], since: '1.0' },
  'setup.get_status': { group: 'system', tab: false, params: [], since: '1.0' },
  'setup.install': { group: 'system', tab: false, params: ['kind', 'target'], since: '1.0' },
  'page.get_state': { group: 'page', tab: true, params: [], since: '1.0' },
  'page.evaluate': {
    group: 'page',
    tab: true,
    params: ['expression', 'awaitPromise', 'timeoutMs', 'returnByValue'],
    since: '1.0'
  },
  'page.get_console': { group: 'page', tab: true, params: ['level', 'clear', 'limit'], since: '1.0' },
  'page.wait_for_load_state': { group: 'wait', tab: true, params: ['timeoutMs'], since: '1.0' },
  'page.get_storage': { group: 'page', tab: true, params: ['type', 'keys'], since: '1.0' },
  'page.get_text': { group: 'page', tab: true, params: ['textBudget'], since: '1.0' },
  'page.get_network': { group: 'page', tab: true, params: ['clear', 'limit', 'urlPattern'], since: '1.0' },
  'navigation.navigate': { group: 'navigate', tab: true, params: ['url', 'waitForLoad', 'timeoutMs'], since: '1.0' },
  'navigation.reload': { group: 'navigate', tab: true, params: ['waitForLoad', 'timeoutMs'], since: '1.0' },
  'navigation.go_back': { group: 'navigate', tab: true, params: ['waitForLoad', 'timeoutMs'], since: '1.0' },
  'navigation.go_forward': { group: 'navigate', tab: true, params: ['waitForLoad', 'timeoutMs'], since: '1.0' },
  'dom.query': {
    group: 'inspect',
    tab: true,
    params: ['selector', 'withinRef', 'maxNodes', 'maxDepth', 'textBudget', 'includeBbox', 'attributeAllowlist'],
    since: '1.0'
  },
  'dom.describe': { group: 'inspect', tab: true, params: ['elementRef'], since: '1.0' },
  'dom.get_text': { group: 'inspect', tab: true, params: ['elementRef', 'textBudget'], since: '1.0' },
  'dom.get_attributes': { group: 'inspect', tab: true, params: ['elementRef', 'attributes'], since: '1.0' },
  'dom.wait_for': { group: 'wait', tab: true, params: ['selector', 'text', 'state', 'timeoutMs'], since: '1.0' },
  'dom.find_by_text': { group: 'inspect', tab: true, params: ['text', 'exact', 'selector', 'maxResults'], since: '1.0' },
  'dom.find_by_role': { group: 'inspect', tab: true, params: ['role', 'name', 'selector', 'maxResults'], since: '1.0' },
  'dom.get_html': { group: 'inspect', tab: true, params: ['elementRef', 'outer', 'maxLength'], since: '1.0' },
  'dom.get_accessibility_tree': { group: 'inspect', tab: true, params: ['maxNodes', 'maxDepth'], since: '1.0' },
  'layout.get_box_model': { group: 'inspect', tab: true, params: ['elementRef'], since: '1.0' },
  'layout.hit_test': { group: 'inspect', tab: true, params: ['x', 'y'], since: '1.0' },
  'styles.get_computed': { group: 'inspect', tab: true, params: ['elementRef', 'properties'], since: '1.0' },
  'styles.get_matched_rules': { group: 'inspect', tab: true, params: ['elementRef'], since: '1.0' },
  'viewport.scroll': { group: 'navigate', tab: true, params: ['target', 'top', 'left', 'behavior', 'relative'], since: '1.0' },
  'viewport.resize': { group: 'navigate', tab: true, params: ['width', 'height', 'deviceScaleFactor', 'reset'], since: '1.0' },
  'input.click': { group: 'interact', tab: true, params: ['target', 'button', 'clickCount', 'modifiers'], since: '1.0' },
  'input.focus': { group: 'interact', tab: true, params: ['target'], since: '1.0' },
  'input.type': { group: 'interact', tab: true, params: ['target', 'text', 'clear', 'submit', 'modifiers'], since: '1.0' },
  'input.press_key': { group: 'interact', tab: true, params: ['target', 'key', 'modifiers'], since: '1.0' },
  'input.set_checked': { group: 'interact', tab: true, params: ['target', 'checked'], since: '1.0' },
  'input.select_option': { group: 'interact', tab: true, params: ['target', 'values', 'labels', 'indexes'], since: '1.0' },
  'input.hover': { group: 'interact', tab: true, params: ['target', 'duration', 'modifiers'], since: '1.0' },
  'input.drag': { group: 'interact', tab: true, params: ['source', 'destination', 'offsetX', 'offsetY'], since: '1.0' },
  'screenshot.capture_region': { group: 'capture', tab: true, params: ['x', 'y', 'width', 'height'], since: '1.0' },
  'screenshot.capture_element': { group: 'capture', tab: true, params: ['elementRef'], since: '1.0' },
  'patch.apply_styles': { group: 'patch', tab: true, params: ['target', 'declarations', 'important', 'patchId', 'verify'], since: '1.0' },
  'patch.apply_dom': { group: 'patch', tab: true, params: ['target', 'operation', 'name', 'value', 'patchId', 'verify'], since: '1.0' },
  'patch.list': { group: 'patch', tab: true, params: [], since: '1.0' },
  'patch.rollback': { group: 'patch', tab: true, params: ['patchId'], since: '1.0' },
  'patch.commit_session_baseline': { group: 'patch', tab: true, params: [], since: '1.0' },
  'cdp.get_document': { group: 'cdp', tab: true, params: [], since: '1.0' },
  'cdp.get_dom_snapshot': { group: 'cdp', tab: true, params: [], since: '1.0' },
  'cdp.get_box_model': { group: 'cdp', tab: true, params: ['elementRef'], since: '1.0' },
  'cdp.get_computed_styles_for_node': { group: 'cdp', tab: true, params: ['elementRef'], since: '1.0' },
  'performance.get_metrics': { group: 'performance', tab: true, params: [], since: '1.0' },
  'log.tail': { group: 'system', tab: false, params: [], since: '1.0' },
  'health.ping': { group: 'system', tab: false, params: [], since: '1.0' }
});

/** @type {ReadonlyArray<import('./types.js').BridgeMethod>} */
export const BRIDGE_METHODS = Object.freeze(
  /** @type {import('./types.js').BridgeMethod[]} */ (Object.keys(BRIDGE_METHOD_REGISTRY))
);

/**
 * @returns {Record<string, import('./types.js').BridgeMethod[]>}
 */
export function createBridgeMethodGroups() {
  /** @type {Record<string, import('./types.js').BridgeMethod[]>} */
  const groups = {};

  for (const method of BRIDGE_METHODS) {
    const group = BRIDGE_METHOD_REGISTRY[method].group;
    if (!groups[group]) {
      groups[group] = [];
    }
    groups[group].push(method);
  }

  return groups;
}

/**
 * @param {string} method
 * @returns {method is import('./types.js').BridgeMethod}
 */
export function isBridgeMethod(method) {
  return Object.hasOwn(BRIDGE_METHOD_REGISTRY, method);
}

/**
 * @param {string} method
 * @returns {boolean}
 */
export function bridgeMethodNeedsTab(method) {
  return isBridgeMethod(method) ? BRIDGE_METHOD_REGISTRY[method].tab : true;
}
