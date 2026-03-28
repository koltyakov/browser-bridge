// @ts-check

import {
  bridgeMethodNeedsTab,
  DEFAULT_CONSOLE_LIMIT,
  DEFAULT_MAX_HTML_LENGTH,
  DEFAULT_NETWORK_LIMIT,
  estimateJsonPayloadCost,
  getBudgetPreset,
  isBudgetPresetName,
  METHODS,
} from '../../protocol/src/index.js';
import {
  getDoctorReport,
  requestBridge,
  resolveRef,
  withBridgeClient
} from '../../agent-client/src/runtime.js';
import {
  annotateBridgeSummary,
  summarizeBridgeResponse,
} from '../../agent-client/src/subagent.js';

/** @typedef {import('../../protocol/src/types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */

const REQUEST_SOURCE = 'mcp';

/**
 * @typedef {{
 *   content: Array<{ type: 'text', text: string }>,
 *   structuredContent: Record<string, unknown>,
 *   isError?: boolean
 * }} ToolResult
 */

/**
 * @param {string} summary
 * @param {Record<string, unknown>} [structuredContent={}]
 * @param {boolean} [isError=false]
 * @returns {ToolResult}
 */
function createToolResult(summary, structuredContent = {}, isError = false) {
  const toolResult = {
    content: [{ type: /** @type {'text'} */ ('text'), text: summary }],
    structuredContent,
    ...(isError ? { isError: true } : {})
  };
  const delivered = estimateJsonPayloadCost(toolResult);
  return {
    ...toolResult,
    structuredContent: {
      ...structuredContent,
      deliveredBytes: delivered.bytes,
      deliveredTokens: delivered.approxTokens,
      deliveredCostClass: delivered.costClass,
    },
  };
}

/**
 * @param {BridgeResponse} response
 * @param {string} [method]
 * @returns {ToolResult}
 */
function summarizeToolResponse(response, method) {
  const summary = annotateBridgeSummary(summarizeBridgeResponse(response, method), response);
  return createToolResult(summary.summary, summary, !summary.ok);
}

/**
 * @param {unknown} error
 * @returns {ToolResult}
 */
function summarizeToolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return createToolResult(`ERROR: ${message}`, {
    ok: false,
    evidence: null
  }, true);
}

/**
 * @param {(client: import('../../agent-client/src/client.js').BridgeClient) => Promise<ToolResult>} callback
 * @returns {Promise<ToolResult>}
 */
async function withToolClient(callback) {
  try {
    return await withBridgeClient(callback);
  } catch (error) {
    return summarizeToolError(error);
  }
}

/**
 * @param {import('../../agent-client/src/client.js').BridgeClient} client
 * @param {{ elementRef?: string | undefined, selector?: string | undefined }} input
 * @param {number | null | undefined} [tabId]
 * @returns {Promise<string>}
 */
async function resolveToolRef(client, input, tabId = null) {
  if (typeof input.elementRef === 'string' && input.elementRef) {
    return input.elementRef;
  }
  if (typeof input.selector === 'string' && input.selector) {
    return resolveRef(client, input.selector, tabId, REQUEST_SOURCE);
  }
  throw new Error('Provide either elementRef or selector.');
}

/**
 * @param {unknown} value
 * @returns {'quick' | 'normal' | 'deep' | null}
 */
function getBudgetPresetName(value) {
  return isBudgetPresetName(value) ? value : null;
}

/**
 * @param {{ budgetPreset?: unknown }} args
 * @returns {number | null}
 */
function getToolTokenBudget(args) {
  const presetName = getBudgetPresetName(args.budgetPreset);
  return presetName ? getBudgetPreset(presetName).tokenBudget : null;
}

/**
 * @template {{ budgetPreset?: unknown, maxNodes?: unknown, maxDepth?: unknown, textBudget?: unknown }} T
 * @param {T} args
 * @returns {T}
 */
function applyTreeBudgetPreset(args) {
  const presetName = getBudgetPresetName(args.budgetPreset);
  if (!presetName) {
    return args;
  }
  const preset = getBudgetPreset(presetName);
  return /** @type {T} */ ({
    ...args,
    maxNodes: args.maxNodes ?? preset.maxNodes,
    maxDepth: args.maxDepth ?? preset.maxDepth,
    textBudget: args.textBudget ?? preset.textBudget,
  });
}

