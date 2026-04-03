// @ts-check

/**
 * @typedef {'trivial' | 'low' | 'moderate' | 'high'} BridgeMethodComplexity
 */

/**
 * @typedef {{
 *   group: string,
 *   tab: boolean,
 *   params: readonly string[],
 *   description: string,
 *   since: string,
 *   complexity: BridgeMethodComplexity
 * }} BridgeMethodRegistryEntry
 */

/**
 * Canonical bridge method registry. This is the shared source of truth for
 * method grouping, tab-routing requirements, and exposed params so the protocol,
 * CLI, MCP layer, and docs can stay aligned.
 *
 * @type {Readonly<Record<import('./types.js').BridgeMethod, string>>}
 */
const BRIDGE_METHOD_DESCRIPTIONS = Object.freeze({
  'access.request': 'Request Browser Bridge access for the focused window. Do not repeat while access is already pending.',
  'tabs.list': 'List tabs in the enabled window.',
  'tabs.create': 'Create a new tab in the enabled window.',
  'tabs.close': 'Close a tab in the enabled window.',
  'skill.get_runtime_context': 'Return runtime method groups, budgets, and limits.',
  'setup.get_status': 'Return MCP and skill setup status.',
  'setup.install': 'Install or uninstall MCP or skill integration targets.',
  'page.get_state': 'Get URL, title, origin, and ready-state for the active page.',
  'page.evaluate': 'Evaluate JavaScript in the page context.',
  'page.get_console': 'Read buffered console output from the page.',
  'page.wait_for_load_state': 'Wait for the page to finish loading.',
  'page.get_storage': 'Read local or session storage values.',
  'page.get_text': 'Read bounded visible text from the page.',
  'page.get_network': 'Read buffered fetch and XHR network activity.',
  'navigation.navigate': 'Navigate the current tab to a URL.',
  'navigation.reload': 'Reload the current tab.',
  'navigation.go_back': 'Navigate backward in tab history.',
  'navigation.go_forward': 'Navigate forward in tab history.',
  'dom.query': 'Query a DOM subtree and return compact node summaries.',
  'dom.describe': 'Describe one element by elementRef.',
  'dom.get_text': 'Read bounded text for one element.',
  'dom.get_attributes': 'Read selected attributes for one element.',
  'dom.wait_for': 'Wait for a selector or text condition in the DOM.',
  'dom.find_by_text': 'Find elements by visible text.',
  'dom.find_by_role': 'Find elements by ARIA role and optional name.',
  'dom.get_html': 'Read inner or outer HTML for one element.',
  'dom.get_accessibility_tree': 'Read a pruned accessibility tree for the tab.',
  'layout.get_box_model': 'Read the box model for one element.',
  'layout.hit_test': 'Resolve the topmost element at a viewport point.',
  'styles.get_computed': 'Read computed style properties for one element.',
  'styles.get_matched_rules': 'Read matched CSS rule context for one element.',
  'viewport.scroll': 'Scroll the viewport or a scrollable element.',
  'viewport.resize': 'Resize or reset the tab viewport.',
  'input.click': 'Click an element.',
  'input.focus': 'Focus an element.',
  'input.type': 'Type text into an element.',
  'input.press_key': 'Send a key press to the page or an element.',
  'input.set_checked': 'Set checkbox or radio checked state.',
  'input.select_option': 'Select options in a select element.',
  'input.hover': 'Hover over an element.',
  'input.drag': 'Drag from one element to another.',
  'input.scroll_into_view': 'Scroll an element into the visible viewport.',
  'screenshot.capture_region': 'Capture a screenshot of a viewport region.',
  'screenshot.capture_element': 'Capture a screenshot of one element.',
  'screenshot.capture_full_page': 'Capture a full-page screenshot beyond the viewport.',
  'patch.apply_styles': 'Apply a reversible inline style patch.',
  'patch.apply_dom': 'Apply a reversible DOM patch.',
  'patch.list': 'List active reversible patches.',
  'patch.rollback': 'Rollback one reversible patch.',
  'patch.commit_session_baseline': 'Commit the current patch session baseline.',
  'cdp.get_document': 'Read the CDP DOM document tree.',
  'cdp.get_dom_snapshot': 'Read a CDP DOM snapshot.',
  'cdp.get_box_model': 'Read a CDP box model for a node.',
  'cdp.get_computed_styles_for_node': 'Read CDP computed styles for a node.',
  'performance.get_metrics': 'Read browser performance metrics.',
  'log.tail': 'Tail recent bridge log entries.',
  'health.ping': 'Check daemon, extension, and access-routing health.'
});

/**
 * @param {import('./types.js').BridgeMethod} method
 * @param {string} group
 * @param {boolean} tab
 * @param {readonly string[]} params
 * @param {BridgeMethodComplexity} [complexity='low']
 * @returns {BridgeMethodRegistryEntry}
 */
