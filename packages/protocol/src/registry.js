// @ts-check

import { CAPABILITIES } from './capability-values.js';

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
 *   complexity: BridgeMethodComplexity,
 *   capability: import('./types.js').Capability | null,
 *   debuggerBacked: boolean
 * }} BridgeMethodRegistryEntry
 */

/**
 * @typedef {{
 *   capability: import('./types.js').Capability | null,
 *   debuggerBacked?: boolean
 * }} BridgeMethodPolicy
 */

/** @type {Readonly<Record<string, Readonly<BridgeMethodPolicy>>>} */
const METHOD_POLICIES = Object.freeze({
  none: Object.freeze({ capability: null }),
  tabsManage: Object.freeze({ capability: CAPABILITIES.TABS_MANAGE }),
  pageRead: Object.freeze({ capability: CAPABILITIES.PAGE_READ }),
  pageEvaluateDebugger: Object.freeze({
    capability: CAPABILITIES.PAGE_EVALUATE,
    debuggerBacked: true,
  }),
  networkRead: Object.freeze({ capability: CAPABILITIES.NETWORK_READ }),
  networkInterceptDebugger: Object.freeze({
    capability: CAPABILITIES.NETWORK_INTERCEPT,
    debuggerBacked: true,
  }),
  navigationControl: Object.freeze({ capability: CAPABILITIES.NAVIGATION_CONTROL }),
  navigationControlDebugger: Object.freeze({
    capability: CAPABILITIES.NAVIGATION_CONTROL,
    debuggerBacked: true,
  }),
  domRead: Object.freeze({ capability: CAPABILITIES.DOM_READ }),
  domReadDebugger: Object.freeze({
    capability: CAPABILITIES.DOM_READ,
    debuggerBacked: true,
  }),
  layoutRead: Object.freeze({ capability: CAPABILITIES.LAYOUT_READ }),
  stylesRead: Object.freeze({ capability: CAPABILITIES.STYLES_READ }),
  viewportControl: Object.freeze({ capability: CAPABILITIES.VIEWPORT_CONTROL }),
  viewportControlDebugger: Object.freeze({
    capability: CAPABILITIES.VIEWPORT_CONTROL,
    debuggerBacked: true,
  }),
  automationInput: Object.freeze({ capability: CAPABILITIES.AUTOMATION_INPUT }),
  screenshotPartialDebugger: Object.freeze({
    capability: CAPABILITIES.SCREENSHOT_PARTIAL,
    debuggerBacked: true,
  }),
  patchDom: Object.freeze({ capability: CAPABILITIES.PATCH_DOM }),
  patchStyles: Object.freeze({ capability: CAPABILITIES.PATCH_STYLES }),
  cdpDomSnapshotDebugger: Object.freeze({
    capability: CAPABILITIES.CDP_DOM_SNAPSHOT,
    debuggerBacked: true,
  }),
  cdpBoxModelDebugger: Object.freeze({
    capability: CAPABILITIES.CDP_BOX_MODEL,
    debuggerBacked: true,
  }),
  cdpStylesDebugger: Object.freeze({
    capability: CAPABILITIES.CDP_STYLES,
    debuggerBacked: true,
  }),
  cdpInputDebugger: Object.freeze({
    capability: CAPABILITIES.CDP_INPUT,
    debuggerBacked: true,
  }),
  performanceReadDebugger: Object.freeze({
    capability: CAPABILITIES.PERFORMANCE_READ,
    debuggerBacked: true,
  }),
});

/**
 * Canonical bridge method registry. This is the shared source of truth for
 * method grouping, tab-routing requirements, exposed params, capability mapping,
 * and debugger policy so the protocol, CLI, MCP layer, and docs can stay aligned.
 *
 * @type {Readonly<Record<import('./types.js').BridgeMethod, string>>}
 */
