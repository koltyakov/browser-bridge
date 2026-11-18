// @ts-check
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareNpm } from './prepare-npm.mjs';
import { resolveVersion } from './version.mjs';
import { haveSameZipContents } from './extension-zip.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = 'koltyakov/browser-bridge';

/** @param {string[]} args @returns {string} */
function gh(args) {
  return execFileSync('gh', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

const resolved = resolveVersion({ root });
const manifest = await prepareNpm();
const checksumBytes = Buffer.from(
  Object.values(manifest.artifacts)
    .map((artifact) => `${artifact.sha256}  ${artifact.asset}\n`)
    .join('')
);
const checksums = {
  asset: 'checksums.txt',
  bytes: checksumBytes.length,
  sha256: createHash('sha256').update(checksumBytes).digest('hex'),
};
await fs.writeFile(path.join(root, 'dist/cli', checksums.asset), checksumBytes);
const artifacts = [...Object.values(manifest.artifacts), checksums].map((artifact) => ({
  ...artifact,
  file: path.join(root, 'dist/cli', artifact.asset),
}));
if (process.argv.includes('--include-extension')) {
  const file = path.join(root, 'dist', `browser-bridge-extension-v${resolved.version}.zip`);
  const bytes = await fs.readFile(file);
  if (bytes.length === 0) throw new Error(`Extension ZIP is empty: ${file}`);
  artifacts.push({
    asset: 'bbx-browser-extension.zip',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    file,
  });
}
const tag = resolved.tag ?? `v${resolved.version}`;
const viewArgs = ['release', 'view', tag, '--repo', repository, '--json', 'isDraft,tagName,assets'];
/** @typedef {{isDraft: boolean, assets: {name: string}[]}} ReleaseState */

/** @param {string} raw @returns {ReleaseState} */
function readRelease(raw) {
  /** @type {unknown} */
  const release = JSON.parse(raw);
  if (
    !release ||
    typeof release !== 'object' ||
    !('isDraft' in release) ||
    typeof release.isDraft !== 'boolean' ||
    !('tagName' in release) ||
    release.tagName !== tag ||
    !('assets' in release) ||
    !Array.isArray(release.assets)
  ) {
    throw new Error(`Expected GitHub release ${tag} with valid draft status and asset metadata`);
  }
  const assets = release.assets.map((/** @type {unknown} */ asset) => {
    if (!asset || typeof asset !== 'object' || !('name' in asset) || typeof asset.name !== 'string')
      throw new Error('GitHub returned an invalid release asset');
    return { name: asset.name };
  });
  if (new Set(assets.map((asset) => asset.name)).size !== assets.length)
    throw new Error('GitHub returned duplicate release assets');
  return { isDraft: release.isDraft, assets };
}

/** A draft may outlive a deleted tag. Never let publishing recreate that tag.
 * @returns {void}
 */
function verifyReleaseTag() {
  /** @type {unknown} */
  const reference = JSON.parse(
    gh(['api', `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`])
  );
  if (
    !reference ||
    typeof reference !== 'object' ||
    !('ref' in reference) ||
    reference.ref !== `refs/tags/${tag}`
  )
    throw new Error(`Release tag ${tag} must already exist; refusing to create or change it`);
}

/** Do not publish unrelated, unverified files attached to a manual draft.
 * @param {ReleaseState} release @returns {void}
 */
function requireKnownDraftAssets(release) {
  const expected = new Set(artifacts.map((artifact) => artifact.asset));
  for (const asset of release.assets) {
    if (!expected.has(asset.name))
      throw new Error(
        `Draft release contains unverified asset ${asset.name}. Rerun with the complete artifact set; refusing to publish it.`
      );
  }
}

const view = spawnSync('gh', viewArgs, { cwd: root, encoding: 'utf8' });
if (view.status !== 0) {
  // Creation verifies the tag and fails if an existing release could not be read.
  // No upload ever uses --clobber, including during concurrent workflow reruns.
  gh([
    'release',
    'create',
    tag,
    '--repo',
    repository,
    '--verify-tag',
    '--title',
    tag,
    '--generate-notes',
  ]);
}
const release = readRelease(view.status === 0 ? view.stdout : gh(viewArgs));
if (release.isDraft) {
  verifyReleaseTag();
  requireKnownDraftAssets(release);
}
const existing = new Set(release.assets.map((asset) => asset.name));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-release-'));
/** @param {import('./prepare-npm.mjs').NativeArtifact & {file: string}} artifact @returns {Promise<void>} */
async function verifyRemote(artifact) {
  const file = path.join(temporary, artifact.asset);
  await fs.rm(file, { force: true });
  gh([
    'release',
    'download',
    tag,
    '--repo',
    repository,
    '--pattern',
    artifact.asset,
    '--dir',
    temporary,
  ]);
  const bytes = await fs.readFile(file);
  if (
    bytes.length !== artifact.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
  ) {
    // Older platform ZIP packers recorded wall-clock timestamps. Keep the
    // original immutable archive if every validated entry is byte-identical.
    if (
      artifact.asset === 'bbx-browser-extension.zip' &&
      haveSameZipContents(bytes, await fs.readFile(artifact.file))
    ) {
      console.log(
        'Verified identical extension contents; reusing the existing immutable ZIP bytes.'
      );
      return;
    }
    throw new Error(
      `Immutable release asset mismatch: ${tag}/${artifact.asset}. Refusing to overwrite it; publish a new version.`
    );
  }
}
try {
  // Check every existing asset before adding any missing assets.
  for (const artifact of artifacts) {
    if (existing.has(artifact.asset)) await verifyRemote(artifact);
  }
  for (const artifact of artifacts) {
    if (existing.has(artifact.asset)) continue;
    const uploadPath = path.join(temporary, artifact.asset);
    await fs.copyFile(artifact.file, uploadPath);
    gh(['release', 'upload', tag, uploadPath, '--repo', repository]);
    await verifyRemote(artifact);
  }
  if (release.isDraft) {
    // Re-read and reverify the complete set after filling any missing assets.
    // A failed upload/verification leaves the release as a resumable draft.
    const current = readRelease(gh(viewArgs));
    requireKnownDraftAssets(current);
    for (const artifact of artifacts) {
      if (!current.assets.some((asset) => asset.name === artifact.asset))
        throw new Error(`Draft release is missing required asset ${artifact.asset}`);
      await verifyRemote(artifact);
    }
    if (current.isDraft) {
      verifyReleaseTag();
      gh(['release', 'edit', tag, '--repo', repository, '--draft=false']);
      const published = readRelease(gh(viewArgs));
      if (published.isDraft) throw new Error(`Draft release ${tag} was not published`);
      requireKnownDraftAssets(published);
      if (
        artifacts.some(
          (artifact) => !published.assets.some((asset) => asset.name === artifact.asset)
        )
      )
        throw new Error(`Published release ${tag} is missing required assets`);
    }
  }
  console.log(
    `Verified all release assets on https://github.com/${repository}/releases/tag/${tag}`
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
