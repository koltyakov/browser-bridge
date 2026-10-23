// @ts-check
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { nativePlatforms, nativeTargets, nativeMaxBytes } from './install-targets.js';

/** @typedef {{asset: string, sha256: string, bytes: number}} Artifact */
/** @typedef {{version: string, target: string, artifact: Artifact, url: string, binary: string}} Release */
/** @typedef {{root?: string, env?: NodeJS.ProcessEnv, platform?: string, arch?: string, fetchFn?: typeof fetch, probeFn?: typeof probeExecutable}} InstallOptions */

export const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const exec = promisify(execFile);
const maxBytes = nativeMaxBytes;
export { nativeTargets };

/** @param {unknown} value @returns {Record<string, unknown>} */
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid native release metadata');
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} error @param {string} code @returns {boolean} */
function hasCode(error, code) {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** @param {NodeJS.ProcessEnv} env @param {string} platform @returns {string} */
function cacheDirectory(env, platform) {
  const home = (platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
  if (platform === 'win32')
    return path.join(
      env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
      'Browser Bridge',
      'npm'
    );
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'Browser Bridge', 'npm');
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'browser-bridge', 'npm');
}

/** @param {InstallOptions} [options] @returns {Promise<Release>} */
export async function loadRelease({
  root = packageRoot,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const target = `${platform}-${arch}`;
  const asset = nativeTargets[target];
  if (!asset)
    throw new Error(
      `Browser Bridge does not publish a native binary for ${target}. Supported targets: ${Object.keys(nativeTargets).join(', ')}`
    );
  const pkg = object(JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')));
  const version = pkg.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error('Invalid npm package version');
  let manifest;
  try {
    manifest = object(
      JSON.parse(await fs.readFile(path.join(root, 'packages/npm/native-manifest.json'), 'utf8'))
    );
  } catch (error) {
    if (hasCode(error, 'ENOENT'))
      throw new Error(
        'Native release manifest is missing. In a source checkout run `make package-npm`; otherwise reinstall @browserbridge/bbx.'
      );
    throw error;
  }
  if (manifest.version !== version)
    throw new Error(`Native release manifest does not match npm version ${version}`);
  const entry = object(object(manifest.artifacts)[target]);
  if (
    entry.asset !== asset ||
    typeof entry.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(entry.sha256) ||
    typeof entry.bytes !== 'number' ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes <= 0 ||
    entry.bytes >= maxBytes
  )
    throw new Error(`Invalid native artifact for ${target}`);
  const artifact = /** @type {Artifact} */ (entry);
  return {
    version,
    target,
    artifact,
    url: `https://github.com/koltyakov/browser-bridge/releases/download/v${version}/${asset}`,
    // Keep running binaries outside node_modules so npm upgrades on Windows do
    // not try to replace a locked daemon executable. Versions never overwrite.
    binary: path.join(
      cacheDirectory(env, platform),
      version,
      target,
      artifact.sha256,
      platform === 'win32' ? 'bbx.exe' : 'bbx'
    ),
  };
}

/** @param {Release} release @returns {Promise<boolean>} */
async function cachedBinary(release) {
  let stat;
  try {
    stat = await fs.lstat(release.binary);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
  const invalid = () =>
    new Error(
      `Cached Browser Bridge binary failed verification. Remove ${release.binary} and retry installation.`
    );
  if (!stat.isFile() || stat.size !== release.artifact.bytes) throw invalid();
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(release.binary)) hash.update(chunk);
  if (hash.digest('hex') !== release.artifact.sha256) throw invalid();
  return true;
}

/** @param {string} binary @param {Release} release @param {NodeJS.ProcessEnv} env @returns {Promise<void>} */
export async function probeExecutable(binary, release, env) {
  const home = await fs.mkdtemp(path.join(path.dirname(binary), '.probe-'));
  try {
    const { stdout } = await exec(binary, ['--self-test'], {
      env: {
        ...env,
        BROWSER_BRIDGE_HOME: home,
        BBX_REMOTE: '',
        BBX_TCP_PORT: '',
        BBX_TCP_HOST: '',
        BBX_TCP_BIND_HOST: '',
        BBX_AUTO_UPDATE: 'off',
      },
      timeout: 15_000,
      maxBuffer: 16_384,
      windowsHide: true,
    });
    const result = object(JSON.parse(stdout));
    const platform = nativePlatforms.find((entry) => entry.key === release.target);
    const target = platform ? `go-${platform.goos}-${platform.goarch}` : '';
    if (result.runtime !== 'go' || result.version !== release.version || result.target !== target)
      throw new Error(
        `Downloaded binary does not match Browser Bridge ${release.version} for ${release.target}`
      );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

/** @param {Release} release @param {typeof fetch} fetchFn @param {AbortSignal} signal @returns {Promise<Response>} */
async function fetchBinary(release, fetchFn, signal) {
  let url = release.url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetchFn(url, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('Native download redirect has no location');
      const next = new URL(location, url);
      if (next.protocol !== 'https:' || next.username || next.password)
        throw new Error('Native downloads require HTTPS redirects without credentials');
      url = next.href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Cannot download Browser Bridge ${release.version} for ${release.target}: HTTP ${response.status}. Expected release asset: ${release.url}`
      );
    }
    if (!response.body) throw new Error('Native download returned an empty body');
    return response;
  }
  throw new Error('Too many native download redirects');
}

/** @param {Release} release @param {InstallOptions} options @returns {Promise<void>} */
async function downloadBinary(release, options) {
  const temporary = path.join(
    path.dirname(release.binary),
    `.download-${process.pid}-${randomUUID()}${path.extname(release.binary)}`
  );
  const file = await fs.open(temporary, 'wx', 0o700);
  try {
    const response = await fetchBinary(
      release,
      options.fetchFn || fetch,
      AbortSignal.timeout(120_000)
    );
    const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > release.artifact.bytes)
          throw new Error('Native download exceeds its expected size');
        hash.update(chunk.value);
        await file.writeFile(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    if (bytes !== release.artifact.bytes || hash.digest('hex') !== release.artifact.sha256)
      throw new Error('Native download failed SHA-256 or size verification');
    await file.chmod(0o755);
    await file.sync();
    await file.close();
    await (options.probeFn || probeExecutable)(temporary, release, options.env || process.env);
    await fs.rename(temporary, release.binary);
  } finally {
    await file.close();
    await fs.rm(temporary, { force: true });
  }
}

/** Download the package-pinned release, or reuse a verified cached executable.
 * @param {InstallOptions} [options] @returns {Promise<Release>}
 */
export async function resolveNative(options = {}) {
  const release = await loadRelease(options);
  if (await cachedBinary(release)) return release;
  const directory = path.dirname(release.binary);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, '.install-lock');
  const deadline = Date.now() + 150_000;
  for (;;) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      if (await cachedBinary(release)) return release;
      const stat = await fs.stat(lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 300_000) {
        await fs.rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for native installation lock ${lock}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    if (!(await cachedBinary(release))) await downloadBinary(release, options);
    return release;
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

/** @param {InstallOptions} [options] @returns {Promise<string>} */
export async function ensureNative(options = {}) {
  return (await resolveNative(options)).binary;
}

/** @param {string} [root] @returns {Promise<boolean>} */
export async function isSourceCheckout(root = packageRoot) {
  return fs
    .access(path.join(root, 'go.mod'))
    .then(() => fs.access(path.join(root, 'cmd/bbx/main.go')))
    .then(
      () => true,
      () => false
    );
}
