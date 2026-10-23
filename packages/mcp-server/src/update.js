// @ts-check

import { BridgeClient } from '../../agent-client/src/client.js';
import { applyConfiguredAutoUpdate } from '../../agent-client/src/config.js';
import { handoffUpdatedRuntime, isSourceCheckout } from '../../agent-client/src/update-handoff.js';
import { NpmPackageUpdatedError } from '../../agent-client/src/npm-self-update.js';
import { applyWindowsTcpTransportDefaults } from '../../native-host/src/config.js';

/**
 * Update before serveStdio reads initialize or a tool request. A fresh runtime
 * inherits the original pipes, not a half-negotiated MCP session.
 * @param {'bbx' | 'bbx-mcp'} [entrypoint]
 * @param {string[]} [args]
 * @returns {Promise<number | null>}
 */
export async function prepareMcpRuntime(entrypoint = 'bbx-mcp', args = process.argv.slice(2)) {
  if (process.env.BBX_REMOTE || isSourceCheckout()) return null;
  applyWindowsTcpTransportDefaults();
  const options = await applyConfiguredAutoUpdate({ exitProcessOnNpmUpdate: false });
  if (!options.updateNpmOnCompatibleVersion) return null;
  const client = new BridgeClient(options);
  let updated = false;
  try {
    await client.connect();
  } catch (error) {
    if (error instanceof NpmPackageUpdatedError) updated = true;
    // An unavailable local daemon must not prevent remote-only MCP use.
  } finally {
    await client.close();
  }
  return updated ? handoffUpdatedRuntime(entrypoint, args) : null;
}
