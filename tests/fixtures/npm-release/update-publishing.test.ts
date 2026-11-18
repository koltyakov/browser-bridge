import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { nativePlatforms } from '../../../packages/npm/src/install-targets.js';
import { publishUpdateFeed, type GitHubResult } from '../../../scripts/publish-update-feed.mjs';
import {
  readNativeUpdateFeed,
  signNativeUpdateFeed,
  type UpdateRelease,
} from '../../../scripts/native-update-feed.mjs';

interface FeedRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  body: string;
  assets: Array<{ name: string }>;
}

class GitHubFixture {
  remote?: FeedRelease;
  feed?: string;
  calls: string[][] = [];
  fault?: 'api' | 'download' | 'verify' | 'upload-before' | 'upload-after' | 'edit-after';
  apiStatus = 403;

  constructor(feed?: string) {
    this.feed = feed;
    if (feed) this.remote = this.release(false, 'Signed native update metadata.');
  }

  current(): FeedRelease | undefined {
    return this.remote;
  }

  release(draft: boolean, body: string): FeedRelease {
    return {
      tag_name: 'native-updates',
      draft,
      prerelease: true,
      body,
      assets: this.feed ? [{ name: 'stable.json' }] : [],
    };
  }

  run = (args: string[]): GitHubResult => {
    this.calls.push([...args]);
    const failed = { status: 1, stdout: '', stderr: 'injected GitHub failure' };
    if (args[0] === 'api') {
      if (this.fault === 'api')
        return {
          ...failed,
          stdout: this.apiStatus ? `HTTP/2.0 ${this.apiStatus} Error\r\n\r\n{}` : '',
        };
      return {
        status: this.remote ? 0 : 1,
        stdout: `HTTP/2.0 ${this.remote ? '200 OK' : '404 Not Found'}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(this.remote ?? { message: 'Not Found' })}`,
        stderr: '',
      };
    }
    if (args[0] !== 'release') throw new Error(`Unexpected command: ${args}`);
    switch (args[1]) {
      case 'create':
        assert.equal(this.remote, undefined, 'must not recreate an existing release');
        assert(args.includes('--draft'), 'initialization must not expose an empty public feed');
        this.remote = this.release(true, args[args.indexOf('--notes') + 1]);
        break;
      case 'download':
        if (this.fault === 'download' || !this.feed) return failed;
        writeFileSync(
          path.join(args[args.indexOf('--dir') + 1], 'stable.json'),
          this.fault === 'verify' ? 'wrong downloaded bytes' : this.feed
        );
        break;
      case 'upload': {
        if (this.fault === 'upload-before') return failed;
        assert(this.remote);
        this.feed = readFileSync(args[3], 'utf8');
        this.remote.assets = [{ name: 'stable.json' }];
        if (this.fault === 'upload-after') return failed;
        break;
      }
      case 'edit':
        assert(this.remote);
        this.remote.draft = false;
        if (this.fault === 'edit-after') return failed;
        break;
      default:
        throw new Error(`Unexpected command: ${args}`);
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  mutations() {
    return this.calls.filter(
      (args) => args[0] === 'release' && ['create', 'upload', 'edit'].includes(args[1])
    );
  }
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-feed-publishing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const env = {
    RELEASE_SIGNING_PUBLIC_KEYS: JSON.stringify({
      test: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
    }),
    RELEASE_SIGNING_KEY_ID: 'test',
    RELEASE_SIGNING_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
  await fs.mkdir(path.join(root, 'dist/cli'), { recursive: true });
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ version: '2.2.1' }));
  const release: UpdateRelease = { version: '2.2.1', protocolMajor: 2, artifacts: {} };
  for (const platform of nativePlatforms) {
    const data = Buffer.from(`native fixture ${platform.asset}`);
    await fs.writeFile(path.join(root, 'dist/cli', platform.asset), data);
    release.artifacts[`go-${platform.goos}-${platform.goarch}`] = {
      url: `https://github.com/koltyakov/browser-bridge/releases/download/v2.2.1/${platform.asset}`,
      sha256: createHash('sha256').update(data).digest('hex'),
      size: data.length,
    };
  }
  const seed = signNativeUpdateFeed(undefined, release, env);
  const github = new GitHubFixture(seed);
  return { root, env, release, seed, github, options: { root, env, runGH: github.run } };
}

