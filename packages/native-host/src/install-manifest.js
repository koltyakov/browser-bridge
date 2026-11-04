// @ts-check

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { atomicWriteFile } from '../../agent-client/src/atomic-write.js';

import {
  APP_NAME,
  BRIDGE_TCP_PORT_ENV,
  DEFAULT_WINDOWS_TCP_PORT,
  getBridgeDir,
  getLauncherFilename,
  getManifestPathCandidates,
  PUBLISHED_EXTENSION_ID,
  SUPPORTED_BROWSERS,
} from './config.js';

export const DEFAULT_EXTENSION_ID_ENV = 'BROWSER_BRIDGE_EXTENSION_ID';
export const BUILT_IN_EXTENSION_ID_SOURCE = 'built_in';
export const INSTALL_NATIVE_MANIFEST_ERROR = 'INSTALL_NATIVE_MANIFEST_FAILED';

const CHROMIUM_SNAP_NATIVE_MESSAGING_RE = /(?:^|[/\\])snap[/\\]chromium[/\\]/;
const CHROMIUM_FLATPAK_NATIVE_MESSAGING_RE =
  /(?:^|[/\\])\.var[/\\]app[/\\]org\.chromium\.Chromium[/\\]/;

/** @typedef {import('./config.js').SupportedBrowser} SupportedBrowser */
/** @typedef {'env' | 'built_in' | 'none' | 'invalid_env'} ExtensionIdSource */
/** @typedef {NodeJS.ErrnoException & { cause?: unknown }} MaybeErrnoError */
/** @typedef {(keyPath: string) => Promise<string | null> | string | null} RegistryValueReader */
/** @typedef {{ env?: NodeJS.ProcessEnv, installDir?: string, bridgeDir?: string, readRegistryValue?: RegistryValueReader }} ManifestPathOptions */

const execFileAsync = promisify(execFile);

/**
 * @returns {string}
 */
function getWindowsRegistryExe() {
  if (process.platform !== 'win32') {
    return 'reg.exe';
  }

  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  return systemRoot ? path.join(systemRoot, 'System32', 'reg.exe') : 'reg.exe';
}

