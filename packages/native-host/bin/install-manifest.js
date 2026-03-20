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

const extensionIdArg = parseExtensionId(process.argv[2]);

const launcher = `#!/bin/sh
exec '${escapeSingleQuotes(nodePath)}' '${escapeSingleQuotes(hostPath)}' "$@"
`;

const existingManifest = await readExistingManifest(manifestPath);
const allowedOrigins = getAllowedOrigins(existingManifest, extensionIdArg);

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

const hasPlaceholder = allowedOrigins.some((o) => o.includes('__REPLACE_WITH_EXTENSION_ID__'));
if (hasPlaceholder) {
  process.stdout.write(
    'Tip: pass the extension ID to set allowed_origins automatically:\n' +
    '  npx bb install <extension-id>\n'
  );
}

/**
 * Parse and validate a Chrome extension ID from a CLI argument.
 * Accepts a raw 32-char ID or a full `chrome-extension://<id>/` origin.
 * @param {string | undefined} arg
 * @returns {string | null} The validated extension ID, or null.
 */
function parseExtensionId(arg) {
  if (!arg) return null;

  // Accept full origin format: chrome-extension://<id>/
  const originMatch = arg.match(/^chrome-extension:\/\/([a-z]{32})\/?$/);
  if (originMatch) return originMatch[1];

  // Accept raw 32-character lowercase ID
  if (/^[a-z]{32}$/.test(arg)) return arg;

  process.stderr.write(`Invalid extension ID: ${arg}\nExpected 32 lowercase letters (e.g. abcdefghijklmnopabcdefghijklmnop)\n`);
  process.exit(1);
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
 * Build the allowed_origins list.
 * If an extension ID was provided, ensures its origin is present.
 * Otherwise falls back to existing origins or a placeholder.
 * @param {{allowed_origins?: string[]} | null} existingManifest
 * @param {string | null} extensionId
 * @returns {string[]}
 */
function getAllowedOrigins(existingManifest, extensionId) {
  const existing = (existingManifest && Array.isArray(existingManifest.allowed_origins))
    ? existingManifest.allowed_origins
    : [];

  if (extensionId) {
    const origin = `chrome-extension://${extensionId}/`;
    // Merge with existing, dedup, and remove placeholder
    const merged = new Set(existing);
    merged.add(origin);
    for (const o of merged) {
      if (o.includes('__REPLACE_WITH_EXTENSION_ID__')) merged.delete(o);
    }
    return [...merged];
  }

  if (existing.length > 0) return existing;
  return ['chrome-extension://__REPLACE_WITH_EXTENSION_ID__/'];
}
