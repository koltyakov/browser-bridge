import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import {
  nativeUpdateLinkerFlags,
  nativeUpdateKeys,
  nativeUpdateSigningKey,
  nativeUpdateSigningKeyID,
} from '../../scripts/native-update-config.mjs';
import {
  readNativeUpdateFeed,
  signNativeUpdateFeed,
  type UpdateRelease,
} from '../../scripts/native-update-feed.mjs';

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const env = {
    RELEASE_SIGNING_PUBLIC_KEYS: JSON.stringify({
      'release-2026-11-17': publicKey
        .export({ format: 'der', type: 'spki' })
        .subarray(-32)
        .toString('base64'),
    }),
    RELEASE_SIGNING_KEY_ID: 'release-2026-11-17',
    RELEASE_SIGNING_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
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
  const envelope = JSON.parse(raw) as { signed: string; signatures: { keyId: string }[] };
  assert.equal(envelope.signatures[0].keyId, env.RELEASE_SIGNING_KEY_ID);
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
        RELEASE_SIGNING_PRIVATE_KEY: fixture().env.RELEASE_SIGNING_PRIVATE_KEY,
      }),
    /does not match/
  );
  assert.throws(
    () => nativeUpdateLinkerFlags({ RELEASE_SIGNING_PUBLIC_KEYS: '{"release":"invalid"}' }),
    /Invalid/
  );
  for (const id of ['', '../invalid', 'x'.repeat(65), 'unknown']) {
    assert.throws(() => nativeUpdateSigningKey({ ...env, RELEASE_SIGNING_KEY_ID: id }));
  }
  assert.equal(nativeUpdateSigningKeyID(env), 'release-2026-11-17');
});

test('native update key rotation retains old pins and signs with the selected key ID', () => {
  const first = fixture();
  const next = fixture();
  const env = {
    ...next.env,
    RELEASE_SIGNING_KEY_ID: 'release-next',
    RELEASE_SIGNING_PUBLIC_KEYS: JSON.stringify({
      ...nativeUpdateKeys(first.env),
      'release-next': nativeUpdateKeys(next.env)['release-2026-11-17'],
    }),
  };
  const oldFeed = signNativeUpdateFeed(undefined, first.release, first.env);
  const previous = readNativeUpdateFeed(oldFeed, env);
  const newFeed = signNativeUpdateFeed(previous, undefined, env);
  assert.equal(readNativeUpdateFeed(newFeed, env).sequence, 2);
  assert.throws(() => readNativeUpdateFeed(newFeed, first.env), /signature/);
});