export class NativeManifestInstallError extends Error {
  /**
   * @param {string} targetPath
   * @param {unknown} cause
   */
  constructor(targetPath, cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to install native host files at ${targetPath}: ${detail}`, { cause });
    this.name = 'NativeManifestInstallError';
    this.code = INSTALL_NATIVE_MANIFEST_ERROR;
    this.targetPath = targetPath;
    this.cause = cause;
    this.errnoCode = /** @type {MaybeErrnoError | undefined} */ (cause)?.code;
  }
}

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
 *   preserveCustomExtensionId?: boolean | undefined,
 *   readRegistryValue?: RegistryValueReader,
 *   writeRegistryValue?: ((keyPath: string, value: string) => Promise<void> | void) | undefined,
 *   env?: NodeJS.ProcessEnv
 * }} InstallManifestOptions
 */

/**
 * @typedef {{
 *   browser?: SupportedBrowser | undefined,
 *   installDir?: string | undefined,
 *   bridgeDir?: string | undefined,
 *   removeBridgeDir?: boolean | undefined,
 *   env?: NodeJS.ProcessEnv,
 *   readRegistryValue?: RegistryValueReader,
 *   deleteRegistryKey?: ((keyPath: string) => Promise<boolean> | boolean) | undefined,
 *   stdout?: Pick<NodeJS.WriteStream, 'write'>
 * }} UninstallManifestOptions
 */

/**
 * @param {SupportedBrowser} [browser='chrome']
 * @returns {string}
 */
export function getWindowsRegistryKey(browser = 'chrome') {
  const roots = {
    chrome: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
    edge: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
    brave: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
    chromium: 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
    // Arc is Chromium-based, and no verified Browser Company-specific native
    // messaging registry path is documented in this repo yet.
    arc: 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
  };

  return `${roots[browser] || roots.chrome}\\${APP_NAME}`;
}

/**
 * Read the default REG_SZ value without assuming an English default-value label.
 * Fail closed on registry access errors rather than replacing an unknown registration.
 *
 * @param {string} keyPath
 * @param {(file: string, args: string[]) => Promise<{ stdout: string }>} [execute=execFileAsync]
 * @returns {Promise<string | null>}
 */
export async function readWindowsRegistryValue(keyPath, execute = execFileAsync) {
  try {
    const { stdout } = await execute(getWindowsRegistryExe(), ['query', keyPath, '/ve']);
    const match = /^\s*.+?\s+REG_SZ\s+(.+?)\s*$/mu.exec(stdout);
    if (!match?.[1]) {
      throw new Error(`Native host registry value is not a REG_SZ path: ${keyPath}`);
    }
    return match[1];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unable to find|cannot find|was unable to find/i.test(message)) {
      return null;
    }
    // reg.exe localizes errors and uses the same exit code for missing keys
    // and access failures. Resolve ambiguous errors through the registry API
    // so a non-English fresh install is not mistaken for a permission failure.
    if (/** @type {{ code?: unknown }} */ (error)?.code === 1) {
      const systemRoot = process.env.SystemRoot || process.env.WINDIR;
      const powershell = systemRoot
        ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe';
      const fullKey = keyPath.replace(/^HKCU\\/u, 'HKEY_CURRENT_USER\\').replaceAll("'", "''");
      const command = `$ErrorActionPreference = 'Stop'; ConvertTo-Json -Compress -InputObject ([Microsoft.Win32.Registry]::GetValue('${fullKey}', '', $null))`;
      const { stdout } = await execute(powershell, [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        command,
      ]);
      /** @type {unknown} */
      const value = JSON.parse(stdout.trim());
      if (value === null || (typeof value === 'string' && value.length > 0)) return value;
      throw new Error(`Native host registry value is not a string path: ${keyPath}`);
    }
    throw error;
  }
}

/**
 * Registry registrations take precedence, including custom manifest locations.
 * Without a registration, reuse a legacy file before creating a fresh install.
 * An explicit installDir is an intentional override, primarily used by embedders.
 *
 * @param {SupportedBrowser} [browser]
 * @param {ManifestPathOptions} [options={}]
 * @returns {Promise<string>}
 */
export async function resolveNativeManifestPath(browser, options = {}) {
  if (options.installDir !== undefined) {
    return path.join(options.installDir, `${APP_NAME}.json`);
  }
  const candidates = getManifestPathCandidates(browser, options.env, options.bridgeDir);
  if (process.platform !== 'win32') {
    return candidates[0];
  }
  const registeredPath = await (options.readRegistryValue || readWindowsRegistryValue)(
    getWindowsRegistryKey(browser)
  );
  if (registeredPath) {
    if (!path.win32.isAbsolute(registeredPath)) {
      throw new Error(`Native host registry path must be absolute: ${registeredPath}`);
    }
    return registeredPath;
  }
  return [...candidates].reverse().find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

/**
 * @param {string} keyPath
 * @param {string} value
 * @returns {Promise<void>}
 */
async function writeRegistryValue(keyPath, value) {
  await execFileAsync(getWindowsRegistryExe(), [
    'add',
    keyPath,
    '/ve',
    '/t',
    'REG_SZ',
    '/d',
    value,
    '/f',
  ]);
}

/**
 * @param {string} keyPath
 * @returns {Promise<boolean>}
 */
async function deleteRegistryKey(keyPath) {
  try {
    await execFileAsync(getWindowsRegistryExe(), ['delete', keyPath, '/f']);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unable to find|cannot find|was unable to find/i.test(message)) {
      return false;
    }
    throw error;
  }
}

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
 * @returns {{ extensionId: string | null, source: ExtensionIdSource }}
 */
export function resolveDefaultExtensionId(env = process.env) {
  const candidate = env[DEFAULT_EXTENSION_ID_ENV];
  if (candidate !== undefined) {
    const parsed = parseExtensionId(candidate);
    return {
      extensionId: parsed,
      source: parsed ? 'env' : 'invalid_env',
    };
  }

  return {
    extensionId: PUBLISHED_EXTENSION_ID || null,
    source: PUBLISHED_EXTENSION_ID ? 'built_in' : 'none',
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string | null}
 */
export function getDefaultExtensionId(env = process.env) {
  return resolveDefaultExtensionId(env).extensionId;
}

/**
 * Build the allowed_origins list.
 * If an extension ID was provided, it is the complete allowlist so stale
 * origins from an earlier installation do not retain native-host access.
 * Otherwise falls back to existing origins or a placeholder.
 *
 * @param {{allowed_origins?: string[]} | null} existingManifest
 * @param {string | null} extensionId
 * @returns {string[]}
 */
export function getAllowedOrigins(existingManifest, extensionId) {
  const existing =
    existingManifest && Array.isArray(existingManifest.allowed_origins)
      ? existingManifest.allowed_origins
      : [];

  if (extensionId) {
    const origin = `chrome-extension://${extensionId}/`;
    return [origin];
  }

