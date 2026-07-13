import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_REMOTE_PORT,
  addRemoteDestination,
  assertProxyBindSafety,
  getRemoteConfigPath,
  listBridgeDestinations,
  normalizeDestinationId,
  parseRemoteEndpoint,
  readRemoteConfig,
  removeRemoteDestination,
  resolveProxyEnableSettings,
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

test('resolveProxyEnableSettings generates a token and defaults on first enable', () => {
  const generatedToken = 'a'.repeat(32);
  const settings = resolveProxyEnableSettings(null, {}, () => generatedToken);
  assert.deepEqual(settings, {
    port: DEFAULT_REMOTE_PORT,
    bindHost: '127.0.0.1',
    token: generatedToken,
    tokenSource: 'generated',
  });
});

test('proxy bind safety requires explicit acknowledgement for new non-loopback exposure', () => {
  assert.doesNotThrow(() => assertProxyBindSafety(null, {}, '127.0.0.1'));
  assert.throws(
    () => assertProxyBindSafety(null, { bindHost: '0.0.0.0' }, '0.0.0.0'),
    /--unsafe-plaintext.*unencrypted.*SSH tunnel/u
  );
  assert.doesNotThrow(() =>
    assertProxyBindSafety(null, { bindHost: '0.0.0.0', unsafePlaintext: true }, '0.0.0.0')
  );
});

test('proxy bind safety preserves an existing non-loopback config on re-enable', () => {
  const existing = { bindHost: '192.168.0.10' };
  assert.doesNotThrow(() => assertProxyBindSafety(existing, {}, existing.bindHost));
  assert.throws(
    () => assertProxyBindSafety(existing, { bindHost: '192.168.0.11' }, '192.168.0.11'),
    /--unsafe-plaintext/u
  );
});

test('resolveProxyEnableSettings reuses existing settings and secret on re-enable', () => {
  const existing = { port: 9443, bindHost: '192.168.0.10', token: TOKEN };
  const settings = resolveProxyEnableSettings(existing, {}, () => {
    throw new Error('must not generate a new token');
  });
  assert.deepEqual(settings, {
    port: 9443,
    bindHost: '192.168.0.10',
    token: TOKEN,
    tokenSource: 'existing',
  });
});

test('resolveProxyEnableSettings keeps the secret when only port or bind host change', () => {
  const existing = { port: 9223, bindHost: '0.0.0.0', token: TOKEN };
  const settings = resolveProxyEnableSettings(existing, { port: 9444 }, () => {
    throw new Error('must not generate a new token');
  });
  assert.deepEqual(settings, {
    port: 9444,
    bindHost: '0.0.0.0',
    token: TOKEN,
    tokenSource: 'existing',
  });
});

test('resolveProxyEnableSettings rotates the secret only when asked', () => {
  const existing = { port: 9223, bindHost: '0.0.0.0', token: TOKEN };
  const newToken = 'b'.repeat(32);
  const explicitToken = 'c'.repeat(32);
  const rotated = resolveProxyEnableSettings(existing, { rotateToken: true }, () => newToken);
  assert.equal(rotated.token, newToken);
  assert.equal(rotated.tokenSource, 'generated');

  const explicit = resolveProxyEnableSettings(existing, { token: explicitToken }, () => {
    throw new Error('must not generate a new token');
  });
  assert.equal(explicit.token, explicitToken);
  assert.equal(explicit.tokenSource, 'explicit');
});

test('readRemoteConfig filters malformed remote entries', async () => {
  await withBridgeHome(async () => {
    await fs.promises.writeFile(
      getRemoteConfigPath(),
      JSON.stringify({
        remotes: [
          { id: 'valid', host: '10.0.0.5', port: 9223, token: TOKEN },
          { id: '../bad', host: '10.0.0.6', port: 9223, token: TOKEN },
          { id: 'bad-token', host: '10.0.0.7', port: 9223, token: 'nope' },
        ],
      }),
      'utf8'
    );

    assert.deepEqual(await readRemoteConfig(), {
      remotes: [{ id: 'valid', host: '10.0.0.5', port: 9223, token: TOKEN }],
    });
  });
});

test('remote config validates tokens before saving and enforces private permissions', async () => {
  await withBridgeHome(async () => {
    await assert.rejects(
      addRemoteDestination({ id: 'vm', host: '10.0.0.5', port: 9223, token: 'short' }),
      /Bridge auth token/u
    );
    await assert.rejects(fs.promises.access(getRemoteConfigPath()), { code: 'ENOENT' });

    await fs.promises.writeFile(getRemoteConfigPath(), '{"remotes":[]}\n', { mode: 0o644 });
    await addRemoteDestination({ id: 'vm', host: '10.0.0.5', port: 9223, token: TOKEN });
    if (process.platform !== 'win32') {
      assert.equal((await fs.promises.stat(getRemoteConfigPath())).mode & 0o777, 0o600);
    }
  });
});