test('feed configuration checks are read-only and reject persistent bootstrap configuration before GitHub access', async (t) => {
  const f = await fixture(t);
  for (const initialize of [false, true]) {
    await assert.rejects(
      publishUpdateFeed(false, {
        ...f.options,
        check: true,
        initialize,
        env: { ...f.env, RELEASE_FEED_INITIALIZE: '1' },
      }),
      /obsolete RELEASE_FEED_INITIALIZE/
    );
  }
  assert.deepEqual(f.github.calls, []);
  await publishUpdateFeed(false, { ...f.options, check: true });
  assert.deepEqual(f.github.mutations(), []);
  assert.equal(f.github.feed, f.seed);
  await assert.rejects(
    publishUpdateFeed(false, {
      ...f.options,
      check: true,
      env: { ...f.env, RELEASE_SIGNING_PRIVATE_KEY: '' },
    })
  );
  assert.deepEqual(f.github.mutations(), []);
});

test('candidate preflight rejects immutable-release changes before remote writes', async (t) => {
  const f = await fixture(t);
  await publishUpdateFeed(true, { ...f.options, check: true });
  await fs.appendFile(path.join(f.root, 'dist/cli', nativePlatforms[0].asset), 'changed');
  await assert.rejects(publishUpdateFeed(true, { ...f.options, check: true }), /immutable signed/);
  assert.deepEqual(f.github.mutations(), []);
  assert.equal(f.github.feed, f.seed);
});

test('normal publishing and renewal reruns preserve history, avoid duplicate releases and never recreate the feed', async (t) => {
  const f = await fixture(t);
  await publishUpdateFeed(true, f.options);
  await publishUpdateFeed(true, f.options);
  await publishUpdateFeed(false, f.options);
  const result = readNativeUpdateFeed(f.github.feed!, f.env);
  assert.equal(result.sequence, 4);
  assert.deepEqual(result.releases, [f.release]);
  assert(f.github.mutations().every((args) => args[1] === 'upload'));
});

test('only explicit initialization permits a missing feed and it remains safe to rerun after success', async (t) => {
  const f = await fixture(t);
  f.github.remote = undefined;
  f.github.feed = undefined;
  await assert.rejects(
    publishUpdateFeed(false, { ...f.options, check: true }),
    /missing.*Initialize/
  );
  assert.deepEqual(f.github.mutations(), []);
  await publishUpdateFeed(false, { ...f.options, initialize: true, check: true });
  assert.deepEqual(f.github.mutations(), []);
  await assert.rejects(
    publishUpdateFeed(false, { ...f.options, initialize: true }),
    /requires --include-release/
  );
  await publishUpdateFeed(true, { ...f.options, initialize: true });
  assert.equal(f.github.current()?.draft, false);
  assert.equal(readNativeUpdateFeed(f.github.feed!, f.env).sequence, 1);
  await publishUpdateFeed(true, { ...f.options, initialize: true });
  assert.equal(readNativeUpdateFeed(f.github.feed!, f.env).sequence, 2);
  assert.deepEqual(readNativeUpdateFeed(f.github.feed!, f.env).releases, [f.release]);
  assert.equal(f.github.calls.filter((args) => args[1] === 'create').length, 1);
});

for (const fault of [
  'upload-before',
  'upload-after',
  'download',
  'verify',
  'edit-after',
] as const) {
  test(`explicit initialization safely resumes after ${fault} without recreating the release`, async (t) => {
    const f = await fixture(t);
    f.github.remote = undefined;
    f.github.feed = undefined;
    f.github.fault = fault;
    await assert.rejects(
      publishUpdateFeed(true, { ...f.options, initialize: true }),
      /GitHub|verification failed/
    );
    assert(f.github.remote);
    f.github.fault = undefined;
    await publishUpdateFeed(true, { ...f.options, initialize: true });
    assert.equal(f.github.current()?.draft, false);
    assert.equal(f.github.calls.filter((args) => args[1] === 'create').length, 1);
    const feed = readNativeUpdateFeed(f.github.feed!, f.env);
    assert.equal(feed.sequence, fault === 'upload-before' ? 1 : 2);
    assert.deepEqual(feed.releases, [f.release]);
  });
}

test('a publish whose upload succeeded before a transport failure can be rerun without resetting its sequence', async (t) => {
  const f = await fixture(t);
  f.github.fault = 'upload-after';
  await assert.rejects(publishUpdateFeed(true, f.options), /GitHub/);
  assert.equal(readNativeUpdateFeed(f.github.feed!, f.env).sequence, 2);
  f.github.fault = undefined;
  await publishUpdateFeed(true, f.options);
  assert.equal(readNativeUpdateFeed(f.github.feed!, f.env).sequence, 3);
  assert(f.github.mutations().every((args) => args[1] === 'upload'));
});

