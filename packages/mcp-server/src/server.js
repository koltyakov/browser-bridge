// @ts-check

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

import {
  handleCaptureTool,
  handleBatchTool,
  handleDomTool,
  handleHealthTool,
  handleInputTool,
  handleLogTool,
  handleNavigationTool,
  handlePageTool,
  handlePatchTool,
  handleRawCallTool,
  handleSetupTool,
  handleSkillTool,
  handleStatusTool,
  handleStylesLayoutTool,
  handleTabsTool
} from './handlers.js';
import {
  BUDGET_PRESETS,
  DEFAULT_CONSOLE_LIMIT,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_HTML_LENGTH,
  DEFAULT_MAX_NODES,
  DEFAULT_PAGE_TEXT_BUDGET,
  DEFAULT_TEXT_BUDGET,
  DEFAULT_WAIT_TIMEOUT_MS,
} from '../../protocol/src/index.js';

export const BUDGET_PRESET_DESCRIPTION = `Budget preset: "quick", "normal", or "deep" (defaults: query ${BUDGET_PRESETS.normal.maxNodes} nodes / depth ${BUDGET_PRESETS.normal.maxDepth} / text ${BUDGET_PRESETS.normal.textBudget}). Numeric fields override the preset when both are provided.`;
export const TAB_ID_DESCRIPTION = 'Explicit tab ID. Use to target a specific tab inside the enabled window instead of the default active-tab routing.';
export const ACCESS_REQUEST_FLOW_DESCRIPTION = 'If a tab-bound call returns ACCESS_DENIED because Browser Bridge is off, that failed call already surfaces an Enable cue in the extension popup/side panel for the relevant window. Ask the user to click Enable, then retry once.';

/**
 * @returns {McpServer}
 */
