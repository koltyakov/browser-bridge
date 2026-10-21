// @ts-check
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, verify } from 'node:crypto';
import { bundled, getStandaloneRoot, readInstallation } from './runtime.js';
import { installCompanion } from './installer.js';
import {
  comparePackageVersions,
  parseStableVersion,
} from '../../agent-client/src/npm-self-update.js';
import { atomicWriteFile } from '../../agent-client/src/atomic-write.js';
import { getAutoUpdatePolicy } from '../../agent-client/src/config.js';

const RELEASES = 'https://github.com/koltyakov/browser-bridge/releases';
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
/** @typedef {{ version: string, protocolMajor: number, assets: Record<string, { name: string, sha256: string, size: number }> }} UpdateManifest */

/** @param {string} text @param {string} signature @param {string} publicKey @returns {UpdateManifest} */
export function verifyUpdateManifest(text, signature, publicKey) {
  if (
    !publicKey ||
    !verify(null, Buffer.from(text), publicKey, Buffer.from(signature.trim(), 'base64'))
  )
    throw new Error('Update signature verification failed. The installed version has been kept.');
  const manifest = JSON.parse(text);
  if (
    !parseStableVersion(manifest.version) ||
    !Number.isSafeInteger(manifest.protocolMajor) ||
    !manifest.assets ||
    typeof manifest.assets !== 'object'
  )
    throw new Error('Invalid update manifest.');
  for (const asset of Object.values(manifest.assets)) {
    const value = /** @type {{ name?: unknown, sha256?: unknown, size?: unknown }} */ (asset);
    if (
      typeof value.name !== 'string' ||
      !/^bbx-[a-z0-9-]+(?:\.exe)?$/.test(value.name) ||
      typeof value.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.sha256) ||
      typeof value.size !== 'number' ||
      !Number.isSafeInteger(value.size) ||
      value.size < 1 ||
      value.size > MAX_DOWNLOAD_BYTES
    )
      throw new Error('Invalid update asset.');
  }
  return manifest;
}

/** @param {string} url @param {number} limit @returns {Promise<Buffer>} */
async function download(url, limit) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body)
    throw new Error(`Download failed (${response.status}). Try again when you are online.`);
  const reader = response.body.getReader();
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Update download exceeded its expected size.');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

/** @param {{ restart?: boolean, background?: boolean }} [options] @returns {Promise<boolean>} */
export async function updateCompanion(options = {}) {
  if (!bundled?.updatePublicKey)
    throw new Error(
      'This build has no update signing key. Download a release installer to update.'
    );
  const [bytes, signature] = await Promise.all([
    download(`${RELEASES}/latest/download/companion-update.json`, 64 * 1024),
    download(`${RELEASES}/latest/download/companion-update.sig`, 1024),
  ]);
  const manifest = verifyUpdateManifest(
    bytes.toString('utf8'),
    signature.toString('utf8'),
    bundled.updatePublicKey
  );
  const current = readInstallation()?.version ?? bundled.version;
  if (readInstallation()?.blockedVersion === manifest.version)
    throw new Error(
      'This release was rolled back. Keeping the previous working version until a newer release is available.'
    );
  if (comparePackageVersions(manifest.version, current) <= 0) {
    process.stdout.write('Browser Bridge is up to date.\n');
    return false;
  }
  if (manifest.protocolMajor !== Number(bundled.version.split('.')[0]))
    throw new Error(
      'This update requires a newer browser protocol. Install the matching companion and extension together.'
    );
  const asset = manifest.assets[bundled.target];
  if (!asset) throw new Error('No compatible update is available for this computer.');
  const binary = await download(
    `${RELEASES}/download/v${manifest.version}/${asset.name}`,
    asset.size
  );
  if (
    binary.length !== asset.size ||
    createHash('sha256').update(binary).digest('hex') !== asset.sha256
  )
    throw new Error('Update download verification failed. The installed version has been kept.');
  await fs.mkdir(getStandaloneRoot(), { recursive: true });
  const staging = await fs.mkdtemp(path.join(getStandaloneRoot(), 'update-'));
  try {
    const source = path.join(staging, process.platform === 'win32' ? 'bbx.exe' : 'bbx');
    await fs.writeFile(source, binary, { mode: 0o755 });
    await installCompanion({
      source,
      version: manifest.version,
      restart: options.restart,
      ...(options.background ? { beforeActivate: requireIdleDaemon } : {}),
    });
    return true;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/**
 * The daemon launches this worker only while idle. Persist check times across
 * restarts so each new daemon does not trigger another download.
 * @returns {Promise<void>}
 */
export async function checkAutomaticUpdate() {
  if (!bundled?.updatePublicKey || (await getAutoUpdatePolicy()) !== 'compatible') return;
  const checkedPath = path.join(getStandaloneRoot(), 'update-check.json');
  try {
    const checked = JSON.parse(await fs.readFile(checkedPath, 'utf8'));
    if (Date.now() - checked.at < 24 * 60 * 60 * 1000) return;
  } catch {
    /* First check, or an interrupted write. */
  }
  await atomicWriteFile(checkedPath, JSON.stringify({ at: Date.now() }));
  await updateCompanion({ background: true });
}

/** @returns {Promise<void>} */
async function requireIdleDaemon() {
  const { BridgeClient } = await import('../../agent-client/src/client.js');
  const client = new BridgeClient({
    checkProtocolOnConnect: false,
    restartDaemonOnVersionMismatch: false,
    updateNpmOnCompatibleVersion: false,
  });
  try {
    await client.connect();
    const response = await client.request({ method: 'daemon.metrics', params: {} });
    const metrics = /** @type {{ activeAgents?: number, pendingRequests?: number } | undefined} */ (
      response.result
    );
    // This worker accounts for one agent connection.
    if (!response.ok || metrics?.activeAgents !== 1 || metrics.pendingRequests !== 0)
      throw new Error('An agent connected while the update downloaded. The update will wait.');
  } finally {
    await client.close();
  }
}
