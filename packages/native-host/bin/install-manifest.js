#!/usr/bin/env node
// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_NAME, getBridgeDir, getManifestInstallDir } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const hostPath = path.join(repoRoot, 'packages', 'native-host', 'bin', 'native-host.js');
const launcherPath = path.join(getBridgeDir(), 'native-host-launcher.sh');
const installDir = getManifestInstallDir();
const manifestPath = path.join(installDir, `${APP_NAME}.json`);
const nodePath = process.execPath;
const placeholderOrigin = 'chrome-extension://__REPLACE_WITH_EXTENSION_ID__/';

const launcher = `#!/bin/sh
exec '${escapeSingleQuotes(nodePath)}' '${escapeSingleQuotes(hostPath)}' "$@"
`;

const existingManifest = await readExistingManifest(manifestPath);
const allowedOrigins = getAllowedOrigins(existingManifest);

/** @type {{name: string, description: string, path: string, type: 'stdio', allowed_origins: string[]}} */
const manifest = {
  name: APP_NAME,
  description: 'Browser Bridge native host',
  path: launcherPath,
  type: 'stdio',
  allowed_origins: allowedOrigins
};

await fs.promises.mkdir(installDir, { recursive: true });
await fs.promises.mkdir(getBridgeDir(), { recursive: true });
await fs.promises.writeFile(launcherPath, launcher, 'utf8');
await fs.promises.chmod(launcherPath, 0o755);
await fs.promises.writeFile(
  manifestPath,
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8'
);

process.stdout.write(`Wrote ${manifestPath}\n`);
process.stdout.write(`Wrote ${launcherPath}\n`);
if (allowedOrigins.includes(placeholderOrigin)) {
  process.stdout.write('Replace __REPLACE_WITH_EXTENSION_ID__ with the installed extension id before using Chrome Native Messaging.\n');
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeSingleQuotes(value) {
  return value.replaceAll("'", "'\\''");
}

/**
 * @param {string} filePath
 * @returns {Promise<{allowed_origins?: string[]} | null>}
 */
async function readExistingManifest(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {{allowed_origins?: string[]} | null} existingManifest
 * @returns {string[]}
 */
function getAllowedOrigins(existingManifest) {
  if (existingManifest && Array.isArray(existingManifest.allowed_origins) && existingManifest.allowed_origins.length > 0) {
    return existingManifest.allowed_origins;
  }
  return [placeholderOrigin];
}