/**
 * @template {{ budgetPreset?: unknown, textBudget?: unknown }} T
 * @param {T} args
 * @returns {T}
 */
function applyTextBudgetPreset(args) {
  const presetName = getBudgetPresetName(args.budgetPreset);
  if (!presetName) {
    return args;
  }
  const preset = getBudgetPreset(presetName);
  return /** @type {T} */ ({
    ...args,
    textBudget: args.textBudget ?? preset.textBudget,
  });
}

/**
 * @template {{ budgetPreset?: unknown, limit?: unknown }} T
 * @param {T} args
 * @param {{ quick: number, normal: number, deep: number }} defaults
 * @returns {T}
 */
function applyLimitBudgetPreset(args, defaults) {
  const presetName = getBudgetPresetName(args.budgetPreset);
  if (!presetName) {
    return args;
  }
  return /** @type {T} */ ({
    ...args,
    limit: args.limit ?? defaults[presetName],
  });
}

/**
 * @template {{ budgetPreset?: unknown, maxLength?: unknown }} T
 * @param {T} args
 * @returns {T}
 */
function applyHtmlBudgetPreset(args) {
  const presetName = getBudgetPresetName(args.budgetPreset);
  if (!presetName) {
    return args;
  }
  const maxLengthByPreset = {
    quick: 600,
    normal: DEFAULT_MAX_HTML_LENGTH,
    deep: 6000,
  };
  return /** @type {T} */ ({
    ...args,
    maxLength: args.maxLength ?? maxLengthByPreset[presetName],
  });
}

/**
 * @param {BridgeMethod} method
 * @param {Record<string, unknown>} [params={}]
 * @param {{ tabId?: number | null, summaryMethod?: string, tokenBudget?: number | null }} [options]
 * @returns {Promise<ToolResult>}
 */
async function callBridgeTool(method, params = {}, options = {}) {
  return withToolClient(async (client) => {
    const response = await requestBridge(client, method, params, {
      tabId: options.tabId ?? null,
      source: REQUEST_SOURCE,
      tokenBudget: options.tokenBudget ?? null,
    });
    return summarizeToolResponse(response, options.summaryMethod || method);
  });
}

/**
 * @typedef {{ ref: boolean, method: BridgeMethod, params: (args: Record<string, unknown>, ref?: string) => Record<string, unknown> }} ToolAction
 */

/**
 * Generic dispatcher for table-driven tool handlers. Each action entry
 * declares a bridge method, whether it needs an element ref, and a function
 * mapping args (and optional ref) to bridge params.
 *
 * @param {Record<string, ToolAction>} actions
 * @param {Record<string, unknown> & { action: string }} args
 * @param {string} toolName
 * @returns {Promise<ToolResult>}
 */
async function dispatchToolAction(actions, args, toolName) {
  const entry = actions[args.action];
  if (!entry) return summarizeToolError(`Unsupported ${toolName} action "${args.action}".`);
  return withToolClient(async (client) => {
    const requestedTabId = typeof args.tabId === 'number' ? args.tabId : null;
    const ref = entry.ref
      ? await resolveToolRef(
        client,
        /** @type {{ elementRef?: string, selector?: string }} */ (args),
        requestedTabId,
      )
      : undefined;
    const response = await requestBridge(client, entry.method, entry.params(args, ref), {
      tabId: requestedTabId,
      source: REQUEST_SOURCE,
      tokenBudget: getToolTokenBudget(/** @type {{ budgetPreset?: unknown }} */ (args)),
    });
    return summarizeToolResponse(response, entry.method);
  });
}

/**
 * @returns {Promise<ToolResult>}
 */
export async function handleStatusTool() {
  try {
    const report = await getDoctorReport();
    const summary = report.issues.length === 0
      ? 'Browser Bridge is ready.'
      : `Browser Bridge has ${report.issues.length} setup issue(s).`;
    return createToolResult(summary, {
      ok: report.issues.length === 0,
      evidence: report
    });
  } catch (error) {
    return summarizeToolError(error);
  }
}

