// @ts-check

import * as z from 'zod/v4';

/** @typedef {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} McpServer */
/** @typedef {import('@modelcontextprotocol/sdk/types.js').GetPromptResult} GetPromptResult */

export const MCP_SERVER_INSTRUCTIONS = [
  "Browser Bridge MCP inspects and interacts with the user's real Chrome tab through typed MCP tools.",
  'In permission-ask hosts, use browser_call as the default Browser Bridge MCP tool so the user can approve one BBX tool instead of separate browser_status, browser_page, browser_dom, browser_input, and other tools.',
  'Prefer Browser Bridge MCP tools over shelling out to bbx. Use bbx only for explicit CLI setup, doctor, logs, or raw debugging requests.',
  'Start with browser_call method health.ping. If window access is disabled, call browser_call method access.request once, ask the user to click Enable in the Browser Bridge popup or side panel, then retry once.',
  'Use structured reads first through browser_call: page.get_state, dom.query, page.get_text, styles.get_computed, or layout.get_box_model. Use browser_batch only for parallel reads; run mutations sequentially and keep limits tight before widening.',
  'Reuse elementRef values returned by DOM tools. Use attribute allowlists for focused DOM reads.',
  'Escalate to screenshot.capture_element, screenshot.capture_region, dom.get_accessibility_tree, page.evaluate, viewport.resize, or CDP only when structured reads cannot answer the question.',
  'Use patch.apply_styles or patch.apply_dom for temporary experiments, and rollback patches before finishing unless the user asks to keep them.',
  'Only use the specialized Browser Bridge MCP tools directly when the host has already allowed them or the user explicitly wants typed tool calls.',
].join('\n');

export const MCP_GUIDANCE_PROMPT_NAMES = Object.freeze([
  'browser_bridge_guide',
  'browser_bridge_investigate',
  'browser_bridge_debug_layout',
  'browser_bridge_verify_flow',
]);

/**
 * Register Browser Bridge MCP prompt templates. These are the MCP-mode equivalent
 * of a lightweight skill: discoverable by clients without requiring filesystem
 * skill installation or shell access.
 *
 * @param {McpServer} server
 * @returns {void}
 */
export function registerBridgeMcpGuidance(server) {
  server.registerPrompt(
    'browser_bridge_guide',
    {
      title: 'Use Browser Bridge MCP',
      description:
        'General Browser Bridge MCP workflow guidance. Prefer this over CLI skill setup.',
    },
    createGuidePrompt
  );

  server.registerPrompt(
    'browser_bridge_investigate',
    {
      title: 'Investigate Current Page',
      description:
        'Inspect the current page with structured reads before screenshots or evaluation.',
      argsSchema: {
        objective: z.string().optional().describe('What to find, verify, or explain'),
        selector: z
          .string()
          .optional()
          .describe('Optional CSS selector to scope the first DOM read'),
        scope: z.enum(['quick', 'normal', 'deep']).optional().describe('Investigation depth'),
      },
    },
    createInvestigatePrompt
  );

  server.registerPrompt(
    'browser_bridge_debug_layout',
    {
      title: 'Debug Layout Or Styling',
      description: 'Diagnose a visual, spacing, sizing, visibility, or CSS issue in the live tab.',
      argsSchema: {
        target: z.string().optional().describe('Element, component, text, or selector to inspect'),
        symptom: z.string().optional().describe('Observed layout or styling problem'),
      },
    },
    createDebugLayoutPrompt
  );

  server.registerPrompt(
    'browser_bridge_verify_flow',
    {
      title: 'Verify User Flow',
      description:
        'Drive a user flow through MCP input tools and verify page, console, and network state.',
      argsSchema: {
        flow: z.string().optional().describe('User flow to exercise'),
        successCriteria: z.string().optional().describe('Expected successful outcome'),
      },
    },
    createVerifyFlowPrompt
  );
}

/**
 * @returns {GetPromptResult}
 */
function createGuidePrompt() {
  return createUserPrompt(
    'Browser Bridge MCP workflow guide.',
    [
      'Use Browser Bridge MCP for this browser task.',
      '',
      'Rules:',
      '1. Prefer MCP over `bbx`; do not shell out unless setup, doctor, logs, or raw CLI debugging is explicitly needed.',
      '2. In permission-ask hosts, use `browser_call` as the default tool so the user can approve one BBX MCP tool instead of separate tools for status, page, DOM, input, and patches.',
      '3. Start with `browser_call` method `health.ping`. If access is disabled, call `browser_call` method `access.request` once, ask the user to click Enable, then retry once.',
      '4. Start with structured reads via `browser_call`: `page.get_state`, `dom.query`, `dom.find_by_text`, `dom.find_by_role`, and `styles.get_computed`. Use `browser_batch` for parallel reads.',
      '5. `browser_call` accepts explicit method limits, not `budgetPreset`; keep limits tight and widen only when results are truncated.',
      '6. Reuse `elementRef` values returned by DOM tools instead of rescanning.',
      '7. Escalate to screenshots, accessibility tree, `page.evaluate`, viewport resize, or CDP only when structured reads cannot answer.',
      '8. Use `patch.apply_styles` or `patch.apply_dom` for temporary experiments and rollback before finishing unless the user asks to keep patches.',
      '9. Only use specialized Browser Bridge MCP tools directly when the host has already allowed them or the user explicitly wants typed tool calls.',
      '',
      'Return concise findings with evidence. Edit source code only after the live page behavior is understood.',
    ].join('\n')
  );
}

