#!/usr/bin/env node
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');
const manifestPath = path.join(repoRoot, 'manifest.json');

/** @typedef {{ version: string }} ExtensionManifest */

const manifest = /** @type {ExtensionManifest} */ (await readJson(manifestPath));
const zipPath = path.join(distDir, `browser-bridge-extension-v${manifest.version}.zip`);
const entries = await listZipEntries(zipPath);

const unexpectedEntries = entries.filter((entry) => !isAllowedEntry(entry));
if (unexpectedEntries.length > 0) {
  throw new Error(
    `Unexpected files in ${path.basename(zipPath)}:\n${unexpectedEntries.map((entry) => `- ${entry}`).join('\n')}`
  );
}

for (const requiredEntry of ['manifest.json', 'LICENSE']) {
  if (!entries.includes(requiredEntry)) {
    throw new Error(`Missing required file in ${path.basename(zipPath)}: ${requiredEntry}`);
  }
}

process.stdout.write(`Validated ${path.basename(zipPath)}\n`);
for (const entry of entries) {
  process.stdout.write(`${entry}\n`);
}

/**
 * @param {string} filePath
 * @returns {Promise<unknown>}
 */
async function readJson(filePath) {
  return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
}

/**
 * @param {string} archivePath
 * @returns {Promise<string[]>}
 */
async function listZipEntries(archivePath) {
  try {
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
  return (
    entry === 'manifest.json' ||
    entry === 'LICENSE' ||
    entry.startsWith('packages/extension/assets/') ||
    entry.startsWith('packages/extension/src/') ||
    entry.startsWith('packages/extension/ui/')
  );
}
