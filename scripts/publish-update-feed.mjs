// @ts-check
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readNativeUpdateFeed, signNativeUpdateFeed } from './native-update-feed.mjs';
import { nativeUpdateSigningKey } from './native-update-config.mjs';
import { nativePlatforms } from '../packages/npm/src/install-targets.js';
import { prepareNpm } from './prepare-npm.mjs';
import { resolveVersion } from './version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = 'koltyakov/browser-bridge';
/** @typedef {{status: number | null, stdout: string, stderr: string, error?: Error}} GitHubResult */
/** @typedef {{initialize?: boolean, check?: boolean, env?: NodeJS.ProcessEnv, root?: string, runGH?: (args: string[]) => GitHubResult}} PublishOptions */
/** @typedef {{tag_name: string, draft: boolean, prerelease: boolean, body: string, assets: {name: string}[]}} FeedRelease */

/** @param {string[]} args @param {NodeJS.ProcessEnv} env @returns {GitHubResult} */
function runGitHub(args, env) {
  return spawnSync('gh', args[0] === 'api' ? args : [...args, '--repo', repository], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
}

/** Distinguish an explicit GitHub 404 from authentication, network and CLI errors.
 * A failed read must never silently become permission to reset the feed.
 * @param {(args: string[]) => GitHubResult} run
 * @returns {FeedRelease | undefined}
 */
function inspectFeedRelease(run) {
  const result = run(['api', `repos/${repository}/releases/tags/native-updates`, '--include']);
  if (result.error) throw result.error;
  const status = /^HTTP\/[\d.]+\s+(\d{3})[^\r\n]*\r?\n/.exec(result.stdout)?.[1];
  if (status === '404' && result.status !== null && result.status !== 0) return undefined;
  if (result.status !== 0 || status !== '200')
    throw new Error(
      `Cannot inspect native update feed: ${result.stderr || 'invalid GitHub response'}`
    );
  const boundary = /\r?\n\r?\n/.exec(result.stdout);
  if (!boundary) throw new Error('Invalid GitHub release response');
  const release = /** @type {Partial<FeedRelease> | null} */ (
    JSON.parse(result.stdout.slice(boundary.index + boundary[0].length))
  );
  if (
    !release ||
    release.tag_name !== 'native-updates' ||
    typeof release.draft !== 'boolean' ||
    release.prerelease !== true ||
    typeof release.body !== 'string' ||
    !Array.isArray(release.assets) ||
    !release.assets.every((asset) => asset && typeof asset.name === 'string')
  )
    throw new Error('Expected the native-updates metadata prerelease');
  return /** @type {FeedRelease} */ (release);
}

/** Release publishing must be serialized with scheduled feed renewal.
 * Checks perform only remote reads. Initialization is an explicit invocation,
 * never a repository setting, and can resume only an unpublished owned draft.
 * @param {boolean} [includeRelease]
 * @param {PublishOptions} [options]
 * @returns {Promise<void>}
 */
export async function publishUpdateFeed(includeRelease = false, options = {}) {
  const env = options.env ?? process.env;
  if (env.RELEASE_FEED_INITIALIZE && env.RELEASE_FEED_INITIALIZE !== '0')
    throw new Error(
      'Remove the obsolete RELEASE_FEED_INITIALIZE variable. Use the manual initialize_feed workflow input or --initialize for one-time initialization.'
    );
  if (options.initialize && !includeRelease && !options.check)
    throw new Error('Initialization requires --include-release and verified native release assets');
  nativeUpdateSigningKey(env);
  const run = options.runGH ?? ((args) => runGitHub(args, env));
  /** @param {string[]} args @returns {string} */
  function gh(args) {
    const result = run(args);
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`GitHub ${args.slice(0, 2).join(' ')} failed: ${result.stderr}`);
    return result.stdout;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-update-feed-'));
  try {
    let remote = inspectFeedRelease(run);
    const version = resolveVersion({ root: options.root ?? root, env }).version;
    const draftMarker = `Browser Bridge native update feed initialization for v${version}.`;
    /** @type {import('./native-update-feed.mjs').UpdateManifest | undefined} */
    let previous;
    if (!remote && !options.initialize)
      throw new Error(
        'Native update feed is missing. Initialize it explicitly with initialize_feed on a manual release-tag run.'
      );
    if (remote?.draft && (!options.initialize || remote.body !== draftMarker))
      throw new Error(
        'Native update feed has an incomplete initialization draft. Rerun the original manual initialization on its release tag.'
      );
    if (remote?.assets.some((asset) => asset.name === 'stable.json')) {
      gh(['release', 'download', 'native-updates', '--pattern', 'stable.json', '--dir', directory]);
      previous = readNativeUpdateFeed(
        await fs.readFile(path.join(directory, 'stable.json'), 'utf8'),
        env
      );
    } else if (remote && (!remote.draft || remote.assets.length !== 0))
      throw new Error(
        'Existing native update release has no signed feed. Restore its metadata; initialization will not reset a public or nonempty release.'
      );
    /** @type {import('./native-update-feed.mjs').UpdateRelease | undefined} */
    let release;
    if (includeRelease) {
      const manifest = await prepareNpm(options.root ?? root, env);
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
    // Validate immutable-release conflicts before creating or uploading anything.
    // The early configuration check need not have local build assets yet.
    const signed = previous || release ? signNativeUpdateFeed(previous, release, env) : undefined;
    if (options.check) return;
    if (!signed) throw new Error('No native releases to sign');
    if (!remote) {
      gh([
        'release',
        'create',
        'native-updates',
        '--target',
        'main',
        '--title',
        'Native update feed',
        '--notes',
        draftMarker,
        '--draft',
        '--prerelease',
        '--latest=false',
      ]);
      remote = inspectFeedRelease(run);
      if (!remote?.draft || remote.body !== draftMarker || remote.assets.length !== 0)
        throw new Error('Native update initialization draft changed unexpectedly');
    }
    const filename = path.join(directory, 'stable.json');
    await fs.writeFile(filename, signed);
    // Only this mutable signed metadata asset may be replaced, never binaries.
    gh(['release', 'upload', 'native-updates', filename, '--clobber']);
    await fs.rm(filename);
    gh(['release', 'download', 'native-updates', '--pattern', 'stable.json', '--dir', directory]);
    if ((await fs.readFile(filename, 'utf8')) !== signed)
      throw new Error('Published native update feed verification failed');
    if (remote.draft) {
      gh(['release', 'edit', 'native-updates', '--draft=false', '--latest=false']);
      if (inspectFeedRelease(run)?.draft !== false)
        throw new Error('Native update feed draft was not published');
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = new Set(process.argv.slice(2));
  if ([...flags].some((flag) => !['--include-release', '--initialize', '--check'].includes(flag)))
    throw new Error('Usage: publish-update-feed.mjs [--include-release] [--initialize] [--check]');
  await publishUpdateFeed(flags.has('--include-release'), {
    initialize: flags.has('--initialize'),
    check: flags.has('--check'),
  });
}
