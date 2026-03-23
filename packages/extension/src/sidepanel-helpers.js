// @ts-check

/**
 * @typedef {{
 *   configured: boolean
 * }} McpClientInstallState
 */

/**
 * @typedef {{
 *   exists: boolean
 * }} SkillInstallState
 */

/**
 * @typedef {{
 *   skills: SkillInstallState[]
 * }} SkillTargetInstallState
 */

/**
 * @typedef {{
 *   mcpClients: McpClientInstallState[],
 *   skillTargets: SkillTargetInstallState[]
 * }} SetupStatusInstallState
 */

/**
 * @param {SetupStatusInstallState} setupStatus
 * @returns {{ hasConfiguredMcp: boolean, hasInstalledCliSkill: boolean }}
 */
function getSetupInstallState(setupStatus) {
  const hasConfiguredMcp = setupStatus.mcpClients.some((client) => client.configured);
  const hasInstalledCliSkill = setupStatus.skillTargets.some((target) => target.skills.some((skill) => skill.exists));
  return { hasConfiguredMcp, hasInstalledCliSkill };
}

/**
 * Auto-expand Host Setup when the panel opens into a completely unconfigured
 * machine: no MCP clients configured and no CLI skill present anywhere.
 *
 * @param {SetupStatusInstallState | null} setupStatus
 * @returns {boolean}
 */
export function shouldAutoExpandHostSetup(setupStatus) {
  if (!setupStatus) {
    return false;
  }

  const { hasConfiguredMcp, hasInstalledCliSkill } = getSetupInstallState(setupStatus);
  if (hasConfiguredMcp) {
    return false;
  }
  return !hasInstalledCliSkill;
}

/**
 * Pick which prompt-example set to show in the side panel.
 *
 * - `mcp`: MCP is installed, CLI skill is not.
 * - `cli`: CLI skill is installed, MCP is not.
 * - `grouped`: neither is installed, or both are installed.
 *
 * @param {SetupStatusInstallState | null} setupStatus
 * @returns {'mcp' | 'cli' | 'grouped'}
 */
export function getPromptExamplesMode(setupStatus) {
  if (!setupStatus) {
    return 'grouped';
  }

  const { hasConfiguredMcp, hasInstalledCliSkill } = getSetupInstallState(setupStatus);
  if (hasConfiguredMcp && !hasInstalledCliSkill) {
    return 'mcp';
  }
  if (hasInstalledCliSkill && !hasConfiguredMcp) {
    return 'cli';
  }
  return 'grouped';
}

/**
 * Pick the activity source tag to display in the side panel. Prefer explicit
 * request metadata, but fall back to setup state when only one host path is
 * configured so older log entries stay understandable.
 *
 * @param {string | null | undefined} source
 * @param {SetupStatusInstallState | null} setupStatus
 * @returns {'' | 'cli' | 'mcp'}
 */
export function getActivitySourceTag(source, setupStatus) {
  if (source === 'cli' || source === 'mcp') {
    return source;
  }

  const promptMode = getPromptExamplesMode(setupStatus);
  if (promptMode === 'cli' || promptMode === 'mcp') {
    return promptMode;
  }

  return '';
}
