// @ts-check

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

import {
  handleCaptureTool,
  handleDomTool,
  handleInputTool,
  handleNavigationTool,
  handlePageTool,
  handlePatchTool,
  handleRawCallTool,
  handleSessionTool,
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

  server.registerTool('browser_tabs', {
    title: 'Browser Tabs',
    description: 'List, create, or close browser tabs through Browser Bridge.',
    inputSchema: {
      action: z.enum(['list', 'create', 'close']),
      url: z.string().optional(),
      active: z.boolean().optional(),
      tabId: z.number().optional()
    }
  }, handleTabsTool);

  server.registerTool('browser_session', {
    title: 'Browser Session',
    description: 'Request access to a tab, inspect the saved session, or revoke the current session.',
    inputSchema: {
      action: z.enum(['request_access', 'get_status', 'revoke']),
      sessionId: z.string().optional(),
      tabId: z.number().optional(),
      origin: z.string().optional(),
      capabilities: z.array(z.string()).optional(),
      ttlMs: z.number().optional(),
      label: z.string().optional()
    }
  }, handleSessionTool);

  server.registerTool('browser_dom', {
    title: 'Browser DOM',
    description: 'Query, describe, read, wait for, or search DOM elements in the approved live tab.',
    inputSchema: {
      action: z.enum(['query', 'describe', 'text', 'attributes', 'wait', 'find_text', 'find_role', 'html', 'accessibility_tree']),
      selector: z.string().optional(),
      elementRef: z.string().optional(),
      withinRef: z.string().optional(),
      maxNodes: z.number().optional(),
      maxDepth: z.number().optional(),
      textBudget: z.number().optional(),
      includeHtml: z.boolean().optional(),
      includeScreenshot: z.boolean().optional(),
      attributeAllowlist: z.array(z.string()).optional(),
      styleAllowlist: z.array(z.string()).optional(),
      includeRoles: z.boolean().optional(),
      attributes: z.array(z.string()).optional(),
      text: z.string().optional(),
      exact: z.boolean().optional(),
      maxResults: z.number().optional(),
      role: z.string().optional(),
      name: z.string().optional(),
      state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(),
      timeoutMs: z.number().optional(),
      outer: z.boolean().optional(),
      maxLength: z.number().optional()
    }
  }, handleDomTool);

  server.registerTool('browser_styles_layout', {
    title: 'Browser Styles And Layout',
    description: 'Read computed styles, matched rules, box models, and layout hit tests from the live tab.',
    inputSchema: {
      action: z.enum(['computed', 'matched_rules', 'box_model', 'hit_test']),
      elementRef: z.string().optional(),
      selector: z.string().optional(),
      properties: z.array(z.string()).optional(),
      x: z.number().optional(),
      y: z.number().optional()
    }
  }, handleStylesLayoutTool);

  server.registerTool('browser_page', {
    title: 'Browser Page State',
    description: 'Read page state, evaluate JavaScript, inspect console and network activity, and fetch storage or performance data.',
    inputSchema: {
      action: z.enum(['state', 'evaluate', 'console', 'wait_for_load', 'storage', 'text', 'network', 'performance']),
      expression: z.string().optional(),
      awaitPromise: z.boolean().optional(),
      timeoutMs: z.number().optional(),
      returnByValue: z.boolean().optional(),
      level: z.string().optional(),
      clear: z.boolean().optional(),
      limit: z.number().optional(),
      type: z.enum(['local', 'session']).optional(),
      keys: z.array(z.string()).optional(),
      textBudget: z.number().optional(),
      urlPattern: z.string().optional()
    }
  }, handlePageTool);

  server.registerTool('browser_navigation', {
    title: 'Browser Navigation',
    description: 'Navigate, reload, move through history, scroll, or resize the approved live tab.',
    inputSchema: {
      action: z.enum(['navigate', 'reload', 'go_back', 'go_forward', 'scroll', 'resize']),
      url: z.string().optional(),
      waitForLoad: z.boolean().optional(),
      timeoutMs: z.number().optional(),
      top: z.number().optional(),
      left: z.number().optional(),
      behavior: z.enum(['auto', 'smooth']).optional(),
      relative: z.boolean().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      reset: z.boolean().optional()
    }
  }, handleNavigationTool);

  server.registerTool('browser_input', {
    title: 'Browser Input',
    description: 'Click, focus, type, press keys, set checked state, select options, hover, or drag in the live tab.',
    inputSchema: {
      action: z.enum(['click', 'focus', 'type', 'press_key', 'set_checked', 'select_option', 'hover', 'drag']),
      elementRef: z.string().optional(),
      selector: z.string().optional(),
      button: z.enum(['left', 'middle', 'right']).optional(),
      clickCount: z.number().optional(),
      text: z.string().optional(),
      clear: z.boolean().optional(),
      submit: z.boolean().optional(),
      key: z.string().optional(),
      modifiers: z.array(z.string()).optional(),
      checked: z.boolean().optional(),
      values: z.array(z.string()).optional(),
      labels: z.array(z.string()).optional(),
      indexes: z.array(z.number()).optional(),
      duration: z.number().optional(),
      sourceElementRef: z.string().optional(),
      sourceSelector: z.string().optional(),
      destinationElementRef: z.string().optional(),
      destinationSelector: z.string().optional(),
      offsetX: z.number().optional(),
      offsetY: z.number().optional()
    }
  }, handleInputTool);

  server.registerTool('browser_patch', {
    title: 'Browser Patch',
    description: 'Apply reversible style or DOM patches, inspect active patches, rollback a patch, or commit the session baseline.',
    inputSchema: {
      action: z.enum(['apply_styles', 'apply_dom', 'list', 'rollback', 'commit_baseline']),
      elementRef: z.string().optional(),
      selector: z.string().optional(),
      declarations: z.record(z.string(), z.string()).optional(),
      important: z.boolean().optional(),
      operation: z.string().optional(),
      value: z.unknown().optional(),
      name: z.string().optional(),
      patchId: z.string().optional()
    }
  }, handlePatchTool);

  server.registerTool('browser_capture', {
    title: 'Browser Capture',
    description: 'Capture screenshots or CDP snapshots when structured reads are not enough.',
    inputSchema: {
      action: z.enum(['element', 'region', 'cdp_document', 'cdp_dom_snapshot', 'cdp_box_model', 'cdp_computed_styles']),
      elementRef: z.string().optional(),
      selector: z.string().optional(),
      rect: z.record(z.string(), z.unknown()).optional()
    }
  }, handleCaptureTool);

  server.registerTool('browser_call', {
    title: 'Raw Browser Bridge Call',
    description: 'Call any Browser Bridge method directly when the grouped tools are not enough.',
    inputSchema: {
      method: z.string(),
      params: z.record(z.string(), z.unknown()).optional(),
      sessionId: z.string().optional()
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
