// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import { APP_NAME, getBridgeDir, getManifestInstallDir } from './config.js';

export const DEFAULT_EXTENSION_ID_ENV = 'BROWSER_BRIDGE_EXTENSION_ID';

/** @typedef {import('./config.js').SupportedBrowser} SupportedBrowser */

/**
 * @typedef {{
 *   repoRoot: string,
 *   extensionIdArg?: string | undefined,
 *   browser?: SupportedBrowser | undefined,
 *   nodePath?: string | undefined,
 *   installDir?: string | undefined,
 *   bridgeDir?: string | undefined,
 *   stdout?: Pick<NodeJS.WriteStream, 'write'>,
 *   stderr?: Pick<NodeJS.WriteStream, 'write'>,
 *   env?: NodeJS.ProcessEnv
 * }} InstallManifestOptions
 */

/**
 * Parse and validate a Chrome extension ID from a CLI argument.
 * Accepts a raw 32-char ID or a full `chrome-extension://<id>/` origin.
 *
 * @param {string | undefined} arg
 * @returns {string | null}
 */
export function parseExtensionId(arg) {
  if (!arg) return null;

  const originMatch = arg.match(/^chrome-extension:\/\/([a-z]{32})\/?$/);
  if (originMatch) return originMatch[1];

  if (/^[a-z]{32}$/.test(arg)) return arg;
  return null;
}

/**
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string | null}
 */
export function getDefaultExtensionId(env = process.env) {
  const candidate = env[DEFAULT_EXTENSION_ID_ENV];
  return parseExtensionId(candidate);
}

/**
 * Build the allowed_origins list.
 * If an extension ID was provided, ensures its origin is present.
 * Otherwise falls back to existing origins or a placeholder.
 *
 * @param {{allowed_origins?: string[]} | null} existingManifest
 * @param {string | null} extensionId
 * @returns {string[]}
 */
export function getAllowedOrigins(existingManifest, extensionId) {
  const existing = (existingManifest && Array.isArray(existingManifest.allowed_origins))
    ? existingManifest.allowed_origins
    : [];

  if (extensionId) {
    const origin = `chrome-extension://${extensionId}/`;
    const merged = new Set(existing);
    merged.add(origin);
    for (const item of [...merged]) {
      if (item.includes('__REPLACE_WITH_EXTENSION_ID__')) {
        merged.delete(item);
      }
    }
    return [...merged];
  }

  if (existing.length > 0) return existing;
  return ['chrome-extension://__REPLACE_WITH_EXTENSION_ID__/'];
}

/**
 * @param {string} value
 * @returns {string}
 */
export function escapeSingleQuotes(value) {
  return value.replaceAll("'", "'\\''");
}

/**
 * @param {string} filePath
 * @returns {Promise<{allowed_origins?: string[]} | null>}
 */
export async function readExistingManifest(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {InstallManifestOptions} options
 * @returns {Promise<{ manifestPath: string, launcherPath: string, allowedOrigins: string[], extensionId: string | null }>}
 */
export async function installNativeManifest(options) {
  const {
    repoRoot,
    extensionIdArg,
    browser,
    nodePath = process.execPath,
    installDir = getManifestInstallDir(browser),
    bridgeDir = getBridgeDir(),
    stdout = process.stdout,
    env = process.env
  } = options;

  const parsedExtensionId = parseExtensionId(extensionIdArg);
  if (extensionIdArg && !parsedExtensionId) {
    throw new Error(
      `Invalid extension ID: ${extensionIdArg}\nExpected 32 lowercase letters or chrome-extension://<id>/`
    );
  }

  const defaultExtensionId = getDefaultExtensionId(env);
  const extensionId = parsedExtensionId || defaultExtensionId;
  const hostPath = path.join(repoRoot, 'packages', 'native-host', 'bin', 'native-host.js');
  const launcherPath = path.join(bridgeDir, 'native-host-launcher.sh');
  const manifestPath = path.join(installDir, `${APP_NAME}.json`);

  const launcher = `#!/bin/sh
exec '${escapeSingleQuotes(nodePath)}' '${escapeSingleQuotes(hostPath)}' "$@"
`;

  const existingManifest = await readExistingManifest(manifestPath);
  const allowedOrigins = getAllowedOrigins(existingManifest, extensionId);

  /** @type {{name: string, description: string, path: string, type: 'stdio', allowed_origins: string[]}} */
  const manifest = {
    name: APP_NAME,
    description: 'Browser Bridge native host',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: allowedOrigins
  };

  await fs.promises.mkdir(installDir, { recursive: true });
  await fs.promises.mkdir(bridgeDir, { recursive: true });
  await fs.promises.writeFile(launcherPath, launcher, 'utf8');
  await fs.promises.chmod(launcherPath, 0o755);
  await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  stdout.write(`Wrote ${manifestPath}\n`);
  stdout.write(`Wrote ${launcherPath}\n`);

  if (!parsedExtensionId && extensionIdArg == null && defaultExtensionId) {
    stdout.write(`Used default extension ID from ${DEFAULT_EXTENSION_ID_ENV}.\n`);
  }

  const hasPlaceholder = allowedOrigins.some((origin) => origin.includes('__REPLACE_WITH_EXTENSION_ID__'));
  if (hasPlaceholder) {
    stdout.write(
      'Tip: pass the extension ID to set allowed_origins automatically:\n' +
      '  bbx install <extension-id>\n'
    );
  }

  return {
    manifestPath,
    launcherPath,
    allowedOrigins,
    extensionId
  };
}
