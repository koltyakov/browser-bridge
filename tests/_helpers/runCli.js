// @ts-check

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const cliPath = path.join(repoRoot, 'packages', 'agent-client', 'src', 'cli.js');

/**
 * @typedef {{
 *   args: string[],
 *   env?: NodeJS.ProcessEnv,
 *   stdin?: string | Buffer,
 *   encoding?: BufferEncoding,
 *   cwd?: string,
 * }} RunCliOptions
 */

/**
 * @typedef {{
 *   status: number | null,
 *   signal: NodeJS.Signals | null,
 *   stdout: string,
 *   stderr: string,
 *   readonly json: any,
 * }} RunCliResult
 */

/**
 * @param {RunCliOptions} options
 * @returns {Promise<RunCliResult>}
 */
export function runCli({ args, env = process.env, stdin, encoding = 'utf8', cwd = repoRoot }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding(encoding);
    child.stderr.setEncoding(encoding);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status, signal) => {
      let parsed = false;
      /** @type {any} */
      let parsedJson;

      resolve({
        status,
        signal,
        stdout,
        stderr,
        get json() {
          if (!parsed) {
            parsedJson = JSON.parse(stdout.trim());
            parsed = true;
          }
          return parsedJson;
        },
      });
    });
    child.stdin.end(stdin);
  });
}
