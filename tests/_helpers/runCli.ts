import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const repoRoot = path.resolve(__dirname, '../..');
export const nativeExecutable =
  process.env.BBX_NATIVE_EXECUTABLE ||
  path.join(repoRoot, 'dist', 'cli', process.platform === 'win32' ? 'bbx.exe' : 'bbx');

// Each test supplies its own bridge home. Do not inherit a developer's remote
// destination, proxy address, or credentials when launching test processes.
export function isolatedBridgeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env, BBX_AUTO_UPDATE: 'off' };
  for (const key of [
    'BBX_REMOTE',
    'BBX_TCP_HOST',
    'BBX_TCP_PORT',
    'BBX_TCP_BIND_HOST',
    'BBX_AUTH_TOKEN',
    'BBX_AUTH_TOKEN_FILE',
  ]) {
    delete result[key];
  }
  return result;
}

export type RunCliOptions = {
  args: string[];
  env?: NodeJS.ProcessEnv;
  stdin?: string | Buffer;
  encoding?: BufferEncoding;
  cwd?: string;
};

export type RunCliResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  readonly json: unknown;
};

export function runCli({
  args,
  env = process.env,
  stdin,
  encoding = 'utf8',
  cwd = repoRoot,
}: RunCliOptions): Promise<RunCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(nativeExecutable, args, {
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
      let parsedJson: unknown;

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
