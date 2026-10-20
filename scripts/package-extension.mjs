#!/usr/bin/env node
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

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
  await copyIntoStage(path.join('packages', 'protocol', 'src'));
  await copyIntoStage(path.join('packages', 'extension', 'src'));
  await copyIntoStage(path.join('packages', 'extension', 'ui'));
  await copyIntoStage(path.join('packages', 'extension', 'assets'));
  await copyIntoStage('LICENSE');
  const hash = createHash('sha256');
  /** @param {string} directory */
  async function hashDirectory(directory) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await hashDirectory(filename);
      else {
        const relative = path.relative(stagingDir, filename).split(path.sep).join('/');
        const bytes = await fs.promises.readFile(filename);
        hash.update(`${relative}\0${bytes.length}\0`).update(bytes);
      }
    }
  }
  await hashDirectory(stagingDir);
  await fs.promises.writeFile(
    path.join(stagingDir, 'packages/extension/src/build-info.js'),
    `// @ts-check\n/** SHA-256 of sorted staged paths and bytes before this generated stamp. @type {string | null} */\nexport const SOURCE_DIGEST = '${hash.digest('hex')}';\n`
  );
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
    const escapedTargetZipPath = targetZipPath.replace(/'/g, "''");
    await execFileAsync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path * -DestinationPath '${escapedTargetZipPath}' -Force`,
      ],
      { cwd: sourceDir }
    );
    return;
  }

  await execFileAsync('zip', ['-q', '-r', targetZipPath, '.'], {
    cwd: sourceDir,
  });
}
