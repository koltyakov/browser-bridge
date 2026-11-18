import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';
import {
  createZipArchive,
  readZipEntry,
  haveSameZipContents,
} from '../../../scripts/extension-zip.mjs';
import { withDifferentZipMetadata } from '../../_helpers/zipMetadata.js';

const exec = promisify(execFile);

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bbx-zip-'quoted-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source with long directory name');
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

test('extension ZIP bytes ignore file times, permissions, creation order and source location', async (t) => {
  const { source, archive } = await fixture(t);
  await fs.writeFile(path.join(source, '日本語.txt'), 'Unicode payload 🧪');
  await createZipArchive(source, archive);
  const first = await fs.readFile(archive);
  const other = path.join(path.dirname(source), 'another source');
  for (const name of ['日本語.txt', 'src/build-info.js', 'manifest.json']) {
    const filename = path.join(other, name);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.copyFile(path.join(source, name), filename);
    await fs.utimes(filename, new Date('2020-01-01'), new Date('2025-06-01'));
    await fs.chmod(filename, 0o755);
  }
  await createZipArchive(other, archive);
  assert.deepEqual(await fs.readFile(archive), first);
  const legacy = withDifferentZipMetadata(first);
  assert.notDeepEqual(legacy, first);
  assert(haveSameZipContents(first, legacy));
  await fs.writeFile(path.join(other, 'manifest.json'), '{"version":"different"}');
  await createZipArchive(other, archive);
  assert(!haveSameZipContents(first, await fs.readFile(archive)));
});

test('extension ZIP comparison rejects ambiguous, unsafe, oversized and corrupt archives', async (t) => {
  const { source, archive } = await fixture(t);
  await fs.writeFile(path.join(source, 'aa.txt'), 'first');
  await fs.writeFile(path.join(source, 'bb.txt'), 'second');
  await createZipArchive(source, archive);
  const original = await fs.readFile(archive);
  const central = original.readUInt32LE(original.length - 22 + 16);
  for (const mutate of [
    (bytes: Buffer) => bytes.writeUInt16LE(1, central + 8), // Encryption.
    (bytes: Buffer) => bytes.writeUInt32LE((0xa000 << 16) >>> 0, central + 38), // Symlink.
    (bytes: Buffer) => bytes.writeUInt32LE(64 * 1024 * 1024 + 1, central + 24),
    (bytes: Buffer) => bytes.writeUInt32LE(0, central + 16), // Wrong CRC.
    (bytes: Buffer) => bytes.writeUInt16LE(99, central + 10), // Unsupported compression.
    (bytes: Buffer) => bytes.writeUInt32LE(0, central), // Broken directory record.
    (bytes: Buffer) => {
      const local = bytes.readUInt32LE(central + 42);
      bytes.writeUInt32LE(0, local + 22); // Conflicting local uncompressed size.
    },
    (bytes: Buffer) => {
      const local = bytes.readUInt32LE(central + 42);
      bytes.writeUInt16LE(0x0808, central + 8);
      bytes.writeUInt16LE(0x0808, local + 6); // Claims a missing data descriptor.
    },
    (bytes: Buffer) => {
      const second = central + 46 + bytes.readUInt16LE(central + 28);
      const local = bytes.readUInt32LE(second + 42);
      bytes.write('aa.txt', second + 46);
      bytes.write('aa.txt', local + 30);
    },
    (bytes: Buffer) => {
      const local = bytes.readUInt32LE(central + 42);
      bytes.write('../bad', central + 46);
      bytes.write('../bad', local + 30);
    },
  ]) {
    const bytes = Buffer.from(original);
    mutate(bytes);
    assert(
      !haveSameZipContents(bytes, bytes),
      'invalid ZIPs must not compare equal even to themselves'
    );
  }
  for (const bytes of [Buffer.alloc(0), Buffer.from('not a ZIP'), original.subarray(0, -1)])
    assert(!haveSameZipContents(original, bytes));
});

test(
  'extension ZIP comparison accepts legacy Unix packer directory records and timestamp extras',
  {
    skip: process.platform === 'win32',
  },
  async (t) => {
    const { source, archive } = await fixture(t);
    await createZipArchive(source, archive);
    const original = await fs.readFile(archive);
    const legacy = path.join(path.dirname(archive), 'legacy.zip');
    await exec('zip', ['-q', '-r', legacy, '.'], { cwd: source });
    assert(haveSameZipContents(original, await fs.readFile(legacy)));
  }
);

test('extension ZIP comparison validates streamed data descriptors with or without signatures', async (t) => {
  const { source, archive } = await fixture(t);
  await fs.unlink(path.join(source, 'src/build-info.js'));
  await createZipArchive(source, archive);
  const original = await fs.readFile(archive);
  const end = original.length - 22;
  const central = original.readUInt32LE(end + 16);
  assert.equal(original.readUInt16LE(end + 10), 1);
  for (const signature of [false, true]) {
    const descriptor = Buffer.alloc(signature ? 16 : 12);
    const offset = signature ? 4 : 0;
    if (signature) descriptor.writeUInt32LE(0x08074b50, 0);
    original.copy(descriptor, offset, central + 16, central + 28);
    const streamed = Buffer.concat([
      original.subarray(0, central),
      descriptor,
      original.subarray(central),
    ]);
    streamed.writeUInt16LE(0x0808, 6);
    streamed.fill(0, 14, 26);
    streamed.writeUInt16LE(0x0808, central + descriptor.length + 8);
    streamed.writeUInt32LE(central + descriptor.length, end + descriptor.length + 16);
    assert(haveSameZipContents(original, streamed));
    await fs.writeFile(archive, streamed);
    assert.equal((await readZipEntry(archive, 'manifest.json')).trimEnd(), '{"version":"2.1.0"}');
    streamed.writeUInt32LE(0, central + offset);
    assert(!haveSameZipContents(streamed, streamed));
  }
});

test(
  'extension ZIP creation rejects symlinks instead of following untracked content',
  {
    skip: process.platform === 'win32',
  },
  async (t) => {
    const { source, archive } = await fixture(t);
    await fs.symlink(path.join(source, 'manifest.json'), path.join(source, 'linked.json'));
    await assert.rejects(createZipArchive(source, archive), /requires regular files/);
    await fs.unlink(path.join(source, 'linked.json'));
    await fs.writeFile(path.join(source, 'back\\slash.txt'), 'not portable');
    await assert.rejects(createZipArchive(source, archive), /Nonportable/);
  }
);

test(
  'Windows ZIP writer preserves entry names when the source uses a DOS short-path alias',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { source, archive } = await fixture(t);
    const escaped = source.replace(/'/g, "''");
    const { stdout } = await exec('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$ErrorActionPreference = 'Stop'; (New-Object -ComObject Scripting.FileSystemObject).GetFolder('${escaped}').ShortPath`,
    ]);
    const shortSource = stdout.trim();
    assert(shortSource.length > 0);
    if (shortSource === source) {
      t.skip('DOS short-path aliases are not enabled on this volume');
      return;
    }
    await createZipArchive(shortSource, archive);
    assert.equal((await readZipEntry(archive, 'manifest.json')).trimEnd(), '{"version":"2.1.0"}');
    assert.equal(
      (await readZipEntry(archive, 'src/build-info.js')).trimEnd(),
      'export const DEVELOPMENT_AUTO_RELOAD = false;'
    );
  }
);

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
