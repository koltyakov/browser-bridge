// @ts-check
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readNativeUpdateFeed, signNativeUpdateFeed } from './native-update-feed.mjs';
import { nativeUpdateSigningKey } from './native-update-config.mjs';
import { nativePlatforms } from '../packages/npm/src/install-targets.js';
import { prepareNpm } from './prepare-npm.mjs';

/** @param {string[]} args @returns {string} */
function gh(args) {
  return execFileSync('gh', [...args, '--repo', 'koltyakov/browser-bridge'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/** Release publishing must be serialized with scheduled feed renewal.
 * @param {boolean} [includeRelease] @returns {Promise<void>}
 */
export async function publishUpdateFeed(includeRelease = false) {
  nativeUpdateSigningKey();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-update-feed-'));
  try {
    /** @type {import('./native-update-feed.mjs').UpdateManifest | undefined} */
    let previous;
    // A missing feed is allowed only for an explicitly requested first publish.
    // Authentication and network failures never silently reset the sequence.
    if (process.env.BBX_NATIVE_UPDATE_INITIALIZE !== '1') {
      gh(['release', 'download', 'native-updates', '--pattern', 'stable.json', '--dir', directory]);
      previous = readNativeUpdateFeed(
        await fs.readFile(path.join(directory, 'stable.json'), 'utf8')
      );
    } else {
      gh([
        'release',
        'create',
        'native-updates',
        '--target',
        'main',
        '--title',
        'Native update feed',
        '--notes',
        'Signed native update metadata.',
        '--prerelease',
        '--latest=false',
      ]);
    }
    /** @type {import('./native-update-feed.mjs').UpdateRelease | undefined} */
    let release;
    if (includeRelease) {
      const manifest = await prepareNpm();
      /** @type {Record<string, import('./native-update-feed.mjs').UpdateArtifact>} */
      const artifacts = {};
      for (const platform of nativePlatforms) {
        const artifact = manifest.artifacts[platform.key];
        artifacts[`go-${platform.goos}-${platform.goarch}`] = {
          url: `https://github.com/koltyakov/browser-bridge/releases/download/v${manifest.version}/${artifact.asset}`,
          sha256: artifact.sha256,
          size: artifact.bytes,
        };
      }
      release = {
        version: manifest.version,
        protocolMajor: Number(manifest.version.split('.')[0]),
        artifacts,
      };
    }
    const signed = signNativeUpdateFeed(previous, release);
    const filename = path.join(directory, 'stable.json');
    await fs.writeFile(filename, signed);
    // Only this mutable signed metadata asset may be replaced, never binaries.
    gh(['release', 'upload', 'native-updates', filename, '--clobber']);
    await fs.rm(filename);
    gh(['release', 'download', 'native-updates', '--pattern', 'stable.json', '--dir', directory]);
    if ((await fs.readFile(filename, 'utf8')) !== signed)
      throw new Error('Published native update feed verification failed');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await publishUpdateFeed(process.argv.includes('--include-release'));
}
