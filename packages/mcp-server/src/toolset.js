// @ts-check

/**
 * Tool-surface profiles for the Browser Bridge MCP server.
 *
 * Every registered tool schema is sent to the agent on `tools/list` and stays in
 * context for the whole session. The full typed surface is convenient in hosts
 * that render tools individually, but it is a fixed token cost in every session
 * even when the agent only ever reaches for the generic `browser_call` path that
 * `MCP_SERVER_INSTRUCTIONS` already recommends as the default.
 *
 * The `minimal` profile registers only the tools needed to reach the entire
 * bridge protocol - generic dispatch, readiness, access, and parallel reads -
 * and drops the specialized typed wrappers. Every method reachable through a
 * specialized tool stays reachable through `browser_call`, so the profile
 * narrows the schema surface without narrowing the protocol.
 */

/** @typedef {'full' | 'minimal'} ToolsetProfile */

export const TOOLSET_PROFILE_ENV = 'BBX_MCP_TOOLSET';

/** @type {ToolsetProfile} */
export const DEFAULT_TOOLSET_PROFILE = 'full';

/** @type {readonly ToolsetProfile[]} */
export const TOOLSET_PROFILES = Object.freeze(['full', 'minimal']);

/**
 * Tools registered under the `minimal` profile.
 *
 * `browser_call` reaches every bridge method by name, `browser_batch` keeps
 * parallel reads available, and the remaining three cover the readiness and
 * access handshake an agent needs before any call can succeed.
 *
 * @type {readonly string[]}
 */
export const MINIMAL_TOOLSET_TOOLS = Object.freeze([
  'browser_access',
  'browser_batch',
  'browser_call',
  'browser_health',
  'browser_status',
]);

/**
 * @param {unknown} value
 * @returns {value is ToolsetProfile}
 */
export function isToolsetProfile(value) {
  return (
    typeof value === 'string' && TOOLSET_PROFILES.includes(/** @type {ToolsetProfile} */ (value))
  );
}

/**
 * Resolve the active profile from the environment.
 *
 * An unset or blank value selects the default profile. An unrecognized value
 * falls back to the default and reports the problem on stderr, which is safe
 * for a stdio MCP server because the protocol itself uses stdout.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @param {{ warn?: (message: string) => unknown }} [options]
 * @returns {ToolsetProfile}
 */
export function resolveToolsetProfile(env = process.env, options = {}) {
  const { warn = (message) => process.stderr.write(`${message}\n`) } = options;
  const raw = env[TOOLSET_PROFILE_ENV];

  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_TOOLSET_PROFILE;
  }

  const normalized = raw.trim().toLowerCase();

  if (isToolsetProfile(normalized)) {
    return normalized;
  }

  warn(
    `Browser Bridge: ignoring unknown ${TOOLSET_PROFILE_ENV} value "${raw}"; expected one of ${TOOLSET_PROFILES.join(', ')}. Falling back to "${DEFAULT_TOOLSET_PROFILE}".`
  );

  return DEFAULT_TOOLSET_PROFILE;
}

/**
 * Build the predicate that decides whether a tool is registered for a profile.
 *
 * @param {ToolsetProfile} profile
 * @returns {(toolName: string) => boolean}
 */
export function createToolFilter(profile) {
  if (profile === 'minimal') {
    const allowed = new Set(MINIMAL_TOOLSET_TOOLS);
    return (toolName) => allowed.has(toolName);
  }

  return () => true;
}
