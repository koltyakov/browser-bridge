// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** @typedef {{ root?: string, env?: Record<string, string | undefined> }} VersionOptions */
/** @typedef {{ version: string, source: 'manifest' | 'tag', tag?: string }} ResolvedVersion */
/** @typedef {Record<string, unknown>} JsonObject */

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

/**
 * Resolve the shared Chrome/npm version without checking generated mirrors.
 * An explicitly supplied env replaces process.env rather than merging with it.
 * @param {VersionOptions} [options]
 * @returns {ResolvedVersion}
 */
export function resolveVersion({ root = repositoryRoot, env = process.env } = {}) {
  const tag = releaseTag(env);
  if (tag !== undefined) {
    return {
      version: validateVersion(tag.replace(/^v/u, ''), `release tag ${JSON.stringify(tag)}`),
      source: 'tag',
      tag,
    };
  }
  const manifest = readObject(path.join(root, 'manifest.json'));
  return {
    version: validateVersion(manifest.version, 'manifest.json.version'),
    source: 'manifest',
  };
}

/**
 * Update version mirrors after validating the authority and all JSON structures.
 * Unchanged files are not rewritten. Tag builds also update the manifest.
 * @param {VersionOptions} [options]
 * @returns {ResolvedVersion}
 */
export function synchronizeVersion(options = {}) {
  const resolved = resolveVersion(options);
  const files = versionFiles(options.root ?? repositoryRoot);
  for (const entry of files) {
    if (entry.file === 'manifest.json' && resolved.source !== 'tag') continue;
    let changed = false;
    for (const target of entry.targets) {
      if (target.object.version !== resolved.version) {
        target.object.version = resolved.version;
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(entry.path, `${JSON.stringify(entry.object, null, 2)}\n`);
  }
  return resolved;
}

/**
 * Assert exact agreement between the authority and package, lock, and manifest.
 * @param {VersionOptions} [options]
 * @returns {ResolvedVersion}
 */
export function checkVersion(options = {}) {
  const resolved = resolveVersion(options);
  const mismatches = versionFiles(options.root ?? repositoryRoot).flatMap((entry) =>
    entry.targets
      .filter((target) => target.object.version !== resolved.version)
      .map((target) => `${target.label} is ${JSON.stringify(target.object.version)}`)
  );
  if (mismatches.length) {
    throw new Error(
      `Version mismatch: expected ${resolved.version} from ${resolved.source}${resolved.tag ? ` ${resolved.tag}` : ''}; ${mismatches.join('; ')}. Run node scripts/version.mjs --sync.`
    );
  }
  return resolved;
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string | undefined}
 */
function releaseTag(env) {
  const ref = env.GITHUB_REF;
  const type = env.GITHUB_REF_TYPE;
  const name = env.GITHUB_REF_NAME;
  const refTag = ref?.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : undefined;
  /** @type {{ label: string, tag: string }[]} */
  const candidates = [];
  if (refTag !== undefined) {
    if (type && type !== 'tag')
      throw new Error(
        'Inconsistent tag environment: GITHUB_REF is a tag but GITHUB_REF_TYPE is not tag.'
      );
    candidates.push({ label: 'GITHUB_REF', tag: refTag });
    if (name !== undefined) candidates.push({ label: 'GITHUB_REF_NAME', tag: name });
  } else if (type === 'tag') {
    if (ref)
      throw new Error(
        'Inconsistent tag environment: GITHUB_REF_TYPE is tag but GITHUB_REF is not a tag ref.'
      );
    if (!name)
      throw new Error('GITHUB_REF_TYPE=tag requires GITHUB_REF_NAME or a refs/tags/ GITHUB_REF.');
    candidates.push({ label: 'GITHUB_REF_NAME', tag: name });
  }
  if (env.RELEASE_TAG !== undefined)
    candidates.push({ label: 'RELEASE_TAG', tag: env.RELEASE_TAG });
  for (const candidate of candidates) {
    if (!candidate.tag.startsWith('v')) {
      throw new Error(
        `Invalid ${candidate.label} tag: expected vX.Y.Z to match the npm binary download URLs.`
      );
    }
    validateVersion(
      candidate.tag.replace(/^v/u, ''),
      `${candidate.label} tag ${JSON.stringify(candidate.tag)}`
    );
    if (candidate.tag !== candidates[0].tag) {
      throw new Error(
        `Inconsistent release tags: ${candidates[0].label}=${JSON.stringify(candidates[0].tag)}, ${candidate.label}=${JSON.stringify(candidate.tag)}.`
      );
    }
  }
  return candidates[0]?.tag;
}

/** @param {unknown} version @param {string} label @returns {string} */
function validateVersion(version, label) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
    throw new Error(
      `Invalid ${label}: expected a stable X.Y.Z version, prefixed with v for tags, without leading zeros. Prerelease and build metadata are unsupported because Chrome and npm share one version.`
    );
  }
  const components = version.split('.').map(Number);
  if (
    components.some((component) => component > 65535) ||
    components.every((component) => component === 0)
  ) {
    throw new Error(
      `Invalid ${label}: Chrome version components must be 0..65535 and the version must not be all zero.`
    );
  }
  return version;
}

/** @param {unknown} value @param {string} label @returns {JsonObject} */
function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return /** @type {JsonObject} */ (value);
}

/** @param {string} file @returns {JsonObject} */
function readObject(file) {
  return requireObject(JSON.parse(fs.readFileSync(file, 'utf8')), file);
}

/**
 * Read every target before sync writes anything, including the lock root entry.
 * @param {string} root
 * @returns {{ file: string, path: string, object: JsonObject, targets: { label: string, object: JsonObject }[] }[]}
 */
function versionFiles(root) {
  return ['package.json', 'package-lock.json', 'manifest.json'].map((file) => {
    const filePath = path.join(root, file);
    const object = readObject(filePath);
    const targets = [{ label: `${file}.version`, object }];
    if (file === 'package-lock.json') {
      const packages = requireObject(object.packages, 'package-lock.json.packages');
      targets.push({
        label: "package-lock.json.packages[''].version",
        object: requireObject(packages[''], "package-lock.json.packages['']"),
      });
    }
    return { file, path: filePath, object, targets };
  });
}

if (process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    const mode = args[0] ?? '--check';
    if (args.length > 1 || !['--sync', '--check', '--print'].includes(mode)) {
      throw new Error('Usage: node scripts/version.mjs [--sync|--check|--print]');
    }
    const resolved =
      mode === '--sync'
        ? synchronizeVersion()
        : mode === '--check'
          ? checkVersion()
          : resolveVersion();
    process.stdout.write(
      mode === '--print'
        ? `${resolved.version}\n`
        : `Version ${mode === '--sync' ? 'synchronized' : 'verified'}: ${resolved.version} (${resolved.source}).\n`
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