/**
 * @param {{ action: string, url?: string, active?: boolean, tabId?: number }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleTabsTool(args) {
  if (args.action === 'list') {
    return callBridgeTool('tabs.list');
  }
  if (args.action === 'create') {
    return callBridgeTool('tabs.create', {
      url: args.url,
      active: args.active
    });
  }
  if (args.action === 'close') {
    if (typeof args.tabId !== 'number') {
      return summarizeToolError('tabId is required for tabs.close.');
    }
    return callBridgeTool('tabs.close', { tabId: args.tabId });
  }
  return summarizeToolError(`Unsupported tabs action "${args.action}".`);
}

/**
/** @type {Record<string, ToolAction>} */
export const DOM_ACTIONS = {
  query:              { ref: false, method: 'dom.query',                  params: a => ({ selector: a.selector || 'body', withinRef: a.withinRef, maxNodes: a.maxNodes, maxDepth: a.maxDepth, textBudget: a.textBudget, includeBbox: a.includeBbox, attributeAllowlist: a.attributeAllowlist }) },
  describe:           { ref: true,  method: 'dom.describe',               params: (_, r) => ({ elementRef: r }) },
  text:               { ref: true,  method: 'dom.get_text',               params: (a, r) => ({ elementRef: r, textBudget: a.textBudget }) },
  attributes:         { ref: true,  method: 'dom.get_attributes',         params: (a, r) => ({ elementRef: r, attributes: a.attributes || [] }) },
  wait:               { ref: false, method: 'dom.wait_for',               params: a => ({ selector: a.selector, text: a.text, state: a.state, timeoutMs: a.timeoutMs }) },
  find_text:          { ref: false, method: 'dom.find_by_text',           params: a => ({ text: a.text, exact: a.exact, selector: a.selector, maxResults: a.maxResults }) },
  find_role:          { ref: false, method: 'dom.find_by_role',           params: a => ({ role: a.role, name: a.name, selector: a.selector, maxResults: a.maxResults }) },
  html:               { ref: true,  method: 'dom.get_html',               params: (a, r) => ({ elementRef: r, outer: a.outer, maxLength: a.maxLength }) },
  accessibility_tree: { ref: false, method: 'dom.get_accessibility_tree', params: a => ({ maxNodes: a.maxNodes, maxDepth: a.maxDepth }) },
};

/**
 * @param {{ action: string, selector?: string, elementRef?: string, withinRef?: string, maxNodes?: number, maxDepth?: number, textBudget?: number, includeBbox?: boolean, attributeAllowlist?: string[], attributes?: string[], text?: string, exact?: boolean, maxResults?: number, role?: string, name?: string, state?: string, timeoutMs?: number, outer?: boolean, maxLength?: number, tabId?: number, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleDomTool(args) {
  if (args.action === 'query' || args.action === 'accessibility_tree') {
    return dispatchToolAction(DOM_ACTIONS, applyTreeBudgetPreset(args), 'DOM');
  }
  if (args.action === 'text') {
    return dispatchToolAction(DOM_ACTIONS, applyTextBudgetPreset(args), 'DOM');
  }
  if (args.action === 'html') {
    return dispatchToolAction(DOM_ACTIONS, applyHtmlBudgetPreset(args), 'DOM');
  }
  return dispatchToolAction(DOM_ACTIONS, args, 'DOM');
}

/** @type {Record<string, ToolAction>} */
export const STYLES_LAYOUT_ACTIONS = {
  computed:      { ref: true,  method: 'styles.get_computed',       params: (a, r) => ({ elementRef: r, properties: a.properties }) },
  matched_rules: { ref: true,  method: 'styles.get_matched_rules', params: (_, r) => ({ elementRef: r }) },
  box_model:     { ref: true,  method: 'layout.get_box_model',     params: (_, r) => ({ elementRef: r }) },
  hit_test:      { ref: false, method: 'layout.hit_test',          params: a => ({ x: a.x, y: a.y }) },
};

