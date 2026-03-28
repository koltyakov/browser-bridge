// @ts-check

/**
 * Canonical bridge method registry. This is the shared source of truth for
 * method grouping, tab-routing requirements, and exposed params so the protocol,
 * CLI, MCP layer, and docs can stay aligned.
 *
 * @type {Readonly<Record<import('./types.js').BridgeMethod, {
 *   group: string,
 *   tab: boolean,
 *   params: readonly string[]
 * }>>}
 */
export const BRIDGE_METHOD_REGISTRY = Object.freeze({
  'access.request': { group: 'system', tab: false, params: [] },
  'tabs.list': { group: 'tabs', tab: false, params: [] },
  'tabs.create': { group: 'tabs', tab: false, params: ['url', 'active'] },
  'tabs.close': { group: 'tabs', tab: false, params: ['tabId'] },
  'skill.get_runtime_context': { group: 'system', tab: false, params: [] },
  'setup.get_status': { group: 'system', tab: false, params: [] },
  'setup.install': { group: 'system', tab: false, params: ['kind', 'target'] },
  'page.get_state': { group: 'page', tab: true, params: [] },
  'page.evaluate': {
    group: 'page',
    tab: true,
    params: ['expression', 'awaitPromise', 'timeoutMs', 'returnByValue']
  },
  'page.get_console': { group: 'page', tab: true, params: ['level', 'clear', 'limit'] },
  'page.wait_for_load_state': { group: 'wait', tab: true, params: ['timeoutMs'] },
  'page.get_storage': { group: 'page', tab: true, params: ['type', 'keys'] },
  'page.get_text': { group: 'page', tab: true, params: ['textBudget'] },
  'page.get_network': { group: 'page', tab: true, params: ['clear', 'limit', 'urlPattern'] },
  'navigation.navigate': { group: 'navigate', tab: true, params: ['url', 'waitForLoad', 'timeoutMs'] },
  'navigation.reload': { group: 'navigate', tab: true, params: ['waitForLoad', 'timeoutMs'] },
  'navigation.go_back': { group: 'navigate', tab: true, params: ['waitForLoad', 'timeoutMs'] },
  'navigation.go_forward': { group: 'navigate', tab: true, params: ['waitForLoad', 'timeoutMs'] },
  'dom.query': {
    group: 'inspect',
    tab: true,
    params: ['selector', 'withinRef', 'maxNodes', 'maxDepth', 'textBudget', 'includeBbox', 'attributeAllowlist']
  },
  'dom.describe': { group: 'inspect', tab: true, params: ['elementRef'] },
  'dom.get_text': { group: 'inspect', tab: true, params: ['elementRef', 'textBudget'] },
  'dom.get_attributes': { group: 'inspect', tab: true, params: ['elementRef', 'attributes'] },
  'dom.wait_for': { group: 'wait', tab: true, params: ['selector', 'text', 'state', 'timeoutMs'] },
  'dom.find_by_text': { group: 'inspect', tab: true, params: ['text', 'exact', 'selector', 'maxResults'] },
  'dom.find_by_role': { group: 'inspect', tab: true, params: ['role', 'name', 'selector', 'maxResults'] },
  'dom.get_html': { group: 'inspect', tab: true, params: ['elementRef', 'outer', 'maxLength'] },
  'dom.get_accessibility_tree': { group: 'inspect', tab: true, params: ['maxNodes', 'maxDepth'] },
  'layout.get_box_model': { group: 'inspect', tab: true, params: ['elementRef'] },
  'layout.hit_test': { group: 'inspect', tab: true, params: ['x', 'y'] },
  'styles.get_computed': { group: 'inspect', tab: true, params: ['elementRef', 'properties'] },
  'styles.get_matched_rules': { group: 'inspect', tab: true, params: ['elementRef'] },
  'viewport.scroll': { group: 'navigate', tab: true, params: ['target', 'top', 'left', 'behavior', 'relative'] },
  'viewport.resize': { group: 'navigate', tab: true, params: ['width', 'height', 'deviceScaleFactor', 'reset'] },
  'input.click': { group: 'interact', tab: true, params: ['target', 'button', 'clickCount', 'modifiers'] },
  'input.focus': { group: 'interact', tab: true, params: ['target'] },
  'input.type': { group: 'interact', tab: true, params: ['target', 'text', 'clear', 'submit', 'modifiers'] },
  'input.press_key': { group: 'interact', tab: true, params: ['target', 'key', 'modifiers'] },
  'input.set_checked': { group: 'interact', tab: true, params: ['target', 'checked'] },
  'input.select_option': { group: 'interact', tab: true, params: ['target', 'values', 'labels', 'indexes'] },
  'input.hover': { group: 'interact', tab: true, params: ['target', 'duration', 'modifiers'] },
  'input.drag': { group: 'interact', tab: true, params: ['source', 'destination', 'offsetX', 'offsetY'] },
  'screenshot.capture_region': { group: 'capture', tab: true, params: ['x', 'y', 'width', 'height'] },
  'screenshot.capture_element': { group: 'capture', tab: true, params: ['elementRef'] },
  'patch.apply_styles': { group: 'patch', tab: true, params: ['target', 'declarations', 'important', 'patchId'] },
  'patch.apply_dom': { group: 'patch', tab: true, params: ['target', 'operation', 'name', 'value', 'patchId'] },
  'patch.list': { group: 'patch', tab: true, params: [] },
  'patch.rollback': { group: 'patch', tab: true, params: ['patchId'] },
  'patch.commit_session_baseline': { group: 'patch', tab: true, params: [] },
  'cdp.get_document': { group: 'cdp', tab: true, params: [] },
  'cdp.get_dom_snapshot': { group: 'cdp', tab: true, params: [] },
  'cdp.get_box_model': { group: 'cdp', tab: true, params: ['elementRef'] },
  'cdp.get_computed_styles_for_node': { group: 'cdp', tab: true, params: ['elementRef'] },
  'performance.get_metrics': { group: 'performance', tab: true, params: [] },
  'log.tail': { group: 'system', tab: false, params: [] },
  'health.ping': { group: 'system', tab: false, params: [] }
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
