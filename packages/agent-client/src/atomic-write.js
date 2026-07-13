// @ts-check

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Replace a file through a sibling temporary file so readers never observe a
 * partial write. Existing permissions are preserved unless an explicit mode is
 * requested.
 *
 * @param {string} targetPath
 * @param {string | NodeJS.ArrayBufferView} data
 * @param {{ encoding?: BufferEncoding, mode?: number, preserveMode?: boolean }} [options={ }]
 * @returns {Promise<void>}
 */
export async function atomicWriteFile(targetPath, data, options = {}) {
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  await fs.promises.mkdir(directory, { recursive: true });

  let existingMode;
  if (options.preserveMode !== false && options.mode === undefined) {
    try {
      existingMode = (await fs.promises.stat(targetPath)).mode & 0o777;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  const mode = options.mode ?? existingMode;
  try {
    await fs.promises.writeFile(temporaryPath, data, {
      ...(options.encoding ? { encoding: options.encoding } : {}),
      ...(mode === undefined ? {} : { mode }),
      flag: 'wx',
    });
    if (process.platform !== 'win32' && mode !== undefined) {
      await fs.promises.chmod(temporaryPath, mode);
    }
    try {
      await fs.promises.rename(temporaryPath, targetPath);
    } catch (error) {
      if (process.platform !== 'win32' || !isReplaceError(error)) {
        throw error;
      }
      try {
        await fs.promises.stat(targetPath);
      } catch {
        throw error;
      }

      const backupPath = `${temporaryPath}.backup`;
      await fs.promises.rename(targetPath, backupPath);
      try {
        await fs.promises.rename(temporaryPath, targetPath);
      } catch (replaceError) {
        await fs.promises.rename(backupPath, targetPath).catch(() => {});
        throw replaceError;
      }
      await fs.promises.rm(backupPath, { force: true }).catch(() => {});
    }
    if (process.platform !== 'win32' && options.mode !== undefined) {
      await fs.promises.chmod(targetPath, options.mode);
    }
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Windows does not replace an existing file with rename().
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isReplaceError(error) {
  const code =
    error && typeof error === 'object' ? /** @type {{ code?: unknown }} */ (error).code : null;
  return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES';
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingFileError(error) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    /** @type {{ code?: unknown }} */ (error).code === 'ENOENT'
  );
}
