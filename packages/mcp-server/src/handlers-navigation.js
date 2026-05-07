// @ts-check

import { callBridgeTool, getToolTokenBudget, summarizeToolError } from './handlers-utils.js';

/** @typedef {import('../../protocol/src/types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('./handlers-utils.js').ToolResult} ToolResult */

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
      active: args.active,
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

/** @type {Record<string, { method: BridgeMethod, params: (a: Record<string, unknown>) => Record<string, unknown> }>} */
export const NAVIGATION_ACTIONS = {
  navigate: {
    method: 'navigation.navigate',
    params: (a) => ({
      url: a.url,
      waitForLoad: a.waitForLoad,
      timeoutMs: a.timeoutMs,
    }),
  },
  reload: {
    method: 'navigation.reload',
    params: (a) => ({ waitForLoad: a.waitForLoad, timeoutMs: a.timeoutMs }),
  },
  go_back: {
    method: 'navigation.go_back',
    params: (a) => ({ waitForLoad: a.waitForLoad, timeoutMs: a.timeoutMs }),
  },
  go_forward: {
    method: 'navigation.go_forward',
    params: (a) => ({ waitForLoad: a.waitForLoad, timeoutMs: a.timeoutMs }),
  },
  scroll: {
    method: 'viewport.scroll',
    params: (a) => ({
      top: a.top,
      left: a.left,
      behavior: a.behavior,
      relative: a.relative,
    }),
  },
  resize: {
    method: 'viewport.resize',
    params: (a) => ({ width: a.width, height: a.height, reset: a.reset }),
  },
};

/**
 * @param {{ action: string, url?: string, waitForLoad?: boolean, timeoutMs?: number, top?: number, left?: number, behavior?: string, relative?: boolean, width?: number, height?: number, reset?: boolean, tabId?: number, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleNavigationTool(args) {
  const entry = NAVIGATION_ACTIONS[args.action];
  if (!entry) return summarizeToolError(`Unsupported navigation action "${args.action}".`);
  return callBridgeTool(entry.method, entry.params(args), {
    tabId: typeof args.tabId === 'number' ? args.tabId : null,
    tokenBudget: getToolTokenBudget(args),
  });
}
