// @ts-check
import { createPublicKey, sign, verify } from 'node:crypto';
import {
  nativeUpdateKeys,
  nativeUpdateSigningKey,
  nativeUpdateSigningKeyID,
} from './native-update-config.mjs';

/** @typedef {{url: string, sha256: string, size: number}} UpdateArtifact */
/** @typedef {{version: string, protocolMajor: number, artifacts: Record<string, UpdateArtifact>}} UpdateRelease */
/** @typedef {{schemaVersion: number, channel: string, sequence: number, issuedAt: string, expiresAt: string, releases: UpdateRelease[]}} UpdateManifest */
/** @typedef {{signed: string, signatures: {keyId: string, signature: string}[]}} UpdateEnvelope */

/** Authenticate the previous feed before retaining any artifact URLs or hashes.
 * @param {string} raw @param {NodeJS.ProcessEnv} [env] @returns {UpdateManifest}
 */
export function readNativeUpdateFeed(raw, env = process.env) {
  const keys = nativeUpdateKeys(env);
  const envelope = /** @type {UpdateEnvelope} */ (JSON.parse(raw));
  const bytes = Buffer.from(envelope.signed, 'base64');
  const authenticated = envelope.signatures.some((entry) => {
    if (!keys[entry.keyId]) return false;
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(keys[entry.keyId], 'base64'),
      ]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, bytes, key, Buffer.from(entry.signature, 'base64'));
  });
  if (!authenticated) throw new Error('Previous native update feed failed signature verification');
  const manifest = /** @type {UpdateManifest} */ (JSON.parse(bytes.toString('utf8')));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.channel !== 'stable' ||
    !Number.isSafeInteger(manifest.sequence) ||
    manifest.sequence < 1 ||
    !Array.isArray(manifest.releases) ||
    manifest.releases.length > 128
  )
    throw new Error('Invalid previous native update manifest');
  return manifest;
}

/** @param {UpdateManifest | undefined} previous
 * @param {UpdateRelease | undefined} release
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Date} [now]
 * @returns {string}
 */
export function signNativeUpdateFeed(previous, release, env = process.env, now = new Date()) {
  const key = nativeUpdateSigningKey(env);
  const releases = [...(previous?.releases || [])];
  if (release) {
    const existing = releases.find((entry) => entry.version === release.version);
    if (existing && JSON.stringify(existing) !== JSON.stringify(release))
      throw new Error('Refusing to change an immutable signed native release');
    if (!existing) releases.push(release);
  }
  if (releases.length === 0) throw new Error('No native releases to sign');
  releases.sort((left, right) => {
    const a = left.version.split('.').map(BigInt);
    const b = right.version.split('.').map(BigInt);
    for (let index = 0; index < 3; index++) {
      if (a[index] !== b[index]) return a[index] > b[index] ? -1 : 1;
    }
    return 0;
  });
  const sequence = (previous?.sequence || 0) + 1;
  if (!Number.isSafeInteger(sequence)) throw new Error('Native update feed sequence overflow');
  const signed = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      channel: 'stable',
      sequence,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      releases: releases.slice(0, 128),
    })
  );
  return JSON.stringify({
    signed: signed.toString('base64'),
    signatures: [
      {
        keyId: nativeUpdateSigningKeyID(env),
        signature: sign(null, signed, key).toString('base64'),
      },
    ],
  });
}
