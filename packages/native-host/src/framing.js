// @ts-check

import { once } from 'node:events';

/**
 * @param {NodeJS.WritableStream} stream
 * @param {unknown} message
 * @returns {Promise<void>}
 */
export async function writeNativeMessage(stream, message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  if (!stream.write(header)) {
    await once(stream, 'drain');
  }
  if (!stream.write(payload)) {
    await once(stream, 'drain');
  }
}

/** @type {number} */
const MAX_NATIVE_MESSAGE_SIZE = 1 * 1024 * 1024;

/**
 * @param {NodeJS.ReadableStream} stream
 * @param {(message: unknown) => void} onMessage
 * @returns {void}
 */
export function createNativeMessageReader(stream, onMessage) {
  let buffer = Buffer.alloc(0);

  /** @param {Buffer} chunk */
  stream.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > MAX_NATIVE_MESSAGE_SIZE) {
        buffer = Buffer.alloc(0);
        return;
      }
      if (buffer.length < 4 + length) {
        return;
      }

      const payload = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      try {
        onMessage(JSON.parse(payload.toString('utf8')));
      } catch {
        // Malformed JSON payload — skip it.
      }
    }
  });
}

/**
 * @param {import('node:net').Socket} socket
 * @param {unknown} message
 * @returns {Promise<void>}
 */
export async function writeJsonLine(socket, message) {
  if (!socket.write(`${JSON.stringify(message)}\n`)) {
    await once(socket, 'drain');
  }
}