test('API, download and signature failures never become permission to initialize', async (t) => {
  const f = await fixture(t);
  for (const apiStatus of [0, 401, 403, 500]) {
    f.github.fault = 'api';
    f.github.apiStatus = apiStatus;
    await assert.rejects(
      publishUpdateFeed(true, { ...f.options, initialize: true, check: true }),
      /Cannot inspect/
    );
  }
  f.github.fault = 'download';
  await assert.rejects(
    publishUpdateFeed(true, { ...f.options, initialize: true, check: true }),
    /download failed/
  );
  f.github.fault = undefined;
  const envelope = JSON.parse(f.seed) as { signed: string };
  envelope.signed = Buffer.from('{}').toString('base64');
  f.github.feed = JSON.stringify(envelope);
  await assert.rejects(
    publishUpdateFeed(true, { ...f.options, initialize: true, check: true }),
    /signature verification/
  );
  assert.deepEqual(f.github.mutations(), []);
});

test('initialization refuses to reset public missing feeds, nonempty drafts and drafts owned by another version', async (t) => {
  const f = await fixture(t);
  f.github.feed = undefined;
  for (const remote of [
    f.github.release(false, 'Signed native update metadata.'),
    f.github.release(true, 'Browser Bridge native update feed initialization for v2.2.0.'),
    {
      ...f.github.release(true, 'Browser Bridge native update feed initialization for v2.2.1.'),
      assets: [{ name: 'unexpected.json' }],
    },
  ]) {
    f.github.remote = remote;
    await assert.rejects(
      publishUpdateFeed(true, { ...f.options, initialize: true, check: true }),
      /reset|initialization draft/
    );
  }
  f.github.remote = f.github.release(
    true,
    'Browser Bridge native update feed initialization for v2.2.1.'
  );
  await assert.rejects(
    publishUpdateFeed(false, { ...f.options, check: true }),
    /initialization draft/
  );
  assert.deepEqual(f.github.mutations(), []);
});

test('malformed or inaccessible feed releases and changed initialization drafts fail closed', async (t) => {
  const f = await fixture(t);
  for (const result of [
    { status: 1, stdout: '', stderr: '', error: new Error('GitHub CLI unavailable') },
    { status: 0, stdout: 'HTTP/2.0 200 OK\r\n', stderr: '' },
    { status: 0, stdout: 'HTTP/2.0 200 OK\r\n\r\nnull', stderr: '' },
    { status: 0, stdout: 'HTTP/2.0 200 OK\r\n\r\n{"tag_name":"another-tag"}', stderr: '' },
  ]) {
    await assert.rejects(
      publishUpdateFeed(false, {
        ...f.options,
        check: true,
        runGH: () => result,
      })
    );
  }
  f.github.remote = undefined;
  f.github.feed = undefined;
  await assert.rejects(
    publishUpdateFeed(true, {
      ...f.options,
      initialize: true,
      runGH: (args) => {
        const result = f.github.run(args);
        if (args[1] === 'create' && f.github.remote) f.github.remote.body = 'unexpected owner';
        return result;
      },
    }),
    /draft changed unexpectedly/
  );
  assert.equal(f.github.calls.filter((args) => args[1] === 'upload').length, 0);
});

test('release workflow gates initialization on manual tag runs and checks configuration and candidate before uploads', async () => {
  const workflow = await fs.readFile(
    new URL('../../../.github/workflows/release.yml', import.meta.url),
    'utf8'
  );
  assert.match(workflow, /workflow_dispatch:\s+inputs:\s+initialize_feed:/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.initialize_feed/);
  assert.match(workflow, /GITHUB_REF_TYPE.*!= "tag"/);
  const early = workflow.indexOf('run: make check-update-feed\n');
  const build = workflow.indexOf('run: make package-native-all\n');
  const candidate = workflow.indexOf('run: make check-update-feed-release\n');
  const publish = workflow.indexOf('run: make publish-release\n');
  assert(early > 0 && early < build && build < candidate && candidate < publish);
  assert.match(
    workflow.slice(early, build),
    /RELEASE_FEED_INITIALIZE:.*vars\.RELEASE_FEED_INITIALIZE/
  );
  assert.doesNotMatch(workflow.slice(publish), /RELEASE_FEED_INITIALIZE/);
});
