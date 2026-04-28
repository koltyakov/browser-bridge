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
const stagingDir = path.join(distDir, 'browser-bridge-extension');
const manifestPath = path.join(repoRoot, 'manifest.json');

/** @typedef {{ version: string, icons?: Record<string, string> }} ExtensionManifest */

const manifest = /** @type {ExtensionManifest} */ (await readJson(manifestPath));

await verifyManifestAssets(manifest);
await stageExtension();

const zipPath = path.join(distDir, `browser-bridge-extension-v${manifest.version}.zip`);
await createZipArchive(stagingDir, zipPath);

process.stdout.write(`Staged extension at ${stagingDir}\n`);
process.stdout.write(`Wrote ${zipPath}\n`);

/**
 * @param {string} filePath
 * @returns {Promise<unknown>}
 */
async function readJson(filePath) {
  return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
}

/**
 * @param {ExtensionManifest} extensionManifest
 * @returns {Promise<void>}
 */
async function verifyManifestAssets(extensionManifest) {
  const iconPaths = Object.values(extensionManifest.icons || {});
  for (const relativePath of iconPaths) {
    const absolutePath = path.join(repoRoot, relativePath);
    await fs.promises.access(absolutePath);
  }
}

/**
 * @returns {Promise<void>}
 */
async function stageExtension() {
  await fs.promises.rm(stagingDir, { recursive: true, force: true });
  await fs.promises.mkdir(stagingDir, { recursive: true });

  await copyIntoStage('manifest.json');
  await copyIntoStage(path.join('packages', 'extension', 'src'));
  await copyIntoStage(path.join('packages', 'extension', 'ui'));
  await copyIntoStage(path.join('packages', 'extension', 'assets'));
  await copyIntoStage('LICENSE');
}

/**
 * @param {string} relativePath
 * @returns {Promise<void>}
 */
async function copyIntoStage(relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
  const targetPath = path.join(stagingDir, relativePath);

  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.promises.cp(sourcePath, targetPath, { recursive: true });
}

/**
 * @param {string} sourceDir
 * @param {string} targetZipPath
 * @returns {Promise<void>}
 */
async function createZipArchive(sourceDir, targetZipPath) {
  await fs.promises.rm(targetZipPath, { force: true });

  if (process.platform === 'win32') {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        'Compress-Archive -Path * -DestinationPath $args[0] -Force',
        targetZipPath,
      ],
      { cwd: sourceDir }
    );
    return;
  }

  await execFileAsync('zip', ['-q', '-r', targetZipPath, '.'], {
    cwd: sourceDir,
  });
}
