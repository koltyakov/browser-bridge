import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_REMOTE_PORT,
  addRemoteDestination,
  getRemoteConfigPath,
  listBridgeDestinations,
  normalizeDestinationId,
  parseRemoteEndpoint,
  readRemoteConfig,
  removeRemoteDestination,
  writeRemoteConfig,
} from '../src/remotes.js';

const TOKEN = '6f7b4e4a-7b9e-4c0d-9e62-4b1fb9f8d237';

async function withBridgeHome(callback: (bridgeHome: string) => Promise<void>): Promise<void> {
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-remotes-test-'));
  const originalBridgeHome = process.env.BROWSER_BRIDGE_HOME;
  process.env.BROWSER_BRIDGE_HOME = bridgeHome;
  try {
    await callback(bridgeHome);
  } finally {
    if (originalBridgeHome === undefined) {
      delete process.env.BROWSER_BRIDGE_HOME;
    } else {
      process.env.BROWSER_BRIDGE_HOME = originalBridgeHome;
    }
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
}

test('parseRemoteEndpoint defaults to the standard proxy port when omitted', () => {
  assert.deepEqual(parseRemoteEndpoint('10.0.0.5'), {
    host: '10.0.0.5',
    port: DEFAULT_REMOTE_PORT,
  });
});

test('parseRemoteEndpoint preserves explicit host and port', () => {
  assert.deepEqual(parseRemoteEndpoint('vm.internal:9443'), {
    host: 'vm.internal',
    port: 9443,
  });
});

test('parseRemoteEndpoint accepts bracketed IPv6 endpoints', () => {
  assert.deepEqual(parseRemoteEndpoint('[::1]:9443'), {
    host: '::1',
    port: 9443,
  });
});

test('parseRemoteEndpoint rejects invalid host and port values', () => {
  assert.throws(() => parseRemoteEndpoint('bad host'), /Remote host/);
  assert.throws(() => parseRemoteEndpoint('127.0.0.1:99999'), /Remote port/);
});

test('normalizeDestinationId rejects local and unsafe names', () => {
  assert.equal(normalizeDestinationId('vm-private'), 'vm-private');
  assert.throws(() => normalizeDestinationId('local'), /Remote name/);
  assert.throws(() => normalizeDestinationId('../vm'), /Remote name/);
});

test('remote config add, replace, list, and remove use Browser Bridge home', async () => {
  await withBridgeHome(async (bridgeHome) => {
    assert.deepEqual(await readRemoteConfig(), { remotes: [] });

    await addRemoteDestination({ id: 'vm', host: '10.0.0.5', port: 9223, token: TOKEN });
    await addRemoteDestination({ id: 'vm', host: '10.0.0.6', port: 9443, token: TOKEN });

    assert.equal(getRemoteConfigPath(), path.join(bridgeHome, 'remotes.json'));
    assert.deepEqual(await readRemoteConfig(), {
      remotes: [{ id: 'vm', host: '10.0.0.6', port: 9443, token: TOKEN }],
    });
    assert.deepEqual(await listBridgeDestinations(), [
      { id: 'local', local: true, host: null, port: null },
      { id: 'vm', local: false, host: '10.0.0.6', port: 9443 },
    ]);

    assert.equal(await removeRemoteDestination('vm'), true);
    assert.equal(await removeRemoteDestination('vm'), false);
    assert.deepEqual(await readRemoteConfig(), { remotes: [] });
  });
});

test('readRemoteConfig filters malformed remote entries', async () => {
  await withBridgeHome(async () => {
    await writeRemoteConfig({
      remotes: [
        { id: 'valid', host: '10.0.0.5', port: 9223, token: TOKEN },
        { id: '../bad', host: '10.0.0.6', port: 9223, token: TOKEN },
        { id: 'bad-token', host: '10.0.0.7', port: 9223, token: 'nope' },
      ],
    });

    assert.deepEqual(await readRemoteConfig(), {
      remotes: [{ id: 'valid', host: '10.0.0.5', port: 9223, token: TOKEN }],
    });
  });
});
