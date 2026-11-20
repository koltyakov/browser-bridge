import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';

test('release publishing requires only versioned assets and npm, not separate feed infrastructure', async () => {
  const workflow = await fs.readFile(
    new URL('../../../.github/workflows/release.yml', import.meta.url),
    'utf8'
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /GITHUB_REF_TYPE.*!= "tag"/);
  assert.doesNotMatch(workflow, /update[-_]feed|initialize_feed|RELEASE_SIGNING|RELEASE_FEED/);
  const tests = workflow.indexOf('run: make test-js\n');
  const build = workflow.indexOf('run: make package-native-all\n');
  const publish = workflow.indexOf('run: make publish-release\n');
  const pack = workflow.indexOf('run: make pack\n');
  assert(tests > 0 && tests < build && build < publish && publish < pack);
  assert.match(workflow, /run: make publish-npm/);
  assert.match(workflow, /id-token: write/);
  assert.doesNotMatch(workflow, /--clobber/);
});

test('normal build and Make targets do not configure a metadata feed or signing keys', async () => {
  const makefile = await fs.readFile(new URL('../../../Makefile', import.meta.url), 'utf8');
  const build = await fs.readFile(
    new URL('../../../scripts/build-native.mjs', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(makefile, /update-feed|UPDATE_FEED_ARGS/);
  assert.doesNotMatch(build, /nativeUpdate|RELEASE_SIGNING/);
  assert.match(makefile, /publish-release:[\s\S]*?publish-native\.mjs --include-extension/);
});

test('no workflow schedules or publishes a separate native metadata feed', async () => {
  const directory = new URL('../../../.github/workflows/', import.meta.url);
  const names = await fs.readdir(directory);
  for (const name of names.filter((entry) => /\.ya?ml$/.test(entry))) {
    const workflow = await fs.readFile(new URL(name, directory), 'utf8');
    assert.doesNotMatch(workflow, /renew-update-feed|publish-update-feed|initialize_feed/, name);
  }
});
