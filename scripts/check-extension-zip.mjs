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

const zipPath = await findExtensionZip();
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
 * @returns {Promise<string>}
 */
async function findExtensionZip() {
  const names = await fs.promises.readdir(distDir);
  const candidates = names
    .filter((name) => /^browser-bridge-extension-v.+\.zip$/.test(name))
    .sort();

  if (candidates.length === 0) {
    throw new Error(
      `No Browser Bridge extension ZIP found in ${distDir}. Run npm run package:extension first.`
    );
  }

  return path.join(distDir, candidates[candidates.length - 1]);
}

/**
 * @param {string} archivePath
 * @returns {Promise<string[]>}
 */
async function listZipEntries(archivePath) {
  const { stdout } = await execFileAsync('zipinfo', ['-1', archivePath], {
    cwd: repoRoot,
  });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith('/'))
    .sort();
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
