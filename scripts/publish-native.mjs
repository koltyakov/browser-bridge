// @ts-check
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readNativeBuild } from './prepare-npm.mjs';
import { resolveVersion } from './version.mjs';

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
const manifest = await readNativeBuild();
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
const artifacts = [...Object.values(manifest.artifacts), checksums];
const tag = resolved.tag ?? `v${resolved.version}`;
const viewArgs = ['release', 'view', tag, '--repo', repository, '--json', 'isDraft,tagName,assets'];
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
/** @type {unknown} */
const release = JSON.parse(gh(viewArgs));
if (
  !release ||
  typeof release !== 'object' ||
  !('isDraft' in release) ||
  release.isDraft !== false ||
  !('tagName' in release) ||
  release.tagName !== tag ||
  !('assets' in release) ||
  !Array.isArray(release.assets)
) {
  throw new Error(`Expected a public, non-draft GitHub release ${tag}`);
}
const existing = new Set(
  release.assets.map((/** @type {unknown} */ asset) => {
    if (
      !asset ||
      typeof asset !== 'object' ||
      !('name' in asset) ||
      typeof asset.name !== 'string'
    ) {
      throw new Error('GitHub returned an invalid release asset');
    }
    return asset.name;
  })
);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-release-'));
/** @param {import('./prepare-npm.mjs').NativeArtifact} artifact @returns {Promise<void>} */
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
    gh([
      'release',
      'upload',
      tag,
      path.join(root, 'dist/cli', artifact.asset),
      '--repo',
      repository,
    ]);
    await verifyRemote(artifact);
  }
  console.log(
    `Verified all native assets and checksums on https://github.com/${repository}/releases/tag/${tag}`
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
