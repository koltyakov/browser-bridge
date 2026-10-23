// @ts-check
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateGzip } from './generated-gzip.mjs';

/** @param {Uint8Array} bytes @returns {number} */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a deterministic ZIP with stored entries: no external zip executable,
 * timestamps, host paths, platform attributes, or compression-version drift.
 * @param {boolean} check
 * @returns {Promise<void>}
 */
export async function generateSkills(check) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const source = path.join(root, 'skills/browser-bridge');
  /** @type {string[]} */
  const names = [];
  /** @param {string} directory @returns {Promise<void>} */
  async function walk(directory) {
    for (const entry of await fs.readdir(path.join(source, directory), { withFileTypes: true })) {
      const name = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) names.push(name);
      else throw new Error(`Skill bundle must contain regular files: ${name}`);
    }
  }
  await walk('');
  names.sort();
  if (names.length > 65535) throw new Error('Too many skill files for ZIP');
  /** @type {Buffer[]} */
  const local = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  for (const name of names) {
    const filename = Buffer.from(name, 'utf8');
    const data = await fs.readFile(path.join(source, name));
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0x0021, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0x0021, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const content = Buffer.concat([...local, directory, end]);
  const destination = path.join(root, 'internal/bridge/assets/skills.bundle');
  if (check) {
    const existing = await fs.readFile(destination).catch(() => Buffer.alloc(0));
    if (!existing.equals(content))
      throw new Error('Embedded skills are stale. Run make generate-protocol.');
  } else {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content);
  }
  await generateGzip(`${destination}.gz`, content, check);
}
