// Test-only mutation of a valid standard ZIP. Entry bytes and CRCs stay intact.
export function withDifferentZipMetadata(original: Buffer): Buffer {
  const bytes = Buffer.from(original);
  const end = bytes.length - 22;
  let cursor = bytes.readUInt32LE(end + 16);
  const count = bytes.readUInt16LE(end + 10);
  for (let index = 0; index < count; index++) {
    const local = bytes.readUInt32LE(cursor + 42);
    bytes.writeUInt16LE(0x5621, local + 12);
    bytes.writeUInt16LE(0x5621, cursor + 14);
    cursor +=
      46 +
      bytes.readUInt16LE(cursor + 28) +
      bytes.readUInt16LE(cursor + 30) +
      bytes.readUInt16LE(cursor + 32);
  }
  return bytes;
}
