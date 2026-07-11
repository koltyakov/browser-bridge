// @ts-check

import { createBridgeClientForDestination } from '../../agent-client/src/remotes.js';
import {
  callBridgeTool,
  createToolResult,
  getBridgeDestinations,
  getToolTokenBudget,
  summarizeToolError,
} from './handlers-utils.js';

/** @typedef {import('../../protocol/src/types.js').BridgeMethod} BridgeMethod */
/** @typedef {import('./handlers-utils.js').ToolResult} ToolResult */

/**
 * @param {{ action: string, url?: string, active?: boolean, tabId?: number, destinationId?: string }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleTabsTool(args) {
  if (args.action === 'list') {
    if (typeof args.destinationId === 'string') {
      return callBridgeTool('tabs.list', {}, { destinationId: args.destinationId });
    }
    const destinations = await getBridgeDestinations();
    if (destinations.length === 1) {
      return callBridgeTool('tabs.list');
    }
    const results = await Promise.all(
      destinations.map(async (destination) => {
        const client = await createBridgeClientForDestination(
          destination.local ? null : destination.id
        );
        try {
          await client.connect();
          const response = await client.request({
            method: 'tabs.list',
            meta: { source: 'mcp' },
          });
          if (!response.ok) {
            return {
              destinationId: destination.id,
              ok: false,
              error: response.error,
              tabs: [],
            };
          }
          const result = /** @type {{ tabs?: Array<Record<string, unknown>> }} */ (response.result);
          return {
            destinationId: destination.id,
            ok: true,
            tabs: (result.tabs ?? []).map((tab) => ({ destinationId: destination.id, ...tab })),
          };
        } catch (error) {
          return {
            destinationId: destination.id,
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
            tabs: [],
          };
        } finally {
          await client.close();
        }
      })
    );
    const tabs = results.flatMap((result) => result.tabs);
    const failures = results.filter((result) => !result.ok);
    return createToolResult(
      failures.length === 0
        ? `Listed ${tabs.length} tab(s) across ${results.length} destination(s).`
        : `Listed ${tabs.length} tab(s) with ${failures.length} destination error(s).`,
      {
        ok: failures.length === 0,
        tabs,
        destinations: results,
      },
      false
    );
  }
  if (args.action === 'create') {
    return callBridgeTool(
      'tabs.create',
      {
        url: args.url,
        active: args.active,
      },
      { destinationId: args.destinationId ?? null }
    );
  }
  if (args.action === 'close') {
    if (typeof args.tabId !== 'number') {
      return summarizeToolError('tabId is required for tabs.close.');
    }
    return callBridgeTool(
      'tabs.close',
      { tabId: args.tabId },
      { destinationId: args.destinationId ?? null }
    );
  }
  if (args.action === 'activate') {
    if (typeof args.tabId !== 'number') {
      return summarizeToolError('tabId is required for tabs.activate.');
    }
    return callBridgeTool(
      'tabs.activate',
      { tabId: args.tabId },
      { destinationId: args.destinationId ?? null }
    );
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
    params: (a) => ({
      width: a.width,
      height: a.height,
      deviceScaleFactor: a.deviceScaleFactor,
      reset: a.reset,
    }),
  },
};

/**
 * @param {{ action: string, url?: string, waitForLoad?: boolean, timeoutMs?: number, top?: number, left?: number, behavior?: string, relative?: boolean, width?: number, height?: number, deviceScaleFactor?: number, reset?: boolean, tabId?: number, destinationId?: string, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleNavigationTool(args) {
  const entry = NAVIGATION_ACTIONS[args.action];
  if (!entry) return summarizeToolError(`Unsupported navigation action "${args.action}".`);
  if (args.action === 'navigate' && (typeof args.url !== 'string' || !args.url.trim())) {
    return summarizeToolError('url is required for navigation.navigate.');
  }
  if (
    args.action === 'resize' &&
    args.reset !== true &&
    (typeof args.width !== 'number' ||
      !Number.isFinite(args.width) ||
      typeof args.height !== 'number' ||
      !Number.isFinite(args.height))
  ) {
    return summarizeToolError(
      'width and height are required for viewport.resize unless reset=true.'
    );
  }
  return callBridgeTool(entry.method, entry.params(args), {
    tabId: typeof args.tabId === 'number' ? args.tabId : null,
    tokenBudget: getToolTokenBudget(args),
    destinationId: args.destinationId ?? null,
  });
}
