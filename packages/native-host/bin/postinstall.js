#!/usr/bin/env node
// @ts-check
/**
 * npm postinstall hook - auto-installs the native messaging manifest so
 * `npm install -g @browserbridge/bbx` is fully self-contained.
 *
 * Always exits 0 so installation never fails in CI or non-Chrome environments.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { restartBridgeDaemonIfRunning } from '../src/daemon-process.js';
import { installNativeManifest } from '../src/install-manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

/**
 * npm exec may run package lifecycle hooks while resolving the local bin. Keep
 * transient `npm exec -- bbx ...` invocations from rewriting host setup or
 * replacing a working daemon.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
function shouldSkipPostinstall(env = process.env) {
  return env.npm_command === 'exec';
}

/**
 * @param {{
 *   installNativeManifestFn?: typeof installNativeManifest,
 *   restartBridgeDaemonIfRunningFn?: typeof restartBridgeDaemonIfRunning,
 *   stdout?: Pick<NodeJS.WriteStream, 'write'>,
 *   stderr?: Pick<NodeJS.WriteStream, 'write'>,
 *   exit?: (code?: number) => void,
 *   env?: NodeJS.ProcessEnv,
 * }} [deps]
 * @returns {Promise<void>}
 */
export async function runPostinstall({
  installNativeManifestFn = installNativeManifest,
  restartBridgeDaemonIfRunningFn = restartBridgeDaemonIfRunning,
  stdout = process.stdout,
  stderr = process.stderr,
  exit = (code) => process.exit(code),
  env = process.env,
} = {}) {
  if (shouldSkipPostinstall(env)) {
    return;
  }

  try {
    await installNativeManifestFn({ repoRoot, preserveCustomExtensionId: true });
    stdout.write('Browser Bridge: native host installed. Run `bbx doctor` to verify.\n');
  } catch (err) {
    // Non-fatal - user can run `bbx install` manually.
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(
      `Browser Bridge: native host auto-install skipped (${message}).\nRun \`bbx install\` manually if needed.\n`
    );
    exit(0);
    return;
  }

  try {
    const restartResult = await restartBridgeDaemonIfRunningFn();
    if (restartResult) {
      stdout.write('Browser Bridge: restarted the local daemon to use the updated install.\n');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(
      `Browser Bridge: native host installed, but daemon restart failed (${message}).\nRun \`bbx restart\` if needed.\n`
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runPostinstall();
}
