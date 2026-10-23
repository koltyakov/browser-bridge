// @ts-check

import { CAPABILITIES } from './capability-values.js';
import { BridgeError, ERROR_CODES } from './errors.js';

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
 *   discovery?: Readonly<BridgeMethodDiscovery>
 * }} BridgeMethodRegistryEntry
 */

/**
 * Canonical input type and minimal example for on-demand agent discovery.
 * @typedef {{paramsType: string, required?: readonly string[], example: Record<string, unknown>}} BridgeMethodDiscovery
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
  sensitiveRead: Object.freeze({ capability: CAPABILITIES.SENSITIVE_READ }),
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
  automationInputDebugger: Object.freeze({
    capability: CAPABILITIES.AUTOMATION_INPUT,
    debuggerBacked: true,
  }),
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
  'session.journal_read':
    'Read exact base64 bytes of a durable recording journal. Requires its secret journalId. Works after extension or daemon restart; page until nextOffset=null. Expires 24 hours after the last write.',
  'session.journal_delete': 'Delete one durable recording journal using its secret journalId.',
  'input.paste_image':
    'Paste a staged PNG using the real clipboard and trusted Chrome input. Overwrites clipboard. Requires a focused top-document editor. Never automatically retry; verify insertion.',
  'download.start':
    'Start a browser-native download without the artifact size ceiling. Returns a secret downloadId for subsequent control. Saves on the browser machine.',
  'download.status': 'Read progress and state of one BBX-created browser download.',
  'download.pause': 'Pause one BBX-created browser download.',
  'download.resume': 'Resume one resumable BBX-created browser download.',
  'download.cancel': 'Cancel one BBX-created browser download.',
  'download.release':
    'Release a terminal download handle without deleting its file or browser history.',
  'session.start':
    'Start bounded recording. activity=true; network,bodies,messages,visual,followTabs,durable,replay default false. bodies/messages require network. durationMs=1000..1800000, default 60000. followTabs tracks up to eight opener descendants inside the enabled window. replay captures the root renderer stream. durable returns a secret journalId for crash recovery. Input values are redacted; pixels and binary bodies are not. Keep sessionId on one connection; two retained sessions maximum.',
  'session.status':
    'Probe a recording by sessionId, including the live page recorder, counters, gaps, body backlog and visual frame count. No event payloads.',
  'session.read':
    'Read bounded recording events with sessionId, cursor=0, limit=25 (max 100), waitMs=0 (max 25000). Cursors belong to this sessionId. Returns nextCursor and explicit capture gaps. No response bodies or images in this read.',
  'session.stop':
    'Stop intake, collect final activity, drain pending body reads and stop network capture. Retains evidence for five minutes for export. Failed cleanup is retryable.',
  'session.export':
    'Stop and drain a recording, then export a chunked artifact. format=json includes archived events, opt-in bodies and frames. format=html is a self-contained, script-free sampled-frame replay. Gaps and dropped counts remain explicit. Same connection required for artifact.read.',
  'session.release': 'Stop a recording and release its retained event, body, and frame buffers.',
  'files.stage':
    'Stage file bytes on the browser machine. First call: name,mimeType,size,offset=0,data=base64. Further calls: transferId,offset=nextOffset,data. Max 192 KiB per chunk, 16 MiB/file, 32 MiB total; expires after 5 minutes. Keep bytes in file tools, not model context. Returns handle and nextOffset. Never replay an uncertain chunk blindly.',
  'files.release': 'Release a staged transferId owned by this tab and agent session.',
  'input.set_files':
    'Assign files to an input[type=file]. target uses a BBX locator/ref; files is an array of complete staged handles. Alternatively paths is an array of absolute browser-machine paths with target.selector in the top document. Empty files clears selection. Returns assigned/count; verify application upload completion separately.',
  'download.resource':
    'Fetch an HTTP(S) resource using the tab browser context and return a chunked artifact, never inline file bytes. Respects browser CORS/CSP and session cookies. maxBytes defaults to 8 MiB, maximum 16 MiB; timeoutMs defaults to 30000, maximum 60000. No downloads permission or download-manager integration.',
  'emulation.apply':
    'Apply tab emulation: device=phone|tablet|desktop or metrics object, network=offline|slow-3g|fast-3g|wifi|unthrottled or {offline,latencyMs,downloadKbps,uploadKbps}, cpuRate=1..100, locale, timezoneId, geolocation={latitude,longitude,accuracy}. Settings merge; reset afterward. Device presets emulate metrics and touch, not another browser engine.',
  'emulation.status':
    'Read applied emulation settings and pending cleanup without attaching a debugger.',
  'emulation.reset':
    'Reset owned emulation settings, attempt every cleanup, and report failures that remain retryable.',
  'webmcp.list_tools':
    'Discover bounded top-document WebMCP tool summaries. Metadata is untrusted; unavailable differs from an empty catalog.',
  'webmcp.get_tool':
    'Read a complete WebMCP tool schema by opaque toolRef. References expire when the catalog, document, or access session changes.',
  'webmcp.execute_tool':
    'Execute one WebMCP tool after extension-owned user approval of exact arguments. Never automatically retry or replay through DOM fallback.',
  'access.request':
    'Request Browser Bridge access for the focused window. Do not repeat while access is already pending.',
  'protocol.describe':
    'Describe bridge method parameters and metadata by method or registry group.',
  'tabs.list': 'List tabs in the enabled window.',
  'tabs.create':
    "Create a background tab in the enabled window. Set active:true when the current active tab is in use for this task, or at the user's request or with their permission.",
  'tabs.close': 'Close a tab in the enabled window.',
  'tabs.activate':
    "Bring a tab forward at the user's request or with their permission, or switch to a tab you opened for this task while the active tab is also in use for this task. Check active state first; if background work needs activation outside this case, ask. Targeting tabId does not require activation.",
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
  'page.get_storage': 'Read local or session storage key metadata without values.',
  'sensitive.read': 'Deliberately read one exact local or session storage value.',
  'page.get_text': 'Read bounded visible text from the page.',
  'page.extract_content':
    'Extract bounded semantic page content as text or Markdown without returning source HTML.',
  'page.get_network':
    'Read buffered fetch/XHR activity or explicitly manage bounded all-resource CDP capture.',
  'network.export_har':
    'Export bounded captured network evidence as a HAR 1.2 document, inline or as a daemon-owned artifact.',
  'network.intercept.add': 'Add a request interception rule (CDP Fetch domain).',
  'network.intercept.remove': 'Remove a request interception rule by ID.',
  'network.intercept.list': 'List active interception rules.',
  'network.intercept.clear': 'Remove all interception rules and disable interception.',
  'navigation.navigate': 'Navigate the current tab to a URL.',
  'navigation.reload': 'Reload the current tab.',
  'navigation.go_back': 'Navigate backward in tab history.',
  'navigation.go_forward': 'Navigate forward in tab history.',
  'dom.query': 'Query a DOM subtree and return compact node summaries.',
  'dom.baseline.create': 'Create a short-lived compact semantic DOM baseline for later comparison.',
  'dom.baseline.compare': 'Compare the current DOM with a retained semantic baseline.',
  'dom.baseline.describe': 'Describe a retained semantic DOM baseline and its scope.',
  'dom.baseline.release': 'Release a retained semantic DOM baseline.',
  'dom.describe': 'Describe one element by elementRef.',
  'dom.get_text': 'Read bounded text for one element.',
  'dom.get_attributes': 'Read selected attributes for one element.',
  'dom.wait_for': 'Wait for a selector or text condition in the DOM.',
  'dom.find_by_text':
    'Find the innermost visible elements by text, including open/closed shadow DOM.',
  'dom.find_by_role':
    'Find visible elements by ARIA role and accessible name (labels, aria-*, alt, content).',
  'dom.get_html': 'Read inner or outer HTML for one element.',
  'dom.get_accessibility_tree':
    'Read an accessibility tree; source=dom returns a compact actionable outline with elementRefs and no debugger.',
  'layout.get_box_model': 'Read the box model for one element.',
  'layout.hit_test': 'Resolve the topmost element at a viewport point.',
  'styles.get_computed':
    'Read requested computed styles; omission returns display, position, width, height, and color.',
  'styles.get_matched_rules':
    'Read element classes and inline style context (not stylesheet cascade data).',
  'viewport.scroll': 'Scroll the viewport or a scrollable element.',
  'viewport.resize': 'Resize or reset the tab viewport.',
  'input.click':
    'Actionability-check and click an element through DOM or optional CDP input; holdMs keeps the button pressed.',
  'input.focus': 'Actionability-check and focus an element through DOM input.',
  'input.type': 'Actionability-check and type through DOM or optional CDP text input.',
  'input.fill':
    'Fill an editable target using a DOM strategy or optional CDP text input; verify afterward.',
  'input.press_key':
    'Send a key press to the page or an element through DOM or optional CDP input; holdMs keeps the key down.',
  'input.set_checked': 'Set checkbox or radio checked state.',
  'input.select_option': 'Select options in a select element.',
  'input.hover': 'Actionability-check and hover through DOM or optional CDP pointer input.',
  'input.drag': 'Actionability-check and drag through DOM or optional CDP pointer input.',
  'input.touch':
    'Press one or more touch points at the same time (chords, multi-finger taps, swipes, pinches) through DOM or optional CDP touch input.',
  'input.perform':
    'Run known input, wait, and bounded read steps in order inside the browser in one call. Use returnLastResult for final evidence; stop for decisions requiring new information and never blindly replay a partial flow.',
  'input.scroll_into_view': 'Scroll an element into the visible viewport.',
  'screenshot.capture_region': 'Capture a screenshot of a viewport region.',
  'screenshot.capture_element': 'Capture a screenshot of one element.',
  'screenshot.capture_full_page': 'Capture a full-page screenshot beyond the viewport.',
  'artifact.read': 'Read one bounded chunk from a daemon-owned artifact.',
  'artifact.delete': 'Delete one daemon-owned artifact.',
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
  'performance.get_metrics':
    'Read a raw Chrome/CDP counter point sample; names and units vary, and BBX measures no navigation window, LCP, CLS, or INP.',
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
 * @param {Readonly<BridgeMethodDiscovery>} [discovery]
 * @returns {BridgeMethodRegistryEntry}
 */
