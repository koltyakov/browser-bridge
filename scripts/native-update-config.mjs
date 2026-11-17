// @ts-check
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const nativeUpdateFeedURL =
  'https://github.com/koltyakov/browser-bridge/releases/download/native-updates/stable.json';

/** @param {NodeJS.ProcessEnv} [env] @returns {Record<string, string>} */
export function nativeUpdateKeys(env = process.env) {
  /** @type {unknown} */
  const parsed = JSON.parse(env.BBX_NATIVE_UPDATE_KEYS || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('BBX_NATIVE_UPDATE_KEYS must be a JSON object');
  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.length > 16)
    throw new Error('Configure BBX_NATIVE_UPDATE_KEYS before publishing native updates');
  for (const [id, value] of entries) {
    if (
      !/^[a-zA-Z0-9._-]{1,80}$/.test(id) ||
      typeof value !== 'string' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(value) ||
      Buffer.from(value, 'base64').length !== 32
    )
      throw new Error('Invalid native update Ed25519 public key');
  }
  return /** @type {Record<string, string>} */ (parsed);
}

/** @param {NodeJS.ProcessEnv} [env] @returns {import('node:crypto').KeyObject} */
export function nativeUpdateSigningKey(env = process.env) {
  const keys = nativeUpdateKeys(env);
  const key = createPrivateKey(env.BBX_NATIVE_UPDATE_PRIVATE_KEY || '');
  if (key.asymmetricKeyType !== 'ed25519')
    throw new Error('Native update signing requires an Ed25519 private key');
  const publicBytes = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
  if (keys.release !== publicBytes.toString('base64'))
    throw new Error('Native update signing key does not match the pinned release key');
  return key;
}

/** @param {NodeJS.ProcessEnv} [env] @returns {string} */
export function nativeUpdateLinkerFlags(env = process.env) {
  if (!env.BBX_NATIVE_UPDATE_KEYS) return '';
  const keys = JSON.stringify(nativeUpdateKeys(env));
  const prefix = 'github.com/koltyakov/browser-bridge/internal/bridge';
  return `-X ${prefix}.nativeUpdateFeedURL=${nativeUpdateFeedURL} -X '${prefix}.nativeUpdateKeysJSON=${keys}'`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  nativeUpdateSigningKey();
  console.log('Native update signing configuration verified.');
}
