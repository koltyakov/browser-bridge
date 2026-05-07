// @ts-check

import os from 'node:os';
import { DEFAULT_CONSOLE_LIMIT, createRuntimeContext } from '../../protocol/src/index.js';
import { collectSetupStatus } from '../../agent-client/src/setup-status.js';
import {
  callBridgeTool,
  createToolResult,
  getDoctorReport,
  getToolTokenBudget,
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
 * @returns {Promise<ToolResult>}
 */
export async function handleStatusTool() {
  try {
    const report = await getDoctorReport();
    const summary =
      report.issues.length === 0
        ? 'Browser Bridge is ready.'
        : `Browser Bridge has ${report.issues.length} readiness issue(s).`;
    return createToolResult(summary, {
      ok: report.issues.length === 0,
      evidence: report,
    });
  } catch (error) {
    return summarizeToolError(error);
  }
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
 * @param {{ limit?: number, budgetPreset?: 'quick' | 'normal' | 'deep' }} args
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
    }
  );
}

/**
 * @returns {Promise<ToolResult>}
 */
export async function handleHealthTool() {
  return withToolClient(async (client) => {
    const response = await client.request({
      method: 'health.ping',
      meta: { source: REQUEST_SOURCE },
    });
    return summarizeToolResponse(response, 'health.ping');
  });
}

/**
 * @returns {Promise<ToolResult>}
 */
export async function handleAccessTool() {
  return callBridgeTool('access.request');
}