function createRegistryEntry(
  method,
  group,
  tab,
  params,
  complexity = 'low',
  policy = METHOD_POLICIES.none,
  discovery
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
      discovery: { value: discovery },
    })
  );
}

/** @type {Readonly<Record<import('./types.js').BridgeMethod, BridgeMethodRegistryEntry>>} */
export const BRIDGE_METHOD_REGISTRY = Object.freeze({
  // system - trivial
  'access.request': createRegistryEntry('access.request', 'system', false, ['intent'], 'trivial'),
  'protocol.describe': createRegistryEntry(
    'protocol.describe',
    'system',
    false,
    ['method', 'group'],
    'trivial'
  ),
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
  'tabs.list': createRegistryEntry('tabs.list', 'tabs', false, ['limit', 'offset'], 'trivial'),
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
    METHOD_POLICIES.pageRead,
    { paramsType: 'ConsoleParams', example: { level: 'error', limit: 10 } }
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
    METHOD_POLICIES.pageRead,
    {
      paramsType: 'WaitForLoadStateParams',
      example: { url: '/dashboard', urlMatch: 'contains', waitForLoad: false },
    }
  ),
  'page.get_storage': createRegistryEntry(
    'page.get_storage',
    'page',
    true,
    ['type', 'keys'],
    'low',
    METHOD_POLICIES.pageRead
  ),
  'sensitive.read': createRegistryEntry(
    'sensitive.read',
    'sensitive',
    true,
    ['source', 'key'],
    'low',
    METHOD_POLICIES.sensitiveRead
  ),
  'page.get_text': createRegistryEntry(
    'page.get_text',
    'page',
    true,
    ['textBudget'],
    'low',
    METHOD_POLICIES.pageRead,
    { paramsType: 'PageTextParams', example: { textBudget: 800 } }
  ),
  'page.extract_content': createRegistryEntry(
    'page.extract_content',
    'page',
    true,
    ['format', 'selector', 'includeMetadata', 'consistency', 'textBudget', 'settleTimeoutMs'],
    'moderate',
    METHOD_POLICIES.pageRead,
    { paramsType: 'ExtractContentParams', example: { format: 'markdown', textBudget: 4000 } }
  ),
  'page.get_network': createRegistryEntry(
    'page.get_network',
    'page',
    true,
    ['clear', 'limit', 'urlPattern', 'source', 'capture'],
    'low',
    METHOD_POLICIES.networkRead
  ),
  'network.export_har': createRegistryEntry(
    'network.export_har',
    'page',
    true,
    ['limit', 'urlPattern', 'delivery'],
    'moderate',
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
    METHOD_POLICIES.domRead,
    { paramsType: 'DomQueryParams', example: { selector: 'main', maxNodes: 10, textBudget: 300 } }
  ),
  'dom.baseline.create': createRegistryEntry(
    'dom.baseline.create',
    'inspect',
    true,
    ['selector', 'maxNodes', 'maxDepth', 'textBudget', 'attributeAllowlist'],
    'low',
    METHOD_POLICIES.domRead
  ),
  'dom.baseline.compare': createRegistryEntry(
    'dom.baseline.compare',
    'inspect',
    true,
    ['baselineId', 'maxChanges'],
    'low',
    METHOD_POLICIES.domRead
  ),
  'dom.baseline.describe': createRegistryEntry(
    'dom.baseline.describe',
    'inspect',
    true,
    ['baselineId'],
    'low',
    METHOD_POLICIES.domRead
  ),
  'dom.baseline.release': createRegistryEntry(
    'dom.baseline.release',
    'inspect',
    true,
    ['baselineId'],
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
    METHOD_POLICIES.domRead,
    {
      paramsType: 'WaitForParams',
      required: ['selector'],
      example: { selector: '[role="status"]', text: 'Saved', timeoutMs: 5000 },
    }
  ),
  'dom.find_by_text': createRegistryEntry(
    'dom.find_by_text',
    'inspect',
    true,
    ['text', 'exact', 'selector', 'maxResults', 'includeHidden'],
    'low',
    METHOD_POLICIES.domRead,
    { paramsType: 'FindByTextParams', required: ['text'], example: { text: 'Save', maxResults: 5 } }
  ),
  'dom.find_by_role': createRegistryEntry(
    'dom.find_by_role',
    'inspect',
    true,
    ['role', 'name', 'exact', 'selector', 'maxResults', 'includeHidden'],
    'low',
    METHOD_POLICIES.domRead,
    {
      paramsType: 'FindByRoleParams',
      required: ['role'],
      example: { role: 'button', name: 'Save', maxResults: 5 },
    }
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
    ['selector', 'maxNodes', 'maxDepth', 'compact', 'interactiveOnly', 'source', 'format'],
    'moderate',
    METHOD_POLICIES.domReadDebugger,
    {
      paramsType: 'AccessibilityTreeParams',
      example: { source: 'dom', interactiveOnly: true, maxNodes: 30 },
    }
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
    METHOD_POLICIES.stylesRead,
    {
      paramsType: 'StyleQueryParams',
      example: { target: { selector: 'main' }, properties: ['display', 'width'] },
    }
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
    [
      'target',
      'button',
      'clickCount',
      'modifiers',
      'holdMs',
      'executionMode',
      'recoverStale',
      'timeoutMs',
      'observe',
    ],
    'low',
    METHOD_POLICIES.automationInputDebugger,
    {
      paramsType: 'InputActionParams',
      required: ['target'],
      example: { target: { role: 'button', name: 'Save' } },
    }
  ),
  'input.focus': createRegistryEntry(
    'input.focus',
    'interact',
    true,
    ['target', 'executionMode', 'recoverStale', 'timeoutMs', 'observe'],
    'low',
    METHOD_POLICIES.automationInputDebugger,
    {
      paramsType: 'InputActionParams',
      required: ['target'],
      example: { target: { label: 'Email' } },
    }
  ),
  'input.type': createRegistryEntry(
    'input.type',
    'interact',
    true,
    [
      'target',
      'text',
      'clear',
      'submit',
      'modifiers',
      'executionMode',
      'recoverStale',
      'timeoutMs',
      'observe',
    ],
    'low',
    METHOD_POLICIES.automationInputDebugger,
    {
      paramsType: 'InputActionParams',
      example: { target: { label: 'Search' }, text: 'browser bridge' },
    }
  ),
  'input.fill': createRegistryEntry(
    'input.fill',
    'interact',
    true,
    ['target', 'value', 'mode', 'executionMode', 'recoverStale', 'timeoutMs', 'observe'],
    'low',
    METHOD_POLICIES.automationInputDebugger,
    {
      paramsType: 'InputActionParams',
      required: ['target'],
      example: { target: { label: 'Email' }, value: 'ada@example.test' },
    }
  ),
  'input.press_key': createRegistryEntry(
    'input.press_key',
    'interact',
    true,
    [
      'target',
      'key',
      'modifiers',
      'holdMs',
      'executionMode',
      'recoverStale',
      'timeoutMs',
      'observe',
    ],
    'low',
    METHOD_POLICIES.automationInputDebugger,
    { paramsType: 'InputActionParams', example: { key: 'Enter' } }
  ),
  'input.set_checked': createRegistryEntry(
    'input.set_checked',
    'interact',
    true,
    ['target', 'checked', 'executionMode', 'recoverStale', 'timeoutMs', 'observe'],
    'low',
    METHOD_POLICIES.automationInputDebugger,
    {
      paramsType: 'CheckedActionParams',
      required: ['target'],
      example: { target: { role: 'checkbox', name: 'Remember me' }, checked: true },
    }
  ),
  'input.select_option': createRegistryEntry(
    'input.select_option',
    'interact',
    true,
    [
      'target',
      'values',
      'labels',
      'indexes',
      'executionMode',
      'recoverStale',
      'timeoutMs',
      'observe',
    ],
    'low',
    METHOD_POLICIES.automationInputDebugger,
    {
      paramsType: 'SelectActionParams',
      required: ['target'],
      example: { target: { label: 'Country' }, labels: ['Canada'] },
    }
  ),
  'input.hover': createRegistryEntry(
    'input.hover',
    'interact',
    true,
    ['target', 'duration', 'modifiers', 'executionMode', 'recoverStale', 'timeoutMs', 'observe'],
    'low',
    METHOD_POLICIES.automationInputDebugger,
    {
      paramsType: 'HoverParams',
      required: ['target'],
      example: { target: { role: 'button', name: 'Menu' } },
    }
  ),
  'input.drag': createRegistryEntry(
    'input.drag',
    'interact',
    true,
    [
      'source',
      'destination',
      'offsetX',
      'offsetY',
      'executionMode',
      'recoverStale',
      'timeoutMs',
      'observe',
    ],
    'moderate',
    METHOD_POLICIES.automationInputDebugger,
    {
      paramsType: 'DragParams',
      required: ['source'],
      example: { source: { testId: 'card' }, destination: { testId: 'column' } },
    }
  ),
  'input.touch': createRegistryEntry(
    'input.touch',
    'interact',
    true,
    ['points', 'holdMs', 'moveSteps', 'executionMode', 'recoverStale'],
    'moderate',
    METHOD_POLICIES.automationInputDebugger,
    {
      paramsType: 'TouchParams',
      required: ['points'],
      example: { points: [{ x: 100, y: 100 }], holdMs: 50 },
    }
  ),
  'input.perform': createRegistryEntry(
    'input.perform',
    'interact',
    true,
    ['steps', 'executionMode', 'timeoutMs', 'continueOnError', 'returnLastResult'],
    'moderate',
    METHOD_POLICIES.automationInputDebugger,
    {
      paramsType: 'PerformParams',
      required: ['steps'],
      example: {
        returnLastResult: true,
        steps: [
          {
            method: 'input.fill',
            params: { target: { label: 'Email' }, value: 'ada@example.test' },
          },
          {
            method: 'input.click',
            params: { target: { role: 'button', name: 'Save' }, observe: true },
          },
        ],
      },
    }
  ),
  'input.scroll_into_view': createRegistryEntry(
    'input.scroll_into_view',
    'interact',
    true,
    ['target'],
    'low',
    METHOD_POLICIES.automationInputDebugger,
    {
      paramsType: 'InputActionParams',
      required: ['target'],
      example: { target: { testId: 'footer' } },
    }
  ),
  // capture - high (screenshots, CDP)
  'screenshot.capture_region': createRegistryEntry(
    'screenshot.capture_region',
    'capture',
    true,
    ['x', 'y', 'width', 'height', 'format', 'quality', 'delivery', 'scale'],
    'high',
    METHOD_POLICIES.screenshotPartialDebugger
  ),
  'screenshot.capture_element': createRegistryEntry(
    'screenshot.capture_element',
    'capture',
    true,
    ['elementRef', 'format', 'quality', 'delivery', 'scale'],
    'high',
    METHOD_POLICIES.screenshotPartialDebugger
  ),
  'screenshot.capture_full_page': createRegistryEntry(
    'screenshot.capture_full_page',
    'capture',
    true,
    ['format', 'quality', 'delivery', 'scale'],
    'high',
    METHOD_POLICIES.screenshotPartialDebugger
  ),
  'artifact.read': createRegistryEntry(
    'artifact.read',
    'artifact',
    false,
    ['artifactId', 'offset', 'maxBytes'],
    'low'
  ),
  'artifact.delete': createRegistryEntry(
    'artifact.delete',
    'artifact',
    false,
    ['artifactId'],
    'low'
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
    ['computedStyles'],
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
  'webmcp.list_tools': createRegistryEntry(
    'webmcp.list_tools',
    'webmcp',
    true,
    ['limit', 'offset', 'query', 'includeDebugging', 'maxBytes'],
    'low',
    METHOD_POLICIES.pageRead
  ),
  'webmcp.get_tool': createRegistryEntry(
    'webmcp.get_tool',
    'webmcp',
    true,
    ['toolRef', 'maxBytes'],
    'low',
    METHOD_POLICIES.pageRead
  ),
  'webmcp.execute_tool': createRegistryEntry(
    'webmcp.execute_tool',
    'webmcp',
    true,
    ['toolRef', 'arguments', 'timeoutMs', 'approvalTimeoutMs', 'maxBytes'],
    'moderate',
    METHOD_POLICIES.automationInput
  ),
  'emulation.apply': createRegistryEntry(
    'emulation.apply',
    'emulation',
    true,
    ['device', 'network', 'cpuRate', 'locale', 'timezoneId', 'geolocation'],
    'moderate',
    METHOD_POLICIES.viewportControlDebugger
  ),
  'emulation.status': createRegistryEntry(
    'emulation.status',
    'emulation',
    true,
    [],
    'trivial',
    METHOD_POLICIES.pageRead
  ),
  'emulation.reset': createRegistryEntry(
    'emulation.reset',
    'emulation',
    true,
    [],
    'low',
    METHOD_POLICIES.viewportControlDebugger
  ),
  'files.stage': createRegistryEntry(
    'files.stage',
    'files',
    true,
    ['name', 'mimeType', 'size', 'transferId', 'offset', 'data'],
    'moderate',
    METHOD_POLICIES.automationInput
  ),
  'files.release': createRegistryEntry(
    'files.release',
    'files',
    true,
    ['transferId'],
    'low',
    METHOD_POLICIES.automationInput
  ),
  'input.set_files': createRegistryEntry(
    'input.set_files',
    'files',
    true,
    ['target', 'files', 'paths'],
    'moderate',
    METHOD_POLICIES.automationInputDebugger
  ),
  'input.paste_image': createRegistryEntry(
    'input.paste_image',
    'files',
    true,
    ['target', 'transferId'],
    'moderate',
    METHOD_POLICIES.automationInputDebugger
  ),
  'download.resource': createRegistryEntry(
    'download.resource',
    'files',
    true,
    ['url', 'maxBytes', 'timeoutMs'],
    'moderate',
    METHOD_POLICIES.networkRead
  ),
  'download.start': createRegistryEntry(
    'download.start',
    'files',
    true,
    ['url', 'filename', 'saveAs'],
    'moderate',
    METHOD_POLICIES.automationInput
  ),
  'download.status': createRegistryEntry(
    'download.status',
    'files',
    true,
    ['downloadId'],
    'low',
    METHOD_POLICIES.networkRead
  ),
  'download.pause': createRegistryEntry(
    'download.pause',
    'files',
    true,
    ['downloadId'],
    'low',
    METHOD_POLICIES.automationInput
  ),
  'download.resume': createRegistryEntry(
    'download.resume',
    'files',
    true,
    ['downloadId'],
    'low',
    METHOD_POLICIES.automationInput
  ),
  'download.cancel': createRegistryEntry(
    'download.cancel',
    'files',
    true,
    ['downloadId'],
    'low',
    METHOD_POLICIES.automationInput
  ),
  'download.release': createRegistryEntry(
    'download.release',
    'files',
    true,
    ['downloadId'],
    'low',
    METHOD_POLICIES.automationInput
  ),
  'session.start': createRegistryEntry(
    'session.start',
    'session',
    true,
    [
      'activity',
      'network',
      'bodies',
      'messages',
      'visual',
      'durationMs',
      'followTabs',
      'durable',
      'replay',
    ],
    'moderate',
    METHOD_POLICIES.automationInputDebugger
  ),
  'session.journal_read': createRegistryEntry(
    'session.journal_read',
    'session',
    false,
    ['journalId', 'offset', 'maxBytes'],
    'low',
    METHOD_POLICIES.none
  ),
  'session.journal_delete': createRegistryEntry(
    'session.journal_delete',
    'session',
    false,
    ['journalId'],
    'low',
    METHOD_POLICIES.none
  ),
  'session.status': createRegistryEntry(
    'session.status',
    'session',
    true,
    ['sessionId'],
    'low',
    METHOD_POLICIES.pageRead
  ),
  'session.read': createRegistryEntry(
    'session.read',
    'session',
    true,
    ['sessionId', 'cursor', 'limit', 'waitMs'],
    'low',
    METHOD_POLICIES.pageRead
  ),
  'session.stop': createRegistryEntry(
    'session.stop',
    'session',
    true,
    ['sessionId'],
    'moderate',
    METHOD_POLICIES.automationInputDebugger
  ),
  'session.export': createRegistryEntry(
    'session.export',
    'session',
    true,
    ['sessionId', 'format'],
    'moderate',
    METHOD_POLICIES.automationInputDebugger
  ),
  'session.release': createRegistryEntry(
    'session.release',
    'session',
    true,
    ['sessionId'],
    'low',
    METHOD_POLICIES.automationInputDebugger
  ),
});

