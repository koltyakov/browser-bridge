// @ts-check

/**
 * @param {unknown} message
 * @returns {Buffer}
 */
export function frameNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * @param {Buffer[]} chunks
 * @returns {unknown[]}
 */
export function decodeNativeMessages(chunks) {
  /** @type {unknown[]} */
  const messages = [];

  for (let index = 0; index < chunks.length - 1; index += 1) {
    const header = chunks[index];
    const payload = chunks[index + 1];

    if (header.length !== 4) {
      continue;
    }

    const expectedLength = header.readUInt32LE(0);
    if (payload.length !== expectedLength) {
      continue;
    }

    messages.push(JSON.parse(payload.toString('utf8')));
    index += 1;
  }

  return messages;
}
