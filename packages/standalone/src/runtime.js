// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getBridgeDir } from '../../native-host/src/config.js';

export const bundled = typeof BBX_BUILD === 'undefined' ? null : BBX_BUILD;
// A checkout must remain usable for development after the companion is installed.
export const sourceCheckout = !bundled && fs.existsSync(new URL('../../../.git', import.meta.url));

/** @returns {string} */
export function getStandaloneRoot() {
  return path.join(getBridgeDir(), 'companion');
}

/** @returns {string} */
export function getStandaloneLauncher() {
  return path.join(getStandaloneRoot(), process.platform === 'win32' ? 'bbx.exe' : 'bbx');
}

/** @typedef {{ version: string, previousVersion?: string, blockedVersion?: string, managePath?: boolean }} Installation */

/** @returns {Installation | null} */
export function readInstallation() {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(getStandaloneRoot(), 'installation.json'), 'utf8')
    );
    if (typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version)) return null;
    return {
      version: value.version,
      ...(typeof value.managePath === 'boolean' ? { managePath: value.managePath } : {}),
      ...(typeof value.previousVersion === 'string' && /^\d+\.\d+\.\d+$/.test(value.previousVersion)
        ? { previousVersion: value.previousVersion }
        : {}),
      ...(typeof value.blockedVersion === 'string' && /^\d+\.\d+\.\d+$/.test(value.blockedVersion)
        ? { blockedVersion: value.blockedVersion }
        : {}),
    };
  } catch {
    return null;
  }
}

/** @param {string} version @returns {string} */
export function getVersionExecutable(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid companion version.');
  return path.join(
    getStandaloneRoot(),
    'versions',
    version,
    process.platform === 'win32' ? 'bbx.exe' : 'bbx'
  );
}

/** @returns {string | null} */
export function installedLauncher() {
  const state = readInstallation();
  return state &&
    fs.existsSync(getVersionExecutable(state.version)) &&
    fs.existsSync(getStandaloneLauncher())
    ? getStandaloneLauncher()
    : null;
}

/**
 * Keep npm entrypoints useful after migration, including GUI clients with cached paths.
 * In a compiled process only the stable launcher forwards, never a versioned payload.
 * @param {string[]} args
 * @returns {Promise<void>}
 */
export async function forwardToCompanion(args) {
  if (sourceCheckout) return;
  const state = readInstallation();
  if (!state) return;
  const executable = getVersionExecutable(state.version);
  if (bundled && path.resolve(process.execPath) !== path.resolve(getStandaloneLauncher())) return;
  if (!fs.existsSync(executable)) return;
  const child = spawn(executable, args, { stdio: 'inherit', windowsHide: true });
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
    process.once(signal, () => child.kill(signal));
  }
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (status) => resolve(status ?? 1));
  });
  process.exit(code);
}
