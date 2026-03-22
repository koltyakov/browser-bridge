// @ts-check

import { METHODS } from '../../protocol/src/index.js';
import { loadSession } from '../../agent-client/src/session-store.js';
import {
  getDoctorReport,
  requestBridge,
  resolveRef,
  withBridgeClient
} from '../../agent-client/src/runtime.js';
import { summarizeBridgeResponse } from '../../agent-client/src/subagent.js';

/** @typedef {import('../../protocol/src/types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */

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
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: {
      summary,
      ...structuredContent
    },
    ...(isError ? { isError: true } : {})
  };
}

/**
 * @param {BridgeResponse} response
 * @param {string} [method]
 * @returns {ToolResult}
 */
function summarizeToolResponse(response, method) {
  const summary = summarizeBridgeResponse(response, method);
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
 * @returns {Promise<string>}
 */
async function resolveToolRef(client, input) {
  if (typeof input.elementRef === 'string' && input.elementRef) {
    return input.elementRef;
  }
  if (typeof input.selector === 'string' && input.selector) {
    return resolveRef(client, input.selector);
  }
  throw new Error('Provide either elementRef or selector.');
}

/**
 * @param {string | undefined} requestedSessionId
 * @returns {Promise<string>}
 */
async function getRequestedSessionId(requestedSessionId) {
  if (requestedSessionId) {
    return requestedSessionId;
  }
  const session = await loadSession();
  if (!session?.sessionId) {
    throw new Error('No saved session available. Run `bbx request-access` first.');
  }
  return session.sessionId;
}

/**
 * @param {BridgeMethod} method
 * @param {Record<string, unknown>} [params={}]
 * @param {{ sessionId?: string | null, summaryMethod?: string }} [options]
 * @returns {Promise<ToolResult>}
 */
async function callBridgeTool(method, params = {}, options = {}) {
  return withToolClient(async (client) => {
    const response = await requestBridge(client, method, params, {
      sessionId: options.sessionId ?? null
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
    const ref = entry.ref ? await resolveToolRef(client, /** @type {{ elementRef?: string, selector?: string }} */ (args)) : undefined;
    const response = await requestBridge(client, entry.method, entry.params(args, ref));
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
 * @param {{ action: string, sessionId?: string, tabId?: number, origin?: string, capabilities?: string[], ttlMs?: number, label?: string }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleSessionTool(args) {
  if (args.action === 'request_access') {
    return callBridgeTool('session.request_access', {
      tabId: args.tabId,
      origin: args.origin,
      capabilities: args.capabilities,
      ttlMs: args.ttlMs,
      label: args.label
    });
  }

  try {
    const sessionId = await getRequestedSessionId(args.sessionId);
    if (args.action === 'get_status') {
      return callBridgeTool('session.get_status', {}, { sessionId });
    }
    if (args.action === 'revoke') {
      return callBridgeTool('session.revoke', {}, { sessionId });
    }
  } catch (error) {
    return summarizeToolError(error);
  }

  return summarizeToolError(`Unsupported session action "${args.action}".`);
}

/** @type {Record<string, ToolAction>} */
export const DOM_ACTIONS = {
  query:              { ref: false, method: 'dom.query',                  params: a => ({ selector: a.selector || 'body', withinRef: a.withinRef, maxNodes: a.maxNodes, maxDepth: a.maxDepth, textBudget: a.textBudget, includeHtml: a.includeHtml, includeScreenshot: a.includeScreenshot, attributeAllowlist: a.attributeAllowlist, styleAllowlist: a.styleAllowlist, includeRoles: a.includeRoles }) },
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
 * @param {{ action: string, selector?: string, elementRef?: string, withinRef?: string, maxNodes?: number, maxDepth?: number, textBudget?: number, includeHtml?: boolean, includeScreenshot?: boolean, attributeAllowlist?: string[], styleAllowlist?: string[], includeRoles?: boolean, attributes?: string[], text?: string, exact?: boolean, maxResults?: number, role?: string, name?: string, state?: string, timeoutMs?: number, outer?: boolean, maxLength?: number }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleDomTool(args) {
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
 * @param {{ action: string, elementRef?: string, selector?: string, properties?: string[], x?: number, y?: number }} args
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
 * @param {{ action: string, expression?: string, awaitPromise?: boolean, timeoutMs?: number, returnByValue?: boolean, level?: string, clear?: boolean, limit?: number, type?: string, keys?: string[], textBudget?: number, urlPattern?: string }} args
 * @returns {Promise<ToolResult>}
 */
export async function handlePageTool(args) {
  const entry = PAGE_ACTIONS[args.action];
  if (!entry) return summarizeToolError(`Unsupported page action "${args.action}".`);
  return callBridgeTool(entry.method, entry.params(args));
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
 * @param {{ action: string, url?: string, waitForLoad?: boolean, timeoutMs?: number, top?: number, left?: number, behavior?: string, relative?: boolean, width?: number, height?: number, reset?: boolean }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleNavigationTool(args) {
  const entry = NAVIGATION_ACTIONS[args.action];
  if (!entry) return summarizeToolError(`Unsupported navigation action "${args.action}".`);
  return callBridgeTool(entry.method, entry.params(args));
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
 * @param {{ action: string, elementRef?: string, selector?: string, button?: string, clickCount?: number, text?: string, clear?: boolean, submit?: boolean, key?: string, modifiers?: string[], checked?: boolean, values?: string[], labels?: string[], indexes?: number[], duration?: number, sourceElementRef?: string, sourceSelector?: string, destinationElementRef?: string, destinationSelector?: string, offsetX?: number, offsetY?: number }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleInputTool(args) {
  return withToolClient(async (client) => {
    const elementTarget = async () => ({ elementRef: await resolveToolRef(client, args) });

    switch (args.action) {
      case 'click': {
        const response = await requestBridge(client, 'input.click', {
          target: await elementTarget(),
          button: args.button,
          clickCount: args.clickCount
        });
        return summarizeToolResponse(response, 'input.click');
      }
      case 'focus': {
        const response = await requestBridge(client, 'input.focus', {
          target: await elementTarget()
        });
        return summarizeToolResponse(response, 'input.focus');
      }
      case 'type': {
        const response = await requestBridge(client, 'input.type', {
          target: await elementTarget(),
          text: args.text,
          clear: args.clear,
          submit: args.submit
        });
        return summarizeToolResponse(response, 'input.type');
      }
      case 'press_key': {
        const target = (args.elementRef || args.selector) ? await elementTarget() : undefined;
        const response = await requestBridge(client, 'input.press_key', {
          target,
          key: args.key,
          modifiers: args.modifiers
        });
        return summarizeToolResponse(response, 'input.press_key');
      }
      case 'set_checked': {
        const response = await requestBridge(client, 'input.set_checked', {
          target: await elementTarget(),
          checked: args.checked
        });
        return summarizeToolResponse(response, 'input.set_checked');
      }
      case 'select_option': {
        const response = await requestBridge(client, 'input.select_option', {
          target: await elementTarget(),
          values: args.values,
          labels: args.labels,
          indexes: args.indexes
        });
        return summarizeToolResponse(response, 'input.select_option');
      }
      case 'hover': {
        const response = await requestBridge(client, 'input.hover', {
          target: await elementTarget(),
          duration: args.duration
        });
        return summarizeToolResponse(response, 'input.hover');
      }
      case 'drag': {
        const source = {
          elementRef: args.sourceElementRef || (args.sourceSelector ? await resolveRef(client, args.sourceSelector) : '')
        };
        const destination = {
          elementRef: args.destinationElementRef || (args.destinationSelector ? await resolveRef(client, args.destinationSelector) : '')
        };
        if (!source.elementRef || !destination.elementRef) {
          return summarizeToolError('sourceElementRef/sourceSelector and destinationElementRef/destinationSelector are required for drag.');
        }
        const response = await requestBridge(client, 'input.drag', {
          source,
          destination,
          offsetX: args.offsetX,
          offsetY: args.offsetY
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
  apply_dom:       { ref: true,  method: 'patch.apply_dom',               params: (a, r) => ({ target: { elementRef: r }, operation: a.operation, value: a.value, name: a.name }) },
  list:            { ref: false, method: 'patch.list',                    params: () => ({}) },
  rollback:        { ref: false, method: 'patch.rollback',                params: a => ({ patchId: a.patchId }) },
  commit_baseline: { ref: false, method: 'patch.commit_session_baseline', params: () => ({}) },
};

/**
 * @param {{ action: string, elementRef?: string, selector?: string, declarations?: Record<string, string>, important?: boolean, operation?: string, value?: unknown, name?: string, patchId?: string }} args
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
 * @param {{ action: string, elementRef?: string, selector?: string, rect?: Record<string, unknown> }} args
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
 * @param {{ method: string, params?: Record<string, unknown>, sessionId?: string }} args
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
      { sessionId: args.sessionId || null }
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
