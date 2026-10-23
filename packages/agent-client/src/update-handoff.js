// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Source checkouts and npm links must not perform a migration preflight.
 * @param {string} [root]
 * @returns {boolean}
 */
export function isSourceCheckout(root = PACKAGE_ROOT) {
  return fs.existsSync(path.join(root, '.git'));
}

/**
 * Resolve the installed package again after npm replaced it. The v1 source
 * entrypoints do not exist in v2, so import.meta.url is not a restart target.
 * @param {'bbx' | 'bbx-mcp'} name
 * @param {string} [root]
 * @returns {string}
 */
export function getInstalledEntrypoint(name, root = PACKAGE_ROOT) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entry = manifest.bin?.[name];
  if (typeof entry !== 'string' || !entry) throw new Error(`Missing installed ${name} launcher.`);
  const resolved = path.resolve(root, entry);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Installed ${name} launcher is outside its package.`);
  }
  return resolved;
}

/** Relaunch only before any browser action or MCP input has been consumed.
 * @param {'bbx' | 'bbx-mcp'} name
 * @param {string[]} args
 * @param {{root?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {number}
 */
export function handoffUpdatedRuntime(name, args, options = {}) {
  const result = spawnSync(
    process.execPath,
    [getInstalledEntrypoint(name, options.root), ...args],
    {
      stdio: 'inherit',
      env: { ...(options.env ?? process.env), BBX_AUTO_UPDATE: 'off' },
    }
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}
