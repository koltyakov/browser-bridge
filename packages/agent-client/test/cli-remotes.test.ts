import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCli } from '../../../tests/_helpers/runCli.ts';

const TOKEN = '6f7b4e4a-7b9e-4c0d-9e62-4b1fb9f8d237';

async function withBridgeHome(callback: (bridgeHome: string) => Promise<void>): Promise<void> {
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-cli-remotes-test-'));
  try {
    await callback(bridgeHome);
  } finally {
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
}

test('bbx remote add defaults omitted port to 9223 and list redacts tokens', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const env = { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome };
    const addResult = await runCli({
      args: ['remote', 'add', 'vm-private', '10.0.0.5', '--token', TOKEN],
      env,
    });

    assert.equal(addResult.status, 0);
    assert.equal(addResult.stderr, '');
    assert.equal(addResult.stdout, 'Remote destination "vm-private" saved (10.0.0.5:9223).\n');

    const listResult = await runCli({ args: ['remote', 'list'], env });
    assert.equal(listResult.status, 0);
    assert.equal(listResult.stderr, '');
    assert.equal(listResult.stdout, 'vm-private\t10.0.0.5:9223\n');
    assert.equal(listResult.stdout.includes(TOKEN), false);
  });
});

test('bbx remote add accepts explicit port and remove deletes the destination', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const env = { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome };
    const addResult = await runCli({
      args: ['remote', 'add', 'vm-private', 'vm.internal:9443', '--token', TOKEN],
      env,
    });
    assert.equal(addResult.status, 0);
    assert.equal(addResult.stderr, '');
    assert.equal(addResult.stdout, 'Remote destination "vm-private" saved (vm.internal:9443).\n');

    const removeResult = await runCli({ args: ['remote', 'remove', 'vm-private'], env });
    assert.equal(removeResult.status, 0);
    assert.equal(removeResult.stderr, '');
    assert.equal(removeResult.stdout, 'Remote destination "vm-private" removed.\n');
  });
});

test('bbx proxy status reports disabled config without starting a daemon', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const result = await runCli({
      args: ['proxy', 'status'],
      env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'Browser Bridge proxy is disabled.\n');
  });
});

test('bbx proxy status reports enabled config and daemon reachability', async () => {
  await withBridgeHome(async (bridgeHome) => {
    await fs.promises.writeFile(
      path.join(bridgeHome, 'proxy.json'),
      JSON.stringify({ enabled: true, port: 65534, bindHost: '0.0.0.0' }),
      'utf8'
    );

    const result = await runCli({
      args: ['proxy', 'status'],
      env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(
      result.stdout,
      [
        'Browser Bridge proxy is enabled on 0.0.0.0:65534.',
        `Config: ${path.join(bridgeHome, 'proxy.json')}`,
        'Daemon: not reachable on 127.0.0.1:65534',
        '',
      ].join('\n')
    );
  });
});
