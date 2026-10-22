#!/usr/bin/env node
// @ts-check
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveNative, isSourceCheckout } from '../src/runtime.js';

const exec = promisify(execFile);

/** @param {NodeJS.ProcessEnv} env @returns {boolean} */
export function shouldInitialize(env) {
  return (
    env.npm_command !== 'exec' &&
    (env.npm_config_global === 'true' ||
      env.npm_config_global === '1' ||
      env.BBX_POSTINSTALL_FORCE === '1')
  );
}

/** Fetch on local and global installs; only a global install registers browsers.
 * @param {import('../src/runtime.js').InstallOptions & { initialize?: (binary: string, env: NodeJS.ProcessEnv) => Promise<void> }} [options]
 * @returns {Promise<void>}
 */
export async function postinstall(options = {}) {
  if (await isSourceCheckout(options.root)) return;
  const { binary, version } = await resolveNative(options);
  const env = { ...(options.env || process.env), BBX_NPM_VERSION: version };
  if (!shouldInitialize(env)) return;
  try {
    if (options.initialize) await options.initialize(binary, env);
    else {
      const result = await exec(binary, ['install', '--preserve-origins'], {
        env,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
    }
  } catch (error) {
    console.error(
      `Browser Bridge binary installed, but native host setup failed: ${error instanceof Error ? error.message : String(error)}\nRun \`bbx install\` to finish setup.`
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await postinstall();
  } catch (error) {
    console.error(
      `Browser Bridge installation failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
