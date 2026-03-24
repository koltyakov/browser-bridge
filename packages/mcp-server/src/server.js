// @ts-check

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

import {
  handleCaptureTool,
  handleDomTool,
  handleHealthTool,
  handleInputTool,
  handleLogTool,
  handleNavigationTool,
  handlePageTool,
  handlePatchTool,
  handleRawCallTool,
  handleSessionTool,
  handleSetupTool,
  handleSkillTool,
  handleStatusTool,
  handleStylesLayoutTool,
  handleTabsTool
} from './handlers.js';

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
    description: 'Check Browser Bridge readiness, daemon connectivity, extension state, and session health.',
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
    description: 'Tail recent bridge logs for debugging connection or session issues.',
    inputSchema: {
      limit: z.number().optional().describe('Maximum log entries to return (default: 50)')
    }
  }, handleLogTool);

  server.registerTool('browser_health', {
    title: 'Browser Bridge Health',
    description: 'Ping the bridge to verify daemon and extension connectivity.',
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

  server.registerTool('browser_session', {
    title: 'Browser Session',
    description: 'Request access to a tab, inspect the saved session, or revoke the current session. ACCESS REQUEST FLOW: request_access requires user approval in the extension popup - expect a brief delay. On APPROVAL_PENDING, wait ~3s and retry up to 4 times. If still pending, tell the user: "Please approve the request in the Browser Bridge extension popup, then type READY so I can continue." Retry once after they respond.',
    inputSchema: {
      action: z.enum(['request_access', 'get_status', 'revoke']).describe('Session operation: request_access prompts user, get_status/revoke use saved session'),
      sessionId: z.string().optional().describe('Explicit session ID (uses saved session if omitted)'),
      tabId: z.number().optional().describe('Tab ID to request access to (uses active tab if omitted)'),
      origin: z.string().optional().describe('Origin pattern to match (e.g., "https://example.com")'),
      capabilities: z.array(z.string()).optional().describe('Requested capabilities (default: ["inspect", "interact"])'),
      ttlMs: z.number().optional().describe('Session lifetime in milliseconds'),
      label: z.string().optional().describe('Human-readable label for the session')
    }
  }, handleSessionTool);

  server.registerTool('browser_dom', {
    title: 'Browser DOM',
    description: 'Query, describe, read, wait for, or search DOM elements in the approved live tab. Use elementRef from prior results to avoid re-querying.',
    inputSchema: {
      action: z.enum(['query', 'describe', 'text', 'attributes', 'wait', 'find_text', 'find_role', 'html', 'accessibility_tree']).describe('DOM operation to perform'),
      selector: z.string().optional().describe('CSS selector (used if no elementRef; resolves to first match)'),
      elementRef: z.string().optional().describe('Element reference from prior query (preferred over selector)'),
      withinRef: z.string().optional().describe('Scope query to this elementRef subtree'),
      maxNodes: z.number().optional().describe('Maximum nodes to return (default: 25)'),
      maxDepth: z.number().optional().describe('Maximum tree depth (default: 4)'),
      textBudget: z.number().optional().describe('Max chars of text content per node (default: 160)'),
      includeHtml: z.boolean().optional().describe('Include innerHTML in results (expensive)'),
      includeScreenshot: z.boolean().optional().describe('Include base64 screenshot (very expensive)'),
      includeBbox: z.boolean().optional().describe('Include bounding box (default: true, set false to save tokens)'),
      attributeAllowlist: z.array(z.string()).optional().describe('Only include these attributes (reduces tokens)'),
      styleAllowlist: z.array(z.string()).optional().describe('Only include these style properties (reduces tokens)'),
      includeRoles: z.boolean().optional().describe('Include ARIA role and accessible name (default: true)'),
      attributes: z.array(z.string()).optional().describe('Attribute names to fetch (for attributes action)'),
      text: z.string().optional().describe('Text to search for (for find_text/wait actions)'),
      exact: z.boolean().optional().describe('Require exact text match (default: false, substring match)'),
      maxResults: z.number().optional().describe('Maximum search results (default: 10)'),
      role: z.string().optional().describe('ARIA role to search for (for find_role action)'),
      name: z.string().optional().describe('Accessible name to match with role'),
      state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional().describe('Expected element state (for wait action)'),
      timeoutMs: z.number().optional().describe('Timeout for wait operations (default: 5000)'),
      outer: z.boolean().optional().describe('Return outerHTML instead of innerHTML (default: false)'),
      maxLength: z.number().optional().describe('Max HTML chars to return (default: 10000)')
    }
  }, handleDomTool);

  server.registerTool('browser_styles_layout', {
    title: 'Browser Styles And Layout',
    description: 'Read computed styles, matched CSS rules, box models, and perform hit tests. Use elementRef from prior queries.',
    inputSchema: {
      action: z.enum(['computed', 'matched_rules', 'box_model', 'hit_test']).describe('Style/layout operation to perform'),
      elementRef: z.string().optional().describe('Element reference (preferred over selector)'),
      selector: z.string().optional().describe('CSS selector (used if no elementRef)'),
      properties: z.array(z.string()).optional().describe('Style properties to fetch (omitting returns all - expensive)'),
      x: z.number().optional().describe('X coordinate for hit_test (viewport relative)'),
      y: z.number().optional().describe('Y coordinate for hit_test (viewport relative)')
    }
  }, handleStylesLayoutTool);

  server.registerTool('browser_page', {
    title: 'Browser Page State',
    description: 'Read page state, evaluate JavaScript, inspect console/network, fetch storage, or get performance metrics.',
    inputSchema: {
      action: z.enum(['state', 'evaluate', 'console', 'wait_for_load', 'storage', 'text', 'network', 'performance']).describe('Page operation to perform'),
      expression: z.string().optional().describe('JavaScript expression to evaluate (for evaluate action)'),
      awaitPromise: z.boolean().optional().describe('Await returned promises (default: false)'),
      timeoutMs: z.number().optional().describe('Timeout for evaluate/wait operations (default: 5000)'),
      returnByValue: z.boolean().optional().describe('Return actual value vs JSON (default: true)'),
      level: z.string().optional().describe('Minimum console level: log, warn, error (default: all)'),
      clear: z.boolean().optional().describe('Clear buffer after reading (default: false)'),
      limit: z.number().optional().describe('Maximum entries to return (default: 50)'),
      type: z.enum(['local', 'session']).optional().describe('Storage type to read (default: local)'),
      keys: z.array(z.string()).optional().describe('Specific storage keys to fetch (omitting returns all)'),
      textBudget: z.number().optional().describe('Max chars for page text (default: 4000)'),
      urlPattern: z.string().optional().describe('Filter network entries by URL pattern')
    }
  }, handlePageTool);

  server.registerTool('browser_navigation', {
    title: 'Browser Navigation',
    description: 'Navigate, reload, move through history, scroll, or resize the approved live tab.',
    inputSchema: {
      action: z.enum(['navigate', 'reload', 'go_back', 'go_forward', 'scroll', 'resize']).describe('Navigation operation to perform'),
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
    description: 'Simulate user input: click, focus, type, press keys, set checked, select options, hover, or drag. Use elementRef from prior queries.',
    inputSchema: {
      action: z.enum(['click', 'focus', 'type', 'press_key', 'set_checked', 'select_option', 'hover', 'drag']).describe('Input operation to perform'),
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
    description: 'Apply reversible style or DOM patches. All patches can be rolled back. Use to prototype UI changes without modifying source.',
    inputSchema: {
      action: z.enum(['apply_styles', 'apply_dom', 'list', 'rollback', 'commit_baseline']).describe('Patch operation to perform'),
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
    description: 'Capture screenshots or CDP snapshots. Use only when structured reads are insufficient - screenshots are token-expensive.',
    inputSchema: {
      action: z.enum(['element', 'region', 'cdp_document', 'cdp_dom_snapshot', 'cdp_box_model', 'cdp_computed_styles']).describe('Capture operation: element/region for screenshots, cdp_* for low-level data'),
      elementRef: z.string().optional().describe('Element reference to screenshot (for element action)'),
      selector: z.string().optional().describe('CSS selector (used if no elementRef)'),
      rect: z.object({
        x: z.number().describe('Region left edge (viewport pixels)'),
        y: z.number().describe('Region top edge (viewport pixels)'),
        width: z.number().describe('Region width (pixels)'),
        height: z.number().describe('Region height (pixels)')
      }).optional().describe('Screenshot region (for region action)')
    }
  }, handleCaptureTool);

  server.registerTool('browser_call', {
    title: 'Raw Browser Bridge Call',
    description: 'Call any Browser Bridge method directly. Escape hatch when grouped tools are insufficient. Prefer specific tools when available.',
    inputSchema: {
      method: z.string().describe('Bridge method name (e.g., "dom.query", "input.click")'),
      params: z.record(z.string(), z.unknown()).optional().describe('Method parameters as object'),
      sessionId: z.string().optional().describe('Explicit session ID (uses saved session if omitted)')
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