export function createBridgeMcpServer() {
  const server = new McpServer({
    name: 'browser-bridge',
    version: '0.1.0'
  });

  server.registerTool('browser_status', {
    title: 'Browser Bridge Status',
    description: `Check Browser Bridge readiness, daemon connectivity, extension state, and access routing health. ${ACCESS_REQUEST_FLOW_DESCRIPTION}`,
    inputSchema: {}
  }, handleStatusTool);

  server.registerTool('browser_setup', {
    title: 'Browser Bridge Setup Status',
    description: 'Check MCP configuration and CLI skill installation status. Use to verify agent integration.',
    inputSchema: {
      global: z.boolean().optional().describe('Check global (true) or local (false) config (default: true)')
    }
  }, handleSetupTool);

  server.registerTool('browser_logs', {
    title: 'Browser Bridge Logs',
    description: 'Tail recent bridge logs for debugging connection or access-routing issues.',
    inputSchema: {
      limit: z.number().optional().describe(`Maximum log entries to return (default: ${DEFAULT_CONSOLE_LIMIT})`),
      budgetPreset: z.enum(['quick', 'normal', 'deep']).optional().describe(BUDGET_PRESET_DESCRIPTION)
    }
  }, handleLogTool);

  server.registerTool('browser_health', {
    title: 'Browser Bridge Health',
    description: `Ping the bridge to verify daemon and extension connectivity. ${ACCESS_REQUEST_FLOW_DESCRIPTION}`,
    inputSchema: {}
  }, handleHealthTool);

  server.registerTool('browser_tabs', {
    title: 'Browser Tabs',
    description: 'List, create, or close browser tabs. IMPORTANT: Do NOT create new tabs unless the user explicitly requests it or the task absolutely requires a fresh page. Always prefer working in existing tabs - use action "list" first to find an appropriate tab.',
    inputSchema: {
      action: z.enum(['list', 'create', 'close']).describe('Tab operation: "list" to see available tabs (preferred), "create" only when necessary, "close" to remove a tab'),
      url: z.string().optional().describe('URL to open (for create action) - avoid unless user requested or task requires fresh page'),
      active: z.boolean().optional().describe('Whether to focus the new tab (default: true)'),
      tabId: z.number().optional().describe('Tab ID to close (required for close action)')
    }
  }, handleTabsTool);

  server.registerTool('browser_dom', {
    title: 'Browser DOM',
    description: `Query, describe, read, wait for, or search DOM elements in the live tab. Default routing follows the active tab in the enabled window. Use elementRef from prior results to avoid re-querying. \`accessibility_tree\` is debugger-backed and should be a last resort after query/find actions. ${ACCESS_REQUEST_FLOW_DESCRIPTION}`,
    inputSchema: {
      action: z.enum(['query', 'describe', 'text', 'attributes', 'wait', 'find_text', 'find_role', 'html', 'accessibility_tree']).describe('DOM operation to perform'),
      tabId: z.number().optional().describe(TAB_ID_DESCRIPTION),
      budgetPreset: z.enum(['quick', 'normal', 'deep']).optional().describe(BUDGET_PRESET_DESCRIPTION),
      selector: z.string().optional().describe('CSS selector (used if no elementRef; resolves to first match)'),
      elementRef: z.string().optional().describe('Element reference from prior query (preferred over selector)'),
      withinRef: z.string().optional().describe('Scope query to this elementRef subtree'),
      maxNodes: z.number().optional().describe(`Maximum nodes to return (default: ${DEFAULT_MAX_NODES})`),
      maxDepth: z.number().optional().describe(`Maximum tree depth (default: ${DEFAULT_MAX_DEPTH})`),
      textBudget: z.number().optional().describe(`Max chars of text content per node (default: ${DEFAULT_TEXT_BUDGET})`),
      includeBbox: z.boolean().optional().describe('Include bounding box (default: true, set false to save tokens)'),
      attributeAllowlist: z.array(z.string()).optional().describe('Only include these attributes (reduces tokens)'),
      attributes: z.array(z.string()).optional().describe('Attribute names to fetch (for attributes action)'),
      text: z.string().optional().describe('Text to search for (for find_text/wait actions)'),
      exact: z.boolean().optional().describe('Require exact text match (default: false, substring match)'),
      maxResults: z.number().optional().describe('Maximum search results (default: 10)'),
      role: z.string().optional().describe('ARIA role to search for (for find_role action)'),
      name: z.string().optional().describe('Accessible name to match with role'),
      state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional().describe('Expected element state (for wait action)'),
      timeoutMs: z.number().optional().describe(`Timeout for wait operations (default: ${DEFAULT_WAIT_TIMEOUT_MS})`),
      outer: z.boolean().optional().describe('Return outerHTML instead of innerHTML (default: false)'),
      maxLength: z.number().optional().describe(`Max HTML chars to return (default: ${DEFAULT_MAX_HTML_LENGTH})`)
    }
  }, handleDomTool);

  server.registerTool('browser_styles_layout', {
    title: 'Browser Styles And Layout',
    description: `Read computed styles, matched CSS rules, box models, and perform hit tests. Default routing follows the active tab in the enabled window. Use elementRef from prior queries. ${ACCESS_REQUEST_FLOW_DESCRIPTION}`,
    inputSchema: {
      action: z.enum(['computed', 'matched_rules', 'box_model', 'hit_test']).describe('Style/layout operation to perform'),
      tabId: z.number().optional().describe(TAB_ID_DESCRIPTION),
      budgetPreset: z.enum(['quick', 'normal', 'deep']).optional().describe(BUDGET_PRESET_DESCRIPTION),
      elementRef: z.string().optional().describe('Element reference (preferred over selector)'),
      selector: z.string().optional().describe('CSS selector (used if no elementRef)'),
      properties: z.array(z.string()).optional().describe('Style properties to fetch (omitting returns all - expensive)'),
      x: z.number().optional().describe('X coordinate for hit_test (viewport relative)'),
      y: z.number().optional().describe('Y coordinate for hit_test (viewport relative)')
    }
  }, handleStylesLayoutTool);

  server.registerTool('browser_page', {
    title: 'Browser Page State',
    description: `Read page state, evaluate JavaScript, inspect console/network, fetch storage, or get performance metrics. Default routing follows the active tab in the enabled window. \`evaluate\` and \`performance\` are debugger-backed and should be used only after lighter reads fail. ${ACCESS_REQUEST_FLOW_DESCRIPTION}`,
    inputSchema: {
      action: z.enum(['state', 'evaluate', 'console', 'wait_for_load', 'storage', 'text', 'network', 'performance']).describe('Page operation to perform'),
      tabId: z.number().optional().describe(TAB_ID_DESCRIPTION),
      budgetPreset: z.enum(['quick', 'normal', 'deep']).optional().describe(BUDGET_PRESET_DESCRIPTION),
      expression: z.string().optional().describe('JavaScript expression to evaluate (for evaluate action)'),
      awaitPromise: z.boolean().optional().describe('Await returned promises (default: false)'),
      timeoutMs: z.number().optional().describe(`Timeout for evaluate/wait operations (default: ${DEFAULT_WAIT_TIMEOUT_MS})`),
      returnByValue: z.boolean().optional().describe('Return actual value vs JSON (default: true)'),
      level: z.string().optional().describe('Minimum console level: log, warn, error (default: all)'),
      clear: z.boolean().optional().describe('Clear buffer after reading (default: false)'),
      limit: z.number().optional().describe(`Maximum entries to return (default: ${DEFAULT_CONSOLE_LIMIT})`),
      type: z.enum(['local', 'session']).optional().describe('Storage type to read (default: local)'),
      keys: z.array(z.string()).optional().describe('Specific storage keys to fetch (omitting returns all)'),
      textBudget: z.number().optional().describe(`Max chars for page text (default: ${DEFAULT_PAGE_TEXT_BUDGET})`),
      urlPattern: z.string().optional().describe('Filter network entries by URL pattern')
    }
  }, handlePageTool);

  server.registerTool('browser_navigation', {
    title: 'Browser Navigation',
    description: `Navigate, reload, move through history, scroll, or resize the live tab. Default routing follows the active tab in the enabled window. \`resize\` is debugger-backed and should be used only when an exact viewport override is required. ${ACCESS_REQUEST_FLOW_DESCRIPTION}`,
    inputSchema: {
      action: z.enum(['navigate', 'reload', 'go_back', 'go_forward', 'scroll', 'resize']).describe('Navigation operation to perform'),
      tabId: z.number().optional().describe(TAB_ID_DESCRIPTION),
      budgetPreset: z.enum(['quick', 'normal', 'deep']).optional().describe(BUDGET_PRESET_DESCRIPTION),
      url: z.string().optional().describe('URL to navigate to (for navigate action)'),
      waitForLoad: z.boolean().optional().describe('Wait for load event (default: true)'),
      timeoutMs: z.number().optional().describe('Timeout for navigation (default: 30000)'),
      top: z.number().optional().describe('Scroll target Y position (pixels)'),
      left: z.number().optional().describe('Scroll target X position (pixels)'),
      behavior: z.enum(['auto', 'smooth']).optional().describe('Scroll behavior (default: auto)'),
      relative: z.boolean().optional().describe('Scroll relative to current position (default: false)'),
      width: z.number().optional().describe('Viewport width in pixels'),
      height: z.number().optional().describe('Viewport height in pixels'),
      reset: z.boolean().optional().describe('Reset viewport to original size (for resize)')
    }
  }, handleNavigationTool);

  server.registerTool('browser_input', {
    title: 'Browser Input',
    description: `Simulate user input: click, focus, type, press keys, set checked, select options, hover, or drag. Default routing follows the active tab in the enabled window. Use elementRef from prior queries. ${ACCESS_REQUEST_FLOW_DESCRIPTION}`,
    inputSchema: {
      action: z.enum(['click', 'focus', 'type', 'press_key', 'set_checked', 'select_option', 'hover', 'drag']).describe('Input operation to perform'),
      tabId: z.number().optional().describe(TAB_ID_DESCRIPTION),
      budgetPreset: z.enum(['quick', 'normal', 'deep']).optional().describe(BUDGET_PRESET_DESCRIPTION),
      elementRef: z.string().optional().describe('Target element reference (preferred over selector)'),
      selector: z.string().optional().describe('CSS selector (used if no elementRef)'),
      button: z.enum(['left', 'middle', 'right']).optional().describe('Mouse button for click (default: left)'),
      clickCount: z.number().optional().describe('Click count (1=single, 2=double)'),
      text: z.string().optional().describe('Text to type (for type action)'),
      clear: z.boolean().optional().describe('Clear field before typing (default: false)'),
      submit: z.boolean().optional().describe('Press Enter after typing (default: false)'),
      key: z.string().optional().describe('Key to press (e.g., "Enter", "Tab", "ArrowDown")'),
      modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional().describe('Modifier keys'),
      checked: z.boolean().optional().describe('Checked state (for set_checked action)'),
      values: z.array(z.string()).optional().describe('Option values to select'),
      labels: z.array(z.string()).optional().describe('Option labels to select (alternative to values)'),
      indexes: z.array(z.number()).optional().describe('Option indexes to select (alternative to values/labels)'),
      duration: z.number().optional().describe('Hover duration in ms (default: 100)'),
      sourceElementRef: z.string().optional().describe('Drag source element (for drag action)'),
      sourceSelector: z.string().optional().describe('Drag source selector (alternative to sourceElementRef)'),
      destinationElementRef: z.string().optional().describe('Drag destination element (for drag action)'),
      destinationSelector: z.string().optional().describe('Drag destination selector (alternative to destinationElementRef)'),
      offsetX: z.number().optional().describe('Drag drop offset X (default: 0)'),
      offsetY: z.number().optional().describe('Drag drop offset Y (default: 0)')
    }
  }, handleInputTool);

  server.registerTool('browser_patch', {
    title: 'Browser Patch',
    description: `Apply reversible style or DOM patches. All patches can be rolled back. Use to prototype UI changes without modifying source. ${ACCESS_REQUEST_FLOW_DESCRIPTION}`,
    inputSchema: {
      action: z.enum(['apply_styles', 'apply_dom', 'list', 'rollback', 'commit_baseline']).describe('Patch operation to perform'),
      tabId: z.number().optional().describe(TAB_ID_DESCRIPTION),
      budgetPreset: z.enum(['quick', 'normal', 'deep']).optional().describe(BUDGET_PRESET_DESCRIPTION),
      elementRef: z.string().optional().describe('Target element reference (preferred over selector)'),
      selector: z.string().optional().describe('CSS selector (used if no elementRef)'),
      declarations: z.record(z.string(), z.string()).optional().describe('CSS property: value pairs (for apply_styles)'),
      important: z.boolean().optional().describe('Add !important flag (default: false)'),
      operation: z.enum(['setAttribute', 'removeAttribute', 'addClass', 'removeClass', 'setTextContent', 'setProperty']).optional().describe('DOM mutation type'),
      value: z.unknown().optional().describe('Value for the DOM operation'),
      name: z.string().optional().describe('Attribute/class/property name (for apply_dom)'),
      patchId: z.string().optional().describe('Patch ID to rollback (omit for most recent)')
    }
  }, handlePatchTool);

  server.registerTool('browser_capture', {
    title: 'Browser Capture',
    description: `Capture screenshots or CDP snapshots. Use only when structured reads are insufficient. Prefer element captures or tight region crops instead of larger screenshots. All capture actions are debugger-backed and token-expensive. ${ACCESS_REQUEST_FLOW_DESCRIPTION}`,
    inputSchema: {
      action: z.enum(['element', 'region', 'cdp_document', 'cdp_dom_snapshot', 'cdp_box_model', 'cdp_computed_styles']).describe('Capture operation: prefer element first, then tight region crops only when element capture cannot express the needed area; cdp_* for low-level data'),
      tabId: z.number().optional().describe(TAB_ID_DESCRIPTION),
      budgetPreset: z.enum(['quick', 'normal', 'deep']).optional().describe(BUDGET_PRESET_DESCRIPTION),
      elementRef: z.string().optional().describe('Element reference to screenshot (for element action; preferred for partial captures)'),
      selector: z.string().optional().describe('CSS selector (used if no elementRef)'),
      rect: z.object({
        x: z.number().describe('Region left edge (viewport pixels)'),
        y: z.number().describe('Region top edge (viewport pixels)'),
        width: z.number().describe('Region width (pixels)'),
        height: z.number().describe('Region height (pixels)')
      }).optional().describe('Screenshot region (for region action; keep this crop as tight as possible)')
    }
  }, handleCaptureTool);

  server.registerTool('browser_batch', {
    title: 'Browser Bridge Batch',
    description: `Execute multiple existing Browser Bridge calls in parallel. Preserves call order in the response and reuses one resolved default routed tab when possible. ${ACCESS_REQUEST_FLOW_DESCRIPTION}`,
    inputSchema: {
      calls: z.array(z.object({
        method: z.string().describe('Bridge method name (e.g. "dom.query", "page.get_text")'),
        params: z.record(z.string(), z.unknown()).optional().describe('Method params for this call'),
        tabId: z.number().optional().describe(TAB_ID_DESCRIPTION),
        budgetPreset: z.enum(['quick', 'normal', 'deep']).optional().describe(BUDGET_PRESET_DESCRIPTION)
      })).min(1).describe('Calls to execute in parallel')
    }
  }, handleBatchTool);

  server.registerTool('browser_call', {
    title: 'Raw Browser Bridge Call',
    description: `Call any Browser Bridge method directly. Escape hatch when grouped tools are insufficient. Prefer specific tools when available. ${ACCESS_REQUEST_FLOW_DESCRIPTION}`,
    inputSchema: {
      method: z.string().describe('Bridge method name (e.g., "dom.query", "input.click")'),
      params: z.record(z.string(), z.unknown()).optional().describe('Method parameters as object'),
      tabId: z.number().optional().describe(TAB_ID_DESCRIPTION)
    }
  }, handleRawCallTool);

  server.registerTool('browser_skill', {
    title: 'Browser Bridge Runtime Context',
    description: 'Return live runtime context: budget presets, method groups, and active limits. Call this first to discover safe defaults before inspecting a page.',
    inputSchema: {}
  }, handleSkillTool);

  return server;
}

/**
 * @returns {Promise<void>}
 */
export async function startBridgeMcpServer() {
  const server = createBridgeMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