const BRIDGE_METHOD_DESCRIPTIONS = Object.freeze({
  'access.request':
    'Request Browser Bridge access for the focused window. Do not repeat while access is already pending.',
  'tabs.list': 'List tabs in the enabled window.',
  'tabs.create': 'Create a new tab in the enabled window.',
  'tabs.close': 'Close a tab in the enabled window.',
  'tabs.activate': 'Bring a tab to the foreground in the enabled window.',
  'skill.get_runtime_context': 'Return runtime method groups, budgets, and limits.',
  'setup.get_status': 'Return MCP and skill setup status.',
  'setup.install': 'Install or uninstall MCP or skill integration targets.',
  'page.get_state': 'Get URL, title, origin, and ready-state for the active page.',
  'page.evaluate': 'Evaluate JavaScript in the page context.',
  'page.get_console': 'Read buffered console output from the page.',
  'page.handle_dialog':
    'Inspect or explicitly act on the current JavaScript dialog. expectedDialogId is only a stale-decision check immediately before dispatch; Chrome cannot bind the CDP command atomically to that identifier.',
  'page.wait_for_load_state':
    'Wait for truthful tab-complete state and/or an event-aware URL condition.',
  'page.get_storage': 'Read local or session storage values.',
  'page.get_text': 'Read bounded visible text from the page.',
  'page.get_network':
    'Read buffered fetch/XHR activity or explicitly manage bounded all-resource CDP capture.',
  'network.intercept.add': 'Add a request interception rule (CDP Fetch domain).',
  'network.intercept.remove': 'Remove a request interception rule by ID.',
  'network.intercept.list': 'List active interception rules.',
  'network.intercept.clear': 'Remove all interception rules and disable interception.',
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
  'dom.get_accessibility_tree':
    'Read a depth-limited accessibility tree with optional compact or interactive filtering.',
  'layout.get_box_model': 'Read the box model for one element.',
  'layout.hit_test': 'Resolve the topmost element at a viewport point.',
  'styles.get_computed':
    'Read requested computed styles; omission returns display, position, width, height, and color.',
  'styles.get_matched_rules':
    'Read element classes and inline style context (not stylesheet cascade data).',
  'viewport.scroll': 'Scroll the viewport or a scrollable element.',
  'viewport.resize': 'Resize or reset the tab viewport.',
  'input.click': 'Actionability-check and click an element through DOM or optional CDP input.',
  'input.focus': 'Actionability-check and focus an element through DOM input.',
  'input.type': 'Actionability-check and type through DOM or optional CDP text input.',
  'input.fill':
    'Fill an editable target using a DOM strategy or optional CDP text input; verify afterward.',
  'input.press_key': 'Send a key press to the page or an element.',
  'input.set_checked': 'Set checkbox or radio checked state.',
  'input.select_option': 'Select options in a select element.',
  'input.hover': 'Actionability-check and hover through DOM or optional CDP pointer input.',
  'input.drag': 'Actionability-check and drag through DOM or optional CDP pointer input.',
  'input.scroll_into_view': 'Scroll an element into the visible viewport.',
  'screenshot.capture_region': 'Capture a screenshot of a viewport region.',
  'screenshot.capture_element': 'Capture a screenshot of one element.',
  'screenshot.capture_full_page': 'Capture a full-page screenshot beyond the viewport.',
  'patch.apply_styles': 'Apply a reversible inline style patch.',
  'patch.apply_dom': 'Apply a reversible DOM patch.',
  'patch.list': 'List active reversible patches.',
  'patch.rollback': 'Rollback one reversible patch.',
  'patch.commit_session_baseline':
    'Keep current document mutations and discard their rollback history.',
  'cdp.get_document': 'Read the CDP DOM document tree.',
  'cdp.get_dom_snapshot': 'Read a CDP DOM snapshot.',
  'cdp.get_box_model': 'Read a CDP box model for a node.',
  'cdp.get_computed_styles_for_node': 'Read CDP computed styles for a node.',
  'cdp.dispatch_key_event': 'Dispatch a key press through Chrome DevTools Protocol input.',
  'performance.get_metrics': 'Read browser performance metrics.',
  'log.tail': 'Tail recent bridge log entries.',
  'health.ping': 'Check daemon, extension, and access-routing health.',
  'daemon.metrics': 'Daemon health and performance metrics.',
});