/**
 * @param {{ action: string, elementRef?: string, selector?: string, properties?: string[], x?: number, y?: number, tabId?: number, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleStylesLayoutTool(args) {
  return dispatchToolAction(STYLES_LAYOUT_ACTIONS, args, 'styles/layout');
}

/** @type {Record<string, { method: BridgeMethod, params: (a: Record<string, unknown>) => Record<string, unknown> }>} */
export const PAGE_ACTIONS = {
  state:         { method: 'page.get_state',           params: () => ({}) },
  evaluate:      { method: 'page.evaluate',            params: a => ({ expression: a.expression, awaitPromise: a.awaitPromise, timeoutMs: a.timeoutMs, returnByValue: a.returnByValue }) },
  console:       { method: 'page.get_console',         params: a => ({ level: a.level, clear: a.clear, limit: a.limit }) },
  wait_for_load: { method: 'page.wait_for_load_state', params: a => ({ timeoutMs: a.timeoutMs }) },
  storage:       { method: 'page.get_storage',         params: a => ({ type: a.type, keys: a.keys }) },
  text:          { method: 'page.get_text',            params: a => ({ textBudget: a.textBudget }) },
  network:       { method: 'page.get_network',         params: a => ({ clear: a.clear, limit: a.limit, urlPattern: a.urlPattern }) },
  performance:   { method: 'performance.get_metrics',  params: () => ({}) },
};

/**
 * @param {{ action: string, expression?: string, awaitPromise?: boolean, timeoutMs?: number, returnByValue?: boolean, level?: string, clear?: boolean, limit?: number, type?: string, keys?: string[], textBudget?: number, urlPattern?: string, tabId?: number, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
 * @returns {Promise<ToolResult>}
 */
export async function handlePageTool(args) {
  let normalizedArgs = args;
  if (args.action === 'text') {
    normalizedArgs = applyTextBudgetPreset(args);
  } else if (args.action === 'console') {
    normalizedArgs = applyLimitBudgetPreset(args, {
      quick: 10,
      normal: DEFAULT_CONSOLE_LIMIT,
      deep: 100,
    });
  } else if (args.action === 'network') {
    normalizedArgs = applyLimitBudgetPreset(args, {
      quick: 10,
      normal: DEFAULT_NETWORK_LIMIT,
      deep: 100,
    });
  }
  const entry = PAGE_ACTIONS[normalizedArgs.action];
  if (!entry) return summarizeToolError(`Unsupported page action "${args.action}".`);
  return callBridgeTool(entry.method, entry.params(normalizedArgs), {
    tabId: typeof normalizedArgs.tabId === 'number' ? normalizedArgs.tabId : null,
    tokenBudget: getToolTokenBudget(normalizedArgs),
  });
}

/** @type {Record<string, { method: BridgeMethod, params: (a: Record<string, unknown>) => Record<string, unknown> }>} */
export const NAVIGATION_ACTIONS = {
  navigate:   { method: 'navigation.navigate',   params: a => ({ url: a.url, waitForLoad: a.waitForLoad, timeoutMs: a.timeoutMs }) },
  reload:     { method: 'navigation.reload',     params: a => ({ waitForLoad: a.waitForLoad, timeoutMs: a.timeoutMs }) },
  go_back:    { method: 'navigation.go_back',    params: a => ({ waitForLoad: a.waitForLoad, timeoutMs: a.timeoutMs }) },
  go_forward: { method: 'navigation.go_forward', params: a => ({ waitForLoad: a.waitForLoad, timeoutMs: a.timeoutMs }) },
  scroll:     { method: 'viewport.scroll',       params: a => ({ top: a.top, left: a.left, behavior: a.behavior, relative: a.relative }) },
  resize:     { method: 'viewport.resize',       params: a => ({ width: a.width, height: a.height, reset: a.reset }) },
};

/**
 * @param {{ action: string, url?: string, waitForLoad?: boolean, timeoutMs?: number, top?: number, left?: number, behavior?: string, relative?: boolean, width?: number, height?: number, reset?: boolean, tabId?: number, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleNavigationTool(args) {
  const entry = NAVIGATION_ACTIONS[args.action];
  if (!entry) return summarizeToolError(`Unsupported navigation action "${args.action}".`);
  return callBridgeTool(entry.method, entry.params(args), {
    tabId: typeof args.tabId === 'number' ? args.tabId : null,
    tokenBudget: getToolTokenBudget(args),
  });
}

/** @type {Record<string, BridgeMethod>} */
export const INPUT_ACTION_METHODS = {
  click: 'input.click',
  focus: 'input.focus',
  type: 'input.type',
  press_key: 'input.press_key',
  set_checked: 'input.set_checked',
  select_option: 'input.select_option',
  hover: 'input.hover',
  drag: 'input.drag'
};

