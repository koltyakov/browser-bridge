import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCli } from '../../../tests/_helpers/runCli.ts';

async function withBridgeHome(callback: (bridgeHome: string) => Promise<void>): Promise<void> {
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-cli-config-test-'));
  try {
    await callback(bridgeHome);
  } finally {
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
}

test('bbx config sets and gets the auto-update policy without a daemon', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const env = { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome };
    const setResult = await runCli({
      args: ['config', 'set', 'auto-update', 'compatible'],
      env,
    });
    assert.equal(setResult.status, 0);
    assert.equal(setResult.stderr, '');
    assert.equal(
      setResult.stdout,
      `Browser Bridge auto-update policy set to "compatible".\nConfig: ${path.join(bridgeHome, 'config.json')}\n`
    );
    assert.deepEqual(
      JSON.parse(await fs.promises.readFile(path.join(bridgeHome, 'config.json'), 'utf8')),
      { autoUpdate: 'compatible' }
    );

    const getResult = await runCli({ args: ['config', 'get', 'auto-update'], env });
    assert.equal(getResult.status, 0);
    assert.equal(getResult.stdout, 'compatible\n');
  });
});

test('bbx config validates policy and remains local-only', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const env = { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome };
    const invalid = await runCli({
      args: ['config', 'set', 'auto-update', 'latest'],
      env,
    });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /must be "off" or "compatible"/u);

    const remote = await runCli({
      args: ['config', 'get', 'auto-update', '--remote', 'vm'],
      env,
    });
    assert.equal(remote.status, 1);
    assert.match(remote.stderr, /--remote flag is not supported/u);
  });
});
