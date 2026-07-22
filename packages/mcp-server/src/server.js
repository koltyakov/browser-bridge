// @ts-check

import fs from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// zod is required at runtime by @modelcontextprotocol/sdk for tool parameter schema
// declarations (z.object, z.string, etc.). It is not used for request/response
// validation - that is handled by the protocol package.
import * as z from 'zod/v4';

import {
  handleAccessTool,
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
  handleTabsTool,
  handleInvestigateTool,
  MAX_BATCH_CALLS,
} from './handlers.js';
import {
  BUDGET_PRESETS,
  DEFAULT_CONSOLE_LIMIT,
  DEFAULT_EVAL_TIMEOUT_MS,
  DEFAULT_LOG_TAIL_LIMIT,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_HTML_LENGTH,
  DEFAULT_MAX_NODES,
  DEFAULT_PAGE_TEXT_BUDGET,
  DEFAULT_TEXT_BUDGET,
  DEFAULT_NAV_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  getMethodsByMaxComplexity,
} from '../../protocol/src/index.js';
import { applyWindowsTcpTransportDefaults } from '../../native-host/src/config.js';
import { MCP_SERVER_INSTRUCTIONS } from './guidance.js';

export const BUDGET_PRESET_DESCRIPTION = `Budget preset: "quick", "normal", or "deep" (defaults: query ${BUDGET_PRESETS.normal.maxNodes} nodes / depth ${BUDGET_PRESETS.normal.maxDepth} / text ${BUDGET_PRESETS.normal.textBudget}). Numeric fields override the preset when both are provided.`;
export const TAB_ID_DESCRIPTION =
  'Target a specific tab instead of the active tab in the enabled window.';
export const DESTINATION_ID_DESCRIPTION =
  'Optional Browser Bridge destination ID from browser_status/browser_tabs; omit for local.';

const MCP_SERVER_VERSION = loadPackageVersion();

/**
 * @returns {string}
 */