/**
 * @param {{ action: string, elementRef?: string, selector?: string, button?: string, clickCount?: number, text?: string, clear?: boolean, submit?: boolean, key?: string, modifiers?: string[], checked?: boolean, values?: string[], labels?: string[], indexes?: number[], duration?: number, sourceElementRef?: string, sourceSelector?: string, destinationElementRef?: string, destinationSelector?: string, offsetX?: number, offsetY?: number, tabId?: number, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleInputTool(args) {
  return withToolClient(async (client) => {
    const requestedTabId = typeof args.tabId === 'number' ? args.tabId : null;
    const elementTarget = async () => ({
      elementRef: await resolveToolRef(client, args, requestedTabId),
    });

    switch (args.action) {
      case 'click': {
        const response = await requestBridge(client, 'input.click', {
          target: await elementTarget(),
          button: args.button,
          clickCount: args.clickCount
        }, {
          tabId: requestedTabId,
          source: REQUEST_SOURCE,
          tokenBudget: getToolTokenBudget(args),
        });
        return summarizeToolResponse(response, 'input.click');
      }
      case 'focus': {
        const response = await requestBridge(client, 'input.focus', {
          target: await elementTarget()
        }, {
          tabId: requestedTabId,
          source: REQUEST_SOURCE,
          tokenBudget: getToolTokenBudget(args),
        });
        return summarizeToolResponse(response, 'input.focus');
      }
      case 'type': {
        const response = await requestBridge(client, 'input.type', {
          target: await elementTarget(),
          text: args.text,
          clear: args.clear,
          submit: args.submit
        }, {
          tabId: requestedTabId,
          source: REQUEST_SOURCE,
          tokenBudget: getToolTokenBudget(args),
        });
        return summarizeToolResponse(response, 'input.type');
      }
      case 'press_key': {
        const target = (args.elementRef || args.selector) ? await elementTarget() : undefined;
        const response = await requestBridge(client, 'input.press_key', {
          target,
          key: args.key,
          modifiers: args.modifiers
        }, {
          tabId: requestedTabId,
          source: REQUEST_SOURCE,
          tokenBudget: getToolTokenBudget(args),
        });
        return summarizeToolResponse(response, 'input.press_key');
      }
      case 'set_checked': {
        const response = await requestBridge(client, 'input.set_checked', {
          target: await elementTarget(),
          checked: args.checked
        }, {
          tabId: requestedTabId,
          source: REQUEST_SOURCE,
          tokenBudget: getToolTokenBudget(args),
        });
        return summarizeToolResponse(response, 'input.set_checked');
      }
      case 'select_option': {
        const response = await requestBridge(client, 'input.select_option', {
          target: await elementTarget(),
          values: args.values,
          labels: args.labels,
          indexes: args.indexes
        }, {
          tabId: requestedTabId,
          source: REQUEST_SOURCE,
          tokenBudget: getToolTokenBudget(args),
        });
        return summarizeToolResponse(response, 'input.select_option');
      }
      case 'hover': {
        const response = await requestBridge(client, 'input.hover', {
          target: await elementTarget(),
          duration: args.duration
        }, {
          tabId: requestedTabId,
          source: REQUEST_SOURCE,
          tokenBudget: getToolTokenBudget(args),
        });
        return summarizeToolResponse(response, 'input.hover');
      }
      case 'drag': {
        const source = {
          elementRef: args.sourceElementRef || (args.sourceSelector ? await resolveRef(client, args.sourceSelector, requestedTabId, REQUEST_SOURCE) : '')
        };
        const destination = {
          elementRef: args.destinationElementRef || (args.destinationSelector ? await resolveRef(client, args.destinationSelector, requestedTabId, REQUEST_SOURCE) : '')
        };
        if (!source.elementRef || !destination.elementRef) {
          return summarizeToolError('sourceElementRef/sourceSelector and destinationElementRef/destinationSelector are required for drag.');
        }
        const response = await requestBridge(client, 'input.drag', {
          source,
          destination,
          offsetX: args.offsetX,
          offsetY: args.offsetY
        }, {
          tabId: requestedTabId,
          source: REQUEST_SOURCE,
          tokenBudget: getToolTokenBudget(args),
        });
        return summarizeToolResponse(response, 'input.drag');
      }
      default:
        return summarizeToolError(`Unsupported input action "${args.action}".`);
    }
  });
}

/** @type {Record<string, ToolAction>} */
export const PATCH_ACTIONS = {
  apply_styles:    { ref: true,  method: 'patch.apply_styles',            params: (a, r) => ({ target: { elementRef: r }, declarations: a.declarations, important: a.important }) },
  apply_dom:       { ref: true,  method: 'patch.apply_dom',               params: (a, r) => {
    const opMap = {
      setAttribute: 'set_attribute',
      removeAttribute: 'remove_attribute',
      addClass: 'toggle_class',
      removeClass: 'toggle_class',
      setTextContent: 'set_text',
      setProperty: 'set_attribute',
    };
    return { target: { elementRef: r }, operation: opMap[a.operation] || a.operation, value: a.value, name: a.name };
  }},
  list:            { ref: false, method: 'patch.list',                    params: () => ({}) },
  rollback:        { ref: false, method: 'patch.rollback',                params: a => ({ patchId: a.patchId }) },
  commit_baseline: { ref: false, method: 'patch.commit_session_baseline', params: () => ({}) },
};

