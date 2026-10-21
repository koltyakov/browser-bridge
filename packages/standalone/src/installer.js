// @ts-check
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  bundled,
  getStandaloneLauncher,
  getStandaloneRoot,
  getVersionExecutable,
  readInstallation,
} from './runtime.js';
import { planMcpMigration } from './migration.js';
import {
  planShellSetup,
  readWindowsUserPath,
  writeWindowsUserPath,
  installWindowsPath,
} from './shell-setup.js';
import { atomicWriteFile } from '../../agent-client/src/atomic-write.js';
import { acquireNpmUpdateLock } from '../../agent-client/src/npm-self-update.js';
import { comparePackageVersions } from '../../agent-client/src/npm-self-update.js';
import { getBridgeConfigPath } from '../../agent-client/src/config.js';
import {
  APP_NAME,
  getManifestInstallDir,
  SUPPORTED_BROWSERS,
} from '../../native-host/src/config.js';
import {
  installNativeManifest,
  getWindowsRegistryKey,
  escapeSingleQuotes,
} from '../../native-host/src/install-manifest.js';
import { restartBridgeDaemonIfRunning } from '../../native-host/src/daemon-process.js';

const execFileAsync = promisify(execFile);

/** @param {string} filename @returns {Promise<Buffer | null>} */
async function readOptional(filename) {
  try {
    return await fs.readFile(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** @param {string} filename @returns {Promise<boolean>} */
async function exists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** @param {string} source @param {string} destination @returns {Promise<void>} */
async function copyExecutable(source, destination) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await fs.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
    await fs.chmod(temporary, 0o755);
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * Install side by side, preserve user state, and switch existing entrypoints.
 * The stable launcher never replaces a running Windows executable.
 * @param {{ source?: string, version?: string, restart?: boolean, projects?: string[], allowDowngrade?: boolean, beforeActivate?: () => Promise<void> }} [options]
 * @returns {Promise<void>}
 */
export async function installCompanion(options = {}) {
  if (!bundled) throw new Error('Run setup from the downloaded Browser Bridge executable.');
  const version = options.version ?? bundled.version;
  const source = options.source ?? process.execPath;
  const root = getStandaloneRoot();
  const release = await acquireNpmUpdateLock(root);
  try {
    const launcher = getStandaloneLauncher();
    const executable = getVersionExecutable(version);
    const statePath = path.join(root, 'installation.json');
    const previous = readInstallation();
    if (
      previous &&
      comparePackageVersions(version, previous.version) < 0 &&
      !options.allowDowngrade
    )
      throw new Error(
        'A newer companion is already installed. Use that version, or run bbx rollback to return to the previous version.'
      );
    const managePath = process.env.BBX_NO_PATH === '1' ? false : (previous?.managePath ?? true);
    const edits = [
      ...(await planMcpMigration(launcher, options.projects)),
      ...(managePath ? await planShellSetup() : []),
    ];
    const manageWindowsPath = process.platform === 'win32' && managePath;
    const windowsPath = manageWindowsPath ? await readWindowsUserPath() : null;
    const { stdout } = await execFileAsync(source, ['--self-test'], { timeout: 30_000 });
    const candidate = JSON.parse(stdout);
    if (candidate.version !== version || candidate.target !== bundled.target)
      throw new Error('Companion self-test failed: wrong version or platform.');
    await fs.mkdir(path.dirname(executable), { recursive: true });
    if (!(await exists(executable))) {
      await copyExecutable(source, executable);
    } else if (path.resolve(source) !== path.resolve(executable)) {
      const digest = (/** @type {Buffer} */ bytes) =>
        createHash('sha256').update(bytes).digest('hex');
      if (digest(await fs.readFile(source)) !== digest(await fs.readFile(executable)))
        throw new Error(
          'This version is already installed with different contents. Publish a new version instead of replacing a running executable.'
        );
    }
    if (!(await exists(launcher))) {
      await copyExecutable(executable, launcher);
    }
    for (const [alias, args] of Object.entries({
      'bbx-mcp': 'mcp serve',
      'bbx-daemon': '--bridge-daemon',
      'bbx-install': 'install',
    })) {
      const windows = process.platform === 'win32';
      const contents = windows
        ? `@"%~dp0bbx.exe" ${args} %*\r\n`
        : `#!/bin/sh\nexec '${escapeSingleQuotes(launcher)}' ${args} "$@"\n`;
      await atomicWriteFile(path.join(root, `${alias}${windows ? '.cmd' : ''}`), contents, {
        mode: 0o755,
      });
    }
    /** @type {Map<string, Buffer | null>} */
    const backups = new Map();
    backups.set(statePath, await readOptional(statePath));
    for (const edit of edits)
      backups.set(edit.path, edit.before === null ? null : Buffer.from(edit.before));
    const configPath = getBridgeConfigPath();
    const configBefore = await readOptional(configPath);
    if (!configBefore) backups.set(configPath, null);
    // Register Chrome and detected browser installations, preserving existing origins.
    const browsers = new Set(
      /** @type {import('../../native-host/src/config.js').SupportedBrowser[]} */ (['chrome'])
    );
    for (const browser of SUPPORTED_BROWSERS) {
      const manifest = path.join(getManifestInstallDir(browser), `${APP_NAME}.json`);
      const existing = await readOptional(manifest);
      if (existing || (await exists(path.dirname(getManifestInstallDir(browser)))))
        browsers.add(browser);
      if (browsers.has(browser)) backups.set(manifest, existing);
    }
    /** @type {Map<string, string | null>} */
    const registry = new Map();
    if (process.platform === 'win32') {
      for (const browser of browsers) {
        const key = getWindowsRegistryKey(browser);
        try {
          const { stdout } = await execFileAsync('reg.exe', ['query', key, '/ve']);
          registry.set(key, /REG_SZ\s+(.+)/.exec(stdout)?.[1].trim() ?? null);
        } catch (error) {
          // Exit code 1 is the normal missing-key result. Other failures must not
          // make us overwrite a registration we could not inspect.
          if (error.code !== 1) throw error;
          registry.set(key, null);
        }
      }
    }
    const backupDir = path.join(root, 'backups', `${Date.now()}-${process.pid}`);
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(
      path.join(backupDir, 'files.json'),
      JSON.stringify(
        [...backups].map(([filename, content]) => ({
          path: filename,
          content: content?.toString('base64') ?? null,
        })),
        null,
        2
      ),
      { mode: 0o600 }
    );
    const applied = new Set();
    let windowsPathChanged = false;
    try {
      await options.beforeActivate?.();
      // State commits first so every new native/MCP process resolves the installed payload.
      await atomicWriteFile(
        statePath,
        `${JSON.stringify({ version, managePath, previousVersion: previous?.version === version ? previous.previousVersion : previous?.version, blockedVersion: options.allowDowngrade ? previous?.version : previous?.blockedVersion })}\n`,
        { mode: 0o600 }
      );
      applied.add(statePath);
      for (const browser of browsers) {
        applied.add(path.join(getManifestInstallDir(browser), `${APP_NAME}.json`));
        await installNativeManifest({
          repoRoot: '',
          browser,
          executablePath: launcher,
          preserveAllowedOrigins: true,
          stdout: { write: () => true },
        });
      }
      for (const edit of edits) {
        if (((await readOptional(edit.path))?.toString('utf8') ?? null) !== edit.before)
          throw new Error(`Agent settings changed during setup: ${edit.path}. Run setup again.`);
        await atomicWriteFile(edit.path, edit.after, { encoding: 'utf8' });
        applied.add(edit.path);
      }
      if (!configBefore) {
        await atomicWriteFile(configPath, `${JSON.stringify({ autoUpdate: 'compatible' })}\n`, {
          mode: 0o600,
        });
        applied.add(configPath);
      }
      if (manageWindowsPath) {
        await installWindowsPath(windowsPath);
        windowsPathChanged = true;
      }
      if (options.restart !== false) await restartBridgeDaemonIfRunning();
    } catch (error) {
      if (windowsPathChanged) await writeWindowsUserPath(windowsPath);
      for (const [filename, content] of backups) {
        if (!applied.has(filename)) continue;
        if (content === null) await fs.rm(filename, { force: true });
        else await atomicWriteFile(filename, content);
      }
      for (const [key, value] of registry) {
        if (value !== null)
          await execFileAsync('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f']);
        else await execFileAsync('reg.exe', ['delete', key, '/f']).catch(() => {});
      }
      if (options.restart !== false && previous)
        await restartBridgeDaemonIfRunning().catch(() => {});
      throw error;
    }
    process.stdout.write(
      `Browser Bridge ${version} is installed.\nYour settings and existing agent connections have been kept.\nReturn to the extension to connect your agent and enable window access.\n${edits.length || manageWindowsPath ? 'Restart existing terminals and connected agents once to use the new companion.\n' : ''}`
    );
  } finally {
    await release();
  }
}