function loadPackageVersion() {
  try {
    const raw = fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** @type {readonly import('../../protocol/src/types.js').BridgeMethod[]} */
const INVESTIGATE_SUBAGENT_BRIDGE_METHODS = Object.freeze(
  getMethodsByMaxComplexity('low').filter(
    (method) =>
      method.startsWith('page.') ||
      method.startsWith('dom.') ||
      method.startsWith('styles.') ||
      method.startsWith('layout.')
  )
);

const INVESTIGATE_DELEGATION_HINT = Object.freeze({
  recommended: true,
  costTier: 'low',
  preferredAgentProfile: {
    modelClass: 'small',
    reasoningEffort: 'low',
  },
  preferredTools: ['browser_dom', 'browser_page', 'browser_styles_layout', 'browser_batch'],
  escalationTools: ['browser_capture'],
  preferredBridgeMethods: INVESTIGATE_SUBAGENT_BRIDGE_METHODS,
  escalationTriggers: [
    'Structured DOM or page reads are insufficient.',
    'Visual confirmation is required.',
    'Debugger-backed evidence is required.',
  ],
});

/**
 * @returns {McpServer}
 */
export function createBridgeMcpServer() {
  const server = new McpServer(
    {
      name: 'browser-bridge',
      version: MCP_SERVER_VERSION,
    },
    {
      instructions: MCP_SERVER_INSTRUCTIONS,
    }
  );

  server.registerTool(
    'browser_status',
    {
      title: 'Browser Bridge Status',
      description:
        'Check bridge readiness: daemon connectivity, extension state, and window access. Omit destinationId to inspect local and configured remote destinations. If access is not enabled, ask the user to click Enable in the extension popup or side panel, then retry.',
      inputSchema: {
        destinationId: z
          .string()
          .optional()
          .describe('Inspect one destination instead of aggregating all configured destinations.'),
      },
    },
    handleStatusTool
  );

  server.registerTool(
    'browser_setup',
    {
      title: 'Browser Bridge Setup Status',
      description: 'Check MCP and CLI skill installation status for agent integration.',
      inputSchema: {
        global: z
          .boolean()
          .optional()
          .describe('Check global (true) or local (false) config (default: true)'),
      },
    },
    handleSetupTool
  );

  server.registerTool(
    'browser_logs',
    {
      title: 'Browser Bridge Logs',
      description: 'Tail recent bridge request logs for debugging connection or routing issues.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Maximum log entries to return (default: ${DEFAULT_LOG_TAIL_LIMIT})`),
        budgetPreset: z
          .enum(['quick', 'normal', 'deep'])
          .optional()
          .describe(BUDGET_PRESET_DESCRIPTION),
        destinationId: z.string().optional().describe(DESTINATION_ID_DESCRIPTION),
      },
    },
    handleLogTool
  );

  server.registerTool(
    'browser_health',
    {
      title: 'Browser Bridge Health',
      description: 'Ping the bridge to verify daemon and extension connectivity.',
      inputSchema: {
        destinationId: z.string().optional().describe(DESTINATION_ID_DESCRIPTION),
      },
    },
    handleHealthTool
  );

  server.registerTool(
    'browser_tabs',
    {
      title: 'Browser Tabs',
      description:
        'List, create, close, or activate browser tabs. List without destinationId aggregates configured destinations; other actions default to local. Only create a page when the user explicitly requests it.',
      inputSchema: {
        action: z
          .enum(['list', 'create', 'close', 'activate'])
          .describe('"list" (preferred), "create" (only when needed), "close", or "activate"'),
        url: z.string().optional().describe('URL for create action'),
        active: z.boolean().optional().describe('Focus the new tab (default: true)'),
        tabId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Tab ID (required for close/activate)'),
        destinationId: z
          .string()
          .optional()
          .describe('Target one destination; list without it aggregates configured destinations.'),
      },
    },
    handleTabsTool
  );

  server.registerTool(
    'browser_dom',
    {
      title: 'Browser DOM',
      description:
        'Query, describe, read, search, or wait for DOM elements. Reuse elementRef from prior results. For full-page text, use browser_page action "text". accessibility_tree is debugger-backed - use query/find first.',
      inputSchema: {
        action: z
          .enum([
            'query',
            'describe',
            'text',
            'attributes',
            'wait',
            'find_text',
            'find_role',
            'html',
            'accessibility_tree',
          ])
          .describe('DOM operation to perform'),
        tabId: z.number().int().positive().optional().describe(TAB_ID_DESCRIPTION),
        destinationId: z.string().optional().describe(DESTINATION_ID_DESCRIPTION),
        budgetPreset: z
          .enum(['quick', 'normal', 'deep'])
          .optional()
          .describe(BUDGET_PRESET_DESCRIPTION),
        selector: z
          .string()
          .optional()
          .describe('CSS selector (used if no elementRef; resolves to first match)'),
        elementRef: z
          .string()
          .optional()
          .describe('Element reference from prior result (preferred over selector)'),
        withinRef: z.string().optional().describe('Scope query to this elementRef subtree'),
        maxNodes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Maximum nodes to return (default: ${DEFAULT_MAX_NODES})`),
        maxDepth: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Maximum tree depth (default: ${DEFAULT_MAX_DEPTH})`),
        compact: z
          .boolean()
          .optional()
          .describe('Remove ignored, empty, and decorative AX nodes while preserving descendants'),
        interactiveOnly: z
          .boolean()
          .optional()
          .describe(
            'Return semantically interactive AX nodes; actionable state is reported separately'
          ),
        textBudget: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Max chars of text content per node (default: ${DEFAULT_TEXT_BUDGET})`),
        includeBbox: z
          .boolean()
          .optional()
          .describe('Include bounding box (default: true, set false to save tokens)'),
        attributeAllowlist: z
          .array(z.string())
          .optional()
          .describe('Only include these attributes (reduces tokens)'),
        attributes: z
          .array(z.string())
          .optional()
          .describe('Attribute names to fetch (for attributes action)'),
        text: z.string().optional().describe('Text to search for (for find_text/wait actions)'),
        exact: z
          .boolean()
          .optional()
          .describe('Require exact text match (default: false, substring match)'),
        maxResults: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum search results (default: 10)'),
        role: z.string().optional().describe('ARIA role to search for (for find_role action)'),
        name: z.string().optional().describe('Accessible name to match with role'),
        state: z
          .enum(['attached', 'detached', 'visible', 'hidden'])
          .optional()
          .describe(
            'Expected element state (for wait action); hidden also matches complete absence'
          ),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Timeout for wait operations (default: ${DEFAULT_WAIT_TIMEOUT_MS})`),
        outer: z
          .boolean()
          .optional()
          .describe('Return outerHTML instead of innerHTML (default: false)'),
        maxLength: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Max HTML chars to return (default: ${DEFAULT_MAX_HTML_LENGTH})`),
      },
    },
    handleDomTool
  );

  server.registerTool(
    'browser_styles_layout',
    {
      title: 'Browser Styles And Layout',
      description:
        'Read computed styles, matched CSS rules, box model, or hit-test a viewport point. Reuse elementRef from prior queries. For DOM structure, use browser_dom.',
      inputSchema: {
        action: z
          .enum(['computed', 'matched_rules', 'box_model', 'hit_test'])
          .describe('Style/layout operation to perform'),
        tabId: z.number().int().positive().optional().describe(TAB_ID_DESCRIPTION),
        destinationId: z.string().optional().describe(DESTINATION_ID_DESCRIPTION),
        budgetPreset: z
          .enum(['quick', 'normal', 'deep'])
          .optional()
          .describe(BUDGET_PRESET_DESCRIPTION),
        elementRef: z.string().optional().describe('Element reference (preferred over selector)'),
        selector: z.string().optional().describe('CSS selector (used if no elementRef)'),
        properties: z
          .array(z.string())
          .optional()
          .describe('Style properties to fetch (omitting returns all - expensive)'),
        x: z
          .number()
          .nonnegative()
          .optional()
          .describe('X coordinate for hit_test (viewport relative)'),
        y: z
          .number()
          .nonnegative()
          .optional()
          .describe('Y coordinate for hit_test (viewport relative)'),
      },
    },
    handleStylesLayoutTool
  );

  server.registerTool(
    'browser_page',
    {
      title: 'Browser Page State',
      description:
        'Read page-level data, wait for load/URL conditions, or explicitly inspect/handle JavaScript dialogs. For element-level reads, use browser_dom. evaluate, performance, handle_dialog, and source=cdp network capture are debugger-backed.',
      inputSchema: {
        action: z
          .enum([
            'state',
            'evaluate',
            'console',
            'handle_dialog',
            'wait_for_load',
            'storage',
            'text',
            'network',
            'performance',
          ])
          .describe('Page operation to perform'),
        tabId: z.number().int().positive().optional().describe(TAB_ID_DESCRIPTION),
        destinationId: z.string().optional().describe(DESTINATION_ID_DESCRIPTION),
        budgetPreset: z
          .enum(['quick', 'normal', 'deep'])
          .optional()
          .describe(BUDGET_PRESET_DESCRIPTION),
        expression: z
          .string()
          .optional()
          .describe('JavaScript expression to evaluate (for evaluate action)'),
        awaitPromise: z.boolean().optional().describe('Await returned promises (default: false)'),
        dialogAction: z
          .enum(['inspect', 'accept', 'dismiss'])
          .optional()
          .describe('Dialog operation on the current dialog (default: inspect)'),
        promptText: z
          .string()
          .max(10_000)
          .optional()
          .describe('Prompt response text; only valid when dialogAction is accept'),
        expectedDialogId: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe(
            'Optional stale-decision check immediately before CDP dispatch; Chrome cannot atomically bind the action to this identifier'
          ),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Timeout (default: ${DEFAULT_EVAL_TIMEOUT_MS} for evaluate, ${DEFAULT_NAV_TIMEOUT_MS} for wait_for_load)`
          ),
        returnByValue: z
          .literal(true)
          .optional()
          .describe('Return serializable values (only true is supported; default: true)'),
        level: z
          .enum(['all', 'debug', 'log', 'info', 'warn', 'error', 'exception', 'rejection'])
          .optional()
          .describe(
            'Minimum console severity (default: all); exception/rejection select that exact stream'
          ),
        clear: z.boolean().optional().describe('Clear buffer after reading (default: false)'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Maximum entries to return (default: ${DEFAULT_CONSOLE_LIMIT})`),
        type: z
          .enum(['local', 'session'])
          .optional()
          .describe('Storage type to read (default: local)'),
        keys: z
          .array(z.string())
          .optional()
          .describe('Specific storage keys to fetch (omitting returns all)'),
        textBudget: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Max chars for page text (default: ${DEFAULT_PAGE_TEXT_BUDGET})`),
        urlPattern: z.string().optional().describe('Filter network entries by URL pattern'),
        source: z
          .enum(['fetch-xhr', 'cdp'])
          .optional()
          .describe('Network source (default: fetch-xhr; cdp captures all resource types)'),
        capture: z
          .enum(['read', 'start', 'clear', 'stop'])
          .optional()
          .describe('Explicit CDP capture lifecycle action (default: read)'),
        waitForLoad: z
          .boolean()
          .optional()
          .describe('For wait_for_load, also require tab status complete (default: true)'),
        url: z.string().optional().describe('URL condition for wait_for_load'),
        urlMatch: z
          .enum(['exact', 'contains', 'regex'])
          .optional()
          .describe('URL match mode for wait_for_load (default: exact)'),
      },
    },
    handlePageTool
  );

  server.registerTool(
    'browser_navigation',
    {
      title: 'Browser Navigation',
      description:
        'Navigate to a URL, reload, go back/forward, scroll, or resize the viewport. resize is debugger-backed - use only for exact viewport overrides.',
      inputSchema: {
        action: z
          .enum(['navigate', 'reload', 'go_back', 'go_forward', 'scroll', 'resize'])
          .describe('Navigation operation to perform'),
        tabId: z.number().int().positive().optional().describe(TAB_ID_DESCRIPTION),
        destinationId: z.string().optional().describe(DESTINATION_ID_DESCRIPTION),
        budgetPreset: z
          .enum(['quick', 'normal', 'deep'])
          .optional()
          .describe(BUDGET_PRESET_DESCRIPTION),
        url: z.string().optional().describe('URL to navigate to (for navigate action)'),
        waitForLoad: z.boolean().optional().describe('Wait for load event (default: true)'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Timeout for navigation (default: ${DEFAULT_NAV_TIMEOUT_MS})`),
        top: z.number().optional().describe('Scroll target Y position (pixels)'),
        left: z.number().optional().describe('Scroll target X position (pixels)'),
        behavior: z.enum(['auto', 'smooth']).optional().describe('Scroll behavior (default: auto)'),
        relative: z
          .boolean()
          .optional()
          .describe('Scroll relative to current position (default: false)'),
        width: z.number().int().positive().optional().describe('Viewport width in pixels'),
        height: z.number().int().positive().optional().describe('Viewport height in pixels'),
        deviceScaleFactor: z
          .number()
          .nonnegative()
          .optional()
          .describe('Viewport device scale factor (for resize)'),
        reset: z.boolean().optional().describe('Reset viewport to original size (for resize)'),
      },
    },
    handleNavigationTool
  );

  server.registerTool(
    'browser_input',
    {
      title: 'Browser Input',
      description:
        'Simulate user input: click, focus, type, press keys, CDP key events, set checked, select options, hover, drag, or scroll into view. Reuse elementRef from prior queries.',
      inputSchema: {
        action: z
          .enum([
            'click',
            'focus',
            'type',
            'fill',
            'press_key',
            'cdp_press_key',
            'set_checked',
            'select_option',
            'hover',
            'drag',
            'scroll_into_view',
          ])
          .describe('Input operation to perform'),
        tabId: z.number().int().positive().optional().describe(TAB_ID_DESCRIPTION),
        destinationId: z.string().optional().describe(DESTINATION_ID_DESCRIPTION),
        budgetPreset: z
          .enum(['quick', 'normal', 'deep'])
          .optional()
          .describe(BUDGET_PRESET_DESCRIPTION),
        elementRef: z
          .string()
          .optional()
          .describe('Target element reference (preferred over selector)'),
        selector: z.string().optional().describe('CSS selector (used if no elementRef)'),
        button: z
          .enum(['left', 'middle', 'right'])
          .optional()
          .describe('Mouse button for click (default: left)'),
        clickCount: z
          .number()
          .int()
          .min(1)
          .max(2)
          .optional()
          .describe('Click count (1=single, 2=double)'),
        text: z.string().max(100000).optional().describe('Text to type (for type action)'),
        value: z.string().max(100000).optional().describe('Value to set (for fill action)'),
        mode: z
          .enum(['auto', 'setter', 'keystrokes'])
          .optional()
          .describe('Fill strategy (default: auto)'),
        executionMode: z
          .enum(['dom', 'cdp'])
          .optional()
          .describe(
            'Input execution path (default: dom; CDP supports click, hover, drag, type, fill)'
          ),
        recoverStale: z
          .boolean()
          .optional()
          .describe('Strict same-document stale elementRef recovery (default: false)'),
        clear: z.boolean().optional().describe('Clear field before typing (default: false)'),
        submit: z.boolean().optional().describe('Press Enter after typing (default: false)'),
        key: z
          .string()
          .optional()
          .describe('Key to press (e.g., "Escape", "Enter", "Tab", "ArrowDown")'),
        code: z
          .string()
          .optional()
          .describe('Optional physical key code for cdp_press_key (e.g., "Escape", "KeyA")'),
        modifiers: z
          .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
          .optional()
          .describe('Modifier keys'),
        checked: z.boolean().optional().describe('Checked state (for set_checked action)'),
        values: z.array(z.string()).optional().describe('Option values to select'),
        labels: z
          .array(z.string())
          .optional()
          .describe('Option labels to select (alternative to values)'),
        indexes: z
          .array(z.number().int().nonnegative())
          .optional()
          .describe('Option indexes to select (alternative to values/labels)'),
        duration: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Hover duration in ms (default: 0)'),
        sourceElementRef: z.string().optional().describe('Drag source element (for drag action)'),
        sourceSelector: z
          .string()
          .optional()
          .describe('Drag source selector (alternative to sourceElementRef)'),
        destinationElementRef: z
          .string()
          .optional()
          .describe('Drag destination element (for drag action)'),
        destinationSelector: z
          .string()
          .optional()
          .describe('Drag destination selector (alternative to destinationElementRef)'),
        offsetX: z.number().optional().describe('Drag drop offset X (default: 0)'),
        offsetY: z.number().optional().describe('Drag drop offset Y (default: 0)'),
      },
    },
    handleInputTool
  );

  server.registerTool(
    'browser_patch',
    {
      title: 'Browser Patch',
      description:
        'Apply or rollback reversible style and DOM patches for live prototyping before editing source. Set verify=true to get computed results inline without a follow-up query.',
      inputSchema: {
        action: z
          .enum(['apply_styles', 'apply_dom', 'list', 'rollback', 'commit_baseline'])
          .describe('Patch operation to perform'),
        tabId: z.number().int().positive().optional().describe(TAB_ID_DESCRIPTION),
        destinationId: z.string().optional().describe(DESTINATION_ID_DESCRIPTION),
        budgetPreset: z
          .enum(['quick', 'normal', 'deep'])
          .optional()
          .describe(BUDGET_PRESET_DESCRIPTION),
        elementRef: z
          .string()
          .optional()
          .describe('Target element reference (preferred over selector)'),
        selector: z.string().optional().describe('CSS selector (used if no elementRef)'),
        declarations: z
          .record(z.string(), z.string())
          .optional()
          .describe('CSS property: value pairs (for apply_styles)'),
        important: z.boolean().optional().describe('Add !important flag (default: false)'),
        operation: z
          .enum(['setAttribute', 'removeAttribute', 'addClass', 'removeClass', 'setTextContent'])
          .optional()
          .describe('DOM mutation type'),
        value: z.unknown().optional().describe('Value for the DOM operation'),
        name: z.string().optional().describe('Attribute/class/property name (for apply_dom)'),
        patchId: z.string().optional().describe('Patch ID (required for rollback)'),
        verify: z
          .boolean()
          .optional()
          .describe(
            'Return computed result inline after applying, eliminating a verification round-trip'
          ),
      },
    },
    handlePatchTool
  );

  server.registerTool(
    'browser_capture',
    {
      title: 'Browser Capture',
      description:
        'Capture screenshots or CDP snapshots. Debugger-backed and token-expensive - use only when structured reads (browser_dom, browser_styles_layout) are insufficient. Prefer element, then tight region; full_page only for document-level context.',
      inputSchema: {
        action: z
          .enum([
            'element',
            'region',
            'full_page',
            'cdp_document',
            'cdp_dom_snapshot',
            'cdp_box_model',
            'cdp_computed_styles',
          ])
          .describe(
            'element (preferred), region (tight crop), full_page (document-level only), or cdp_* for low-level data'
          ),
        tabId: z.number().int().positive().optional().describe(TAB_ID_DESCRIPTION),
        destinationId: z.string().optional().describe(DESTINATION_ID_DESCRIPTION),
        budgetPreset: z
          .enum(['quick', 'normal', 'deep'])
          .optional()
          .describe(BUDGET_PRESET_DESCRIPTION),
        elementRef: z
          .string()
          .optional()
          .describe('Element reference (for element action, preferred)'),
        selector: z.string().optional().describe('CSS selector (used if no elementRef)'),
        nodeId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('CDP node id for cdp_box_model/cdp_computed_styles'),
        rect: z
          .object({
            x: z.number().nonnegative().describe('Region left edge (viewport pixels)'),
            y: z.number().nonnegative().describe('Region top edge (viewport pixels)'),
            width: z.number().positive().describe('Region width (pixels)'),
            height: z.number().positive().describe('Region height (pixels)'),
          })
          .optional()
          .describe('Viewport region for region action (keep crop tight)'),
      },
    },
    handleCaptureTool
  );

  server.registerTool(
    'browser_batch',
    {
      title: 'Browser Bridge Batch',
      description:
        'Execute independent read-only bridge calls in parallel to reduce round-trips. Mutations and destructive reads are rejected; run them sequentially with specialized tools or browser_call. Preserves call order in the response.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        calls: z
          .array(
            z.object({
              method: z.string().describe('Bridge method name (e.g. "dom.query", "page.get_text")'),
              params: z
                .record(z.string(), z.unknown())
                .optional()
                .describe('Method params for this call'),
              tabId: z.number().int().positive().optional().describe(TAB_ID_DESCRIPTION),
              destinationId: z.string().optional().describe(DESTINATION_ID_DESCRIPTION),
              budgetPreset: z
                .enum(['quick', 'normal', 'deep'])
                .optional()
                .describe(BUDGET_PRESET_DESCRIPTION),
            })
          )
          .min(1)
          .max(MAX_BATCH_CALLS)
          .describe('Calls to execute in parallel'),
      },
    },
    handleBatchTool
  );

  server.registerTool(
    'browser_call',
    {
      title: 'Raw Browser Bridge Call',
      description:
        'Primary Browser Bridge tool for permission-ask hosts: call any bridge method directly by name so the user can approve one BBX MCP tool instead of each specialized tool separately.',
      inputSchema: {
        method: z.string().describe('Bridge method name (e.g., "dom.query", "input.click")'),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Method parameters as object'),
        tabId: z.number().int().positive().optional().describe(TAB_ID_DESCRIPTION),
        destinationId: z.string().optional().describe(DESTINATION_ID_DESCRIPTION),
        budgetPreset: z
          .enum(['quick', 'normal', 'deep'])
          .optional()
          .describe(BUDGET_PRESET_DESCRIPTION),
      },
    },
    handleRawCallTool
  );

  server.registerTool(
    'browser_skill',
    {
      title: 'Browser Bridge Runtime Context',
      description:
        'Return runtime context: budget presets, method groups, and active limits. Call to discover defaults before inspecting a page.',
      inputSchema: {
        destinationId: z.string().optional().describe(DESTINATION_ID_DESCRIPTION),
      },
    },
    handleSkillTool
  );

  server.registerTool(
    'browser_access',
    {
      title: 'Request Browser Bridge Access',
      description:
        'Request window access for Browser Bridge. Surfaces an Enable prompt in the extension popup or side panel. Use once per window; if access is already pending, ask the user to enable that window instead of requesting again.',
      inputSchema: {
        destinationId: z.string().optional().describe(DESTINATION_ID_DESCRIPTION),
      },
    },
    handleAccessTool
  );

  server.registerTool(
    'browser_investigate',
    {
      title: 'Browser Investigate',
      description:
        'Investigate a page to answer a question or verify a condition. ' +
        'Pass a natural-language objective and an optional scope (quick/normal/deep). ' +
        'DELEGATION HINT: Prefer delegating this to a smaller, low-cost subagent ' +
        'that starts with structured reads via browser_dom, browser_page, ' +
        'browser_styles_layout, and browser_batch. Escalate to browser_capture only ' +
        'when structured reads are insufficient. ' +
        'If subagent delegation is not available, a deterministic heuristic fallback ' +
        'runs a scripted inspection sequence and returns a best-effort summary.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: {
        delegationHint: INVESTIGATE_DELEGATION_HINT,
      },
      inputSchema: {
        objective: z
          .string()
          .describe('What to find, verify, or extract from the current page (natural language).'),
        scope: z
          .enum(['quick', 'normal', 'deep'])
          .optional()
          .describe(
            'Investigation depth: "quick" (page state + one DOM query), ' +
              '"normal" (state + DOM + text, default), ' +
              '"deep" (state + DOM + text + console + network).'
          ),
        tabId: z.number().int().positive().optional().describe(TAB_ID_DESCRIPTION),
        destinationId: z.string().optional().describe(DESTINATION_ID_DESCRIPTION),
        selector: z
          .string()
          .optional()
          .describe('Optional CSS selector to scope the investigation to a subtree.'),
      },
    },
    handleInvestigateTool
  );

  return server;
}

/**
 * @returns {Promise<void>}
 */
export async function startBridgeMcpServer() {
  applyWindowsTcpTransportDefaults();
  const server = createBridgeMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
