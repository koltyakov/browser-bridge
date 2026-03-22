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
 * @param {{ action: string, url?: string, tabId?: number }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleTabsTool(args) {
  if (args.action === 'list') {
    return callBridgeTool('tabs.list');
  }
  if (args.action === 'create') {
    return callBridgeTool('tabs.create', {
      url: args.url
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

/**
 * @param {{ action: string, selector?: string, elementRef?: string, withinRef?: string, maxNodes?: number, maxDepth?: number, textBudget?: number, includeHtml?: boolean, includeScreenshot?: boolean, attributeAllowlist?: string[], styleAllowlist?: string[], includeRoles?: boolean, attributes?: string[], text?: string, exact?: boolean, maxResults?: number, role?: string, name?: string, state?: string, timeoutMs?: number, outer?: boolean, maxLength?: number }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleDomTool(args) {
  return withToolClient(async (client) => {
    switch (args.action) {
      case 'query': {
        const response = await requestBridge(client, 'dom.query', {
          selector: args.selector || 'body',
          withinRef: args.withinRef,
          maxNodes: args.maxNodes,
          maxDepth: args.maxDepth,
          textBudget: args.textBudget,
          includeHtml: args.includeHtml,
          includeScreenshot: args.includeScreenshot,
          attributeAllowlist: args.attributeAllowlist,
          styleAllowlist: args.styleAllowlist,
          includeRoles: args.includeRoles
        });
        return summarizeToolResponse(response, 'dom.query');
      }
      case 'describe': {
        const elementRef = await resolveToolRef(client, args);
        const response = await requestBridge(client, 'dom.describe', { elementRef });
        return summarizeToolResponse(response, 'dom.describe');
      }
      case 'text': {
        const elementRef = await resolveToolRef(client, args);
        const response = await requestBridge(client, 'dom.get_text', {
          elementRef,
          textBudget: args.textBudget
        });
        return summarizeToolResponse(response, 'dom.get_text');
      }
      case 'attributes': {
        const elementRef = await resolveToolRef(client, args);
        const response = await requestBridge(client, 'dom.get_attributes', {
          elementRef,
          attributes: args.attributes || []
        });
        return summarizeToolResponse(response, 'dom.get_attributes');
      }
      case 'wait': {
        const response = await requestBridge(client, 'dom.wait_for', {
          selector: args.selector,
          text: args.text,
          state: args.state,
          timeoutMs: args.timeoutMs
        });
        return summarizeToolResponse(response, 'dom.wait_for');
      }
      case 'find_text': {
        const response = await requestBridge(client, 'dom.find_by_text', {
          text: args.text,
          exact: args.exact,
          selector: args.selector,
          maxResults: args.maxResults
        });
        return summarizeToolResponse(response, 'dom.find_by_text');
      }
      case 'find_role': {
        const response = await requestBridge(client, 'dom.find_by_role', {
          role: args.role,
          name: args.name,
          selector: args.selector,
          maxResults: args.maxResults
        });
        return summarizeToolResponse(response, 'dom.find_by_role');
      }
      case 'html': {
        const elementRef = await resolveToolRef(client, args);
        const response = await requestBridge(client, 'dom.get_html', {
          elementRef,
          outer: args.outer,
          maxLength: args.maxLength
        });
        return summarizeToolResponse(response, 'dom.get_html');
      }
      case 'accessibility_tree': {
        const response = await requestBridge(client, 'dom.get_accessibility_tree', {
          maxNodes: args.maxNodes,
          maxDepth: args.maxDepth
        });
        return summarizeToolResponse(response, 'dom.get_accessibility_tree');
      }
      default:
        return summarizeToolError(`Unsupported DOM action "${args.action}".`);
    }
  });
}

/**
 * @param {{ action: string, elementRef?: string, selector?: string, properties?: string[], x?: number, y?: number }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleStylesLayoutTool(args) {
  return withToolClient(async (client) => {
    switch (args.action) {
      case 'computed': {
        const elementRef = await resolveToolRef(client, args);
        const response = await requestBridge(client, 'styles.get_computed', {
          elementRef,
          properties: args.properties
        });
        return summarizeToolResponse(response, 'styles.get_computed');
      }
      case 'matched_rules': {
        const elementRef = await resolveToolRef(client, args);
        const response = await requestBridge(client, 'styles.get_matched_rules', { elementRef });
        return summarizeToolResponse(response, 'styles.get_matched_rules');
      }
      case 'box_model': {
        const elementRef = await resolveToolRef(client, args);
        const response = await requestBridge(client, 'layout.get_box_model', { elementRef });
        return summarizeToolResponse(response, 'layout.get_box_model');
      }
      case 'hit_test': {
        const response = await requestBridge(client, 'layout.hit_test', {
          x: args.x,
          y: args.y
        });
        return summarizeToolResponse(response, 'layout.hit_test');
      }
      default:
        return summarizeToolError(`Unsupported styles/layout action "${args.action}".`);
    }
  });
}

/**
 * @param {{ action: string, expression?: string, awaitPromise?: boolean, timeoutMs?: number, returnByValue?: boolean, level?: string, clear?: boolean, limit?: number, type?: string, keys?: string[], textBudget?: number, urlPattern?: string }} args
 * @returns {Promise<ToolResult>}
 */
export async function handlePageTool(args) {
  switch (args.action) {
    case 'state':
      return callBridgeTool('page.get_state');
    case 'evaluate':
      return callBridgeTool('page.evaluate', {
        expression: args.expression,
        awaitPromise: args.awaitPromise,
        timeoutMs: args.timeoutMs,
        returnByValue: args.returnByValue
      }, { summaryMethod: 'page.evaluate' });
    case 'console':
      return callBridgeTool('page.get_console', {
        level: args.level,
        clear: args.clear,
        limit: args.limit
      }, { summaryMethod: 'page.get_console' });
    case 'wait_for_load':
      return callBridgeTool('page.wait_for_load_state', {
        timeoutMs: args.timeoutMs
      }, { summaryMethod: 'page.wait_for_load_state' });
    case 'storage':
      return callBridgeTool('page.get_storage', {
        type: args.type,
        keys: args.keys
      }, { summaryMethod: 'page.get_storage' });
    case 'text':
      return callBridgeTool('page.get_text', {
        textBudget: args.textBudget
      }, { summaryMethod: 'page.get_text' });
    case 'network':
      return callBridgeTool('page.get_network', {
        clear: args.clear,
        limit: args.limit,
        urlPattern: args.urlPattern
      }, { summaryMethod: 'page.get_network' });
    case 'performance':
      return callBridgeTool('performance.get_metrics', {}, { summaryMethod: 'performance.get_metrics' });
    default:
      return summarizeToolError(`Unsupported page action "${args.action}".`);
  }
}

/**
 * @param {{ action: string, url?: string, waitForLoad?: boolean, timeoutMs?: number, top?: number, left?: number, behavior?: string, relative?: boolean, width?: number, height?: number, reset?: boolean }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleNavigationTool(args) {
  switch (args.action) {
    case 'navigate':
      return callBridgeTool('navigation.navigate', {
        url: args.url,
        waitForLoad: args.waitForLoad,
        timeoutMs: args.timeoutMs
      });
    case 'reload':
      return callBridgeTool('navigation.reload', {
        waitForLoad: args.waitForLoad,
        timeoutMs: args.timeoutMs
      });
    case 'go_back':
      return callBridgeTool('navigation.go_back', {
        waitForLoad: args.waitForLoad,
        timeoutMs: args.timeoutMs
      });
    case 'go_forward':
      return callBridgeTool('navigation.go_forward', {
        waitForLoad: args.waitForLoad,
        timeoutMs: args.timeoutMs
      });
    case 'scroll':
      return callBridgeTool('viewport.scroll', {
        top: args.top,
        left: args.left,
        behavior: args.behavior,
        relative: args.relative
      }, { summaryMethod: 'viewport.scroll' });
    case 'resize':
      return callBridgeTool('viewport.resize', {
        width: args.width,
        height: args.height,
        reset: args.reset
      }, { summaryMethod: 'viewport.resize' });
    default:
      return summarizeToolError(`Unsupported navigation action "${args.action}".`);
  }
}

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

/**
 * @param {{ action: string, elementRef?: string, selector?: string, declarations?: Record<string, string>, important?: boolean, operation?: string, value?: unknown, name?: string, patchId?: string }} args
 * @returns {Promise<ToolResult>}
 */
export async function handlePatchTool(args) {
  return withToolClient(async (client) => {
    switch (args.action) {
      case 'apply_styles': {
        const elementRef = await resolveToolRef(client, args);
        const response = await requestBridge(client, 'patch.apply_styles', {
          target: { elementRef },
          declarations: args.declarations,
          important: args.important
        });
        return summarizeToolResponse(response, 'patch.apply_styles');
      }
      case 'apply_dom': {
        const elementRef = await resolveToolRef(client, args);
        const response = await requestBridge(client, 'patch.apply_dom', {
          target: { elementRef },
          operation: args.operation,
          value: args.value,
          name: args.name
        });
        return summarizeToolResponse(response, 'patch.apply_dom');
      }
      case 'list': {
        const response = await requestBridge(client, 'patch.list');
        return summarizeToolResponse(response, 'patch.list');
      }
      case 'rollback': {
        const response = await requestBridge(client, 'patch.rollback', {
          patchId: args.patchId
        });
        return summarizeToolResponse(response, 'patch.rollback');
      }
      case 'commit_baseline': {
        const response = await requestBridge(client, 'patch.commit_session_baseline');
        return summarizeToolResponse(response, 'patch.commit_session_baseline');
      }
      default:
        return summarizeToolError(`Unsupported patch action "${args.action}".`);
    }
  });
}

/**
 * @param {{ action: string, elementRef?: string, selector?: string, rect?: Record<string, unknown> }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleCaptureTool(args) {
  return withToolClient(async (client) => {
    switch (args.action) {
      case 'element': {
        const elementRef = await resolveToolRef(client, args);
        const response = await requestBridge(client, 'screenshot.capture_element', { elementRef });
        return summarizeToolResponse(response, 'screenshot.capture_element');
      }
      case 'region': {
        const response = await requestBridge(client, 'screenshot.capture_region', args.rect || {});
        return summarizeToolResponse(response, 'screenshot.capture_region');
      }
      case 'cdp_document': {
        const response = await requestBridge(client, 'cdp.get_document');
        return summarizeToolResponse(response, 'cdp.get_document');
      }
      case 'cdp_dom_snapshot': {
        const response = await requestBridge(client, 'cdp.get_dom_snapshot');
        return summarizeToolResponse(response, 'cdp.get_dom_snapshot');
      }
      case 'cdp_box_model': {
        const elementRef = await resolveToolRef(client, args);
        const response = await requestBridge(client, 'cdp.get_box_model', { elementRef });
        return summarizeToolResponse(response, 'cdp.get_box_model');
      }
      case 'cdp_computed_styles': {
        const elementRef = await resolveToolRef(client, args);
        const response = await requestBridge(client, 'cdp.get_computed_styles_for_node', { elementRef });
        return summarizeToolResponse(response, 'cdp.get_computed_styles_for_node');
      }
      default:
        return summarizeToolError(`Unsupported capture action "${args.action}".`);
    }
  });
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
