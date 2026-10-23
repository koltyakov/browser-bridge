import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  generateInstallTargets,
  validateInstallTargets,
} from '../../../scripts/generate-install-targets.mjs';
import type { InstallTargets } from '../../../scripts/generate-install-targets.mjs';
import {
  nativePlatforms,
  nativeTargets,
  nativeMaxBytes,
} from '../../../packages/npm/src/install-targets.js';

async function source(): Promise<InstallTargets> {
  return JSON.parse(
    await fs.readFile(new URL('../../../protocol/install-targets.json', import.meta.url), 'utf8')
  ) as InstallTargets;
}

test('installation targets are shared by the builder, npm launcher and generated consumers', async () => {
  const input = await source();
  validateInstallTargets(input);
  assert.deepEqual(nativePlatforms, input.platforms);
  assert.deepEqual(
    nativeTargets,
    Object.fromEntries(input.platforms.map((entry) => [entry.key, entry.asset]))
  );
  assert.equal(nativeMaxBytes, input.maxBinaryBytes);
});

test('installation target validation rejects collisions and unsafe generated identifiers', async () => {
  for (const mutate of [
    (input: InstallTargets) => {
      input.platforms.push(input.platforms[0]);
    },
    (input: InstallTargets) => {
      input.browsers.push(input.browsers[0]);
    },
    (input: InstallTargets) => {
      input.platforms[0].asset = '../escape';
    },
    (input: InstallTargets) => {
      input.extensionId = 'invalid';
    },
    (input: InstallTargets) => {
      input.browsers[0].linuxDir = '../escape';
    },
    (input: InstallTargets) => {
      input.maxBinaryBytes = -1;
    },
    (input: InstallTargets) => {
      input.platforms[0].unixPatterns = [];
    },
  ]) {
    const input = await source();
    mutate(input);
    assert.throws(() => validateInstallTargets(input));
  }
});

test('one new platform generates every consumer and stale output fails check mode', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-targets-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of [
    'protocol',
    'packages/npm/src',
    'packages/extension/src',
    'internal/bridge',
    'scripts',
    '.github/workflows',
  ])
    await fs.mkdir(path.join(directory, name), { recursive: true });
  for (const name of ['scripts/install.sh', 'scripts/install.ps1', '.github/workflows/native.yml'])
    await fs.copyFile(new URL(`../../../${name}`, import.meta.url), path.join(directory, name));
  const input = await source();
  input.platforms.push({
    key: 'linux-riscv64',
    goos: 'linux',
    goarch: 'riscv64',
    asset: 'bbx-linux-riscv64',
    runner: 'ubuntu-24.04',
    unixPatterns: ['Linux:riscv64'],
  });
  await fs.writeFile(path.join(directory, 'protocol/install-targets.json'), JSON.stringify(input));
  await generateInstallTargets(false, directory);
  await generateInstallTargets(true, directory);
  for (const name of [
    'packages/npm/src/install-targets.js',
    'internal/bridge/install_targets.gen.go',
    'scripts/install.sh',
    '.github/workflows/native.yml',
  ])
    assert.match(await fs.readFile(path.join(directory, name), 'utf8'), /riscv64/u, name);
  const generated = path.join(directory, 'packages/npm/src/install-targets.js');
  await fs.appendFile(generated, '// drift\n');
  await assert.rejects(generateInstallTargets(true, directory), /stale/u);
  await generateInstallTargets(false, directory);
  await generateInstallTargets(true, directory);
});
