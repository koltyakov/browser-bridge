// @ts-check

/**
 * Canonical bridge method registry. This is the shared source of truth for
 * method grouping, session requirements, and exposed params so the protocol,
 * CLI, MCP layer, and docs can stay aligned.
 *
 * @type {Readonly<Record<import('./types.js').BridgeMethod, {
 *   group: string,
 *   session: boolean,
 *   params: readonly string[]
 * }>>}
 */
export const BRIDGE_METHOD_REGISTRY = Object.freeze({
  'tabs.list': { group: 'tabs', session: false, params: [] },
  'tabs.create': { group: 'tabs', session: false, params: ['url', 'active'] },
  'tabs.close': { group: 'tabs', session: false, params: ['tabId'] },
  'session.request_access': {
    group: 'session',
    session: false,
    params: ['tabId', 'origin', 'capabilities', 'ttlMs', 'label']
  },
  'session.get_status': { group: 'session', session: true, params: [] },
  'session.revoke': { group: 'session', session: true, params: [] },
  'skill.get_runtime_context': { group: 'session', session: false, params: [] },
  'setup.get_status': { group: 'session', session: false, params: [] },
  'setup.install': { group: 'session', session: false, params: ['kind', 'target'] },
  'page.get_state': { group: 'page', session: true, params: [] },
  'page.evaluate': {
    group: 'page',
    session: true,
    params: ['expression', 'awaitPromise', 'timeoutMs', 'returnByValue']
  },
  'page.get_console': { group: 'page', session: true, params: ['level', 'clear', 'limit'] },
  'page.wait_for_load_state': { group: 'wait', session: true, params: ['timeoutMs'] },
  'page.get_storage': { group: 'page', session: true, params: ['type', 'keys'] },
  'page.get_text': { group: 'page', session: true, params: ['textBudget'] },
  'page.get_network': { group: 'page', session: true, params: ['clear', 'limit', 'urlPattern'] },
  'navigation.navigate': { group: 'navigate', session: true, params: ['url', 'waitForLoad', 'timeoutMs'] },
  'navigation.reload': { group: 'navigate', session: true, params: ['waitForLoad', 'timeoutMs'] },
  'navigation.go_back': { group: 'navigate', session: true, params: ['waitForLoad', 'timeoutMs'] },
  'navigation.go_forward': { group: 'navigate', session: true, params: ['waitForLoad', 'timeoutMs'] },
  'dom.query': {
    group: 'inspect',
    session: true,
    params: ['selector', 'withinRef', 'maxNodes', 'maxDepth', 'textBudget', 'includeHtml', 'includeScreenshot', 'attributeAllowlist', 'styleAllowlist', 'includeRoles']
  },
  'dom.describe': { group: 'inspect', session: true, params: ['elementRef'] },
  'dom.get_text': { group: 'inspect', session: true, params: ['elementRef', 'textBudget'] },
  'dom.get_attributes': { group: 'inspect', session: true, params: ['elementRef', 'attributes'] },
  'dom.wait_for': { group: 'wait', session: true, params: ['selector', 'text', 'state', 'timeoutMs'] },
  'dom.find_by_text': { group: 'inspect', session: true, params: ['text', 'exact', 'selector', 'maxResults'] },
  'dom.find_by_role': { group: 'inspect', session: true, params: ['role', 'name', 'selector', 'maxResults'] },
  'dom.get_html': { group: 'inspect', session: true, params: ['elementRef', 'outer', 'maxLength'] },
  'dom.get_accessibility_tree': { group: 'inspect', session: true, params: ['maxNodes', 'maxDepth'] },
  'layout.get_box_model': { group: 'inspect', session: true, params: ['elementRef'] },
  'layout.hit_test': { group: 'inspect', session: true, params: ['x', 'y'] },
  'styles.get_computed': { group: 'inspect', session: true, params: ['elementRef', 'properties'] },
  'styles.get_matched_rules': { group: 'inspect', session: true, params: ['elementRef'] },
  'viewport.scroll': { group: 'navigate', session: true, params: ['target', 'top', 'left', 'behavior', 'relative'] },
  'viewport.resize': { group: 'navigate', session: true, params: ['width', 'height', 'deviceScaleFactor', 'reset'] },
  'input.click': { group: 'interact', session: true, params: ['target', 'button', 'clickCount', 'modifiers'] },
  'input.focus': { group: 'interact', session: true, params: ['target'] },
  'input.type': { group: 'interact', session: true, params: ['target', 'text', 'clear', 'submit', 'modifiers'] },
  'input.press_key': { group: 'interact', session: true, params: ['target', 'key', 'modifiers'] },
  'input.set_checked': { group: 'interact', session: true, params: ['target', 'checked'] },
  'input.select_option': { group: 'interact', session: true, params: ['target', 'values', 'labels', 'indexes'] },
  'input.hover': { group: 'interact', session: true, params: ['target', 'duration', 'modifiers'] },
  'input.drag': { group: 'interact', session: true, params: ['source', 'destination', 'offsetX', 'offsetY'] },
  'screenshot.capture_region': { group: 'capture', session: true, params: ['x', 'y', 'width', 'height'] },
  'screenshot.capture_element': { group: 'capture', session: true, params: ['elementRef'] },
  'patch.apply_styles': { group: 'patch', session: true, params: ['target', 'declarations', 'important', 'patchId'] },
  'patch.apply_dom': { group: 'patch', session: true, params: ['target', 'operation', 'name', 'value', 'patchId'] },
  'patch.list': { group: 'patch', session: true, params: [] },
  'patch.rollback': { group: 'patch', session: true, params: ['patchId'] },
  'patch.commit_session_baseline': { group: 'patch', session: true, params: [] },
  'cdp.get_document': { group: 'cdp', session: true, params: [] },
  'cdp.get_dom_snapshot': { group: 'cdp', session: true, params: [] },
  'cdp.get_box_model': { group: 'cdp', session: true, params: ['elementRef'] },
  'cdp.get_computed_styles_for_node': { group: 'cdp', session: true, params: ['elementRef'] },
  'performance.get_metrics': { group: 'performance', session: true, params: [] },
  'log.tail': { group: 'session', session: false, params: [] },
  'health.ping': { group: 'session', session: false, params: [] }
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
export function bridgeMethodNeedsSession(method) {
  return isBridgeMethod(method) ? BRIDGE_METHOD_REGISTRY[method].session : true;
}
