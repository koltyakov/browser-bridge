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
/** @typedef {{root?: string, env?: NodeJS.ProcessEnv, platform?: string, arch?: string, fetchFn?: typeof fetch, probeFn?: typeof probeExecutable, refresh?: boolean}} InstallOptions */

export const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const exec = promisify(execFile);
const maxBytes = nativeMaxBytes;
export { nativeTargets };
const repository = 'https://api.github.com/repos/koltyakov/browser-bridge';
const downloads = 'https://github.com/koltyakov/browser-bridge/releases/download';
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const metadataMaxBytes = 8 * 1024 * 1024;

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
  const cache = env.XDG_CACHE_HOME;
  return path.join(
    cache && path.isAbsolute(cache) ? cache : path.join(home, '.cache'),
    'browser-bridge',
    'npm'
  );
}

/** Read bounded release metadata using the same HTTPS redirect rules as binaries.
 * @param {string} url @param {typeof fetch} fetchFn @returns {Promise<string>}
 */
async function metadata(url, fetchFn) {
  const response = await fetchResponse(url, fetchFn, AbortSignal.timeout(15_000));
  const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > metadataMaxBytes)
        throw new Error('Native release metadata exceeds its size limit');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** @param {unknown} value @returns {string | undefined} */
function releaseVersion(value) {
  const release = object(value);
  if (
    release.draft !== false ||
    release.prerelease !== false ||
    typeof release.tag_name !== 'string' ||
    !release.tag_name.startsWith('v')
  )
    return undefined;
  const version = release.tag_name.replace(/^v/, '');
  return stableVersion.test(version) ? version : undefined;
}

/** @param {string} selector @param {typeof fetch} fetchFn @returns {Promise<Record<string, unknown>>} */
async function selectRelease(selector, fetchFn) {
  if (selector === 'latest' || stableVersion.test(selector)) {
    const release = object(
      JSON.parse(
        await metadata(
          `${repository}/releases/${selector === 'latest' ? 'latest' : `tags/v${selector}`}`,
          fetchFn
        )
      )
    );
    const version = releaseVersion(release);
    if (!version || (selector !== 'latest' && version !== selector))
      throw new Error(`Invalid published stable release for ${selector}`);
    return release;
  }
  /** @type {Record<string, unknown> | undefined} */
  let best;
  let patch = -1n;
  for (let page = 1; ; page++) {
    /** @type {unknown} */
    const releases = JSON.parse(
      await metadata(`${repository}/releases?per_page=100&page=${page}`, fetchFn)
    );
    if (!Array.isArray(releases)) throw new Error('Invalid GitHub release list');
    for (const candidate of releases) {
      const version = releaseVersion(candidate);
      if (version?.startsWith(`${selector}.`) && BigInt(version.split('.')[2]) > patch) {
        best = object(candidate);
        patch = BigInt(version.split('.')[2]);
      }
    }
    if (releases.length < 100) break;
  }
  if (!best) throw new Error(`No published stable release found for ${selector}.x`);
  return best;
}

/** @param {unknown} value @param {string} asset @param {string} target @returns {Artifact} */
function validateArtifact(value, asset, target) {
  const entry = object(value);
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
  return /** @type {Artifact} */ (entry);
}

/** @param {string} filename @returns {Promise<Record<string, unknown> | undefined>} */
async function readSelection(filename) {
  try {
    return object(JSON.parse(await fs.readFile(filename, 'utf8')));
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    return undefined;
  }
}

/** @param {string} filename @param {Record<string, unknown>} selection @returns {Promise<void>} */
async function writeSelection(filename, selection) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(selection), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Resolve a native release independently of the npm package version.
 * BBX_VERSION accepts an extension release line, an exact stable version, or latest.
 * @param {InstallOptions} [options] @returns {Promise<Release>}
 */
export async function loadRelease({
  root = packageRoot,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  fetchFn = fetch,
  refresh = false,
} = {}) {
  const target = `${platform}-${arch}`;
  const asset = nativeTargets[target];
  if (!asset)
    throw new Error(
      `Browser Bridge does not publish a native binary for ${target}. Supported targets: ${Object.keys(nativeTargets).join(', ')}`
    );
  const directory = cacheDirectory(env, platform);
  // Remember each installation's selected release, including on Windows where
  // every invocation uses Node. Other npm installations must not change it.
  const identity = createHash('sha256').update(path.resolve(root)).digest('hex');
  const installation = path.join(directory, `installation-${identity}-${target}.json`);
  const installed = await readSelection(installation);
  const requested = env.BBX_VERSION || (!refresh && installed?.selector) || 'latest';
  if (typeof requested !== 'string') throw new Error('Invalid cached native release selector');
  const selector = requested.replace(/^v/, '');
  if (selector !== 'latest' && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.test(selector))
    throw new Error('Invalid BBX_VERSION: expected latest, X.Y, or X.Y.Z');
  const selection = path.join(directory, `release-${selector}-${target}.json`);
  let cached =
    !refresh && installed?.selector === selector ? installed : await readSelection(selection);
  if (!cached || refresh) {
    const release = await selectRelease(selector, fetchFn);
    const version = releaseVersion(release);
    if (!Array.isArray(release.assets)) throw new Error('Invalid native release assets');
    const assets = release.assets.map(object).filter((entry) => entry.name === asset);
    if (assets.length !== 1) throw new Error(`Missing or duplicate native artifact for ${target}`);
    const checksums = await metadata(`${downloads}/v${version}/checksums.txt`, fetchFn);
    const matches = checksums
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((entry) => entry[1] === asset);
    if (matches.length !== 1) throw new Error(`Missing or duplicate native checksum for ${target}`);
    const artifact = validateArtifact(
      { asset, bytes: assets[0].size, sha256: matches[0][0] },
      asset,
      target
    );
    cached = { selector, version, artifact };
    await writeSelection(selection, cached);
  }
  const version = cached.version;
  if (
    cached.selector !== selector ||
    typeof version !== 'string' ||
    !stableVersion.test(version) ||
    (selector !== 'latest' && version !== selector && !version.startsWith(`${selector}.`))
  )
    throw new Error('Invalid cached native release version');
  const artifact = validateArtifact(cached.artifact, asset, target);
  if (cached !== installed) await writeSelection(installation, cached);
  return {
    version,
    target,
    artifact,
    url: `${downloads}/v${version}/${asset}`,
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

/** @param {string} initialURL @param {typeof fetch} fetchFn @param {AbortSignal} signal @returns {Promise<Response>} */
async function fetchResponse(initialURL, fetchFn, signal) {
  let url = initialURL;
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
        `Cannot download Browser Bridge release: HTTP ${response.status}. URL: ${initialURL}`
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
    const response = await fetchResponse(
      release.url,
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

/** Download the selected GitHub release, or reuse a verified cached executable.
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