function createRegistryEntry(method, group, tab, params, complexity = 'low') {
  return {
    group,
    tab,
    params,
    description: BRIDGE_METHOD_DESCRIPTIONS[method],
    since: '1.0',
    complexity,
  };
}

/** @type {Readonly<Record<import('./types.js').BridgeMethod, BridgeMethodRegistryEntry>>} */
export const BRIDGE_METHOD_REGISTRY = Object.freeze({
  // system — trivial
  'access.request': createRegistryEntry('access.request', 'system', false, [], 'trivial'),
  'skill.get_runtime_context': createRegistryEntry('skill.get_runtime_context', 'system', false, [], 'trivial'),
  'setup.get_status': createRegistryEntry('setup.get_status', 'system', false, [], 'trivial'),
  'setup.install': createRegistryEntry('setup.install', 'system', false, ['kind', 'target'], 'trivial'),
  'log.tail': createRegistryEntry('log.tail', 'system', false, [], 'trivial'),
  'health.ping': createRegistryEntry('health.ping', 'system', false, [], 'trivial'),
  // tabs — trivial
  'tabs.list': createRegistryEntry('tabs.list', 'tabs', false, [], 'trivial'),
  'tabs.create': createRegistryEntry('tabs.create', 'tabs', false, ['url', 'active'], 'trivial'),
  'tabs.close': createRegistryEntry('tabs.close', 'tabs', false, ['tabId'], 'trivial'),
  // page — low (basic reads), moderate (evaluate, debugger-backed)
  'page.get_state': createRegistryEntry('page.get_state', 'page', true, [], 'low'),
  'page.evaluate': {
    ...createRegistryEntry('page.evaluate', 'page', true, ['expression', 'awaitPromise', 'timeoutMs', 'returnByValue'], 'moderate')
  },
  'page.get_console': createRegistryEntry('page.get_console', 'page', true, ['level', 'clear', 'limit'], 'low'),
  'page.wait_for_load_state': createRegistryEntry('page.wait_for_load_state', 'wait', true, ['timeoutMs'], 'low'),
  'page.get_storage': createRegistryEntry('page.get_storage', 'page', true, ['type', 'keys'], 'low'),
  'page.get_text': createRegistryEntry('page.get_text', 'page', true, ['textBudget'], 'low'),
  'page.get_network': createRegistryEntry('page.get_network', 'page', true, ['clear', 'limit', 'urlPattern'], 'low'),
  // navigation — low
  'navigation.navigate': createRegistryEntry('navigation.navigate', 'navigate', true, ['url', 'waitForLoad', 'timeoutMs'], 'low'),
  'navigation.reload': createRegistryEntry('navigation.reload', 'navigate', true, ['waitForLoad', 'timeoutMs'], 'low'),
  'navigation.go_back': createRegistryEntry('navigation.go_back', 'navigate', true, ['waitForLoad', 'timeoutMs'], 'low'),
  'navigation.go_forward': createRegistryEntry('navigation.go_forward', 'navigate', true, ['waitForLoad', 'timeoutMs'], 'low'),
  // dom — low (reads), moderate (accessibility tree)
  'dom.query': {
    ...createRegistryEntry('dom.query', 'inspect', true, ['selector', 'withinRef', 'maxNodes', 'maxDepth', 'textBudget', 'includeBbox', 'attributeAllowlist'], 'low')
  },
  'dom.describe': createRegistryEntry('dom.describe', 'inspect', true, ['elementRef'], 'low'),
  'dom.get_text': createRegistryEntry('dom.get_text', 'inspect', true, ['elementRef', 'textBudget'], 'low'),
  'dom.get_attributes': createRegistryEntry('dom.get_attributes', 'inspect', true, ['elementRef', 'attributes'], 'low'),
  'dom.wait_for': createRegistryEntry('dom.wait_for', 'wait', true, ['selector', 'text', 'state', 'timeoutMs'], 'low'),
  'dom.find_by_text': createRegistryEntry('dom.find_by_text', 'inspect', true, ['text', 'exact', 'selector', 'maxResults'], 'low'),
  'dom.find_by_role': createRegistryEntry('dom.find_by_role', 'inspect', true, ['role', 'name', 'selector', 'maxResults'], 'low'),
  'dom.get_html': createRegistryEntry('dom.get_html', 'inspect', true, ['elementRef', 'outer', 'maxLength'], 'low'),
  'dom.get_accessibility_tree': createRegistryEntry('dom.get_accessibility_tree', 'inspect', true, ['maxNodes', 'maxDepth'], 'moderate'),
  // layout — low
  'layout.get_box_model': createRegistryEntry('layout.get_box_model', 'inspect', true, ['elementRef'], 'low'),
  'layout.hit_test': createRegistryEntry('layout.hit_test', 'inspect', true, ['x', 'y'], 'low'),
  // styles — low (computed), moderate (matched rules)
  'styles.get_computed': createRegistryEntry('styles.get_computed', 'inspect', true, ['elementRef', 'properties'], 'low'),
  'styles.get_matched_rules': createRegistryEntry('styles.get_matched_rules', 'inspect', true, ['elementRef'], 'moderate'),
  // viewport — low (scroll), moderate (resize, debugger-backed)
  'viewport.scroll': createRegistryEntry('viewport.scroll', 'navigate', true, ['target', 'top', 'left', 'behavior', 'relative'], 'low'),
  'viewport.resize': createRegistryEntry('viewport.resize', 'navigate', true, ['width', 'height', 'deviceScaleFactor', 'reset'], 'moderate'),
  // input — low (simple), moderate (drag)
  'input.click': createRegistryEntry('input.click', 'interact', true, ['target', 'button', 'clickCount', 'modifiers'], 'low'),
  'input.focus': createRegistryEntry('input.focus', 'interact', true, ['target'], 'low'),
  'input.type': createRegistryEntry('input.type', 'interact', true, ['target', 'text', 'clear', 'submit', 'modifiers'], 'low'),
  'input.press_key': createRegistryEntry('input.press_key', 'interact', true, ['target', 'key', 'modifiers'], 'low'),
  'input.set_checked': createRegistryEntry('input.set_checked', 'interact', true, ['target', 'checked'], 'low'),
  'input.select_option': createRegistryEntry('input.select_option', 'interact', true, ['target', 'values', 'labels', 'indexes'], 'low'),
  'input.hover': createRegistryEntry('input.hover', 'interact', true, ['target', 'duration', 'modifiers'], 'low'),
  'input.drag': createRegistryEntry('input.drag', 'interact', true, ['source', 'destination', 'offsetX', 'offsetY'], 'moderate'),
  'input.scroll_into_view': createRegistryEntry('input.scroll_into_view', 'interact', true, ['target'], 'low'),
  // capture — high (screenshots, CDP)
  'screenshot.capture_region': createRegistryEntry('screenshot.capture_region', 'capture', true, ['x', 'y', 'width', 'height'], 'high'),
  'screenshot.capture_element': createRegistryEntry('screenshot.capture_element', 'capture', true, ['elementRef'], 'high'),
  'screenshot.capture_full_page': createRegistryEntry('screenshot.capture_full_page', 'capture', true, [], 'high'),
  // patch — moderate (side effects)
  'patch.apply_styles': createRegistryEntry('patch.apply_styles', 'patch', true, ['target', 'declarations', 'important', 'patchId', 'verify'], 'moderate'),
  'patch.apply_dom': createRegistryEntry('patch.apply_dom', 'patch', true, ['target', 'operation', 'name', 'value', 'patchId', 'verify'], 'moderate'),
  'patch.list': createRegistryEntry('patch.list', 'patch', true, [], 'low'),
  'patch.rollback': createRegistryEntry('patch.rollback', 'patch', true, ['patchId'], 'low'),
  'patch.commit_session_baseline': createRegistryEntry('patch.commit_session_baseline', 'patch', true, [], 'low'),
  // cdp — high (raw protocol, large payloads)
  'cdp.get_document': createRegistryEntry('cdp.get_document', 'cdp', true, [], 'high'),
  'cdp.get_dom_snapshot': createRegistryEntry('cdp.get_dom_snapshot', 'cdp', true, [], 'high'),
  'cdp.get_box_model': createRegistryEntry('cdp.get_box_model', 'cdp', true, ['elementRef'], 'high'),
  'cdp.get_computed_styles_for_node': createRegistryEntry('cdp.get_computed_styles_for_node', 'cdp', true, ['elementRef'], 'high'),
  // performance — moderate (debugger-backed)
  'performance.get_metrics': createRegistryEntry('performance.get_metrics', 'performance', true, [], 'moderate'),
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

/** @type {readonly BridgeMethodComplexity[]} */
const COMPLEXITY_LEVELS = ['trivial', 'low', 'moderate', 'high'];

/**
 * Return all bridge methods at or below the given complexity level.
 *
 * @param {BridgeMethodComplexity} maxComplexity
 * @returns {import('./types.js').BridgeMethod[]}
 */
export function getMethodsByMaxComplexity(maxComplexity) {
  const maxIndex = COMPLEXITY_LEVELS.indexOf(maxComplexity);
  return BRIDGE_METHODS.filter(m =>
    COMPLEXITY_LEVELS.indexOf(BRIDGE_METHOD_REGISTRY[m].complexity) <= maxIndex
  );
}
