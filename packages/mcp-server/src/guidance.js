// @ts-check

/**
 * Guidance lines shared by the progressive tool surface.
 *
 * @type {readonly string[]}
 */
const SHARED_INSTRUCTIONS = Object.freeze([
  'Prefer Browser Bridge MCP tools over shelling out to bbx. Use bbx only for explicit CLI setup, doctor, logs, or raw debugging requests.',
  'Start with browser_call method health.ping. If window access is disabled, call browser_call method access.request once, ask the user to click Enable in the Browser Bridge popup or side panel, then retry once.',
  'Use structured reads first through browser_call: page.get_state, dom.query, page.get_text, page.extract_content, styles.get_computed, or layout.get_box_model. Prefer semantic extraction for articles and documentation. Use browser_batch only for parallel reads; run mutations sequentially and keep limits tight before widening.',
  'Reuse elementRef values returned by DOM reads. Use attribute allowlists for focused DOM reads.',
  'Escalate to screenshot.capture_element, screenshot.capture_region, dom.get_accessibility_tree, page.evaluate, viewport.resize, or CDP only when structured reads cannot answer the question.',
  'Use patch.apply_styles or patch.apply_dom for temporary experiments, and rollback patches before finishing unless the user asks to keep them.',
]);

/**
 * Workflow guidance appended after the tool-selection rules.
 *
 * @type {readonly string[]}
 */
const WORKFLOW_INSTRUCTIONS = Object.freeze([
  '',
  'Page investigation: read page state, scoped DOM, and relevant page text first, batching independent reads. Find targets by text or role when selectors are unknown. Add styles, console, or network reads only when they directly answer the objective, and use screenshots or evaluation only when structured evidence is insufficient.',
  'Layout debugging: locate the target, read only relevant computed properties and its box model, and inspect matched rules only when the cascade is unclear. Prototype the smallest fix with a reversible style patch, verify the result, check for new console errors, then rollback before editing source unless the user asks to keep the patch.',
  'Flow verification: read initial page state, locate controls semantically, reuse elementRef values, interact through input tools, and wait for navigation or UI state changes. Verify the final DOM or page text plus console and network state when relevant. Do not create a new tab unless requested or required by the flow.',
]);

const SERVER_HEADER =
  "Browser Bridge MCP inspects and interacts with the user's real Chrome tab through a compact tool set.";

const LEGACY_TOOL_RULES = Object.freeze([
  'The common tools are available immediately. When a specialized typed tool is useful, call browser_toolset with its exact tool name; browser_call always reaches every bridge method without loading another tool.',
  'Use browser_call method protocol.describe with method or group params to load unfamiliar signatures cheaply.',
]);

const MODERN_TOOL_RULES = Object.freeze([
  'The compact tool list is static for stateless MCP. browser_call reaches every bridge method, and browser_skill returns runtime groups and limits.',
  'Use browser_call method protocol.describe with method or group params to load unfamiliar signatures cheaply.',
]);

/**
 * Build instructions for the negotiated MCP era.
 *
 * @param {'legacy' | 'modern'} [era='legacy']
 * @returns {string}
 */
export function getMcpServerInstructions(era = 'legacy') {
  const toolRules = era === 'modern' ? MODERN_TOOL_RULES : LEGACY_TOOL_RULES;
  return [SERVER_HEADER, ...toolRules, ...SHARED_INSTRUCTIONS, ...WORKFLOW_INSTRUCTIONS].join('\n');
}

export const MCP_SERVER_INSTRUCTIONS = getMcpServerInstructions();
export const MODERN_MCP_SERVER_INSTRUCTIONS = getMcpServerInstructions('modern');