/** @type {ReadonlyArray<import('./types.js').BridgeMethod>} */
export const BRIDGE_METHODS = Object.freeze(
  /** @type {import('./types.js').BridgeMethod[]} */ (Object.keys(BRIDGE_METHOD_REGISTRY))
);

/** @type {ReadonlySet<import('./types.js').BridgeMethod>} */
export const METHOD_SET = new Set(BRIDGE_METHODS);

/** Methods whose read-only forms may run concurrently without side effects. */
const BATCH_SAFE_METHODS = new Set([
  'emulation.status',
  'webmcp.list_tools',
  'webmcp.get_tool',
  'health.ping',
  'daemon.metrics',
  'tabs.list',
  'skill.get_runtime_context',
  'setup.get_status',
  'log.tail',
  'page.get_state',
  'page.get_console',
  'page.wait_for_load_state',
  'page.get_storage',
  'page.get_text',
  'page.extract_content',
  'page.get_network',
  'dom.query',
  'dom.baseline.compare',
  'dom.baseline.describe',
  'dom.describe',
  'dom.get_text',
  'dom.get_attributes',
  'dom.wait_for',
  'dom.find_by_text',
  'dom.find_by_role',
  'dom.get_html',
  'dom.get_accessibility_tree',
  'layout.get_box_model',
  'layout.hit_test',
  'styles.get_computed',
  'styles.get_matched_rules',
  'network.intercept.list',
  'patch.list',
  'performance.get_metrics',
]);