/**
 * @param {{ action: string, elementRef?: string, selector?: string, declarations?: Record<string, string>, important?: boolean, operation?: string, value?: unknown, name?: string, patchId?: string, tabId?: number, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
 * @returns {Promise<ToolResult>}
 */
export async function handlePatchTool(args) {
  return dispatchToolAction(PATCH_ACTIONS, args, 'patch');
}

/** @type {Record<string, ToolAction>} */
export const CAPTURE_ACTIONS = {
  element:             { ref: true,  method: 'screenshot.capture_element',       params: (_, r) => ({ elementRef: r }) },
  region:              { ref: false, method: 'screenshot.capture_region',        params: a => /** @type {Record<string, unknown>} */ (a.rect || {}) },
  cdp_document:        { ref: false, method: 'cdp.get_document',                params: () => ({}) },
  cdp_dom_snapshot:    { ref: false, method: 'cdp.get_dom_snapshot',             params: () => ({}) },
  cdp_box_model:       { ref: true,  method: 'cdp.get_box_model',               params: (_, r) => ({ elementRef: r }) },
  cdp_computed_styles: { ref: true,  method: 'cdp.get_computed_styles_for_node', params: (_, r) => ({ elementRef: r }) },
};

/**
 * @param {{ action: string, elementRef?: string, selector?: string, rect?: Record<string, unknown>, tabId?: number, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleCaptureTool(args) {
  return dispatchToolAction(CAPTURE_ACTIONS, args, 'capture');
}

/**
 * Returns the live runtime context: budget presets, method groups, and active limits.
 * Equivalent to `bbx skill`. Use this first to discover safe defaults before inspecting.
 *
 * @returns {Promise<ToolResult>}
 */
export async function handleSkillTool() {
  try {
    const { createRuntimeContext } = await import('../../protocol/src/index.js');
    const ctx = createRuntimeContext();
    return createToolResult('Runtime context retrieved.', { ok: true, runtimeContext: ctx });
  } catch (error) {
    return summarizeToolError(error);
  }
}

