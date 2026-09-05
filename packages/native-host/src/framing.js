// @ts-check

import { MAX_JSON_LINE_BYTES, MAX_NATIVE_MESSAGE_BYTES } from '../../protocol/src/index.js';

export const MAX_OUTPUT_QUEUE_BYTES = 4 * MAX_JSON_LINE_BYTES;
export const MAX_OUTPUT_QUEUE_MESSAGES = 128;
export const OUTPUT_DRAIN_TIMEOUT_MS = 30_000;

/** @typedef {NodeJS.WritableStream & { destroyed?: boolean, writableEnded?: boolean, destroy?: () => unknown }} OutputStream */
/** @typedef {{ parts: Array<string | Buffer>, bytes: number, resolve: () => void, reject: (error: Error) => void }} QueuedWrite */

/** @param {OutputStream} stream @returns {(parts: Array<string | Buffer>) => Promise<void>} */
function createBoundedWriter(stream) {
  /** @type {QueuedWrite[]} */
  const queue = [];
  let bytes = 0;
  let running = false;
  /** @type {Error | null} */
  let failure = null;
  /** @type {((error: Error) => void) | null} */
  let cancelDrain = null;

  /** @param {Error} error */
  function fail(error) {
    failure ??= error;
    cancelDrain?.(error);
    for (const entry of queue.splice(0)) entry.reject(error);
    bytes = 0;
    stream.destroy?.();
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length && !failure) {
        const entry = queue[0];
        for (const part of entry.parts) {
          if (failure) throw failure;
          if (stream.destroyed || stream.writableEnded) throw new Error('Output stream closed.');
          if (!stream.write(part)) {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(
                () => finish(new Error('Output drain timed out.')),
                OUTPUT_DRAIN_TIMEOUT_MS
              );
              timer.unref?.();
              /** @param {Error} [error] */
              function finish(error) {
                clearTimeout(timer);
                stream.removeListener('drain', drained);
                stream.removeListener('close', closed);
                stream.removeListener('error', finish);
                cancelDrain = null;
                if (error) reject(error);
                else resolve(undefined);
              }
              const drained = () => finish();
              const closed = () => finish(new Error('Output stream closed while writing.'));
              cancelDrain = finish;
              stream.once('drain', drained);
              stream.once('close', closed);
              stream.once('error', finish);
            });
          }
        }
        if (failure) break;
        queue.shift();
        bytes -= entry.bytes;
        entry.resolve();
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      running = false;
    }
  }

  return (parts) => {
    if (failure) return Promise.reject(failure);
    const size = parts.reduce((total, part) => total + Buffer.byteLength(part), 0);
    if (queue.length >= MAX_OUTPUT_QUEUE_MESSAGES || bytes + size > MAX_OUTPUT_QUEUE_BYTES) {
      const error = new Error('Output queue limit exceeded.');
      fail(error);
      return Promise.reject(error);
    }
    const result = new Promise((resolve, reject) => {
      queue.push({ parts, bytes: size, resolve: () => resolve(undefined), reject });
      bytes += size;
    });
    void pump();
    return result;
  };
}

/** @type {WeakMap<OutputStream, ReturnType<typeof createBoundedWriter>>} */
const outputWriters = new WeakMap();

/** @param {OutputStream} stream @param {Array<string | Buffer>} parts */
function writeParts(stream, parts) {
  let writer = outputWriters.get(stream);
  if (!writer) {
    writer = createBoundedWriter(stream);
    outputWriters.set(stream, writer);
  }
  return writer(parts);
}

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
  await writeParts(stream, [header, payload]);
}

/**
 * @param {NodeJS.WritableStream} stream
 * @returns {(message: unknown) => Promise<void>}
 */
export function createNativeMessageWriter(stream) {
  return (message) => writeNativeMessage(stream, message);
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
  const line = `${JSON.stringify(message)}\n`;
  const byteLength = Buffer.byteLength(line.slice(0, -1), 'utf8');
  if (byteLength > MAX_JSON_LINE_BYTES) {
    throw new Error(`JSON line exceeds ${MAX_JSON_LINE_BYTES} bytes: ${byteLength}`);
  }
  await writeParts(socket, [line]);
}
