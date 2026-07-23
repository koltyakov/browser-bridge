// @ts-check

export const MCP_SERVER_INSTRUCTIONS = [
  "Browser Bridge MCP inspects and interacts with the user's real Chrome tab through typed MCP tools.",
  'In permission-ask hosts, use browser_call as the default Browser Bridge MCP tool so the user can approve one BBX tool instead of separate browser_status, browser_page, browser_dom, browser_input, and other tools.',
  'Prefer Browser Bridge MCP tools over shelling out to bbx. Use bbx only for explicit CLI setup, doctor, logs, or raw debugging requests.',
  'Start with browser_call method health.ping. If window access is disabled, call browser_call method access.request once, ask the user to click Enable in the Browser Bridge popup or side panel, then retry once.',
  'Use structured reads first through browser_call: page.get_state, dom.query, page.get_text, page.extract_content, styles.get_computed, or layout.get_box_model. Prefer semantic extraction for articles and documentation. Use browser_batch only for parallel reads; run mutations sequentially and keep limits tight before widening.',
  'Reuse elementRef values returned by DOM tools. Use attribute allowlists for focused DOM reads.',
  'Escalate to screenshot.capture_element, screenshot.capture_region, dom.get_accessibility_tree, page.evaluate, viewport.resize, or CDP only when structured reads cannot answer the question.',
  'Use patch.apply_styles or patch.apply_dom for temporary experiments, and rollback patches before finishing unless the user asks to keep them.',
  'Only use the specialized Browser Bridge MCP tools directly when the host has already allowed them or the user explicitly wants typed tool calls.',
  '',
  'Page investigation: read page state, scoped DOM, and relevant page text first, batching independent reads. Find targets by text or role when selectors are unknown. Add styles, console, or network reads only when they directly answer the objective, and use screenshots or evaluation only when structured evidence is insufficient.',
  'Layout debugging: locate the target, read only relevant computed properties and its box model, and inspect matched rules only when the cascade is unclear. Prototype the smallest fix with a reversible style patch, verify the result, check for new console errors, then rollback before editing source unless the user asks to keep the patch.',
  'Flow verification: read initial page state, locate controls semantically, reuse elementRef values, interact through input tools, and wait for navigation or UI state changes. Verify the final DOM or page text plus console and network state when relevant. Do not create a new tab unless requested or required by the flow.',
].join('\n');