/**
 * @param {import('./types.js').BridgeMethod} method
 * @param {string} group
 * @param {boolean} tab
 * @param {readonly string[]} params
 * @param {BridgeMethodComplexity} [complexity='low']
 * @param {Readonly<BridgeMethodPolicy>} [policy=METHOD_POLICIES.none]
 * @returns {BridgeMethodRegistryEntry}
 */
function createRegistryEntry(
  method,
  group,
  tab,
  params,
  complexity = 'low',
  policy = METHOD_POLICIES.none
) {
  const entry = {
    group,
    tab,
    params,
    description: BRIDGE_METHOD_DESCRIPTIONS[method],
    since: '1.0',
    complexity,
  };

  return /** @type {BridgeMethodRegistryEntry} */ (
    Object.defineProperties(entry, {
      capability: { value: policy.capability },
      debuggerBacked: { value: policy.debuggerBacked ?? false },
    })
  );
}

/** @type {Readonly<Record<import('./types.js').BridgeMethod, BridgeMethodRegistryEntry>>} */
export const BRIDGE_METHOD_REGISTRY = Object.freeze({
  // system - trivial
  'access.request': createRegistryEntry('access.request', 'system', false, [], 'trivial'),
  'skill.get_runtime_context': createRegistryEntry(
    'skill.get_runtime_context',
    'system',
    false,
    [],
    'trivial'
  ),
  'setup.get_status': createRegistryEntry('setup.get_status', 'system', false, [], 'trivial'),
  'setup.install': createRegistryEntry(
    'setup.install',
    'system',
    false,
    ['action', 'kind', 'target'],
    'trivial'
  ),
  'log.tail': createRegistryEntry('log.tail', 'system', false, ['limit'], 'trivial'),
  'health.ping': createRegistryEntry('health.ping', 'system', false, [], 'trivial'),
  'daemon.metrics': createRegistryEntry('daemon.metrics', 'system', false, [], 'trivial'),
  // tabs - trivial
  'tabs.list': createRegistryEntry('tabs.list', 'tabs', false, [], 'trivial'),
  'tabs.create': createRegistryEntry(
    'tabs.create',
    'tabs',
    false,
    ['url', 'active'],
    'trivial',
    METHOD_POLICIES.tabsManage
  ),
  'tabs.close': createRegistryEntry(
    'tabs.close',
    'tabs',
    false,
    ['tabId'],
    'trivial',
    METHOD_POLICIES.tabsManage
  ),
  'tabs.activate': createRegistryEntry(
    'tabs.activate',
    'tabs',
    false,
    ['tabId'],
    'trivial',
    METHOD_POLICIES.tabsManage
  ),
  // page - low (basic reads), moderate (evaluate, debugger-backed)
  'page.get_state': createRegistryEntry(
    'page.get_state',
    'page',
    true,
    [],
    'low',
    METHOD_POLICIES.pageRead
  ),
  'page.evaluate': createRegistryEntry(
    'page.evaluate',
    'page',
    true,
    ['expression', 'awaitPromise', 'timeoutMs', 'returnByValue'],
    'moderate',
    METHOD_POLICIES.pageEvaluateDebugger
  ),
  'page.get_console': createRegistryEntry(
    'page.get_console',
    'page',
    true,
    ['level', 'clear', 'limit'],
    'low',
    METHOD_POLICIES.pageRead
  ),
  'page.handle_dialog': createRegistryEntry(
    'page.handle_dialog',
    'page',
    true,
    ['action', 'promptText', 'expectedDialogId'],
    'low',
    METHOD_POLICIES.navigationControlDebugger
  ),
  'page.wait_for_load_state': createRegistryEntry(
    'page.wait_for_load_state',
    'wait',
    true,
    ['waitForLoad', 'timeoutMs', 'url', 'urlMatch'],
    'low',
    METHOD_POLICIES.pageRead
  ),
  'page.get_storage': createRegistryEntry(
    'page.get_storage',
    'page',
    true,
    ['type', 'keys'],
    'low',
    METHOD_POLICIES.pageRead
  ),
  'page.get_text': createRegistryEntry(
    'page.get_text',
    'page',
    true,
    ['textBudget'],
    'low',
    METHOD_POLICIES.pageRead
  ),
  'page.get_network': createRegistryEntry(
    'page.get_network',
    'page',
    true,
    ['clear', 'limit', 'urlPattern', 'source', 'capture'],
    'low',
    METHOD_POLICIES.networkRead
  ),
  // network intercept - moderate (holds debugger session)
  'network.intercept.add': createRegistryEntry(
    'network.intercept.add',
    'page',
    true,
    ['urlPattern', 'action', 'statusCode', 'body', 'headers'],
    'moderate',
    METHOD_POLICIES.networkInterceptDebugger
  ),
  'network.intercept.remove': createRegistryEntry(
    'network.intercept.remove',
    'page',
    true,
    ['ruleId'],
    'trivial',
    METHOD_POLICIES.networkInterceptDebugger
  ),
  'network.intercept.list': createRegistryEntry(
    'network.intercept.list',
    'page',
    true,
    [],
    'trivial',
    METHOD_POLICIES.networkInterceptDebugger
  ),
  'network.intercept.clear': createRegistryEntry(
    'network.intercept.clear',
    'page',
    true,
    [],
    'low',
    METHOD_POLICIES.networkInterceptDebugger
  ),
  // navigation - low
  'navigation.navigate': createRegistryEntry(
    'navigation.navigate',
    'navigate',
    true,
    ['url', 'waitForLoad', 'timeoutMs'],
    'low',
    METHOD_POLICIES.navigationControl
  ),
  'navigation.reload': createRegistryEntry(
    'navigation.reload',
    'navigate',
    true,
    ['waitForLoad', 'timeoutMs'],
    'low',
    METHOD_POLICIES.navigationControl
  ),
  'navigation.go_back': createRegistryEntry(
    'navigation.go_back',
    'navigate',
    true,
    ['waitForLoad', 'timeoutMs'],
    'low',
    METHOD_POLICIES.navigationControl
  ),
  'navigation.go_forward': createRegistryEntry(
    'navigation.go_forward',
    'navigate',
    true,
    ['waitForLoad', 'timeoutMs'],
    'low',
    METHOD_POLICIES.navigationControl
  ),
  // dom - low (reads), moderate (accessibility tree)
  'dom.query': createRegistryEntry(
    'dom.query',
    'inspect',
    true,
    [
      'selector',
      'withinRef',
      'maxNodes',
      'maxDepth',
      'textBudget',
      'includeBbox',
      'attributeAllowlist',
    ],
    'low',
    METHOD_POLICIES.domRead
  ),
  'dom.describe': createRegistryEntry(
    'dom.describe',
    'inspect',
    true,
    ['elementRef', 'target'],
    'low',
    METHOD_POLICIES.domRead
  ),
  'dom.get_text': createRegistryEntry(
    'dom.get_text',
    'inspect',
    true,
    ['elementRef', 'target', 'textBudget'],
    'low',
    METHOD_POLICIES.domRead
  ),
  'dom.get_attributes': createRegistryEntry(
    'dom.get_attributes',
    'inspect',
    true,
    ['elementRef', 'target', 'attributes'],
    'low',
    METHOD_POLICIES.domRead
  ),
  'dom.wait_for': createRegistryEntry(
    'dom.wait_for',
    'wait',
    true,
    ['selector', 'text', 'state', 'timeoutMs'],
    'low',
    METHOD_POLICIES.domRead
  ),
  'dom.find_by_text': createRegistryEntry(
    'dom.find_by_text',
    'inspect',
    true,
    ['text', 'exact', 'selector', 'maxResults'],
    'low',
    METHOD_POLICIES.domRead
  ),
  'dom.find_by_role': createRegistryEntry(
    'dom.find_by_role',
    'inspect',
    true,
    ['role', 'name', 'selector', 'maxResults'],
    'low',
    METHOD_POLICIES.domRead
  ),
  'dom.get_html': createRegistryEntry(
    'dom.get_html',
    'inspect',
    true,
    ['elementRef', 'target', 'outer', 'maxLength'],
    'low',
    METHOD_POLICIES.domRead
  ),
  'dom.get_accessibility_tree': createRegistryEntry(
    'dom.get_accessibility_tree',
    'inspect',
    true,
    ['maxNodes', 'maxDepth', 'compact', 'interactiveOnly'],
    'moderate',
    METHOD_POLICIES.domReadDebugger
  ),
  // layout - low
  'layout.get_box_model': createRegistryEntry(
    'layout.get_box_model',
    'inspect',
    true,
    ['elementRef', 'target'],
    'low',
    METHOD_POLICIES.layoutRead
  ),
  'layout.hit_test': createRegistryEntry(
    'layout.hit_test',
    'inspect',
    true,
    ['x', 'y'],
    'low',
    METHOD_POLICIES.layoutRead
  ),
  // styles - low (computed), moderate (matched rules)
  'styles.get_computed': createRegistryEntry(
    'styles.get_computed',
    'inspect',
    true,
    ['elementRef', 'target', 'properties'],
    'low',
    METHOD_POLICIES.stylesRead
  ),
  'styles.get_matched_rules': createRegistryEntry(
    'styles.get_matched_rules',
    'inspect',
    true,
    ['elementRef', 'target'],
    'moderate',
    METHOD_POLICIES.stylesRead
  ),
  // viewport - low (scroll), moderate (resize, debugger-backed)
  'viewport.scroll': createRegistryEntry(
    'viewport.scroll',
    'navigate',
    true,
    ['target', 'top', 'left', 'behavior', 'relative'],
    'low',
    METHOD_POLICIES.viewportControl
  ),
  'viewport.resize': createRegistryEntry(
    'viewport.resize',
    'navigate',
    true,
    ['width', 'height', 'deviceScaleFactor', 'reset'],
    'moderate',
    METHOD_POLICIES.viewportControlDebugger
  ),
  // input - low (simple), moderate (drag)
  'input.click': createRegistryEntry(
    'input.click',
    'interact',
    true,
    ['target', 'button', 'clickCount', 'modifiers', 'executionMode', 'recoverStale'],
    'low',
    METHOD_POLICIES.automationInput
  ),
  'input.focus': createRegistryEntry(
    'input.focus',
    'interact',
    true,
    ['target', 'executionMode', 'recoverStale'],
    'low',
    METHOD_POLICIES.automationInput
  ),
  'input.type': createRegistryEntry(
    'input.type',
    'interact',
    true,
    ['target', 'text', 'clear', 'submit', 'modifiers', 'executionMode', 'recoverStale'],
    'low',
    METHOD_POLICIES.automationInput
  ),
  'input.fill': createRegistryEntry(
    'input.fill',
    'interact',
    true,
    ['target', 'value', 'mode', 'executionMode', 'recoverStale'],
    'low',
    METHOD_POLICIES.automationInput
  ),
  'input.press_key': createRegistryEntry(
    'input.press_key',
    'interact',
    true,
    ['target', 'key', 'modifiers', 'executionMode', 'recoverStale'],
    'low',
    METHOD_POLICIES.automationInput
  ),
  'input.set_checked': createRegistryEntry(
    'input.set_checked',
    'interact',
    true,
    ['target', 'checked', 'executionMode', 'recoverStale'],
    'low',
    METHOD_POLICIES.automationInput
  ),
  'input.select_option': createRegistryEntry(
    'input.select_option',
    'interact',
    true,
    ['target', 'values', 'labels', 'indexes', 'executionMode', 'recoverStale'],
    'low',
    METHOD_POLICIES.automationInput
  ),
  'input.hover': createRegistryEntry(
    'input.hover',
    'interact',
    true,
    ['target', 'duration', 'modifiers', 'executionMode', 'recoverStale'],
    'low',
    METHOD_POLICIES.automationInput
  ),
  'input.drag': createRegistryEntry(
    'input.drag',
    'interact',
    true,
    ['source', 'destination', 'offsetX', 'offsetY', 'executionMode', 'recoverStale'],
    'moderate',
    METHOD_POLICIES.automationInput
  ),
  'input.scroll_into_view': createRegistryEntry(
    'input.scroll_into_view',
    'interact',
    true,
    ['target'],
    'low',
    METHOD_POLICIES.automationInput
  ),
  // capture - high (screenshots, CDP)
  'screenshot.capture_region': createRegistryEntry(
    'screenshot.capture_region',
    'capture',
    true,
    ['x', 'y', 'width', 'height'],
    'high',
    METHOD_POLICIES.screenshotPartialDebugger
  ),
  'screenshot.capture_element': createRegistryEntry(
    'screenshot.capture_element',
    'capture',
    true,
    ['elementRef'],
    'high',
    METHOD_POLICIES.screenshotPartialDebugger
  ),
  'screenshot.capture_full_page': createRegistryEntry(
    'screenshot.capture_full_page',
    'capture',
    true,
    [],
    'high',
    METHOD_POLICIES.screenshotPartialDebugger
  ),
  // patch - moderate (side effects)
  'patch.apply_styles': createRegistryEntry(
    'patch.apply_styles',
    'patch',
    true,
    ['target', 'declarations', 'important', 'patchId', 'verify'],
    'moderate',
    METHOD_POLICIES.patchStyles
  ),
  'patch.apply_dom': createRegistryEntry(
    'patch.apply_dom',
    'patch',
    true,
    ['target', 'operation', 'name', 'value', 'patchId', 'verify'],
    'moderate',
    METHOD_POLICIES.patchDom
  ),
  'patch.list': createRegistryEntry(
    'patch.list',
    'patch',
    true,
    [],
    'low',
    METHOD_POLICIES.patchDom
  ),
  'patch.rollback': createRegistryEntry(
    'patch.rollback',
    'patch',
    true,
    ['patchId'],
    'low',
    METHOD_POLICIES.patchDom
  ),
  'patch.commit_session_baseline': createRegistryEntry(
    'patch.commit_session_baseline',
    'patch',
    true,
    [],
    'low',
    METHOD_POLICIES.patchDom
  ),
  // cdp - high (raw protocol, large payloads)
  'cdp.get_document': createRegistryEntry(
    'cdp.get_document',
    'cdp',
    true,
    [],
    'high',
    METHOD_POLICIES.cdpDomSnapshotDebugger
  ),
  'cdp.get_dom_snapshot': createRegistryEntry(
    'cdp.get_dom_snapshot',
    'cdp',
    true,
    [],
    'high',
    METHOD_POLICIES.cdpDomSnapshotDebugger
  ),
  'cdp.get_box_model': createRegistryEntry(
    'cdp.get_box_model',
    'cdp',
    true,
    ['nodeId'],
    'high',
    METHOD_POLICIES.cdpBoxModelDebugger
  ),
  'cdp.get_computed_styles_for_node': createRegistryEntry(
    'cdp.get_computed_styles_for_node',
    'cdp',
    true,
    ['nodeId'],
    'high',
    METHOD_POLICIES.cdpStylesDebugger
  ),
  'cdp.dispatch_key_event': createRegistryEntry(
    'cdp.dispatch_key_event',
    'cdp',
    true,
    ['key', 'code', 'modifiers'],
    'moderate',
    METHOD_POLICIES.cdpInputDebugger
  ),
  // performance - moderate (debugger-backed)
  'performance.get_metrics': createRegistryEntry(
    'performance.get_metrics',
    'performance',
    true,
    [],
    'moderate',
    METHOD_POLICIES.performanceReadDebugger
  ),
});

/** @type {ReadonlyArray<import('./types.js').BridgeMethod>} */
export const BRIDGE_METHODS = Object.freeze(
  /** @type {import('./types.js').BridgeMethod[]} */ (Object.keys(BRIDGE_METHOD_REGISTRY))
);

/** @type {ReadonlySet<import('./types.js').BridgeMethod>} */
export const METHOD_SET = new Set(BRIDGE_METHODS);

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
  return BRIDGE_METHODS.filter(
    (m) => COMPLEXITY_LEVELS.indexOf(BRIDGE_METHOD_REGISTRY[m].complexity) <= maxIndex
  );
}