/**
 * Classify a normalized or raw bridge call for parallel read-only execution.
 * Parameter checks deliberately reject malformed truthy mutation flags before
 * protocol normalization can coerce them.
 *
 * @param {import('./types.js').BridgeMethod} method
 * @param {Record<string, unknown>} [params]
 * @returns {boolean}
 */
export function isBatchSafeBridgeCall(method, params = {}) {
  if (!BATCH_SAFE_METHODS.has(method)) return false;
  if (
    (method === 'page.get_console' || method === 'page.get_network') &&
    params.clear !== undefined &&
    params.clear !== false
  ) {
    return false;
  }
  if (
    method === 'page.get_network' &&
    params.source === 'cdp' &&
    params.capture !== undefined &&
    params.capture !== 'read'
  ) {
    return false;
  }
  return true;
}

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
 * @typedef {{
 *   method: import('./types.js').BridgeMethod,
 *   group: string,
 *   tab: boolean,
 *   params: readonly string[],
 *   description: string,
 *   complexity: BridgeMethodComplexity
 * }} BridgeMethodDescription
 */

/**
 * @param {import('./types.js').BridgeMethod} method
 * @returns {BridgeMethodDescription}
 */
function createBridgeMethodDescription(method) {
  const entry = BRIDGE_METHOD_REGISTRY[method];
  return {
    method,
    group: entry.group,
    tab: entry.tab,
    params: entry.params,
    description: entry.description,
    complexity: entry.complexity,
  };
}

/**
 * Return a compact registry index or detailed descriptions for one method or group.
 *
 * @param {{ method?: unknown, group?: unknown }} [options]
 * @returns {{ groups: Array<{ group: string, count: number }> } | BridgeMethodDescription | { group: string, methods: BridgeMethodDescription[] }}
 */
export function describeBridgeMethods(options = {}) {
  const { method, group } = options;
  if (method !== undefined && group !== undefined) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'protocol.describe accepts either method or group, not both.'
    );
  }
  if (method !== undefined) {
    if (typeof method !== 'string' || !isBridgeMethod(method)) {
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        `Unknown bridge method "${String(method)}".`
      );
    }
    return createBridgeMethodDescription(method);
  }

  const groups = createBridgeMethodGroups();
  if (group !== undefined) {
    if (typeof group !== 'string' || !Object.hasOwn(groups, group)) {
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        `Unknown bridge method group "${String(group)}".`
      );
    }
    return {
      group,
      methods: groups[group].map(createBridgeMethodDescription),
    };
  }

  return {
    groups: Object.entries(groups).map(([groupName, methods]) => ({
      group: groupName,
      count: methods.length,
    })),
  };
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
