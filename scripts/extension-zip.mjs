// @ts-check
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** @param {string} value @returns {string} */
function powerShellLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Create a portable ZIP with forward-slash entry names on every platform.
 * @param {string} sourceDir
 * @param {string} targetZipPath
 * @returns {Promise<void>}
 */
export async function createZipArchive(sourceDir, targetZipPath) {
  await fs.rm(targetZipPath, { force: true });
  if (process.platform === 'win32') {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.IO.Compression',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `$source = ${powerShellLiteral(path.resolve(sourceDir))}`,
      `$zip = [System.IO.Compression.ZipFile]::Open(${powerShellLiteral(path.resolve(targetZipPath))}, [System.IO.Compression.ZipArchiveMode]::Create)`,
      // Relative names do not depend on PowerShell preserving DOS short-path aliases.
      'try { Get-ChildItem -LiteralPath $source -Recurse -File -Force -Name | ForEach-Object { $entry = $_.Replace([char]92, [char]47); $file = Join-Path -Path $source -ChildPath $_; [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file, $entry, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null } } finally { $zip.Dispose() }',
    ].join('; ');
    await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command]);
    return;
  }
  await execFileAsync('zip', ['-q', '-r', path.resolve(targetZipPath), '.'], {
    cwd: sourceDir,
  });
}

/** Read standard entries and legacy Windows ZIPs whose names contain backslashes.
 * @param {string} archivePath
 * @param {string} entry
 * @returns {Promise<string>}
 */
export async function readZipEntry(archivePath, entry) {
  if (process.platform === 'win32') {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.IO.Compression',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `$zip = [System.IO.Compression.ZipFile]::OpenRead(${powerShellLiteral(archivePath)})`,
      `try { $entries = @($zip.Entries | Where-Object { $_.FullName.Replace([char]92, [char]47) -ceq ${powerShellLiteral(entry)} }); if ($entries.Count -ne 1) { throw 'Expected exactly one matching ZIP entry' }; $reader = [System.IO.StreamReader]::new($entries[0].Open()); try { $reader.ReadToEnd() } finally { $reader.Dispose() } } finally { $zip.Dispose() }`,
    ].join('; ');
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-Command',
      command,
    ]);
    return stdout;
  }
  const { stdout } = await execFileAsync('unzip', ['-p', archivePath, entry]);
  return stdout;
}
