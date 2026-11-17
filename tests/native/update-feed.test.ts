import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import {
  nativeUpdateLinkerFlags,
  nativeUpdateSigningKey,
} from '../../scripts/native-update-config.mjs';
import {
  readNativeUpdateFeed,
  signNativeUpdateFeed,
  type UpdateRelease,
} from '../../scripts/native-update-feed.mjs';

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const env = {
    BBX_NATIVE_UPDATE_KEYS: JSON.stringify({
      release: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
    }),
    BBX_NATIVE_UPDATE_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
  const release: UpdateRelease = {
    version: '2.2.2',
    protocolMajor: 2,
    artifacts: {
      'go-linux-amd64': {
        url: 'https://example.com/bbx',
        sha256: 'a'.repeat(64),
        size: 100,
      },
    },
  };
  return { env, release };
}

test('native update publishing authenticates, renews, and retains immutable releases', () => {
  const { env, release } = fixture();
  const now = new Date('2026-11-17T12:00:00Z');
  const raw = signNativeUpdateFeed(undefined, release, env, now);
  const first = readNativeUpdateFeed(raw, env);
  assert.equal(first.sequence, 1);
  assert.deepEqual(first.releases, [release]);
  assert.equal(first.expiresAt, '2026-12-01T12:00:00.000Z');
  const renewed = readNativeUpdateFeed(signNativeUpdateFeed(first, undefined, env, now), env);
  assert.equal(renewed.sequence, 2);
  assert.deepEqual(renewed.releases, [release]);
  assert.throws(
    () => signNativeUpdateFeed(first, { ...release, protocolMajor: 3 }, env),
    /immutable/
  );
  const envelope = JSON.parse(raw) as { signed: string };
  envelope.signed = Buffer.from('{}').toString('base64');
  assert.throws(() => readNativeUpdateFeed(JSON.stringify(envelope), env), /signature/);
  assert.throws(() => readNativeUpdateFeed(raw, fixture().env), /signature/);
});

test('native release builds pin keys and publishing rejects missing or mismatched signing configuration', () => {
  const { env } = fixture();
  assert.match(nativeUpdateLinkerFlags(env), /nativeUpdateKeysJSON=/);
  assert.match(nativeUpdateLinkerFlags(env), /native-updates\/stable.json/);
  assert.equal(nativeUpdateLinkerFlags({}), '');
  assert.throws(() => nativeUpdateSigningKey({}), /Configure/);
  assert.throws(
    () =>
      nativeUpdateSigningKey({
        ...env,
        BBX_NATIVE_UPDATE_PRIVATE_KEY: fixture().env.BBX_NATIVE_UPDATE_PRIVATE_KEY,
      }),
    /does not match/
  );
  assert.throws(
    () => nativeUpdateLinkerFlags({ BBX_NATIVE_UPDATE_KEYS: '{"release":"invalid"}' }),
    /Invalid/
  );
});
