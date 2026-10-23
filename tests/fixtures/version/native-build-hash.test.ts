import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { nativeBuildHash } from '../../../scripts/native-build-hash.mjs';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bbx-native-hash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of [
    'go.mod',
    'go.sum',
    'cmd/bbx/main.go',
    'internal/bridge/main.go',
    'internal/bridge/generated/catalog.json.gz',
    'internal/bridge/assets/skills.bundle.gz',
    'internal/protocol/types.gen.go',
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `fixture: ${file}`);
  }
  return root;
}

test('native hash is stable across rebuilds, checkout paths, and file timestamps', (t) => {
  const root = fixture(t);
  const otherRoot = fixture(t);
  const hash = nativeBuildHash(root);
  assert.match(hash, /^[a-f0-9]{8}$/u);
  fs.utimesSync(path.join(root, 'cmd/bbx/main.go'), new Date(0), new Date(0));
  assert.equal(nativeBuildHash(root), hash);
  assert.equal(nativeBuildHash(otherRoot), hash);
});

test('native hash tracks source contents, paths, module metadata, and embedded assets', (t) => {
  const root = fixture(t);
  let previous = nativeBuildHash(root);
  for (const file of [
    'cmd/bbx/main.go',
    'internal/bridge/main.go',
    'internal/protocol/types.gen.go',
    'go.mod',
    'go.sum',
    'internal/bridge/generated/catalog.json.gz',
    'internal/bridge/assets/skills.bundle.gz',
  ]) {
    fs.appendFileSync(path.join(root, file), '\nchanged');
    const hash = nativeBuildHash(root);
    assert.notEqual(hash, previous, file);
    previous = hash;
  }
  fs.renameSync(path.join(root, 'cmd/bbx/main.go'), path.join(root, 'cmd/bbx/renamed.go'));
  assert.notEqual(nativeBuildHash(root), previous);
});

test('native hash ignores tests, docs, and build outputs but includes new runtime files', (t) => {
  const root = fixture(t);
  const hash = nativeBuildHash(root);
  for (const file of [
    'internal/bridge/main_test.go',
    'internal/bridge/README.md',
    'internal/bridge/testdata/ignored.go',
    'dist/cli/bbx',
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'ignored');
  }
  assert.equal(nativeBuildHash(root), hash);
  fs.writeFileSync(path.join(root, 'internal/bridge/new.go'), 'new runtime code');
  assert.notEqual(nativeBuildHash(root), hash);
});
