// @ts-check
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { entrypoints } from './entrypoints.js';
import { packageRoot } from './runtime.js';

/** @typedef {import('./runtime.js').Release} Release */
/** @typedef {{root?: string, env?: NodeJS.ProcessEnv, platform?: string}} LauncherOptions */
/** @typedef {{node?: string, openssl?: string}} LauncherTools */

/** @param {string} text @returns {string} */
function quote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** Keep verification outside the executable being checked, including on the fast path.
 * @param {Release} release
 * @param {string} wrapper
 * @param {string[]} prefix
 * @param {LauncherTools} [tools]
 * @returns {string}
 */
export function renderNativeLauncher(
  release,
  wrapper,
  prefix,
  { node = process.execPath, openssl = '/usr/bin/openssl' } = {}
) {
  const binary = quote(release.binary);
  const verifier = quote(openssl);
  const fallback = `exec ${quote(node)} ${quote(wrapper)} "$@"`;
  const failure = `printf '%s\\n' ${quote(`Browser Bridge: Cached Browser Bridge binary failed verification. Remove ${release.binary} and retry installation.`)} >&2; exit 1`;
  return `#!/bin/sh
if [ ! -x ${verifier} ] || { [ ! -e ${binary} ] && [ ! -L ${binary} ]; }; then
  ${fallback}
fi
if [ -L ${binary} ] || [ ! -f ${binary} ]; then
  ${failure}
fi
digest=$(${verifier} dgst -sha256 < ${binary}) || { ${failure}; }
if [ "\${digest##* }" != ${quote(release.artifact.sha256)} ]; then
  ${failure}
fi
export BBX_NPM_VERSION=${quote(release.version)}
exec ${binary}${prefix.map((arg) => ` ${quote(arg)}`).join('')} "$@"
`;
}

/** @param {string} link @param {string[]} targets @returns {Promise<boolean>} */
async function ownedLink(link, targets) {
  try {
    if (!(await fs.lstat(link)).isSymbolicLink()) return false;
    const target = path.resolve(path.dirname(link), await fs.readlink(link));
    return targets.includes(target);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** @param {string} destination @param {string} body @returns {Promise<void>} */
async function writeLauncher(destination, body) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, body, { flag: 'wx', mode: 0o755 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Optimize only npm-owned POSIX symlinks, leaving JS files and Windows shims intact.
 * @param {Release} release
 * @param {LauncherOptions} [options]
 * @returns {Promise<number>}
 */
export async function installNativeLaunchers(
  release,
  { root = packageRoot, env = process.env, platform = process.platform } = {}
) {
  if (platform !== 'darwin' && platform !== 'linux') return 0;
  const modules = path.dirname(path.dirname(root));
  if (path.basename(modules) !== 'node_modules') return 0;
  const directories = new Set([path.join(modules, '.bin')]);
  if (env.npm_config_global === 'true' || env.npm_config_global === '1') {
    if (env.npm_config_prefix && path.isAbsolute(env.npm_config_prefix))
      directories.add(path.join(env.npm_config_prefix, 'bin'));
    if (path.basename(path.dirname(modules)) === 'lib')
      directories.add(path.join(path.dirname(path.dirname(modules)), 'bin'));
  }
  let linked = 0;
  for (const [name, prefix] of Object.entries(entrypoints)) {
    const wrapper = path.join(root, 'packages/npm/bin', `${name}.js`);
    const launcher = path.join(root, 'packages/npm/bin/.native', name);
    const targets = [wrapper, launcher];
    for (const directory of directories) {
      const link = path.join(directory, name);
      if (!(await ownedLink(link, targets))) continue;
      await writeLauncher(launcher, renderNativeLauncher(release, wrapper, prefix));
      const temporary = `${link}.${randomUUID()}.tmp`;
      try {
        await fs.symlink(path.relative(directory, launcher), temporary);
        if (!(await ownedLink(link, targets))) continue;
        await fs.rename(temporary, link);
        linked++;
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }
  }
  return linked;
}
