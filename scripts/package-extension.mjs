#!/usr/bin/env node
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { resolveVersion } from './version.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');
const stagingDir = path.join(distDir, 'ext');
const manifestPath = path.join(repoRoot, 'manifest.json');
const buildOnly = process.argv.includes('--build-only');

/** @typedef {{ version: string, version_name?: string, minimum_chrome_version: string, icons?: Record<string, string> }} ExtensionManifest */

const manifest = /** @type {ExtensionManifest} */ (await readJson(manifestPath));
manifest.version = resolveVersion({ root: repoRoot }).version;

await verifyManifestAssets(manifest);
await stageExtension();

const zipPath = path.join(distDir, `browser-bridge-extension-v${manifest.version}.zip`);
if (!buildOnly) await createZipArchive(stagingDir, zipPath);

process.stdout.write(
  `Staged extension v${manifest.version_name ?? manifest.version} at ${stagingDir}\n`
);
if (!buildOnly) process.stdout.write(`Wrote ${zipPath}\n`);

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
    const absolutePath = path.join(repoRoot, 'packages/extension', relativePath);
    await fs.promises.access(absolutePath);
  }
}

/**
 * @returns {Promise<void>}
 */
async function stageExtension() {
  await fs.promises.rm(stagingDir, { recursive: true, force: true });
  await fs.promises.mkdir(stagingDir, { recursive: true });

  await fs.promises.writeFile(
    path.join(stagingDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  /** @type {Record<string, string>} */
  const entryPoints = {};
  for (const outputDirectory of ['src', 'ui']) {
    const directory = path.join('packages/extension', outputDirectory);
    const files = await fs.promises.readdir(path.join(repoRoot, directory));
    if (files.some((file) => file.endsWith('.js'))) {
      throw new Error(`Extension runtime sources must be TypeScript: ${directory}`);
    }
    for (const file of files.filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))) {
      entryPoints[`${outputDirectory}/${path.basename(file, '.ts')}`] = path.join(directory, file);
    }
    for (const file of files.filter((file) => /\.(html|css)$/.test(file))) {
      await copyIntoStage(path.join(directory, file), path.join(outputDirectory, file));
    }
  }
  // Compile shared browser helpers alongside the extension. Type-only protocol
  // imports disappear during compilation and never enter the extension ZIP.
  const protocolDirectory = 'protocol/src';
  const protocolFiles = await fs.promises.readdir(path.join(repoRoot, protocolDirectory));
  if (protocolFiles.some((file) => file.endsWith('.js'))) {
    throw new Error(`Shared protocol sources must be TypeScript: ${protocolDirectory}`);
  }
  for (const file of protocolFiles.filter(
    (file) => file.endsWith('.ts') && !file.endsWith('.d.ts')
  )) {
    entryPoints[`protocol/${path.basename(file, '.ts')}`] = path.join(protocolDirectory, file);
  }
  await build({
    absWorkingDir: repoRoot,
    entryPoints,
    outdir: stagingDir,
    bundle: false,
    plugins: [
      {
        name: 'flatten-protocol-imports',
        setup(builder) {
          builder.onLoad(
            { filter: /packages[\\/]extension[\\/].*\.ts$/ },
            async ({ path: source }) => ({
              // Source imports keep resolving against the repository for tsc.
              // Rewrite before compilation so source maps match the emitted code.
              contents: (await fs.promises.readFile(source, 'utf8')).replaceAll(
                '../../../protocol/src/',
                '../protocol/'
              ),
              loader: 'ts',
            })
          );
        },
      },
    ],
    platform: 'browser',
    target: `chrome${manifest.minimum_chrome_version}`,
    // Keep classic content-script IIFEs classic, and injected functions free
    // of module-level name-preservation helpers when Chrome serializes them.
    keepNames: false,
    sourcemap: buildOnly ? 'linked' : false,
    tsconfigRaw: { compilerOptions: { useDefineForClassFields: true, verbatimModuleSyntax: true } },
  });
  await copyIntoStage(path.join('packages', 'extension', 'assets'), 'assets');
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
  const sourceDigest = hash.digest('hex');
  if (buildOnly) {
    // Hash before adding the derived label so identical builds keep the same ID.
    manifest.version_name = `${manifest.version}-dev.${sourceDigest.slice(0, 8)}`;
    await fs.promises.writeFile(
      path.join(stagingDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
  }
  await fs.promises.writeFile(
    path.join(stagingDir, 'src/build-info.js'),
    `// @ts-check\n/** SHA-256 of sorted staged paths and bytes before generated build metadata. @type {string | null} */\nexport const SOURCE_DIGEST = '${sourceDigest}';\n/** @type {boolean} */\nexport const DEVELOPMENT_AUTO_RELOAD = ${buildOnly};\n`
  );
  if (buildOnly) {
    // Publish last, and atomically, so running workers never reload a partial
    // build. This resource contains no machine-specific paths.
    const stampPath = path.join(stagingDir, 'development-build.json');
    await fs.promises.writeFile(
      `${stampPath}.tmp`,
      `${JSON.stringify({ formatVersion: 1, complete: true, sourceDigest })}\n`
    );
    await fs.promises.rename(`${stampPath}.tmp`, stampPath);
  }
}

/**
 * @param {string} relativePath
 * @param {string} [outputPath]
 * @returns {Promise<void>}
 */
async function copyIntoStage(relativePath, outputPath = relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
  const targetPath = path.join(stagingDir, outputPath);

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
