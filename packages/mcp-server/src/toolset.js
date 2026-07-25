// @ts-check

/**
 * Browser Bridge starts with a compact fixed tool surface. Specialized typed
 * tools remain registered but disabled until browser_toolset enables one by
 * exact name. browser_call always keeps the full bridge protocol reachable.
 */

/** @type {readonly string[]} */
export const INITIAL_TOOLSET_TOOLS = Object.freeze([
  'browser_access',
  'browser_batch',
  'browser_call',
  'browser_health',
  'browser_status',
  'browser_toolset',
]);

/** @typedef {'browser_dom' | 'browser_styles_layout' | 'browser_page' | 'browser_logs' | 'browser_input' | 'browser_navigation' | 'browser_tabs' | 'browser_capture' | 'browser_artifact' | 'browser_patch' | 'browser_intercept' | 'browser_investigate' | 'browser_sensitive_read' | 'browser_setup' | 'browser_skill'} LoadableToolName */

/** @type {readonly LoadableToolName[]} */
export const LOADABLE_TOOLSET_TOOLS = Object.freeze([
  'browser_dom',
  'browser_styles_layout',
  'browser_page',
  'browser_logs',
  'browser_input',
  'browser_navigation',
  'browser_tabs',
  'browser_capture',
  'browser_artifact',
  'browser_patch',
  'browser_intercept',
  'browser_investigate',
  'browser_sensitive_read',
  'browser_setup',
  'browser_skill',
]);

const INITIAL_TOOLSET = new Set(INITIAL_TOOLSET_TOOLS);

/**
 * @param {string} toolName
 * @returns {boolean}
 */
export function isInitiallyEnabledTool(toolName) {
  return INITIAL_TOOLSET.has(toolName);
}
