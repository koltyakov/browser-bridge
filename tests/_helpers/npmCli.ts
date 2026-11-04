import fs from 'node:fs';
import path from 'node:path';

// Execute npm's JavaScript entry point with Node. Windows npm.cmd launchers
// cannot be passed to execFile, and make does not supply npm_execpath.
export function resolveNpmCli({
  execPath = process.execPath,
  env = process.env,
}: { execPath?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const bin = path.dirname(fs.realpathSync.native(execPath));
  const candidates = [
    env.npm_execpath,
    path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...(env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, 'npm')),
  ];
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    const resolved = fs.realpathSync.native(candidate);
    // Other package managers can set npm_execpath to their own executable.
    if (path.basename(resolved) === 'npm-cli.js' && fs.statSync(resolved).isFile()) return resolved;
  }
  throw new Error(`Cannot locate npm-cli.js for ${execPath}; install npm alongside Node.js.`);
}
