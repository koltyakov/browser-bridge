// @ts-check

import { once } from 'node:events';

import { MAX_NATIVE_MESSAGE_BYTES } from '../../protocol/src/index.js';

/**
 * @param {NodeJS.WritableStream} stream
 * @param {unknown} message
 * @returns {Promise<void>}
 */
export async function writeNativeMessage(stream, message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length > MAX_NATIVE_MESSAGE_BYTES) {
    throw new Error(`Native message exceeds ${MAX_NATIVE_MESSAGE_BYTES} bytes: ${payload.length}`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  if (!stream.write(header)) {
    await once(stream, 'drain');
  }
  if (!stream.write(payload)) {
    await once(stream, 'drain');
  }
}

/**
 * @param {NodeJS.ReadableStream} stream
 * @param {(message: unknown) => void} onMessage
 * @param {(error: Error) => void} [onProtocolError]
 * @returns {void}
 */
export function createNativeMessageReader(stream, onMessage, onProtocolError) {
  /** @type {Buffer[]} */
  const chunks = [];
  let bufferedBytes = 0;
  let closed = false;

  /**
   * @param {number} length
   * @returns {Buffer | null}
   */
  function peekBytes(length) {
    if (length === 0) {
      return Buffer.alloc(0);
    }
    if (bufferedBytes < length || chunks.length === 0) {
      return null;
    }

    const firstChunk = chunks[0];
    if (firstChunk.length >= length) {
      return firstChunk.subarray(0, length);
    }

    const combined = Buffer.allocUnsafe(length);
    let offset = 0;
    for (const chunk of chunks) {
      const copyLength = Math.min(chunk.length, length - offset);
      chunk.copy(combined, offset, 0, copyLength);
      offset += copyLength;
      if (offset === length) {
        return combined;
      }
    }

    return null;
  }

  /**
   * @param {number} length
   * @returns {Buffer | null}
   */
  function consumeBytes(length) {
    if (length === 0) {
      return Buffer.alloc(0);
    }
    if (bufferedBytes < length || chunks.length === 0) {
      return null;
    }

    const firstChunk = chunks[0];
    if (firstChunk.length === length) {
      chunks.shift();
      bufferedBytes -= length;
      return firstChunk;
    }
    if (firstChunk.length > length) {
      const consumed = firstChunk.subarray(0, length);
      chunks[0] = firstChunk.subarray(length);
      bufferedBytes -= length;
      return consumed;
    }

    const combined = Buffer.allocUnsafe(length);
    let offset = 0;
    let remaining = length;
    while (remaining > 0 && chunks.length > 0) {
      const chunk = chunks[0];
      const copyLength = Math.min(chunk.length, remaining);
      chunk.copy(combined, offset, 0, copyLength);
      offset += copyLength;
      remaining -= copyLength;
      if (copyLength === chunk.length) {
        chunks.shift();
      } else {
        chunks[0] = chunk.subarray(copyLength);
      }
    }

    bufferedBytes -= length;
    return combined;
  }

  /**
   * @param {Error} error
   * @returns {void}
   */
  function closeReader(error) {
    if (closed) {
      return;
    }
    closed = true;
    stream.removeListener('data', handleData);
    onProtocolError?.(error);
    const destroy = /** @type {{ destroy?: (() => void) | undefined }} */ (stream).destroy;
    if (typeof destroy === 'function') {
      destroy.call(stream);
    }
  }

  /** @param {Buffer} chunk */
  function handleData(chunk) {
    if (closed || chunk.length === 0) {
      return;
    }

    chunks.push(chunk);
    bufferedBytes += chunk.length;

    while (bufferedBytes >= 4) {
      const header = peekBytes(4);
      if (!header) {
        return;
      }

      const length = header.readUInt32LE(0);
      if (length > MAX_NATIVE_MESSAGE_BYTES) {
        closeReader(
          new Error(`Native message exceeds ${MAX_NATIVE_MESSAGE_BYTES} bytes: ${length}`)
        );
        return;
      }

      const frameLength = 4 + length;
      if (bufferedBytes < frameLength) {
        return;
      }

      const frame = consumeBytes(frameLength);
      if (!frame) {
        return;
      }

      const payload = frame.subarray(4);
      try {
        onMessage(JSON.parse(payload.toString('utf8')));
      } catch {
        // Malformed JSON payload - skip it.
      }
    }
  }

  stream.on('data', handleData);
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
