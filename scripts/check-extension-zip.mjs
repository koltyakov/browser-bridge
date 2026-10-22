#!/usr/bin/env node
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveVersion } from './version.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');
const { version } = resolveVersion({ root: repoRoot });
const zipPath = path.join(distDir, `browser-bridge-extension-v${version}.zip`);
const entries = await listZipEntries(zipPath);

const unexpectedEntries = entries.filter((entry) => !isAllowedEntry(entry));
if (unexpectedEntries.length > 0) {
  throw new Error(
    `Unexpected files in ${path.basename(zipPath)}:\n${unexpectedEntries.map((entry) => `- ${entry}`).join('\n')}`
  );
}

for (const requiredEntry of [
  'manifest.json',
  'LICENSE',
  'src/background.js',
  'src/build-info.js',
  'src/content-script.js',
  'ui/sidepanel.html',
  'ui/sidepanel.js',
  'protocol/index.js',
]) {
  if (!entries.includes(requiredEntry)) {
    throw new Error(`Missing required file in ${path.basename(zipPath)}: ${requiredEntry}`);
  }
}

const buildInfo = await readZipEntry(zipPath, 'src/build-info.js');
const packedManifest = /** @type {unknown} */ (
  JSON.parse(await readZipEntry(zipPath, 'manifest.json'))
);
if (
  !packedManifest ||
  typeof packedManifest !== 'object' ||
  !('version' in packedManifest) ||
  packedManifest.version !== version
) {
  throw new Error(`Extension ZIP version must match ${version}.`);
}
if (!/^export const DEVELOPMENT_AUTO_RELOAD = false;$/m.test(buildInfo)) {
  throw new Error('Release extension ZIP must disable development auto-reload.');
}
if ('version_name' in packedManifest && packedManifest.version_name !== version) {
  throw new Error('Release extension ZIP must not include a development version suffix.');
}

process.stdout.write(`Validated ${path.basename(zipPath)}\n`);
for (const entry of entries) {
  process.stdout.write(`${entry}\n`);
}

/**
 * @param {string} archivePath
 * @param {string} entry
 * @returns {Promise<string>}
 */
async function readZipEntry(archivePath, entry) {
  if (process.platform === 'win32') {
    const escapedArchivePath = archivePath.replace(/'/g, "''");
    const escapedEntry = entry.replace(/'/g, "''");
    const command = [
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `$zip = [System.IO.Compression.ZipFile]::OpenRead('${escapedArchivePath}')`,
      `try { $reader = [System.IO.StreamReader]::new($zip.GetEntry('${escapedEntry}').Open()); try { $reader.ReadToEnd() } finally { $reader.Dispose() } } finally { $zip.Dispose() }`,
    ].join('; ');
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-Command',
      command,
    ]);
    return stdout;
  }
  const { stdout } = await execFileAsync('unzip', ['-p', archivePath, entry]);
  return stdout;
}

/**
 * @param {string} archivePath
 * @returns {Promise<string[]>}
 */
async function listZipEntries(archivePath) {
  try {
    await fs.promises.access(archivePath);

    if (process.platform === 'win32') {
      return await listZipEntriesWithPowerShell(archivePath);
    }

    const { stdout } = await execFileAsync('zipinfo', ['-1', archivePath], {
      cwd: repoRoot,
    });
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.endsWith('/'))
      .sort();
  } catch (error) {
    if (isMissingArchiveError(error)) {
      const expectedName = path.basename(archivePath);
      throw new Error(
        `No Browser Bridge extension ZIP found at ${archivePath}. Run npm run package:extension first to create ${expectedName}.`
      );
    }

    throw error;
  }
}

/**
 * @param {string} archivePath
 * @returns {Promise<string[]>}
 */
async function listZipEntriesWithPowerShell(archivePath) {
  const escapedArchivePath = archivePath.replace(/'/g, "''");
  const command = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$zip = [System.IO.Compression.ZipFile]::OpenRead('${escapedArchivePath}')`,
    'try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }',
  ].join('; ');

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-Command', command],
    {
      cwd: repoRoot,
    }
  );

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter((line) => line && !line.endsWith('/'))
    .sort();
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingArchiveError(error) {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = typeof error.message === 'string' ? error.message : '';
  if (message.includes('No such file') || message.includes('cannot find or open')) {
    return true;
  }

  const code = Reflect.get(error, 'code');
  return code === 'ENOENT';
}

/**
 * @param {string} entry
 * @returns {boolean}
 */
function isAllowedEntry(entry) {
  if (/\.(?:ts|map)$/.test(entry)) return false;
  return (
    entry === 'manifest.json' ||
    entry === 'LICENSE' ||
    (entry.startsWith('protocol/') && entry.endsWith('.js')) ||
    entry.startsWith('assets/') ||
    (entry.startsWith('src/') && entry.endsWith('.js')) ||
    (entry.startsWith('ui/') && /\.(?:js|html|css)$/.test(entry))
  );
}
