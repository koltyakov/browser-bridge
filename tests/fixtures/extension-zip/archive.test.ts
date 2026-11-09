import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';
import { createZipArchive, readZipEntry } from '../../../scripts/extension-zip.mjs';

const exec = promisify(execFile);

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bbx-zip-'quoted-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  const archive = path.join(directory, "extension's archive.zip");
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'manifest.json'), '{"version":"2.1.0"}');
  await fs.writeFile(
    path.join(source, 'src/build-info.js'),
    'export const DEVELOPMENT_AUTO_RELOAD = false;'
  );
  return { source, archive };
}

test('extension ZIP round-trips nested portable entries and replaces stale archives', async (t) => {
  const { source, archive } = await fixture(t);
  await fs.writeFile(archive, 'stale archive');
  await createZipArchive(source, archive);
  assert.equal((await readZipEntry(archive, 'manifest.json')).trimEnd(), '{"version":"2.1.0"}');
  assert.equal(
    (await readZipEntry(archive, 'src/build-info.js')).trimEnd(),
    'export const DEVELOPMENT_AUTO_RELOAD = false;'
  );
  if (process.platform === 'win32') {
    const escaped = archive.replace(/'/g, "''");
    const { stdout } = await exec('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::OpenRead('${escaped}'); try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }`,
    ]);
    const entries = stdout.trim().split(/\r?\n/);
    assert(entries.includes('src/build-info.js'));
    assert(entries.every((entry) => !entry.includes('\\')));
  }
  await fs.unlink(path.join(source, 'manifest.json'));
  await createZipArchive(source, archive);
  await assert.rejects(readZipEntry(archive, 'manifest.json'));
});

test(
  'Windows ZIP reader accepts legacy backslash entries and rejects missing or ambiguous entries',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { archive } = await fixture(t);
    const escaped = archive.replace(/'/g, "''");
    const create = async (entries: string[]) => {
      await fs.rm(archive, { force: true });
      const statements = entries.map(
        (entry) =>
          `$writer = [System.IO.StreamWriter]::new($zip.CreateEntry('${entry}').Open()); try { $writer.Write('fixture') } finally { $writer.Dispose() }`
      );
      await exec('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::Open('${escaped}', [System.IO.Compression.ZipArchiveMode]::Create); try { ${statements.join('; ')} } finally { $zip.Dispose() }`,
      ]);
    };
    await create(['src\\build-info.js']);
    assert.equal((await readZipEntry(archive, 'src/build-info.js')).trimEnd(), 'fixture');
    await assert.rejects(readZipEntry(archive, 'src/missing.js'), /exactly one matching ZIP entry/);
    await create(['src\\build-info.js', 'src/build-info.js']);
    await assert.rejects(
      readZipEntry(archive, 'src/build-info.js'),
      /exactly one matching ZIP entry/
    );
  }
);
