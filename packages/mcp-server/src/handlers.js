// @ts-check

import os from 'node:os';
import { DEFAULT_CONSOLE_LIMIT, createRuntimeContext } from '../../protocol/src/index.js';
import { collectSetupStatus } from '../../agent-client/src/setup-status.js';
import {
  callBridgeTool,
  createToolResult,
  getDoctorReport,
  getToolTokenBudget,
  getBridgeDestinations,
  applyLimitBudgetPreset,
  summarizeToolError,
  summarizeToolResponse,
  withToolClient,
  REQUEST_SOURCE,
} from './handlers-utils.js';

export {
  createToolResult,
  summarizeToolError,
  summarizeToolResponse,
  withToolClient,
  resolveToolRef,
  getBudgetPresetName,
  inferBudgetFromSelector,
  getToolTokenBudget,
  applyTreeBudgetPreset,
  applyTextBudgetPreset,
  applyLimitBudgetPreset,
  applyHtmlBudgetPreset,
  requestBridgeWithRetry,
  callBridgeTool,
  dispatchToolAction,
  REQUEST_SOURCE,
} from './handlers-utils.js';

export {
  DOM_ACTIONS,
  STYLES_LAYOUT_ACTIONS,
  PATCH_ACTIONS,
  handleDomTool,
  handleStylesLayoutTool,
  handlePatchTool,
} from './handlers-dom.js';

export { NAVIGATION_ACTIONS, handleTabsTool, handleNavigationTool } from './handlers-navigation.js';

export {
  CAPTURE_ACTIONS,
  INPUT_ACTION_METHODS,
  handleCaptureTool,
  handleInputTool,
} from './handlers-capture.js';

export {
  PAGE_ACTIONS,
  handlePageTool,
  handleBatchTool,
  handleRawCallTool,
  handleInvestigateTool,
} from './handlers-page.js';

/** @typedef {import('./handlers-utils.js').ToolAction} ToolAction */
/** @typedef {import('./handlers-utils.js').ToolResult} ToolResult */

const HOME_DIR = os.homedir();

/**
 * @param {{ destinationId?: string }} [args]
 * @returns {Promise<ToolResult>}
 */
export async function handleStatusTool(args = {}) {
  try {
    const requestedDestinationId =
      typeof args.destinationId === 'string' ? args.destinationId : null;
    if (requestedDestinationId && requestedDestinationId !== 'local') {
      const destination = (await getBridgeDestinations()).find(
        (entry) => entry.id === requestedDestinationId
      );
      const result = await callRemoteHealth(requestedDestinationId);
      return createToolResult(
        result.reachable
          ? `Browser Bridge destination "${requestedDestinationId}" is reachable.`
          : `Browser Bridge destination "${requestedDestinationId}" is not reachable.`,
        {
          ok: result.reachable === true,
          destination: destination ?? { id: requestedDestinationId, local: false },
          ...result,
        },
        result.reachable !== true
      );
    }

    const report = await getDoctorReport();
    const destinations = await Promise.all(
      (await getBridgeDestinations()).map(async (destination) => {
        if (destination.local) {
          return {
            ...destination,
            reachable: report.daemonReachable,
            extensionConnected: report.extensionConnected,
            accessEnabled: report.accessEnabled,
            routeReady: report.routeReady,
            routeTabId: report.routeTabId,
          };
        }
        const result = await callRemoteHealth(destination.id);
        return { ...destination, ...result };
      })
    );
    const summary =
      report.issues.length === 0
        ? 'Browser Bridge is ready.'
        : `Browser Bridge has ${report.issues.length} readiness issue(s).`;
    return createToolResult(summary, {
      ok: report.issues.length === 0,
      evidence: report,
      destinations,
    });
  } catch (error) {
    return summarizeToolError(error);
  }
}

/**
 * @param {string} destinationId
 * @returns {Promise<Record<string, unknown>>}
 */
async function callRemoteHealth(destinationId) {
  const result = await callBridgeTool('health.ping', {}, { destinationId });
  return {
    reachable: result.structuredContent.ok === true,
    health: result.structuredContent,
  };
}

/**
 * @returns {Promise<ToolResult>}
 */
export async function handleSkillTool() {
  try {
    const ctx = createRuntimeContext();
    return createToolResult('Runtime context retrieved.', {
      ok: true,
      runtimeContext: ctx,
    });
  } catch (error) {
    return summarizeToolError(error);
  }
}

/**
 * @param {{ global?: boolean }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleSetupTool(args) {
  const projectPath = args.global !== false ? HOME_DIR : process.cwd();
  const status = await collectSetupStatus({
    global: args.global !== false,
    cwd: process.cwd(),
    projectPath,
  });
  const configuredMcp = status.mcpClients.filter((e) => e.configured).length;
  const installedSkills = status.skillTargets.filter((e) => e.installed).length;
  const summary = `Optional agent integration status: ${configuredMcp}/${status.mcpClients.length} MCP clients configured, ${installedSkills}/${status.skillTargets.length} skills installed.`;
  return createToolResult(summary, { ok: true, status });
}

/**
 * @param {{ limit?: number, budgetPreset?: 'quick' | 'normal' | 'deep', destinationId?: string }} args
 * @returns {Promise<ToolResult>}
 */
export async function handleLogTool(args) {
  const normalizedArgs = applyLimitBudgetPreset(args, {
    quick: 10,
    normal: DEFAULT_CONSOLE_LIMIT,
    deep: 100,
  });
  return callBridgeTool(
    'log.tail',
    {
      limit: normalizedArgs.limit ?? DEFAULT_CONSOLE_LIMIT,
    },
    {
      tokenBudget: getToolTokenBudget(normalizedArgs),
      destinationId: typeof args.destinationId === 'string' ? args.destinationId : null,
    }
  );
}

/**
 * @param {{ destinationId?: string }} [args]
 * @returns {Promise<ToolResult>}
 */
export async function handleHealthTool(args = {}) {
  const destinationId = typeof args.destinationId === 'string' ? args.destinationId : null;
  return withToolClient(
    async (client) => {
      const response = await client.request({
        method: 'health.ping',
        meta: { source: REQUEST_SOURCE },
      });
      return summarizeToolResponse(response, 'health.ping');
    },
    { destinationId }
  );
}

/**
 * @param {{ destinationId?: string }} [args]
 * @returns {Promise<ToolResult>}
 */
export async function handleAccessTool(args = {}) {
  return callBridgeTool(
    'access.request',
    {},
    {
      destinationId: typeof args.destinationId === 'string' ? args.destinationId : null,
    }
  );
}