/**
 * @param {{ objective?: string, selector?: string, scope?: 'quick' | 'normal' | 'deep' }} args
 * @returns {GetPromptResult}
 */
function createInvestigatePrompt(args) {
  const objective = normalizeTextArg(
    args.objective,
    'inspect the current page and report findings'
  );
  const selector = normalizeTextArg(
    args.selector,
    'none; start with main, body, or semantic search'
  );
  const scope = normalizeTextArg(args.scope, 'normal');

  return createUserPrompt(
    'Browser Bridge MCP page investigation workflow.',
    [
      'Investigate the current page with Browser Bridge MCP.',
      '',
      `Objective: ${objective}`,
      `Scope: ${scope}`,
      `Initial selector: ${selector}`,
      '',
      'Workflow:',
      '1. Call `browser_status` to confirm daemon, extension, and access readiness.',
      '2. If access is disabled, call `browser_access` once, ask the user to click Enable, then retry once.',
      '3. Use `browser_batch` for independent structured reads, usually `page.get_state`, a scoped `dom.query`, and `page.get_text` when page copy matters.',
      '4. Use `browser_dom` `find_text` or `find_role` when the target is known by label but not selector.',
      '5. Add `browser_styles_layout`, `browser_page` console, or `browser_page` network only when they directly answer the objective.',
      '6. Escalate to screenshots, accessibility tree, or evaluate only when structured reads are insufficient.',
      '',
      'Return concise findings, relevant evidence, and the next source-code action if a fix is needed.',
    ].join('\n')
  );
}

/**
 * @param {{ target?: string, symptom?: string }} args
 * @returns {GetPromptResult}
 */
function createDebugLayoutPrompt(args) {
  const target = normalizeTextArg(args.target, 'the affected element or component');
  const symptom = normalizeTextArg(args.symptom, 'the observed layout or styling problem');

  return createUserPrompt(
    'Browser Bridge MCP layout debugging workflow.',
    [
      'Debug a layout or styling issue in the live tab with Browser Bridge MCP.',
      '',
      `Target: ${target}`,
      `Symptom: ${symptom}`,
      '',
      'Workflow:',
      '1. Call `browser_status` first and resolve access if needed.',
      '2. Locate the target with `browser_dom` `query`, `find_text`, or `find_role` using a quick budget.',
      '3. Read only relevant computed styles with `browser_styles_layout` action `computed` and specific `properties`.',
      '4. Read dimensions with `browser_styles_layout` action `box_model`; use matched rules only when the cascade is unclear.',
      '5. Prototype the smallest visual fix with `browser_patch` action `apply_styles` and `verify: true` when useful.',
      '6. Check `browser_page` console for new errors after interaction or patching.',
      '7. Roll back temporary patches unless the user explicitly wants them kept, then edit source with the confirmed fix.',
      '',
      'Avoid screenshots until DOM, computed styles, and box model evidence are insufficient.',
    ].join('\n')
  );
}

/**
 * @param {{ flow?: string, successCriteria?: string }} args
 * @returns {GetPromptResult}
 */
function createVerifyFlowPrompt(args) {
  const flow = normalizeTextArg(args.flow, 'the requested user flow');
  const successCriteria = normalizeTextArg(
    args.successCriteria,
    'visible success state, no console errors, and expected network behavior'
  );

  return createUserPrompt(
    'Browser Bridge MCP user-flow verification workflow.',
    [
      'Verify a user flow in the current real browser tab with Browser Bridge MCP.',
      '',
      `Flow: ${flow}`,
      `Success criteria: ${successCriteria}`,
      '',
      'Workflow:',
      '1. Call `browser_status` and resolve access if needed.',
      '2. Read `browser_page` state so you know the current URL and title before interacting.',
      '3. Locate controls semantically with `browser_dom` `find_role` or `find_text`; reuse returned `elementRef` values.',
      '4. Interact with `browser_input` actions such as `click`, `type`, `set_checked`, `select_option`, and `press_key`.',
      '5. After navigation or UI changes, wait with `browser_dom` action `wait` or `browser_page` action `wait_for_load`.',
      '6. Verify final page text/DOM plus `browser_page` console and network if the flow depends on API calls.',
      '7. Do not create new tabs unless the user requested a fresh page or the flow requires one.',
      '',
      'Report the verified result, evidence, and any blocking failures.',
    ].join('\n')
  );
}

/**
 * @param {string} description
 * @param {string} text
 * @returns {GetPromptResult}
 */
function createUserPrompt(description, text) {
  return {
    description,
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text,
        },
      },
    ],
  };
}

/**
 * @param {string | undefined} value
 * @param {string} fallback
 * @returns {string}
 */
function normalizeTextArg(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}
