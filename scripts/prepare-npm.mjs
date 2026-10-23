// @ts-check
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveVersion } from './version.mjs';
import { nativePlatforms, nativeMaxBytes } from '../packages/npm/src/install-targets.js';

/** @typedef {{asset: string, sha256: string, bytes: number}} NativeArtifact */
/** @typedef {{version: string, artifacts: Record<string, NativeArtifact>}} NativeManifest */

const root = fileURLToPath(new URL('../', import.meta.url));

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate every registered native asset and pin the exact bytes shipped on GitHub.
 * @param {string} [directory]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<NativeManifest>}
 */
export async function readNativeBuild(directory = root, env = process.env) {
  const { version } = resolveVersion({ root: directory, env });
  /** @type {unknown} */
  const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  if (!isRecord(pkg) || pkg.version !== version) {
    throw new Error(`package.json version must match ${version}; run make sync-version`);
  }
  /** @type {NativeManifest} */
  const manifest = { version, artifacts: {} };
  for (const platform of nativePlatforms) {
    const file = path.join(directory, 'dist/cli', platform.asset);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size >= nativeMaxBytes) {
      throw new Error(
        `${platform.asset} must be a regular file smaller than ${nativeMaxBytes} bytes`
      );
    }
    const bytes = await fs.readFile(file);
    if (bytes.length !== stat.size)
      throw new Error(`Native asset changed while reading: ${platform.asset}`);
    manifest.artifacts[platform.key] = {
      asset: platform.asset,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    };
  }
  return manifest;
}

/**
 * Replace the generated manifest only after every platform passes validation.
 * @param {string} [directory]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<NativeManifest>}
 */
export async function prepareNpm(directory = root, env = process.env) {
  const manifest = await readNativeBuild(directory, env);
  const destination = path.join(directory, 'packages/npm/native-manifest.json');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await prepareNpm();
  console.log(
    `Prepared npm native manifest for ${manifest.version} (${Object.keys(manifest.artifacts).length} platforms)`
  );
}
