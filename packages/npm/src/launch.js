// @ts-check
import { spawn } from 'node:child_process';
import { resolveNative } from './runtime.js';

/** Forward stdio, arguments, signals, and exit status without interpreting RPC.
 * @param {string[]} prefix @returns {Promise<void>}
 */
export async function launch(prefix) {
  try {
    const { binary, version } = await resolveNative();
    const child = spawn(binary, [...prefix, ...process.argv.slice(2)], {
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, BBX_NPM_VERSION: version },
    });
    /** @type {NodeJS.Signals[]} */
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const handlers = signals.map((signal) => {
      const handler = () => {
        child.kill(signal);
      };
      process.on(signal, handler);
      return handler;
    });
    const clear = () =>
      signals.forEach((signal, index) => process.removeListener(signal, handlers[index]));
    child.once('error', (error) => {
      clear();
      console.error(`Browser Bridge: ${error.message}`);
      process.exitCode = 1;
    });
    child.once('exit', (code, signal) => {
      clear();
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code ?? 1;
    });
  } catch (error) {
    console.error(`Browser Bridge: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
