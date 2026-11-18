// @ts-check
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const execFileAsync = promisify(execFile);

/** @param {string} value @returns {string} */
function powerShellLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

/** @param {Uint8Array} bytes @returns {number} */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Create a reproducible ZIP: sorted portable names, fixed DOS date, no host
 * permissions, timestamps or extra fields. Release CI pins Node/zlib as well.
 * @param {string} sourceDir
 * @param {string} targetZipPath
 * @returns {Promise<void>}
 */
export async function createZipArchive(sourceDir, targetZipPath) {
  /** @type {string[]} */
  const names = [];
  /** @param {string} directory @returns {Promise<void>} */
  async function walk(directory) {
    for (const entry of await fs.readdir(path.join(sourceDir, directory), {
      withFileTypes: true,
    })) {
      const name = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.name.includes('\\')) throw new Error(`Nonportable ZIP name: ${name}`);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) names.push(name);
      else throw new Error(`Extension ZIP requires regular files: ${name}`);
    }
  }
  await walk('');
  names.sort();
  if (names.length > 65535) throw new Error('Too many extension ZIP entries');
  /** @type {Buffer[]} */
  const local = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  for (const name of names) {
    const filename = Buffer.from(name);
    const data = await fs.readFile(path.join(sourceDir, name));
    const compressed = deflateRawSync(data, { level: 9 });
    if (filename.length > 65535 || data.length > 0xffffffff || offset > 0xffffffff)
      throw new Error('Extension ZIP exceeds standard ZIP limits');
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0x0021, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt16LE(0x0021, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  if (offset + directory.length > 0xffffffff)
    throw new Error('Extension ZIP exceeds standard ZIP limits');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  await fs.writeFile(targetZipPath, Buffer.concat([...local, directory, end]));
}

/** Decode bounded standard ZIPs for content comparison, including old platform
 * packers. Reject duplicates, traversal, symlinks, encryption and corrupt CRCs.
 * Directory records and packaging-only metadata do not change extension code.
 * @param {Buffer} bytes @returns {Map<string, Buffer>}
 */
function zipContents(bytes) {
  const limit = 64 * 1024 * 1024;
  if (bytes.length > limit) throw new Error('Oversized ZIP');
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557)) {
    if (
      bytes.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + bytes.readUInt16LE(end + 20) === bytes.length
    )
      break;
    end--;
  }
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50) throw new Error('Missing ZIP directory');
  const count = bytes.readUInt16LE(end + 10);
  const start = bytes.readUInt32LE(end + 16);
  if (
    bytes.readUInt32LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 8) !== count ||
    count > 4096 ||
    start + bytes.readUInt32LE(end + 12) !== end
  )
    throw new Error('Unsupported ZIP directory');
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  let cursor = start;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error('Invalid ZIP entry');
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const recordLength =
      46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    if (cursor + recordLength > end) throw new Error('Truncated ZIP entry');
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    const parts = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
    const fileType = (bytes.readUInt32LE(cursor + 38) >>> 16) & 0xf000;
    if (
      !Buffer.from(name).equals(nameBytes) ||
      name.includes('\\') ||
      name.includes('\0') ||
      parts.some((part) => !part || part === '.' || part === '..' || part.includes(':')) ||
      seen.has(name) ||
      (flags & ~0x080e) !== 0 ||
      (fileType !== 0 && fileType !== (name.endsWith('/') ? 0x4000 : 0x8000))
    )
      throw new Error('Unsafe ZIP entry');
    seen.add(name);
    total += size;
    if (total > limit || ![0, 8].includes(method)) throw new Error('Unsupported ZIP payload');
    const local = bytes.readUInt32LE(cursor + 42);
    if (
      local + 30 > start ||
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method
    )
      throw new Error('Invalid ZIP local header');
    const localNameLength = bytes.readUInt16LE(local + 26);
    const dataStart = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    if (
      dataStart + compressedSize > start ||
      !bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)
    )
      throw new Error('Ambiguous ZIP entry');
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    if (flags & 8) {
      let descriptor = dataStart + compressedSize;
      if (descriptor + 12 > start) throw new Error('Missing ZIP data descriptor');
      if (bytes.readUInt32LE(descriptor) === 0x08074b50) descriptor += 4;
      if (
        descriptor + 12 > start ||
        bytes.readUInt32LE(descriptor) !== crc ||
        bytes.readUInt32LE(descriptor + 4) !== compressedSize ||
        bytes.readUInt32LE(descriptor + 8) !== size
      )
        throw new Error('Corrupt ZIP data descriptor');
    } else if (
      bytes.readUInt32LE(local + 14) !== crc ||
      bytes.readUInt32LE(local + 18) !== compressedSize ||
      bytes.readUInt32LE(local + 22) !== size
    ) {
      throw new Error('Inconsistent ZIP local sizes');
    }
    const data =
      method === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) });
    if (data.length !== size || crc32(data) !== crc) throw new Error('Corrupt ZIP payload');
    if (name.endsWith('/')) {
      if (size !== 0) throw new Error('Nonempty ZIP directory');
    } else files.set(name, data);
    cursor += recordLength;
  }
  if (cursor !== end) throw new Error('Invalid ZIP directory length');
  return files;
}

/** Preserve published bytes when only ZIP metadata or compression differs.
 * Malformed or ambiguous archives are never considered equivalent.
 * @param {Buffer} left @param {Buffer} right @returns {boolean}
 */
export function haveSameZipContents(left, right) {
  try {
    const a = zipContents(left);
    const b = zipContents(right);
    return (
      a.size === b.size &&
      [...a].every(([name, data]) => {
        const other = b.get(name);
        return other !== undefined && data.equals(other);
      })
    );
  } catch {
    return false;
  }
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