/**
 * Check MCP config and CLI skill installation status.
 *
 * @param {{ global?: boolean }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleSetupTool(args) {
  const { collectSetupStatus } = await import('../../agent-client/src/setup-status.js');
  const projectPath = args.global !== false ? (await import('node:os')).homedir() : process.cwd();
  const status = await collectSetupStatus({
    global: args.global !== false,
    cwd: process.cwd(),
    projectPath
  });
  const configuredMcp = status.mcpClients.filter((e) => e.configured).length;
  const installedSkills = status.skillTargets.filter((e) => e.installed).length;
  const summary = configuredMcp === 0 && installedSkills === 0
    ? 'No MCP or skill setup found. Run `bbx install-mcp` and `bbx install-skill`.'
    : `Setup: ${configuredMcp}/${status.mcpClients.length} MCP clients configured, ${installedSkills}/${status.skillTargets.length} skills installed.`;
  return createToolResult(summary, { ok: true, status });
}

/**
 * Tail recent bridge logs for debugging.
 *
 * @param {{ limit?: number, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleLogTool(args) {
  const normalizedArgs = applyLimitBudgetPreset(args, {
    quick: 10,
    normal: DEFAULT_CONSOLE_LIMIT,
    deep: 100,
  });
  return callBridgeTool('log.tail', {
    limit: normalizedArgs.limit ?? DEFAULT_CONSOLE_LIMIT,
  }, {
    tokenBudget: getToolTokenBudget(normalizedArgs),
  });
}

/**
 * Ping the bridge to check connectivity.
 *
 * @returns {Promise<ToolResult>}
 */
export async function handleHealthTool() {
  return callBridgeTool('health.ping');
}

/**
 * @param {{ calls?: Array<{ method?: string, params?: Record<string, unknown>, tabId?: number, budgetPreset?: 'quick' | 'normal' | 'deep' }> }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleBatchTool(args) {
  if (!Array.isArray(args.calls) || args.calls.length === 0) {
    return summarizeToolError('calls must be a non-empty array.');
  }

  return withToolClient(async (client) => {
    const results = await Promise.all(args.calls.map(async (call) => {
      if (!call || typeof call !== 'object' || typeof call.method !== 'string') {
        return {
          method: '',
          tabId: null,
          ok: false,
          summary: 'INVALID_REQUEST: Each batch call needs a method.',
          evidence: null,
          error: { code: 'INVALID_REQUEST', message: 'Each batch call needs a method.' },
          response: null,
        };
      }

      if (!METHODS.includes(/** @type {BridgeMethod} */ (call.method))) {
        return {
          method: call.method,
          tabId: null,
          ok: false,
          summary: `INVALID_REQUEST: Unknown bridge method "${call.method}".`,
          evidence: null,
          error: {
            code: 'INVALID_REQUEST',
            message: `Unknown bridge method "${call.method}".`,
          },
          response: null,
        };
      }

      const method = /** @type {BridgeMethod} */ (call.method);
      const tabId = bridgeMethodNeedsTab(method)
        ? (typeof call.tabId === 'number' ? call.tabId : null)
        : null;
      const tokenBudget = getToolTokenBudget(call);

      try {
        const response = await client.request({
          method,
          params: call.params || {},
          tabId,
          meta: {
            source: REQUEST_SOURCE,
            ...(tokenBudget != null ? { token_budget: tokenBudget } : {}),
          },
        });
        const summary = annotateBridgeSummary(summarizeBridgeResponse(response, method), response);
        return {
          method,
          tabId,
          ...summary,
          meta: response.meta,
          error: response.ok ? null : response.error,
          response: response.ok ? response.result : null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          method,
          tabId,
          ok: false,
          summary: `${method}: ${message}`,
          evidence: null,
          error: { code: 'INTERNAL_ERROR', message },
          response: null,
        };
      }
    }));

    const failureCount = results.filter((result) => !result.ok).length;
    const summary = failureCount === 0
      ? `Batch executed ${results.length} call(s).`
      : `Batch executed ${results.length} call(s) with ${failureCount} error(s).`;
    return createToolResult(summary, {
      ok: failureCount === 0,
      results,
    }, failureCount > 0);
  });
}

/**
 * @param {{ method: string, params?: Record<string, unknown>, tabId?: number }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleRawCallTool(args) {
  if (!METHODS.includes(/** @type {BridgeMethod} */ (args.method))) {
    return summarizeToolError(`Unknown bridge method "${args.method}".`);
  }

  return withToolClient(async (client) => {
    const response = await requestBridge(
      client,
      /** @type {BridgeMethod} */ (args.method),
      args.params || {},
      {
        tabId: typeof args.tabId === 'number' ? args.tabId : null,
        source: REQUEST_SOURCE
      }
    );

    if (!response.ok) {
      return createToolResult(response.error.message, {
        ok: false,
        error: response.error,
        response
      }, true);
    }

    return createToolResult(`Called ${args.method}.`, {
      ok: true,
      response: response.result
    });
  });
}