  if (existing.length > 0) return existing;
  return ['chrome-extension://__REPLACE_WITH_EXTENSION_ID__/'];
}

/**
 * @param {string[] | undefined} allowedOrigins
 * @returns {string[]}
 */
function getExtensionIdsFromAllowedOrigins(allowedOrigins) {
  if (!Array.isArray(allowedOrigins)) {
    return [];
  }

  const ids = new Set();
  for (const origin of allowedOrigins) {
    const match = /^chrome-extension:\/\/([a-z]{32})\/?$/.exec(origin);
    if (match?.[1]) {
      ids.add(match[1]);
    }
  }
  return [...ids];
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
 * @returns {Promise<{name?: string, allowed_origins?: string[]} | null>}
 */
export async function readExistingManifest(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const manifest = JSON.parse(raw);
    return manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : null;
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
    env = process.env,
    installDir: requestedInstallDir,
    bridgeDir = getBridgeDir(env),
    stdout = process.stdout,
    stderr = process.stderr,
    preserveCustomExtensionId = process.platform === 'win32',
    readRegistryValue: readRegistryValueFn = readWindowsRegistryValue,
    writeRegistryValue: writeRegistryValueFn = writeRegistryValue,
  } = options;

  const parsedExtensionId = parseExtensionId(extensionIdArg);
  if (extensionIdArg && !parsedExtensionId) {
    throw new Error(
      `Invalid extension ID: ${extensionIdArg}\nExpected 32 lowercase letters or chrome-extension://<id>/`
    );
  }

  const defaultExtensionId = resolveDefaultExtensionId(env);
  if (!parsedExtensionId && defaultExtensionId.source === 'invalid_env') {
    throw new Error(
      `Invalid ${DEFAULT_EXTENSION_ID_ENV}: ${env[DEFAULT_EXTENSION_ID_ENV]}\nExpected 32 lowercase letters or chrome-extension://<id>/`
    );
  }
  const requestedExtensionId = parsedExtensionId || defaultExtensionId.extensionId;
  const hostPath = path.join(repoRoot, 'packages', 'native-host', 'bin', 'native-host.js');
  const launcherPath = path.join(bridgeDir, getLauncherFilename());
  const manifestPath = await resolveNativeManifestPath(browser, {
    installDir: requestedInstallDir,
    bridgeDir,
    env,
    readRegistryValue: readRegistryValueFn,
  });
  const installDir = path.dirname(manifestPath);

  const launcher =
    process.platform === 'win32'
      ? `@echo off\r\nset ${BRIDGE_TCP_PORT_ENV}=${DEFAULT_WINDOWS_TCP_PORT}\r\n"${nodePath}" "${hostPath}" %*\r\n`
      : `#!/bin/sh
exec '${escapeSingleQuotes(nodePath)}' '${escapeSingleQuotes(hostPath)}' "$@"
`;

  const existingManifest = await readExistingManifest(manifestPath);
  const existingExtensionIds = getExtensionIdsFromAllowedOrigins(existingManifest?.allowed_origins);
  const hasStoreOrigin = existingExtensionIds.includes(PUBLISHED_EXTENSION_ID);
  const customExtensionIds = existingExtensionIds.filter((id) => id !== PUBLISHED_EXTENSION_ID);
  const preservedCustomExtensionId =
    preserveCustomExtensionId &&
    !parsedExtensionId &&
    extensionIdArg == null &&
    defaultExtensionId.source === BUILT_IN_EXTENSION_ID_SOURCE &&
    customExtensionIds.length > 0 &&
    (process.platform === 'win32' || !hasStoreOrigin);
  const allowedOrigins = preservedCustomExtensionId
    ? getAllowedOrigins(existingManifest, null)
    : getAllowedOrigins(existingManifest, requestedExtensionId);
  const extensionId = preservedCustomExtensionId
    ? customExtensionIds[0] || requestedExtensionId
    : requestedExtensionId;

  /** @type {{name: string, description: string, path: string, type: 'stdio', allowed_origins: string[]}} */
  const manifest = {
    name: APP_NAME,
    description: 'Browser Bridge native host',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: allowedOrigins,
  };

  let failingPath = installDir;
  /** @type {Array<{ filePath: string, contents: Buffer | null }>} */
  const backups = [];
  /**
   * @param {string} filePath
   * @param {string} contents
   * @returns {Promise<void>}
   */
  async function writeHostFile(filePath, contents) {
    if (process.platform === 'win32') {
      backups.push({ filePath, contents: await readFileIfExists(filePath) });
      await atomicWriteFile(filePath, contents);
    } else {
      await fs.promises.writeFile(filePath, contents, 'utf8');
    }
  }
  try {
    await fs.promises.mkdir(installDir, { recursive: true });
    failingPath = bridgeDir;
    await fs.promises.mkdir(bridgeDir, { recursive: true });
    failingPath = launcherPath;
    await writeHostFile(launcherPath, launcher);
    if (process.platform !== 'win32') {
      await fs.promises.chmod(launcherPath, 0o755);
    }
    failingPath = manifestPath;
    await writeHostFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (process.platform === 'win32') {
      failingPath = getWindowsRegistryKey(browser);
      await writeRegistryValueFn(getWindowsRegistryKey(browser), manifestPath);
    }
  } catch (error) {
    /** @type {unknown[]} */
    const rollbackErrors = [];
    for (const backup of backups.reverse()) {
      try {
        if (backup.contents === null) {
          await fs.promises.rm(backup.filePath, { force: true });
        } else {
          await atomicWriteFile(backup.filePath, backup.contents);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new NativeManifestInstallError(
        failingPath,
        new AggregateError([error, ...rollbackErrors], 'Native host install and rollback failed')
      );
    }
    throw new NativeManifestInstallError(failingPath, error);
  }

  stdout.write(`Wrote ${manifestPath}\n`);
  stdout.write(`Wrote ${launcherPath}\n`);
  if (process.platform === 'win32') {
    stdout.write(`Registered ${getWindowsRegistryKey(browser)}\n`);
  }

  if (!preservedCustomExtensionId && !parsedExtensionId && extensionIdArg == null && extensionId) {
    if (defaultExtensionId.source === 'env') {
      stdout.write(`Used extension ID from ${DEFAULT_EXTENSION_ID_ENV}.\n`);
    } else if (defaultExtensionId.source === BUILT_IN_EXTENSION_ID_SOURCE) {
      stdout.write('Used built-in Browser Bridge extension ID.\n');
    }
  }

  if (preservedCustomExtensionId) {
    stderr.write(
      `Warning: existing native host manifest keeps custom extension ID ${customExtensionIds.join(', ')} instead of the Browser Bridge store ID ${PUBLISHED_EXTENSION_ID}. Leaving allowed_origins unchanged.\n`
    );
  }

  if (isChromiumSnapManifestInstall(browser, installDir)) {
    stderr.write(
      'Compatibility warning: detected a Linux Chromium snap native messaging path. Strict snap Chromium commonly blocks launching Browser Bridge\'s Node-based native host with AppArmor, which leaves `bbx status` at "Extension: disconnected". Use a non-snap Chromium-based browser such as Google Chrome, Brave, or Edge and run `bbx install --browser <browser>`.\n'
    );
  }

  if (isChromiumFlatpakManifestInstall(browser, installDir)) {
    stderr.write(
      'Compatibility warning: detected a Linux Chromium Flatpak native messaging path. Sandboxed Flatpak Chromium commonly blocks launching Browser Bridge\'s Node-based native host, which leaves `bbx status` at "Extension: disconnected". Use a non-sandboxed Chromium-based browser such as Google Chrome, Brave, or Edge and run `bbx install --browser <browser>`.\n'
    );
  }

  const hasPlaceholder = allowedOrigins.some((origin) =>
    origin.includes('__REPLACE_WITH_EXTENSION_ID__')
  );
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
    extensionId,
  };
}

/**
 * @param {SupportedBrowser | undefined} browser
 * @param {string} installDir
 * @returns {boolean}
 */
function isChromiumSnapManifestInstall(browser, installDir) {
  return browser === 'chromium' && CHROMIUM_SNAP_NATIVE_MESSAGING_RE.test(installDir);
}

/**
 * @param {SupportedBrowser | undefined} browser
 * @param {string} installDir
 * @returns {boolean}
 */
function isChromiumFlatpakManifestInstall(browser, installDir) {
  return browser === 'chromium' && CHROMIUM_FLATPAK_NATIVE_MESSAGING_RE.test(installDir);
}

/**
 * @param {UninstallManifestOptions} [options={}]
 * @returns {Promise<{ manifestPath: string, bridgeDir: string, removedManifest: boolean, removedBridgeDir: boolean }>}
 */
export async function uninstallNativeManifest(options = {}) {
  const {
    browser,
    installDir,
    env = process.env,
    bridgeDir = getBridgeDir(env),
    removeBridgeDir = false,
    deleteRegistryKey: deleteRegistryKeyFn = deleteRegistryKey,
    readRegistryValue: readRegistryValueFn = readWindowsRegistryValue,
    stdout = process.stdout,
  } = options;

  const manifestPath = await resolveNativeManifestPath(browser, {
    installDir,
    bridgeDir,
    env,
    readRegistryValue: readRegistryValueFn,
  });
  const candidates =
    installDir !== undefined ? [manifestPath] : getManifestPathCandidates(browser, env, bridgeDir);
  const registryKeyPath = process.platform === 'win32' ? getWindowsRegistryKey(browser) : null;
  /** @type {string[]} */
  const otherRegistrations = [];
  if (registryKeyPath && installDir === undefined) {
    for (const key of new Set(SUPPORTED_BROWSERS.map((entry) => getWindowsRegistryKey(entry)))) {
      if (key === registryKeyPath) continue;
      const registeredPath = await readRegistryValueFn(key);
      if (registeredPath) otherRegistrations.push(registeredPath);
    }
    // Only remove an externally located manifest when it identifies this host.
    if ((await readExistingManifest(manifestPath))?.name === APP_NAME) {
      candidates.push(manifestPath);
    }
  }

  // Arc and Chromium currently share a registry key. Do not unregister the
  // other browser when its own manifest is the registered target.
  const belongsToOtherBrowser =
    registryKeyPath &&
    installDir === undefined &&
    !getManifestPathCandidates(browser, env, bridgeDir).some((candidate) =>
      sameWindowsPath(candidate, manifestPath)
    ) &&
    SUPPORTED_BROWSERS.some(
      (entry) =>
        entry !== browser &&
        getWindowsRegistryKey(entry) === registryKeyPath &&
        getManifestPathCandidates(entry, env, bridgeDir).some((candidate) =>
          sameWindowsPath(candidate, manifestPath)
        )
    );
  const removedRegistryKey =
    registryKeyPath && !belongsToOtherBrowser ? await deleteRegistryKeyFn(registryKeyPath) : false;
  if (removedRegistryKey && registryKeyPath) {
    stdout.write(`Removed ${registryKeyPath}\n`);
  }

  if (belongsToOtherBrowser) otherRegistrations.push(manifestPath);
  let removedManifest = false;
  for (const candidate of new Set(candidates)) {
    if (otherRegistrations.some((registeredPath) => sameWindowsPath(registeredPath, candidate))) {
      continue;
    }
    if (await removePathIfExists(candidate)) {
      removedManifest = true;
      stdout.write(`Removed ${candidate}\n`);
    }
  }

  const hasOtherManifests =
    process.platform === 'win32' &&
    installDir === undefined &&
    (otherRegistrations.length > 0 ||
      SUPPORTED_BROWSERS.some((entry) =>
        getManifestPathCandidates(entry, env, bridgeDir).some((candidate) =>
          fs.existsSync(candidate)
        )
      ));
  const removedBridgeDir =
    removeBridgeDir && !hasOtherManifests ? await removePathIfExists(bridgeDir) : false;
  if (removedBridgeDir) {
    stdout.write(`Removed ${bridgeDir}\n`);
  }

  return {
    manifestPath,
    bridgeDir,
    removedManifest,
    removedBridgeDir,
  };
}

/** @param {string} left @param {string} right @returns {boolean} */
function sameWindowsPath(left, right) {
  return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

/** @param {string} filePath @returns {Promise<Buffer | null>} */
async function readFileIfExists(filePath) {
  try {
    return await fs.promises.readFile(filePath);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
async function removePathIfExists(targetPath) {
  try {
    await fs.promises.access(targetPath);
  } catch {
    return false;
  }

  try {
    await fs.promises.rm(targetPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    const code = /** @type {{ code?: string } | undefined} */ (error)?.code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
